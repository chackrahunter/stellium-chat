/**
 * Wächst der Speicher unbegrenzt mit dem Verlauf?
 *
 * Gemessen wird der JS-Haufen und die Zahl der Knoten im Dokument, während
 * viele Nachrichten eintreffen. Beides muss sich einpendeln — sonst trägt
 * die App nach einem Arbeitstag alles mit, was jemals geschrieben wurde.
 */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true, args: ['--js-flags=--expose-gc'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-DE' })).newPage();
await p.goto(APP);
await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
await p.reload(); await p.waitForTimeout(1200);
if (await p.locator('.auth').count()) {
  await p.locator('.auth input').first().fill(LOGIN);
  await p.locator('.auth input[type="password"]').first().fill(PW);
  await p.locator('.auth button[type="submit"]').first().click();
}
await p.waitForSelector('.app', { timeout: 20000 });
await p.waitForTimeout(2500);

const messe = async () => {
  await p.evaluate(() => { if (window.gc) window.gc(); });
  await p.waitForTimeout(400);
  return p.evaluate(() => ({
    haufen: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    knoten: document.querySelectorAll('*').length,
    nachrichtenImDom: document.querySelectorAll('.msg').length,
    imSpeicher: window.__stelliumStore
      ? Object.values(window.__stelliumStore.getState().messages).reduce((n, l) => n + l.length, 0)
      : null,
  }));
};

const anfang = await messe();
console.log(`  Start: ${anfang.haufen ?? '?'} MB · ${anfang.knoten} Knoten · ${anfang.nachrichtenImDom} Nachrichten im Dokument`);

/* Viele Nachrichten hereinbekommen — über den Zustand, damit es schnell geht
   und die Prüfdatenbank nicht mit tausend Zeilen zugemüllt wird. */
await p.evaluate(() => {
  const store = window.__stelliumStore;
  const s = store.getState();
  const kanal = s.activeChannelId;
  const vorlage = (s.messages[kanal] ?? [])[0];
  if (!vorlage) throw new Error('keine Vorlage');
  for (let i = 0; i < 1200; i++) {
    store.setState((alt) => {
      const liste = alt.messages[kanal] ?? [];
      const neu = {
        ...vorlage,
        id: `probe_${i}`,
        text: `Lastprobe ${i} — ${'x'.repeat(80)}`,
        createdAt: Date.now() + i,
        reactions: [], attachments: [], links: [], poll: null, voice: null,
      };
      return { messages: { ...alt.messages, [kanal]: [...liste, neu] } };
    });
  }
});
await p.waitForTimeout(2500);

const nachher = await messe();
console.log(`  Nach 1200: ${nachher.haufen ?? '?'} MB · ${nachher.knoten} Knoten · ${nachher.nachrichtenImDom} im Dokument · ${nachher.imSpeicher} im Speicher`);

/* Die 1200 oben werden am Handler vorbei eingespeist — das belastet
   absichtlich das Dokument. Ob der echte Weg begrenzt, zeigt sich, sobald
   der Server den Verlauf schickt. */
await pruefe('Der echte Weg begrenzt den Verlauf', async () => {
  const kanal = await p.evaluate(() => window.__stelliumStore.getState().activeChannelId);
  await p.evaluate((k) => window.__stelliumStore.getState().openChannel(k), kanal);
  await p.waitForTimeout(2000);
  const wieviele = await p.evaluate((k) => (window.__stelliumStore.getState().messages[k] ?? []).length, kanal);
  muss(wieviele <= 400, `${wieviele} Nachrichten im Speicher`);
  return `${wieviele} statt 1250`;
});

await pruefe('Das Dokument bleibt schlank', async () => {
  muss(nachher.nachrichtenImDom <= 200, `${nachher.nachrichtenImDom} Nachrichten im Dokument`);
  return `${nachher.nachrichtenImDom} Nachrichten gezeichnet`;
});

await pruefe('Die Knotenzahl bleibt beherrschbar', async () => {
  muss(nachher.knoten < 6000, `${nachher.knoten} Knoten`);
  return `${nachher.knoten} Knoten`;
});

if (anfang.haufen && nachher.haufen) {
  await pruefe('Der Haufen wächst nicht ins Uferlose', async () => {
    const zuwachs = nachher.haufen - anfang.haufen;
    muss(zuwachs < 60, `+${zuwachs} MB`);
    return `+${zuwachs} MB (von ${anfang.haufen} auf ${nachher.haufen})`;
  });
}

// Kanalwechsel: alte Kanäle sollen vergessen werden.
await pruefe('Nicht besuchte Kanäle werden vergessen', async () => {
  const kanaele = await p.evaluate(() => {
    const s = window.__stelliumStore.getState();
    return Object.values(s.channels).filter((c) => c.kind === 'public').slice(0, 10).map((c) => c.id);
  });
  for (const id of kanaele) {
    await p.evaluate((k) => window.__stelliumStore.getState().openChannel(k), id);
    await p.waitForTimeout(220);
  }
  await p.waitForTimeout(1200);
  const gehalten = await p.evaluate(() => Object.keys(window.__stelliumStore.getState().messages).length);
  muss(gehalten <= 7, `${gehalten} Kanäle im Speicher`);
  return `${gehalten} von ${kanaele.length} behalten`;
});

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
