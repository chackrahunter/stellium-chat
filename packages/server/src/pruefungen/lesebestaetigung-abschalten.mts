/**
 * Wer Lesebestätigungen abschaltet: verschwindet aus der Leserliste anderer,
 * ohne den eigenen Ungelesen-Zähler zu verlieren.
 *
 * Die Lesemarke (channel_members.last_read_message_id/last_read_at) trägt
 * BEIDES — die Leserliste (readReceiptsBatch) UND den Ungelesen-Zähler
 * (store.unreadCounts/channelState). Der naheliegende, falsche Umbau wäre,
 * beim Abschalten das SCHREIBEN der Marke zu unterlassen — dann stünde die
 * Person zwar bei niemandem mehr als Leserin, aber ihr eigener Kanal zeigte
 * dieselben Nachrichten immer wieder als ungelesen. Richtig ist: die Marke
 * wird weiter gesetzt wie eh und je (messages.markRead bleibt unverändert),
 * nur die AUSGABE an andere unterbleibt — geprüft wird hier genau das, an der
 * echten readReceiptsBatch()/channelState() aus services/messages.ts und
 * services/store.ts, nicht an einer Nachbildung.
 *
 * Läuft gegen eine WEGWERFBARE Datenbank — siehe scripts/lesebestaetigung-
 * abschalten-pruefen.mjs, dasselbe Muster wie bei umfrage-anonym.mts.
 *
 * Aufruf:  node scripts/lesebestaetigung-abschalten-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import * as messages from '../services/messages.js';
import * as store from '../services/store.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probe-alice', 'probe-alice', 'Alice', 'x', 0)`);
db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probe-bob', 'probe-bob', 'Bob', 'x', 0)`);
// Deterministischer Ausgangspunkt, auch wenn dieser Lauf schon einmal gegen
// dieselbe Datenbank lief (INSERT OR IGNORE übergeht dann das Anlegen oben).
db.run(`UPDATE users SET lesebestaetigung_aus = 0 WHERE id = 'probe-bob'`);

db.run(`INSERT OR IGNORE INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-lb-ch', 'public', 'probe', 'probe-alice', 0)`);
db.run(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at)
        VALUES ('probe-lb-ch', 'probe-alice', 0)`);
db.run(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at)
        VALUES ('probe-lb-ch', 'probe-bob', 0)`);
// Zurücksetzen auf "noch nichts gelesen", falls schon einmal gelaufen.
db.run(`UPDATE channel_members SET last_read_message_id = NULL, last_read_at = NULL
        WHERE channel_id = 'probe-lb-ch' AND user_id = 'probe-bob'`);

// Lexikalisch sortierbar wie echte newId()-Kennungen — '1' < '2' reicht hier.
// Die zweite Nachricht entsteht bewusst erst weiter unten, an der Stelle in
// der Erzählung, an der Alice sie tatsächlich schreibt — sonst zählte der
// Ungelesen-Zähler sie schon mit, bevor Bob überhaupt zum ersten Mal gelesen
// hat, und der Schritt "0 Ungelesene direkt nach dem Lesen" wäre falsch.
db.run(`DELETE FROM messages WHERE id IN ('probe-lb-msg-1', 'probe-lb-msg-2')`);
db.run(`INSERT INTO messages (id, channel_id, user_id, text, created_at)
        VALUES ('probe-lb-msg-1', 'probe-lb-ch', 'probe-alice', 'hallo', 0)`);

console.log('\nLesebestätigungen an (Vorgabe) — Bob liest die erste Nachricht:');
pruef('Vorgabe: lesebestaetigungAus steht auf false', store.lesebestaetigungAus('probe-bob'), false);
const at1 = messages.markRead('probe-lb-ch', 'probe-bob', 'probe-lb-msg-1');
pruef('markRead() rückt vor', at1 !== null, true);
let leser = messages.readReceiptsBatch(['probe-lb-msg-1']);
pruef('Bob erscheint als Leser der ersten Nachricht', leser['probe-lb-msg-1'].map((r) => r.userId), ['probe-bob']);
pruef('Bobs Ungelesen-Zähler ist 0 (alles gelesen)', store.channelState('probe-lb-ch', 'probe-bob')!.unreadCount, 0);

console.log('\nBob schaltet Lesebestätigungen ab (wie prefs:update -> EINSTELLUNGEN.lesebestaetigungAus):');
db.run(`UPDATE users SET lesebestaetigung_aus = 1 WHERE id = 'probe-bob'`);
pruef('lesebestaetigungAus steht jetzt auf true', store.lesebestaetigungAus('probe-bob'), true);
leser = messages.readReceiptsBatch(['probe-lb-msg-1']);
pruef('Bob erscheint NICHT MEHR in der Leserliste', leser['probe-lb-msg-1'] ?? [], []);
const stNachAbschalten = store.channelState('probe-lb-ch', 'probe-bob')!;
pruef('Bobs Lesemarke steht unverändert auf der ersten Nachricht', stNachAbschalten.lastReadMessageId, 'probe-lb-msg-1');
pruef('Bobs eigener Ungelesen-Zähler bleibt 0', stNachAbschalten.unreadCount, 0);

console.log('\nAlice schreibt eine zweite Nachricht, NACHDEM Bob abgeschaltet hat:');
db.run(`INSERT INTO messages (id, channel_id, user_id, text, created_at)
        VALUES ('probe-lb-msg-2', 'probe-lb-ch', 'probe-alice', 'zweite Nachricht', 1)`);
const stUngelesen = store.channelState('probe-lb-ch', 'probe-bob')!;
pruef('Ungelesen-Zähler zählt die neue Nachricht trotzdem mit', stUngelesen.unreadCount, 1);

console.log('\nBob liest auch die zweite — die Marke rückt weiter vor, trotz abgeschalteter Lesebestätigung:');
const at2 = messages.markRead('probe-lb-ch', 'probe-bob', 'probe-lb-msg-2');
pruef('markRead() funktioniert unverändert', at2 !== null, true);
const stFertig = store.channelState('probe-lb-ch', 'probe-bob')!;
pruef('Ungelesen-Zähler wieder 0', stFertig.unreadCount, 0);
pruef('Lesemarke steht jetzt auf der zweiten Nachricht', stFertig.lastReadMessageId, 'probe-lb-msg-2');
leser = messages.readReceiptsBatch(['probe-lb-msg-1', 'probe-lb-msg-2']);
pruef('Bob taucht bei keiner der beiden Nachrichten auf', [leser['probe-lb-msg-1'] ?? [], leser['probe-lb-msg-2'] ?? []], [[], []]);

console.log('\nGegenprobe: wieder einschalten macht die schon geschriebene Marke sofort wieder sichtbar:');
db.run(`UPDATE users SET lesebestaetigung_aus = 0 WHERE id = 'probe-bob'`);
leser = messages.readReceiptsBatch(['probe-lb-msg-2']);
pruef('Bob ist wieder sichtbar — nichts ging beim Abschalten verloren', leser['probe-lb-msg-2'].map((r) => r.userId), ['probe-bob']);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mAbgeschaltet heißt "nicht mehr herausgegeben", nicht "nicht mehr mitgeschrieben" — der Ungelesen-Zähler bleibt unberührt.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
