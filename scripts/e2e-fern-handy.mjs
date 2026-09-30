/**
 * Fernsteuerung im Browser auf dem Telefon — von der Oberfläche bis zum Pi.
 *
 * Headless Chrome als iPhone (Touch, schmaler Schirm, `pointer: coarse`),
 * die gebaute Oberfläche vom Probeserver ausgeliefert wie im Betrieb, der
 * ECHTE Pi-Dienst mit einem nachgemachten Abgreifer, der echtes H.264 aus
 * ffmpeg abspielt. Geprüft wird der ganze Weg:
 *
 *   Stern-Menü → Eintrag da → Verbinden → Bild dekodiert (Bildpunkte auf der
 *   Leinwand, nicht nur „Bytes kamen an") → Tippen = Klick an der richtigen
 *   Stelle → Ziehen → langes Drücken = Rechtsklick → zwei Finger zoomen →
 *   Bildschirmtastatur tippt → nichts ragt über den Rand.
 *
 * Braucht: Google Chrome (Playwright-Kanal „chrome" — Chromium ohne Marke
 * kann kein H.264), ffmpeg. Kein laufender Server, kein Pi.
 *
 *     node scripts/e2e-fern-handy.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { kennungNeu } from '../server-setup/fernsteuerung/dienst/anmeldung.mjs';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(wurzel);

let fehler = 0;
const pruefe = (was, ok, zusatz = '') => {
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${was}${zusatz ? `  \x1b[90m${zusatz}\x1b[0m` : ''}`);
};
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
async function bis(bedingung, fristMs = 10_000) {
  const ende = Date.now() + fristMs;
  while (Date.now() < ende) { if (await bedingung()) return true; await schlaf(50); }
  return Boolean(await bedingung());
}

/* ── Oberfläche bauen, falls sie älter ist als ihre Quellen ──── */

function juengste(ordner) {
  let n = 0;
  const gehe = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) gehe(p); else n = Math.max(n, fs.statSync(p).mtimeMs);
    }
  };
  try { gehe(ordner); } catch { return 0; }
  return n;
}
if (juengste('packages/desktop/dist') < juengste('packages/desktop/src')) {
  console.log('Oberfläche wird gebaut …');
  execFileSync('npm', ['run', 'build:web', '-w', '@stellium/desktop'], { stdio: 'pipe' });
}

/* ── Echtes H.264 für den nachgemachten Abgreifer ────────────── */

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'fern-handy-'));
const film = path.join(ordner, 'film.h264');
/* Dasselbe Profil, das der Pi kodiert (Constrained Baseline 3.1, siehe
   `avc1.42E01F` in Fernsteuerung.tsx), Annex-B, ein Trennzeichen (AUD) vor
   jedem Bild und SPS/PPS vor jedem Schlüsselbild — so wie x264 auf dem Pi. */
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=15', '-t', '2',
  '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p',
  '-x264-params', 'keyint=15:aud=1:repeat-headers=1', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', film]);

