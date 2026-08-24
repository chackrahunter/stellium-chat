#!/usr/bin/env node
/**
 * Ist packages/desktop/electron/i18n.ts noch deckungsgleich mit den 22
 * Wörterbüchern in packages/desktop/src/i18n/?
 *
 * WARUM DAS EIN EIGENER LAUF IST
 * electron/i18n.ts kann die Wörterbücher in src/i18n nicht importieren —
 * tsconfig.electron.json setzt rootDir: "electron", ein Import aus src/
 * läge außerhalb davon (siehe der lange Kommentar am Kopf von
 * electron/i18n.ts). Die rund 50 Schlüssel, die der Hauptprozess braucht
 * (Menü, Tray, Bestätigungsdialoge, Update-Gründe), stehen darum an ZWEI
 * Stellen: als Quelle in den 22 Wörterbüchern, als schmale Kopie in
 * electron/i18n.ts. Zwei Stellen für denselben Text laufen ohne Kontrolle
 * irgendwann auseinander — genau die Art Fehler, die diese ganze Änderung
 * ausgelöst hat (ein hartkodierter Text, den niemand mehr mit der
 * eigentlichen Übersetzung abglich). Dieser Lauf ist die Kontrolle: er
 * vergleicht beide Seiten Zeichen für Zeichen.
 *
 * Nach jeder Änderung an einem der Schlüssel unten (in electron/i18n.ts
 * ODER in einem der 22 Wörterbücher) laufen lassen:
 *   node scripts/hauptprozess-woerterbuch-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = path.join(REPO, 'packages/desktop/src/i18n');
const ELECTRON_I18N = path.join(REPO, 'packages/desktop/electron/i18n.ts');

/** Zeilen der Form   'schlüssel': 'wert',   — mit beliebiger fester
 *  Einrückung (2 Leerzeichen in den 22 Wörterbüchern, 4 in electron/i18n.ts,
 *  weil dort eine Ebene tiefer verschachtelt). Erkennt nur eigene, einfach
 *  gequotete Werte — dieselbe Bauform, die scripts/inject beim Schreiben
 *  beider Seiten verwendet hat. */
function woerterbuchLesen(text) {
  const eintraege = {};
  const muster = /^\s+'([^']+)':\s*'((?:[^'\\]|\\.)*)'\s*,\s*$/gm;
  let treffer;
  while ((treffer = muster.exec(text))) {
    eintraege[treffer[1]] = treffer[2]
      .replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  return eintraege;
}

/** electron/i18n.ts in seine Sprachblöcke zerlegen: "  de: {" … "  },". */
function hauptprozessWoerterbuecher(text) {
  const bloecke = {};
  const musterBlock = /^ {2}([a-z]{2}): \{\n([\s\S]*?)\n {2}\},$/gm;
  let treffer;
  while ((treffer = musterBlock.exec(text))) {
    bloecke[treffer[1]] = woerterbuchLesen(treffer[2]);
  }
  return bloecke;
}

const electronText = fs.readFileSync(ELECTRON_I18N, 'utf8');
const hauptprozess = hauptprozessWoerterbuecher(electronText);
const sprachen = Object.keys(hauptprozess).sort();

if (sprachen.length < 22) {
  console.log(`✗ Nur ${sprachen.length} Sprachblöcke in electron/i18n.ts erkannt — Parser oder Datei prüfen.`);
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
  const zielSchluessel = Object.keys(hauptprozess[sprache]).sort();

  for (const schluessel of zielSchluessel) {
    geprueft += 1;
    const hauptWert = hauptprozess[sprache][schluessel];
    const quellWert = quelle[schluessel];
    if (quellWert === undefined) {
      console.log(`✗ ${sprache}.${schluessel}: in electron/i18n.ts, aber kein solcher Schlüssel in src/i18n/${sprache}.ts`);
      abweichungen += 1;
    } else if (quellWert !== hauptWert) {
      console.log(`✗ ${sprache}.${schluessel}: weicht ab`);
      console.log(`    electron/i18n.ts:  ${hauptWert}`);
      console.log(`    src/i18n/${sprache}.ts: ${quellWert}`);
      abweichungen += 1;
    }
  }
}

console.log(`\n${geprueft} Einträge über ${sprachen.length} Sprachen geprüft.`);
console.log(abweichungen === 0
  ? 'electron/i18n.ts ist deckungsgleich mit den Wörterbüchern in src/i18n.'
  : `${abweichungen} Abweichung(en) gefunden.`);
process.exit(abweichungen ? 1 : 0);
