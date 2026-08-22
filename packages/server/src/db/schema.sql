PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  -- Beide Felder liegen verschlüsselt vor. Die Eindeutigkeit prüfen die
  -- Suchwerte handle_bidx und email_bidx (partielle Indizes weiter unten):
  -- mehrere Konten ohne E-Mail müssen möglich sein.
  handle                TEXT NOT NULL,
  email                 TEXT NOT NULL DEFAULT '',
  display_name          TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  avatar_color          TEXT NOT NULL DEFAULT '#7c5cff',
  avatar_url            TEXT,
  title                 TEXT,
  timezone              TEXT NOT NULL DEFAULT 'Europe/Berlin',
  -- Steht die Zeitzone noch auf der Vorgabe, weil sie niemand bestätigt hat?
  -- 'Europe/Berlin' oben ist nur ein Platzhalter — die Leitung, die ein
  -- Konto anlegt (services/users.ts createAccount), kann von hier aus nicht
  -- wissen, wo die Person wirklich sitzt. 1 heißt "noch nicht bestätigt":
  -- der Browser darf die echte Zeitzone beim nächsten Anmelden einmalig
  -- selbst eintragen (state/store.ts zeitzoneNachtragen). Jeder Schreibzugriff
  -- auf timezone — von Hand in Settings.tsx oder durch diesen Nachtrag
  -- selbst — setzt die Spalte auf 0 (ws/gateway.ts, prefs:update): ab dann
  -- rührt kein Client die Zeitzone mehr automatisch an, auch nicht nach
  -- einer Dienstreise.
  timezone_auto         INTEGER NOT NULL DEFAULT 1,
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
  -- Status folgt dem Fenster (vorn = online, weg = abwesend)
  auto_status           INTEGER NOT NULL DEFAULT 1,
  -- Lesebestätigungen abgeschaltet: die eigene Lesemarke (siehe
  -- channel_members.last_read_message_id/last_read_at) rückt unverändert
  -- vor, damit der eigene Ungelesen-Zähler weiter stimmt — nur herausgegeben
  -- wird sie dann an niemanden mehr (siehe readReceiptsBatch in
  -- services/messages.ts). Vorgabe 0: Lesebestätigungen sind an, bis jemand
  -- sie ausdrücklich abschaltet.
  lesebestaetigung_aus  INTEGER NOT NULL DEFAULT 0,
  -- Schublade in der Verwaltung. NULL heißt: automatisch einsortieren.
  kategorie  TEXT,
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
  /* Wann die Lesemarke zuletzt vorwärts sprang — Grundlage für
     Lesebestätigungen (wer hat gelesen, und wann). Bewusst EIN Zeitpunkt für
     den ganzen Sprung, nicht einer je Nachricht: die Marke ist die einzige
     Wahrheit darüber, was gelesen ist (siehe last_read_message_id direkt
     darüber), und eine zweite, feinere Tabelle je Nachricht wüchse mit
     Nachrichten × Personen statt mit Personen × Kanälen. NULL heißt: entweder
     noch nie gelesen, oder vor dieser Fassung gelesen — dann ist der genaue
     Zeitpunkt nicht mehr bekannt, und erfunden wird hier nichts. */
  last_read_at        INTEGER,
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
  -- Prüfsumme des Inhalts. Wird dieselbe Datei noch einmal geschickt, genügt
  -- ein Verweis darauf — übertragen werden muss sie dann nicht mehr.
  sha256     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
-- Der Index auf sha256 entsteht in migrate.ts, nicht hier: diese Datei läuft
-- vor dem Nachrüsten der Spalten, und in einer bestehenden Datenbank gibt es
-- die Spalte an dieser Stelle noch nicht. Der Server startete dann gar nicht.

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
  /* Welcher Eintrag in translation_memory diese Zeile gerade trägt — die
     einzige Quelle, aus der translation_memory.verweise nachgerechnet wird
     (siehe dort). NULL heißt: kein Treffer im Satz-Cache, z.B. weil der Text
     nicht übersetzbar war. */
  tm_key      TEXT,
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
  created_at INTEGER NOT NULL,
  /* Wie viele Zeilen in message_translations gerade auf diesen Schlüssel
     zeigen (message_translations.tm_key) — dieselbe Machart wie
     bloecke.verweise/datei_bloecke: nicht hoch- und runterzählen, sondern aus
     der Wahrheit nachrechnen (services/translation/index.ts,
     tmVerweiseNachrechnen). Erreicht der Wert 0, gehört die Phrase keiner
     bestehenden Nachricht mehr — dann wird die Zeile gelöscht, nicht nur auf
     0 gesetzt: der Zwischenspeicher ist sonst der einzige Ort, an dem der
     Inhalt einer gelöschten Nachricht überlebt. Von Umfragen und
     Kanalangaben erzeugte Zeilen tragen weiterhin 0 (niemand zählt sie mit)
     und werden von diesem Aufräumen nicht angefasst — es räumt ausdrücklich
     nur die Schlüssel auf, die es übergeben bekommt. */
  verweise   INTEGER NOT NULL DEFAULT 0
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

-- ─────────────────────────────────────────────────────────────────
-- Erweiterungen
-- ─────────────────────────────────────────────────────────────────

-- Server-weite Einstellungen, z.B. das gewählte Übersetzungsmodell.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

