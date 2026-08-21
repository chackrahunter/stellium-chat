import type {
  Attachment, Channel, ChannelState, ManagedUser, Message, Reaction,
  ScheduledMessage, SelfUser, User,
} from '@stellium/shared';
import { db, placeholders } from '../db/index.js';
import { blindIndex, decryptField, maskEmail } from '../crypto/pii.js';
import { entschluesseln } from '../crypto/nachrichten.js';
import { huelleLesen } from '../crypto/dateien.js';
import { overridesFor, permissionsFor } from './users.js';
import { linkPreviewsFor } from './links.js';
import { hiddenFor } from './messages.js';
import { pollForMessage } from './polls.js';
import { cachedPollView, cachedChannelView } from '../translation/index.js';
import { voiceNoteFor } from './voice.js';

/* ── Nutzer ───────────────────────────────────────────────────── */

export function toUser(r: any): User {
  return {
    id: r.id,
    // Benutzername und E-Mail liegen verschlüsselt in der Datenbank.
    handle: decryptField(r.handle),
    displayName: r.display_name,
    email: decryptField(r.email),
    avatarColor: r.avatar_color,
    avatarUrl: r.avatar_url ?? null,
    title: r.title ?? null,
    timezone: r.timezone,
    language: r.language,
    autoTranslate: Boolean(r.auto_translate),
    status: r.status,
    statusEmoji: r.status_emoji ?? null,
    statusText: r.status_text ?? null,
    statusExpiresAt: r.status_expires_at ?? null,
    lastSeenAt: r.last_seen_at ?? null,
    role: r.role,
    disabled: Boolean(r.disabled),
    /* Technische Konten (Assistent, Wartung) bleiben in der Liste — sonst
       stünden ihre Nachrichten ohne Namen da —, sind aber nirgends
       anzutippen. Die Oberfläche filtert an dieser Marke. */
    /* Dieselbe Regel wie in der Kontenverwaltung (TeamAdmin.schublade):
       gewählt schlägt geraten, und ohne Wahl ist ein Bot technisch. Stünde
       hier nur die Kategorie, wäre der Assistent bis zur ersten Einsortierung
       von Hand ein ganz normales Konto — erwähnbar und anschreibbar. */
    technisch: r.kategorie ? r.kategorie === 'technisch' : r.role === 'bot',
    createdAt: r.created_at,
  };
}

export function toSelf(r: any): SelfUser {
  return {
    ...toUser(r),
    notifyOn: r.notify_on,
    quietHoursStart: r.quiet_hours_start ?? null,
    quietHoursEnd: r.quiet_hours_end ?? null,
    composeTargetPreview: Boolean(r.compose_target_preview),
    theme: r.theme,
    density: r.density,
    notificationSound: r.notification_sound ?? 'ping',
    translationSpeed: r.translation_speed ?? 'balanced',
    uiLanguage: r.ui_language ?? r.language ?? 'de',
    permissions: permissionsFor(r.id),
    mustChangePassword: Boolean(r.must_change_password),
    mustCompleteProfile: Boolean(r.must_complete_profile),
  };
}

/** Kontenliste für die Verwaltung — E-Mails nur angedeutet. */
export function listManagedUsers(): ManagedUser[] {
  /* Gelöschte ans Ende: sie bleiben nur bestehen, damit ihre Nachrichten
     einen Urheber behalten — vorn stehen die, um die es geht. */
  return db.all(
    `SELECT * FROM users
     ORDER BY CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END, disabled, display_name COLLATE NOCASE`,
  ).map((r: any) => ({
    id: r.id,
    handle: decryptField(r.handle),
    displayName: r.display_name,
    emailMasked: r.email ? maskEmail(decryptField(r.email)) : '—',
    role: r.role,
    disabled: Boolean(r.disabled),
    deletedAt: r.deleted_at ?? null,
    kategorie: r.kategorie ?? null,
    mustChangePassword: Boolean(r.must_change_password),
    lastSeenAt: r.last_seen_at ?? null,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
    overrides: overridesFor(r.id),
    permissions: permissionsFor(r.id),
  }));
}

export function getUser(id: string): User | null {
  const r = db.get('SELECT * FROM users WHERE id = ?', id);
  return r ? toUser(r) : null;
}

export function getSelf(id: string): SelfUser | null {
  const r = db.get('SELECT * FROM users WHERE id = ?', id);
  return r ? toSelf(r) : null;
}

