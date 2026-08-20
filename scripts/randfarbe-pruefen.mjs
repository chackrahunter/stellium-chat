/**
 * Haben die beiden Hintergrundebenen denselben Grund?
 *
 * `html` und `.cosmos` tragen dieselben drei Verläufe. Der Sinn davon: was am
 * Rand liegt, sieht dann aus wie der Rest — egal, welche Fläche der Browser
 * gerade abliest, um den Bereich hinter seinen eigenen Leisten zu füllen.
 *
 * Nur zählt für diesen Bereich **kein Verlauf**, sondern ausschließlich die
 * flache Grundfarbe darunter. Stehen die beiden Ebenen auf verschiedenem
 * Grund, entsteht dort ein Streifen — und zwar in der Farbe der oberen Ebene,
 * weil sie die untere überdeckt.
 *
 * Genau das ist passiert: `html` wurde auf `--grund-rand` umgestellt,
 * `.cosmos` blieb auf `--bg-void`. Die Änderung wirkte deshalb nirgends. Auf
 * dem iPhone gemessen: unten 98 Punkte, oben 61,7 Punkte flaches #050610 —
 * die alte Farbe, obwohl Manifest, `theme-color` und `--grund-rand` alle
 * längst auf #172736 standen.
 *
 * Das war nicht am Bildschirmabzug zu sehen und nicht am Quelltext: die
 * Änderung sah richtig aus, sie lag nur eine Ebene zu tief. Deshalb diese
 * Prüfung.
 *
 *     node scripts/randfarbe-pruefen.mjs
 */
import fs from 'node:fs';

const DATEI = 'packages/desktop/src/styles/app.css';
const F = { rot: '\x1b[31m', gruen: '\x1b[32m', grau: '\x1b[90m', aus: '\x1b[0m' };

const text = fs.readFileSync(DATEI, 'utf8');

/** Die letzte Farbangabe einer `background`-Kurzschreibweise ist der Grund —
 *  alles davor sind Verläufe, die darüber liegen. */
function grundVon(regel) {
  const anfang = text.indexOf(regel);
  if (anfang < 0) return { fehler: `${regel} nicht gefunden` };
  const block = text.slice(anfang, text.indexOf('}', anfang));
  const bg = block.match(/background:\s*([\s\S]*?);/);
  if (!bg) return { fehler: `${regel} hat keine background-Angabe` };
  const teile = bg[1].split(',');
  const letzter = teile[teile.length - 1].trim();
  const name = letzter.match(/var\(\s*(--[\w-]+)/);
  return name ? { grund: name[1] } : { grund: letzter };
}

const a = grundVon('\nhtml {');
const b = grundVon('\n.cosmos {');

console.log('');
for (const [wo, w] of [['html', a], ['.cosmos', b]]) {
  if (w.fehler) {
    console.log(`  ${F.rot}✗${F.aus} ${w.fehler}`);
  } else {
    console.log(`  ${wo.padEnd(9)} Grund: ${w.grund}`);
  }
}

if (a.fehler || b.fehler) { console.log(''); process.exit(1); }

if (a.grund !== b.grund) {
  console.log(`\n  ${F.rot}✗ Die beiden Ebenen stehen auf verschiedenem Grund.${F.aus}`);
  console.log(`  ${F.grau}.cosmos liegt über html und reicht bis in die Ecken — sichtbar am`);
  console.log(`  Rand ist also ${b.grund}, nicht ${a.grund}. Dort entsteht ein Streifen.${F.aus}\n`);
  process.exit(1);
}

console.log(`\n  ${F.gruen}✓${F.aus} Beide Ebenen stehen auf demselben Grund — am Rand kann kein`);
console.log(`    Streifen entstehen, gleich welche Fläche der Browser abliest.\n`);
