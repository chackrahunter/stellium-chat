#!/usr/bin/env node
/**
 * Erzeugt packages/server/src/services/push-i18n.ts — das kleine
 * Push-Wörterbuch für services/push.ts.
 *
 *   node scripts/push-woerterbuch-erzeugen.mjs
 *
 * WARUM ES DAS GEBEN MUSS
 * Web-Push-Titel entstehen serverseitig (services/push.ts), lange bevor
 * irgendein Browser-Tab offen ist — store.uiLanguageOf(userId) kennt die
 * Zielsprache zwar (ein einfacher, synchroner DB-Read), aber die 22
 * Wörterbücher mit dem eigentlichen Text liegen in
 * packages/desktop/src/i18n/ und damit in einem anderen npm-Workspace: sie
 * stecken zur Laufzeit im gehashten Bundle der Desktop-App, ~2.084
 * Einträge je Sprache, node:sqlite-Server und Vite-Bundle teilen sich keinen
 * Prozess und sollen es auch nicht — packages/server hat keine Abhängigkeit
 * auf packages/desktop und soll keine bekommen.
 *
 * Dieselbe Lage wie bei packages/desktop/electron/i18n.ts (siehe dessen
 * Dateikopf: eigener rootDir, ein Import aus src/i18n bricht dort mit
 * TS6059 ab) — hier ist die Mauer eine Workspace-Grenze statt eine
 * tsconfig-rootDir, aber der Befund ist derselbe: ein kleiner, eigener
 * Auszug ist nötig, nicht das ganze Wörterbuch.
 *
 * ANDERS ALS ELECTRON/I18N.TS: ERZEUGT, NICHT VON HAND GESCHRIEBEN
 * electron/i18n.ts wurde laut eigenem Dateikopf einmalig per
 * "scripts/inject" geschrieben und seither von Hand gepflegt — dagegen
 * steht scripts/hauptprozess-woerterbuch-pruefen.mjs als nachträglicher
 * Wächter. Diese Datei hier dreht die Reihenfolge um: die 22 Wörterbücher
 * bleiben die einzige Quelle der Wahrheit, push-i18n.ts ist ihr Ergebnis,
 * nicht ihre Kopie. Nach jeder Änderung an einem der Schlüssel unten (in
 * einem der 22 Wörterbücher) diesen Lauf erneut anstoßen; würde jemand
 * push-i18n.ts stattdessen von Hand nachziehen und dabei etwas vergessen,
 * findet scripts/push-woerterbuch-pruefen.mjs das zuverlässig — aber ein
 * Lauf, der die Datei gleich neu schreibt, lässt diese Möglichkeit gar
 * nicht erst entstehen.
 *
 * NUR DREIZEHN SCHLÜSSEL, UND WARUM GENAU DIESE
 * Nicht neu formuliert, sondern wiederverwendet: jeder der dreizehn
 * Schlüssel unten steht schon in den 22 Wörterbüchern UND wird im Frontend an
 * derselben Stelle für dasselbe Ereignis gezeigt (Fundstelle in der
 * Begründung je Schlüssel). Eine zweite, eigene Formulierung für denselben
 * Sachverhalt wäre genau die zweite Übersetzungsanlage, vor der
 * postMeldungPushMelden() in ws/gateway.ts warnt — diese Datei hier
 * entsteht als AUSZUG, nicht als Ergänzung.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = path.join(wurzel, 'packages/desktop/src/i18n');
const ZIEL = path.join(wurzel, 'packages/server/src/services/push-i18n.ts');

/* Reihenfolge der Sprachblöcke — dieselbe wie in
   packages/desktop/src/i18n/kern.ts (WOERTERBUECHER dort), damit beide
   Dateien nebeneinander lesbar bleiben. */
const SPRACHEN = ['de', 'en', 'ar', 'cs', 'da', 'es', 'fi', 'fr', 'hi', 'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk', 'zh'];

