/**
 * Stimmen ALLE angemeldeten Randfarben mit der Seite überein?
 *
 * Es gibt nicht eine Stelle, an der eine flache Farbe für die Flächen steht,
 * die nicht die Seite malt, sondern DREI — und sie gelten in verschiedenen
 * Lagen:
 *
 *   --grund-rand (Stylesheet)        die Hintergrundfarbe der Seite selbst
 *   theme-color  (index.html)        was Safari um die Seite herum tönt
 *   theme_color / background_color   was das BETRIEBSSYSTEM nimmt, wenn die
 *   (manifest.webmanifest)           Seite als Web-App vom Startbildschirm
 *                                    läuft — also genau so, wie Don sie nutzt
 *
 * Genau daran ist es zweimal vorbeigegangen: geprüft wurde immer nur die eine
 * Stelle, die gerade in Verdacht stand. Diese Prüfung nimmt alle drei und hält
 * sie gegen die WIRKLICH gemessene unterste Bildpunktzeile der Seite. Weicht
 * eine ab, entsteht dort eine sichtbare Kante — egal wie grün die anderen sind.
 *
 * Aufruf:  node scripts/randfarben-pruefen.mjs
 */
import { webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { pngLesen, hell } from './png-lesen.mjs';
import fs from 'node:fs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const WURZEL = new URL('../packages/desktop/', import.meta.url).pathname;
const BILD = '/tmp/randfarben.png';
const GRENZE = 6;   // Helligkeitsstufen, ab denen das Auge die Kante findet

async function probeserverMitAnlaeufen(versuche = 8) {
  let letzter;
  for (let n = 0; n < versuche; n += 1) {
    try { return await probeserver(); } catch (f) { letzter = f; await new Promise((r) => setTimeout(r, 400)); }
  }
  throw letzter;
}

const zuRgb = (s) => {
  const h = String(s).trim().replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(h)) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const z = (String(s).match(/\d+/g) ?? []).slice(0, 3).map(Number);
  return z.length === 3 ? z : null;
};

/* ── Was ist überhaupt angemeldet? ───────────────────────────── */
const html = fs.readFileSync(`${WURZEL}index.html`, 'utf8');
const manifest = JSON.parse(fs.readFileSync(`${WURZEL}public/manifest.webmanifest`, 'utf8'));
const angemeldet = [
  { wo: 'index.html  theme-color',            gilt: 'Safari, um die Seite herum',      wert: (html.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/i) ?? [])[1] },
  { wo: 'manifest    theme_color',            gilt: 'WEB-APP vom Startbildschirm',     wert: manifest.theme_color },
  { wo: 'manifest    background_color',       gilt: 'WEB-APP: Startbild und Leerraum', wert: manifest.background_color },
];

/* ── Was malt die Seite unten wirklich? ──────────────────────── */
const probe = await probeserverMitAnlaeufen();
const b = await webkit.launch({ headless: true });
const ctx = await b.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, deviceScaleFactor: 1, locale: 'de-DE' });
const p = await ctx.newPage();
await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [probe.S, probe.token]);
await p.reload();
await p.waitForSelector('.app', { timeout: 20000 });
await p.addStyleTag({ content: ':root { --sicher-oben: 59px; --sicher-unten: 34px; --sicher-links: 0px; --sicher-rechts: 0px; }' });
await p.addStyleTag({ content: '.cosmos__stars { display: none !important; } .cosmos__blob { animation: none !important; }' });
await p.waitForTimeout(900);
const grundRand = await p.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
await p.screenshot({ path: BILD });
await b.close();
await probe.stop();

const bild = pngLesen(BILD);
const SPALTEN = [30, 130, 201, 300, 380];
const s = [0, 0, 0];
for (const x of SPALTEN) { const c = bild.punkt(x, bild.hoehe - 1); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
const seite = s.map((n) => Math.round(n / SPALTEN.length));

angemeldet.unshift({ wo: 'app.css     --grund-rand', gilt: 'Hintergrundfarbe der Seite', wert: grundRand });

console.log(`\n╔═══ Randfarben gegen die gemessene Seite ═══`);
console.log(`║ Unterste Bildpunktzeile der Seite: rgb(${seite.join(',')})  Helligkeit ${hell(seite)}`);
console.log('║');
let schlecht = 0;
for (const a of angemeldet) {
  const c = zuRgb(a.wert);
  if (!c) { console.log(`║ ${a.wo.padEnd(30)} — nicht gefunden —`); schlecht += 1; continue; }
  const d = Math.abs(hell(c) - hell(seite));
  const gut = d <= GRENZE;
  if (!gut) schlecht += 1;
  console.log(`║ ${gut ? '✓' : '✗'} ${a.wo.padEnd(30)} ${String(a.wert).padEnd(9)} rgb(${c.join(',')})`.padEnd(76) + `Abstand ${String(d).padStart(3)}   gilt für: ${a.gilt}`);
}
console.log('║');
console.log(schlecht
  ? `╚═══ ✗ ${schlecht} Randfarbe(n) passen nicht zur Seite — dort entsteht eine sichtbare Kante.\n`
  : '╚═══ ✓ Alle Randfarben liegen auf der Seite.\n');
process.exit(schlecht ? 1 : 0);
