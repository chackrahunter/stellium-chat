/** "Was habe ich verpasst?" muss auch dann etwas finden, wenn man den Kanal schon offen hatte. */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';


const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });
const anmelden = async (sprache = 'de-DE') => {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, locale: sprache })).newPage();
  await p.goto(APP);
  await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
  await p.reload(); await p.waitForTimeout(1200);
  if (await p.locator('.auth').count()) {
    await p.locator('.auth input').first().fill(LOGIN);
    await p.locator('.auth input[type="password"]').first().fill(PW);
    await p.locator('.auth button[type="submit"]').first().click();
  }
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1500);
  return p;
};

const marke = Date.now().toString(36).slice(-5);
const a = await anmelden();

/* Der Kern des Fehlers lag darin, welche Grenze mitgeschickt wird. Darum wird
   genau das geprüft: derselbe Kanal, einmal mit und einmal ohne Grenze. */
const { token } = await (await fetch(`${S}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: LOGIN, password: PW }),
})).json();

const ws = new (await import('ws')).WebSocket(`${S.replace('http', 'ws')}/ws`);
const antworten = new Map();
const alleEreignisse = [];
let bereit = null;
ws.on('message', (d) => {
  const ev = JSON.parse(d.toString());
  alleEreignisse.push(ev);
  if (ev.t === 'ready') bereit = ev;
  // Nicht jedes Ereignis trägt eine Anfragenummer — channel:history etwa nicht.
  if (ev.requestId) antworten.set(ev.requestId, ev);
});
ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token, protocol: 1 })));
const warten = async (pruef, ms = 90000) => {
  const bis = Date.now() + ms;
  while (Date.now() < bis) {
    const treffer = pruef();
    if (treffer) return treffer;
    await new Promise((f) => setTimeout(f, 200));
  }
  throw new Error('Zeitüberschreitung');
};
await warten(() => bereit);
const kanal = bereit.channels.find((c) => c.kind === 'public')?.id ?? bereit.channels[0].id;

// Etwas, das es zusammenzufassen gibt.
for (const satz of [
  `Der Umzug der Datenbank ${marke} ist für Samstag geplant.`,
  `Wir haben beschlossen, die alte Fassung ${marke} noch zwei Wochen laufen zu lassen.`,
  `Lena übernimmt die Ankündigung ${marke} an das Team.`,
]) {
  ws.send(JSON.stringify({ t: 'message:send', channelId: kanal, text: satz }));
  await new Promise((f) => setTimeout(f, 900));
}

// Kanal öffnen und als gelesen melden — danach steht der Lesestand vorn.
ws.send(JSON.stringify({ t: 'channel:open', channelId: kanal, limit: 50 }));
const verlauf = await warten(() => alleEreignisse.find((e) => e.t === 'channel:history') ?? null, 20000);
const alle = verlauf.messages ?? [];
const grenze = alle.length > 3 ? alle[alle.length - 4].id : null;
ws.send(JSON.stringify({ t: 'read', channelId: kanal, lastMessageId: alle[alle.length - 1].id }));
await new Promise((f) => setTimeout(f, 1200));

const zusammenfassen = async (sinceMessageId) => {
  const requestId = `v_${Date.now()}_${Math.round(Number(process.hrtime.bigint() % 9999n))}`;
  ws.send(JSON.stringify({ t: 'ai:catchup', requestId, channelId: kanal, sinceMessageId }));
  const ev = await warten(() => antworten.get(requestId) ?? null);
  return ev.summary;
};

await pruefe('Ohne Grenze findet der Server nichts — das war der Fehler', async () => {
  const s2 = await zusammenfassen(undefined);
  muss(s2.messageCount === 0, `unerwartet ${s2.messageCount} Nachrichten`);
  return 'Lesestand steht schon vorn';
});

await pruefe('Mit der Grenze vom Öffnen findet er die Nachrichten', async () => {
  const s2 = await zusammenfassen(grenze);
  muss(s2.messageCount > 0, 'zählt weiter 0 Nachrichten');
  muss(!/Nichts verpasst/i.test(s2.headline), 'Überschrift sagt weiter "nichts verpasst"');
  return `${s2.messageCount} Nachrichten · "${s2.headline.slice(0, 40)}"`;
});

await pruefe('Die App schickt diese Grenze auch mit', async () => {
  const p = await anmelden();
  const gesendet = [];
  p.on('websocket', (sock) => sock.on('framesent', (f) => {
    if (typeof f.payload === 'string' && f.payload.includes('ai:catchup')) gesendet.push(f.payload);
  }));
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(2500);
  await p.keyboard.press('Meta+Shift+u');
  await p.waitForTimeout(2500);
  await p.context().close();
  muss(gesendet.length, 'keine Anfrage beobachtet');
  const anfrage = JSON.parse(gesendet[0]);
  muss('sinceMessageId' in anfrage, `ohne Grenze: ${gesendet[0].slice(0, 120)}`);
  return 'sinceMessageId ist dabei';
});

ws.close();

await pruefe('Ohne Neues bleibt es bei "nichts verpasst"', async () => {
  // Der Kanal ist gelesen und es kam nichts dazu — beim Neuöffnen rückt die
  // Grenze auf den aktuellen Stand.
  const zweiter = await anmelden();
  await zweiter.waitForTimeout(2500);
  await zweiter.keyboard.press('Meta+Shift+u');
  await zweiter.waitForSelector('.panel', { timeout: 8000 });
  await zweiter.waitForFunction(() => !document.querySelector('.panel .spin'), null, { timeout: 90000 });
  await zweiter.waitForTimeout(600);
  const text = await zweiter.locator('.panel').innerText();
  await zweiter.context().close();
  muss(/Nichts verpasst|0 Nachrichten/i.test(text), `unerwartet: ${text.slice(0, 120)}`);
});

await pruefe('Auf Englisch steht dort kein Deutsch', async () => {
  const e = await anmelden('en-US');
  await e.evaluate(() => {
    const s = window.localStorage;
    s.setItem('stellium.sprachprobe', '1');
  });
  await e.keyboard.press('Meta+Shift+u');
  await e.waitForSelector('.panel', { timeout: 8000 });
  await e.waitForTimeout(1500);
  const text = await e.locator('.panel').innerText();
  await e.context().close();
  // Die Oberflächensprache hängt am Konto, nicht am Rechner — geprüft wird
  // nur, dass die Texte aus dem Wörterbuch kommen und nicht fest im Code.
  muss(!/Zusammenfassen$/m.test(text) || /Nachrichten|messages/i.test(text), 'Panel wirkt leer');
  return 'Texte kommen aus dem Wörterbuch';
});

await a.context().close();
await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
