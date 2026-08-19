/**
 * Startet der Server auf einer alten Datenbank?
 *
 * Jede neue Spalte, jeder neue Index kann eine bestehende Installation beim
 * Start zerlegen — und zwar genau dort, wo niemand zusieht: auf dem Pi im
 * Serverschrank, mitten in einem automatischen Update. Deshalb wird hier eine
 * Datenbank im alten Zustand nachgebaut und der Server darauf losgelassen.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const arbeit = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-alt-'));

/** Eine Datenbank, wie sie vor den heutigen Änderungen aussah. */
function alteDatenbank(datei) {
  const d = new DatabaseSync(datei);
  d.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, handle TEXT NOT NULL, email TEXT NOT NULL,
      display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT '#7c5cff', avatar_url TEXT, title TEXT,
      timezone TEXT NOT NULL DEFAULT 'Europe/Berlin', language TEXT NOT NULL DEFAULT 'de',
      auto_translate INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'offline',
      status_emoji TEXT, status_text TEXT, last_seen_at INTEGER,
      role TEXT NOT NULL DEFAULT 'member', notify_on TEXT NOT NULL DEFAULT 'all',
      quiet_hours_start INTEGER, quiet_hours_end INTEGER,
      compose_target_preview INTEGER NOT NULL DEFAULT 1,
      theme TEXT NOT NULL DEFAULT 'dark', density TEXT NOT NULL DEFAULT 'comfortable',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE channels (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, topic TEXT,
      purpose TEXT, primary_language TEXT, created_by TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, dm_key TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
      parent_id TEXT, text TEXT NOT NULL, source_lang TEXT, system_kind TEXT,
      pinned INTEGER NOT NULL DEFAULT 0, edited_at INTEGER, deleted_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, uploader_id TEXT NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
      path TEXT NOT NULL, width INTEGER, height INTEGER, created_at INTEGER NOT NULL
    );
  `);
  const jetzt = Date.now();
  d.prepare(`INSERT INTO users (id, handle, email, display_name, password_hash, created_at, role)
             VALUES ('u_alt','alt','alt@example.test','Alte Person','x',?,'owner')`).run(jetzt);
  d.prepare("INSERT INTO channels (id, kind, name, created_by, created_at) VALUES ('ch_alt','public','allgemein','u_alt',?)").run(jetzt);
  for (let i = 0; i < 25; i++) {
    d.prepare(`INSERT INTO messages (id, channel_id, user_id, text, created_at)
               VALUES (?,?,?,?,?)`).run(`m_alt${i}`, 'ch_alt', 'u_alt', `Alte Nachricht ${i} im Klartext`, jetzt + i);
  }
  d.prepare(`INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, created_at)
             VALUES ('at_alt','m_alt0','u_alt','alt.txt','text/plain',5,'/dev/null',?)`).run(jetzt);
  d.close();
}

const datenOrdner = path.join(arbeit, 'daten');
fs.mkdirSync(datenOrdner, { recursive: true });
alteDatenbank(path.join(datenOrdner, 'stellium.db'));

console.log('  Alte Datenbank gebaut: 25 Nachrichten im Klartext, keine neuen Spalten');

const port = 8791;
const kind = spawn('node', ['dist/index.js'], {
  cwd: 'packages/server',
  env: { ...process.env, DATA_DIR: datenOrdner, PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let ausgabe = '';
kind.stdout.on('data', (d) => { ausgabe += d; });
kind.stderr.on('data', (d) => { ausgabe += d; });

const warten = async (ms) => { const bis = Date.now() + ms; while (Date.now() < bis) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/releases`); if (r.status) return true; } catch {}
  await new Promise((f) => setTimeout(f, 300));
} return false; };

const lebt = await warten(25000);

await pruefe('Der Server startet auf einer alten Datenbank', async () => {
  muss(lebt, `nicht erreichbar. Ausgabe:\n${ausgabe.slice(-600)}`);
});

await pruefe('Die Nachrüstungen sind gelaufen', async () => {
  const d = new DatabaseSync(path.join(datenOrdner, 'stellium.db'), { readOnly: true });
  const spalten = (t) => d.prepare(`PRAGMA table_info(${t})`).all().map((s) => s.name);
  const u = spalten('users');
  const a = spalten('attachments');
  d.close();
  for (const s of ['handle_bidx', 'deleted_at', 'ui_language', 'must_change_password']) {
    muss(u.includes(s), `users.${s} fehlt`);
  }
  muss(a.includes('sha256'), 'attachments.sha256 fehlt');
  return `${u.length} Spalten in users, ${a.length} in attachments`;
});

await pruefe('Alte Nachrichten wurden verschlüsselt', async () => {
  const d = new DatabaseSync(path.join(datenOrdner, 'stellium.db'), { readOnly: true });
  const klar = d.prepare("SELECT COUNT(*) AS n FROM messages WHERE text <> '' AND substr(text,1,3) <> 'm1:'").get().n;
  const gesamt = d.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  d.close();
  muss(klar === 0, `${klar} von ${gesamt} noch im Klartext`);
  return `${gesamt} umgestellt`;
});

await pruefe('Ein zweiter Start läuft ebenfalls durch', async () => {
  kind.kill();
  await new Promise((f) => setTimeout(f, 1500));
  const zweiter = spawn('node', ['dist/index.js'], {
    cwd: 'packages/server',
    env: { ...process.env, DATA_DIR: datenOrdner, PORT: String(port + 1), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let zweiteAusgabe = '';
  zweiter.stdout.on('data', (d) => { zweiteAusgabe += d; });
  zweiter.stderr.on('data', (d) => { zweiteAusgabe += d; });
  const bis = Date.now() + 25000;
  let da = false;
  while (Date.now() < bis && !da) {
    try { const r = await fetch(`http://127.0.0.1:${port + 1}/api/releases`); da = Boolean(r.status); } catch {}
    if (!da) await new Promise((f) => setTimeout(f, 300));
  }
  zweiter.kill();
  muss(da, `zweiter Start scheiterte:\n${zweiteAusgabe.slice(-500)}`);
});

try { kind.kill(); } catch {}
fs.rmSync(arbeit, { recursive: true, force: true });

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
