import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { migrate } from './migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export type Row = Record<string, any>;

/** Dünne Hülle um node:sqlite mit den Helfern, die wir wirklich brauchen. */
class Db {
  private readonly raw: DatabaseSync;
  private readonly cache = new Map<string, any>();
  /** Volltextsuche verfügbar? Sonst greift die LIKE-Suche. */
  public fts = false;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  exec(sql: string): void { this.raw.exec(sql); }

  run(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.stmt(sql).run(...params) as any;
  }

  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    const r = this.stmt(sql).get(...params);
    return r === undefined ? undefined : ({ ...(r as any) } as T);
  }

  all<T = Row>(sql: string, ...params: any[]): T[] {
    return (this.stmt(sql).all(...params) as any[]).map((r) => ({ ...r }) as T);
  }

  /** Platzhalterliste für IN (...) */
  static placeholders(n: number): string {
    return Array.from({ length: n }, () => '?').join(',');
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  close(): void { this.raw.close(); }
}

export const db = new Db(config.dbFile);
export const placeholders = Db.placeholders;

export function initDb(): void {
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate();
  setupFts();
}

/**
 * Volltextindex über Original UND alle Übersetzungen — so findet eine
 * deutsche Suchanfrage auch Nachrichten, die auf Englisch geschrieben wurden.
 */
function setupFts(): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
        message_id UNINDEXED,
        channel_id UNINDEXED,
        lang       UNINDEXED,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    db.fts = true;
  } catch (err) {
    db.fts = false;
    console.warn('[db] FTS5 nicht verfügbar, nutze LIKE-Suche:', (err as Error).message);
  }
}

/** Index für eine Nachricht neu aufbauen (Original + Übersetzungen). */
export function reindexMessage(messageId: string): void {
  if (!db.fts) return;
  db.run('DELETE FROM message_fts WHERE message_id = ?', messageId);
  const msg = db.get<{ channel_id: string; text: string; source_lang: string | null; deleted_at: number | null }>(
    'SELECT channel_id, text, source_lang, deleted_at FROM messages WHERE id = ?', messageId,
  );
  if (!msg || msg.deleted_at) return;
  db.run(
    'INSERT INTO message_fts (message_id, channel_id, lang, body) VALUES (?,?,?,?)',
    messageId, msg.channel_id, msg.source_lang ?? 'unknown', msg.text,
  );
  const translations = db.all<{ lang: string; text: string }>(
    'SELECT lang, text FROM message_translations WHERE message_id = ?', messageId,
  );
  for (const tr of translations) {
    db.run(
      'INSERT INTO message_fts (message_id, channel_id, lang, body) VALUES (?,?,?,?)',
      messageId, msg.channel_id, tr.lang, tr.text,
    );
  }
}

export function removeFromIndex(messageId: string): void {
  if (!db.fts) return;
  db.run('DELETE FROM message_fts WHERE message_id = ?', messageId);
}

export function now(): number { return Date.now(); }
