import type { Channel } from '@stellium/shared';
import { db, removeChannelFromIndex } from '../db/index.js';
import { newId } from '../util/id.js';
import { getChannel, isMember, toChannel } from './store.js';
import { assistantUserId } from './assistant.js';
import * as ablage from './ablage.js';

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

/**
 * DMs sind Kanäle mit stabilem Schlüssel aus den sortierten Teilnehmer-IDs.
 *
 * Ist der KI-Assistent beteiligt, antwortet er hier immer — unabhängig davon,
 * über welchen Weg der Chat geöffnet wurde. Vorher hing das am Aufrufer, und
 * ein Klick in der Seitenleiste erzeugte einen stummen Chat.
 */
export function openDm(userA: string, userB: string): Channel {
  const key = [userA, userB].sort().join(':');
  const mitKi = userA === assistantUserId() || userB === assistantUserId();
  const existing = db.get('SELECT * FROM channels WHERE dm_key = ?', key);

  if (existing) {
    ensureMember(existing.id as string, userA);
    ensureMember(existing.id as string, userB);
    if (mitKi && existing.ai_mode !== 'always') {
      db.run("UPDATE channels SET ai_mode = 'always' WHERE id = ?", existing.id);
      return getChannel(existing.id as string, userA)!;
    }
    return toChannel(existing, userA);
  }

  const id = newId('dm_');
  const at = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO channels (id, kind, name, topic, purpose, primary_language, archived, dm_key, ai_mode, created_by, created_at)
       VALUES (?, 'dm', '', NULL, NULL, NULL, 0, ?, ?, ?, ?)`,
      id, key, mitKi ? 'always' : 'off', userA, at,
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
  name?: string; topic?: string; purpose?: string;
  primaryLanguage?: string | null; archived?: boolean; readOnly?: boolean;
}): Channel | null {
  const sets: string[] = [];
  const vals: any[] = [];

  if (patch.name !== undefined) {
    const ch = getChannel(channelId);
    if (ch?.kind === 'dm') throw new Error('Direktnachrichten haben keinen Namen.');
    const name = normalizeChannelName(patch.name);
    if (!name) throw new Error('Der Name darf nicht leer sein.');
    const belegt = db.get<{ id: string }>(
      "SELECT id FROM channels WHERE kind <> 'dm' AND lower(name) = lower(?) AND id <> ?", name, channelId,
    );
    if (belegt) throw new Error(`Der Name #${name} ist schon vergeben.`);
    sets.push('name = ?'); vals.push(name);
  }
  if (patch.readOnly !== undefined) { sets.push('read_only = ?'); vals.push(patch.readOnly ? 1 : 0); }
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

/* ── Verwaltung ───────────────────────────────────────────────── */

/**
 * Kanal endgültig löschen, samt Nachrichten und Anhängen.
 * Archivieren ist fast immer die bessere Wahl — deshalb hängt das an einem
 * eigenen Recht und ist Direktnachrichten gegenüber gesperrt.
 */
export function deleteChannel(channelId: string): { name: string; messages: number } {
  const ch = getChannel(channelId);
  if (!ch) throw new Error('Kanal nicht gefunden');
  if (ch.kind === 'dm') throw new Error('Direktnachrichten lassen sich nicht löschen, nur ausblenden.');

  const anzahl = db.get<{ n: number }>('SELECT COUNT(*) n FROM messages WHERE channel_id = ?', channelId)?.n ?? 0;

  /* Die Pfade müssen vor dem Löschen gelesen werden. Gleich darauf räumt die
     Datenbank die Zeilen über ON DELETE CASCADE selbst ab — Nachrichten,
     Anhänge, Dateien — und dann weiß niemand mehr, welche Inhalte auf der
     Platte dazugehörten. */
  const pfade = [
    ...db.all<{ path: string }>(
      `SELECT a.path FROM attachments a
         JOIN messages m ON m.id = a.message_id
        WHERE m.channel_id = ?`,
      channelId,
    ),
    ...db.all<{ path: string }>('SELECT path FROM files WHERE channel_id = ?', channelId),
  ].map((r) => r.path);

  /* Zeilen und Index in einem Zug. Der Volltextindex hängt an keiner
     Fremdschlüsselbeziehung — was ON DELETE CASCADE hier abräumt, muss dort
     von Hand nach. Beides in einer Transaktion, damit nicht der eine Teil
     verschwindet und der andere bleibt. */
  db.transaction(() => {
    removeChannelFromIndex(channelId);
    db.run('DELETE FROM channels WHERE id = ?', channelId);
  });

  /* Was der Kanal hinterlässt, liegt in zwei Formen da: Blöcke für alles, was
     in den Blockspeicher gewandert ist, und ganze Dateien für alles andere.
     Beides wird hier eingesammelt — bis eben behauptete an dieser Stelle ein
     Kommentar, das erledige ein Aufräumlauf, den es nie gegeben hat. */
  ablage.verwaisteAufraeumen();
  ablage.dateienAufraeumen(pfade);

  return { name: ch.name, messages: anzahl };
}

/**
 * Einen Chat aus der eigenen Liste nehmen, ohne ihn für andere anzutasten.
 * Schreibt jemand wieder, taucht er von selbst erneut auf.
 */
export function hideChannel(channelId: string, userId: string): void {
  const ch = getChannel(channelId, userId);
  if (!ch) throw new Error('Kanal nicht gefunden');
  if (ch.kind === 'dm') {
    db.run('UPDATE channel_members SET hidden = 1 WHERE channel_id = ? AND user_id = ?', channelId, userId);
    return;
  }
  // Bei normalen Kanälen ist Verlassen die passende Handlung.
  db.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, userId);
}

/** Wieder einblenden, sobald neue Aktivität kommt. */
export function unhideForAll(channelId: string): void {
  /* `AND hidden = 1`, weil das bei jeder einzelnen Nachricht läuft: ohne die
     Bedingung schreibt SQLite jede Mitgliedszeile des Kanals neu, auch wenn
     sich nichts ändert — bei zwanzig Mitgliedern also zwanzig Zeilen ins WAL
     für jede Zeile Text. */
  db.run('UPDATE channel_members SET hidden = 0 WHERE channel_id = ? AND hidden = 1', channelId);
}

export function setMembers(channelId: string, add: string[] = [], remove: string[] = []): Channel {
  const ch = getChannel(channelId);
  if (!ch) throw new Error('Kanal nicht gefunden');
  if (ch.kind === 'dm') throw new Error('Bei Direktnachrichten stehen die Teilnehmenden fest.');

  db.transaction(() => {
    for (const uid of add) {
      if (!db.get('SELECT 1 AS x FROM users WHERE id = ?', uid)) continue;
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)',
        channelId, uid, Date.now());
    }
    for (const uid of remove) {
      if (uid === ch.createdBy) continue;   // wer ihn angelegt hat, bleibt drin
      db.run('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, uid);
    }
  });
  return getChannel(channelId)!;
}

export function setMuted(channelId: string, userId: string, muted: boolean): void {
  db.run('UPDATE channel_members SET muted = ? WHERE channel_id = ? AND user_id = ?',
    muted ? 1 : 0, channelId, userId);
}

export function setStarred(channelId: string, userId: string, starred: boolean): void {
  db.run('UPDATE channel_members SET starred = ? WHERE channel_id = ? AND user_id = ?',
    starred ? 1 : 0, channelId, userId);
}
