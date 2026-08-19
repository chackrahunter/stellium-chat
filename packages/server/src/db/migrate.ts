import { db } from './index.js';
import { blindIndex, encryptField, encryptionActive } from '../crypto/pii.js';
import { istChiffrat, verschluesseln, verschluesselungAktiv } from '../crypto/nachrichten.js';

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
  { table: 'users', column: 'deleted_at',           definition: 'INTEGER' },
  // Prüfsumme des Inhalts: damit muss dieselbe Datei nur einmal übertragen werden.
  { table: 'attachments', column: 'sha256',        definition: 'TEXT' },
  /* Wie die Datei auf der Platte liegt und wie viel Platz sie dort belegt.
     `size` bleibt die Größe, die der Mensch hochgeladen hat und wiederbekommt —
     `stored_size` ist, was das Kontingent wirklich kostet. */
  { table: 'attachments', column: 'encoding',      definition: 'TEXT' },
  { table: 'attachments', column: 'stored_size',   definition: 'INTEGER' },
  { table: 'files',       column: 'encoding',      definition: 'TEXT' },
  { table: 'files',       column: 'stored_size',   definition: 'INTEGER' },
  // Schublade in der Verwaltung; leer heißt "von selbst einsortieren".
  { table: 'users', column: 'kategorie',            definition: 'TEXT' },
  { table: 'users', column: 'ui_language',          definition: "TEXT" },
  { table: 'users',    column: 'status_expires_at',  definition: 'INTEGER' },
  { table: 'users',    column: 'notification_sound', definition: "TEXT NOT NULL DEFAULT 'ping'" },
  { table: 'users',    column: 'translation_speed',  definition: "TEXT NOT NULL DEFAULT 'balanced'" },
  { table: 'messages', column: 'forwarded_from',     definition: 'TEXT' },
  { table: 'messages', column: 'kind',               definition: "TEXT NOT NULL DEFAULT 'text'" },
  { table: 'channels', column: 'ai_mode',            definition: "TEXT NOT NULL DEFAULT 'off'" },
  { table: 'channels', column: 'read_only',          definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'channel_members', column: 'hidden',      definition: 'INTEGER NOT NULL DEFAULT 0' },
  /* Vertrauliche Kanäle. `schluessel_fassung` bleibt bei 0, solange nichts
     verschlüsselt ist — die erste Fassung ist die 1, und daran erkennt der
     Server, ob überhaupt schon ein Schlüssel ausgehandelt wurde. */
  { table: 'channels', column: 'vertraulich',        definition: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'channels', column: 'schluessel_fassung', definition: 'INTEGER NOT NULL DEFAULT 0' },
  /* Private Dateien in der Ablage. Der Inhalt ist dann schon verschlüsselt,
     wenn er hier ankommt — die Spalte sagt nur, dass man ihn nicht als
     Klartext ausliefern oder in eine Vorschau stecken darf. */
  { table: 'files', column: 'privat',                definition: 'INTEGER NOT NULL DEFAULT 0' },
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

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_sha ON attachments(sha256)');
  } catch (err) {
    console.warn('[db] Index für Anhang-Prüfsummen:', (err as Error).message);
  }

  rebuildUsersTable();
  encryptExistingUsers();
  bestehendeTexteVerschluesseln();
  geloeschteNachtragen();
}

/**
 * Konten, die vor dieser Fassung gelöscht wurden, tragen kein Datum.
 *
 * Erkennbar sind sie am Platzhalternamen: nur so kamen sie zustande. Ohne
 * diesen Nachtrag stünden sie weiter wie gewöhnliche Konten in der Verwaltung —
 * und genau das sah aus, als hätte das Löschen nicht gewirkt.
 */
function geloeschteNachtragen(): void {
  const spalten = db.all<{ name: string }>('PRAGMA table_info(users)');
  if (!spalten.some((c) => c.name === 'deleted_at')) return;

  const offen = db.all<{ id: string }>(
    "SELECT id FROM users WHERE deleted_at IS NULL AND display_name = 'Ehemaliges Mitglied'",
  );
  if (!offen.length) return;
  const jetzt = Date.now();
  db.transaction(() => {
    for (const u of offen) db.run('UPDATE users SET deleted_at = ? WHERE id = ?', jetzt, u.id);
  });
  console.log(`[db] ${offen.length} bereits gelöschte Konten als solche gekennzeichnet.`);
}

/**
 * Nachrichten, die vor der Umstellung im Klartext angelegt wurden,
 * nachträglich verschlüsseln.
 *
 * In Schritten von tausend Zeilen und in einer Transaktion: auf einem
 * Raspberry Pi mit hunderttausend Nachrichten soll der Start nicht am
 * Speicher scheitern. Wer schon verschlüsselt ist, wird übersprungen —
 * der Durchlauf darf jederzeit abbrechen und beim nächsten Start weitergehen.
 */