/**
 * Die Schlüssel, die services/push.ts für Push-Titel/-Texte braucht — jeder
 * schon vorhanden UND im Frontend an derselben Stelle für dasselbe Ereignis
 * im Einsatz:
 *
 *   toast.newMessage                  DM-Titel ohne bekannten Namen
 *                                      (state/store.ts, notifyIfNeeded():
 *                                      genau derselbe Rückfall)
 *   vertraulich.titel                  Text für eine Ende-zu-Ende-verschlüsselte
 *                                      Nachricht (state/store.ts,
 *                                      notifyIfNeeded(): derselbe Schlüssel
 *                                      steht dort schon als Textkörper,
 *                                      wenn istE2EChiffrat() zutrifft)
 *   toast.vorschlagNeuAufgabe          KI-Vorschlag „Aufgabe"
 *   toast.vorschlagNeuIdee             KI-Vorschlag „Idee"
 *   toast.vorschlagNeuTermin           KI-Vorschlag „Termin"
 *                                      (state/vorschlaege.ts: derselbe
 *                                      Rundruf, dieselben drei Titel)
 *   postSichtung.grund.entwurfWartet   Mail-Sichtung: Entwurf wartet auf
 *                                      Freigabe (components/PostMeldungen.tsx
 *                                      zeigt denselben Satz als
 *                                      Begründungszeile für dieselbe Zeile)
 *   toast.taskAssigned                 Aufgabe zugeteilt (der Text steht
 *                                      schon in allen 22 Wörterbüchern,
 *                                      auch ohne eigenen Frontend-Toast dafür)
 *   toast.reminderTitle                Erinnerungs-Titel ohne eigenen Text
 *   toast.reminderLook                 Erinnerungs-Text ohne Vorschau
 *                                      (state/store.ts, reminder:fire:
 *                                      derselbe zeigen()-Aufruf, dieselben
 *                                      zwei Rückfälle)
 *
 *   push.neuePostImFach                Neue Post in einem bestimmten Fach
 *                                      (gateway.ts, postMeldungPushMelden(),
 *                                      der Zweig ungleich 'entwurf'). Bewusst
 *                                      ein eigener Schlüssel und NICHT
 *                                      'post.neueNachricht': das ist der Titel
 *                                      des Schreiben-Knopfs (PostSchreiben.tsx),
 *                                      nicht einer Eingangs-Meldung, und trägt
 *                                      in mindestens einer Sprache (Japanisch:
 *                                      „新規メール", wörtlich „neue/zu
 *                                      erstellende Mail") ausdrücklich die
 *                                      Compose-Bedeutung. Einziger Schlüssel
 *                                      hier mit Platzhalter ({fach});
 *                                      textAufloesen() in services/push.ts
 *                                      setzt ihn aus `werte` ein.
 *
 *   verkaufMeldung.toastTitelEinzeln   "Ein Kauf ist passiert" — Push-Titel
 *                                      für genau eine neu erkannte Meldung
 *                                      (gateway.ts, verkaufPushMelden()).
 *                                      Derselbe Schlüssel, mit dem
 *                                      state/verkaufMeldungen.ts im Frontend
 *                                      denselben Fall schon als In-App-Toast
 *                                      zeigt — kein zweiter, eigens
 *                                      formulierter Text für dasselbe
 *                                      Ereignis.
 *   verkaufMeldung.toastTitelSammel    Dieselbe Meldung, aber für mehrere auf
 *                                      einmal erkannte Verkäufe (derselbe
 *                                      Sammel-Zweig in
 *                                      state/verkaufMeldungen.ts).
 *   verkaufMeldung.toastKoerperSammel  Der Text-Körper dazu, wenn alle
 *                                      gebündelten Verkäufe dieselbe Währung
 *                                      tragen (state/verkaufMeldungen.ts,
 *                                      derselbe `waehrung`-Zweig).
 *
 *   notzugang.pushTitel                „Notzugang eingelöst" — Titel der
 *                                      Meldung, die beim Einlösen an die
 *                                      besitzende Person UND an jede
 *                                      beitragende Person geht (routes.ts,
 *                                      /api/konto/notzugang/einloesen).
 *   notzugang.pushEingeloest           Der Text dazu, mit {name} und {n}.
 *                                      Beide Schlüssel stehen schon in allen
 *                                      22 Wörterbüchern; die Tafel selbst
 *                                      (NotzugangPanel.tsx) zeigt denselben
 *                                      Vorgang in ihrer Spur. Ein Vorgang,
 *                                      bei dem jemand für einen Augenblick
 *                                      einen fremden Kontoschlüssel in der
 *                                      Hand hält, darf nicht lautlos sein —
 *                                      und „nicht lautlos" heißt: auch dann,
 *                                      wenn gerade kein Fenster offen ist.
 *
 *   notzugang.pushHerausgegebenTitel   Dieselbe Meldung, einen Schritt
 *   notzugang.pushHerausgegeben        früher: sobald der Server die Anteile
 *                                      HERAUSGIBT (routes.ts,
 *                                      /api/konto/notzugang/beitraege/:id).
 *                                      Die beiden darüber hängen an einem
 *                                      Aufruf, den der Client auch weglassen
 *                                      könnte — er hat den Kontoschlüssel zu
 *                                      dem Zeitpunkt längst. Diese beiden
 *                                      hängen an dem Augenblick, in dem die
 *                                      Anteile wirklich über die Leitung
 *                                      gehen, und den kann niemand
 *                                      überspringen, der sie haben will.
 *
 *   notzugang.pushAufgehobenTitel      Und die dritte Meldung dieser Familie:
 *   notzugang.pushAufgehoben           die Verwaltung hat einen FREMDEN
 *   notzugang.pushAufgehobenVerbrannt  Notzugang aufgehoben (routes.ts,
 *                                      DELETE /api/admin/notzugang/:id). Das
 *                                      stand bisher nur in der eigenen Tafel
 *                                      der betroffenen Person — sichtbar für
 *                                      den, der sie aufschlägt, also
 *                                      frühestens an dem Tag, an dem er die
 *                                      Rettungsleine braucht und sie nicht
 *                                      mehr findet. Zwei Texte, weil es zwei
 *                                      verschiedene Nachrichten sind: die
 *                                      Leine ist weg, oder Notizen und Tresor
 *                                      sind es auch (aufheben() brennt nieder,
 *                                      wenn keine Passworthülle mehr dasteht).
 *                                      Alle drei stehen schon in allen 22
 *                                      Wörterbüchern; den Vorgang selbst zeigt
 *                                      NotzugangPanel.tsx in seiner Spur.
 */
