/**
 * Prüft gegen eine frische Datenbank: landet eine kontextabhängige
 * Übersetzung im GETEILTEN translation_memory, wo ein späteres, ganz
 * anderes Gespräch sie träfe? Und: bleibt translation_memory für die
 * Fälle nutzbar, für die es das nie durfte sein — kurze, oft wiederholte
 * Nachrichten mit Verlauf?
 *
 * DIE ENTSCHEIDUNG (Fund 7, Auftrag)
 *
 * translateMessage() (translation/index.ts) baute für Zielsprache Englisch
 * echten Gesprächsverlauf als `context` (siehe verlauf.ts) — für JEDE
 * Nachricht mit Verlauf, unabhängig von ihrer Länge. Der Zweig für KURZE
 * Nachrichten mit Verlauf (mitWache) setzt `skipWrite: true` für seinen
 * kontextreichen Aufruf — richtig, denn translation_memory cacht ohne
 * Kontext im Schlüssel (nur Anbieter/Sprachen/maskierter Text) — und schreibt
 * die kontextlose Gegenfassung parallel ganz normal. Der else-Zweig (alles
 * andere: LANGE Nachrichten, auch mit Verlauf) bekam denselben `context` UND
 * `skipWrite: true` — das schaltete translation_memory für JEDE englische
 * Nachricht mit Verlauf ab, ganz unabhängig von der Länge, obwohl der
 * gemessene Gewinn der Kontext-Ergänzung nur für die enge, kurze
 * Randbedingung vorliegt (216 Läufe, scripts/polaritaet-messen.mjs).
 *
 * Die Korrektur: der else-Zweig bekommt nur noch die Kanal-Metadaten
 * (`opts.context`) als Kontext, keinen echten Gesprächsverlauf mehr — der
 * Stand vor der Verlauf-Ergänzung, für den gilt, was für Fälle ohne
 * Verlauf schon immer galt: kein Kontext, der eine spätere Wiederverwendung
 * verfälschen könnte, also auch kein Grund mehr für skipWrite. Die
 * Korrektheitsgarantie (eine MIT Kontext erzeugte Übersetzung darf nie OHNE
 * diesen Kontext wieder ausgeliefert werden) bleibt dabei unangetastet — sie
 * gilt jetzt einfach nur noch für den Zweig, der wirklich Kontext anlegt.
 *
 * ZWEI PRÜFUNGEN, DIE SICH UNTERSCHEIDEN MÜSSEN:
 *
 *   1. Lange Nachricht mit Verlauf (else-Zweig): bekommt jetzt KEINEN
 *      echten Gesprächsverlauf mehr im Kontext — translation_memory MUSS
 *      also wieder eine Zeile bekommen, genau wie vor der Verlauf-Ergänzung.
 *   2. Kurze Nachricht mit Verlauf (mitWache-Zweig, unverändert): bekommt
 *      weiterhin echten Verlauf für ihren kontextreichen Kandidaten, der
 *      wegen skipWrite nie in den geteilten Speicher darf — geschrieben
 *      wird dort ausschließlich die kontextlose Gegenfassung. Diese Prüfung
 *      war vorher nicht separat abgedeckt; sie hält zugleich fest, dass
 *      genau die kurzen, oft wiederholten Phrasen ("ok", "danke", "passt"),
 *      um die es beim Speicherdruck auf dem Pi eigentlich geht,
 *      translation_memory nie verloren hatten — nur die langen Nachrichten
 *      im else-Zweig waren betroffen.
 *
 * Aufruf:  node scripts/kontext-skipwrite-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import { translateMessage } from '../translation/index.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT INTO users (id, handle, display_name, password_hash, language, created_at)
        VALUES ('autor-de', 'autor-de', 'Autorin', 'x', 'de', 0)`);
db.run(`INSERT INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-ch', 'public', 'probe', 'autor-de', 0)`);

// Vorherige Nachricht — liefert echten Gesprächsverlauf (verlaufAlsKontext)
// für alles Folgende in diesem Kanal.
db.run(
  `INSERT INTO messages (id, channel_id, user_id, text, source_lang, created_at)
   VALUES ('msg1', 'probe-ch', 'autor-de', 'Kannst du dir das bitte heute noch ansehen?', 'de', 1000)`,
);

/* ── 1. Lange Nachricht mit Verlauf (else-Zweig) ─────────────────────── */

