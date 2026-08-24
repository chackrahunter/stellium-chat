/**
 * Prüft gegen eine frische Datenbank: bekommt ein Kanalthema/eine
 * Änderungsliste ohne verlässliche Spracherkennung die Sprache der Person,
 * die es geschrieben hat — statt eines ungeprüften "englisch" mit 0,15
 * Zuversicht (languages.ts, detectLanguage())?
 *
 * DER BEFUND
 *
 * translateChannel() und translateReleaseNotes() reichten `sourceLang: null`
 * an translate() durch. Dessen interne Erkennung prüft ihre eigene
 * Zuversicht nicht — kurzer, hinweisfreier ASCII-Text (kein Stoppwort, kein
 * Umlaut, keine deutschen Substantiv-Großschreibungen) landet dort IMMER als
 * "englisch", egal wie unsicher. Zwei Auswirkungen, beide über diesen Lauf
 * geprüft:
 *
 *   1. Ist die Zielsprache zufällig Englisch, gilt die (falsche) Erkennung
 *      als "schon Zielsprache" — NOOP. Der Text bleibt stehen, wie er ist.
 *      Für "Update verfuegbar" (echtes Deutsch ohne Umlaut-Taste oder mit
 *      absichtlich weggelassenem ü) heißt das: die deutsche Änderungsliste
 *      bleibt für ein englischsprachiges Kolleg*innen-Konto stehen — GENAU
 *      der Fall, für den translateReleaseNotes() heute (22.08.2026) gebaut
 *      wurde (siehe Auftrag).
 *   2. translateChannel()/translateReleaseNotes() geben bei NOOP `null`
 *      zurück statt eines Texts — messbar ohne jede Prompt-Introspektion.
 *
 * Aufruf:  node scripts/sprach-schwelle-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import { translateChannel, translateReleaseNotes } from '../translation/index.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};
const pruefWahr = (name: string, bedingung: boolean, hinweis = '') => {
  if (bedingung) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); return; }
  fehler++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${hinweis ? `  — ${hinweis}` : ''}`);
};

// Deutschsprachige Autorin ohne Sonderzeichen in ihrem Text — genau der
// Fall, den detectLanguage() nicht von Englisch unterscheiden kann.
db.run(`INSERT INTO users (id, handle, display_name, password_hash, language, created_at)
        VALUES ('autor-de', 'autor-de', 'Autorin', 'x', 'de', 0)`);

/* ── translateChannel() ──────────────────────────────────────────
   Thema "Deploy Prozess" — Deutsch, aber ohne Stoppwort/Umlaut/Diakritikum
   verlässlich nur mit 0,15 Zuversicht als "englisch" geraten (siehe
   scripts/sprach-schwelle-pruefen.mjs / manuell mit detectLanguage geprüft).
   primary_language bewusst NICHT gesetzt: das ist der Fall, in dem NUR die
   Autorensprache noch retten kann. */
db.run(`INSERT INTO channels (id, kind, name, topic, created_by, created_at)
        VALUES ('probe-kanal', 'public', 'probe', 'Deploy Prozess', 'autor-de', 0)`);

console.log('translateChannel(): Thema "Deploy Prozess" nach Englisch');
const kanalErgebnis = await translateChannel('probe-kanal', 'en');
pruefWahr(
  'wird übersetzt statt an der falschen Erkennung als NOOP zu scheitern',
  kanalErgebnis !== null && kanalErgebnis.topic !== null && kanalErgebnis.topic !== 'Deploy Prozess',
  `Ergebnis: ${JSON.stringify(kanalErgebnis)}`,
);

/* ── translateReleaseNotes() ─────────────────────────────────────
   Dieselbe Falle, dasselbe Werkzeug (erkennungOderAutorensprache) — hier mit
   dem Text, der genau den im Auftrag beschriebenen Schaden zeigt: eine
   deutsche Änderungsliste, die für ein "en"-Konto fälschlich unübersetzt
   bliebe. */