-- Umfragen hängen an einer Nachricht und werden mit ihr gelöscht.
CREATE TABLE IF NOT EXISTS polls (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  multiple   INTEGER NOT NULL DEFAULT 0,
  anonymous  INTEGER NOT NULL DEFAULT 0,
  closed     INTEGER NOT NULL DEFAULT 0,
  closes_at  INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_message ON polls(message_id);

CREATE TABLE IF NOT EXISTS poll_options (
  id       TEXT PRIMARY KEY,
  poll_id  TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text     TEXT NOT NULL,
  /* Nur für anonyme Umfragen die maßgebliche Zählung (siehe poll_participants
     weiter unten) — bei offenen Umfragen bleibt die Spalte auf 0 und die
     Zählung kommt weiter aus poll_votes, denn dort steht ohnehin schon jede
     Stimme mit Person. Zwei Wahrheiten für dieselbe Zahl wären ein Weg, auf
     dem sie auseinanderlaufen; deshalb gilt je Umfrage nur eine der beiden. */
  votes    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_poll_options ON poll_options(poll_id, position);

/* Stimmen mit Person↔Antwort — für offene Umfragen die einzige Quelle
   (Gesichter unter den Antworten, Stimme ändern/zurückziehen). Für ANONYME
   Umfragen darf hier nach der ersten Stimme nichts mehr stehen: siehe
   poll_participants direkt darunter, das die beiden Fragen "wer hat
   abgestimmt" und "was wurde gewählt" bewusst auseinanderhält. */
CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id    TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id  TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, option_id, user_id)
);

/* Wer bei einer ANONYMEN Umfrage abgestimmt hat — ohne Bezug darauf, was.
   Trägt zwei Aufgaben, die poll_votes für offene Umfragen in einer Tabelle
   erledigt, hier aber auseinandergehören: die Sperre gegen Mehrfachabstimmen
   (diese Zeile) und die Zählung je Antwort (poll_options.votes oben). Damit
   steht nirgends in der Datenbank, wie eine bestimmte Person bei einer
   anonymen Umfrage gestimmt hat — nur, dass sie es hat. Genau das verspricht
   die Oberfläche ("Es wird nur gezählt, nicht wer gestimmt hat"), und genau
   das muss die Datenbank dann auch halten. Bei offenen Umfragen bleibt diese
   Tabelle für die betreffende poll_id leer; sie gilt ausschließlich für
   anonymous = 1. */
CREATE TABLE IF NOT EXISTS poll_participants (
  poll_id    TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id)
);

-- Link-Vorschauen werden pro URL genau einmal geholt und geteilt.
CREATE TABLE IF NOT EXISTS link_previews (
  url_hash    TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  title       TEXT,
  description TEXT,
  image       TEXT,
  site        TEXT,
  ok          INTEGER NOT NULL DEFAULT 1,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_links (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url_hash   TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, url_hash)
);

-- Erinnerungen an einzelne Nachrichten.
CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  note       TEXT,
  remind_at  INTEGER NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at, done);

-- Web-Push-Abonnements: ein Gerät, ein Datensatz. `endpoint` ist eindeutig
-- über alle Konten hinweg (die URL kommt vom Push-Dienst des Browsers und
-- gehört genau einem Gerät), deshalb genügt ON CONFLICT(endpoint) als
-- Aufnahme oder Auffrischung, ohne vorher nachzusehen, ob es den Datensatz
-- schon gibt.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

-- Entwürfe überleben Kanalwechsel und Neustart.
CREATE TABLE IF NOT EXISTS drafts (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  parent_id  TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id, parent_id)
);

-- Transkript einer Sprachnachricht, erzeugt von Groqs Whisper.
CREATE TABLE IF NOT EXISTS voice_transcripts (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  lang          TEXT,
  duration_ms   INTEGER,
  provider      TEXT NOT NULL,
  model         TEXT,
  created_at    INTEGER NOT NULL
);

-- Persönliche Rechte-Abweichungen von der Rollenvorgabe.
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  allowed    INTEGER NOT NULL,
  set_by     TEXT,
  set_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, permission)
);

