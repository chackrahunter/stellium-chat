/**
 * Prüft gegen eine frische Datenbank: ein Anhang-Platzhalter, dessen Upload
 * nie ankam, verschwindet nach seiner Frist von selbst — UND alle, die die
 * Nachricht schon gesehen haben, erfahren davon (ihr Kreisel hört auf zu
 * drehen), nicht nur der Server intern.
 *
 * DER BEFUND, DEN DIESER LAUF ABDECKT
 * `ausstehendeAnhaenge` (ws/gateway.ts) wurde bisher nur durch message:attach
 * und message:attachGiveUp geleert — quittiert eine Verbindung nie eins von
 * beiden (App beendet, Auto-Updater dazwischen, während ein Upload noch
 * läuft), blieb der Eintrag bis zum nächsten Serverneustart stehen, und jede
 * Person, die die Nachricht schon zugestellt bekommen hat, sah "wird
 * hochgeladen" für immer weiterdrehen. Die sendende Person selbst sah davon
 * nichts (Kanalverläufe liefern pendingAttachments nicht mit) — genau das
 * machte den Fehler für Betroffene undiagnostizierbar.
 *
 * Läuft über eine ECHTE handleConnection()-Sitzung mit einer eigenen,
 * minimalen Attrappe für `ws.WebSocket` (kein echter Netzwerk-Socket, kein
 * offener Port) — so entsteht der Platzhalter genau wie im echten Betrieb,
 * über message:send, und der Rundruf nach dem Aufräumen lässt sich an der
 * Attrappe eines ZWEITEN Kontos beobachten, ohne einen laufenden Server
 * vorauszusetzen.
 *
 * Aufruf:  node scripts/anhang-platzhalter-frist-pruefen.mjs
 */
import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@stellium/shared';
import { WS_PROTOCOL_VERSION } from '@stellium/shared';
import { db, initDb } from '../db/index.js';
import { signToken } from '../auth.js';
import * as gateway from '../ws/gateway.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/** Minimale Attrappe für `ws.WebSocket` — genug für handleConnection():
 *  `on`/`emit` (EventEmitter), `readyState`, `send`, `close`, `terminate`.
 *  Kein echter Netzwerk-Socket, kein offener Port. */
class FakeSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  empfangen: ServerEvent[] = [];
  send(raw: string) { this.empfangen.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
}

function person(id: string): void {
  db.run(
    `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
     VALUES (?,?,?,'x',0)`, id, id, id,
  );
}
person('probe-frist-alice');
person('probe-frist-bob');
db.run(`INSERT OR IGNORE INTO channels (id, kind, name, created_by, created_at)
        VALUES ('probe-frist-ch', 'public', 'probe', 'probe-frist-alice', 0)`);
db.run(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at)
        VALUES ('probe-frist-ch', 'probe-frist-alice', 0)`);
db.run(`INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at)
        VALUES ('probe-frist-ch', 'probe-frist-bob', 0)`);

const alice = new FakeSocket();
const bob = new FakeSocket();
gateway.handleConnection(alice as any);
gateway.handleConnection(bob as any);
alice.emit('message', JSON.stringify({ t: 'auth', token: signToken('probe-frist-alice'), protocol: WS_PROTOCOL_VERSION }));
bob.emit('message', JSON.stringify({ t: 'auth', token: signToken('probe-frist-bob'), protocol: WS_PROTOCOL_VERSION }));

console.log('\nAlice schickt eine Nachricht mit zwei noch hochladenden Anhängen:');
alice.emit('message', JSON.stringify({
  t: 'message:send', clientId: 'probe-frist-c1', channelId: 'probe-frist-ch', text: '',
  pendingAttachments: [
    { tempId: 'video', name: 'grillabend.mp4', mime: 'video/mp4' },
    { tempId: 'foto', name: 'urlaub.jpg', mime: 'image/jpeg' },
  ],
}));

const neu = bob.empfangen.find((e): e is Extract<ServerEvent, { t: 'message:new' }> =>
  e.t === 'message:new' && e.message.channelId === 'probe-frist-ch');
pruef('Bob bekommt die Nachricht sofort zugestellt', Boolean(neu), true);
const messageId = neu?.message.id ?? '';
pruef('Bob sieht beide Platzhalter in der frischen Nachricht', neu?.message.pendingAttachments?.map((p) => p.tempId).sort(), ['foto', 'video']);

console.log('\nEin Aufräumlauf sofort danach rührt frische Platzhalter nicht an:');
const sofort = gateway.ausstehendeAnhaengeAufraeumen();
pruef('nichts wird entfernt — beide Anhänge sind gerade erst angelegt', sofort, 0);

console.log('\nDer Video-Upload bricht ab, ohne dass die App das je meldet (kein message:attach, kein message:attachGiveUp) — die Frist läuft ab:');
gateway._platzhalterAlternLassenFuerPruefung(messageId, 'video', 31 * 60_000);
bob.empfangen.length = 0; // nur den Rundruf DIESES Aufräumlaufs beobachten
const entferntErsteRunde = gateway.ausstehendeAnhaengeAufraeumen();
pruef('genau ein verwaister Platzhalter wird entfernt', entferntErsteRunde, 1);

const aktualisiert1 = bob.empfangen.find((e): e is Extract<ServerEvent, { t: 'message:updated' }> =>
  e.t === 'message:updated' && e.message.id === messageId);
pruef('Bob bekommt einen message:updated-Rundruf, genau wie bei message:attachGiveUp', Boolean(aktualisiert1), true);
pruef('der verwaiste Video-Platzhalter ist weg', aktualisiert1?.message.pendingAttachments?.map((p) => p.tempId), ['foto']);
pruef('der frische Foto-Platzhalter steht noch — nicht jeder Platzhalter der Nachricht fällt pauschal weg', aktualisiert1?.message.pendingAttachments?.length, 1);

console.log('\nEin zweiter Aufräumlauf sofort danach findet nichts mehr zu tun (kein Doppel-Rundruf):');
bob.empfangen.length = 0;
const zweiteRunde = gateway.ausstehendeAnhaengeAufraeumen();
pruef('nichts Neues abgelaufen', zweiteRunde, 0);
pruef('kein weiterer Rundruf ohne echte Änderung', bob.empfangen.some((e) => e.t === 'message:updated'), false);

console.log('\nAuch der zweite (Foto-)Anhang verwaist irgendwann — die Nachricht wird vollständig sauber:');
gateway._platzhalterAlternLassenFuerPruefung(messageId, 'foto', 31 * 60_000);
bob.empfangen.length = 0;
const entferntZweiteRunde = gateway.ausstehendeAnhaengeAufraeumen();
pruef('auch der zweite Platzhalter wird entfernt', entferntZweiteRunde, 1);
const aktualisiert2 = bob.empfangen.find((e): e is Extract<ServerEvent, { t: 'message:updated' }> =>
  e.t === 'message:updated' && e.message.id === messageId);
pruef('Bobs Kreisel bekommt endgültig Bescheid — keine Anhänge mehr offen', aktualisiert2?.message.pendingAttachments?.length, 0);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mEin Platzhalter, dessen Upload nie ankam, verschwindet nach seiner Frist — und alle, die ihn schon sahen, erfahren davon.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
