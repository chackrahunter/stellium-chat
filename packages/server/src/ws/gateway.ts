import type { WebSocket } from 'ws';
import {
  decode, encode, normalizeLang, WS_PROTOCOL_VERSION,
  type ClientEvent, type Message, type ServerEvent, type Task, type UserStatus,
} from '@stellium/shared';
import { verifyToken } from '../auth.js';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../util/id.js';
import { aiCapabilities, roundTrip, translate, translateMessage, translatePoll, translateChannel } from '../translation/index.js';
import * as ai from '../services/ai.js';
import * as channels from '../services/channels.js';
import * as messages from '../services/messages.js';
import * as store from '../services/store.js';
import * as polls from '../services/polls.js';
import { may } from '../services/users.js';
import { extractMentions, mentionsEveryone, PERMISSIONS, type PermissionKey } from '@stellium/shared';
import * as reminders from '../services/reminders.js';
import * as drafts from '../services/drafts.js';
import { attachPreviews, extractUrls } from '../services/links.js';
import { saveTranscript, transcribe, voiceNoteFor } from '../services/voice.js';
import * as ki from '../services/assistant.js';
import * as tasks from '../services/tasks.js';
import * as settings from '../services/settings.js';
import * as releases from '../services/releases.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import * as events from '../services/events.js';
import * as files from '../services/files.js';
import * as ideas from '../services/ideas.js';
import * as wartung from '../services/wartung.js';
import { db as database } from '../db/index.js';
import { reindexMessage } from '../db/index.js';

interface Session {
  id: string;
  socket: WebSocket;
  userId: string | null;
  language: string;
  autoTranslate: boolean;
  openChannelId: string | null;
  alive: boolean;
}

const sessions = new Map<string, Session>();
const byUser = new Map<string, Set<Session>>();
/** Verhindert doppelte Übersetzungsaufträge für dieselbe Nachricht+Sprache. */
const inflight = new Map<string, Promise<unknown>>();

function send(session: Session, ev: ServerEvent): void {
  if (session.socket.readyState !== 1) return;
  try { session.socket.send(encode(ev)); } catch { /* Socket ist weg */ }
}

function sendToUser(userId: string, ev: ServerEvent): void {
  for (const s of byUser.get(userId) ?? []) send(s, ev);
}

/** Für Ereignisse, die außerhalb des Gateways entstehen (z. B. HTTP-Uploads). */
export function broadcastAll(ev: ServerEvent): void {
  broadcast(ev);
}

/**
 * Darf diese Person die Nachricht überhaupt sehen?
 *
 * Mehrere Ereignisse nehmen eine Nachrichtenkennung entgegen und antworten mit
 * deren Inhalt — übersetzen, Thread öffnen, merken. Ohne diese Prüfung genügte
 * eine bekannte Kennung, um an Nachrichten aus fremden Kanälen und
 * Direktchats zu kommen. Kennungen sind zufällig, aber sie wandern: durch
 * Weiterleitungen, Zitate, Protokolle.
 */
function darfNachrichtSehen(userId: string, messageId: string): boolean {
  const msg = database.get<{ channel_id: string }>(
    'SELECT channel_id FROM messages WHERE id = ?', messageId,
  );
  if (!msg) return false;
  return store.memberIds(msg.channel_id).includes(userId);
}

function broadcast(ev: ServerEvent, userIds?: Iterable<string>): void {
  if (userIds) { for (const uid of userIds) sendToUser(uid, ev); return; }
  for (const s of sessions.values()) if (s.userId) send(s, ev);
}

function fail(session: Session, code: string, message: string, requestId?: string): void {
  send(session, { t: 'error', code, message, requestId });
}

/**
 * Rechteprüfung. Die Oberfläche blendet Dinge zwar aus, aber verlassen darf
 * man sich nur auf das hier — ein eigener Client könnte alles schicken.
 */
function darf(session: Session, permission: PermissionKey): boolean {
  if (!session.userId) return false;
  if (may(session.userId, permission)) return true;
  const info = PERMISSIONS.find((p) => p.key === permission);
  fail(session, 'forbidden', `Dafür fehlt dir das Recht "${info?.labelDe ?? permission}".`);
  return false;
}

function isOnline(userId: string): boolean {
  return (byUser.get(userId)?.size ?? 0) > 0;
}

/* ── Übersetzung für Empfänger ────────────────────────────────── */

/** Füllt Übersetzungen aus dem Cache und meldet, was noch fehlt. */
function fillCachedTranslations(list: Message[], lang: string): Message[] {
  const target = normalizeLang(lang);
  const need: Message[] = [];
  for (const m of list) {
    if (!m.text || m.deletedAt) continue;
    if ((m.sourceLang ?? 'unknown') === target) continue;
    const row = db.get<{ text: string; provider: string; model: string | null; confidence: number | null }>(
      'SELECT text, provider, model, confidence FROM message_translations WHERE message_id = ? AND lang = ?',
      m.id, target,
    );
    if (row) {
      m.translation = { lang: target, text: entschluesseln(row.text), provider: row.provider, model: row.model, confidence: row.confidence, cached: true };
    } else {
      need.push(m);
    }
  }
  return need;
}

/** Übersetzt fehlende Nachrichten im Hintergrund und schiebt sie nach. */
function translateInBackground(list: Message[], lang: string, userId: string, context?: string | null): void {
  const target = normalizeLang(lang);
  let chain = Promise.resolve();
  for (const m of list) {
    const key = `${m.id}:${target}`;
    chain = chain.then(async () => {
      let job = inflight.get(key);
      if (!job) {
        job = translateMessage(m.id, target, { context }).finally(() => inflight.delete(key));
        inflight.set(key, job);
      }
      const view = await job as Awaited<ReturnType<typeof translateMessage>>;
      if (view) sendToUser(userId, { t: 'translation', messageId: m.id, translation: view });
    }).catch((err) => console.error('[ws] Übersetzung fehlgeschlagen:', (err as Error).message));
  }
}

/** Kurzer Gesprächskontext, damit das Modell Anrede und Fachbegriffe trifft. */
function channelContext(channelId: string): string | null {
  const ch = db.get<{ name: string; topic: string | null; purpose: string | null }>(
    'SELECT name, topic, purpose FROM channels WHERE id = ?', channelId,
  );
  if (!ch) return null;
  const parts = [ch.name && `Kanal #${ch.name}`, ch.topic, ch.purpose].filter(Boolean);
  return parts.length ? parts.join(' — ').slice(0, 300) : null;
}

/**
 * Nachricht ausliefern: erst sofort an alle (schnell), dann pro Zielsprache
 * genau einmal übersetzen und das Ergebnis nachschieben.
 */
