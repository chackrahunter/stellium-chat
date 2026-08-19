/** Nachrichten liegen verschlüsselt in der Datenbank — und funktionieren trotzdem. */
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

const DB = process.env.STELLIUM_DB ?? 'data/stellium.db';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };
const datenbank = () => new DatabaseSync(DB, { readOnly: true });

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'de-DE' })).newPage();
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

const marke = `Geheimwort${Date.now().toString(36).slice(-5)}`;

await pruefe('Alte Nachrichten sind weiter lesbar', async () => {
  const text = await p.locator('.stream').innerText();
  muss(text.length > 40, 'der Verlauf ist leer');
  muss(!text.includes('m1:'), 'da steht ein Chiffrat auf dem Bildschirm');
});

await pruefe('Neue Nachricht kommt an', async () => {
  await p.locator('.composer__input').fill(`${marke} — bitte bis Freitag ansehen`);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1800);
  muss((await p.locator('.stream').innerText()).includes(marke), 'Nachricht fehlt im Verlauf');
});

await pruefe('In der Datenbank steht kein Klartext', async () => {
  const d = datenbank();
  const treffer = d.prepare('SELECT COUNT(*) AS c FROM messages WHERE text LIKE ?').get(`%${marke}%`).c;
  muss(treffer === 0, 'der Text steht im Klartext in der Tabelle');
  const imIndex = d.prepare('SELECT COUNT(*) AS c FROM message_fts WHERE body LIKE ?').get(`%${marke.toLowerCase()}%`).c;
  muss(imIndex === 0, 'der Text steht im Klartext im Volltextindex');
  const offen = d.prepare("SELECT COUNT(*) AS c FROM messages WHERE text <> '' AND substr(text,1,3) <> 'm1:'").get().c;
  muss(offen === 0, `${offen} Nachrichten liegen noch im Klartext`);
  d.close();
  return 'weder in der Tabelle noch im Index';
});

await pruefe('Suche findet sie trotzdem', async () => {
  await p.keyboard.press('Meta+f');
  await p.waitForSelector('.panel input', { timeout: 8000 });
  await p.locator('.panel input').first().fill(marke);
  await p.waitForTimeout(2500);
  const treffer = await p.locator('.panel').last().innerText();
  muss(treffer.includes(marke), `nicht gefunden: ${treffer.slice(0, 90)}`);
  await p.keyboard.press('Escape');
});

await pruefe('Nach dem Neuladen ist sie noch da', async () => {
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(2500);
  muss((await p.locator('.stream').innerText()).includes(marke), 'nach dem Neuladen verschwunden');
});

await pruefe('Bearbeiten bleibt verschlüsselt', async () => {
  const neu = `${marke}-geaendert`;
  const zeile = p.locator('.msg').filter({ hasText: marke }).last();
  await zeile.hover();
  await zeile.locator('.msg__actions button[title]').last().click();
  await p.waitForTimeout(500);
  await p.locator('button', { hasText: /Bearbeiten/i }).first().click();
  await p.waitForTimeout(700);
  const feld = zeile.locator('textarea, .input').first();
  await feld.fill(neu);
  await feld.press('Enter');
  await p.waitForTimeout(1800);
  muss((await p.locator('.stream').innerText()).includes(neu), 'Änderung nicht sichtbar');
  const d = datenbank();
  const treffer = d.prepare('SELECT COUNT(*) AS c FROM messages WHERE text LIKE ?').get(`%${neu}%`).c;
  d.close();
  muss(treffer === 0, 'der geänderte Text steht im Klartext');
});

await pruefe('Entwürfe liegen ebenfalls verschlüsselt', async () => {
  const entwurf = `Entwurf-${marke}`;
  await p.locator('.composer__input').fill(entwurf);
  await p.waitForTimeout(2500);
  const d = datenbank();
  const gesamt = d.prepare('SELECT COUNT(*) AS c FROM drafts').get().c;
  const klar = d.prepare('SELECT COUNT(*) AS c FROM drafts WHERE text LIKE ?').get(`%${entwurf}%`).c;
  d.close();
  muss(gesamt > 0, 'kein Entwurf gespeichert');
  muss(klar === 0, 'der Entwurf steht im Klartext');
  await p.locator('.composer__input').fill('');
  return `${gesamt} Entwürfe geprüft`;
});

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
