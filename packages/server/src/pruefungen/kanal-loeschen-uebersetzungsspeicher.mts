/**
 * Prüft gegen eine frische Datenbank: räumt das Löschen eines KANALS den
 * Übersetzungsspeicher genauso auf wie das Löschen einer einzelnen
 * Nachricht?
 *
 * Der Befund lautete: services/channels.ts deleteChannel() ruft
 * tmVerweiseNachrechnen() nirgends auf. deleteMessage() und editMessage()
 * (services/messages.ts) tun das beide. ON DELETE CASCADE räumt beim Löschen
 * eines Kanals zwar messages und darüber message_translations korrekt ab —
 * aber translation_memory.verweise ist eine GECACHTE Zählung, die nur
 * tmVerweiseNachrechnen() aus der Wahrheit (message_translations) neu
 * bestimmt (siehe translation/index.ts). Ohne diesen Aufruf bleibt die
 * Zählung nach dem Löschen eines ganzen Kanals stehen, wo sie vorher stand —
 * und eine Phrase, die NUR NOCH von Nachrichten im gelöschten Kanal gehalten
 * wurde, verschwindet nie: Quelle UND Übersetzung jeder je übersetzten
 * Phrase des Kanals bleiben für immer im Übersetzungsspeicher liegen, obwohl
 * der Kanal selbst weg ist.
 *
 * Fast eine Zielverschiebung von uebersetzungsspeicher-loeschen.mts (dort:
 * deleteMessage) auf deleteChannel — dieselbe Buchführung, ein anderer
 * Auslöser. Siehe dort für dieselbe Machart im Detail; dieser Lauf ist
 * services/channels.ts' erste Prüfung überhaupt (channels.ts stand bisher in
 * keinem Prüflauf).
 *
 * Der Aufbau prüft BEIDE Richtungen, nicht nur das Leck: zwei Nachrichten in
 * Kanal A teilen sich eine übersetzte Phrase, eine dritte Nachricht in Kanal
 * B trägt DIESELBE Phrase. Kanal A wird gelöscht — die Phrase muss bestehen
 * bleiben (Kanal B braucht sie noch), nur ihr Zähler darf um genau zwei
 * sinken. Erst wenn auch Kanal B gelöscht ist, darf die Phrase wirklich
 * verschwinden. Eine Lösung, die beim Löschen eines Kanals einfach jede
 * seiner Phrasen unbesehen aus translation_memory wirft, bestünde eine
 * Prüfung, die nur nach dem Leck sucht — und würde hier trotzdem
 * durchfallen, weil sie Kanal B die Übersetzung unter den Füßen wegzöge.
 * Diese Überlöschungs-Prüfung ist so wichtig wie die Unterlöschungs-Prüfung:
 * eine Lösung, die einfach alles wegwirft, verliert stillschweigend Daten
 * eines anderen, weiterbestehenden Kanals.
 *
 * Aufruf:  node scripts/kanal-loeschen-uebersetzungsspeicher-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import { tmVerweiseNachrechnen } from '../translation/index.js';
import { deleteChannel } from '../services/channels.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probe1', 'probe1', 'Probe', 'x', 0)`);
db.run(`INSERT INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-chA', 'public', 'probe-a', 'probe1', 0)`);
db.run(`INSERT INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-chB', 'public', 'probe-b', 'probe1', 0)`);

db.run(`INSERT INTO messages (id, channel_id, user_id, text, created_at) VALUES ('msgA1', 'probe-chA', 'probe1', 'x', 0)`);
db.run(`INSERT INTO messages (id, channel_id, user_id, text, created_at) VALUES ('msgA2', 'probe-chA', 'probe1', 'x', 0)`);
db.run(`INSERT INTO messages (id, channel_id, user_id, text, created_at) VALUES ('msgB1', 'probe-chB', 'probe1', 'x', 0)`);

/* K1 = "Guten Morgen" -> "Good morning", geteilt von msgA1 UND msgA2 (Kanal
   A) UND msgB1 (Kanal B) — dieselbe Phrase, drei Nachrichten, zwei Kanäle.
   hits/verweise starten wie beim echten INSERT in translate(). */
db.run(
  `INSERT INTO translation_memory (key, source_lang, target_lang, source_text, target_text, provider, hits, created_at, verweise)
   VALUES ('K1', 'de', 'en', 'Guten Morgen', 'Good morning', 'demo', 1, 0, 0)`,
);
for (const [msgId, hash] of [['msgA1', 'hA1'], ['msgA2', 'hA2'], ['msgB1', 'hB1']] as const) {
  db.run(
    `INSERT INTO message_translations (message_id, lang, text, provider, source_hash, tm_key, created_at)
     VALUES (?, 'en', 'Good morning', 'demo', ?, 'K1', 0)`,
    msgId, hash,
  );
}
// Wie translateMessage() es nach jedem Schreiben täte: den Zähler aus der
// Wahrheit ziehen.
tmVerweiseNachrechnen(['K1']);

const verweise = () => db.get<{ verweise: number }>('SELECT verweise FROM translation_memory WHERE key = ?', 'K1')?.verweise;
const gibtsNoch = () => Boolean(db.get('SELECT 1 AS x FROM translation_memory WHERE key = ?', 'K1'));

console.log('Vor dem Löschen:');
pruef('K1 zählt alle drei Nachrichten (msgA1, msgA2, msgB1)', verweise(), 3);

console.log('\nKanal A wird gelöscht (msgA1 + msgA2 gehen mit ihm) — Kanal B bleibt bestehen:');
deleteChannel('probe-chA');

pruef('msgA1/msgA2 haben keine message_translations-Zeile mehr (ON DELETE CASCADE über messages)',
  db.all('SELECT 1 FROM message_translations WHERE message_id IN (?, ?)', 'msgA1', 'msgA2'), []);
pruef('msgB1s message_translations-Zeile steht weiter (anderer Kanal, nicht betroffen)',
  db.all('SELECT 1 FROM message_translations WHERE message_id = ?', 'msgB1').length, 1);
pruef('K1 zählt jetzt nur noch msgB1 — der Zähler ist um genau zwei gesunken', verweise(), 1);
pruef('K1 besteht weiter — Kanal B braucht die Phrase noch (keine Überlöschung)', gibtsNoch(), true);

console.log('\nAuch Kanal B wird gelöscht — niemand braucht "Guten Morgen" mehr:');
deleteChannel('probe-chB');
pruef('K1 ist jetzt vollständig aus translation_memory entfernt (kein Leck)', gibtsNoch(), false);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mKanal-Löschen trifft den Übersetzungsspeicher genauso präzise wie Nachrichten-Löschen.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
