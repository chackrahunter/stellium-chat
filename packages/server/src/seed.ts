import os from 'node:os';
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

/**
 * Name des ersten Kontos. Reihenfolge: OWNER_HANDLE/OWNER_NAME aus der
 * Umgebung, sonst der Systembenutzer. "admin" und "root" werden bewusst
 * vermieden — genau diese Namen probieren automatisierte Anmeldeversuche
 * zuerst durch.
 */
function ownerVorgabe(): { handle: string; name: string } {
  const ausUmgebung = config.owner.handle.trim().toLowerCase();
  if (ausUmgebung) {
    return {
      handle: ausUmgebung,
      name: config.owner.name.trim() || grossschreiben(ausUmgebung),
    };
  }

  const system = (() => {
    try { return os.userInfo().username; } catch { return ''; }
  })();
  const bereinigt = system
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 32);

  const unbrauchbar = !bereinigt || ['admin', 'root', 'administrator', 'user', 'node'].includes(bereinigt);
  const handle = unbrauchbar ? 'inhaber' : bereinigt;
  return { handle, name: config.owner.name.trim() || grossschreiben(handle) };
}

function grossschreiben(wert: string): string {
  return wert
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((teil) => teil.charAt(0).toUpperCase() + teil.slice(1))
    .join(' ');
}

export async function ensureSeed(): Promise<void> {
  if (db.get('SELECT 1 AS x FROM users LIMIT 1')) return;

  const { handle, name } = ownerVorgabe();
  const konto = createAccount({
    displayName: name,
    handle,
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