const abgreifer = path.join(ordner, 'abgreifer.mjs');
fs.writeFileSync(abgreifer, `#!/usr/bin/env node
import fs from 'node:fs';
const merk = (z) => { try { fs.appendFileSync(process.env.PROBE_LOG, z + '\\n'); } catch {} };
merk('start');
const roh = fs.readFileSync(process.env.PROBE_FILM);
/* Am Trennzeichen (00 00 00 01 09) in Einzelbilder schneiden. */
const bilder = [];
let anfang = 0;
for (let i = 4; i + 4 < roh.length; i++) {
  if (roh[i] === 0 && roh[i + 1] === 0 && roh[i + 2] === 0 && roh[i + 3] === 1 && (roh[i + 4] & 0x1f) === 9) {
    bilder.push(roh.subarray(anfang, i)); anfang = i;
  }
}
bilder.push(roh.subarray(anfang));
function rahmen(art, inhalt) {
  const kopf = Buffer.alloc(5); kopf[0] = art; kopf.writeUInt32LE(inhalt.length, 1);
  process.stdout.write(Buffer.concat([kopf, inhalt]));
}
let n = 0;
setInterval(() => rahmen(1, bilder[n++ % bilder.length]), 66);
setInterval(() => rahmen(3, Buffer.from('15,0 B/s')), 500);
let rest = '';
process.stdin.on('data', (d) => {
  rest += String(d);
  for (;;) {
    const i = rest.indexOf('\\n'); if (i < 0) break; const z = rest.slice(0, i); rest = rest.slice(i + 1);
    if (z) merk('befehl ' + z);
    /* Wie der echte: die neue Auswahl kommt als Rahmen 2 zurück. */
    if (z.startsWith('a ')) rahmen(2, Buffer.from(z.slice(2), 'base64'));
  }
});
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o755 });

/* ── Pi-Dienst ───────────────────────────────────────────────── */

const kennung = kennungNeu(ordner);
const LOG = path.join(ordner, 'abgreifer.log');
const HAFEN = await new Promise((fertig) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => fertig(p)); });
});
const dienst = spawn(process.execPath, ['server-setup/fernsteuerung/dienst/fern-dienst.mjs'], {
  env: { ...process.env, FERN_ORDNER: ordner, FERN_HOST: abgreifer, FERN_PORT: String(HAFEN),
    PROBE_LOG: LOG, PROBE_FILM: film },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let dienstAusgabe = '';
dienst.stderr.on('data', (d) => { dienstAusgabe += d; });
await bis(() => dienstAusgabe.includes('lauscht auf'));
const befehle = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n') : [])
  .filter((z) => z.startsWith('befehl ')).map((z) => z.slice(7));

/* ── Server mit hinterlegtem Zugang ──────────────────────────── */

let probe = null;
let browser = null;
const aufraeumen = async () => {
  try { await browser?.close(); } catch { /* zu */ }
  try { await probe?.stop(); } catch { /* weg */ }
  try { dienst.kill('SIGKILL'); } catch { /* weg */ }
  fs.rmSync(ordner, { recursive: true, force: true });
};
/* Auch bei einem Abbruch mitten drin: kein Dienst, der weiterläuft, kein
   Ordner, der liegen bleibt. */
process.once('exit', () => { try { dienst.kill('SIGKILL'); } catch { /* weg */ } fs.rmSync(ordner, { recursive: true, force: true }); });
try {
  probe = await probeserver();
  const r = await fetch(`${probe.S}/api/fern/zugang`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${probe.token}` },
    /* Das Passwort geht nur hierhin und wird nirgends ausgegeben. */
    body: JSON.stringify({ adresse: `ws://127.0.0.1:${HAFEN}`, passwort: kennung.klartext, kennung: kennung.id }),
  });
  pruefe('Zugang hinterlegt', r.ok, String(r.status));

  /* ── Browser als iPhone ────────────────────────────────────── */

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'de-DE' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: probe.S });
  const p = await ctx.newPage();
  const konsole = [];
  p.on('pageerror', (f) => konsole.push(String(f)));
  await p.goto(probe.S);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 30_000 });
  await p.evaluate(() => navigator.clipboard.writeText('vorher'));

  console.log('\nMenü');
  pruefe('das Gerät gilt als Telefon (pointer: coarse)', await p.evaluate(() => matchMedia('(pointer: coarse)').matches));
  pruefe('WebCodecs sind da', await p.evaluate(() => typeof VideoDecoder !== 'undefined'));
  /* Auf dem Telefon steckt die Leiste mit dem Stern in der Schublade. */
  const stern = p.locator('.rail__logo--knopf').first();
  if (!(await stern.isVisible())) {
    await p.locator('.header__menue').click();
    await stern.waitFor({ state: 'visible', timeout: 5000 });
  }
  await stern.click();
  const eintrag = p.getByRole('menuitem', { name: 'Pi fernsteuern' });
  await eintrag.waitFor({ timeout: 5000 }).catch(() => { /* das sagt die Prüfung darunter */ });
  pruefe('„Pi fernsteuern" steht im Stern-Menü des Browsers', await eintrag.count() === 1);
  await eintrag.click();
  await p.waitForSelector('.fern-fenster--handy', { timeout: 10_000 });
  pruefe('öffnet als Vollbild, nicht als Tafel', await p.locator('.panel .fern').count() === 0);

  console.log('\nVerbinden');
  const netz = [];
  p.on('websocket', (w) => netz.push(w.url()));
  await p.getByRole('button', { name: 'Verbinden' }).click();
  pruefe('Verbindung steht', await bis(() => p.locator('.fern__hinweis').count().then((n) => n === 0)));
  pruefe('über den Chat-Server, nicht direkt zum Pi',
    netz.some((u) => u.endsWith('/api/fern/leitung')) && !netz.some((u) => u.includes(`:${HAFEN}`)), netz.join(' '));
  const bunt = () => p.evaluate(() => {
    const c = document.querySelector('.fern__schirm');
    if (!c || !c.width) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
    return n;
  });
  pruefe('das Bild ist dekodiert und gemalt (Bildpunkte, nicht nur Bytes)', await bis(async () => (await bunt()) > 50),
    `${await bunt()} helle Stichproben`);
  const groesse = await p.evaluate(() => { const c = document.querySelector('.fern__schirm'); return [c.width, c.height]; });
  pruefe('in der Größe des Stroms', groesse[0] === 640 && groesse[1] === 360, groesse.join('×'));

  console.log('\nFinger');
  await p.getByRole('button', { name: /nur zusehen/ }).click();
  await bis(() => p.locator('.fern__knopf--an').count().then((n) => n > 0));
  const rahmen = await p.locator('.fern__schirm').boundingBox();
  pruefe('der Schirm passt in die Breite des Telefons', rahmen.x >= 0 && rahmen.x + rahmen.width <= 390 + 1,
    `${Math.round(rahmen.x)}..${Math.round(rahmen.x + rahmen.width)}`);

  /* Berührungen über CDP — so kommen sie im Browser als echte Touch-Pointer
     an, mit pointerType „touch", wie auf dem Telefon. */
  const cdp = await ctx.newCDPSession(p);
  const beruehren = (typ, punkte) => cdp.send('Input.dispatchTouchEvent', {
    type: typ, touchPoints: punkte.map(([x, y], id) => ({ x, y, id })),
  });
  const mitte = [rahmen.x + rahmen.width / 2, rahmen.y + rahmen.height / 2];
  const erwartet = (x, y) => [
    Math.round((x - rahmen.x) / rahmen.width * 65535), Math.round((y - rahmen.y) / rahmen.height * 65535)];

  const vorher = befehle().length;
  await beruehren('touchStart', [mitte]);
  await beruehren('touchEnd', []);
  await bis(() => befehle().length >= vorher + 3);
  const klick = befehle().slice(vorher);
  const [ex, ey] = erwartet(...mitte);
  const zeiger = klick.find((z) => z.startsWith('z '))?.split(' ').map(Number);
  pruefe('Tippen = Linksklick', klick.includes('t 272 1') && klick.includes('t 272 0'), klick.join(' | '));
  pruefe('…an der getippten Stelle', zeiger && Math.abs(zeiger[1] - ex) < 700 && Math.abs(zeiger[2] - ey) < 700,
    `${zeiger?.slice(1).join(' ')} statt ${ex} ${ey}`);
  pruefe('…und genau einmal (keine nachgemachten Mausereignisse)',
    klick.filter((z) => z === 't 272 1').length === 1, klick.join(' | '));

  let v = befehle().length;
  await beruehren('touchStart', [[mitte[0] - 60, mitte[1]]]);
  for (let i = 1; i <= 6; i++) { await beruehren('touchMove', [[mitte[0] - 60 + i * 20, mitte[1]]]); }
  await beruehren('touchEnd', []);
  await bis(() => befehle().slice(v).includes('t 272 0'));
  const zug = befehle().slice(v);
  pruefe('Ziehen = Knopf runter, Zeiger wandert, Knopf hoch',
    zug[1] === 't 272 1' && zug.filter((z) => z.startsWith('z ')).length >= 5 && zug.at(-1) === 't 272 0', zug.join(' | '));

  v = befehle().length;
  await beruehren('touchStart', [mitte]);
  await schlaf(800);
  await beruehren('touchEnd', []);
  await bis(() => befehle().slice(v).includes('t 273 0'));
  pruefe('langes Drücken = Rechtsklick', befehle().slice(v).includes('t 273 1') && !befehle().slice(v).includes('t 272 1'),
    befehle().slice(v).join(' | '));

  v = befehle().length;
  await beruehren('touchStart', [[mitte[0] - 30, mitte[1]], [mitte[0] + 30, mitte[1]]]);
  for (let i = 1; i <= 5; i++) {
    await beruehren('touchMove', [[mitte[0] - 30 - i * 15, mitte[1]], [mitte[0] + 30 + i * 15, mitte[1]]]);
  }
  await beruehren('touchEnd', []);
  await schlaf(200);
  const zoom = await p.evaluate(() => getComputedStyle(document.querySelector('.fern__schirm')).transform);
  pruefe('zwei Finger auseinander vergrößern die Ansicht', zoom !== 'none' && /matrix\(([\d.]+)/.exec(zoom)?.[1] > 1.5, zoom);
  pruefe('…ohne dass beim Pi etwas ankommt', befehle().length === v, befehle().slice(v).join(' | '));
  const gross = await p.locator('.fern__schirm').boundingBox();
  await beruehren('touchStart', [mitte]);
  await beruehren('touchEnd', []);
  await bis(() => befehle().length >= v + 3);
  const imZoom = befehle().slice(v).find((z) => z.startsWith('z '))?.split(' ').map(Number);
  const ez = [Math.round((mitte[0] - gross.x) / gross.width * 65535), Math.round((mitte[1] - gross.y) / gross.height * 65535)];
  pruefe('Tippen im vergrößerten Bild trifft trotzdem die richtige Stelle',
    imZoom && Math.abs(imZoom[1] - ez[0]) < 700 && Math.abs(imZoom[2] - ez[1]) < 700, `${imZoom?.slice(1).join(' ')} statt ${ez.join(' ')}`);

  console.log('\nBildschirmtastatur');
  await p.getByRole('button', { name: 'Tastatur' }).first().click();
  pruefe('das unsichtbare Feld hat den Fokus (öffnet auf iOS die Tastatur)',
    await p.evaluate(() => document.activeElement?.classList.contains('fern__eingabe')));
  v = befehle().length;
  await p.keyboard.type('Hi!');
  await p.keyboard.press('Backspace');
  await p.keyboard.press('Enter');
  await bis(() => befehle().slice(v).filter((z) => z === 'k 28 0').length > 0);
  const getippt = befehle().slice(v).filter((z) => z.startsWith('k ')).join(',');
  pruefe('„Hi!", Rücktaste, Eingabe kommen als Tasten der US-Belegung an',
    getippt === 'k 42 1,k 35 1,k 35 0,k 42 0,k 23 1,k 23 0,k 42 1,k 2 1,k 2 0,k 42 0,k 14 1,k 14 0,k 28 1,k 28 0', getippt);
  pruefe('das Feld bleibt leer (nichts für die Autokorrektur)',
    await p.evaluate(() => document.querySelector('.fern__eingabe').value === ''));
  const langerText = 'abc def! '.repeat(40);
  v = befehle().length;
  await p.keyboard.insertText(langerText);
  const erwarteteZeilen = [...langerText].reduce((n, z) => n + (/[a-z ]/.test(z) ? 2 : 4), 0);
  const kZeilen = () => befehle().slice(v).filter((z) => z.startsWith('k ')).length;
  await bis(() => kZeilen() >= erwarteteZeilen);
  pruefe(`ein Text mit ${langerText.length} Zeichen kommt vollständig an (in Stücken)`,
    kZeilen() === erwarteteZeilen, `${kZeilen()} von ${erwarteteZeilen} Zeilen`);
  v = befehle().length;
  await p.keyboard.insertText('Grüße');
  await bis(() => befehle().slice(v).join(',').includes('k 29 1,k 47 1,k 47 0,k 29 0'));
  const ablage = befehle().slice(v).find((z) => z.startsWith('a '));
  pruefe('„Grüße" geht über die Ablage des Pi und Strg+V',
    ablage && Buffer.from(ablage.slice(2), 'base64').toString('utf8') === 'Grüße'
    && befehle().slice(v).join(',').includes('k 29 1,k 47 1,k 47 0,k 29 0'), befehle().slice(v).join(' | '));

  console.log('\nAblage des Pi');
  /* Der Pi meldet die neue Auswahl zurück (hier: „Grüße" von eben). Sie
     darf die Ablage des Telefons nicht ungefragt überschreiben. */
  const knopf = p.getByRole('button', { name: 'Ablage des Pi übernehmen' });
  pruefe('ein Knopf bietet sie an', await bis(() => knopf.count().then((n) => n === 1)));
  pruefe('…die Ablage des Telefons ist unverändert',
    await p.evaluate(() => navigator.clipboard.readText()) !== 'Grüße');
  await knopf.click();
  pruefe('erst der Druck übernimmt sie', await bis(() => p.evaluate(() => navigator.clipboard.readText()).then((t) => t === 'Grüße')));

  console.log('\nRand');
  const ueber = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  pruefe('nichts läuft seitlich über', ueber <= 1, `${ueber} px`);
  const leiste = await p.locator('.fern-fenster__leiste').boundingBox();
  pruefe('die Werkzeugleiste passt auf den Schirm', leiste.x >= 0 && leiste.x + leiste.width <= 391);
  pruefe('keine Fehler in der Seite', konsole.length === 0, konsole.join(' | ').slice(0, 300));

  await p.getByRole('button', { name: 'Trennen' }).click();
  pruefe('Trennen gibt den Platz auf dem Pi frei',
    await bis(() => JSON.parse(fs.readFileSync(path.join(ordner, 'zustand.json'), 'utf8')).zuschauer === 0));
} catch (f) {
  fehler++;
  console.log(`\x1b[31m✗ abgebrochen: ${f.message.split('\n')[0]}\x1b[0m`);
} finally {
  await aufraeumen();
}

console.log(fehler
  ? `\n\x1b[31m${fehler} Prüfung(en) fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mFernsteuerung im Telefon-Browser: Menü, Bild, Tippen, Ziehen, Rechtsklick, Zoom und Tastatur gehen durch.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
