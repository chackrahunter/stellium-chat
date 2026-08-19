import {
  detectLanguage, extractMentions, mentionsEveryone, normalizeLang,
  withinDeleteWindow, withinEditWindow, type DeleteScope, type Message,
} from '@stellium/shared';
import { db, reindexMessage, removeFromIndex } from '../db/index.js';
import { newId } from '../util/id.js';
import { dropMessageTranslations } from '../translation/index.js';
import { getMessage, getUserByHandle, hydrateMessages } from './store.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';

export interface CreateMessageInput {
  channelId: string;
  userId: string;
  text: string;
  parentId?: string | null;
  attachmentIds?: string[];
  sourceLang?: string | null;
  systemKind?: string | null;
  /** "text" | "voice" | "poll" */
  kind?: string;
  /** Herkunft bei Weiterleitungen: "<messageId>|<channelId>|<userId>" */
  forwardedFrom?: string | null;
  /** Darf die Person einzelne Personen erwähnen? Sonst wird nichts eingetragen. */
  mayMention?: boolean;
  /** Darf sie den ganzen Kanal erwähnen (@alle)? */
  mayMentionEveryone?: boolean;
}

export function createMessage(input: CreateMessageInput): Message {
  const text = input.text.trim();
  if (!text && !(input.attachmentIds?.length)) throw new Error('Leere Nachricht');
  if (text.length > 12_000) throw new Error('Nachricht zu lang (max. 12.000 Zeichen)');

  const id = newId('m_');
  const at = Date.now();
  // Bei unsicherer Erkennung lieber nichts eintragen: das Übersetzungsmodell
  // erkennt die Sprache zuverlässiger und das Ergebnis wird zurückgeschrieben.
  const erkannt = input.sourceLang ? { lang: normalizeLang(input.sourceLang), confidence: 1 } : detectLanguage(text);
  const sourceLang = erkannt.lang === 'unknown' || erkannt.confidence < 0.35 ? null : erkannt.lang;

  db.transaction(() => {
    db.run(
      `INSERT INTO messages (id, channel_id, user_id, parent_id, text, source_lang, system_kind, pinned, kind, forwarded_from, created_at)
       VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
      id, input.channelId, input.userId, input.parentId ?? null, verschluesseln(text), sourceLang,
      input.systemKind ?? null, input.kind ?? 'text', input.forwardedFrom ?? null, at,
    );

    // Erwähnungen nur eintragen, wenn das Recht dafür da ist. Ohne Eintrag
    // gibt es keine Benachrichtigung und keine Hervorhebung.
    if (input.mayMention !== false) {
      for (const handle of extractMentions(text)) {
        const user = getUserByHandle(handle);
        if (user) db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', id, user.id);
      }
    }

    // @alle betrifft jede Person im Kanal außer der schreibenden.
    if (input.mayMentionEveryone && mentionsEveryone(text)) {
      const mitglieder = db.all<{ user_id: string }>(
        'SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id <> ?',
        input.channelId, input.userId,
      );
      for (const m of mitglieder) {
        db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', id, m.user_id);
      }
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
  return getMessage(id, input.userId)!;
}

export function editMessage(messageId: string, userId: string, text: string, mayMention = true): Message {
  const row = db.get<{ user_id: string; deleted_at: number | null; created_at: number; kind: string }>(
    'SELECT user_id, deleted_at, created_at, kind FROM messages WHERE id = ?', messageId,
  );
  if (!row) throw new Error('Nachricht nicht gefunden');
  if (row.user_id !== userId) throw new Error('Nur eigene Nachrichten lassen sich bearbeiten');
  if (row.deleted_at) throw new Error('Nachricht wurde gelöscht');
  if (row.kind === 'poll') throw new Error('Umfragen lassen sich nicht nachträglich ändern.');
  // Nach dem Zeitfenster ist die Nachricht Teil des Verlaufs, auf den sich
  // andere schon bezogen haben.
  if (!withinEditWindow(row.created_at)) {
    throw new Error('Bearbeiten geht nur in den ersten zwei Stunden nach dem Senden.');
  }

  const clean = text.trim();
  if (!clean) throw new Error('Leere Nachricht');

  const detected = detectLanguage(clean).lang;
  db.transaction(() => {
    db.run(
      'UPDATE messages SET text = ?, source_lang = ?, edited_at = ? WHERE id = ?',
      verschluesseln(clean), detected === 'unknown' ? null : detected, Date.now(), messageId,
    );
    db.run('DELETE FROM message_mentions WHERE message_id = ?', messageId);
    if (mayMention) {
      for (const handle of extractMentions(clean)) {
        const user = getUserByHandle(handle);
        if (user) db.run('INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?,?)', messageId, user.id);
      }
    }
  });

  // Alte Übersetzungen passen nicht mehr zum neuen Text.
  dropMessageTranslations(messageId);
  reindexMessage(messageId);
  return getMessage(messageId)!;
}

/**
 * Löschen in zwei Stufen.
 *
 *   "all"  nimmt die Nachricht für alle zurück. Erlaubt für eigene Nachrichten
 *          innerhalb des Zeitfensters, für Moderation jederzeit.
 *   "me"   blendet sie nur für die aufrufende Person aus. Immer möglich, auch
 *          bei fremden Nachrichten und nach Ablauf des Fensters.
 */
export function deleteMessage(
  messageId: string, userId: string, canDeleteAny: boolean, scope: DeleteScope = 'all',
): { channelId: string; scope: DeleteScope } {
  const row = db.get<{ user_id: string; channel_id: string; created_at: number }>(
    'SELECT user_id, channel_id, created_at FROM messages WHERE id = ?', messageId,
  );
  if (!row) throw new Error('Nachricht nicht gefunden');

  if (scope === 'me') {
    db.run('INSERT OR IGNORE INTO hidden_messages (user_id, message_id, created_at) VALUES (?,?,?)',
      userId, messageId, Date.now());
    return { channelId: row.channel_id, scope: 'me' };
  }

  const eigene = row.user_id === userId;
  if (!eigene && !canDeleteAny) throw new Error('Fremde Nachrichten darf nur die Moderation löschen.');
  if (eigene && !canDeleteAny && !withinDeleteWindow(row.created_at)) {
    throw new Error('Für alle zurücknehmen geht nur in den ersten zwei Stunden. Du kannst sie noch für dich ausblenden.');
  }

  db.run("UPDATE messages SET deleted_at = ?, text = '', pinned = 0 WHERE id = ?", Date.now(), messageId);
  db.run('DELETE FROM message_translations WHERE message_id = ?', messageId);
  removeFromIndex(messageId);
  return { channelId: row.channel_id, scope: 'all' };
}

/** Für eine Person ausgeblendete Nachrichten. */
export function hiddenFor(userId: string, messageIds: string[]): Set<string> {
  if (!messageIds.length) return new Set();
  const rows = db.all<{ message_id: string }>(
    `SELECT message_id FROM hidden_messages WHERE user_id = ? AND message_id IN (${messageIds.map(() => '?').join(',')})`,
    userId, ...messageIds,
  );
  return new Set(rows.map((r) => r.message_id));
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
    id, input.channelId, input.userId, input.parentId ?? null, verschluesseln(text), input.sendAt, Date.now(),
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
  ).map((r) => ({ ...r, text: entschluesseln(r.text) }));
}

export function removeScheduled(id: string): void {
  db.run('DELETE FROM scheduled_messages WHERE id = ?', id);
}

export function messagesByIds(ids: string[]): Message[] {
  if (!ids.length) return [];
  const rows = db.all(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return hydrateMessages(rows);
}