// Mehr als KURZTEXT_WOERTER_SCHWELLE=6 Wörter — landet damit bewusst im
// else-Zweig von translateMessage(), nicht im mitWache-Zweig.
const LANGER_TEXT = 'ich bin heute fertig und das ist schon erledigt bitte pruefe es kurz';
db.run(
  `INSERT INTO messages (id, channel_id, user_id, text, source_lang, created_at)
   VALUES ('msg2', 'probe-ch', 'autor-de', ?, 'de', 2000)`,
  LANGER_TEXT,
);

const zeilenVorLang = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM translation_memory')?.n ?? 0;
pruef('translation_memory ist leer, bevor überhaupt übersetzt wurde', zeilenVorLang, 0);

console.log('\ntranslateMessage(msg2, "en") — lange Nachricht MIT Verlauf im Kanal, aber ohne Verlauf im Kontext');
const ergebnisLang = await translateMessage('msg2', 'en');
pruef('wurde übersetzt (kein Fehlschlag, keine NOOP)', Boolean(ergebnisLang && !ergebnisLang.unuebersetzt), true);

const zeilenNachLang = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM translation_memory')?.n ?? 0;
pruef(
  'translation_memory bekommt jetzt eine Zeile — kein echter Verlauf mehr im Kontext, also nichts zu schützen',
  zeilenNachLang,
  1,
);

// Gegenprobe: message_translations (die NACHRICHTENEIGENE Ablage, nicht der
// geteilte Speicher) bekommt die Übersetzung so oder so — sonst wäre das
// nächste Ansehen derselben Nachricht ein unnötiger zweiter Modellaufruf.
const eigeneAblageLang = db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM message_translations WHERE message_id = 'msg2' AND lang = 'en'",
)?.n ?? 0;
pruef('die Nachricht selbst bekommt trotzdem ihre eigene Übersetzung gespeichert', eigeneAblageLang, 1);

/* ── 2. Kurze Nachricht mit Verlauf (mitWache-Zweig, unverändert) ────── */

// Höchstens 6 Wörter — landet im mitWache-Zweig, dessen kontextreicher
// Kandidat skipWrite trägt (unverändert durch diese Änderung).
// Mit Wörterbuch-Treffern für den Demo-Provider (siehe providers/demo.ts,
// DICT['de>en']) — sonst gäbe "mach ich gleich" unverändert zurück, das
// zählte als Echo (istEcho) und liefe nie bis zum Schreiben durch.
const KURZER_TEXT = 'ja mach ich heute';
db.run(
  `INSERT INTO messages (id, channel_id, user_id, text, source_lang, created_at)
   VALUES ('msg3', 'probe-ch', 'autor-de', ?, 'de', 3000)`,
  KURZER_TEXT,
);

const zeilenVorKurz = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM translation_memory')?.n ?? 0;

console.log('\ntranslateMessage(msg3, "en") — kurze Nachricht MIT Verlauf (mitWache-Zweig)');
const ergebnisKurz = await translateMessage('msg3', 'en');
pruef('wurde übersetzt (kein Fehlschlag, keine NOOP)', Boolean(ergebnisKurz && !ergebnisKurz.unuebersetzt), true);

const zeilenNachKurz = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM translation_memory')?.n ?? 0;
pruef(
  'translation_memory bekommt genau eine neue Zeile — die kontextlose Gegenfassung, nie die kontextreiche',
  zeilenNachKurz - zeilenVorKurz,
  1,
);

console.log(`\n${fehler === 0 ? '✓ alle Prüfungen bestanden' : `✗ ${fehler} Prüfung(en) fehlgeschlagen`}`);
process.exit(fehler === 0 ? 0 : 1);