function deliverMessage(message: Message, senderClientId?: string): void {
  const recipients = new Set(store.memberIds(message.channelId));
  // Öffentliche Kanäle: auch Nicht-Mitglieder, die gerade zuschauen
  for (const s of sessions.values()) {
    if (s.userId && s.openChannelId === message.channelId) recipients.add(s.userId);
  }

  for (const uid of recipients) {
    const payload: ServerEvent = {
      t: 'message:new',
      message,
      ...(uid === message.userId && senderClientId ? { clientId: senderClientId } : {}),
    };
    sendToUser(uid, payload);
    const state = store.channelState(message.channelId, uid);
    if (state) sendToUser(uid, { t: 'channel:state', state });
  }

  // Zielsprachen einsammeln (nur für Leute, die auto-translate anhaben)
  const sourceLang = message.sourceLang ?? 'unknown';
  const langs = new Map<string, string[]>();
  for (const uid of recipients) {
    if (uid === message.userId) continue;
    const u = db.get<{ language: string; auto_translate: number; role: string }>(
      'SELECT language, auto_translate, role FROM users WHERE id = ?', uid,
    );
    // Für Bots übersetzen wäre verschenkte Rechenzeit — sie lesen nichts.
    if (!u || !u.auto_translate || u.role === 'bot') continue;
    const target = normalizeLang(u.language);
    if (target === sourceLang) continue;
    langs.set(target, [...(langs.get(target) ?? []), uid]);
  }

  // Eine Umfrage steht nicht im Nachrichtentext, sondern in eigenen Zeilen.
  // Ohne diesen Anstoß bliebe sie mitten im übersetzten Gespräch deutsch.
  if (message.poll) {
    for (const [target, users] of langs) {
      void translatePoll(message.poll.id, target, { sourceLang: message.sourceLang })
        .then((sicht) => {
          if (!sicht) return;
          for (const uid of users) {
            const poll = polls.getPoll(message.poll!.id, uid);
            if (poll) sendToUser(uid, { t: 'poll:updated', poll: { ...poll, translation: sicht }, channelId: message.channelId });
          }
        })
        .catch((err) => console.error('[ws] Umfrage-Übersetzung:', (err as Error).message));
    }
  }

  const context = channelContext(message.channelId);
  for (const [target, users] of langs) {
    const key = `${message.id}:${target}`;
    let job = inflight.get(key);
    if (!job) {
      job = translateMessage(message.id, target, { context }).finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    void job
      .then((view) => {
        if (!view) return;
        for (const uid of users) sendToUser(uid, { t: 'translation', messageId: message.id, translation: view as any });
      })
      .catch((err) => console.error('[ws] Übersetzung fehlgeschlagen:', (err as Error).message));
  }
}

/* ── Presence ─────────────────────────────────────────────────── */

function setStatus(
  userId: string, status: UserStatus,
  emoji?: string | null, text?: string | null, expiresAt?: number | null,
): void {
  const sets = ['status = ?', 'last_seen_at = ?'];
  const vals: any[] = [status, Date.now()];
  if (emoji !== undefined) { sets.push('status_emoji = ?'); vals.push(emoji); }
  if (text !== undefined) { sets.push('status_text = ?'); vals.push(text); }
  if (expiresAt !== undefined) { sets.push('status_expires_at = ?'); vals.push(expiresAt); }
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, userId);

  const u = store.getUser(userId);
  if (u) {
    broadcast({
      t: 'presence', userId, status: u.status,
      statusEmoji: u.statusEmoji, statusText: u.statusText,
      statusExpiresAt: u.statusExpiresAt, lastSeenAt: u.lastSeenAt,
    });
  }
}

/* ── Verbindungsaufbau ────────────────────────────────────────── */

export function handleConnection(socket: WebSocket): void {
  const session: Session = {
    id: newId('s_'), socket, userId: null, language: 'en',
    autoTranslate: true, openChannelId: null, alive: true,
  };
  sessions.set(session.id, session);

  const authTimer = setTimeout(() => {
    if (!session.userId) { fail(session, 'auth_timeout', 'Keine Anmeldung innerhalb von 10 Sekunden'); socket.close(); }
  }, 10_000);

  socket.on('message', (raw: Buffer | string) => {
    const ev = decode<ClientEvent>(raw.toString());
    if (!ev || typeof ev.t !== 'string') return;
    if (ev.t === 'auth') {
      clearTimeout(authTimer);
      // Ohne dieses catch würde ein Fehler beim Anmelden — eine hakende
      // Datenbank genügt — als unbehandelte Zurückweisung den ganzen Server
      // mitreißen, mitsamt allen anderen Verbindungen.
      void authenticate(session, ev).catch((err) => {
        console.error('[ws] Anmeldung:', (err as Error).message);
        fail(session, 'auth_failed', 'Anmeldung fehlgeschlagen. Bitte noch einmal versuchen.');
        session.socket.close();
      });
      return;
    }
    if (!session.userId) { fail(session, 'unauthorized', 'Bitte zuerst anmelden'); return; }
    void handleEvent(session, ev).catch((err) => {
      console.error('[ws]', ev.t, (err as Error).message);
      fail(session, 'handler_error', (err as Error).message, (ev as any).requestId);
    });
  });

  socket.on('pong', () => { session.alive = true; });

  socket.on('close', () => {
    clearTimeout(authTimer);
    sessions.delete(session.id);
    if (session.userId) {
      const set = byUser.get(session.userId);
      set?.delete(session);
      if (set && set.size === 0) {
        byUser.delete(session.userId);
        setStatus(session.userId, 'offline');
      }
    }
  });

  socket.on('error', () => { /* close folgt */ });
}

async function authenticate(session: Session, ev: Extract<ClientEvent, { t: 'auth' }>): Promise<void> {
  if (ev.protocol !== WS_PROTOCOL_VERSION) {
    fail(session, 'protocol_mismatch', `Client-Protokoll ${ev.protocol}, Server erwartet ${WS_PROTOCOL_VERSION}. Bitte App aktualisieren.`);
    session.socket.close();
    return;
  }
  const userId = verifyToken(ev.token);
  if (!userId) { fail(session, 'invalid_token', 'Anmeldung abgelaufen'); session.socket.close(); return; }

  const self = store.getSelf(userId);
  if (!self) { fail(session, 'unknown_user', 'Konto existiert nicht mehr'); session.socket.close(); return; }

  session.userId = userId;
  session.language = normalizeLang(self.language);
  session.autoTranslate = self.autoTranslate;

  const set = byUser.get(userId) ?? new Set<Session>();
  const wasOffline = set.size === 0;
  set.add(session);
  byUser.set(userId, set);

  send(session, {
    t: 'ready',
    self,
    users: store.listUsers().map((u) => ({ ...u, status: isOnline(u.id) ? u.status : 'offline' })),
    channels: store.visibleChannels(userId),
    states: store.channelStates(userId),
    scheduled: store.scheduledFor(userId),
    reminders: reminders.remindersFor(userId),
    drafts: drafts.draftsFor(userId),
    serverTime: Date.now(),
    serverVersion: config.version,
    /* Auch ohne Verwaltungsrecht soll jeder sehen, dass gleich neu gestartet
       wird — die Liste der Fassungen bekommt nur die Verwaltung zu sehen. */
    serverUpdate: (() => {
      const bereit = releases.getRelease('server');
      return bereit && releases.istNeuer(bereit.version, config.version) ? bereit.version : null;
    })(),
    ai: aiCapabilities(),
  });

  // Steht eine Auszeit an, soll auch wer gerade erst kommt sie sehen.
  const auszeit = wartung.anstehend();
  if (auszeit) {
    send(session, {
      t: 'server:update',
      ...auszeit,
      serverZeit: Date.now(),
    });
  }

  if (wasOffline) setStatus(userId, self.status === 'offline' ? 'online' : self.status);

  // Kanalnamen und -themen in die Lesesprache bringen. Im Hintergrund, damit
  // die Oberfläche sofort steht; die Übersetzungen kommen nach.
  if (self.autoTranslate) {
    for (const kanal of store.visibleChannels(userId)) {
      if (kanal.kind === 'dm' || kanal.translation) continue;
      void kanalUebersetzungNachreichen(kanal.id, userId);
    }
  }
}

/* ── Event-Dispatch ───────────────────────────────────────────── */

