import { db, initDb } from './db/index.js';
import { newId } from './util/id.js';
import { createAccount } from './services/users.js';
import { config } from './config.js';
import { encryptionActive } from './crypto/pii.js';

/**
 * Erststart: keine Demo-Daten, sondern ein einziges Owner-Konto mit
 * Einmal-Passwort und ein offener Kanal. Alles Weitere legt die Team-Leitung
 * in der App an.
 */

const STARTKANAELE = [
  { name: 'allgemein', topic: 'Alles, was das ganze Team angeht' },
];

export async function ensureSeed(): Promise<void> {
  if (db.get('SELECT 1 AS x FROM users LIMIT 1')) return;

  const konto = createAccount({
    displayName: 'Administrator',
    handle: 'admin',
    role: 'owner',
    language: 'de',
    timezone: 'Europe/Berlin',
    createdBy: 'system',
  });

  const jetzt = Date.now();
  db.transaction(() => {
    for (const k of STARTKANAELE) {
      const id = newId('ch_');
      db.run(
        `INSERT INTO channels (id, kind, name, topic, primary_language, archived, created_by, created_at)
         VALUES (?, 'public', ?, ?, NULL, 0, ?, ?)`,
        id, k.name, k.topic, konto.userId, jetzt,
      );
      db.run('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)',
        id, konto.userId, jetzt);
    }
  });

  const rahmen = '─'.repeat(54);
  console.log(`
  ${rahmen}
   ${config.workspaceName} ist eingerichtet.

   Melde dich einmalig an und lege dabei deine eigenen
   Zugangsdaten fest:

     Benutzername    ${konto.handle}
     Einmal-Passwort ${konto.oneTimePassword}

   Beim ersten Login wirst du nach einem eigenen Passwort,
   Benutzernamen und deiner E-Mail gefragt. Danach ist dieses
   Passwort ungültig.

   Personendaten sind ${encryptionActive() ? 'verschlüsselt' : 'NICHT verschlüsselt — Masterpasswort fehlt'}.
  ${rahmen}
`);
}

// Direkt ausführbar, falls jemand die Ersteinrichtung erzwingen will.
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  initDb();
  if (db.get('SELECT 1 AS x FROM users LIMIT 1')) {
    console.log('Es gibt bereits Konten. Für einen Neustart data/stellium.db löschen.');
  } else {
    void ensureSeed();
  }
}