-- Einmal-Passwörter für neue Konten und Zurücksetzungen.
CREATE TABLE IF NOT EXISTS invites (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invites_user ON invites(user_id, used_at);

-- Kanäle, in denen der KI-Assistent mitredet.
--   off      gar nicht (Standard)
--   mention  nur wenn er erwähnt wird
--   always   auf jede Nachricht
-- Wird per Migration ergänzt, siehe migrate.ts.

-- ─────────────────────────────────────────────────────────────────
-- Aufgaben
-- Status und Priorität werden als Schlüssel gespeichert, nicht als Text —
-- die Oberfläche zeigt sie in der Sprache der jeweiligen Person.
-- ─────────────────────────────────────────────────────────────────

-- Projekte bündeln Aufgaben. Bewusst schlank: Name, Farbe, ein Satz dazu.
CREATE TABLE IF NOT EXISTS projekte (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  beschreibung TEXT,
  farbe        TEXT NOT NULL DEFAULT '#7c5cff',
  archiviert   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projekte_offen ON projekte(archiviert, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending|working|review|finished|blocked
  priority    TEXT NOT NULL DEFAULT 'normal',    -- low|normal|high|urgent
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  channel_id  TEXT REFERENCES channels(id) ON DELETE SET NULL,
  message_id  TEXT,                              -- Herkunft, falls aus einer Nachricht entstanden
  due_at      INTEGER,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  finished_at INTEGER,
  position    INTEGER NOT NULL DEFAULT 0,
  projekt_id  TEXT REFERENCES projekte(id) ON DELETE SET NULL,
  -- Von der KI angelegt und noch von niemandem angesehen: steht unter „Prüfen".
  von_ki      INTEGER NOT NULL DEFAULT 0,
  geprueft_am INTEGER
);
-- Die Indizes auf projekt_id, von_ki und geprueft_am stehen NICHT hier,
-- sondern in migrate.ts: diese Datei läuft VOR der Spalten-Nachrüstung, und
-- auf einer bestehenden Datenbank gibt es die Spalten hier noch nicht.
-- (Genau daran ist Fassung 1.0.17 auf dem Server gescheitert.)
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status, position);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_channel  ON tasks(channel_id);

-- Wer über Änderungen an einer Aufgabe informiert wird.
CREATE TABLE IF NOT EXISTS task_watchers (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

-- Verlauf einer Aufgabe, damit nachvollziehbar bleibt, wer was geändert hat.
CREATE TABLE IF NOT EXISTS task_events (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id),
  kind      TEXT NOT NULL,      -- created|status|assignee|due|priority|title|comment
  von       TEXT,
  nach      TEXT,
  text      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(task_id, created_at);

-- ─────────────────────────────────────────────────────────────────
-- Team-Kalender
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  kind        TEXT NOT NULL DEFAULT 'meeting',   -- meeting|deadline|absence|holiday|reminder
  starts_at   INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL,
  all_day     INTEGER NOT NULL DEFAULT 0,
  location    TEXT,
  channel_id  TEXT REFERENCES channels(id) ON DELETE SET NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  von_ki      INTEGER NOT NULL DEFAULT 0,
  geprueft_am INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_zeit ON events(starts_at, ends_at);

CREATE TABLE IF NOT EXISTS event_attendees (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response TEXT NOT NULL DEFAULT 'pending',      -- pending|yes|no|maybe
  PRIMARY KEY (event_id, user_id)
);

-- ─────────────────────────────────────────────────────────────────
-- Dateiablage (unabhängig von Nachrichten)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  path        TEXT NOT NULL,
  folder      TEXT NOT NULL DEFAULT '',          -- leerer Wert = Wurzel
  channel_id  TEXT REFERENCES channels(id) ON DELETE CASCADE,
  description TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_ort ON files(channel_id, folder, name);

-- Nachrichten, die jemand nur für sich ausgeblendet hat.
-- Für alle löschen ist nur im Zeitfenster möglich; danach bleibt das hier.
CREATE TABLE IF NOT EXISTS hidden_messages (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

-- ─────────────────────────────────────────────────────────────────
-- Ideenboard
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ideas (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'new',       -- new|working|done|rejected
  tag         TEXT NOT NULL DEFAULT '',          -- freies Schlagwort, leer erlaubt
  channel_id  TEXT REFERENCES channels(id) ON DELETE SET NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT REFERENCES users(id),
  decision    TEXT,                              -- Begründung bei fertig/abgelehnt
  von_ki      INTEGER NOT NULL DEFAULT 0,
  geprueft_am INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status, updated_at DESC);

-- Eine Stimme pro Person und Idee: +1 oder -1.
CREATE TABLE IF NOT EXISTS idea_votes (
  idea_id    TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wert       INTEGER NOT NULL,                   -- 1 oder -1
  created_at INTEGER NOT NULL,
  PRIMARY KEY (idea_id, user_id)
);

CREATE TABLE IF NOT EXISTS idea_comments (
  id         TEXT PRIMARY KEY,
  idea_id    TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idea_comments ON idea_comments(idea_id, created_at);

-- ─────────────────────────────────────────────────────────────────
-- Verteilung neuer App-Versionen (eine je Plattform)
-- ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS releases (
  platform     TEXT PRIMARY KEY,                 -- darwin|win32|linux
  version      TEXT NOT NULL,
  notes        TEXT,
  file_name    TEXT NOT NULL,
  path         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  published_by TEXT NOT NULL REFERENCES users(id),
  published_at INTEGER NOT NULL
);

-- Übersetzte Umfragen. Frage und Antwortmöglichkeiten liegen als JSON,
-- damit eine Umfrage in jeder Sprache genau einen Eintrag hat.
CREATE TABLE IF NOT EXISTS poll_translations (
  poll_id     TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  lang        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  provider    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (poll_id, lang)
);

-- Übersetzte Kanalangaben. Name, Thema und Zweck stehen in eigenen Spalten
-- und kamen deshalb nie durch die Nachrichtenübersetzung.
CREATE TABLE IF NOT EXISTS channel_translations (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  lang        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  provider    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, lang)
);

/* Blockspeicher: derselbe Inhalt wird nur einmal abgelegt.
   `groesse` ist die Länge des Blocks, `belegt` was er nach dem Packen auf der
   Platte kostet, `verweise` wie viele Dateien ihn benutzen. */
CREATE TABLE IF NOT EXISTS bloecke (
  summe       TEXT PRIMARY KEY,
  groesse     INTEGER NOT NULL,
  belegt      INTEGER NOT NULL,
  verfahren   TEXT,
  verweise    INTEGER NOT NULL DEFAULT 0,
  erstellt_am INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bloecke_verweise ON bloecke(verweise);

/* Welche Blöcke eine Datei ausmachen, in der richtigen Reihenfolge. */
CREATE TABLE IF NOT EXISTS datei_bloecke (
  datei_id  TEXT NOT NULL,
  art       TEXT NOT NULL,      -- 'file' oder 'attachment'
  nummer    INTEGER NOT NULL,
  summe     TEXT NOT NULL,
  PRIMARY KEY (art, datei_id, nummer)
);
CREATE INDEX IF NOT EXISTS idx_datei_bloecke_summe ON datei_bloecke(summe);

-- ─────────────────────────────────────────────────────────────────
-- Vertrauliche Kanäle: Ende-zu-Ende-Verschlüsselung
--
-- Hier liegt bewusst nichts, womit der Server etwas öffnen könnte. Er verwahrt
-- öffentliche Schlüsselteile und verschlossene Pakete — mehr braucht er nicht,
-- und mehr darf er nicht haben. Wer diese Datei mitsamt Masterpasswort in die
-- Hand bekommt, hat damit trotzdem keinen einzigen Nachrichtentext.
-- ─────────────────────────────────────────────────────────────────

/* Der öffentliche Teil des Schlüsselpaars eines Kontos.
   Absichtlich unverschlüsselt: er ist zum Verteilen da. Der Abdruck steht
   daneben, damit zwei Menschen ihn vorlesen und vergleichen können — sonst
   könnte der Server hier einen eigenen Schlüssel hinterlegen und mitlesen. */
CREATE TABLE IF NOT EXISTS vertraulich_schluessel (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  jwk         TEXT NOT NULL,
  abdruck     TEXT NOT NULL,
  erstellt_am INTEGER NOT NULL
);

/* Der private Teil, verschlossen mit dem Wiederherstellungscode.
   Der Code steht nirgends auf dem Server — ohne ihn ist diese Zeile eine
   Zeichenkette ohne Bedeutung. Sie existiert nur, damit ein neues Gerät nicht
   bei null anfangen muss. */
CREATE TABLE IF NOT EXISTS vertraulich_sicherung (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  paket       TEXT NOT NULL,
  erstellt_am INTEGER NOT NULL
);

/* Welche Fassungen des Kanalschlüssels es gibt. Der Schlüssel selbst steht
   hier nicht — nur die Buchführung darüber, wer wann gewechselt hat. */
CREATE TABLE IF NOT EXISTS kanal_schluessel (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  fassung     INTEGER NOT NULL,
  erzeugt_von TEXT NOT NULL REFERENCES users(id),
  grund       TEXT,
  erstellt_am INTEGER NOT NULL,
  PRIMARY KEY (channel_id, fassung)
);

/* Der Kanalschlüssel, verpackt für genau ein Konto.
   `von_user_id` sagt, wessen öffentlicher Teil beim Aushandeln mitgewirkt hat —
   ohne diese Angabe könnte die empfangende App das gemeinsame Geheimnis nicht
   nachbilden. */
CREATE TABLE IF NOT EXISTS kanal_schluessel_pakete (
  channel_id  TEXT NOT NULL,
  fassung     INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  von_user_id TEXT NOT NULL,
  alg         TEXT NOT NULL,
  iv          TEXT NOT NULL,
  daten       TEXT NOT NULL,
  erstellt_am INTEGER NOT NULL,
  PRIMARY KEY (channel_id, fassung, user_id)
);
CREATE INDEX IF NOT EXISTS idx_kanal_pakete_user ON kanal_schluessel_pakete(user_id);

/* Eine Freigabe nach einem Vorfall.
   `code_abdruck` ist der Abdruck des Codes, nicht der Code: der Server soll
   prüfen können, ob jemand ihn kennt, ohne ihn selbst zu kennen. Und selbst
   wer den Abdruck bricht, kommt nicht an den Inhalt — das Paket ist zusätzlich
   für den privaten Schlüssel der Verwaltung verschlossen. */
CREATE TABLE IF NOT EXISTS vertraulich_freigaben (
  id                 TEXT PRIMARY KEY,
  channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  fassung            INTEGER NOT NULL,
  melder_id          TEXT NOT NULL REFERENCES users(id),
  grund              TEXT NOT NULL,
  code_abdruck       TEXT NOT NULL,
  fehlversuche       INTEGER NOT NULL DEFAULT 0,
  erstellt_am        INTEGER NOT NULL,
  laeuft_ab          INTEGER NOT NULL,
  zurueckgenommen_am INTEGER
);
CREATE INDEX IF NOT EXISTS idx_freigaben_kanal ON vertraulich_freigaben(channel_id, erstellt_am DESC);

/* Der freigegebene Kanalschlüssel, verpackt für ein Mitglied der Verwaltung
   und zusätzlich mit dem Code verschlossen. Zwei Schlösser, zwei Besitzer:
   ohne Code gibt der Server nichts heraus, ohne privaten Schlüssel nützt der
   Code nichts. */
CREATE TABLE IF NOT EXISTS vertraulich_freigabe_pakete (
  freigabe_id TEXT NOT NULL REFERENCES vertraulich_freigaben(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  von_user_id TEXT NOT NULL,
  alg         TEXT NOT NULL,
  iv          TEXT NOT NULL,
  daten       TEXT NOT NULL,
  PRIMARY KEY (freigabe_id, user_id)
);

-- ─────────────────────────────────────────────────────────────────
-- Notizen — Ende-zu-Ende verschlüsselt wie oben, aber keine Kanäle
-- ─────────────────────────────────────────────────────────────────
/* Dieselbe Maschinerie wie bei vertraulichen Kanälen (ECDH-Schlüsselpaar aus
   vertraulich_schluessel, Pakete im selben Format) — eigene Tabellen aber
   trotzdem, aus einem einzigen Grund: eine Notiz ist kein Nachrichtenstrom,
   sondern EIN Schriftstück, das sich ändert. Ein Kanal muss jede alte
   Fassung seines Schlüssels für immer behalten, weil alte Nachrichten unter
   ihr verschlossen bleiben; eine Notiz hat keine alten Nachrichten — beim
   Schlüsselwechsel wird ihr einziger Inhalt einfach neu verschlossen, und
   die alte Fassung ist danach ohne Bedeutung. Diese Tabellen bilden das
   nicht künstlich nach: es gibt hier keine Fassungs-Vergangenheit zu
   verwalten, und deshalb auch keine Tabelle dafür (vergleiche
   kanal_schluessel oben, das genau das für Kanäle führt).

   Hinzufügen und Entfernen sind bewusst nur der besitzenden Person erlaubt
   (siehe services/notizen.ts) — nicht aus Misstrauen, sondern damit beim
   Entfernen immer dieselbe Person handelt, die den Notizschlüssel ohnehin
   in der Hand hat. Ein Kanal braucht für den Schlüsselwechsel eine Absprache
   unter den verbleibenden Mitgliedern (siehe vertraulich:wechsel-noetig),
   weil dort jede berechtigte Person entfernen darf, auch ohne Schlüssel.
   Diese Absprache entfällt hier vollständig. */
CREATE TABLE IF NOT EXISTS notizen (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id),
  /* "e1:<fassung>:<iv>:<daten>" — trägt Titel UND Text als ein JSON, mit
     derselben Nutzlast-Form wie eine Nachricht in einem vertraulichen Kanal
     (siehe E2ENutzlast in shared/vertraulich.ts). Ein eigenes Format für
     Notizen hätte nichts gewonnen und wäre die zweite Chiffre-Sprache im
     Haus gewesen. */
  chiffrat          TEXT NOT NULL,
  /* Inhaltsstand für die Konflikterkennung beim Speichern — zählt bei jedem
     Speichern hoch, unabhängig von schluessel_fassung darunter. Getrennt,
     weil ein Schlüsselwechsel (jemand wird entfernt) den Inhalt nicht
     ändert, nur seine Hülle — würden beide dieselbe Zahl teilen, sähe jeder
     Wechsel wie eine Bearbeitung aus, und "hat sich die Notiz geändert?"
     ließe sich nicht mehr beantworten. */
  version           INTEGER NOT NULL DEFAULT 1,
  schluessel_fassung INTEGER NOT NULL DEFAULT 1,
  geaendert_von     TEXT NOT NULL REFERENCES users(id),
  geaendert_am      INTEGER NOT NULL,
  erstellt_am       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notizen_owner ON notizen(owner_id);

/* Wer zusätzlich zur besitzenden Person lesen und schreiben darf.
   entfernt_am bleibt stehen statt die Zeile zu löschen — das ist die
   Grundlage für Notiz.ehemaligeMitglieder: die Oberfläche sagt beim
   Entfernen ehrlich, dass Gelesenes damit nicht ungelesen wird, und diese
   Spalte ist der Beleg dafür, dass genau das nirgends verschwiegen wird.
   entfernt_grund unterscheidet "eine Person hat entfernt" (dann steht sie in
   notiz_ereignis, siehe unten — hier reicht der Zeitpunkt) von "das Konto
   wurde gelöscht" (services/users.ts, deleteAccount). */
CREATE TABLE IF NOT EXISTS notiz_mitglieder (
  notiz_id        TEXT NOT NULL REFERENCES notizen(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hinzugefuegt_von TEXT NOT NULL REFERENCES users(id),
  hinzugefuegt_am INTEGER NOT NULL,
  entfernt_am     INTEGER,
  entfernt_grund  TEXT,
  PRIMARY KEY (notiz_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notiz_mitglieder_user ON notiz_mitglieder(user_id);

/* Der Notizschlüssel, verpackt für genau ein Konto — dieselbe Form wie
   kanal_schluessel_pakete, nur ohne fassung in der Kennung: hier lebt immer
   nur die AKTUELLE Fassung (siehe Erklärung oben), ein neuer Wechsel ersetzt
   die Zeile statt eine weitere anzulegen. `fassung` steht trotzdem als
   normale Spalte dabei — als Gegenprobe für die App, dass ein gerade
   angekommenes Paket wirklich zur Fassung gehört, die sie erwartet. */
CREATE TABLE IF NOT EXISTS notiz_schluessel_pakete (
  notiz_id    TEXT NOT NULL REFERENCES notizen(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fassung     INTEGER NOT NULL,
  von_user_id TEXT NOT NULL,
  alg         TEXT NOT NULL,
  iv          TEXT NOT NULL,
  daten       TEXT NOT NULL,
  erstellt_am INTEGER NOT NULL,
  PRIMARY KEY (notiz_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_notiz_pakete_user ON notiz_schluessel_pakete(user_id);

-- ─────────────────────────────────────────────────────────────────
-- Vorschläge der KI, bevor sie etwas werden
-- ─────────────────────────────────────────────────────────────────
/* Die Zwischenstufe zwischen "die KI hat etwas erkannt" und "es steht auf dem
   Brett". Ohne sie legt die Erkennung Aufgaben an, die niemand bestellt hat,
   und jemand muss hinterher aufräumen — das ist keine Hilfe, sondern Arbeit.

   `titel` ist Klartext aus einer Nachricht und geht deshalb wie jeder andere
   Nachrichtentext durch crypto/nachrichten.ts. Eine Nachrüstung in
   db/migrate.ts braucht es nicht: die Tabelle ist neu, es gibt keinen
   Altbestand, der offen dastünde.

   `abdruck` ist der HMAC des vereinheitlichten Titels — dieselbe Bauart wie
   die Fingerabdrücke im Volltextindex. Er trägt die Dublettensperre, ohne
   selbst lesbar zu sein.

   Die Sperre steht als UNIQUE-Bedingung in der Datenbank und nicht als Merker
   im Arbeitsspeicher: ein Serverneustart soll nicht dazu führen, dass morgen
   noch einmal auftaucht, was gestern abgelehnt wurde. Genau deshalb bleibt
   eine abgelehnte Zeile stehen, statt gelöscht zu werden — sie IST das
   Gedächtnis. */
CREATE TABLE IF NOT EXISTS vorschlaege (
  id                TEXT PRIMARY KEY,
  art               TEXT NOT NULL,                    -- aufgabe|idee
  zustand           TEXT NOT NULL DEFAULT 'offen',    -- offen|angenommen|abgelehnt|verfallen
  titel             TEXT NOT NULL,                    -- verschlüsselt
  abdruck           TEXT NOT NULL,                    -- HMAC des vereinheitlichten Titels
  channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  quelle_message_id TEXT,                             -- Nachricht, aus der er stammt
  -- Genau eine Person ist zuständig. Ein Vorschlag, den fünf Leute sehen und
  -- keiner annimmt, weil jeder den anderen meint, ist schlechter als keiner.
  fuer_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Wen die KI genannt hat. Getrennt von fuer_user_id, weil "niemand genannt"
  -- eine eigene Auskunft ist: dann liegt er bei dem, der die Nachricht schrieb.
  genannt_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  faellig_am        INTEGER,
  erstellt_am       INTEGER NOT NULL,
  entschieden_am    INTEGER,
  entschieden_von   TEXT REFERENCES users(id) ON DELETE SET NULL,
  ergebnis_id       TEXT,                             -- die angelegte Aufgabe/Idee
  -- Nur bei art='termin': wann es losgeht und wie lange es dauert.
  beginnt_am        INTEGER,
  dauer_minuten     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vorschlaege_dublette ON vorschlaege(channel_id, art, abdruck);
CREATE INDEX IF NOT EXISTS idx_vorschlaege_fuer   ON vorschlaege(fuer_user_id, zustand, erstellt_am DESC);
CREATE INDEX IF NOT EXISTS idx_vorschlaege_kanal  ON vorschlaege(channel_id, zustand);

-- Wie lange jemand an einem Tag online war, in Sekunden.
--
-- Bewusst als Summe je Tag und nicht als Liste von Zeitspannen: eine Liste
-- muss beim Abmelden sauber geschlossen werden, und genau das passiert bei
-- einem Absturz, einem Neustart oder einer abgerissenen Leitung nicht. Dann
-- steht dort eine offene Spanne, die entweder für immer weiterläuft oder
-- verworfen werden muss. Eine Summe, die alle 30 Sekunden um 30 wächst,
-- kann keinen halben Zustand haben.
--
-- Der Tag steht als UTC-Datum. In einem Team über mehrere Zeitzonen gibt es
-- kein "heute", das für alle stimmt; UTC ist wenigstens für alle dasselbe.
CREATE TABLE IF NOT EXISTS praesenz_tage (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  sekunden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_praesenz_tag ON praesenz_tage(tag);

/* ── Post ──────────────────────────────────────────────────
   Was die KI aus einer eingegangenen Mail gemacht hat. Der Text der Mail
   selbst steht NICHT hier: er liegt bei Gmail und wird von dort geholt.
   Eine zweite Kopie wäre eine zweite Stelle, die man schützen muss, und
   sie liefe irgendwann auseinander. Hier steht nur, was Stellium selbst
   entschieden hat. */
CREATE TABLE IF NOT EXISTS mail_sichtung (
  mail_id TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  gesichtet_am INTEGER NOT NULL,
  /* Die Einordnung der KI als JSON — Absenderart, Anliegen, Dringlichkeit.
 Als Text und nicht in Spalten: welche Felder nützlich sind, weiß man
 erst nach einigen Wochen echter Post. */
  einordnung  TEXT,
  /* 'laeuft'   = die KI fragt gerade das Modell, noch keine Antwort da.
 'gemeldet' = niemand muss antworten, die Leitung wurde benachrichtigt.
 'entwurf'  = ein Entwurf wartet auf Freigabe.
 'gesendet' / 'abgelehnt' = entschieden.
 'fehler'   = das Modell hat nicht geantwortet; nachzusichten() nimmt die
              Zeile für einen zweiten Anlauf. */
  zustand TEXT NOT NULL DEFAULT 'gemeldet'
);

CREATE TABLE IF NOT EXISTS mail_entwuerfe (
  id        TEXT PRIMARY KEY,
  mail_id   TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  an        TEXT NOT NULL,
  betreff   TEXT NOT NULL,
  text  TEXT NOT NULL,
  /* Warum die KI meint, dass geantwortet werden sollte — steht neben dem
 Entwurf, damit man nicht raten muss, worauf er antwortet. */
  begruendung   TEXT,
  zustand   TEXT NOT NULL DEFAULT 'offen',
  erstellt_am   INTEGER NOT NULL,
  entschieden_am INTEGER,
  entschieden_von TEXT REFERENCES users(id) ON DELETE SET NULL,
  /* Die Kennung der wirklich gesendeten Mail — der Beweis, dass es hinaus
 ist, und der Weg zurück zum Verlauf. */
  gesendet_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_entwurf_zustand ON mail_entwuerfe(zustand, erstellt_am);
CREATE TABLE IF NOT EXISTS mail_nachrichten (
  id           TEXT PRIMARY KEY,
  /* An welche Adresse sie ging — daraus entstehen die Ordner in der
     Oberflaeche. "support@stellium.club" und "billing@stellium.club" landen
     im selben Postfach, sollen aber getrennt zu lesen sein. */
  fach         TEXT NOT NULL,
  richtung     TEXT NOT NULL,           -- 'ein' oder 'aus'
  /* Verschluesselt wie Chatnachrichten: das ist Schriftwechsel mit Kunden,
     und wer die Datenbankdatei hat, soll ihn nicht lesen koennen. */
  von          TEXT NOT NULL,
  an           TEXT NOT NULL,
  betreff      TEXT NOT NULL,
  text         TEXT NOT NULL,
  html         TEXT,
  /* Die Kennungen, an denen Mailprogramme einen Verlauf aufhaengen. Ohne sie
     waere jede Antwort eine neue Nachricht mit "Re:" davor. */
  message_id   TEXT,
  referenzen   TEXT,
  thread_id    TEXT,
  /* Der Umschlagabsender ist NICHT der sichtbare. "From:" steht im
     Mailprogramm, "MAIL FROM" zaehlt fuer SPF. Gehen sie auseinander, gehoert
     das dem Menschen gezeigt, der eine Antwort freigibt. */
  umschlag_von TEXT,
  antwort_an   TEXT,
  /* Was Cloudflare zu SPF/DKIM/DMARC gemeldet hat. Als Signal, nie als
     Sperre: Post zu verlieren waere schlimmer. Der KI-Entwurf haengt daran. */
  pruefung     TEXT,
  /* Zustellschluessel des Workers — SHA-256 ueber den Rumpf. NICHT die
     Message-ID des Absenders: die ist bei vielen Systemen vorhersagbar, und
     wer sie vorher anmeldet, laesst die echte Mail lautlos als Dublette
     verschwinden. */
  zustell_schluessel TEXT,
  am           INTEGER NOT NULL,
  gelesen      INTEGER NOT NULL DEFAULT 0,
  /* Anhaenge liegen als JSON daneben: Name, Typ, Groesse und der Ort in der
     Ablage. Der Inhalt selbst gehoert nicht in die Datenbank. */
  anhaenge     TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_fach ON mail_nachrichten(fach, am DESC);
CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail_nachrichten(thread_id);
-- Der Index auf zustell_schluessel entsteht in migrate.ts, nicht hier: diese
-- Datei läuft vor dem Nachrüsten der Spalten, und auf einer Datenbank, die
-- mail_nachrichten schon vor diesem Feld kannte, gibt es die Spalte an dieser
-- Stelle noch nicht. Der Server startete dann gar nicht (dieselbe Art Fehler
-- wie beim Index auf sha256 oben).
CREATE TABLE IF NOT EXISTS mail_partner (
  /* Der Suchwert: derselbe Blindindex wie bei Konten. Die Adresse selbst ist
     personenbezogen und liegt daneben verschluesselt — gesucht wird ueber den
     Index, gelesen wird das Chiffrat. */
  adresse_bidx TEXT PRIMARY KEY,
  adresse      TEXT NOT NULL,
  sprache      TEXT NOT NULL,
  /* Wie sicher die Erkennung war, die zu dieser Sprache gefuehrt hat. Eine
     spaetere, unsicherere Messung soll eine sichere nicht umwerfen. */
  sicher       REAL NOT NULL DEFAULT 0,
  seit         INTEGER NOT NULL,
  /* Die Gruppe des Briefpartners (siehe PARTNER_GRUPPEN in
     packages/shared/src/types.ts) -- dieselbe Art Merkmal wie sprache oben,
     deshalb dieselbe Zeile und keine eigene Tabelle. NULL heisst: noch nicht
     eingeordnet.
     gruppe_von_ki: steht "gruppe" so da, wie die KI sie vorgeschlagen hat,
     und hat noch kein Mensch zugestimmt oder umentschieden? Nur eine Anzeige
     ("Vorschlag" statt "Tatsache"), keine Sperre.
     gruppe_vorschlag_am: die EINE Gelegenheit, die die KI je Adresse hat,
     einen Vorschlag zu machen -- gesetzt, sobald sie einmal geurteilt hat,
     und danach fuer immer gesetzt. post-partnergruppen.ts fragt nur dann
     erneut, wenn diese Spalte NULL ist; ein Mensch, der von Hand eine Gruppe
     setzt, fuellt sie ebenfalls (siehe dort), damit die KI eine von Hand
     getroffene Wahl nie wieder anruehrt -- auch dann nicht, wenn die KI
     selbst nie gefragt wurde.
     gruppe_begruendung: ein Satz der KI, warum sie so entschieden hat.
     Bleibt stehen, wenn ein Mensch genau diesen Wert bestaetigt (er erklaert
     dann weiterhin, warum die Zeile so steht) -- wird NULL, sobald ein
     Mensch eine ANDERE Gruppe waehlt, denn dann erklaert der Satz eine
     Entscheidung, die nicht mehr gilt. */
  gruppe               TEXT,
  gruppe_von_ki        INTEGER NOT NULL DEFAULT 0,
  gruppe_vorschlag_am  INTEGER,
  gruppe_begruendung   TEXT
);
-- Der Index auf gruppe (fuer die Filterung nach Gruppe) entsteht in
-- migrate.ts, nicht hier -- aus demselben Grund wie bei zustell_schluessel
-- oben: diese Spalte ist auf einer bestehenden Datenbank erst nachgeruestet.

/* ── Verkaufsstatistik ─────────────────────────────────────────
 * Zwei Entwurfsentscheidungen stecken in diesen Tabellen (siehe Auftrag
 * "Verkaufsstatistik ausbauen"):
 *
 * 1. ROH SPEICHERN, SUMMEN RECHNEN — NICHT SUMMEN SPEICHERN. Eine
 *    Erstattung kommt oft Wochen nach dem Verkauf. Wer im März 40 Verkäufe
 *    summiert und wegschreibt, hat dort für immer 40 stehen, auch wenn zwei
 *    zurückgingen. Deshalb liegt hier JEDER Verkauf und JEDES Abonnement
 *    einzeln, mit der Kennung, die Gumroad selbst dafür vergibt — ein
 *    erneuter Abruf AKTUALISIERT dieselbe Zeile (ON CONFLICT), statt sie ein
 *    zweites Mal zu zählen. Jede Kennzahl (Umsatz je Monat, Abonnenten nach
 *    Status, Erstattungsquote) wird bei Bedarf frisch aus diesen Rohdaten
 *    gerechnet, siehe services/gumroad.ts.
 *
 * 2. KEINE KUNDENDATEN. Name, E-Mail, Adresse eines Käufers stehen absichtlich
 *    NICHT hier — nur Beträge, Status und Zeitstempel, alles, was eine
 *    Kennzahl braucht, nichts, was eine Person identifiziert. Dieselbe
 *    Zurückhaltung wie in gumroadDiagnose() (server-setup/stellium-konsole.mjs):
 *    "kein Kundendatensatz verlässt diese Funktion". Auszahlungen sind davon
 *    ausgenommen (siehe verkauf_gumroad_auszahlungen unten) — das ist Gumroads
 *    Überweisung an den Verkäufer selbst, keine Käuferdaten.
 *
 * Beide Tabellen unten sind kontoweit (ALLE Produkte des Gumroad-Kontos),
 * nicht auf ein einzelnes Produkt beschränkt — `produkt_id` steht bei jeder
 * Zeile dabei, falls eine künftige Ansicht nach Produkt aufschlüsseln will. */
CREATE TABLE IF NOT EXISTS verkauf_gumroad_verkaeufe (
  id                  TEXT PRIMARY KEY,     -- Gumroads eigene Verkaufs-ID
  produkt_id          TEXT,
  subscription_id     TEXT,                 -- NULL = einmaliger Kauf
  preis_cent          INTEGER NOT NULL DEFAULT 0,
  gebuehr_cent        INTEGER NOT NULL DEFAULT 0,
  waehrung            TEXT NOT NULL DEFAULT 'USD',
  /* Gumroad selbst ist hier uneinheitlich zwischen seinen Endpunkten —
     `recurrence` UND `subscription_duration` kommen beide vor. Siehe
     services/gumroad.ts, laufzeitVon(), für die doppelte Prüfung (derselbe
     Grund wie bei chargedback/chargebacked unten). NULL = einmaliger Kauf. */
  laufzeit            TEXT,
  erstellt_am         INTEGER,
  erstattet           INTEGER NOT NULL DEFAULT 0,     -- refunded (vollständig)
  teilerstattet       INTEGER NOT NULL DEFAULT 0,     -- partially_refunded
  erstattbar_cent     INTEGER,                        -- amount_refundable_in_currency, roh übernommen
  angefochten         INTEGER NOT NULL DEFAULT 0,      -- disputed
  anfechtung_gewonnen INTEGER,                         -- dispute_won, NULL = keine Anfechtung/unbekannt
  /* Zwei Schreibweisen bei Gumroad: `/v2/sales` liefert `chargedback`,
     `/v2/licenses/*` (eine andere Ressource) `chargebacked`. Diese Spalte
     ist das Ergebnis NACH der Prüfung beider Schreibweisen — sie hält nicht
     fest, welche Schreibweise ankam, nur DASS eine Rückbuchung vorliegt. */
  rueckgebucht        INTEGER NOT NULL DEFAULT 0,
  /* Der EZB-Referenzkurs zum Tag von erstellt_am — NICHT der heutige. Einmal
     aufgelöst und dann stehengelassen (siehe services/gumroad.ts): ein
     historisches Datum liefert immer denselben Kurs, ein erneuter Abruf
     überschreibt ihn nur, solange er noch fehlt (COALESCE beim Upsert). So
     bleibt der Umsatz eines alten Verkaufs stabil, auch wenn sich der
     heutige Kurs ändert. */
  kurs_eur_je_usd     REAL,
  kurs_datum          TEXT,
  zuletzt_gesehen_am  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verkauf_gr_verkaeufe_erstellt ON verkauf_gumroad_verkaeufe(erstellt_am);
CREATE INDEX IF NOT EXISTS idx_verkauf_gr_verkaeufe_abo ON verkauf_gumroad_verkaeufe(subscription_id);

CREATE TABLE IF NOT EXISTS verkauf_gumroad_abonnenten (
  id                 TEXT PRIMARY KEY,      -- Gumroads eigene Abonnenten-ID
  produkt_id         TEXT,
  /* alive, pending_cancellation, pending_failure, failed_payment, cancelled */
  status             TEXT NOT NULL,
  laufzeit           TEXT,                  -- recurrence
  erstellt_am        INTEGER,
  probe_bis          INTEGER,               -- free_trial_ends_at, NULL = keine Probezeit
  gekuendigt_am      INTEGER,
  beendet_am         INTEGER,
  fehlgeschlagen_am  INTEGER,
  zuletzt_gesehen_am INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verkauf_gr_abo_status ON verkauf_gumroad_abonnenten(status);

/* Auszahlungen sind Gumroads Überweisung AN den Verkäufer — keine
   Käuferdaten, deshalb hier (anders als oben) auch das vollständige Feld
   `rohdaten`. Grund: `zahlungsart` ist als Kennzahl gewünscht (siehe
   Auftrag), aber ohne einen echten Zugang zum Prüfen des genauen Feldnamens
   nicht sicher zu benennen — gumroadDiagnose() bestätigt bislang nur
   `amount`, `status`, `currency`. Die Rohantwort bleibt darum daneben
   liegen, statt einen falschen Feldnamen zu erfinden; siehe Bericht am
   Auftragsende. `betrag` ist NICHT bestätigt in Cent oder Dezimalwährung —
   roh übernommen, nicht durch 100 geteilt. */
CREATE TABLE IF NOT EXISTS verkauf_gumroad_auszahlungen (
  id                 TEXT PRIMARY KEY,
  betrag             REAL,
  waehrung           TEXT,
  status             TEXT,
  zahlungsart        TEXT,
  rohdaten           TEXT,
  zuletzt_gesehen_am INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verkauf_gr_auszahl_status ON verkauf_gumroad_auszahlungen(status);

/* Momentaufnahmen — für Anbieter OHNE eigene Historie.
 *
 * Patreon kennt kein "ehemalig seit wann": die Kennzahlen-Schnittstelle
 * (services/patreon.ts, patreonKennzahlen()) liefert nur den STAND JETZT.
 * Ohne eigene, regelmäßige Momentaufnahme gäbe es für Patreon nie einen
 * Verlauf und nie eine Abgangszahl — beides lässt sich aus der Schnittstelle
 * selbst nicht nachträglich rekonstruieren. Gumroad braucht diese Tabelle
 * NICHT: dort steht die Historie schon roh in den beiden Tabellen oben
 * (erstellt_am, gekuendigt_am, beendet_am je Abonnement), ein Verlauf lässt
 * sich daraus jederzeit neu rechnen.
 *
 * `tag` (UTC) statt eines Zeitstempels als Teil des Schlüssels — dieselbe
 * Bauart wie praesenz_tage oben: höchstens eine Zeile je Anbieter und Tag,
 * ein erneuter Lauf am selben Tag aktualisiert sie nur. `anbieter` bleibt
 * ein Textfeld statt einer festen Spaltenliste, falls einmal ein weiterer
 * Anbieter ohne eigene Historie dazukommt. */
CREATE TABLE IF NOT EXISTS verkauf_momentaufnahmen (
  anbieter          TEXT NOT NULL,
  tag               TEXT NOT NULL,
  erfasst_am        INTEGER NOT NULL,
  aktive            INTEGER NOT NULL DEFAULT 0,
  deklination       INTEGER NOT NULL DEFAULT 0,
  ehemalig          INTEGER NOT NULL DEFAULT 0,
  follower          INTEGER NOT NULL DEFAULT 0,
  einnahmen_cent    INTEGER NOT NULL DEFAULT 0,
  waehrung          TEXT,
  neu_diesen_monat  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (anbieter, tag)
);

/* Historische Wechselkurse, dauerhaft zwischengespeichert — ein Kurs zu
   einem vergangenen Datum ändert sich nie wieder, also lohnt sich das
   Nachschlagen kein zweites Mal. Dieselbe Quelle wie überall im Haus
   (api.frankfurter.dev, EZB-Referenzkurs), nur mit einem festen statt dem
   "latest"-Pfad — siehe services/wechselkurse.ts. `datum` ist das
   ANGEFRAGTE Datum (Schlüssel für den Zwischenspeicher), `quelldatum` das
   Datum, das die Quelle tatsächlich geliefert hat (an Wochenenden und
   Feiertagen der letzte Werktag davor). */
CREATE TABLE IF NOT EXISTS wechselkurse (
  datum      TEXT NOT NULL,
  basis      TEXT NOT NULL,
  ziel       TEXT NOT NULL,
  kurs       REAL NOT NULL,
  quelldatum TEXT,
  geholt_am  INTEGER NOT NULL,
  PRIMARY KEY (datum, basis, ziel)
);
