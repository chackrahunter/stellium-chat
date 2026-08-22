import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { migrate } from './migrate.js';
import { istE2EChiffrat } from '@stellium/shared';
import { entschluesseln, suchWorte } from '../crypto/nachrichten.js';
import { indexKennung, schluesselProbePruefen } from './schluesselprobe.js';

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
  /* Vor jeder Nachrüstung: passt das Masterpasswort noch zu den Daten?
     Steht die Prüfung dahinter, hat migrate() bei einem Schlüsselwechsel
     schon den Übersetzungsspeicher geleert. */
  schluesselProbePruefen();
  migrate();
  setupFts();
  indexAufFingerabdruckeUmstellen();
}

/**
 * Kennung des Indexformats — ändert sie sich, wird neu aufgebaut.
 *
 * Die Kennung hängt bewusst am Indexschlüssel: ohne Masterpasswort entstehen
 * die Abdrücke mit einem festen Ersatzschlüssel. Kommt später ein Masterpasswort
 * dazu (oder fällt es weg), passen die alten Abdrücke nicht mehr — der Index
 * müsste neu gebaut werden. Eine feste Konstante hätte das verschwiegen, und
 * die Suche hätte den Altbestand nie wieder gefunden.
 */
const INDEX_FORMAT = indexKennung();

/**
 * Bis zur Verschlüsselung standen die Wörter selbst im Volltextindex. Sie
 * müssen dort verschwinden, sonst wäre der Inhalt jeder Nachricht weiter im
 * Klartext lesbar — nur eben in einer anderen Tabelle.
 */
function indexAufFingerabdruckeUmstellen(): void {
  if (!db.fts) return;
  const stand = db.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'fts_format'",
  )?.value;
  if (stand === INDEX_FORMAT) return;

  const ids = db.all<{ id: string }>(
    'SELECT id FROM messages WHERE deleted_at IS NULL',
  ).map((r) => r.id);

  db.run('DELETE FROM message_fts');
  for (const id of ids) reindexMessage(id);

  db.run(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('fts_format', ?, NULL, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    INDEX_FORMAT, Date.now(),
  );
  if (ids.length) console.log(`[db] Volltextindex neu aufgebaut (${ids.length} Nachrichten).`);
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

/**
 * SQL-Bedingung: welche kanalgebundenen Zeilen ein Konto sehen darf.
 *
 * Aufgaben, Termine und Ideen können an einem Kanal hängen. Wer den Kanal
 * nicht sehen darf, hat auch mit dem nichts zu tun, was daraus entstanden ist:
 * ein Aufgabentitel aus einem privaten Kanal ist genauso wenig öffentlich wie
 * die Nachricht, aus der er stammt — und die Aufgabenerkennung macht aus
 * Nachrichten Titel.
 *
 * Dieselbe Regel wie überall sonst: offene Kanäle sieht jeder, alles andere
 * nur Mitglieder. Was an gar keinem Kanal hängt, geht das ganze Team an und
 * bleibt für alle sichtbar.
 *
 * Die Bedingung steht hier und nicht dreimal in den Diensten. Drei Kopien
 * heißen drei Stellen, an denen man sie beim nächsten Umbau vergessen kann —
 * und genau daran hing dieser Fund: die Sichtbarkeit war im Kommentar
 * beschrieben und nirgends im Code.
 *
 * Der Aufrufer setzt an dieser Stelle genau einen Parameter ein: die Kennung
 * des fragenden Kontos.
 *
 * Eine Folge, die man kennen muss: wird ein Kanal gelöscht, setzen die
 * Fremdschlüssel channel_id auf NULL (ON DELETE SET NULL) — was aus ihm
 * stammt, ist danach für alle sichtbar. Das ist bewusst so gelassen: die
 * Alternative wäre, Aufgaben und Ideen mit dem Kanal zu vernichten, und das
 * verliert Arbeit. Wer einen privaten Kanal löscht, sollte vorher wissen, dass
 * seine Aufgaben bleiben und dann dem Team gehören.
 */
export function nurSichtbareKanaele(spalte = 'channel_id'): string {
  return `(${spalte} IS NULL OR ${spalte} IN (
            SELECT c.id FROM channels c
            LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
             WHERE c.kind = 'public' OR m.user_id IS NOT NULL))`;
}

/** Index für eine Nachricht neu aufbauen (Original + Übersetzungen). */
export function reindexMessage(messageId: string): void {
  if (!db.fts) return;
  db.run('DELETE FROM message_fts WHERE message_id = ?', messageId);
  const msg = db.get<{ channel_id: string; text: string; source_lang: string | null; deleted_at: number | null }>(
    'SELECT channel_id, text, source_lang, deleted_at FROM messages WHERE id = ?', messageId,
  );
  if (!msg || msg.deleted_at) return;
  /* Aus vertraulichen Kanälen kommt gar nichts in den Index.
     Es wäre technisch harmlos — im Index landeten Fingerabdrücke über
     Base64-Zeichenfolgen, aus denen sich nichts ablesen lässt. Aber gefunden
     würde damit auch nichts, und ein Index, der nur wächst und nie trifft,
     ist schlimmer als keiner: er sähe aus, als arbeitete die Suche. */
  const text = entschluesseln(msg.text);
  if (istE2EChiffrat(text)) return;
  /* Im Index stehen nicht die Wörter selbst, sondern ihre Fingerabdrücke.
     Sonst läge der Inhalt jeder Nachricht doch wieder im Klartext in der
     Datenbank — nur eben in einer anderen Tabelle. */
  db.run(
    'INSERT INTO message_fts (message_id, channel_id, lang, body) VALUES (?,?,?,?)',
    messageId, msg.channel_id, msg.source_lang ?? 'unknown', suchWorte(text),
  );
  const translations = db.all<{ lang: string; text: string }>(
    'SELECT lang, text FROM message_translations WHERE message_id = ?', messageId,
  );
  for (const tr of translations) {
    db.run(
      'INSERT INTO message_fts (message_id, channel_id, lang, body) VALUES (?,?,?,?)',
      messageId, msg.channel_id, tr.lang, suchWorte(entschluesseln(tr.text)),
    );
  }
}

export function removeFromIndex(messageId: string): void {
  if (!db.fts) return;
  db.run('DELETE FROM message_fts WHERE message_id = ?', messageId);
}

/**
 * Alles aus dem Volltextindex nehmen, was zu einem Kanal gehört.
 *
 * message_fts ist eine virtuelle Tabelle und kennt keine Fremdschlüssel. Die
 * Nachrichten eines gelöschten Kanals räumt die Datenbank über ON DELETE
 * CASCADE selbst ab — ihre Indexzeilen bleiben stehen, für immer und ohne
 * dass jemals wieder etwas dahinter steht. Nachgemessen: ein Kanal mit einer
 * Nachricht hinterließ nach dem Löschen genau eine Zeile im Index.
 */
export function removeChannelFromIndex(channelId: string): void {
  if (!db.fts) return;
  db.run('DELETE FROM message_fts WHERE channel_id = ?', channelId);
}

export function now(): number { return Date.now(); }