export function getUserByHandle(handle: string): User | null {
  // Über den Blind-Index, weil der Benutzername verschlüsselt gespeichert ist.
  const r = db.get('SELECT * FROM users WHERE handle_bidx = ?', blindIndex(handle))
    ?? db.get('SELECT * FROM users WHERE lower(handle) = lower(?)', handle);
  return r ? toUser(r) : null;
}

export function listUsers(): User[] {
  return db.all('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').map(toUser);
}

/** Sprache der Oberfläche — fällt auf die Übersetzungssprache zurück. */
export function uiLanguageOf(userId: string): string {
  const r = db.get<{ ui_language: string | null; language: string }>(
    'SELECT ui_language, language FROM users WHERE id = ?', userId,
  );
  return r?.ui_language || r?.language || 'de';
}

export function userLanguage(id: string): string {
  return db.get<{ language: string }>('SELECT language FROM users WHERE id = ?', id)?.language ?? 'en';
}

/* ── Kanäle ───────────────────────────────────────────────────── */

export function memberIds(channelId: string): string[] {
  return db.all<{ user_id: string }>('SELECT user_id FROM channel_members WHERE channel_id = ?', channelId)
    .map((r) => r.user_id);
}

export function toChannel(r: any, viewerId?: string): Channel {
  const members = memberIds(r.id);
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    topic: r.topic ?? null,
    purpose: r.purpose ?? null,
    primaryLanguage: r.primary_language ?? null,
    aiMode: (r.ai_mode ?? 'off') as Channel['aiMode'],
    readOnly: Boolean(r.read_only),
    vertraulich: Boolean(r.vertraulich),
    schluesselFassung: r.schluessel_fassung ?? 0,
    archived: Boolean(r.archived),
    createdBy: r.created_by,
    createdAt: r.created_at,
    memberIds: members,
    dmPeerId: r.kind === 'dm' && viewerId ? members.find((m) => m !== viewerId) ?? null : null,
    /* Bereits übersetzt? Dann gleich mitschicken. Fehlt sie, kommt sie als
       eigenes Ereignis nach.

       In vertraulichen Kanälen gar nicht: Name, Thema und Zweck stehen zwar im
       Klartext auf dem Server, aber sie durch das Übersetzungsmodell zu
       schicken hieße, sie an einen fremden Dienst zu geben. Wer einen Kanal
       vertraulich stellt, erwartet das Gegenteil. */
    translation: viewerId && r.kind !== 'dm' && !r.vertraulich ? kanalUebersetzung(r.id, viewerId) : null,
  };
}

function kanalUebersetzung(channelId: string, viewerId: string) {
  const sprache = db.get<{ language: string }>('SELECT language FROM users WHERE id = ?', viewerId)?.language;
  return sprache ? cachedChannelView(channelId, sprache) : null;
}

export function getChannel(id: string, viewerId?: string): Channel | null {
  const r = db.get('SELECT * FROM channels WHERE id = ?', id);
  return r ? toChannel(r, viewerId) : null;
}

export function isMember(channelId: string, userId: string): boolean {
  return Boolean(db.get('SELECT 1 AS x FROM channel_members WHERE channel_id = ? AND user_id = ?', channelId, userId));
}

/** Kanäle, die der Nutzer sieht: eigene Mitgliedschaften + offene Kanäle. */
export function visibleChannels(userId: string): Channel[] {
  const rows = db.all(
    `SELECT DISTINCT c.* FROM channels c
     LEFT JOIN channel_members m ON m.channel_id = c.id AND m.user_id = ?
     WHERE c.archived = 0
       AND (m.user_id IS NOT NULL OR c.kind = 'public')
       AND COALESCE(m.hidden, 0) = 0
     ORDER BY c.kind, c.name COLLATE NOCASE`,
    userId,
  );
  return rows.map((r) => toChannel(r, userId));
}

export function channelStates(userId: string): ChannelState[] {
  const rows = db.all<{ channel_id: string; last_read_message_id: string | null; muted: number; starred: number }>(
    'SELECT channel_id, last_read_message_id, muted, starred FROM channel_members WHERE user_id = ?',
    userId,
  );
  return rows.map((r) => ({
    channelId: r.channel_id,
    lastReadMessageId: r.last_read_message_id,
    muted: Boolean(r.muted),
    starred: Boolean(r.starred),
    ...unreadCounts(r.channel_id, userId, r.last_read_message_id),
  }));
}