async function handleEvent(session: Session, ev: ClientEvent): Promise<void> {
  const userId = session.userId!;

  switch (ev.t) {
    case 'ping':
      send(session, { t: 'pong', ts: ev.ts });
      return;

    case 'channel:open': {
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'not_found', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'forbidden', 'Kein Zugriff auf diesen Kanal');
      }
      session.openChannelId = ch.id;

      /* Math.min allein reicht nicht: eine negative Zahl kommt kleiner durch
         und wird in SQL zu LIMIT -1 — das liefert den ganzen Kanal auf einmal. */
      const wieviele = Math.min(Math.max(Math.trunc(ev.limit ?? 50) || 50, 1), 100);
      const { messages: list, hasMore } = store.channelHistory(ch.id, ev.before ?? null, wieviele, userId);
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language) : [];
      send(session, { t: 'channel:history', channelId: ch.id, messages: list, hasMore });
      if (missing.length) translateInBackground(missing, session.language, userId, channelContext(ch.id));
      return;
    }

    case 'channel:create': {
      if (!darf(session, ev.kind === 'private' ? 'channel.create_private' : 'channel.create')) return;
      const ch = channels.createChannel({
        kind: ev.kind, name: ev.name, topic: ev.topic ?? null,
        primaryLanguage: ev.primaryLanguage ?? null, createdBy: userId, memberIds: ev.memberIds,
      });
      const audience = ev.kind === 'public' ? undefined : ch.memberIds;
      broadcast({ t: 'channel:upsert', channel: ch }, audience);
      for (const uid of ch.memberIds) {
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      return;
    }

    case 'channel:join': {
      const ch = channels.joinChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:upsert', channel: ch });
      const st = store.channelState(ch.id, userId);
      if (st) sendToUser(userId, { t: 'channel:state', state: st });
      const sys = messages.createMessage({
        channelId: ch.id, userId, text: `@${store.getUser(userId)?.handle} ist dem Kanal beigetreten`, systemKind: 'join',
      });
      deliverMessage(sys);
      return;
    }

    case 'channel:leave':
      channels.leaveChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:removed', channelId: ev.channelId });
      return;

    case 'channel:update': {
      // Nach einer Änderung sind alte Übersetzungen hinfällig; die Prüfsumme
      // sorgt dafür, dass sie beim nächsten Anfassen neu entstehen.
      if (!darf(session, ev.archived !== undefined ? 'channel.archive' : 'channel.manage')) return;
      const ch = channels.updateChannel(ev.channelId, {
        name: ev.name, topic: ev.topic, purpose: ev.purpose,
        primaryLanguage: ev.primaryLanguage, archived: ev.archived, readOnly: ev.readOnly,
      });
      if (ch) broadcast({ t: 'channel:upsert', channel: ch }, ch.kind === 'public' ? undefined : ch.memberIds);
      return;
    }

    case 'channel:delete': {
      if (!darf(session, 'channel.delete')) return;
      const betroffen = store.memberIds(ev.channelId);
      const info = channels.deleteChannel(ev.channelId);
      broadcast({ t: 'channel:removed', channelId: ev.channelId }, betroffen);
      console.log(`[kanal] #${info.name} gelöscht (${info.messages} Nachrichten) von ${userId}`);
      return;
    }

    case 'channel:hide': {
      channels.hideChannel(ev.channelId, userId);
      sendToUser(userId, { t: 'channel:removed', channelId: ev.channelId });
      return;
    }

    case 'channel:members': {
      if (!darf(session, 'channel.members')) return;
      const ch = channels.setMembers(ev.channelId, ev.add ?? [], ev.remove ?? []);
      // Neue Mitglieder brauchen den Kanal, entfernte sollen ihn verlieren.
      for (const uid of ch.memberIds) {
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ch.id, uid)! });
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      for (const uid of ev.remove ?? []) {
        if (!ch.memberIds.includes(uid)) sendToUser(uid, { t: 'channel:removed', channelId: ch.id });
      }
      return;
    }

    case 'channel:mute': {
      channels.setMuted(ev.channelId, userId, ev.muted);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      return;
    }

    case 'channel:star': {
      channels.setStarred(ev.channelId, userId, ev.starred);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      return;
    }

    case 'dm:open': {
      if (!darf(session, 'dm.start')) return;
      const ch = channels.openDm(userId, ev.userId);
      for (const uid of ch.memberIds) {
        sendToUser(uid, { t: 'channel:upsert', channel: store.getChannel(ch.id, uid)! });
        const st = store.channelState(ch.id, uid);
        if (st) sendToUser(uid, { t: 'channel:state', state: st });
      }
      session.openChannelId = ch.id;
      const { messages: list, hasMore } = store.channelHistory(ch.id, null, 50, userId);
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language) : [];
      send(session, { t: 'channel:history', channelId: ch.id, messages: list, hasMore });
      if (missing.length) translateInBackground(missing, session.language, userId, null);
      return;
    }

    case 'message:send': {
      if (!darf(session, 'message.send')) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'not_found', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'forbidden', 'Kein Zugriff auf diesen Kanal');
      }
      if (ch.kind === 'public') channels.ensureMember(ch.id, userId);

      // Ankündigungskanäle: nur wer sie verwalten darf, schreibt auch hinein.
      if (ch.readOnly && !may(userId, 'channel.manage')) {
        return fail(session, 'forbidden', 'In diesen Kanal schreibt nur die Kanalverwaltung.');
      }

      // Wer einen Chat ausgeblendet hat, soll ihn bei neuer Aktivität wiedersehen.
      channels.unhideForAll(ch.id);

      // Erwähnungen sind ein eigenes Recht: wer es nicht hat, soll das auch
      // erfahren, statt dass die Benachrichtigung still verschluckt wird.
      const darfErwaehnen = may(userId, 'mention.user');
      const darfAlle = may(userId, 'mention.everyone');
      if (!darfErwaehnen && extractMentions(ev.text).length > 0) {
        return fail(session, 'forbidden', 'Dafür fehlt dir das Recht "Personen erwähnen".');
      }
      if (!darfAlle && mentionsEveryone(ev.text)) {
        return fail(session, 'forbidden', 'Dafür fehlt dir das Recht "Alle erwähnen".');
      }

      const msg = messages.createMessage({
        channelId: ch.id, userId, text: ev.text, parentId: ev.parentId ?? null,
        attachmentIds: ev.attachmentIds, sourceLang: ev.sourceLang ?? null,
        mayMention: darfErwaehnen, mayMentionEveryone: darfAlle,
      });
      messages.markRead(ch.id, userId, msg.id);
      deliverMessage(msg, ev.clientId);
      enrichLinks(msg.id, msg.text, ch.id);
      vielleichtAntworten(ch.id, msg.text, userId);
      return;
    }

    case 'message:edit': {
      if (!darf(session, 'message.edit_own')) return;
      if (!may(userId, 'mention.user') && extractMentions(ev.text).length > 0) {
        return fail(session, 'forbidden', 'Dafür fehlt dir das Recht "Personen erwähnen".');
      }
      const msg = messages.editMessage(ev.messageId, userId, ev.text);
      broadcast({ t: 'message:updated', message: msg }, store.memberIds(msg.channelId));
      // Neu übersetzen für alle, die zuschauen
      const targets = new Set<string>();
      for (const uid of store.memberIds(msg.channelId)) {
        if (uid === userId || !isOnline(uid)) continue;
        const u = store.getUser(uid);
        if (u?.autoTranslate) targets.add(normalizeLang(u.language));
      }
      for (const lang of targets) {
        void translateMessage(msg.id, lang, { force: true, context: channelContext(msg.channelId) })
          .then((view) => {
            if (!view) return;
            for (const uid of store.memberIds(msg.channelId)) {
              const u = store.getUser(uid);
              if (u && u.autoTranslate && normalizeLang(u.language) === lang) {
                sendToUser(uid, { t: 'translation', messageId: msg.id, translation: view });
              }
            }
          })
          .catch(() => { /* Original bleibt sichtbar */ });
      }
      return;
    }

    case 'message:delete': {
      const scope = ev.scope ?? 'all';
      const eigene = store.getMessage(ev.messageId)?.userId === userId;
      // Für sich ausblenden darf jede:r immer — das ändert nichts für andere.
      if (scope === 'all' && !darf(session, eigene ? 'message.delete_own' : 'message.delete_any')) return;

      const ergebnis = messages.deleteMessage(ev.messageId, userId, may(userId, 'message.delete_any'), scope);
      if (ergebnis.scope === 'me') {
        // Nur die eigene Ansicht ändert sich.
        send(session, { t: 'message:deleted', messageId: ev.messageId, channelId: ergebnis.channelId });
      } else {
        broadcast({ t: 'message:deleted', messageId: ev.messageId, channelId: ergebnis.channelId },
          store.memberIds(ergebnis.channelId));
      }
      return;
    }

    case 'message:react': {
      if (!darf(session, 'reaction.add')) return;
      const { channelId } = messages.toggleReaction(ev.messageId, userId, ev.emoji);
      const msg = store.getMessage(ev.messageId);
      if (msg) broadcast({ t: 'reaction:updated', messageId: msg.id, channelId, reactions: msg.reactions }, store.memberIds(channelId));
      return;
    }

    case 'message:pin': {
      if (!darf(session, 'message.pin')) return;
      const msg = messages.setPinned(ev.messageId, ev.pinned);
      if (msg) broadcast({ t: 'message:updated', message: msg }, store.memberIds(msg.channelId));
      return;
    }

    case 'message:save':
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'forbidden', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      messages.setSaved(ev.messageId, userId, ev.saved);
      return;

    case 'message:schedule': {
      if (!darf(session, 'message.schedule')) return;
      // Ohne diese Prüfung ließe sich in jeden Kanal schreiben — auch in
      // private und in fremde Direktchats. Nur eben zeitversetzt.
      if (!store.getChannel(ev.channelId, userId) || !store.isMember(ev.channelId, userId)) {
        return fail(session, 'forbidden', 'Kein Zugriff auf diesen Kanal');
      }
      const id = messages.scheduleMessage({
        channelId: ev.channelId, userId, text: ev.text, sendAt: ev.sendAt, parentId: ev.parentId ?? null,
      });
      const item = db.get('SELECT * FROM scheduled_messages WHERE id = ?', id);
      if (item) send(session, { t: 'scheduled:upsert', item: store.toScheduled(item) });
      return;
    }

    case 'message:unschedule':
      if (messages.cancelScheduled(ev.scheduledId, userId)) {
        sendToUser(userId, { t: 'scheduled:removed', scheduledId: ev.scheduledId });
      }
      return;

    case 'thread:open': {
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'forbidden', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const list = store.threadHistory(ev.messageId, userId);
      if (!list.length) return fail(session, 'not_found', 'Thread nicht gefunden');
      const missing = session.autoTranslate ? fillCachedTranslations(list, session.language) : [];
      send(session, { t: 'thread:history', parentId: ev.messageId, channelId: list[0].channelId, messages: list });
      if (missing.length) translateInBackground(missing, session.language, userId, channelContext(list[0].channelId));
      return;
    }

    case 'typing': {
      const audience = store.memberIds(ev.channelId).filter((uid) => uid !== userId);
      broadcast({ t: 'typing', channelId: ev.channelId, userId, parentId: ev.parentId ?? null }, audience);
      return;
    }

    case 'read': {
      messages.markRead(ev.channelId, userId, ev.lastMessageId);
      const st = store.channelState(ev.channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      broadcast({ t: 'read', channelId: ev.channelId, userId, lastMessageId: ev.lastMessageId },
        store.memberIds(ev.channelId).filter((uid) => uid !== userId));
      return;
    }

    case 'presence:set':
      setStatus(userId, ev.status, ev.statusEmoji, ev.statusText, ev.statusExpiresAt);
      return;

    case 'prefs:update': {
      const map: Record<string, string> = {
        language: 'language', autoTranslate: 'auto_translate', notifyOn: 'notify_on',
        theme: 'theme', density: 'density', composeTargetPreview: 'compose_target_preview',
        quietHoursStart: 'quiet_hours_start', quietHoursEnd: 'quiet_hours_end',
        displayName: 'display_name', title: 'title', timezone: 'timezone',
      };
      const sets: string[] = [];
      const vals: any[] = [];
      for (const [key, value] of Object.entries(ev.patch)) {
        const col = map[key];
        if (!col) continue;
        sets.push(`${col} = ?`);
        vals.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      }
      if (!sets.length) return;
      db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, userId);

      const self = store.getSelf(userId)!;
      session.language = normalizeLang(self.language);
      session.autoTranslate = self.autoTranslate;
      for (const s of byUser.get(userId) ?? []) {
        s.language = session.language;
        s.autoTranslate = session.autoTranslate;
        send(s, { t: 'self:updated', self });
      }
      broadcast({ t: 'user:upsert', user: store.getUser(userId)! });

      // Sprache gewechselt -> offenen Kanal in der neuen Sprache nachliefern
      if (ev.patch.language && session.openChannelId) {
        const { messages: list } = store.channelHistory(session.openChannelId, null, 50);
        const missing = fillCachedTranslations(list, session.language);
        for (const m of list) {
          if (m.translation) send(session, { t: 'translation', messageId: m.id, translation: m.translation });
        }
        if (missing.length) translateInBackground(missing, session.language, userId, channelContext(session.openChannelId));

        // Umfragen stehen nicht im Nachrichtentext und blieben sonst in der
        // alten Sprache stehen, während ringsum alles gewechselt hat.
        for (const m of list) {
          if (!m.poll) continue;
          void pollUebersetzungNachreichen(m.poll.id, userId, session.openChannelId);
        }
      }

      // Dasselbe für die Kanäle selbst — Name, Thema, Zweck.
      if (ev.patch.language) {
        for (const kanal of store.visibleChannels(userId)) {
          if (kanal.kind === 'dm') continue;
          void kanalUebersetzungNachreichen(kanal.id, userId);
        }
      }
      return;
    }

    case 'translate:request': {
      if (!darf(session, 'ai.translate')) return;
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'forbidden', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const view = await translateMessage(ev.messageId, ev.targetLang, { force: ev.force });
      if (view) send(session, { t: 'translation', messageId: ev.messageId, translation: view });
      else fail(session, 'no_translation', 'Keine Übersetzung nötig oder möglich');
      return;
    }

    case 'translate:roundtrip': {
      if (!darf(session, 'ai.translate')) return;
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'forbidden', 'Zu dieser Nachricht hast du keinen Zugang.');
      }
      const result = await roundTrip(ev.messageId, ev.targetLang);
      if (!result) return fail(session, 'no_translation', 'Für diese Nachricht liegt keine Übersetzung vor');
      send(session, { t: 'roundtrip', messageId: ev.messageId, targetLang: ev.targetLang, ...result });
      return;
    }

    case 'compose:preview': {
      if (!darf(session, 'ai.translate')) return;
      const outcome = await translate({
        text: ev.text, targetLang: ev.targetLang, context: channelContext(ev.channelId),
      });
      send(session, {
        t: 'compose:preview', requestId: ev.requestId,
        text: outcome.text, targetLang: ev.targetLang, sourceLang: outcome.sourceLang,
      });
      return;
    }

    case 'ai:catchup': {
      if (!darf(session, 'ai.assistant')) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'not_found', 'Kanal nicht gefunden', ev.requestId);
      const state = store.channelState(ev.channelId, userId);
      const summary = await ai.catchUp({
        channelId: ev.channelId,
        sinceMessageId: ev.sinceMessageId ?? state?.lastReadMessageId ?? null,
        language: session.language,
        channelName: channels.channelLabel(ch, userId, (id) => store.getUser(id)?.displayName ?? 'Unbekannt'),
      });
      send(session, { t: 'ai:catchup', requestId: ev.requestId, summary });
      return;
    }

    case 'ai:thread-summary': {
      if (!darf(session, 'ai.assistant')) return;
      /* Ohne diese Prüfung ließe sich jeder Thread zusammenfassen, dessen
         Kennung man kennt — auch aus einem Kanal, in dem man nichts verloren
         hat. Die Zusammenfassung gäbe den Inhalt dann wieder. */
      if (!darfNachrichtSehen(userId, ev.messageId)) {
        return fail(session, 'not_found', 'Nachricht nicht gefunden', ev.requestId);
      }
      const summary = await ai.summarizeThread(ev.messageId, session.language);
      send(session, { t: 'ai:thread-summary', requestId: ev.requestId, messageId: ev.messageId, summary });
      return;
    }

    case 'ai:smart-replies': {
      if (!darf(session, 'ai.assistant')) return;
      // Vorschläge entstehen aus dem Verlauf — also nur, wo man mitliest.
      if (!store.getChannel(ev.channelId, userId)) {
        return fail(session, 'not_found', 'Kanal nicht gefunden', ev.requestId);
      }
      const self = store.getSelf(userId)!;
      const replies = await ai.smartReplies({
        channelId: ev.channelId, parentId: ev.parentId ?? null,
        language: session.language, selfName: self.displayName,
      });
      send(session, { t: 'ai:smart-replies', requestId: ev.requestId, replies });
      return;
    }

    case 'ai:rewrite': {
      if (!darf(session, 'ai.assistant')) return;
      const text = await ai.rewrite({ text: ev.text, tone: ev.tone, targetLang: ev.targetLang ?? null });
      send(session, { t: 'ai:rewrite', requestId: ev.requestId, text });
      return;
    }

    /* ── Umfragen ─────────────────────────────────────────── */

    case 'poll:create': {
      if (!darf(session, 'poll.create')) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'not_found', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'forbidden', 'Kein Zugriff auf diesen Kanal');
      }
      const msg = messages.createMessage({
        channelId: ch.id, userId, text: ev.question.trim(),
        parentId: ev.parentId ?? null, kind: 'poll',
      });
      polls.createPoll({
        messageId: msg.id, question: ev.question, options: ev.options,
        multiple: ev.multiple, anonymous: ev.anonymous, closesAt: ev.closesAt ?? null, userId,
      });
      // Neu laden, damit die Umfrage dranhängt.
      deliverMessage(store.getMessage(msg.id, userId)!, ev.clientId);
      return;
    }

    case 'poll:vote': {
      // Eine Umfrage hängt an einer Nachricht — wer die nicht sehen darf,
      // stimmt auch nicht mit ab.
      const zugehoerig = database.get<{ message_id: string }>(
        'SELECT message_id FROM polls WHERE id = ?', ev.pollId,
      );
      if (!zugehoerig || !darfNachrichtSehen(userId, zugehoerig.message_id)) {
        return fail(session, 'forbidden', 'Zu dieser Umfrage hast du keinen Zugang.');
      }
      polls.vote(ev.pollId, userId, ev.optionIds);
      broadcastPoll(ev.pollId);
      return;
    }

    case 'poll:close': {
      polls.closePoll(ev.pollId, userId, may(userId, 'poll.close_any'));
      broadcastPoll(ev.pollId);
      return;
    }

    /* ── Weiterleiten ─────────────────────────────────────── */

    case 'message:forward': {
      if (!darf(session, 'message.forward')) return;
      const original = store.getMessage(ev.messageId, userId);
      if (!original) return fail(session, 'not_found', 'Nachricht nicht gefunden');
      const target = store.getChannel(ev.toChannelId, userId);
      if (!target) return fail(session, 'not_found', 'Zielkanal nicht gefunden');
      if (target.kind !== 'public' && !store.isMember(target.id, userId)) {
        return fail(session, 'forbidden', 'Kein Zugriff auf den Zielkanal');
      }
      if (!store.isMember(original.channelId, userId) && store.getChannel(original.channelId)?.kind !== 'public') {
        return fail(session, 'forbidden', 'Kein Zugriff auf die Ursprungsnachricht');
      }

      const text = [ev.comment?.trim(), original.text].filter(Boolean).join('\n\n');
      const msg = messages.createMessage({
        channelId: target.id, userId, text,
        forwardedFrom: `${original.id}|${original.channelId}|${original.userId}`,
      });
      deliverMessage(msg, ev.clientId);
      enrichLinks(msg.id, msg.text, target.id);
      return;
    }

    /* ── Erinnerungen ─────────────────────────────────────── */

    case 'reminder:create': {
      const reminder = reminders.createReminder({
        userId, channelId: ev.channelId, messageId: ev.messageId ?? null,
        note: ev.note ?? null, remindAt: ev.remindAt,
      });
      send(session, { t: 'reminder:upsert', reminder });
      return;
    }

    case 'reminder:cancel':
      if (reminders.cancel(ev.reminderId, userId)) {
        sendToUser(userId, { t: 'reminder:removed', reminderId: ev.reminderId });
      }
      return;

    case 'reminder:done':
      if (reminders.markDone(ev.reminderId, userId)) {
        sendToUser(userId, { t: 'reminder:removed', reminderId: ev.reminderId });
      }
      return;

    /* ── Entwürfe ─────────────────────────────────────────── */

    case 'draft:save':
      drafts.saveDraft(userId, ev.channelId, ev.parentId ?? null, ev.text);
      return;

    /* ── Sprachnachrichten ────────────────────────────────── */

    case 'voice:send': {
      if (!darf(session, 'voice.send')) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'not_found', 'Kanal nicht gefunden');
      if (ch.kind !== 'public' && !store.isMember(ch.id, userId)) {
        return fail(session, 'forbidden', 'Kein Zugriff auf diesen Kanal');
      }
      const msg = messages.createMessage({
        channelId: ch.id, userId, text: '🎙️ Sprachnachricht',
        parentId: ev.parentId ?? null, attachmentIds: [ev.attachmentId], kind: 'voice',
      });
      messages.markRead(ch.id, userId, msg.id);
      deliverMessage(msg, ev.clientId);
      void runTranscription(msg.id, ev.attachmentId).catch((err) => console.error('[ws] Umschrift:', (err as Error).message));
      return;
    }

    /* ── KI als Gesprächspartner ──────────────────────────── */

    case 'ai:open-chat': {
      if (!darf(session, 'ai.assistant')) return;
      const channelId = ki.openPrivateChat(userId);
      const ch = store.getChannel(channelId, userId)!;
      send(session, { t: 'channel:upsert', channel: ch });
      const st = store.channelState(channelId, userId);
      if (st) send(session, { t: 'channel:state', state: st });
      session.openChannelId = channelId;
      const { messages: list, hasMore } = store.channelHistory(channelId, null, 50, userId);
      send(session, { t: 'channel:history', channelId, messages: list, hasMore });
      // Ohne diese Zeile lädt der Kanal im Hintergrund und die Ansicht bleibt,
      // wo sie war — der Klick sähe aus, als hätte er nichts bewirkt.
      send(session, { t: 'channel:focus', channelId });
      return;
    }

    case 'ai:open-team-channel': {
      if (!darf(session, 'ai.assistant')) return;
      const self = store.getSelf(userId);
      const channelId = ki.ensureTeamChannel(self?.id ?? userId);
      channels.ensureMember(channelId, userId);
      const ch = store.getChannel(channelId, userId)!;
      broadcast({ t: 'channel:upsert', channel: ch });
      const zustand = store.channelState(channelId, userId);
      if (zustand) send(session, { t: 'channel:state', state: zustand });
      session.openChannelId = channelId;
      const { messages: list, hasMore } = store.channelHistory(channelId, null, 50, userId);
      send(session, { t: 'channel:history', channelId, messages: list, hasMore });
      send(session, { t: 'channel:focus', channelId });
      return;
    }

    case 'ai:set-mode': {
      if (!darf(session, 'channel.manage')) return;
      ki.setAiMode(ev.channelId, ev.mode);
      const ch = store.getChannel(ev.channelId, userId);
      if (ch) broadcast({ t: 'channel:upsert', channel: ch }, ch.kind === 'public' ? undefined : ch.memberIds);
      return;
    }

    /* ── Aufgaben ─────────────────────────────────────────── */

    case 'task:list':
      send(session, {
        t: 'task:list',
        tasks: tasks.listTasks({ channelId: ev.channelId, assigneeId: ev.assigneeId }),
      });
      return;

    case 'task:create': {
      if (!darf(session, 'task.create')) return;
      if (ev.assigneeId && ev.assigneeId !== userId && !may(userId, 'task.assign')) {
        return fail(session, 'forbidden', 'Aufgaben an andere zu übergeben ist ein eigenes Recht.');
      }
      const task = tasks.createTask({ ...ev, createdBy: userId });
      // Alle Beteiligten sollen die Aufgabe sofort sehen.
      broadcastTask(task);
      return;
    }

    case 'task:update': {
      if (!darf(session, 'task.create')) return;
      const vorher = tasks.getTask(ev.taskId);
      if (!vorher) return fail(session, 'not_found', 'Aufgabe nicht gefunden.');
      if (ev.patch.assigneeId !== undefined && ev.patch.assigneeId !== userId && !may(userId, 'task.assign')) {
        return fail(session, 'forbidden', 'Aufgaben an andere zu übergeben ist ein eigenes Recht.');
      }
      broadcastTask(tasks.updateTask(ev.taskId, ev.patch, userId));
      return;
    }

    case 'task:move': {
      if (!darf(session, 'task.create')) return;
      broadcastTask(tasks.reorder(ev.taskId, ev.status, ev.afterId ?? null, userId));
      return;
    }

    case 'task:comment': {
      const verlauf = tasks.addComment(ev.taskId, userId, ev.text);
      send(session, { t: 'task:history', taskId: ev.taskId, events: verlauf });
      const task = tasks.getTask(ev.taskId);
      if (task) broadcastTask(task);
      return;
    }

    case 'task:watch':
      broadcastTask(tasks.setWatching(ev.taskId, userId, ev.watching));
      return;

    case 'task:delete': {
      const task = tasks.getTask(ev.taskId);
      if (!task) return;
      const eigene = task.createdBy === userId;
      if (!eigene && !may(userId, 'task.delete')) {
        return fail(session, 'forbidden', 'Fremde Aufgaben darf nur die Moderation löschen.');
      }
      tasks.deleteTask(ev.taskId);
      broadcast({ t: 'task:removed', taskId: ev.taskId });
      return;
    }

    case 'task:history':
      send(session, { t: 'task:history', taskId: ev.taskId, events: tasks.historyOf(ev.taskId) });
      return;

    case 'ai:extract-tasks': {
      if (!darf(session, 'ai.assistant')) return;
      // Aufgaben entstehen aus dem Verlauf des Kanals — nur aus einem eigenen.
      if (!store.getChannel(ev.channelId, userId)) {
        return fail(session, 'not_found', 'Kanal nicht gefunden', ev.requestId);
      }
      /* Nur das Neue seit dem letzten Durchgang ansehen. */
      const marke = `aufgaben_ab:${ev.channelId}`;
      const seit = settings.getSetting(marke);
      const gefunden = await ai.extractTasks({
        channelId: ev.channelId,
        language: session.language,
        sinceMessageId: seit,
      });
      const neuste = database.get<{ id: string }>(
        'SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1', ev.channelId,
      )?.id;

      /* Früher bekam man eine Liste zum Ankreuzen. Gewünscht ist, dass die
         Erkennung die Aufgaben gleich anlegt — bestätigt wird nur noch, dass
         es passiert ist. Was im Kanal schon offen steht, entsteht nicht
         zweimal, sonst füllt jeder Klick das Brett mit Dubletten. */
      const erstellt: Task[] = [];
      let uebersprungen = 0;
      if (gefunden.length && may(userId, 'task.create')) {
        const darfZuweisen = may(userId, 'task.assign');
        const bekannt = new Set(
          tasks.listTasks({ channelId: ev.channelId, includeFinished: false })
            .map((a) => a.title.trim().toLowerCase()),
        );
        for (const vorschlag of gefunden) {
          const schluessel = vorschlag.title.trim().toLowerCase();
          if (bekannt.has(schluessel)) { uebersprungen++; continue; }
          try {
            const task = tasks.createTask({
              title: vorschlag.title,
              // Ohne das Recht zum Zuweisen landet sie beim Auslöser selbst.
              assigneeId: darfZuweisen ? vorschlag.assigneeId : null,
              dueAt: vorschlag.dueAt,
              channelId: ev.channelId,
              createdBy: userId,
            });
            bekannt.add(schluessel);
            broadcastTask(task);
            erstellt.push(task);
          } catch {
            uebersprungen++;
          }
        }
      }

      // Erst nach dem Anlegen merken — bricht etwas ab, wird beim nächsten
      // Mal derselbe Abschnitt noch einmal gelesen statt übersprungen.
      if (neuste) settings.setSetting(marke, neuste, userId);

      send(session, {
        t: 'ai:extract-tasks', requestId: ev.requestId,
        tasks: gefunden, erstellt, uebersprungen,
      });
      return;
    }

    case 'ai:protocol': {
      if (!darf(session, 'ai.assistant')) return;
      const kanal = store.getChannel(ev.channelId, userId);
      if (!kanal) return fail(session, 'not_found', 'Kanal nicht gefunden.');
      send(session, {
        t: 'ai:protocol',
        protocol: await ai.protokoll({
          channelId: ev.channelId,
          channelName: kanal.name,
          language: session.language,
          sinceMessageId: ev.sinceMessageId ?? null,
        }),
      });
      return;
    }

    /* ── Kalender ─────────────────────────────────────────── */

    case 'event:list':
      send(session, { t: 'event:list', events: events.listEvents(ev.from, ev.to) });
      return;

    case 'event:create': {
      if (!darf(session, 'event.create')) return;
      const termin = events.createEvent({ ...ev, createdBy: userId });
      broadcast({ t: 'event:upsert', event: termin });
      return;
    }

    case 'event:update': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return fail(session, 'not_found', 'Termin nicht gefunden.');
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'forbidden', 'Fremde Termine darf nur die Verwaltung ändern.');
      }
      broadcast({ t: 'event:upsert', event: events.updateEvent(ev.eventId, ev.patch) });
      return;
    }

    case 'event:respond':
      broadcast({ t: 'event:upsert', event: events.respond(ev.eventId, userId, ev.response) });
      return;

    case 'event:attendees': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return;
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'forbidden', 'Nur wer eingeladen hat, ändert die Teilnehmenden.');
      }
      broadcast({ t: 'event:upsert', event: events.setAttendees(ev.eventId, ev.add, ev.remove) });
      return;
    }

    case 'event:delete': {
      const termin = events.getEvent(ev.eventId);
      if (!termin) return;
      if (termin.createdBy !== userId && !may(userId, 'event.manage')) {
        return fail(session, 'forbidden', 'Fremde Termine darf nur die Verwaltung löschen.');
      }
      events.deleteEvent(ev.eventId);
      broadcast({ t: 'event:removed', eventId: ev.eventId });
      return;
    }

    /* ── Ideenboard ───────────────────────────────────────── */

    case 'idea:list':
      send(session, { t: 'idea:list', ideas: ideas.listIdeas(userId) });
      return;

    case 'idea:create': {
      if (!darf(session, 'idea.create')) return;
      broadcastIdee(ideas.createIdea({ ...ev, createdBy: userId }));
      return;
    }

    case 'idea:update': {
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return fail(session, 'not_found', 'Idee nicht gefunden.');
      if (idee.createdBy !== userId && !may(userId, 'idea.manage')) {
        return fail(session, 'forbidden', 'Fremde Ideen darf nur die Moderation ändern.');
      }
      broadcastIdee(ideas.updateIdea(ev.ideaId, ev.patch, userId));
      return;
    }

    case 'idea:status': {
      if (!darf(session, 'idea.manage')) return;
      broadcastIdee(ideas.setStatus(ev.ideaId, ev.status, userId, ev.decision));
      return;
    }

    case 'idea:vote': {
      if (!darf(session, 'idea.vote')) return;
      ideas.vote(ev.ideaId, userId, ev.wert);
      // Die eigene Stimme steckt in der Antwort — jede Person bekommt daher
      // ihre eigene Sicht auf dieselbe Idee.
      for (const s of sessions.values()) {
        if (!s.userId) continue;
        const eigene = ideas.getIdea(ev.ideaId, s.userId);
        if (eigene) send(s, { t: 'idea:upsert', idea: eigene });
      }
      return;
    }

    case 'idea:comments':
      send(session, { t: 'idea:comments', ideaId: ev.ideaId, comments: ideas.comments(ev.ideaId) });
      return;

    case 'idea:comment': {
      if (!darf(session, 'message.send')) return;
      const liste = ideas.addComment(ev.ideaId, userId, ev.text);
      broadcast({ t: 'idea:comments', ideaId: ev.ideaId, comments: liste });
      broadcastIdee(ideas.getIdea(ev.ideaId, userId));
      return;
    }

    case 'idea:comment-delete': {
      ideas.deleteComment(ev.commentId, userId, may(userId, 'idea.manage'));
      broadcast({ t: 'idea:comments', ideaId: ev.ideaId, comments: ideas.comments(ev.ideaId) });
      return;
    }

    case 'idea:delete': {
      const idee = ideas.getIdea(ev.ideaId, userId);
      if (!idee) return;
      if (idee.createdBy !== userId && !may(userId, 'idea.manage')) {
        return fail(session, 'forbidden', 'Fremde Ideen darf nur die Moderation löschen.');
      }
      ideas.deleteIdea(ev.ideaId);
      broadcast({ t: 'idea:removed', ideaId: ev.ideaId });
      return;
    }

    /* ── Dateiablage ──────────────────────────────────────── */

    case 'file:list':
      send(session, {
        t: 'file:list',
        files: files.listFiles({ channelId: ev.channelId, folder: ev.folder }),
        usage: files.usage(),
      });
      return;

    case 'file:update': {
      const datei = files.getFile(ev.fileId);
      if (!datei) return fail(session, 'not_found', 'Datei nicht gefunden.');
      if (datei.uploadedBy !== userId && !may(userId, 'file.manage')) {
        return fail(session, 'forbidden', 'Fremde Dateien darf nur die Verwaltung ändern.');
      }
      broadcast({ t: 'file:upsert', file: files.updateFile(ev.fileId, ev) });
      return;
    }

    case 'file:delete': {
      const datei = files.getFile(ev.fileId);
      if (!datei) return;
      if (datei.uploadedBy !== userId && !may(userId, 'file.manage')) {
        return fail(session, 'forbidden', 'Fremde Dateien darf nur die Verwaltung löschen.');
      }
      files.deleteFile(ev.fileId);
      broadcast({ t: 'file:removed', fileId: ev.fileId });
      return;
    }

    case 'voice:retranscribe': {
      const voice = voiceNoteFor(ev.messageId);
      if (!voice) return fail(session, 'not_found', 'Keine Aufnahme an dieser Nachricht');
      void runTranscription(ev.messageId, voice.attachmentId).catch((err) => console.error('[ws] Umschrift:', (err as Error).message));
      return;
    }

    case 'ai:ask': {
      if (!darf(session, 'ai.assistant')) return;
      const ch = store.getChannel(ev.channelId, userId);
      if (!ch) return fail(session, 'not_found', 'Kanal nicht gefunden', ev.requestId);
      const result = await ai.askChannel({
        channelId: ev.channelId, question: ev.question, language: session.language,
        channelName: channels.channelLabel(ch, userId, (id) => store.getUser(id)?.displayName ?? 'Unbekannt'),
      });
      send(session, { t: 'ai:ask', requestId: ev.requestId, ...result });
      return;
    }
  }
}


