/**
 * Malt eine fixierte Ebene den Grund? Dann fehlt am Rand etwas.
 *
 * Safari ab iOS 26 zeichnet ein `position: fixed`-Element mit deckendem
 * Hintergrund **nicht bis zum Schirmrand**: was unter die Bedienelemente
 * reicht, wird abgeschnitten statt dahinter gezeichnet. Ein bekannter
 * WebKit-Fehler, nicht unserer — aber wir müssen damit leben.
 *
 * Wir sind zweimal hineingelaufen:
 *
 *   1. `.cosmos` stand auf --bg-void, während `html` schon auf --grund-rand
 *      lief. Weil .cosmos obendrauf liegt, war am Rand die falsche Farbe zu
 *      sehen — behoben, indem beide denselben Grund bekamen.
 *   2. Damit war die Farbe richtig, aber die Fläche blieb: auf dem Gerät
 *      gemessen 62 Punkte hoch, flach, mit gerader sichtbarer Kante. Denn
 *      abgeschnitten wird sie unabhängig davon, welche Farbe sie hat.
 *
 * Die Lehre daraus, und die Regel, die diese Prüfung durchsetzt:
 * **Der Grund gehört auf `html`.** Ein Wurzelhintergrund füllt die Leinwand
 * immer vollständig, weil er nicht fixiert ist und damit gar nicht in diesen
 * Fehler laufen kann. Fixierte Ebenen dürfen darüber Verläufe, Sterne und
 * Blasen legen — aber nichts Deckendes, das am Rand fehlen könnte.
 *
 *     node scripts/randfarbe-pruefen.mjs
 */
import fs from 'node:fs';

const DATEI = 'packages/desktop/src/styles/app.css';
const F = { rot: '\x1b[31m', gruen: '\x1b[32m', grau: '\x1b[90m', aus: '\x1b[0m' };
/* Kommentare zuerst heraus. In ihnen stehen geschweifte Klammern und
   Doppelpunkte, und daran ist die erste Fassung dieses Zerlegers gescheitert:
   sie fand die html-Regel nicht und meldete, html habe gar keinen Grund. */
const roh = fs.readFileSync(DATEI, 'utf8');
const text = roh.replace(/\/\*[\s\S]*?\*\//g, (t) => t.replace(/[^\n]/g, ' '));

/** Alle Regelblöcke mit ihrem Selektor und Rumpf. */
function bloecke() {
  const raus = [];
  const re = /(^|\})\s*([^{}@][^{}]*?)\s*\{([^{}]*)\}/gms;
  let m;
  while ((m = re.exec(text))) {
    const zeile = text.slice(0, m.index).split('\n').length;
    raus.push({ zeile, sel: m[2].trim().replace(/\s+/g, ' '), rumpf: m[3] });
  }
  return raus;
}

const alle = bloecke();
let fehler = 0;
console.log('');

/* ── 1. Hat `html` einen Grund? ──────────────────────────────── */

const wurzel = alle.find((b) => /^html\b/.test(b.sel) && /background\s*:/.test(b.rumpf));
if (!wurzel) {
  console.log(`  ${F.rot}✗${F.aus} html hat keinen Hintergrund — dann füllt nichts verlässlich die Ränder.`);
  fehler++;
} else {
  const letzter = wurzel.rumpf.match(/background:\s*([\s\S]*?);/)[1].split(',').pop().trim();
  console.log(`  ${F.gruen}✓${F.aus} html trägt den Grund: ${letzter}`);
}

/* ── 2. Malt eine fixierte Ebene etwas Deckendes? ───────────── */

/** Ein Verlauf, der in `transparent` ausläuft, ist harmlos: fehlt er am Rand,
 *  sieht man den Unterschied nicht. Gefährlich ist nur eine flache Farbe. */
function deckend(wert) {
  const ohneVerlaeufe = wert.replace(/(radial|linear|conic)-gradient\([^()]*(\([^()]*\)[^()]*)*\)/g, '');
  return /#[0-9a-f]{3,8}|rgba?\(|hsla?\(|var\(--/i.test(ohneVerlaeufe);
}

const verdaechtig = alle.filter((b) =>
  /position:\s*fixed/.test(b.rumpf) && /background\s*:/.test(b.rumpf));

for (const b of verdaechtig) {
  const wert = b.rumpf.match(/background:\s*([\s\S]*?);/)?.[1] ?? '';
  const raus = deckend(wert);
  const reicht = /inset:\s*calc\(\s*-/.test(b.rumpf);
  if (raus && reicht) {
    console.log(`  ${F.rot}✗${F.aus} ${b.sel} (Z.${b.zeile}) ist fixiert, reicht über den Rand hinaus`);
    console.log(`      und malt etwas Deckendes: ${F.grau}${wert.split(',').pop().trim()}${F.aus}`);
    console.log(`      ${F.grau}Safari schneidet das am unteren Rand ab — dort bleibt eine Fläche.${F.aus}`);
    fehler++;
  }
}

if (!verdaechtig.length || !fehler) {
  console.log(`  ${F.gruen}✓${F.aus} Keine fixierte Ebene malt einen deckenden Grund über die Kante hinaus.`);
}

console.log(fehler
  ? `\n  ${F.rot}${fehler} Fund(e).${F.aus}\n`
  : `\n  ${F.gruen}Der Rand kann nicht ausfallen.${F.aus}\n`);
process.exit(fehler ? 1 : 0);
