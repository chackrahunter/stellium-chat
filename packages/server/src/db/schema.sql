PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  handle                TEXT NOT NULL UNIQUE,
  email                 TEXT NOT NULL UNIQUE,
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  avatar_color          TEXT NOT NULL DEFAULT '#7c5cff',
  avatar_url            TEXT,
  title                 TEXT,
  timezone              TEXT NOT NULL DEFAULT 'Europe/Berlin',
  language              TEXT NOT NULL DEFAULT 'de',
  auto_translate        INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'offline',
  status_emoji          TEXT,
  status_text           TEXT,
  last_seen_at          INTEGER,
  role                  TEXT NOT NULL DEFAULT 'member',
  notify_on             TEXT NOT NULL DEFAULT 'all',
  quiet_hours_start     INTEGER,
  quiet_hours_end       INTEGER,
  compose_target_preview INTEGER NOT NULL DEFAULT 1,
  theme                 TEXT NOT NULL DEFAULT 'dark',
  density               TEXT NOT NULL DEFAULT 'comfortable',
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  topic            TEXT,
  purpose          TEXT,
  primary_language TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  dm_key           TEXT UNIQUE,
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_kind ON channels(kind, archived);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id          TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at           INTEGER NOT NULL,
  last_read_message_id TEXT,
  muted               INTEGER NOT NULL DEFAULT 0,
  starred             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON channel_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  parent_id     TEXT REFERENCES messages(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  source_lang   TEXT,
  system_kind   TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  edited_at     INTEGER,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_parent  ON messages(parent_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_pinned  ON messages(channel_id, pinned) WHERE pinned = 1;

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_user ON message_mentions(user_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  path       TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- Übersetzungs-Cache: pro Nachricht und Zielsprache genau ein Eintrag.
CREATE TABLE IF NOT EXISTS message_translations (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  lang        TEXT NOT NULL,
  text        TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT,
  confidence  REAL,
  source_hash TEXT NOT NULL,   -- erkennt Edits: Hash des Originaltexts
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, lang)
);

-- Globaler Satz-Cache: gleiche Phrase muss nie zweimal übersetzt werden.
CREATE TABLE IF NOT EXISTS translation_memory (
  key        TEXT PRIMARY KEY,   -- sha1(source_lang|target_lang|text)
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_text TEXT NOT NULL,
  target_text TEXT NOT NULL,
  provider   TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary (
  id             TEXT PRIMARY KEY,
  term           TEXT NOT NULL,
  translations   TEXT,           -- JSON oder NULL = nie übersetzen
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_term ON glossary(lower(term));

CREATE TABLE IF NOT EXISTS saved_messages (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  TEXT,
  text       TEXT NOT NULL,
  send_at    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_messages(send_at);

CREATE TABLE IF NOT EXISTS ai_summaries (
  id         TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  scope      TEXT NOT NULL,      -- "catchup" | "thread"
  ref_id     TEXT,
  language   TEXT NOT NULL,
  payload    TEXT NOT NULL,      -- JSON
  created_at INTEGER NOT NULL
);
