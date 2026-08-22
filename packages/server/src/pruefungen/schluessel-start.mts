/**
 * Ein Serverstart, auf das Nötigste eingedampft — die Werkbank für
 * scripts/schluesselwechsel-pruefen.mjs.
 *
 * Warum nicht der echte Server: geprüft wird `initDb()`, und dort sitzt die
 * Schlüsselprobe. Alles danach (Fastify, WebSocket, Übersetzungsanbieter)
 * braucht Netz und Zeit und trägt zur Frage nichts bei. Der Aufruf hier ist
 * derselbe, den `src/index.ts` als Allererstes tut.
 *
 *   --anlegen   zusätzlich ein Konto und eine Nachricht anlegen, damit in der
 *               Datenbank wirklich etwas steht, das am Schlüssel hängt
 *
 * Läuft der Start durch, steht am Ende START-OK auf der Ausgabe. Schlägt die
 * Probe zu, kommt es dazu nicht: sie beendet den Vorgang mit 1.
 */
import { db, initDb } from '../db/index.js';
import { createAccount } from '../services/users.js';
import { verschluesseln } from '../crypto/nachrichten.js';

initDb();

if (process.argv.includes('--anlegen') && !db.get('SELECT 1 AS x FROM users LIMIT 1')) {
  const konto = createAccount({
    displayName: 'Probe Person',
    handle: 'probe',
    email: 'probe@example.org',
    role: 'owner',
    createdBy: 'system',
  });
  db.run(
    `INSERT INTO channels (id, kind, name, created_by, created_at)
     VALUES ('ch_probe', 'public', 'probe', ?, ?)`,
    konto.userId, Date.now(),
  );
  db.run(
    `INSERT INTO messages (id, channel_id, user_id, text, kind, created_at)
     VALUES ('msg_probe', 'ch_probe', ?, ?, 'text', ?)`,
    konto.userId, verschluesseln('Ein Satz, der verschlüsselt liegen soll.'), Date.now(),
  );
}

console.log('START-OK');