/* ── Helfer für die neuen Funktionen ──────────────────────────── */

/** Umfrage-Stand an alle im Kanal schicken — jede:r sieht die eigene Wahl. */
function broadcastPoll(pollId: string): void {
  const row = database.get<{ message_id: string }>('SELECT message_id FROM polls WHERE id = ?', pollId);
  if (!row) return;
  const msg = database.get<{ channel_id: string }>('SELECT channel_id FROM messages WHERE id = ?', row.message_id);
  if (!msg) return;
  for (const uid of store.memberIds(msg.channel_id)) {
    const poll = polls.getPoll(pollId, uid);
    if (!poll) continue;
    sendToUser(uid, { t: 'poll:updated', poll, channelId: msg.channel_id });
    // Die Übersetzung kommt nach, sobald sie da ist — auf sie zu warten würde
    // das Ergebnis einer Abstimmung für alle anderen verzögern.
    void pollUebersetzungNachreichen(pollId, uid, msg.channel_id);
  }
}

/**
 * Name, Thema und Zweck eines Kanals in die Lesesprache bringen. Läuft im
 * Hintergrund; steht der Kanal schon in dieser Sprache, passiert nichts.
 */
async function kanalUebersetzungNachreichen(channelId: string, userId: string): Promise<void> {
  const sprache = store.getSelf(userId)?.language;
  if (!sprache) return;
  try {
    const sicht = await translateChannel(channelId, sprache);
    const kanal = store.getChannel(channelId, userId);
    if (kanal) sendToUser(userId, { t: 'channel:upsert', channel: { ...kanal, translation: sicht } });
  } catch (err) {
    console.error('[kanal]', (err as Error).message);
  }
}

