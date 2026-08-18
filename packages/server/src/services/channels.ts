import type { Channel } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { getChannel, isMember, toChannel } from './store.js';

export function createChannel(input: {
  kind: 'public' | 'private';
  name: string;
  topic?: string | null;
  primaryLanguage?: string | null;
  createdBy: string;
  memberIds?: string[];
}): Channel {
  const name = normalizeChannelName(input.name);
  if (!name) throw new Error('Kanalname fehlt');

  const existing = db.get<{ id: string }>(
    "SELECT id FROM channels WHERE kind <> 'dm' AND lower(name) = lower(?)", name,
  );
  if (existing) throw new Error(`Kanal #${name} existiert bereits`);

  const id = newId('ch_');
  const at = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO channels (id, kind, name, topic, purpose, primary_language, archived, created_by, created_at)
       VALUES (?,?,?,?,NULL,?,0,?,?)`,
      id, input.kind, name, input.topic ?? null, input.primaryLanguage ?? null, input.createdBy, at,
    );
    const members = new Set([input.createdBy, ...(input.memberIds ?? [])]);
    for (const uid of members) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', id, uid, at);
    }
  });
  return getChannel(id, input.createdBy)!;
}

/** DMs sind Kanäle mit stabilem Schlüssel aus den sortierten Teilnehmer-IDs. */
export function openDm(userA: string, userB: string): Channel {
  const key = [userA, userB].sort().join(':');
  const existing = db.get('SELECT * FROM channels WHERE dm_key = ?', key);
  if (existing) {
    // Selbst-Notiz-Kanal und DMs: sicherstellen, dass beide Mitglied sind
    ensureMember(existing.id as string, userA);
    ensureMember(existing.id as string, userB);
    return toChannel(existing, userA);
  }

  const id = newId('dm_');
  const at = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO channels (id, kind, name, topic, purpose, primary_language, archived, dm_key, created_by, created_at)
       VALUES (?, 'dm', '', NULL, NULL, NULL, 0, ?, ?, ?)`,
      id, key, userA, at,
    );
    for (const uid of new Set([userA, userB])) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', id, uid, at);
    }
  });
  return getChannel(id, userA)!;
}

export function ensureMember(channelId: string, userId: string): void {
  db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', channelId, userId, Date.now());
}

export function joinChannel(channelId: string, userId: string): Channel {
  const ch = getChannel(channelId, userId);
  if (!ch) throw new Error('Kanal nicht gefunden');
  if (ch.kind === 'private' && !isMember(channelId, userId)) throw new Error('Privater Kanal — Einladung nötig');
  if (ch.kind === 'dm') throw new Error('DMs kann man nicht betreten');
  ensureMember(channelId, userId);
  return getChannel(channelId, userId)!;
}

export function leaveChannel(channelId: string, userId: string): void {
  const ch = getChannel(channelId, userId);
  if (!ch) return;
  if (ch.kind === 'dm') throw new Error('DMs kann man nicht verlassen');
  db.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, userId);
}

export function updateChannel(channelId: string, patch: {
  topic?: string; purpose?: string; primaryLanguage?: string | null; archived?: boolean;
}): Channel | null {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.topic !== undefined) { sets.push('topic = ?'); vals.push(patch.topic || null); }
  if (patch.purpose !== undefined) { sets.push('purpose = ?'); vals.push(patch.purpose || null); }
  if (patch.primaryLanguage !== undefined) { sets.push('primary_language = ?'); vals.push(patch.primaryLanguage); }
  if (patch.archived !== undefined) { sets.push('archived = ?'); vals.push(patch.archived ? 1 : 0); }
  if (!sets.length) return getChannel(channelId);
  db.run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, ...vals, channelId);
  return getChannel(channelId);
}

export function normalizeChannelName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

/** Anzeigename eines Kanals — für Benachrichtigungen und KI-Prompts. */
export function channelLabel(channel: Channel, viewerId: string, nameOf: (id: string) => string): string {
  if (channel.kind !== 'dm') return channel.name;
  const peer = channel.memberIds.find((m) => m !== viewerId);
  return peer ? nameOf(peer) : 'Notiz an mich';
}
