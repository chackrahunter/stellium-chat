/**
 * Durchlauf der Kontoverwaltung mit echtem Browser.
 *   node scripts/e2e-admin.mjs <einmal-passwort> [benutzername]
 *
 * Das Konto muss die Rolle "owner" haben — nur damit lassen sich einzelne
 * Rechte vergeben, und genau das prüft dieser Durchlauf.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'scripts/screenshots');
fs.mkdirSync(shots, { recursive: true });

const einmal = process.argv[2];
const neuerNutzer = process.argv[3] ?? 'admin';
// Eigener Name je Durchlauf — sonst kollidiert der zweite Lauf mit dem ersten.
const eigenerName = `${neuerNutzer}x`;
if (!einmal) { console.error('Einmal-Passwort als Argument angeben.'); process.exit(1); }

const ergebnisse = [];
let seite;

async function pruefe(name, fn) {
  try {
    const notiz = await fn();
    ergebnisse.push(true);
    console.log(`  ✓ ${name}${notiz ? ` — ${notiz}` : ''}`);
  } catch (err) {
    ergebnisse.push(false);
    console.log(`  ✗ ${name} — ${err.message.split('\n').slice(0, 7).join(' ⏎ ')}`);
    try { await seite.screenshot({ path: path.join(shots, `admin-${name.replace(/\W+/g, '-').toLowerCase()}.png`) }); } catch {}
  }
}
const muss = (b, m) => { if (!b) throw new Error(m); };

const browser = await chromium.launch({ headless: true });
const kontext = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: 'de-DE' });
seite = await kontext.newPage();

console.log('\nErstanmeldung und Einrichtung');

await pruefe('Anmeldung mit Einmal-Passwort', async () => {
  await seite.goto(APP, { waitUntil: 'domcontentloaded' });
  await seite.waitForSelector('.auth__card', { timeout: 20000 });
  await seite.fill('input[autocomplete="username"]', neuerNutzer);
  await seite.fill('input[type="password"]', einmal);
  await seite.click('button[type="submit"]');
  // Auf den Einrichtungs-Bildschirm warten, nicht nur auf irgendeine Überschrift:
  // Anmeldung und Einrichtung teilen sich dieselbe Klasse. Die Einrichtung ist
  // am einzigen sprachunabhängigen Merkmal erkennbar — sie hat fünf Felder.
  await seite.waitForFunction(
    () => document.querySelectorAll('.auth__card input').length >= 5,
    undefined, { timeout: 20000 },
  );
  return 'Einrichtung wird erzwungen';
});

await pruefe('Selbstregistrierung ist nicht angeboten', async () => {
  const text = await seite.locator('.auth__card').innerText();
  muss(!/Registrieren/i.test(text), 'Es gibt noch einen Registrieren-Knopf');
  return 'kein Registrieren-Knopf';
});

await pruefe('Eigene Zugangsdaten setzen', async () => {
  const felder = seite.locator('.auth__card input');
  await felder.nth(0).fill('Don-Calvin Kuhn');
  await felder.nth(1).fill(eigenerName);
  await felder.nth(2).fill(`${eigenerName}@stellium.de`);
  await felder.nth(3).fill(PW);
  await felder.nth(4).fill(PW);
  await seite.screenshot({ path: path.join(shots, 'einrichtung.png') });
  await seite.locator('.auth__card button', { hasText: 'Einrichtung abschließen' }).click();
  await seite.waitForSelector('.app', { timeout: 20000 });
  return 'Chat geöffnet';
});

console.log('\nTeam-Verwaltung');

await pruefe('Verwaltung öffnen', async () => {
  await seite.locator('.rail [data-tour="team"]').click();
  await seite.waitForSelector('.admin', { timeout: 8000 });
  // Die Liste kommt per HTTP nach — auf den ersten Eintrag warten.
  await seite.locator('.admin__liste .result').first().waitFor({ timeout: 15000 });
  const anzahl = await seite.locator('.admin__liste .result').count();
  return `${anzahl} Konto sichtbar`;
});

let einmalNeu = null;
let handleNeu = null;

await pruefe('Konto anlegen und Einmal-Passwort erhalten', async () => {
  await seite.locator('button', { hasText: 'Konto anlegen' }).click();
  await seite.waitForSelector('.panel input', { timeout: 8000 });
  const felder = seite.locator('.scrim .panel').last().locator('input');
  await felder.nth(0).fill(`Sarah ${eigenerName}`);
  await seite.locator('.scrim .panel').last().locator('button', { hasText: 'Anlegen und Einmal-Passwort' }).click();
  await seite.waitForSelector('.zugang', { timeout: 15000 });
  einmalNeu = (await seite.locator('.zugang__wert--gross').innerText()).trim();
  handleNeu = (await seite.locator('.zugang__wert').first().innerText()).trim().replace(/^@/, '');
  muss(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(einmalNeu), `Passwortformat unerwartet: ${einmalNeu}`);
  await seite.screenshot({ path: path.join(shots, 'einmal-passwort.png') });
  // Escape darf nur diesen Dialog schließen, nicht die ganze Verwaltung.
  await seite.keyboard.press('Escape');
  await seite.locator('.zugang').waitFor({ state: 'detached', timeout: 5000 });
  muss(await seite.locator('.admin').isVisible(), 'Escape hat auch die Verwaltung geschlossen');
  return `@${handleNeu} — ${einmalNeu}`;
});

await pruefe('Rechte einzeln entziehen', async () => {
  const eintrag = seite.locator('.admin__liste .result', { hasText: `Sarah ${eigenerName}` }).first();
  await eintrag.waitFor({ timeout: 15000 });
  await eintrag.click();
  await seite.waitForSelector('.admin__detail .row', { timeout: 10000 });
  const zeile = seite.locator('.admin__detail .row', { hasText: 'Personen erwähnen' }).first();
  await zeile.locator('.switch').click();
  await seite.waitForTimeout(900);
  const zustand = await zeile.locator('.switch').getAttribute('aria-checked');
  muss(zustand === 'false', `Schalter steht auf ${zustand}`);
  const markiert = await zeile.locator('.msg__tag').count();
  muss(markiert > 0, 'Abweichung wird nicht als solche markiert');
  await seite.screenshot({ path: path.join(shots, 'rechte.png') });
  return 'Erwähnen entzogen, als abweichend markiert';
});

await pruefe('Rolle ändern wirkt auf die Rechte', async () => {
  const vorher = await seite.locator('.admin__detail .field__label').first().innerText();
  await seite.locator('.admin__detail button', { hasText: 'Gast' }).first().click();
  await seite.waitForTimeout(900);
  const text = await seite.locator('.admin__detail').innerText();
  const treffer = /(\d+) von (\d+) erlaubt/.exec(text);
  muss(treffer, 'Rechteanzahl nicht gefunden');
  muss(Number(treffer[1]) <= 6, `Gast hat ${treffer[1]} Rechte — erwartet deutlich weniger`);
  void vorher;
  return `Gast: ${treffer[1]} von ${treffer[2]} Rechten`;
});

await pruefe('Konto sperren', async () => {
  await seite.locator('.admin__detail button', { hasText: 'Sperren' }).click();
  await seite.waitForTimeout(900);
  const zeile = seite.locator('.admin__liste .result', { hasText: `Sarah ${eigenerName}` }).first();
  await zeile.locator('.msg__tag', { hasText: 'gesperrt' }).waitFor({ timeout: 8000 });
  return 'als gesperrt markiert';
});

console.log('\nAnmeldung der neuen Person');

await pruefe('Gesperrtes Konto wird abgewiesen', async () => {
  const r = await seite.evaluate(async (pw) => {
    const res = await fetch('http://localhost:8787/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: pw.handle, password: pw.passwort }),
    });
    return { status: res.status, body: await res.json() };
  }, { handle: handleNeu, passwort: einmalNeu });
  muss(r.status === 403, `Status ${r.status} statt 403`);
  return r.body.error;
});

await browser.close();

const ok = ergebnisse.filter(Boolean).length;
console.log(`\n${'─'.repeat(58)}`);
console.log(`${ok} von ${ergebnisse.length} Prüfungen bestanden`);
process.exit(ok === ergebnisse.length ? 0 : 1);