/**
 * Frage und Antworten in die Lesesprache bringen und nachliefern.
 * Steht die Umfrage schon in dieser Sprache, passiert nichts.
 */
async function pollUebersetzungNachreichen(pollId: string, userId: string, channelId: string): Promise<void> {
  const sprache = store.getSelf(userId)?.language;
  if (!sprache) return;
  try {
    const sicht = await translatePoll(pollId, sprache);
    const poll = polls.getPoll(pollId, userId);
    if (!poll) return;
    // Auch ohne Übersetzung senden: wer zurück in die Ausgangssprache wechselt,
    // säße sonst weiter vor der englischen Fassung.
    sendToUser(userId, { t: 'poll:updated', poll: { ...poll, translation: sicht }, channelId });
  } catch (err) {
    console.error('[umfrage]', (err as Error).message);
  }
}

/**
 * Link-Vorschauen nachreichen. Läuft bewusst nach der Zustellung —
 * eine langsame fremde Website darf den Chat nicht aufhalten.
 */
function enrichLinks(messageId: string, text: string, channelId: string): void {
  if (!extractUrls(text).length) return;
  void attachPreviews(messageId, text)
    .then((links) => {
      if (!links.length) return;
      broadcast({ t: 'links', messageId, links }, store.memberIds(channelId));
    })
    .catch((err) => console.warn('[links]', (err as Error).message));
}

