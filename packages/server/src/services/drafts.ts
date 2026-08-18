import type { Draft } from '@stellium/shared';
import { db } from '../db/index.js';

/** Entwürfe überleben Kanalwechsel, Neustart und Rechnerwechsel. */

export function saveDraft(userId: string, channelId: string, parentId: string | null, text: string): void {
  const key = parentId ?? '';
  if (!text.trim()) {
    db.run('DELETE FROM drafts WHERE user_id = ? AND channel_id = ? AND parent_id = ?', userId, channelId, key);
    return;
  }
  db.run(
    `INSERT INTO drafts (user_id, channel_id, parent_id, text, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, channel_id, parent_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    userId, channelId, key, text.slice(0, 12_000), Date.now(),
  );
}

export function draftsFor(userId: string): Draft[] {
  return db.all<{ channel_id: string; parent_id: string; text: string; updated_at: number }>(
    'SELECT channel_id, parent_id, text, updated_at FROM drafts WHERE user_id = ?', userId,
  ).map((r) => ({
    channelId: r.channel_id,
    parentId: r.parent_id || null,
    text: r.text,
    updatedAt: r.updated_at,
  }));
}
