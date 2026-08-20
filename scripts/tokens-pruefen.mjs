/**
 * Zeigt jede Regel auf einen Namen, den es gibt?
 *
 * `color: var(--gibtsnicht)` ist kein Syntaxfehler. Der Browser wirft die
 * **ganze Deklaration** weg, lautlos, und die Regel tut einfach nichts. Kein
 * Werkzeug meldet es: der Typecheck sieht kein CSS, die Bildschirmabzüge
 * zeigen etwas, das plausibel aussieht, und im Entwicklerwerkzeug steht die
 * Zeile ordentlich da — nur ohne Wirkung.
 *
 * Genau so sind hier 60 Regeln ins Leere gelaufen: `--text-dim`,
 * `--bg-sunken` und `--text` wurden benutzt, aber nie erklärt. Am sichtbarsten
 * an den Filterreitern der Ideentafel, wo der aktive vom inaktiven kaum zu
 * unterscheiden war, weil bei beiden Farbe *und* Grund ausfielen.
 *
 * Geprüft wird beides: die Stilvorlagen und die `style={{ }}`-Angaben im
 * Quelltext — dort steht dieselbe Sorte Name, und dort fällt es genauso aus.
 *
 *     node scripts/tokens-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const STILE = 'packages/desktop/src/styles';
const QUELLE = 'packages/desktop/src';

/* Namen, die nicht aus unseren Vorlagen kommen und deshalb kein Fund sind. */
const VON_AUSSEN = new Set([
  'sicher-oben', 'sicher-unten', 'sicher-links', 'sicher-rechts', // aus env(), in tokens.css gesetzt
]);

function dateien(verzeichnis, endung) {
  const raus = [];
  for (const e of fs.readdirSync(verzeichnis, { withFileTypes: true })) {
    const voll = path.join(verzeichnis, e.name);
    if (e.isDirectory()) raus.push(...dateien(voll, endung));
    else if (endung.test(e.name)) raus.push(voll);
  }
  return raus;
}

/* ── Was erklärt wird ────────────────────────────────────────── */

const erklaert = new Set();
for (const datei of dateien(STILE, /\.css$/)) {
  const text = fs.readFileSync(datei, 'utf8');
  for (const m of text.matchAll(/(^|[;{\s])(--[\w-]+)\s*:/g)) erklaert.add(m[2]);
}

/* ── Was benutzt wird ────────────────────────────────────────── */

const benutzt = new Map(); // Name → [wo, …]
const merken = (name, wo) => {
  if (!benutzt.has(name)) benutzt.set(name, []);
  const liste = benutzt.get(name);
  if (!liste.includes(wo)) liste.push(wo);
};

for (const datei of dateien(STILE, /\.css$/)) {
  const kurz = path.relative(STILE, datei);
  for (const m of fs.readFileSync(datei, 'utf8').matchAll(/var\(\s*(--[\w-]+)/g)) {
    merken(m[1], kurz);
  }
}

/* Dieselbe Sorte Name steht auch in den style={{ }}-Angaben. */
for (const datei of dateien(QUELLE, /\.tsx?$/)) {
  if (datei.includes('/styles/')) continue;
  const kurz = path.relative(QUELLE, datei);
  for (const m of fs.readFileSync(datei, 'utf8').matchAll(/var\(\s*(--[\w-]+)/g)) {
    merken(m[1], kurz);
  }
}

/* ── Urteil ──────────────────────────────────────────────────── */

const F = { rot: '[31m', gruen: '[32m', grau: '[90m', aus: '[0m' };
const fehlend = [...benutzt.entries()]
  .filter(([name]) => !erklaert.has(name) && !VON_AUSSEN.has(name.slice(2)))
  .sort((a, b) => b[1].length - a[1].length);

console.log(`\n  ${erklaert.size} Namen erklärt · ${benutzt.size} benutzt\n`);

if (!fehlend.length) {
  console.log(`  ${F.gruen}✓${F.aus} Jede Regel zeigt auf einen Namen, den es gibt.\n`);
  process.exit(0);
}

console.log(`  ${F.rot}✗ ${fehlend.length} Name(n) werden benutzt, aber nie erklärt.${F.aus}`);
console.log(`  ${F.grau}Jede solche Deklaration fällt vollständig aus — lautlos.${F.aus}\n`);
for (const [name, orte] of fehlend) {
  console.log(`      ${name}`);
  console.log(`        ${F.grau}${orte.slice(0, 4).join(', ')}${orte.length > 4 ? ` … und ${orte.length - 4} weitere` : ''}${F.aus}`);
}
console.log('');
process.exit(1);
