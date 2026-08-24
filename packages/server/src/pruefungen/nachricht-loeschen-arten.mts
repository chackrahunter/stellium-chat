/**
 * Prüft gegen eine frische Datenbank: blendet das Löschen einer Nachricht
 * WIRKLICH JEDE Art von Inhalt aus, nicht nur Text?
 *
 * Der Befund lautete: hydrateMessages() (services/store.ts) prüfte
 * `deleted_at` für `text`, `attachments` und `links`, aber `poll` und
 * `voice` wurden unbedingt berechnet. Eine gelöschte Sprachnachricht schickte
 * ihr Whisper-Transkript trotzdem an jedes Kanalmitglied weiter, eine
 * gelöschte Umfrage Frage und Antwortoptionen — bei jedem Laden des
 * Verlaufs, obwohl der Text direkt daneben schon leer war. Ein anderer Agent
 * behebt genau das gerade; dieser Lauf kann beim ersten Start also noch rot
 * sein (siehe Bericht an den Auftraggeber für den aktuellen Stand).
 *
 * Geprüft wird über den ECHTEN Lesepfad — getMessage()/hydrateMessages() —,
 * nicht mit eigenem SQL: der Fehler sitzt genau in dieser Funktion, eine
 * Prüfung, die daran vorbeiliest, würde ihn nicht sehen.
 *
 * EINE Tabelle, keine drei Blöcke: für jede bekannte Art (text, poll, voice)
 * läuft unten dieselbe Prüfschleife. `kind` ist in der Datenbank eine freie
 * TEXT-Spalte ohne eigene Aufzählung, die sich automatisch abfragen ließe
 * (siehe @stellium/shared, `Message.kind: string` — nur ein Kommentar nennt
 * "text" | "voice" | "poll") — kommt später eine sechste Art dazu, muss sie
 * hier von Hand als weiterer Eintrag in ARTEN ergänzt werden. Was sich NICHT
 * von Hand nachziehen lässt, ist die Prüfung selbst: `nachDemLoeschenLeer()`
 * verlangt für JEDE Art dasselbe vollständige Bündel — text, attachments,
 * poll, voice, links, mentionUserIds, genau die Felder, die in
 * hydrateMessages() hinter der EINEN `inhalt`-Prüfung stehen —, nicht nur
 * das eine Feld, das die jeweilige Art selbst befüllt. Wer ein neues Feld
 * einführt und vergisst, es in dieses Bündel aufzunehmen, reißt schon die
 * ERSTE Art in der Schleife aus, nicht erst die neue.
 *
 * Gegenprobe: dieselbe Nachricht wird zuerst UNGELÖSCHT gelesen — sonst
 * bewiese ein leeres Ergebnis nach dem Löschen nichts (leere Fixture statt
 * gehaltener Zusage). Bei der Art "text" hängt zusätzlich eine echte
 * Erwähnung dran, damit auch `mentionUserIds` an echtem Inhalt geprüft wird
 * und nicht nur an einem von vornherein leeren Feld.
 *
 * Aufruf:  node scripts/nachricht-loeschen-arten-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import { deleteMessage } from '../services/messages.js';
import { getMessage } from '../services/store.js';
import { createPoll } from '../services/polls.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probeU', 'probeU', 'Probe', 'x', 0)`);
db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probeErwaehnt', 'probeErwaehnt', 'Erwähnt', 'x', 0)`);
db.run(`INSERT INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-ch', 'public', 'probe', 'probeU', 0)`);

/* ── Eine Zeile je bekannter Art ─────────────────────────────────────
 * `vorbereiten()` legt die Nachricht UND ihren artspezifischen Inhalt an.
 * `vorherIst()` ist die Gegenprobe: was die UNGELÖSCHTE Nachricht mindestens
 * zeigen muss. Die eigentliche Prüfung (das ganze inhalt-Bündel NACH dem
 * Löschen) läuft für jede Zeile identisch weiter unten — siehe
 * nachDemLoeschenLeer(). */
interface ArtProbe {
  kind: string;
  messageId: string;
  vorbereiten(): void;
  vorherIst(msg: any): void;
}

