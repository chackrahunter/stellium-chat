/**
 * Die kleinen Symbole für Menüleiste und Taskleiste erzeugen.
 *
 * Warum es dieses Skript gibt: `nativeImage` kann **kein SVG lesen**. Ein
 * `createFromDataURL('data:image/svg+xml;…')` liefert ein leeres Bild —
 * gemessen unter Electron 43.4.1: `isEmpty() === true`, Größe 0×0, auch nach
 * `resize()`. `new Tray(leeresBild)` wirft dabei nicht, deshalb ist es
 * jahrelang niemandem aufgefallen: in der Menüleiste war schlicht nichts.
 *
 * Also wird das SVG hier einmal beim Bauen zu echten PNG-Dateien gerastert.
 * Gezeichnet wird im Browser, den Playwright ohnehin mitbringt.
 *
 *     node scripts/symbole-erzeugen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ziel = 'packages/desktop/build';

/* Der Stellium-Stern. Dieselbe Kontur wie im Programmsymbol. */
const STERN = 'M16 3l3.2 8.6L28 14l-8.8 2.4L16 25l-3.2-8.6L4 14l8.8-2.4z';

/* macOS färbt Vorlagenbilder selbst ein und wertet dafür **nur den
   Alphakanal** aus. Schwarz auf durchsichtig ist deshalb genau richtig: die
   Menüleiste macht daraus hell oder dunkel, je nach Erscheinungsbild. Eine
   bunte Vorlage würde dort unruhig aussehen. */
const VORLAGE = (groesse) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${groesse}" height="${groesse}" viewBox="0 0 32 32">
    <path d="${STERN}" fill="#000"/>
  </svg>`;

/* Windows legt das Overlay über das Programmsymbol in der Taskleiste. Dort
   wird nichts eingefärbt — ein schwarzer Stern verschwände auf dunklem Grund.
   Also ein eigenes, sichtbares Abzeichen in den Hausfarben. */
const ABZEICHEN = (groesse) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${groesse}" height="${groesse}" viewBox="0 0 32 32">
    <defs><linearGradient id="v" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#38bdf8"/>
    </linearGradient></defs>
    <circle cx="16" cy="16" r="15" fill="url(#v)"/>
    <path d="${STERN}" fill="#fff" transform="translate(16 16) scale(0.62) translate(-16 -16)"/>
  </svg>`;

const arbeiten = [
  { datei: 'tray.png', groesse: 16, svg: VORLAGE },
  { datei: 'tray@2x.png', groesse: 32, svg: VORLAGE },
  { datei: 'abzeichen.png', groesse: 32, svg: ABZEICHEN },
];

const browser = await chromium.launch();
const seite = await browser.newPage();

for (const { datei, groesse, svg } of arbeiten) {
  await seite.setViewportSize({ width: groesse, height: groesse });
  await seite.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}</style>${svg(groesse)}`,
  );
  const bild = await seite.locator('svg').screenshot({ omitBackground: true });
  fs.writeFileSync(path.join(ziel, datei), bild);
  console.log(`  ${datei}  ${groesse}×${groesse}  ${bild.length} Byte`);
}

await browser.close();
console.log('\nFertig. Die Dateien liegen in', ziel);
