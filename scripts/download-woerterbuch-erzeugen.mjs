#!/usr/bin/env node
/**
 * Erzeugt packages/server/src/http/download/download-i18n.ts — das kleine
 * Wörterbuch für die serverseitige Seite `/download` (http/download/seite.ts).
 *
 *   node scripts/download-woerterbuch-erzeugen.mjs
 *
 * WARUM ES DAS GEBEN MUSS
 * Dieselbe Mauer wie bei packages/server/src/services/push-i18n.ts (siehe
 * dessen Dateikopf für die ausführliche Begründung): packages/server hat
 * keine Abhängigkeit auf packages/desktop und soll keine bekommen, die 22
 * Wörterbücher mit dem eigentlichen Text liegen aber in
 * packages/desktop/src/i18n/. `/download` rendert serverseitig, bevor
 * irgendein Browser-Tab offen ist — ein eigener, kleiner Auszug ist nötig,
 * nicht das ganze Wörterbuch.
 *
 * ANDERS ALS PUSH-I18N.TS: AUCH DIE LESERICHTUNG
 * `/download` setzt `dir="rtl"` für die Sprachen, die von rechts nach links
 * gelesen werden — ohne diese Angabe stünde arabischer Text (und jede
 * andere RTL-Sprache, käme sie zu den 22 dazu) in einem Layout, das für die
 * andere Richtung gebaut ist. Diese Liste gibt es schon, in
 * packages/desktop/src/i18n/kern.ts (VON_RECHTS) — dieses Skript liest sie
 * von dort ab, genau wie die Textschlüssel, statt eine zweite, eigene Liste
 * anzulegen, die mit der Zeit von der ersten abweicht.
 *
 * scripts/download-woerterbuch-pruefen.mjs vergleicht diese Datei Zeichen
 * für Zeichen (und die RTL-Liste Eintrag für Eintrag) gegen ihre Quellen und
 * schlägt an, falls das Nachziehen hier vergessen wird.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = path.join(wurzel, 'packages/desktop/src/i18n');
const KERN_DATEI = path.join(I18N_DIR, 'kern.ts');
const ZIEL = path.join(wurzel, 'packages/server/src/http/download/download-i18n.ts');

/* Reihenfolge der Sprachblöcke — dieselbe wie in
   packages/desktop/src/i18n/kern.ts (WOERTERBUECHER dort) und in
   push-i18n.ts, damit alle drei Dateien nebeneinander lesbar bleiben. */
const SPRACHEN = ['de', 'en', 'ar', 'cs', 'da', 'es', 'fi', 'fr', 'hi', 'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk', 'zh'];

/**
 * Die Schlüssel, die http/download/seite.ts braucht — jeder schon vorhanden
 * UND an anderer Stelle im Frontend für dasselbe Ereignis im Einsatz (siehe
 * DownloadPanel.tsx bzw. Login.tsx für den jeweiligen Ursprung), bis auf die
 * sechs, die eigens für diese Seite entstanden sind (Kennzeichnung unten).
 */
const SCHLUESSEL = [
  'auth.noAccount',            // Login.tsx — dieselbe Auskunft für dieselbe Frage
  'auth.tagline',               // Login.tsx — Unterzeile unter der Marke
  'download.empty',             // DownloadPanel.tsx — keine Fassung hinterlegt
  'download.hintDarwin',        // NEU für diese Seite — Architekturhinweis macOS-Karte
  'download.hintLinux',         // NEU für diese Seite — Formathinweis Linux-Karte
  'download.hintWin32',         // NEU für diese Seite — Formathinweis Windows-Karte
  'download.otherSystems',      // DownloadPanel.tsx — Abschnitt "Andere Systeme"
  'download.pageTitle',         // NEU für diese Seite — <title>, {arbeitsbereich} herunterladen
  'download.published',         // DownloadPanel.tsx — "vom {datum}"
  'download.recommended',       // DownloadPanel.tsx — Abschnitt "Für dein System"
  'download.title',             // DownloadPanel.tsx — Überschrift, auch als Rückfall für "Andere Systeme" ohne Treffer
  'download.version',           // DownloadPanel.tsx — "Version {version}"
  'download.viaBrowser',        // NEU für diese Seite — Fußzeile, Einleitung zum Browser-Link
  'download.viaBrowserLink',    // NEU für diese Seite — Fußzeile, Linktext
  'download.whatsNew',          // DownloadPanel.tsx — Überschrift der Änderungsliste
  'update.autoHint',            // Settings.tsx — dieselbe Auskunft zur Selbstaktualisierung
].sort();

/* Dieselbe robuste Lesart wie in push-woerterbuch-erzeugen.mjs: Werte stehen
   meist einfach gequotet, Sprachen mit Apostroph im Text (frz. "l'équipe")
   zwangsläufig doppelt. */
