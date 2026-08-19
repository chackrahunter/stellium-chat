import type { SearchHit } from '@stellium/shared';
import { db, placeholders } from '../db/index.js';
import { hydrateMessages, visibleChannels } from './store.js';
import { entschluesseln, suchBegriffe } from '../crypto/nachrichten.js';

export interface SearchQuery {
  userId: string;
  q: string;
  channelId?: string | null;
  fromUserId?: string | null;
  hasFiles?: boolean;
  limit?: number;
}

/**
 * Sucht über Originale UND gespeicherte Übersetzungen. Dadurch findet eine
 * deutsche Suchanfrage auch Nachrichten, die auf Englisch geschrieben wurden —
 * vorausgesetzt, sie wurden schon einmal übersetzt.
 */
export function search(query: SearchQuery): SearchHit[] {
  const q = query.q.trim();
  if (q.length < 2) return [];

  const limit = Math.min(query.limit ?? 40, 100);
  /* Vertrauliche Kanäle fallen heraus, bevor überhaupt gesucht wird.
     Sie zu durchsuchen wäre nicht gefährlich, sondern sinnlos: der Server hat
     dort nur Chiffrat. Aber ein Suchlauf, der einen Kanal stillschweigend
     übergeht, sieht aus wie einer, der dort nichts gefunden hat. Deshalb
     bekommt die Oberfläche die Kanäle gar nicht erst in den Bereich — und
     kann sagen, dass hier nur die App selbst sucht. */
  const allowed = visibleChannels(query.userId).filter((c) => !c.vertraulich).map((c) => c.id);
  if (!allowed.length) return [];

  const scope = query.channelId && allowed.includes(query.channelId) ? [query.channelId] : allowed;

  const rows = db.fts ? ftsSearch(q, scope, limit * 2) : likeSearch(q, scope, limit * 2);
  if (!rows.length) return [];

  const ids = [...new Set(rows.map((r) => r.message_id))];
  const msgRows = db.all(
    `SELECT * FROM messages WHERE id IN (${placeholders(ids.length)}) AND deleted_at IS NULL`
    + (query.fromUserId ? ' AND user_id = ?' : ''),
    ...ids, ...(query.fromUserId ? [query.fromUserId] : []),
  );
  const messages = new Map(hydrateMessages(msgRows).map((m) => [m.id, m]));

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.message_id)) continue;
    const msg = messages.get(r.message_id);
    if (!msg) continue;
    if (query.hasFiles && msg.attachments.length === 0) continue;
    seen.add(r.message_id);
    hits.push({
      message: msg,
      channelId: msg.channelId,
      snippet: r.snippet ?? excerpt(msg.text, q),
      matchedTranslation: r.lang !== (msg.sourceLang ?? 'unknown'),
      score: r.score,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

interface RawHit { message_id: string; lang: string; snippet: string | null; score: number }

function ftsSearch(q: string, channelIds: string[], limit: number): RawHit[] {
  const expr = toFtsExpression(q);
  if (!expr) return [];
  try {
    return db.all<RawHit>(
      /* Kein snippet(): im Index stehen Fingerabdrücke, kein Text — ein
         Ausschnitt daraus wäre unlesbar. Die Fundstelle schneidet danach
         `excerpt` aus dem entschlüsselten Original. */
      `SELECT message_id, lang, NULL AS snippet, -bm25(message_fts) AS score
       FROM message_fts
       WHERE message_fts MATCH ? AND channel_id IN (${placeholders(channelIds.length)})
       ORDER BY score DESC LIMIT ?`,
      expr, ...channelIds, limit,
    );
  } catch {
    return likeSearch(q, channelIds, limit);
  }
}

/**
 * Die Suchanfrage in dieselben Fingerabdrücke übersetzen, die im Index stehen.
 *
 * Präfixsuche gibt es hier nicht mehr: zwei Fingerabdrücke haben keinen
 * gemeinsamen Anfang, auch wenn die Wörter einen hatten. Das ist der Preis
 * dafür, dass im Index nichts Lesbares liegt.
 */
function toFtsExpression(q: string): string {
  return suchBegriffe(q).map((t) => `"${t}"`).join(' AND ');
}

/**
 * Rückfallweg ohne FTS5. Er kann nicht mehr per SQL filtern — in der Spalte
 * steht ein Chiffrat, und danach zu suchen fände nichts. Also holt er einen
 * begrenzten Ausschnitt der jüngsten Nachrichten und siebt ihn im Speicher.
 */
function likeSearch(q: string, channelIds: string[], limit: number): RawHit[] {
  const nadel = q.toLowerCase();
  const passt = (t: string) => t.toLowerCase().includes(nadel);
  const FENSTER = 4000;

  const original = db.all<{ id: string; source_lang: string | null; text: string }>(
    `SELECT id, source_lang, text FROM messages
     WHERE channel_id IN (${placeholders(channelIds.length)}) AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT ?`,
    ...channelIds, FENSTER,
  ).map((r) => ({ ...r, text: entschluesseln(r.text) })).filter((r) => passt(r.text)).slice(0, limit);

  const translated = db.all<{ message_id: string; lang: string; text: string }>(
    `SELECT t.message_id, t.lang, t.text FROM message_translations t
     JOIN messages m ON m.id = t.message_id
     WHERE m.channel_id IN (${placeholders(channelIds.length)}) AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT ?`,
    ...channelIds, FENSTER,
  ).map((r) => ({ ...r, text: entschluesseln(r.text) })).filter((r) => passt(r.text)).slice(0, limit);
  return [
    ...original.map((r) => ({ message_id: r.id, lang: r.source_lang ?? 'unknown', snippet: excerpt(r.text, q), score: 1 })),
    ...translated.map((r) => ({ message_id: r.message_id, lang: r.lang, snippet: excerpt(r.text, q), score: 0.6 })),
  ];
}

function excerpt(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 160);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + q.length + 80);
  const body = text.slice(start, end);
  const marked = body.replace(new RegExp(escapeRe(q), 'gi'), (m) => `<em>${m}</em>`);
  return `${start > 0 ? '…' : ''}${marked}${end < text.length ? '…' : ''}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
