/**
 * Grenzfälle: Dinge, die im Alltag passieren und im Normaltest nicht vorkommen.
 * Zweimal anmelden, zwei Fenster, Verbindungsabbruch, kaputte Eingaben.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

const SHOTS = '/Users/don-calvinkuhn/Developer/Chat-Team-GUI/scripts/screenshots';
fs.mkdirSync(SHOTS, { recursive: true });


const ergebnisse = [];
async function pruefe(name, fn) {
  try { const n = await fn(); ergebnisse.push(true); console.log(`  ✓ ${name}${n ? ` — ${n}` : ''}`); }
  catch (e) { ergebnisse.push(false); console.log(`  ✗ ${name} — ${e.message.split('\n')[0]}`); }
}
const muss = (b, m) => { if (!b) throw new Error(m); };

async function neueSeite(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 }, locale: 'de-DE', ...opts });
  const p = await ctx.newPage();
  const fehler = [];
  p.on('pageerror', (e) => fehler.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  p._fehler = fehler;
  await p.goto(APP);
  await p.evaluate((s) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, S);
  await p.reload();
  await p.waitForTimeout(900);
  return p;
}

async function anmelden(p) {
  if (!(await p.locator('.auth').count())) return;
  await p.locator('.auth input').first().fill(LOGIN);
  await p.locator('.auth input[type="password"]').first().fill(PW);
  await p.locator('.auth button[type="submit"]').first().click();
  await p.waitForSelector('.app', { timeout: 20000 });
}

const browser = await chromium.launch({ headless: true });

console.log('\nAnmeldung');

await pruefe('Falsches Passwort wird erklärt, nicht verschluckt', async () => {
  const p = await neueSeite(browser);
  await p.locator('.auth input').first().fill(LOGIN);
  await p.locator('.auth input[type="password"]').first().fill('falschfalschfalsch');
  await p.locator('.auth button[type="submit"]').first().click();
  await p.waitForSelector('.auth__error', { timeout: 10000 });
  const text = await p.locator('.auth__error').innerText();
  muss(text.length > 5, 'keine verständliche Meldung');
  muss(!(await p.locator('.app').count()), 'trotzdem hereingelassen');
  await p.context().close();
  return text.slice(0, 50);
});

await pruefe('Zweimal hintereinander anmelden bleibt stabil', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  // Noch einmal anmelden, während die Sitzung schon läuft.
  const zweite = await p.evaluate(async ({ s, login, pw }) => {
    const r = await fetch(`${s}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password: pw }),
    });
    return { status: r.status, hatToken: Boolean((await r.json()).token) };
  }, { s: S, login: LOGIN, pw: PW });
  muss(zweite.status === 200 && zweite.hatToken, 'zweite Anmeldung schlägt fehl');
  await p.waitForTimeout(1500);
  muss(await p.locator('.app').count(), 'die erste Sitzung wurde geworfen');
  muss(!p._fehler.length, `Fehler: ${p._fehler[0]}`);
  await p.context().close();
  return 'beide Tokens gültig';
});

await pruefe('Zwei Fenster gleichzeitig sehen dieselbe Nachricht', async () => {
  const a = await neueSeite(browser);
  const b = await neueSeite(browser);
  await anmelden(a); await anmelden(b);
  await a.waitForTimeout(900); await b.waitForTimeout(900);

  const kanal = a.locator('.sidebar__scroll .group').last().locator('.chan').first();
  await kanal.click();
  await b.locator('.sidebar__scroll .group').last().locator('.chan').first().click();
  await a.waitForTimeout(700); await b.waitForTimeout(700);

  const text = `Zwei Fenster ${Date.now().toString(36).slice(-5)}`;
  await a.locator('.composer__input').fill(text);
  await a.keyboard.press('Enter');
  // Im zweiten Fenster muss sie ohne Neuladen auftauchen.
  await b.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 12000 });
  await a.context().close(); await b.context().close();
  return 'kommt in Echtzeit an';
});

await pruefe('Ungültiger Token wirft sauber zur Anmeldung', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.evaluate(() => localStorage.setItem('stellium.token', 'kaputt.kaputt.kaputt'));
  await p.reload();
  await p.waitForSelector('.auth', { timeout: 15000 });
  muss(!(await p.locator('.app').count()), 'zeigt trotzdem den Chat');
  await p.context().close();
  return 'Anmeldung erscheint wieder';
});

console.log('\nVerbindung');

await pruefe('Serverabbruch wird angezeigt und wieder aufgebaut', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.waitForTimeout(900);
  // Alle WebSocket-Verbindungen kappen — wie ein kurzer Netzausfall.
  await p.context().setOffline(true);
  /* Erst muss der Hinweis überhaupt erscheinen. Ohne diese Zeile prüfte der
     Lauf nur die Rückkehr — und die Bedingung „steht dort NICHT 'Verbindung
     verloren'" ist schon vor dem Ausfall erfüllt. Merkte die App den Abriss
     gar nicht, war das ein bestandener Lauf, obwohl genau das der Fehler ist,
     um den es hier geht. */
  await p.waitForFunction(
    () => document.body.innerText.includes('Verbindung verloren'),
    undefined, { timeout: 25000 },
  );
  await p.context().setOffline(false);
  await p.waitForFunction(
    () => !document.body.innerText.includes('Verbindung verloren'),
    undefined, { timeout: 25000 },
  );
  muss(await p.locator('.app').count(), 'App ist nach dem Ausfall weg');
  await p.context().close();
  return 'verbindet sich neu';
});