/**
 * Aufnahme transkribieren und das Ergebnis zum Nachrichtentext machen.
 * Damit greifen Suche und Übersetzung genauso wie bei getippten Nachrichten:
 * eine japanische Sprachnachricht landet auf Deutsch im Fenster.
 */
async function runTranscription(messageId: string, attachmentId: string): Promise<void> {
  const msg = store.getMessage(messageId);
  if (!msg) return;
  const audience = store.memberIds(msg.channelId);

  try {
    const result = await transcribe(attachmentId);
    saveTranscript(attachmentId, result);

    // Das Transkript ist ab jetzt der Text der Nachricht.
    database.run(
      'UPDATE messages SET text = ?, source_lang = ? WHERE id = ?',
      verschluesseln(result.text), result.lang, messageId,
    );
    reindexMessage(messageId);

    const updated = store.getMessage(messageId)!;
    for (const uid of audience) {
      sendToUser(uid, { t: 'message:updated', message: store.getMessage(messageId, uid)! });
      sendToUser(uid, { t: 'voice:transcript', messageId, voice: voiceNoteFor(messageId)! });
    }

    // Und jetzt wie jede andere Nachricht in die Sprachen der Empfänger bringen.
    const context = channelContext(updated.channelId);
    const langs = new Map<string, string[]>();
    for (const uid of audience) {
      if (uid === updated.userId) continue;
      const u = store.getUser(uid);
      if (!u?.autoTranslate) continue;
      const target = normalizeLang(u.language);
      if (target === (result.lang ?? 'unknown')) continue;
      langs.set(target, [...(langs.get(target) ?? []), uid]);
    }
    for (const [target, users] of langs) {
      void translateMessage(messageId, target, { force: true, context })
        .then((view) => {
          if (!view) return;
          for (const uid of users) sendToUser(uid, { t: 'translation', messageId, translation: view });
        })
        .catch(() => { /* Original bleibt sichtbar */ });
    }
  } catch (err) {
    console.warn('[voice]', (err as Error).message);
    for (const uid of audience) {
      sendToUser(uid, { t: 'voice:transcript', messageId, voice: voiceNoteFor(messageId)! });
    }
  }
}

