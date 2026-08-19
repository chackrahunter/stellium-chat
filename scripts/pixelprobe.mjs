/**
 * Welche Farbe hat der unterste Streifen wirklich?
 *
 * Berechnete Stile führen in die Irre: sie melden die Hintergrundfarbe eines
 * Elements, nicht das, was am Ende auf dem Schirm landet. Deshalb wird hier
 * ein Bild gemacht und die Farbe einzelner Bildpunkte ausgelesen.
 */
import { webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';
import fs from 'node:fs';
import zlib from 'node:zlib';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const probe = await probeserver();
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
await p.addStyleTag({ content: ':root { --sicher-oben: 59px; --sicher-unten: 34px; }' });
await p.waitForTimeout(1200);

/* Die Farbe eines Bildpunkts über eine Leinwand auslesen: der Browser zeichnet
   dafür den sichtbaren Ausschnitt nach — genau das, was das Auge sieht. */
const punkte = await p.evaluate(() => {
  const h = window.innerHeight, w = window.innerWidth;
  const stellen = [
    ['Mitte oben', w / 2, 120],
    ['über dem Eingabefeld', w / 2, h - 140],
    ['im Sicherheitsbereich', w / 2, h - 12],
    ['ganz unten', w / 2, h - 2],
  ];
  return stellen.map(([name, x, y]) => {
    const el = document.elementFromPoint(x, y);
    return { name, y: Math.round(y), element: el ? `${el.tagName.toLowerCase()}.${(el.className||'').toString().split(' ')[0]}` : '—' };
  });
});

await p.screenshot({ path: '/tmp/probe.png' });
await b.close();
await probe.stop();

/* PNG von Hand lesen — nur die Farbe einzelner Zeilen, ohne fremde Pakete. */
const roh = fs.readFileSync('/tmp/probe.png');
let pos = 8, breite = 0, hoehe = 0; const daten = [];
while (pos < roh.length) {
  const len = roh.readUInt32BE(pos);
  const typ = roh.toString('ascii', pos + 4, pos + 8);
  if (typ === 'IHDR') { breite = roh.readUInt32BE(pos + 8); hoehe = roh.readUInt32BE(pos + 12); }
  if (typ === 'IDAT') daten.push(roh.subarray(pos + 8, pos + 8 + len));
  pos += 12 + len;
}
const roh2 = zlib.inflateSync(Buffer.concat(daten));
const proZeile = breite * 4 + 1;
const farbe = (y) => {
  const start = y * proZeile;
  let vorher = Buffer.alloc(breite * 4);
  // Vereinfachung: nur Zeilen mit Filter 0 (ohne Vorhersage) direkt lesen.
  for (let i = 0; i <= y; i += 1) {
    const f = roh2[i * proZeile];
    const zeile = roh2.subarray(i * proZeile + 1, (i + 1) * proZeile);
    if (f === 0) vorher = Buffer.from(zeile);
    else if (f === 2) { const n = Buffer.alloc(breite * 4); for (let x = 0; x < breite * 4; x += 1) n[x] = (zeile[x] + vorher[x]) & 255; vorher = n; }
    else return null;
  }
  const x = Math.floor(breite / 2) * 4;
  return `rgb(${vorher[x]}, ${vorher[x + 1]}, ${vorher[x + 2]})`;
};

console.log(`\nBild ${breite}×${hoehe}\n`);
for (const s of punkte) {
  console.log(`  ${s.name.padEnd(24)} y=${String(s.y).padStart(4)}  ${(farbe(s.y) ?? 'nicht lesbar').padEnd(20)} ${s.element}`);
}