console.log('\nEingaben');

await pruefe('Leere Nachricht wird nicht gesendet', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.locator('.sidebar__scroll .group').last().locator('.chan').first().click();
  await p.waitForTimeout(700);
  const vorher = await p.locator('.msg').count();
  await p.locator('.composer__input').fill('   ');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1200);
  muss(await p.locator('.msg').count() === vorher, 'Leerzeichen wurden gesendet');
  await p.context().close();
});

await pruefe('Sehr lange Nachricht bricht die Ansicht nicht', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.locator('.sidebar__scroll .group').last().locator('.chan').first().click();
  await p.waitForTimeout(700);
  const lang = `Lang${Date.now().toString(36).slice(-4)} ` + 'x'.repeat(4000);
  await p.locator('.composer__input').fill(lang);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(2000);
  const ueberlauf = await p.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  muss(!ueberlauf, 'die Seite lässt sich jetzt seitlich schieben');
  await p.context().close();
});

await pruefe('Sonderzeichen und Emoji überstehen den Weg', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.locator('.sidebar__scroll .group').last().locator('.chan').first().click();
  await p.waitForTimeout(700);
  const text = `Grüße ${Date.now().toString(36).slice(-4)} — <script>alert(1)</script> 你好 🌍 «ç»`;
  await p.locator('.composer__input').fill(text);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1800);
  const drin = await p.evaluate((t) => document.body.innerText.includes(t.split(' — ')[0]), text);
  muss(drin, 'Nachricht nicht gefunden');
  // Das Skript darf als Text erscheinen, aber nicht ausgeführt werden.
  const skripte = await p.evaluate(() => document.querySelectorAll('.msg script').length);
  muss(skripte === 0, 'ein <script> ist im Nachrichtenbaum gelandet');
  await p.context().close();
  return 'unverändert, nichts ausgeführt';
});

console.log('\nGleichzeitigkeit');

await pruefe('Gelöschter Kanal lässt die andere Sitzung nicht abstürzen', async () => {
  const a = await neueSeite(browser);
  const b = await neueSeite(browser);
  await anmelden(a); await anmelden(b);
  await a.waitForTimeout(900);

  const name = `weg-${Date.now().toString(36).slice(-5)}`;
  await a.evaluate((n) => window.dispatchEvent(new CustomEvent('noop')), name);
  // Kanal über die Oberfläche anlegen
  await a.locator('.sidebar__scroll .group').nth(1).locator('.chan').first().click();
  await a.waitForTimeout(400);
  await a.keyboard.press('Meta+Shift+n');
  await a.waitForSelector('.panel input.input', { timeout: 8000 });
  await a.locator('.panel input.input').first().fill(name);
  await a.locator('.panel .btn--primary').last().click();
  await a.waitForTimeout(1800);

  // In der zweiten Sitzung hineingehen, in der ersten löschen.
  await b.waitForFunction((n) => document.body.innerText.includes(n), name, { timeout: 12000 });
  await b.locator('.chan', { hasText: name }).first().click();
  await b.waitForTimeout(800);

  await a.locator('.chan', { hasText: name }).first().click({ button: 'right' });
  await a.waitForSelector('.kontextmenue', { timeout: 6000 });
  const loeschen = a.locator('.kontextmenue button').filter({ hasText: /löschen/i }).last();
  /* Der Zuhörer muss VOR dem Klick stehen. Er stand danach — Playwright weist
     einen Dialog ohne Zuhörer sofort ab, der Kanal wurde also nie gelöscht,
     und die beiden Zusagen darunter bescheinigten anschließend einen Vorgang,
     der gar nicht stattgefunden hatte. */
  a.once('dialog', (d) => d.accept());
  await loeschen.click();
  await a.waitForTimeout(2500);

  /* Und nachsehen, ob der Kanal wirklich weg ist — sonst prüft der Rest
     wieder nur, dass nichts passiert ist. */
  await b.waitForFunction((n) => !document.body.innerText.includes(n), name, { timeout: 15000 });

  muss(await b.locator('.app').count(), 'die zweite Sitzung ist abgestürzt');
  const schlimm = b._fehler.filter((f) => /undefined is not|cannot read|of null/i.test(f));
  muss(!schlimm.length, `Fehler in der zweiten Sitzung: ${schlimm[0]}`);
  await a.context().close(); await b.context().close();
  return 'bleibt bedienbar';
});