/**
 * Antwortet der Assistent auf diese Nachricht? Läuft nach der Zustellung,
 * damit die Nachricht der Person sofort im Kanal steht und nicht auf das
 * Modell wartet.
 */
function vielleichtAntworten(channelId: string, text: string, authorId: string): void {
  if (!ki.shouldAnswer(channelId, text, authorId)) return;

  const botId = ki.assistantUserId();
  if (!botId) return;
  const empfaenger = store.memberIds(channelId);
  const istDm = store.getChannel(channelId)?.kind === 'dm';

  // "Denkt nach"-Anzeige, damit niemand ins Leere schaut.
  broadcast({ t: 'ai:thinking', channelId, active: true }, empfaenger);

  void ki.generateReply(channelId, istDm ? 'privat' : 'team')
    .then((antwort) => {
      const msg = messages.createMessage({
        channelId, userId: botId, text: antwort,
        mayMention: false, mayMentionEveryone: false,
      });
      deliverMessage(msg);
    })
    .catch((err) => {
      console.warn('[ki]', (err as Error).message);
      // Fehler gehören in den Chat, nicht nur ins Log — sonst wartet man endlos.
      const msg = messages.createMessage({
        channelId, userId: botId,
        text: `Ich konnte gerade nicht antworten: ${(err as Error).message}`,
        mayMention: false, mayMentionEveryone: false,
      });
      deliverMessage(msg);
    })
    .finally(() => {
      broadcast({ t: 'ai:thinking', channelId, active: false }, empfaenger);
    });
}

