import { detectLanguage, extractMentions, normalizeLang, type Message } from '@stellium/shared';
import { db, reindexMessage, removeFromIndex } from '../db/index.js';
import { newId } from '../util/id.js';
import { dropMessageTranslations } from '../translation/index.js';
import { getMessage, getUserByHandle, hydrateMessages } from './store.js';

export interface CreateMessageInput {
  channelId: string;
  userId: string;
  text: string;
  parentId?: string | null;
  attachmentIds?: string[];
  sourceLang?: string | null;
  systemKind?: string | null;
}

export function createMessage(input: CreateMessageInput): Message {
  const text = input.text.trim();
  if (!text && !(input.attachmentIds?.length)) throw new Error('Leere Nachricht');
  if (text.length > 12_000) throw new Error('Nachricht zu lang (max. 12.000 Zeichen)');

  const id = newId('m_');
  const at = Date.now();
  const detected = input.sourceLang ? normalizeLang(input.sourceLang) : detectLanguage(text).lang;
  const sourceLang = detected === 'unknown' ? null : detected;

  db.transaction(() => {
    db.run(
      `INSERT INTO messages (id, channel_id, user_id, parent_id, text, source_lang, system_kind, pinned, created_at)
       VALUES (?,?,?,?,?,?,?,0,?)`,
      id, input.channelId, input.userId, input.parentId ?? null, text, sourceLang, input.systemKind ?? null, at,
    );

    for (const handle of extractMentions(text)) {
      const user = getUserByHandle(handle);
      if (user) db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', id, user.id);
    }

    for (const attId of input.attachmentIds ?? []) {
      db.run('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL', id, attId);
    }

    // Wer im Thread antwortet, gilt als Teilnehmer der Wurzel-Nachricht.
    if (input.parentId) {
      const parent = db.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', input.parentId);
      if (!parent) throw new Error('Thread-Wurzel nicht gefunden');
    }
  });

  reindexMessage(id);
  return getMessage(id)!;
}

export function editMessage(messageId: string, userId: string, text: string): Message {
  const row = db.get<{ user_id: string; deleted_at: number | null }>(
    'SELECT user_id, deleted_at FROM messages WHERE id = ?', messageId,
  );
  if (!row) throw new Error('Nachricht nicht gefunden');
  if (row.user_id !== userId) throw new Error('Nur eigene Nachrichten lassen sich bearbeiten');
  if (row.deleted_at) throw new Error('Nachricht wurde gelöscht');

  const clean = text.trim();
  if (!clean) throw new Error('Leere Nachricht');

  const detected = detectLanguage(clean).lang;
  db.transaction(() => {
    db.run(
      'UPDATE messages SET text = ?, source_lang = ?, edited_at = ? WHERE id = ?',
      clean, detected === 'unknown' ? null : detected, Date.now(), messageId,
    );
    db.run('DELETE FROM message_mentions WHERE message_id = ?', messageId);
    for (const handle of extractMentions(clean)) {
      const user = getUserByHandle(handle);
      if (user) db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', messageId, user.id);
    }
  });

  // Alte Übersetzungen passen nicht mehr zum neuen Text.
  dropMessageTranslations(messageId);
  reindexMessage(messageId);
  return getMessage(messageId)!;
}

export function deleteMessage(messageId: string, userId: string, isAdmin: boolean): { channelId: string } {
  const row = db.get<{ user_id: string; channel_id: string }>(
    'SELECT user_id, channel_id FROM messages WHERE id = ?', messageId,
  );
  if (!row) throw new Error('Nachricht nicht gefunden');
  if (row.user_id !== userId && !isAdmin) throw new Error('Keine Berechtigung');

  db.run('UPDATE messages SET deleted_at = ?, text = \'\', pinned = 0 WHERE id = ?', Date.now(), messageId);
  db.run('DELETE FROM message_translations WHERE message_id = ?', messageId);
  removeFromIndex(messageId);
  return { channelId: row.channel_id };
}

export function toggleReaction(messageId: string, userId: string, emoji: string): { channelId: string } {
  const row = db.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', messageId);
  if (!row) throw new Error('Nachricht nicht gefunden');

  const clean = emoji.trim().slice(0, 32);
  if (!clean) throw new Error('Emoji fehlt');

  const existing = db.get('SELECT 1 AS x FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, clean);
  if (existing) {
    db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, clean);
  } else {
    db.run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?,?,?,?)', messageId, userId, clean, Date.now());
  }
  return { channelId: row.channel_id };
}

export function setPinned(messageId: string, pinned: boolean): Message | null {
  db.run('UPDATE messages SET pinned = ? WHERE id = ?', pinned ? 1 : 0, messageId);
  return getMessage(messageId);
}

export function setSaved(messageId: string, userId: string, saved: boolean): void {
  if (saved) {
    db.run('INSERT OR IGNORE INTO saved_messages (user_id, message_id, created_at) VALUES (?,?,?)', userId, messageId, Date.now());
  } else {
    db.run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', userId, messageId);
  }
}

export function markRead(channelId: string, userId: string, lastMessageId: string): void {
  db.run(
    `UPDATE channel_members SET last_read_message_id = ?
     WHERE channel_id = ? AND user_id = ? AND (last_read_message_id IS NULL OR last_read_message_id < ?)`,
    lastMessageId, channelId, userId, lastMessageId,
  );
}

/* ── Geplante Nachrichten ─────────────────────────────────────── */

export function scheduleMessage(input: {
  channelId: string; userId: string; text: string; sendAt: number; parentId?: string | null;
}) {
  const text = input.text.trim();
  if (!text) throw new Error('Leere Nachricht');
  if (input.sendAt < Date.now() + 10_000) throw new Error('Sendezeitpunkt muss mindestens 10 Sekunden in der Zukunft liegen');

  const id = newId('sc_');
  db.run(
    'INSERT INTO scheduled_messages (id, channel_id, user_id, parent_id, text, send_at, created_at) VALUES (?,?,?,?,?,?,?)',
    id, input.channelId, input.userId, input.parentId ?? null, text, input.sendAt, Date.now(),
  );
  return id;
}

export function cancelScheduled(id: string, userId: string): boolean {
  const res = db.run('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ?', id, userId);
  return res.changes > 0;
}

export function dueScheduled(now: number) {
  return db.all<{ id: string; channel_id: string; user_id: string; parent_id: string | null; text: string }>(
    'SELECT id, channel_id, user_id, parent_id, text FROM scheduled_messages WHERE send_at <= ? ORDER BY send_at ASC LIMIT 50',
    now,
  );
}

export function removeScheduled(id: string): void {
  db.run('DELETE FROM scheduled_messages WHERE id = ?', id);
}

export function messagesByIds(ids: string[]): Message[] {
  if (!ids.length) return [];
  const rows = db.all(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return hydrateMessages(rows);
}