export function unreadCounts(channelId: string, userId: string, lastReadId: string | null) {
  const boundary = lastReadId ?? '';
  const unread = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages
     WHERE channel_id = ? AND deleted_at IS NULL AND user_id <> ? AND id > ?`,
    channelId, userId, boundary,
  )?.n ?? 0;
  const mentions = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM messages m
     JOIN message_mentions mm ON mm.message_id = m.id
     WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.user_id <> ? AND m.id > ? AND mm.user_id = ?`,
    channelId, userId, boundary, userId,
  )?.n ?? 0;
  return { unreadCount: unread, mentionCount: mentions };
}

export function channelState(channelId: string, userId: string): ChannelState | null {
  const r = db.get<{ last_read_message_id: string | null; muted: number; starred: number }>(
    'SELECT last_read_message_id, muted, starred FROM channel_members WHERE channel_id = ? AND user_id = ?',
    channelId, userId,
  );
  if (!r) return null;
  return {
    channelId,
    lastReadMessageId: r.last_read_message_id,
    muted: Boolean(r.muted),
    starred: Boolean(r.starred),
    ...unreadCounts(channelId, userId, r.last_read_message_id),
  };
}

/* ── Nachrichten ──────────────────────────────────────────────── */

function attachmentsFor(messageIds: string[]): Map<string, Attachment[]> {
  const out = new Map<string, Attachment[]>();
  if (!messageIds.length) return out;
  const rows = db.all<any>(
    `SELECT id, message_id, name, mime, size, width, height, huelle FROM attachments
     WHERE message_id IN (${placeholders(messageIds.length)})`,
    ...messageIds,
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({
      id: r.id, messageId: r.message_id, name: r.name, mime: r.mime,
      size: r.size, url: `/files/${r.id}`, width: r.width ?? null, height: r.height ?? null,
      /* Die Hülle geht mit hinaus, obwohl sie auch im Umschlag der Datei
         steht. Ohne sie müsste die Oberfläche jede Datei erst holen, um zu
         erfahren, ob sie sie überhaupt anzeigen darf — und ein `<img src>`
         wäre bis dahin längst losgelaufen. */
      huelle: huelleLesen(r.huelle),
    });
    out.set(r.message_id, list);
  }
  return out;
}

function reactionsFor(messageIds: string[]): Map<string, Reaction[]> {
  const out = new Map<string, Reaction[]>();
  if (!messageIds.length) return out;
  const rows = db.all<{ message_id: string; emoji: string; user_id: string }>(
    `SELECT message_id, emoji, user_id FROM reactions
     WHERE message_id IN (${placeholders(messageIds.length)}) ORDER BY created_at ASC`,
    ...messageIds,
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    const hit = list.find((x) => x.emoji === r.emoji);
    if (hit) hit.userIds.push(r.user_id);
    else list.push({ emoji: r.emoji, userIds: [r.user_id] });
    out.set(r.message_id, list);
  }
  return out;
}

function mentionsFor(messageIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!messageIds.length) return out;
  const rows = db.all<{ message_id: string; user_id: string }>(
    `SELECT message_id, user_id FROM message_mentions WHERE message_id IN (${placeholders(messageIds.length)})`,
    ...messageIds,
  );
  for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), r.user_id]);
  return out;
}