/**
 * Eine geänderte Idee geht an alle — mit der jeweils eigenen Stimme, denn
 * "myVote" unterscheidet sich je Person.
 */
function broadcastIdee(idee: ReturnType<typeof ideas.getIdea>): void {
  if (!idee) return;
  for (const s of sessions.values()) {
    if (!s.userId) continue;
    const eigene = ideas.getIdea(idee.id, s.userId);
    if (eigene) send(s, { t: 'idea:upsert', idea: eigene });
  }
}

/**
 * Aufgaben gehen an alle: sie betreffen das ganze Team, und wer sie sehen darf,
 * entscheidet sich über den Kanal, nicht über die Aufgabe selbst.
 */
function broadcastTask(task: Awaited<ReturnType<typeof tasks.getTask>>): void {
  if (!task) return;
  broadcast({ t: 'task:upsert', task });
}

/* ── Hintergrundaufgaben ──────────────────────────────────────── */

export function startBackgroundJobs(): () => void {
  // Geplante Nachrichten ausliefern
  const scheduler = setInterval(() => {
    try {
      for (const row of messages.dueScheduled(Date.now())) {
        try {
          const msg = messages.createMessage({
            channelId: row.channel_id, userId: row.user_id, text: row.text, parentId: row.parent_id,
          });
          messages.removeScheduled(row.id);
          sendToUser(row.user_id, { t: 'scheduled:removed', scheduledId: row.id });
          deliverMessage(msg);
        } catch (err) {
          console.error('[scheduler]', (err as Error).message);
          messages.removeScheduled(row.id);
        }
      }
    } catch (err) {
      console.error('[scheduler]', (err as Error).message);
    }
  }, 5_000);

  // Fällige Erinnerungen zustellen
  const reminderTimer = setInterval(() => {
    try {
      for (const reminder of reminders.due(Date.now())) {
        const owner = ownerOfReminder(reminder.id);
        database.run('UPDATE reminders SET done = 1 WHERE id = ?', reminder.id);
        const message = reminder.messageId ? store.getMessage(reminder.messageId, owner) : null;
        if (owner) sendToUser(owner, { t: 'reminder:fire', reminder, message });
      }
    } catch (err) {
      console.error('[reminders]', (err as Error).message);
    }
  }, 15_000);

  // Abgelaufene Status zurücksetzen ("bin gleich zurück" soll nicht ewig stehen)
  const statusTimer = setInterval(() => {
    try {
      const expired = database.all<{ id: string }>(
        'SELECT id FROM users WHERE status_expires_at IS NOT NULL AND status_expires_at <= ?', Date.now(),
      );
      for (const row of expired) {
        database.run(
          "UPDATE users SET status_emoji = NULL, status_text = NULL, status_expires_at = NULL WHERE id = ?",
          row.id,
        );
        const u = store.getUser(row.id);
        if (u) {
          broadcast({
            t: 'presence', userId: row.id, status: u.status,
            statusEmoji: null, statusText: null, statusExpiresAt: null, lastSeenAt: u.lastSeenAt,
          });
        }
      }
    } catch (err) {
      console.error('[status]', (err as Error).message);
    }
  }, 30_000);

  // Hat das Aktualisierungsskript eine Auszeit hinterlegt? Dann einmal
  // ansagen — und einmal, wenn sie wieder verschwindet.
  let angesagt: string | null = null;
  const wartungsTimer = setInterval(() => {
    try {
      const w = wartung.anstehend();
      if (w && w.version !== angesagt) {
        angesagt = w.version;
        broadcast({ t: 'server:update', ...w, serverZeit: Date.now() });
      } else if (!w && angesagt) {
        angesagt = null;
        broadcast({ t: 'server:update-abgesagt' });
      }
    } catch (err) {
      console.error('[wartung]', (err as Error).message);
    }
  }, 5_000);

  // Termine, die in 15 Minuten beginnen, einmal ankündigen
  const gemeldet = new Set<string>();
  const terminTimer = setInterval(() => {
    try {
      for (const termin of events.startingSoon(15 * 60_000)) {
        if (gemeldet.has(termin.id)) continue;
        gemeldet.add(termin.id);
        for (const teil of termin.attendees) {
          if (teil.response === 'no') continue;
          sendToUser(teil.userId, {
            t: 'reminder:fire',
            reminder: {
              id: `ev_${termin.id}`, messageId: null, channelId: termin.channelId ?? '',
              note: termin.title, remindAt: termin.startsAt, done: false, createdAt: Date.now(),
            },
            message: null,
          });
        }
      }
      // Der Merker darf nicht unbegrenzt wachsen.
      if (gemeldet.size > 500) gemeldet.clear();
    } catch (err) {
      console.error('[termine]', (err as Error).message);
    }
  }, 60_000);

  // Tote Sockets aussortieren
  const heartbeat = setInterval(() => {
    for (const s of sessions.values()) {
      if (!s.alive) { s.socket.terminate(); continue; }
      s.alive = false;
      try { s.socket.ping(); } catch { /* ignore */ }
    }
  }, 30_000);

  return () => {
    clearInterval(scheduler);
    clearInterval(reminderTimer);
    clearInterval(statusTimer);
    clearInterval(terminTimer);
    clearInterval(wartungsTimer);
    clearInterval(heartbeat);
  };
}

/** Zu wem gehört die Erinnerung? Die Liste liefert sie ohne Besitzer mit. */
function ownerOfReminder(reminderId: string): string {
  return database.get<{ user_id: string }>('SELECT user_id FROM reminders WHERE id = ?', reminderId)?.user_id ?? '';
}

export function onlineUserIds(): string[] {
  return [...byUser.keys()];
}