function bestehendeTexteVerschluesseln(): void {
  if (!verschluesselungAktiv()) return;

  const tabellen: { tabelle: string; schluessel: string }[] = [
    { tabelle: 'messages', schluessel: 'id' },
    { tabelle: 'message_translations', schluessel: 'rowid' },
    { tabelle: 'scheduled_messages', schluessel: 'id' },
    { tabelle: 'drafts', schluessel: 'rowid' },
    { tabelle: 'voice_transcripts', schluessel: 'attachment_id' },
    { tabelle: 'poll_options', schluessel: 'id' },
  ];

  /* Umfragen und der Übersetzungsspeicher tragen ihren Text in anders
     benannten Spalten. Der Zwischenspeicher lag am längsten offen: dort stehen
     Quelle und Übersetzung jeder je übersetzten Nachricht nebeneinander. */
  const sonderfaelle: { tabelle: string; spalte: string; schluessel: string }[] = [
    { tabelle: 'polls', spalte: 'question', schluessel: 'id' },
    { tabelle: 'poll_translations', spalte: 'payload', schluessel: 'rowid' },
    { tabelle: 'translation_memory', spalte: 'source_text', schluessel: 'key' },
    { tabelle: 'translation_memory', spalte: 'target_text', schluessel: 'key' },
  ];

  let gesamt = 0;
  for (const { tabelle, schluessel } of tabellen) {
    if (!db.all(`PRAGMA table_info(${tabelle})`).length) continue;
    for (;;) {
      const offen = db.all<{ k: string | number; text: string }>(
        `SELECT ${schluessel} AS k, text FROM ${tabelle}
         WHERE text IS NOT NULL AND text <> '' AND substr(text, 1, 3) <> 'm1:' LIMIT 1000`,
      ).filter((r) => !istChiffrat(r.text));
      if (!offen.length) break;
      db.transaction(() => {
        for (const r of offen) {
          db.run(`UPDATE ${tabelle} SET text = ? WHERE ${schluessel} = ?`, verschluesseln(r.text), r.k);
        }
      });
      gesamt += offen.length;
    }
  }

  for (const { tabelle, spalte, schluessel } of sonderfaelle) {
    if (!db.all(`PRAGMA table_info(${tabelle})`).length) continue;
    for (;;) {
      const offen = db.all<{ k: string | number; wert: string }>(
        `SELECT ${schluessel} AS k, ${spalte} AS wert FROM ${tabelle}
         WHERE ${spalte} IS NOT NULL AND ${spalte} <> '' AND substr(${spalte}, 1, 3) <> 'm1:' LIMIT 1000`,
      ).filter((r) => !istChiffrat(r.wert));
      if (!offen.length) break;
      db.transaction(() => {
        for (const r of offen) {
          db.run(`UPDATE ${tabelle} SET ${spalte} = ? WHERE ${schluessel} = ?`, verschluesseln(r.wert), r.k);
        }
      });
      gesamt += offen.length;
    }
  }

  /* Die Schlüsselwerte des Zwischenspeichers entstehen jetzt anders (HMAC
     statt sha1). Alte Einträge fänden sich nie wieder und lägen nur herum —
     sie werden verworfen, die Übersetzungen entstehen bei Bedarf neu. */
  try {
    const alt = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM translation_memory WHERE length(key) = 40 AND key GLOB '[0-9a-f]*'",
    )?.n ?? 0;
    if (alt > 0 && verschluesselungAktiv()) {
      const weg = db.run("DELETE FROM translation_memory WHERE length(key) <> 40");
      if (weg.changes) console.log(`[db] ${weg.changes} Einträge im Übersetzungsspeicher verworfen (neuer Schlüsselwert).`);
    }
  } catch { /* Tabelle fehlt */ }

  if (gesamt) {
    console.log(`[db] ${gesamt} gespeicherte Texte nachträglich verschlüsselt.`);
  }
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
          translation_speed      TEXT NOT NULL DEFAULT 'balanced',
          -- Diese beiden fehlten. Die Spaltenliste für das INSERT kommt aus
          -- PRAGMA table_info(users) und enthält sie — der Neuaufbau scheiterte
          -- deshalb, und mit ihm der ganze Serverstart.
          deleted_at             INTEGER,
          kategorie              TEXT
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

  /* Nicht am fehlenden Blind-Index festmachen: den schreibt createAccount
     immer, auch ohne Masterpasswort (dann eben mit dem Ersatzschlüssel).
     Konten aus dieser Zeit blieben sonst für immer im Klartext stehen. Das
     fehlende Chiffrat-Präfix ist das ehrliche Merkmal. */
  const offen = db.all<{ id: string; handle: string; email: string }>(
    "SELECT id, handle, email FROM users WHERE handle NOT LIKE 'v1:%'",
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
