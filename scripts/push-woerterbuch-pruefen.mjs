#!/usr/bin/env node
/**
 * Ist packages/server/src/services/push-i18n.ts noch deckungsgleich mit den
 * 22 Wörterbüchern in packages/desktop/src/i18n/?
 *
 * WARUM DAS EIN EIGENER LAUF IST
 * push-i18n.ts entsteht aus scripts/push-woerterbuch-erzeugen.mjs — ein
 * erneuter Lauf davon hält die Datei von selbst deckungsgleich. Diese Prüfung
 * fängt trotzdem zwei Fälle ab, die ein Generator-Lauf allein nicht verhindert:
 * jemand ändert push-i18n.ts von Hand (der Dateikopf dort verbietet es, das
 * hält niemanden zuverlässig ab), oder einer der 22 Wörterbücher ändert sich
 * und niemand erinnert sich, den Generator danach erneut laufen zu lassen —
 * genau der Fehler, den scripts/hauptprozess-woerterbuch-pruefen.mjs für die
 * gleichnamige Lage bei packages/desktop/electron/i18n.ts schon bewacht.
 *
 * Nach jeder Änderung an einem der neun Schlüssel unten (in push-i18n.ts ODER
 * in einem der 22 Wörterbücher) laufen lassen — am einfachsten, indem man
 * erst den Generator und dann diese Prüfung aufruft:
 *
 *   node scripts/push-woerterbuch-erzeugen.mjs && node scripts/push-woerterbuch-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = path.join(REPO, 'packages/desktop/src/i18n');
const PUSH_I18N = path.join(REPO, 'packages/server/src/services/push-i18n.ts');

/** Zeilen der Form   'schlüssel': 'wert',   ODER  'schlüssel': "wert",  —
 *  mit beliebiger fester Einrückung (2 Leerzeichen in den 22 Wörterbüchern,
 *  4 in push-i18n.ts, weil dort eine Ebene tiefer verschachtelt). Die
 *  22 Wörterbücher quoten meist einfach, Werte mit Apostroph (z. B.
 *  Französisch) zwangsläufig doppelt — push-i18n.ts selbst quotet immer
 *  einfach (siehe alsTsWert() im Generator), aber derselbe Leser liest
 *  beide Seiten, darum bleibt auch die doppelte Form erlaubt. */
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

/** push-i18n.ts in seine Sprachblöcke zerlegen: "  de: {" … "  },". */
function pushWoerterbuecher(text) {
  const bloecke = {};
  const musterBlock = /^ {2}([a-z]{2}): \{\n([\s\S]*?)\n {2}\},$/gm;
  let treffer;
  while ((treffer = musterBlock.exec(text))) {
    bloecke[treffer[1]] = woerterbuchLesen(treffer[2]);
  }
  return bloecke;
}

if (!fs.existsSync(PUSH_I18N)) {
  console.log(`✗ ${path.relative(REPO, PUSH_I18N)} gibt es nicht — node scripts/push-woerterbuch-erzeugen.mjs laufen lassen.`);
  process.exit(1);
}

const pushText = fs.readFileSync(PUSH_I18N, 'utf8');
const pushWb = pushWoerterbuecher(pushText);
const sprachen = Object.keys(pushWb).sort();

if (sprachen.length < 22) {
  console.log(`✗ Nur ${sprachen.length} Sprachblöcke in push-i18n.ts erkannt — Parser oder Datei prüfen.`);
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
  const zielSchluessel = Object.keys(pushWb[sprache]).sort();

  for (const schluessel of zielSchluessel) {
    geprueft += 1;
    const pushWert = pushWb[sprache][schluessel];
    const quellWert = quelle[schluessel];
    if (quellWert === undefined) {
      console.log(`✗ ${sprache}.${schluessel}: in push-i18n.ts, aber kein solcher Schlüssel in src/i18n/${sprache}.ts`);
      abweichungen += 1;
    } else if (quellWert !== pushWert) {
      console.log(`✗ ${sprache}.${schluessel}: weicht ab`);
      console.log(`    push-i18n.ts:           ${pushWert}`);
      console.log(`    src/i18n/${sprache}.ts: ${quellWert}`);
      abweichungen += 1;
    }
  }
}

console.log(`\n${geprueft} Einträge über ${sprachen.length} Sprachen geprüft.`);
console.log(abweichungen === 0
  ? 'push-i18n.ts ist deckungsgleich mit den Wörterbüchern in src/i18n.'
  : `${abweichungen} Abweichung(en) gefunden.`);
process.exit(abweichungen ? 1 : 0);