const ARTEN: ArtProbe[] = [
  {
    kind: 'text',
    messageId: 'probe-text',
    vorbereiten() {
      db.run(
        `INSERT INTO messages (id, channel_id, user_id, text, kind, created_at)
         VALUES ('probe-text', 'probe-ch', 'probeU', 'Hallo Welt, das hier ist der Text.', 'text', ?)`,
        Date.now(),
      );
      db.run(
        `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, created_at)
         VALUES ('probe-att', 'probe-text', 'probeU', 'foto.png', 'image/png', 1234, '/dev/null', ?)`,
        Date.now(),
      );
      db.run(
        `INSERT INTO link_previews (url_hash, url, title, description, ok, fetched_at)
         VALUES ('probe-hash', 'https://example.test/', 'Beispiel', 'Eine Beschreibung', 1, ?)`,
        Date.now(),
      );
      db.run(`INSERT INTO message_links (message_id, url_hash, position) VALUES ('probe-text', 'probe-hash', 0)`);
      db.run(`INSERT INTO message_mentions (message_id, user_id) VALUES ('probe-text', 'probeErwaehnt')`);
    },
    vorherIst(msg) {
      pruef('text: der Inhalt steht vor dem Löschen', msg.text, 'Hallo Welt, das hier ist der Text.');
      pruef('text: der Anhang steht vor dem Löschen', msg.attachments.length, 1);
      pruef('text: die Link-Vorschau steht vor dem Löschen', msg.links.length, 1);
      pruef('text: die Erwähnung steht vor dem Löschen', msg.mentionUserIds, ['probeErwaehnt']);
    },
  },
  {
    kind: 'poll',
    messageId: 'probe-poll',
    vorbereiten() {
      db.run(
        `INSERT INTO messages (id, channel_id, user_id, text, kind, created_at)
         VALUES ('probe-poll', 'probe-ch', 'probeU', 'Umfrage', 'poll', ?)`,
        Date.now(),
      );
      createPoll({
        messageId: 'probe-poll', question: 'Schmeckt der Kaffee?',
        options: ['Ja', 'Nein'], multiple: false, anonymous: false, userId: 'probeU',
      });
    },
    vorherIst(msg) {
      pruef('poll: die Frage steht vor dem Löschen', msg.poll?.question, 'Schmeckt der Kaffee?');
      pruef('poll: die Optionen stehen vor dem Löschen',
        msg.poll?.options.map((o: any) => o.text), ['Ja', 'Nein']);
    },
  },
  {
    kind: 'voice',
    messageId: 'probe-voice',
    vorbereiten() {
      db.run(
        `INSERT INTO messages (id, channel_id, user_id, text, kind, created_at)
         VALUES ('probe-voice', 'probe-ch', 'probeU', '', 'voice', ?)`,
        Date.now(),
      );
      db.run(
        `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, created_at)
         VALUES ('probe-audio', 'probe-voice', 'probeU', 'aufnahme.webm', 'audio/webm', 5678, '/dev/null', ?)`,
        Date.now(),
      );
      db.run(
        `INSERT INTO voice_transcripts (attachment_id, text, lang, duration_ms, provider, model, created_at)
         VALUES ('probe-audio', 'Ein Satz, den niemand mehr hören soll.', 'de', 3000, 'lokal', 'test', ?)`,
        Date.now(),
      );
    },
    vorherIst(msg) {
      pruef('voice: das Transkript steht vor dem Löschen',
        msg.voice?.transcript, 'Ein Satz, den niemand mehr hören soll.');
      pruef('voice: der Anhang steht vor dem Löschen', msg.attachments.length, 1);
    },
  },
];

/* Das vollständige Bündel aus services/store.ts, hydrateMessages() — genau
   die Felder, die dort hinter der EINEN deleted_at-Prüfung stehen (oder
   stehen sollten). Läuft für JEDE Art identisch, nicht nur für die Art,
   deren Lücke bekannt war: eine text-Nachricht ohne poll/voice muss diese
   Felder ebenso leer zeigen wie eine Umfrage ihre Frage. */
function nachDemLoeschenLeer(art: string, msg: any) {
  pruef(`${art}: text ist leer`, msg.text, '');
  pruef(`${art}: attachments ist leer`, msg.attachments, []);
  pruef(`${art}: poll ist null`, msg.poll, null);
  pruef(`${art}: voice ist null`, msg.voice, null);
  pruef(`${art}: links ist leer`, msg.links, []);
  pruef(`${art}: mentionUserIds ist leer`, msg.mentionUserIds, []);
  pruef(`${art}: deletedAt ist gesetzt`, typeof msg.deletedAt === 'number', true);
  // kind bleibt bewusst stehen — den braucht der Löschvermerk selbst
  // ("Sprachnachricht gelöscht" statt nur "Nachricht gelöscht").
  pruef(`${art}: kind bleibt erhalten (für den Löschvermerk)`, msg.kind, art);
}

for (const probe of ARTEN) {
  console.log(`\nArt "${probe.kind}":`);
  probe.vorbereiten();

  const vorher = getMessage(probe.messageId, 'probeU');
  if (!vorher) {
    pruef(`${probe.kind}: Nachricht wurde angelegt und ist lesbar`, false, true);
    continue;
  }
  probe.vorherIst(vorher);

  deleteMessage(probe.messageId, 'probeU', false, 'all');

  const nachher = getMessage(probe.messageId, 'probeU');
  if (!nachher) {
    pruef(`${probe.kind}: Nachricht bleibt nach dem Löschen als Tombstone auffindbar`, false, true);
    continue;
  }
  nachDemLoeschenLeer(probe.kind, nachher);
}

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mLöschen blendet JEDE bekannte Art von Nachrichteninhalt aus — nicht nur Text.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