function woerterbuchLesen(datei) {
  const text = fs.readFileSync(datei, 'utf8');
  const eintraege = {};
  const muster = /^\s{2}'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*$/gm;
  let treffer;
  while ((treffer = muster.exec(text))) {
    const roh = treffer[2] ?? treffer[3] ?? '';
    eintraege[treffer[1]] = roh
      .replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return eintraege;
}

/** Die RTL-Sprachen aus kern.ts abschöpfen, statt sie hier neu zu benennen. */
function rtlSprachenLesen(datei) {
  const text = fs.readFileSync(datei, 'utf8');
  const treffer = /const VON_RECHTS = new Set\(\[([^\]]*)\]\)/.exec(text);
  if (!treffer) {
    console.error(`✗ VON_RECHTS in ${datei} nicht gefunden — Muster geändert?`);
    process.exit(1);
  }
  return [...treffer[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
}

let fehlerAufgetreten = false;
const woerterbuecher = {};
for (const sprache of SPRACHEN) {
  const datei = path.join(I18N_DIR, `${sprache}.ts`);
  if (!fs.existsSync(datei)) {
    console.error(`✗ ${datei} fehlt.`);
    fehlerAufgetreten = true;
    continue;
  }
  const alle = woerterbuchLesen(datei);
  const teil = {};
  const fehlend = [];
  for (const schluessel of SCHLUESSEL) {
    if (alle[schluessel] === undefined) { fehlend.push(schluessel); continue; }
    teil[schluessel] = alle[schluessel];
  }
  if (fehlend.length) {
    console.error(`✗ ${sprache}.ts: ${fehlend.length} Schlüssel fehlen: ${fehlend.join(', ')}`);
    fehlerAufgetreten = true;
    continue;
  }
  woerterbuecher[sprache] = teil;
}
const rtlSprachen = rtlSprachenLesen(KERN_DATEI);
if (fehlerAufgetreten) {
  console.error('\nAbgebrochen — nichts geschrieben.');
  process.exit(1);
}

/* Ausgabe immer einfach gequotet, mit denselben drei Escapes wie in den 22
   Wörterbüchern — unabhängig davon, wie der Quellwert oben gequotet war. */
function alsTsWert(text) {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

const zeilen = [];
zeilen.push('/**');
zeilen.push(' * Wörterbuch für die serverseitige Seite /download (http/download/seite.ts)');
zeilen.push(' * — bewusst getrennt von den 22 Wörterbüchern in packages/desktop/src/i18n/.');
zeilen.push(' *');
zeilen.push(' * ERZEUGT — nicht von Hand ändern. Quelle ist scripts/download-woerterbuch-erzeugen.mjs,');
zeilen.push(' * das genau diese Datei aus den 22 Wörterbüchern und aus VON_RECHTS in');
zeilen.push(' * packages/desktop/src/i18n/kern.ts herausschneidet. Nach jeder Änderung an');
zeilen.push(' * einem der Schlüssel unten (in einem der 22 Wörterbücher) oder an VON_RECHTS');
zeilen.push(' * erneut laufen lassen:');
zeilen.push(' *');
zeilen.push(' *   node scripts/download-woerterbuch-erzeugen.mjs');
zeilen.push(' *');
zeilen.push(' * scripts/download-woerterbuch-pruefen.mjs vergleicht diese Datei Zeichen für');
zeilen.push(' * Zeichen (und RTL_SPRACHEN Eintrag für Eintrag) gegen ihre Quellen und schlägt');
zeilen.push(' * an, falls das vergessen wird.');
zeilen.push(' *');
zeilen.push(' * Ausführliche Begründung — warum es diese Datei überhaupt braucht, warum');
zeilen.push(' * genau diese Schlüssel — im Kopf von scripts/download-woerterbuch-erzeugen.mjs.');
zeilen.push(' */');
zeilen.push('');
zeilen.push('export type DownloadKey =');
for (const schluessel of SCHLUESSEL) zeilen.push(`  | '${schluessel}'`);
zeilen.push('  ;');
zeilen.push('');
zeilen.push('type Woerterbuch = Record<DownloadKey, string>;');
zeilen.push('');
zeilen.push('export const WOERTERBUECHER: Record<string, Woerterbuch> = {');
for (const sprache of SPRACHEN) {
  zeilen.push(`  ${sprache}: {`);
  for (const schluessel of SCHLUESSEL) {
    zeilen.push(`    '${schluessel}': '${alsTsWert(woerterbuecher[sprache][schluessel])}',`);
  }
  zeilen.push('  },');
}
zeilen.push('};');
zeilen.push('');
zeilen.push('/** Sprachen, die von rechts nach links gelesen werden — siehe VON_RECHTS in');
zeilen.push(' *  packages/desktop/src/i18n/kern.ts, hier nur gespiegelt. */');
zeilen.push(`export const RTL_SPRACHEN: readonly string[] = [${rtlSprachen.map((s) => `'${s}'`).join(', ')}];`);
zeilen.push('');

fs.writeFileSync(ZIEL, zeilen.join('\n'));
console.log(`✓ ${path.relative(wurzel, ZIEL)} geschrieben — ${SCHLUESSEL.length} Schlüssel × ${SPRACHEN.length} Sprachen, ${rtlSprachen.length} RTL-Sprachen.`);
