#!/usr/bin/env node
/**
 * Statische Bauartprüfung: liest post-lernen.ts NIE aus eingehender Post.
 *
 * Herkunft: dieser Abschnitt stand bis eben als reiner Text-Grep im
 * Playwright-Lauf (scripts/e2e-postgedaechtnis.mjs, Abschnitt „Die Sperren
 * stehen im Quelltext, nicht nur im Ergebnis"). Er brauchte nie einen
 * Browser oder eine Datenbank — reine Quelltextanalyse — stand aber trotzdem
 * dort, weil die ganze Datei Playwright importiert. Deshalb lief er nur mit,
 * wenn `e2e-postgedaechtnis.mjs` von Hand gestartet wurde, und blieb aus dem
 * normalen Sweep der `*-pruefen.mjs`-Dateien außen vor. Genau das ließ ihn
 * veralten: `stapelMischen()` (Reihenfolge von Kandidaten und abgehakten
 * Zeilen) änderte die SELECT-Spaltenliste in `quellen()` (kam `ki_art`
 * hinzu), der alte Grep suchte aber nach der EXAKTEN alten Spaltenliste und
 * fand danach nichts mehr — 0 Treffer statt 2, obwohl die geprüfte
 * Eigenschaft die ganze Zeit unverändert galt.
 *
 * WARUM EINE EIGENSCHAFT UND KEINE ZÄHLUNG
 * Der alte Grep prüfte „es gibt genau zwei Abfragen mit exakt diesem
 * Spaltentext" — eine Zählung über eine wörtliche Kopie der Abfrage.
 * Jeder Umbau der Abfrage selbst (neue Spalte, andere Formatierung, ein
 * zusammengelegter Zweig statt zwei) bricht so einen Test, ohne dass sich an
 * der eigentlichen Zusage etwas geändert hätte — und die Reaktion darauf ist
 * fast immer, den Grep zu lockern, bis er wieder grün ist, nicht ihn wieder
 * scharf zu stellen. Dieser Lauf prüft stattdessen die EIGENSCHAFT selbst,
 * über den Syntaxbaum (das TypeScript-Compiler-API, wie schon in
 * message-send-clientid-verkabelung-pruefen.mjs):
 *
 *   1. JEDE `db.all(...)`/`db.get(...)`-Abfrage INNERHALB von `quellen()`,
 *      die `mail_nachrichten` erwähnt, trägt die Richtungssperre
 *      (`NUR_AUSGEHEND` bzw. wörtlich `richtung = 'aus'`) — unabhängig
 *      davon, welche Spalten sie sonst wählt oder wie sie formatiert ist.
 *   2. Keine dieser Abfragen erwähnt `richtung = 'ein'`.
 *   3. `NUR_AUSGEHEND` selbst ist unverändert `"richtung = 'aus'"`.
 *   4. Die einzige Stelle der ganzen Datei, die einen Kandidaten erzeugt
 *      (`kandidaten.push(`), liegt strukturell INNERHALB von `quellen()`.
 *      Das schließt den Kreis: `spiegeltEingang()` und
 *      `sicherstellenWasserstandsstart()` fragen `mail_nachrichten` zwar
 *      auch ab (die eine ABSICHTLICH mit `richtung = 'ein'`, um Fremdtext zu
 *      ERKENNEN und zu VERWERFEN, nicht um ihn zu lernen; die andere ganz
 *      ohne Richtung, weil sie nur den Wasserstand setzt) — aber keine der
 *      beiden kann je einen Kandidaten liefern, weil `kandidaten.push(`
 *      nirgendwo in ihnen vorkommt.
 *
 * Punkt 1 allein wäre eine Zusage über die Abfrage; Punkt 4 macht daraus eine
 * Zusage über die ganze Datei — dass es keinen zweiten Weg zu einem
 * Kandidaten gibt, der die Sperre umgeht.
 *
 * GEGENPROBE
 * Jede Zusage hier hat eine Mindestzahl an Fundstellen (`>= 1` bzw. `=== 1`)
 * statt einer reinen Boole'schen Prüfung — fällt die Fundstellenzahl auf 0,
 * hat sich entweder die Bauart geändert (umbenannt, verschoben) oder die
 * Suche ist blind geworden. Beides soll laut auffallen, nicht als „nichts
 * gefunden, also nichts falsch" durchgehen.
 *
 *   node scripts/post-lernen-quelle-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dateiPfad = path.join(wurzel, 'packages/server/src/services/post-lernen.ts');

let fehler = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ist=${JSON.stringify(ist)} soll=${JSON.stringify(soll)}`}`);
};

const quellText = fs.readFileSync(dateiPfad, 'utf8');
const quelle = ts.createSourceFile(dateiPfad, quellText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Findet die Top-Level-Funktion mit diesem Namen — egal ob `function x()`
 *  oder `export function x()` (der `export`-Modifikator hängt am selben
 *  Knoten, ändert also nichts an der Suche). */
function findeFunktion(name) {
  let treffer = null;
  for (const n of quelle.statements) {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) { treffer = n; break; }
  }
  return treffer;
}

/** Alle Aufrufe von `db.all(...)` / `db.get(...)` / `db.run(...)` unter `wurzelKnoten`,
 *  deren erstes Argument (das SQL-Template) `nadel` im Text trägt. */