db.run(`INSERT INTO releases (platform, version, notes, file_name, path, size, sha256, published_by, published_at)
        VALUES ('darwin', '1.0.0', 'Update verfuegbar', 'x.dmg', '/x', 1, 'x', 'autor-de', 0)`);

console.log('\ntranslateReleaseNotes(): "Update verfuegbar" nach Englisch');
const notesErgebnis = await translateReleaseNotes('darwin', 'en');
pruefWahr(
  'wird übersetzt statt still als "schon Zielsprache" zu gelten (gäbe null zurück)',
  notesErgebnis !== null && notesErgebnis !== 'Update verfuegbar',
  `Ergebnis: ${JSON.stringify(notesErgebnis)}`,
);

/* ── Gegenprobe: primary_language schlägt jede Erkennung ──────────
   Ein Kanal mit ausdrücklich eingetragener Sprache darf sich davon nicht
   durch eine (hier absichtlich in die Irre führende) Text-Erkennung
   abbringen lassen — primary_language ist eine bewusste Angabe, keine
   Vermutung.

   Die alte Fassung dieser Prüfung konnte den Fall nicht von seinem eigenen
   Rückfall unterscheiden: ihr Kanal gehörte 'autor-de' (Sprache 'de'),
   genau wie primary_language — würde translateChannel() primary_language
   komplett ignorieren und auf erkennungOderAutorensprache() zurückfallen,
   käme wegen derselben Autorensprache trotzdem 'de' heraus, und die
   Prüfung (nur "irgendein Ergebnis kam zurück") wäre grün geblieben, obwohl
   genau die geprüfte Zeile fehlte. Deshalb jetzt: eine Autorin mit einer
   ANDEREN Sprache als primary_language — und eine Prüfung, die nicht nur
   "kam etwas zurück", sondern "kam das mit 'de' als Ausgangssprache
   übersetzte Ergebnis zurück" verlangt.

   'autor-en' schreibt sonst Englisch. Bricht primary_language weg, fällt
   erkennungOderAutorensprache() auf ihre Sprache zurück — 'en', identisch
   zur Zielsprache 'en' — und translate() gibt dann NOOP zurück (source ===
   target), also topic === null und translateChannel() insgesamt null
   (siehe dort, `!name && !topic && !purpose`). Bleibt primary_language
   dagegen wie vorgesehen maßgeblich, ist sourceLang 'de' — der Demo-
   Provider (kein API-Schlüssel im Prüflauf) übersetzt "Fehler" laut
   seinem de>en-Wörterbuch fest zu "bug"; das Wort steht in keiner anderen
   Wörterbuch-Zeile, kommt in "Kritischer Fehler" also nur bei sourceLang
   'de' heraus. Die beiden Fälle unterscheiden sich damit beobachtbar:
   entweder null (Rückfall auf die Autorensprache) oder exakt
   "Kritischer bug" (primary_language griff). */
db.run(`INSERT INTO users (id, handle, display_name, password_hash, language, created_at)
        VALUES ('autor-en', 'autor-en', 'Author', 'x', 'en', 0)`);
db.run(`INSERT INTO channels (id, kind, name, topic, primary_language, created_by, created_at)
        VALUES ('probe-kanal-2', 'public', 'probe2', 'Kritischer Fehler', 'de', 'autor-en', 0)`);
console.log('\ntranslateChannel(): primary_language="de" gilt, auch wenn die Autorin sonst Englisch schreibt');
const kanal2 = await translateChannel('probe-kanal-2', 'en');
pruef(
  'übersetzt mit sourceLang "de" aus primary_language, nicht mit der Autorensprache "en"'
    + ' (sonst: NOOP wegen source===target, also null)',
  kanal2?.topic ?? null,
  'Kritischer bug',
);

console.log(`\n${fehler === 0 ? '✓ alle Prüfungen bestanden' : `✗ ${fehler} Prüfung(en) fehlgeschlagen`}`);
process.exit(fehler === 0 ? 0 : 1);