function threadInfoFor(messageIds: string[]): Map<string, { count: number; lastAt: number; participants: string[] }> {
  const out = new Map<string, { count: number; lastAt: number; participants: string[] }>();
  if (!messageIds.length) return out;
  const rows = db.all<{ parent_id: string; user_id: string; created_at: number }>(
    `SELECT parent_id, user_id, created_at FROM messages
     WHERE parent_id IN (${placeholders(messageIds.length)}) AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    ...messageIds,
  );
  for (const r of rows) {
    const entry = out.get(r.parent_id) ?? { count: 0, lastAt: 0, participants: [] };
    entry.count++;
    entry.lastAt = Math.max(entry.lastAt, r.created_at);
    if (!entry.participants.includes(r.user_id)) entry.participants.push(r.user_id);
    out.set(r.parent_id, entry);
  }
  return out;
}

export function hydrateMessages(rows: any[], viewerId = ''): Message[] {
  const ids = rows.map((r) => r.id);
  const versteckt = viewerId ? hiddenFor(viewerId, ids) : new Set<string>();
  const atts = attachmentsFor(ids);
  const reacts = reactionsFor(ids);
  const mentions = mentionsFor(ids);
  const threads = threadInfoFor(ids);

  return rows.map((r) => {
    const thread = threads.get(r.id);
    const kind = r.kind ?? 'text';
    return {
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      parentId: r.parent_id ?? null,
      text: r.deleted_at ? '' : entschluesseln(r.text),
      sourceLang: r.source_lang ?? null,
      createdAt: r.created_at,
      editedAt: r.edited_at ?? null,
      deletedAt: r.deleted_at ?? null,
      systemKind: r.system_kind ?? null,
      attachments: r.deleted_at ? [] : (atts.get(r.id) ?? []),
      reactions: reacts.get(r.id) ?? [],
      replyCount: thread?.count ?? 0,
      lastReplyAt: thread?.lastAt ?? null,
      threadParticipantIds: thread?.participants ?? [],
      mentionUserIds: mentions.get(r.id) ?? [],
      pinned: Boolean(r.pinned),
      kind,
      forwardedFrom: r.forwarded_from ? parseForward(r.forwarded_from) : null,
      poll: kind === 'poll' ? mitUebersetzung(pollForMessage(r.id, viewerId), viewerId) : null,
      voice: kind === 'voice' ? voiceNoteFor(r.id) : null,
      links: r.deleted_at ? [] : linkPreviewsFor(r.id),
      hiddenForMe: versteckt.has(r.id),
      translation: null,
    } satisfies Message;
  });
}

export function getMessage(id: string, viewerId = ''): Message | null {
  const r = db.get('SELECT * FROM messages WHERE id = ?', id);
  return r ? hydrateMessages([r], viewerId)[0] : null;
}

/** Weiterleitungs-Herkunft steckt als kompakter String in der Spalte. */
function parseForward(raw: string): Message['forwardedFrom'] {
  const [messageId, channelId, userId] = raw.split('|');
  return messageId && channelId && userId ? { messageId, channelId, userId } : null;
}

export function channelHistory(channelId: string, before: string | null, limit: number, viewerId = ''): { messages: Message[]; hasMore: boolean } {
  const rows = before
    ? db.all(
        `SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND id < ?
         ORDER BY created_at DESC LIMIT ?`, channelId, before, limit + 1)
    : db.all(
        `SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL
         ORDER BY created_at DESC LIMIT ?`, channelId, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { messages: hydrateMessages(page.reverse(), viewerId), hasMore };
}

export function threadHistory(parentId: string, viewerId = ''): Message[] {
  const root = db.get('SELECT * FROM messages WHERE id = ?', parentId);
  const replies = db.all('SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at ASC', parentId);
  return hydrateMessages(root ? [root, ...replies] : replies, viewerId);
}

export function pinnedMessages(channelId: string): Message[] {
  return hydrateMessages(db.all(
    'SELECT * FROM messages WHERE channel_id = ? AND pinned = 1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50',
    channelId,
  ));
}

export function savedMessages(userId: string): Message[] {
  return hydrateMessages(db.all(
    `SELECT m.* FROM saved_messages s JOIN messages m ON m.id = s.message_id
     WHERE s.user_id = ? AND m.deleted_at IS NULL ORDER BY s.created_at DESC LIMIT 100`,
    userId,
  ), userId);
}

/* ── Geplante Nachrichten ─────────────────────────────────────── */

export function toScheduled(r: any): ScheduledMessage {
  return {
    id: r.id, channelId: r.channel_id, userId: r.user_id,
    text: entschluesseln(r.text), sendAt: r.send_at, parentId: r.parent_id ?? null, createdAt: r.created_at,
  };
}

export function scheduledFor(userId: string): ScheduledMessage[] {
  return db.all('SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY send_at ASC', userId).map(toScheduled);
}

/**
 * Hängt einer Umfrage die bereits übersetzte Fassung an, falls es eine gibt.
 * Fehlt sie noch, bleibt es beim Original — sie kommt dann als eigenes
 * Ereignis nach, sobald das Modell geantwortet hat.
 */
function mitUebersetzung(poll: ReturnType<typeof pollForMessage>, viewerId: string) {
  if (!poll) return poll;
  const sprache = db.get<{ language: string }>('SELECT language FROM users WHERE id = ?', viewerId)?.language;
  if (!sprache) return poll;
  return { ...poll, translation: cachedPollView(poll.id, sprache) };
}