function sammleDbAufrufe(wurzelKnoten, nadel) {
  const gefunden = [];
  const gehe = (n) => {
    if (
      ts.isCallExpression(n)
      && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression)
      && n.expression.expression.text === 'db'
      && ['all', 'get', 'run'].includes(n.expression.name.text)
    ) {
      const arg = n.arguments[0];
      const argText = arg ? arg.getText(quelle) : '';
      if (argText.includes(nadel)) {
        const zeile = quelle.getLineAndCharacterOfPosition(n.getStart(quelle)).line + 1;
        gefunden.push({ zeile, argText, methode: n.expression.name.text });
      }
    }
    ts.forEachChild(n, gehe);
  };
  gehe(wurzelKnoten);
  return gefunden;
}

/** Alle Aufrufe der Form `kandidaten.push(...)` unter `wurzelKnoten`. */
function sammleKandidatenPush(wurzelKnoten) {
  const gefunden = [];
  const gehe = (n) => {
    if (
      ts.isCallExpression(n)
      && ts.isPropertyAccessExpression(n.expression)
      && ts.isIdentifier(n.expression.expression)
      && n.expression.expression.text === 'kandidaten'
      && n.expression.name.text === 'push'
    ) {
      gefunden.push(n);
    }
    ts.forEachChild(n, gehe);
  };
  gehe(wurzelKnoten);
  return gefunden;
}

/* ── 1: die benannte Richtungssperre selbst ──────────────────────── */

console.log('\nDie Richtungssperre NUR_AUSGEHEND:');
let nurAusgehendText = null;
for (const n of quelle.statements) {
  if (!ts.isVariableStatement(n)) continue;
  for (const d of n.declarationList.declarations) {
    if (ts.isIdentifier(d.name) && d.name.text === 'NUR_AUSGEHEND' && d.initializer) {
      nurAusgehendText = d.initializer.getText(quelle);
    }
  }
}
pruef('const NUR_AUSGEHEND ist unverändert "richtung = \'aus\'"', nurAusgehendText, `"richtung = 'aus'"`);

/* ── 2: jede mail_nachrichten-Abfrage in quellen() trägt die Sperre ── */

console.log('\nquellen() -- die einzige Stelle, die Kandidaten erzeugen darf:');
const quellenFn = findeFunktion('quellen');
pruef('die Funktion quellen() wurde gefunden', Boolean(quellenFn), true);

if (quellenFn) {
  const abfragen = sammleDbAufrufe(quellenFn, 'mail_nachrichten');
  pruef('mindestens eine mail_nachrichten-Abfrage gefunden (Gegenprobe gegen eine blinde Suche)',
    abfragen.length >= 1, true);

  for (const a of abfragen) {
    const traegtSperre = a.argText.includes('NUR_AUSGEHEND') || a.argText.includes("richtung = 'aus'");
    pruef(`Zeile ${a.zeile}: db.${a.methode}(...) auf mail_nachrichten trägt NUR_AUSGEHEND`, traegtSperre, true);
    pruef(`Zeile ${a.zeile}: dieselbe Abfrage erwähnt nicht "richtung = 'ein'"`,
      a.argText.includes("richtung = 'ein'"), false);
  }

  /* ── 3: kandidaten.push(...) -- der einzige Weg zu einem Kandidaten -- liegt
     strukturell INNERHALB von quellen(). Das ist der Ring, der spiegeltEingang()
     und sicherstellenWasserstandsstart() ausschließt: beide fragen
     mail_nachrichten zwar auch ab, aber keine von beiden kann je einen
     Kandidaten liefern, wenn diese Prüfung grün ist. */
  const pushInQuellen = sammleKandidatenPush(quellenFn);
  pruef('genau ein kandidaten.push(...) innerhalb von quellen() (Gegenprobe gegen eine blinde Suche)',
    pushInQuellen.length, 1);

  const pushImGanzenFile = sammleKandidatenPush(quelle);
  pruef('kandidaten.push(...) kommt in der GANZEN Datei nur innerhalb von quellen() vor',
    pushImGanzenFile.length, pushInQuellen.length);
}

/* ── 4: post-wissen.ts und post-lernen.ts binden senden() nicht ein ─── */

console.log('\nKein Zugriff auf den Versand:');
for (const datei of ['post-wissen.ts', 'post-lernen.ts', 'post-wissen-ki.ts']) {
  const pfad = path.join(wurzel, 'packages/server/src/services', datei);
  const src = ts.createSourceFile(pfad, fs.readFileSync(pfad, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let bindetSendenEin = false;
  for (const n of src.statements) {
    if (!ts.isImportDeclaration(n)) continue;
    if (!ts.isStringLiteral(n.moduleSpecifier) || n.moduleSpecifier.text !== './post.js') continue;
    const bindungen = n.importClause?.namedBindings;
    if (bindungen && ts.isNamedImports(bindungen)) {
      if (bindungen.elements.some((el) => el.name.text === 'senden')) bindetSendenEin = true;
    }
  }
  pruef(`${datei} bindet senden() aus post.js nicht ein`, bindetSendenEin, false);
}

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mpost-lernen.ts liest ausschließlich ausgehende Post, und kandidaten.push(...) hat keinen zweiten Weg.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