const SCHLUESSEL = [
  'notzugang.pushAufgehoben',
  'notzugang.pushAufgehobenTitel',
  'notzugang.pushAufgehobenVerbrannt',
  'notzugang.pushEingeloest',
  'notzugang.pushHerausgegeben',
  'notzugang.pushHerausgegebenTitel',
  'notzugang.pushTitel',
  'postSichtung.grund.entwurfWartet',
  'push.neuePostImFach',
  'toast.newMessage',
  'toast.reminderLook',
  'toast.reminderTitle',
  'toast.taskAssigned',
  'toast.vorschlagNeuAufgabe',
  'toast.vorschlagNeuIdee',
  'toast.vorschlagNeuTermin',
  'verkaufMeldung.toastKoerperSammel',
  'verkaufMeldung.toastTitelEinzeln',
  'verkaufMeldung.toastTitelSammel',
  'vertraulich.titel',
].sort();

/* Robuste Lesart wie scripts/woerterbuecher-erzeugen.mjs: Werte stehen meist
   einfach gequotet, Sprachen mit Apostroph im Text (frz. "l'équipe")
   zwangsläufig doppelt — wer nur einfache liest, hält sie für nicht
   vorhanden. */
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
if (fehlerAufgetreten) {
  console.error('\nAbgebrochen — nichts geschrieben.');
  process.exit(1);
}

/* Ausgabe immer einfach gequotet, mit denselben drei Escapes wie in den 22
   Wörterbüchern (\\, ', \n) — unabhängig davon, wie der Quellwert oben
   gequotet war. Alle dreizehn Schlüssel sind heute einzeilig und ohne
   Apostroph in allen 22 Sprachen (geprüft beim Schreiben dieser Datei);
   \n bleibt trotzdem behandelt, falls ein künftiger Schlüssel mehrzeilig ist. */
function alsTsWert(text) {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

const zeilen = [];
zeilen.push('/**');
zeilen.push(' * Push-Wörterbuch für services/push.ts — bewusst getrennt von den 22');
zeilen.push(' * Wörterbüchern in packages/desktop/src/i18n/.');
zeilen.push(' *');
zeilen.push(' * ERZEUGT — nicht von Hand ändern. Quelle ist scripts/push-woerterbuch-erzeugen.mjs,');
zeilen.push(' * das genau diese Datei aus den 22 Wörterbüchern dort herausschneidet. Nach');
zeilen.push(' * jeder Änderung an einem der Schlüssel unten (in einem der 22 Wörterbücher)');
zeilen.push(' * erneut laufen lassen:');
zeilen.push(' *');
zeilen.push(' *   node scripts/push-woerterbuch-erzeugen.mjs');
zeilen.push(' *');
zeilen.push(' * scripts/push-woerterbuch-pruefen.mjs vergleicht diese Datei Zeichen für');
zeilen.push(' * Zeichen gegen die 22 Wörterbücher und schlägt an, falls das vergessen wird.');
zeilen.push(' *');
zeilen.push(' * Ausführliche Begründung — warum es diese Datei überhaupt braucht, warum nur');
zeilen.push(' * diese dreizehn Schlüssel — im Kopf von');
zeilen.push(' * scripts/push-woerterbuch-erzeugen.mjs.');
zeilen.push(' */');
zeilen.push('');
zeilen.push('export type PushKey =');
for (const schluessel of SCHLUESSEL) zeilen.push(`  | '${schluessel}'`);
zeilen.push('  ;');
zeilen.push('');
zeilen.push('type Woerterbuch = Record<PushKey, string>;');
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

fs.writeFileSync(ZIEL, zeilen.join('\n'));
console.log(`✓ ${path.relative(wurzel, ZIEL)} geschrieben — ${SCHLUESSEL.length} Schlüssel × ${SPRACHEN.length} Sprachen.`);
