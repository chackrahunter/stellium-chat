import { db } from './index.js';
import { blindIndex, encryptField, encryptionActive } from '../crypto/pii.js';

/**
 * Spalten nachrüsten, die in älteren Datenbanken fehlen.
 * Neue Tabellen erledigt schema.sql mit CREATE TABLE IF NOT EXISTS —
 * für Spalten gibt es kein "IF NOT EXISTS", deshalb dieser Weg.
 */
const COLUMNS: { table: string; column: string; definition: string }[] = [
  // Verschlüsselte Personendaten: Suchwert getrennt vom Chiffrat
  { table: 'users', column: 'handle_bidx',          definition: 'TEXT' },
  { table: 'users', column: 'email_bidx',           definition: 'TEXT' },
  // Kontoverwaltung
  { table: 'users', column: 'must_change_password', definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'must_complete_profile',definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'disabled',             definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'users', column: 'created_by',           definition: 'TEXT' },
  { table: 'users', column: 'password_set_at',      definition: 'INTEGER' },
  { table: 'users', column: 'ui_language',          definition: "TEXT" },
  { table: 'users',    column: 'status_expires_at',  definition: 'INTEGER' },
  { table: 'users',    column: 'notification_sound', definition: "TEXT NOT NULL DEFAULT 'ping'" },
  { table: 'users',    column: 'translation_speed',  definition: "TEXT NOT NULL DEFAULT 'balanced'" },
  { table: 'messages', column: 'forwarded_from',     definition: 'TEXT' },
  { table: 'messages', column: 'kind',               definition: "TEXT NOT NULL DEFAULT 'text'" },
  { table: 'channels', column: 'ai_mode',            definition: "TEXT NOT NULL DEFAULT 'off'" },
  { table: 'channels', column: 'read_only',          definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'channel_members', column: 'hidden',      definition: 'INTEGER NOT NULL DEFAULT 0' },
];

export function migrate(): void {
  for (const { table, column, definition } of COLUMNS) {
    const existing = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!existing.length) continue;                       // Tabelle gibt es noch nicht
    if (existing.some((c) => c.name === column)) continue; // Spalte ist schon da
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] Spalte ${table}.${column} ergänzt`);
  }

  // Die alten UNIQUE-Bedingungen hingen am Klartext. Nach der Verschlüsselung
  // muss die Eindeutigkeit über die Suchwerte laufen.
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_bidx ON users(handle_bidx) WHERE handle_bidx IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_bidx  ON users(email_bidx)  WHERE email_bidx  IS NOT NULL');
  } catch (err) {
    console.warn('[db] Eindeutigkeitsindex für Personendaten:', (err as Error).message);
  }

  rebuildUsersTable();
  encryptExistingUsers();
}

/**
 * Die ursprüngliche users-Tabelle hatte UNIQUE auf handle und email im
 * Klartext. Seit beide verschlüsselt sind, gehört die Eindeutigkeit an die
 * Suchwerte (handle_bidx, email_bidx) — als partieller Index, der mehrere
 * NULL-Werte erlaubt.
 *
 * Die alte Bedingung ist nicht nur überflüssig, sie ist falsch: Konten ohne
 * E-Mail speichern alle denselben leeren Wert und kollidieren miteinander.
 * Man konnte also genau ein Konto ohne E-Mail anlegen.
 *
 * SQLite kann Bedingungen nicht einzeln entfernen, deshalb wird die Tabelle
 * einmalig neu aufgebaut.
 */
function rebuildUsersTable(): void {
  const definition = db.get<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  )?.sql;
  if (!definition || !/UNIQUE/i.test(definition)) return;   // schon erledigt

  const spalten = db.all<{ name: string }>('PRAGMA table_info(users)').map((c) => c.name);
  const liste = spalten.join(', ');

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_neu (
          id                     TEXT PRIMARY KEY,
          handle                 TEXT NOT NULL,
          email                  TEXT NOT NULL DEFAULT '',
          display_name           TEXT NOT NULL,
          password_hash          TEXT NOT NULL,
          avatar_color           TEXT NOT NULL DEFAULT '#7c5cff',
          avatar_url             TEXT,
          title                  TEXT,
          timezone               TEXT NOT NULL DEFAULT 'Europe/Berlin',
          language               TEXT NOT NULL DEFAULT 'de',
          auto_translate         INTEGER NOT NULL DEFAULT 1,
          status                 TEXT NOT NULL DEFAULT 'offline',
          status_emoji           TEXT,
          status_text            TEXT,
          last_seen_at           INTEGER,
          role                   TEXT NOT NULL DEFAULT 'member',
          notify_on              TEXT NOT NULL DEFAULT 'all',
          quiet_hours_start      INTEGER,
          quiet_hours_end        INTEGER,
          compose_target_preview INTEGER NOT NULL DEFAULT 1,
          theme                  TEXT NOT NULL DEFAULT 'dark',
          density                TEXT NOT NULL DEFAULT 'comfortable',
          created_at             INTEGER NOT NULL,
          handle_bidx            TEXT,
          email_bidx             TEXT,
          must_change_password   INTEGER NOT NULL DEFAULT 0,
          must_complete_profile  INTEGER NOT NULL DEFAULT 0,
          disabled               INTEGER NOT NULL DEFAULT 0,
          created_by             TEXT,
          password_set_at        INTEGER,
          ui_language            TEXT,
          status_expires_at      INTEGER,
          notification_sound     TEXT NOT NULL DEFAULT 'ping',
          translation_speed      TEXT NOT NULL DEFAULT 'balanced'
        )
      `);
      db.exec(`INSERT INTO users_neu (${liste}) SELECT ${liste} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_neu RENAME TO users');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_bidx ON users(handle_bidx) WHERE handle_bidx IS NOT NULL');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_bidx  ON users(email_bidx)  WHERE email_bidx  IS NOT NULL');
    });
    console.log('[db] users-Tabelle neu aufgebaut: Eindeutigkeit liegt jetzt auf den Suchwerten.');
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Bestehende Konten nachträglich verschlüsseln.
 * Läuft nur, solange noch Klartext dasteht — danach passiert nichts mehr.
 */
function encryptExistingUsers(): void {
  const spalten = db.all<{ name: string }>('PRAGMA table_info(users)');
  if (!spalten.some((c) => c.name === 'handle_bidx')) return;
  if (!encryptionActive()) return;   // ohne Masterpasswort bleibt alles wie es ist

  const offen = db.all<{ id: string; handle: string; email: string }>(
    'SELECT id, handle, email FROM users WHERE handle_bidx IS NULL',
  );
  if (!offen.length) return;

  db.transaction(() => {
    for (const u of offen) {
      db.run(
        'UPDATE users SET handle = ?, handle_bidx = ?, email = ?, email_bidx = ? WHERE id = ?',
        encryptField(u.handle), blindIndex(u.handle),
        encryptField(u.email), blindIndex(u.email),
        u.id,
      );
    }
  });
  console.log(`[db] ${offen.length} Konten verschlüsselt (E-Mail und Benutzername).`);
}