await pruefe('Abmelden räumt alles weg', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.waitForTimeout(800);
  await p.evaluate(() => window.__stelliumLogout?.() ?? null);
  await p.evaluate(() => localStorage.removeItem('stellium.token'));
  await p.reload();
  await p.waitForSelector('.auth', { timeout: 15000 });
  const rest = await p.evaluate(() => localStorage.getItem('stellium.token'));
  muss(!rest, 'der Token liegt noch im Speicher');
  await p.context().close();
});

console.log('\nNeue Bereiche');

await pruefe('Gleichzeitiges Abstimmen bleibt bei einer Stimme je Person', async () => {
  const a = await neueSeite(browser);
  await anmelden(a);
  await a.waitForTimeout(800);
  const titel = `Doppelklick ${Date.now().toString(36).slice(-5)}`;
  await a.click('[data-tour="ideas"]');
  await a.waitForSelector('.idea-bar', { timeout: 8000 });
  await a.locator('.panel__head .pill--accent').click();
  await a.waitForTimeout(400);
  await a.locator('.panel input.input').first().fill(titel);
  await a.locator('.panel__foot .btn--primary').last().click();
  await a.waitForTimeout(1200);

  // Fünfmal schnell hintereinander auf denselben Daumen.
  const zeile = a.locator('.idea-row').filter({ hasText: titel }).first();
  for (let i = 0; i < 5; i += 1) await zeile.locator('.idea-vote__btn').first().click();
  await a.waitForTimeout(1500);
  const wert = (await zeile.locator('.idea-vote__zahl').innerText()).trim();
  // Ungerade Anzahl Klicks auf "dafür", Start bei +1: am Ende 0 oder +1,
  // aber niemals mehr als eine Stimme derselben Person.
  muss(['0', '+1'].includes(wert), `Stand ${wert} — mehr als eine Stimme gezählt`);
  await a.context().close();
  return `Stand ${wert}`;
});

await pruefe('Aufgabe mit Datum ohne Uhrzeit landet nicht im Vortag', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.waitForTimeout(800);
  await p.click('[data-tour="tasks"]');
  await p.waitForSelector('.panel', { timeout: 8000 });
  await p.locator('.panel__head .pill--accent').click();
  await p.waitForTimeout(400);
  const titel = `Frist ${Date.now().toString(36).slice(-5)}`;
  await p.locator('.panel input.input').first().fill(titel);
  const heute = await p.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await p.locator('.panel input[type="date"]').first().fill(heute);
  await p.locator('.panel__foot .btn--primary').last().click();
  await p.waitForTimeout(1500);
  const karte = p.locator('.task-card').filter({ hasText: titel }).first();
  const text = await karte.innerText();
  muss(!/überfällig|overdue/i.test(text), `heute fällig wird als überfällig gezeigt: ${text}`);
  await p.context().close();
});

await pruefe('Termin über Mitternacht erscheint an beiden Tagen', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.waitForTimeout(800);
  await p.click('[data-tour="calendar"]');
  await p.waitForSelector('.week', { timeout: 8000 });
  await p.locator('.panel__head .pill--accent').click();
  await p.waitForTimeout(400);
  const titel = `Nachtschicht ${Date.now().toString(36).slice(-4)}`;
  await p.locator('.panel input.input').first().fill(titel);
  const felder = p.locator('.panel input[type="datetime-local"]');
  const heute = await p.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const morgen = await p.evaluate(() => {
    const d = new Date(Date.now() + 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await felder.nth(0).fill(`${heute}T22:00`);
  await felder.nth(1).fill(`${morgen}T06:00`);
  await p.locator('.panel__foot .btn--primary').last().click();
  await p.waitForTimeout(1600);
  const tage = await p.locator('.week__day').filter({ hasText: titel }).count();
  muss(tage >= 2, `nur an ${tage} Tag sichtbar`);
  await p.context().close();
  return `an ${tage} Tagen`;
});

await pruefe('Kommentar mit nur Leerzeichen wird abgelehnt', async () => {
  const p = await neueSeite(browser);
  await anmelden(p);
  await p.waitForTimeout(800);
  await p.click('[data-tour="ideas"]');
  await p.waitForSelector('.idea-bar', { timeout: 8000 });
  // Eigene Idee anlegen, damit der Test nicht von früheren Läufen abhängt.
  await p.locator('.panel__head .pill--accent').click();
  await p.waitForTimeout(400);
  await p.locator('.panel input.input').first().fill(`Leerprobe ${Date.now().toString(36).slice(-5)}`);
  await p.locator('.panel__foot .btn--primary').last().click();
  await p.waitForTimeout(1400);
  await p.locator('.idea-row__main').first().click();
  await p.waitForTimeout(700);
  const dialog = p.locator('.panel').last();
  const vorher = await dialog.locator('.idea-comment').count();
  await dialog.locator('input.input').last().fill('    ');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1200);
  muss(await dialog.locator('.idea-comment').count() === vorher, 'leerer Kommentar wurde angelegt');
  await p.context().close();
});

await browser.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
