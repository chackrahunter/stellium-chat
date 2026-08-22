/**
 * Prüft gegen eine frische Datenbank: trifft das Löschen einer Nachricht
 * wirklich nur IHREN Beitrag zum Übersetzungsspeicher, ohne eine Phrase
 * wegzuwerfen, die eine andere, weiter bestehende Nachricht noch braucht?
 *
 * Der Befund lautete: translation_memory wird beim Löschen gar nicht
 * angefasst — Quelle und Übersetzung jeder je übersetzten Phrase blieben
 * liegen. Die naive Antwort ("beim Löschen einfach die Zeile mit demselben
 * Text wegwerfen") würde den Speicher für alle anderen Nachrichten mit
 * derselben Phrase entwerten. Dieser Lauf simuliert genau den Konflikt: zwei
 * Nachrichten teilen sich eine Phrase, eine dritte hat eine eigene.
 *
 * Simuliert wird auf der Ebene von message_translations/translation_memory
 * direkt (ohne echten Übersetzer-Aufruf) — geprüft wird damit gezielt die
 * Buchführung in tmVerweiseNachrechnen()/dropMessageTranslations(), nicht
 * der Netzwerkpfad zum Modell.
 *
 * Aufruf:  node scripts/uebersetzungsspeicher-loeschen-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import { dropMessageTranslations, tmVerweiseNachrechnen } from '../translation/index.js';
import { deleteMessage } from '../services/messages.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probe1', 'probe1', 'Probe', 'x', 0)`);
db.run(`INSERT OR IGNORE INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-ch', 'public', 'probe', 'probe1', 0)`);
for (const id of ['msgA', 'msgB', 'msgC']) {
  db.run(`INSERT OR IGNORE INTO messages (id, channel_id, user_id, text, created_at)
          VALUES (?, 'probe-ch', 'probe1', 'x', 0)`, id);
}

/* K1 = geteilte Phrase ("Guten Morgen" von msgA UND msgB), K2 = eigene Phrase
   von msgC. hits/verweise starten wie beim echten INSERT in translate(). */
for (const [key, quelle, ziel] of [
  ['K1', 'Guten Morgen', 'Good morning'],
  ['K2', 'Wie geht es dir', 'How are you'],
] as const) {
  db.run(
    `INSERT INTO translation_memory (key, source_lang, target_lang, source_text, target_text, provider, hits, created_at, verweise)
     VALUES (?, 'de', 'en', ?, ?, 'demo', 1, 0, 0)`,
    key, quelle, ziel,
  );
}
db.run(`INSERT INTO message_translations (message_id, lang, text, provider, source_hash, tm_key, created_at)
        VALUES ('msgA', 'en', 'Good morning', 'demo', 'hA', 'K1', 0)`);
db.run(`INSERT INTO message_translations (message_id, lang, text, provider, source_hash, tm_key, created_at)
        VALUES ('msgB', 'en', 'Good morning', 'demo', 'hB', 'K1', 0)`);
db.run(`INSERT INTO message_translations (message_id, lang, text, provider, source_hash, tm_key, created_at)
        VALUES ('msgC', 'en', 'How are you', 'demo', 'hC', 'K2', 0)`);

// Wie translateMessage() es nach jedem Schreiben täte: den Zähler aus der
// Wahrheit ziehen.
tmVerweiseNachrechnen(['K1', 'K2']);

const verweise = (key: string) => db.get<{ verweise: number }>('SELECT verweise FROM translation_memory WHERE key = ?', key)?.verweise;
const gibtsNoch = (key: string) => Boolean(db.get('SELECT 1 AS x FROM translation_memory WHERE key = ?', key));

console.log('Vor dem Löschen:');
pruef('K1 (msgA + msgB) zählt 2 Verweise', verweise('K1'), 2);
pruef('K2 (nur msgC) zählt 1 Verweis', verweise('K2'), 1);

console.log('\nmsgA wird gelöscht (Nachricht zurückgenommen):');
deleteMessage('msgA', 'probe1', true, 'all');
pruef('K1 zählt jetzt nur noch msgB', verweise('K1'), 1);
pruef('K1 besteht weiter — msgB braucht die Phrase noch', gibtsNoch('K1'), true);
pruef('K2 unberührt', verweise('K2'), 1);
pruef('msgA selbst hat keine message_translations-Zeile mehr',
  db.all('SELECT 1 FROM message_translations WHERE message_id = ?', 'msgA'), []);

console.log('\nAuch msgB wird gelöscht — niemand braucht "Guten Morgen" mehr:');
dropMessageTranslations('msgB');
pruef('K1 ist jetzt vollständig aus translation_memory entfernt', gibtsNoch('K1'), false);
pruef('K2 (msgC) bleibt unverändert bestehen', verweise('K2'), 1);
pruef('K2 ist weiterhin auffindbar', gibtsNoch('K2'), true);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mLöschen trifft genau die Phrasen, die niemand mehr braucht — nicht mehr, nicht weniger.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
