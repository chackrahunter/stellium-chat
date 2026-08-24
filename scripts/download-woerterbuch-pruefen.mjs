#!/usr/bin/env node
/**
 * Ist packages/server/src/http/download/download-i18n.ts noch deckungsgleich
 * mit den 22 Wörterbüchern in packages/desktop/src/i18n/ und mit VON_RECHTS
 * in packages/desktop/src/i18n/kern.ts?
 *
 * WARUM DAS EIN EIGENER LAUF IST
 * Dieselbe Lage wie bei scripts/push-woerterbuch-pruefen.mjs (siehe dessen
 * Dateikopf): ein erneuter Lauf des Erzeugers hält download-i18n.ts von
 * selbst deckungsgleich, diese Prüfung fängt trotzdem ab, wenn jemand die
 * Datei von Hand ändert (der Dateikopf dort verbietet es, hält aber niemanden
 * zuverlässig ab) oder eine Quelle sich ändert, ohne dass der Erzeuger danach
 * erneut läuft.
 *
 * Am einfachsten Erzeuger und Prüfung hintereinander laufen lassen:
 *
 *   node scripts/download-woerterbuch-erzeugen.mjs && node scripts/download-woerterbuch-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = path.join(REPO, 'packages/desktop/src/i18n');
const KERN_DATEI = path.join(I18N_DIR, 'kern.ts');
const DOWNLOAD_I18N = path.join(REPO, 'packages/server/src/http/download/download-i18n.ts');

/** Zeilen der Form   'schlüssel': 'wert',   ODER  'schlüssel': "wert",  —
 *  mit beliebiger fester Einrückung (2 Leerzeichen in den 22 Wörterbüchern,
 *  4 in download-i18n.ts, weil dort eine Ebene tiefer verschachtelt). */
function woerterbuchLesen(text) {
  const eintraege = {};
  const muster = /^\s+'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*$/gm;
  let treffer;
  while ((treffer = muster.exec(text))) {
    const roh = treffer[2] ?? treffer[3] ?? '';
    eintraege[treffer[1]] = roh
      .replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return eintraege;
}

/** download-i18n.ts in seine Sprachblöcke zerlegen: "  de: {" … "  },". */
function downloadWoerterbuecher(text) {
  const bloecke = {};
  const musterBlock = /^ {2}([a-z]{2}): \{\n([\s\S]*?)\n {2}\},$/gm;
  let treffer;
  while ((treffer = musterBlock.exec(text))) {
    bloecke[treffer[1]] = woerterbuchLesen(treffer[2]);
  }
  return bloecke;
}

function rtlSprachenLesen(datei) {
  const text = fs.readFileSync(datei, 'utf8');
  const treffer = /const VON_RECHTS = new Set\(\[([^\]]*)\]\)/.exec(text);
  if (!treffer) return null;
  return [...treffer[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
}

if (!fs.existsSync(DOWNLOAD_I18N)) {
  console.log(`✗ ${path.relative(REPO, DOWNLOAD_I18N)} gibt es nicht — node scripts/download-woerterbuch-erzeugen.mjs laufen lassen.`);
  process.exit(1);
}

const downloadText = fs.readFileSync(DOWNLOAD_I18N, 'utf8');
const downloadWb = downloadWoerterbuecher(downloadText);
const sprachen = Object.keys(downloadWb).sort();

if (sprachen.length < 22) {
  console.log(`✗ Nur ${sprachen.length} Sprachblöcke in download-i18n.ts erkannt — Parser oder Datei prüfen.`);
  process.exit(1);
}

let abweichungen = 0;
let geprueft = 0;

for (const sprache of sprachen) {
  const quelleDatei = path.join(I18N_DIR, `${sprache}.ts`);
  if (!fs.existsSync(quelleDatei)) {
    console.log(`✗ ${sprache}: kein ${sprache}.ts in packages/desktop/src/i18n/`);
    abweichungen += 1;
    continue;
  }
  const quelle = woerterbuchLesen(fs.readFileSync(quelleDatei, 'utf8'));
  const zielSchluessel = Object.keys(downloadWb[sprache]).sort();

  for (const schluessel of zielSchluessel) {
    geprueft += 1;
    const downloadWert = downloadWb[sprache][schluessel];
    const quellWert = quelle[schluessel];
    if (quellWert === undefined) {
      console.log(`✗ ${sprache}.${schluessel}: in download-i18n.ts, aber kein solcher Schlüssel in src/i18n/${sprache}.ts`);
      abweichungen += 1;
    } else if (quellWert !== downloadWert) {
      console.log(`✗ ${sprache}.${schluessel}: weicht ab`);
      console.log(`    download-i18n.ts:       ${downloadWert}`);
      console.log(`    src/i18n/${sprache}.ts: ${quellWert}`);
      abweichungen += 1;
    }
  }
}

/* RTL_SPRACHEN gegen VON_RECHTS aus kern.ts. */
const rtlQuelle = rtlSprachenLesen(KERN_DATEI);
const musterRtl = /export const RTL_SPRACHEN: readonly string\[\] = \[([^\]]*)\];/.exec(downloadText);
const rtlZiel = musterRtl ? [...musterRtl[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort() : null;

if (!rtlQuelle) {
  console.log('✗ VON_RECHTS in packages/desktop/src/i18n/kern.ts nicht gefunden — Muster geändert?');
  abweichungen += 1;
} else if (!rtlZiel) {
  console.log('✗ RTL_SPRACHEN in download-i18n.ts nicht gefunden — Muster geändert?');
  abweichungen += 1;
} else if (rtlQuelle.join(',') !== rtlZiel.join(',')) {
  console.log(`✗ RTL_SPRACHEN weicht von VON_RECHTS ab: [${rtlZiel.join(', ')}] statt [${rtlQuelle.join(', ')}]`);
  abweichungen += 1;
} else {
  console.log(`RTL_SPRACHEN deckungsgleich mit VON_RECHTS (${rtlQuelle.length} Sprachen).`);
}

console.log(`\n${geprueft} Einträge über ${sprachen.length} Sprachen geprüft.`);
console.log(abweichungen === 0
  ? 'download-i18n.ts ist deckungsgleich mit seinen Quellen.'
  : `${abweichungen} Abweichung(en) gefunden.`);
process.exit(abweichungen ? 1 : 0);
