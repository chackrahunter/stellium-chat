import { create } from 'zustand';
import {
  normalizeLang,
  type AiCapabilities, type AiSummary, type Channel, type ChannelState,
  type Message, type RewriteTone, type ScheduledMessage, type SearchHit,
  type SelfUser, type ServerEvent, type SmartReply, type User, type UserStatus,
} from '@stellium/shared';
import { api, setToken, token } from '../net/api.js';
import { socket, type ConnectionState } from '../net/socket.js';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'ok';
  title: string;
  body?: string;
}

export type Overlay = null | 'quick' | 'search' | 'settings' | 'newChannel' | 'glossary' | 'catchup' | 'schedule' | 'people';

interface PendingRequest<T> { resolve: (value: T) => void; reject: (err: Error) => void; timer: number }

interface StoreState {
  /* Verbindung & Identität */
  connection: ConnectionState;
  connectionDetail: string | null;
  booted: boolean;
  self: SelfUser | null;
  ai: AiCapabilities | null;

  /* Daten */
  users: Record<string, User>;
  channels: Record<string, Channel>;
  states: Record<string, ChannelState>;
  messages: Record<string, Message[]>;         // channelId -> chronologisch
  hasMore: Record<string, boolean>;
  threads: Record<string, Message[]>;          // parentId -> [root, ...replies]
  scheduled: ScheduledMessage[];

  /* Übersetzung */
  translating: Record<string, boolean>;        // messageId -> läuft gerade
  showOriginal: Record<string, boolean>;       // messageId -> Original einblenden
  roundTrips: Record<string, { backTranslation: string; similarity: number }>;

  /* UI */
  activeChannelId: string | null;
  threadParentId: string | null;
  overlay: Overlay;
  sidebarCollapsed: boolean;
  typing: Record<string, Record<string, number>>;   // channelId -> userId -> ts
  readMarkers: Record<string, string | null>;       // channelId -> Grenze beim Öffnen
  toasts: Toast[];
  smartReplies: SmartReply[];
  catchup: AiSummary | null;
  catchupLoading: boolean;
  lightbox: string | null;
  searchHits: SearchHit[];
  searching: boolean;

  /* Aktionen */
  boot: () => Promise<void>;
  login: (login: string, password: string) => Promise<void>;
  register: (input: Parameters<typeof api.register>[0]) => Promise<void>;
  logout: () => void;

  openChannel: (channelId: string) => void;
  loadOlder: (channelId: string) => void;
  openThread: (parentId: string | null) => void;
  openDm: (userId: string) => void;

  sendMessage: (input: { channelId: string; text: string; parentId?: string | null; attachmentIds?: string[] }) => void;
  editMessage: (messageId: string, text: string) => void;
  deleteMessage: (messageId: string) => void;
  react: (messageId: string, emoji: string) => void;
  pin: (messageId: string, pinned: boolean) => void;
  save: (messageId: string, saved: boolean) => void;
  schedule: (input: { channelId: string; text: string; sendAt: number; parentId?: string | null }) => void;
  unschedule: (id: string) => void;
  sendTyping: (channelId: string, parentId?: string | null) => void;

  toggleOriginal: (messageId: string) => void;
  requestTranslation: (messageId: string, targetLang?: string) => void;
  requestRoundTrip: (messageId: string) => void;
  composePreview: (text: string, targetLang: string, channelId: string) => Promise<string>;

  createChannel: (input: { kind: 'public' | 'private'; name: string; topic?: string; primaryLanguage?: string | null; memberIds?: string[] }) => void;
  joinChannel: (channelId: string) => void;
  leaveChannel: (channelId: string) => void;
  updateChannel: (channelId: string, patch: { topic?: string; purpose?: string; primaryLanguage?: string | null }) => void;

  updatePrefs: (patch: Partial<SelfUser>) => void;
  setStatus: (status: UserStatus, emoji?: string | null, text?: string | null) => void;

  runCatchup: (channelId: string) => void;
  loadSmartReplies: (channelId: string, parentId?: string | null) => void;
  clearSmartReplies: () => void;
  rewrite: (text: string, tone: RewriteTone, targetLang?: string | null) => Promise<string>;
  askChannel: (channelId: string, question: string) => Promise<{ answer: string; citedMessageIds: string[] }>;
  runSearch: (q: string, channelId?: string | null) => Promise<void>;

  setOverlay: (overlay: Overlay) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLightbox: (url: string | null) => void;
  toast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
}

const uid = () => Math.random().toString(36).slice(2, 11);
const pending = new Map<string, PendingRequest<any>>();

function awaitReply<T>(requestId: string, timeoutMs = 45_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Die KI hat nicht rechtzeitig geantwortet.'));
    }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
  });
}

function settle(requestId: string, value: unknown, error?: Error): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  if (error) entry.reject(error);
  else entry.resolve(value);
}

/** Nachricht in die chronologisch sortierte Liste einfügen bzw. ersetzen. */
function upsertMessage(list: Message[] | undefined, msg: Message): Message[] {
  const arr = list ? [...list] : [];
  const byId = arr.findIndex((m) => m.id === msg.id);
  if (byId >= 0) {
    arr[byId] = { ...arr[byId], ...msg };
    return arr;
  }
  // Optimistische Variante derselben Nachricht ersetzen
  if (msg.clientId) {
    const optimistic = arr.findIndex((m) => m.clientId === msg.clientId);
    if (optimistic >= 0) { arr[optimistic] = msg; return arr; }
  }
  let i = arr.length;
  while (i > 0 && arr[i - 1].createdAt > msg.createdAt) i--;
  arr.splice(i, 0, msg);
  return arr;
}

export const useStore = create<StoreState>((set, get) => ({
  connection: 'idle',
  connectionDetail: null,
  booted: false,
  self: null,
  ai: null,

  users: {},
  channels: {},
  states: {},
  messages: {},
  hasMore: {},
  threads: {},
  scheduled: [],

  translating: {},
  showOriginal: {},
  roundTrips: {},

  activeChannelId: null,
  threadParentId: null,
  overlay: null,
  sidebarCollapsed: false,
  typing: {},
  readMarkers: {},
  toasts: [],
  smartReplies: [],
  catchup: null,
  catchupLoading: false,
  lightbox: null,
  searchHits: [],
  searching: false,

  /* ── Start ──────────────────────────────────────────────── */

  boot: async () => {
    if (!token()) { set({ booted: true }); return; }
    try {
      const { user, ai } = await api.me();
      set({ self: user, ai });
      applyTheme(user.theme, user.density);
      socket.connect();
    } catch {
      setToken(null);
      set({ self: null });
    } finally {
      set({ booted: true });
    }
  },

  login: async (login, password) => {
    const { token: t, user } = await api.login(login, password);
    setToken(t);
    set({ self: user });
    applyTheme(user.theme, user.density);
    socket.connect();
  },

  register: async (input) => {
    const { token: t, user } = await api.register(input);
    setToken(t);
    set({ self: user });
    applyTheme(user.theme, user.density);
    socket.connect();
  },

  logout: () => {
    socket.disconnect();
    setToken(null);
    set({
      self: null, users: {}, channels: {}, states: {}, messages: {}, threads: {},
      activeChannelId: null, threadParentId: null, overlay: null, scheduled: [],
      catchup: null, smartReplies: [], searchHits: [],
    });
  },

  /* ── Kanäle ─────────────────────────────────────────────── */

  openChannel: (channelId) => {
    const state = get().states[channelId];
    set((s) => ({
      activeChannelId: channelId,
      threadParentId: null,
      smartReplies: [],
      catchup: null,
      readMarkers: { ...s.readMarkers, [channelId]: state?.lastReadMessageId ?? null },
    }));
    socket.send({ t: 'channel:open', channelId, limit: 50 });
  },

  loadOlder: (channelId) => {
    const list = get().messages[channelId];
    if (!list?.length || !get().hasMore[channelId]) return;
    socket.send({ t: 'channel:open', channelId, before: list[0].id, limit: 50 });
  },

  openThread: (parentId) => {
    set({ threadParentId: parentId, smartReplies: [] });
    if (parentId) socket.send({ t: 'thread:open', messageId: parentId });
  },

  openDm: (userId) => {
    set({ overlay: null });
    socket.send({ t: 'dm:open', userId });
  },

  /* ── Nachrichten ────────────────────────────────────────── */

  sendMessage: ({ channelId, text, parentId, attachmentIds }) => {
    const self = get().self;
    if (!self) return;
    const clientId = uid();

    // Optimistisch anzeigen — fühlt sich sofort an, auch bei langsamer Leitung.
    const optimistic: Message = {
      id: `tmp_${clientId}`, channelId, userId: self.id, parentId: parentId ?? null,
      text, sourceLang: null, createdAt: Date.now(), editedAt: null, deletedAt: null,
      systemKind: null, attachments: [], reactions: [], replyCount: 0, lastReplyAt: null,
      threadParticipantIds: [], mentionUserIds: [], pinned: false, translation: null,
      pending: true, clientId,
    };

    set((s) => {
      const next: Partial<StoreState> = { messages: { ...s.messages, [channelId]: upsertMessage(s.messages[channelId], optimistic) } };
      if (parentId && s.threads[parentId]) {
        next.threads = { ...s.threads, [parentId]: upsertMessage(s.threads[parentId], optimistic) };
      }
      return next;
    });

    const delivered = socket.send({
      t: 'message:send', clientId, channelId, text,
      parentId: parentId ?? null, attachmentIds,
    });
    if (!delivered) {
      get().toast({ kind: 'info', title: 'Offline', body: 'Die Nachricht geht raus, sobald die Verbindung steht.' });
    }
  },

  editMessage: (messageId, text) => socket.send({ t: 'message:edit', messageId, text }) as unknown as void,
  deleteMessage: (messageId) => socket.send({ t: 'message:delete', messageId }) as unknown as void,
  react: (messageId, emoji) => socket.send({ t: 'message:react', messageId, emoji }) as unknown as void,
  pin: (messageId, pinned) => socket.send({ t: 'message:pin', messageId, pinned }) as unknown as void,
  save: (messageId, saved) => {
    socket.send({ t: 'message:save', messageId, saved });
    get().toast({ kind: 'ok', title: saved ? 'Gemerkt' : 'Aus den gemerkten entfernt' });
  },

  schedule: ({ channelId, text, sendAt, parentId }) => {
    socket.send({ t: 'message:schedule', channelId, text, sendAt, parentId: parentId ?? null });
    set({ overlay: null });
  },
  unschedule: (id) => socket.send({ t: 'message:unschedule', scheduledId: id }) as unknown as void,

  sendTyping: (() => {
    let last = 0;
    return (channelId: string, parentId?: string | null) => {
      const now = Date.now();
      if (now - last < 2500) return;      // nicht bei jedem Tastendruck funken
      last = now;
      socket.send({ t: 'typing', channelId, parentId: parentId ?? null });
    };
  })(),

  /* ── Übersetzung ────────────────────────────────────────── */

  toggleOriginal: (messageId) =>
    set((s) => ({ showOriginal: { ...s.showOriginal, [messageId]: !s.showOriginal[messageId] } })),

  requestTranslation: (messageId, targetLang) => {
    const lang = targetLang ?? get().self?.language ?? 'en';
    set((s) => ({ translating: { ...s.translating, [messageId]: true } }));
    socket.send({ t: 'translate:request', messageId, targetLang: normalizeLang(lang), force: Boolean(targetLang) });
  },

  requestRoundTrip: (messageId) => {
    const lang = get().self?.language ?? 'en';
    socket.send({ t: 'translate:roundtrip', messageId, targetLang: normalizeLang(lang) });
  },

  composePreview: async (text, targetLang, channelId) => {
    const requestId = uid();
    const promise = awaitReply<string>(requestId, 20_000);
    socket.send({ t: 'compose:preview', requestId, text, targetLang, channelId });
    return promise;
  },

  createChannel: (input) => {
    socket.send({
      t: 'channel:create', kind: input.kind, name: input.name, topic: input.topic,
      primaryLanguage: input.primaryLanguage ?? null, memberIds: input.memberIds,
    });
    set({ overlay: null });
  },
  joinChannel: (channelId) => socket.send({ t: 'channel:join', channelId }) as unknown as void,
  leaveChannel: (channelId) => {
    socket.send({ t: 'channel:leave', channelId });
    if (get().activeChannelId === channelId) set({ activeChannelId: null });
  },
  updateChannel: (channelId, patch) => socket.send({ t: 'channel:update', channelId, ...patch }) as unknown as void,

  updatePrefs: (patch) => {
    const self = get().self;
    if (self) {
      const merged = { ...self, ...patch };
      set({ self: merged });
      applyTheme(merged.theme, merged.density);
    }
    socket.send({ t: 'prefs:update', patch: patch as any });
  },

  setStatus: (status, emoji, text) =>
    socket.send({ t: 'presence:set', status, statusEmoji: emoji, statusText: text }) as unknown as void,

  /* ── KI ─────────────────────────────────────────────────── */

  runCatchup: (channelId) => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: 'KI nicht aktiv', body: get().ai?.note ?? 'Setze GROQ_API_KEY auf dem Server.' });
      return;
    }
    const requestId = uid();
    set({ catchupLoading: true, overlay: 'catchup', catchup: null });
    void awaitReply<AiSummary>(requestId)
      .then((summary) => set({ catchup: summary, catchupLoading: false }))
      .catch((err: Error) => {
        set({ catchupLoading: false });
        get().toast({ kind: 'error', title: 'Zusammenfassung fehlgeschlagen', body: err.message });
      });
    socket.send({ t: 'ai:catchup', requestId, channelId });
  },

  loadSmartReplies: (channelId, parentId) => {
    if (!get().ai?.assistant) return;
    const requestId = uid();
    void awaitReply<SmartReply[]>(requestId, 20_000)
      .then((replies) => set({ smartReplies: replies }))
      .catch(() => set({ smartReplies: [] }));
    socket.send({ t: 'ai:smart-replies', requestId, channelId, parentId: parentId ?? null });
  },

  clearSmartReplies: () => set({ smartReplies: [] }),

  rewrite: async (text, tone, targetLang) => {
    const requestId = uid();
    const promise = awaitReply<string>(requestId, 40_000);
    socket.send({ t: 'ai:rewrite', requestId, text, tone, targetLang: targetLang ?? null });
    return promise;
  },

  askChannel: async (channelId, question) => {
    const requestId = uid();
    const promise = awaitReply<{ answer: string; citedMessageIds: string[] }>(requestId);
    socket.send({ t: 'ai:ask', requestId, channelId, question });
    return promise;
  },

  runSearch: async (q, channelId) => {
    if (q.trim().length < 2) { set({ searchHits: [], searching: false }); return; }
    set({ searching: true });
    try {
      const { hits } = await api.search({ q, channelId });
      set({ searchHits: hits, searching: false });
    } catch (err) {
      set({ searchHits: [], searching: false });
      get().toast({ kind: 'error', title: 'Suche fehlgeschlagen', body: (err as Error).message });
    }
  },

  /* ── UI ─────────────────────────────────────────────────── */

  setOverlay: (overlay) => set({ overlay }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setLightbox: (lightbox) => set({ lightbox }),

  toast: (toast) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    window.setTimeout(() => get().dismissToast(id), toast.kind === 'error' ? 7000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/* ── Theme auf das Dokument anwenden ────────────────────────── */

function applyTheme(theme: SelfUser['theme'], density: SelfUser['density']): void {
  const root = document.documentElement;
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  root.dataset.theme = resolved;
  root.dataset.density = density;
  void window.stellium?.setTheme(theme);
}

/* ── Server-Ereignisse in den Store spiegeln ────────────────── */

socket.onState((connection, detail) => {
  useStore.setState({ connection, connectionDetail: detail ?? null });
  if (connection === 'failed') {
    setToken(null);
    useStore.setState({ self: null });
  }
});

socket.onEvent((ev: ServerEvent) => {
  const store = useStore.getState();

  switch (ev.t) {
    case 'ready': {
      applyTheme(ev.self.theme, ev.self.density);
      useStore.setState({
        self: ev.self,
        ai: ev.ai,
        users: Object.fromEntries(ev.users.map((u) => [u.id, u])),
        channels: Object.fromEntries(ev.channels.map((c) => [c.id, c])),
        states: Object.fromEntries(ev.states.map((s) => [s.channelId, s])),
        scheduled: ev.scheduled,
      });
      const active = useStore.getState().activeChannelId
        ?? ev.channels.find((c) => c.kind === 'public')?.id
        ?? ev.channels[0]?.id;
      if (active) useStore.getState().openChannel(active);
      break;
    }

    case 'channel:history': {
      useStore.setState((s) => {
        const existing = s.messages[ev.channelId] ?? [];
        // Ältere Seite: vorne anhängen. Erste Seite: ersetzen.
        const isOlderPage = existing.length > 0 && ev.messages.length > 0
          && ev.messages[ev.messages.length - 1].createdAt < (existing[0]?.createdAt ?? Infinity);
        const merged = isOlderPage ? [...ev.messages, ...existing] : ev.messages;
        return {
          messages: { ...s.messages, [ev.channelId]: merged },
          hasMore: { ...s.hasMore, [ev.channelId]: ev.hasMore },
        };
      });
      break;
    }

    case 'thread:history':
      useStore.setState((s) => ({ threads: { ...s.threads, [ev.parentId]: ev.messages } }));
      break;

    case 'message:new': {
      const msg: Message = ev.clientId ? { ...ev.message, clientId: ev.clientId } : ev.message;
      useStore.setState((s) => {
        const next: Partial<StoreState> = {
          messages: { ...s.messages, [msg.channelId]: upsertMessage(s.messages[msg.channelId], msg) },
        };
        if (msg.parentId && s.threads[msg.parentId]) {
          next.threads = { ...s.threads, [msg.parentId]: upsertMessage(s.threads[msg.parentId], msg) };
        }
        // Thread-Zähler an der Wurzel hochziehen
        if (msg.parentId) {
          const list = next.messages![msg.channelId];
          next.messages = {
            ...next.messages,
            [msg.channelId]: list.map((m) => m.id === msg.parentId
              ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: msg.createdAt,
                  threadParticipantIds: m.threadParticipantIds.includes(msg.userId)
                    ? m.threadParticipantIds : [...m.threadParticipantIds, msg.userId] }
              : m),
          };
        }
        return next;
      });
      notifyIfNeeded(msg);
      markReadIfViewing(msg);
      break;
    }

    case 'message:updated':
      useStore.setState((s) => {
        const next: Partial<StoreState> = {
          messages: { ...s.messages, [ev.message.channelId]: upsertMessage(s.messages[ev.message.channelId], ev.message) },
        };
        if (ev.message.parentId && s.threads[ev.message.parentId]) {
          next.threads = { ...s.threads, [ev.message.parentId]: upsertMessage(s.threads[ev.message.parentId], ev.message) };
        }
        if (s.threads[ev.message.id]) {
          next.threads = { ...(next.threads ?? s.threads), [ev.message.id]: upsertMessage(s.threads[ev.message.id], ev.message) };
        }
        return next;
      });
      break;

    case 'message:deleted':
      useStore.setState((s) => ({
        messages: {
          ...s.messages,
          [ev.channelId]: (s.messages[ev.channelId] ?? []).map((m) =>
            m.id === ev.messageId ? { ...m, deletedAt: Date.now(), text: '', attachments: [], translation: null } : m),
        },
      }));
      break;

    case 'reaction:updated':
      useStore.setState((s) => {
        const patch = (list: Message[] = []) => list.map((m) => m.id === ev.messageId ? { ...m, reactions: ev.reactions } : m);
        const threads = { ...s.threads };
        for (const key of Object.keys(threads)) threads[key] = patch(threads[key]);
        return { messages: { ...s.messages, [ev.channelId]: patch(s.messages[ev.channelId]) }, threads };
      });
      break;

    case 'translation':
      useStore.setState((s) => {
        const patch = (list: Message[] = []) => list.map((m) => m.id === ev.messageId ? { ...m, translation: ev.translation } : m);
        const messages = { ...s.messages };
        for (const key of Object.keys(messages)) messages[key] = patch(messages[key]);
        const threads = { ...s.threads };
        for (const key of Object.keys(threads)) threads[key] = patch(threads[key]);
        const translating = { ...s.translating };
        delete translating[ev.messageId];
        return { messages, threads, translating };
      });
      break;

    case 'roundtrip':
      useStore.setState((s) => ({
        roundTrips: { ...s.roundTrips, [ev.messageId]: { backTranslation: ev.backTranslation, similarity: ev.similarity } },
      }));
      break;

    case 'channel:upsert':
      useStore.setState((s) => ({ channels: { ...s.channels, [ev.channel.id]: ev.channel } }));
      if (ev.channel.kind === 'dm') useStore.getState().openChannel(ev.channel.id);
      break;

    case 'channel:removed':
      useStore.setState((s) => {
        const channels = { ...s.channels }; delete channels[ev.channelId];
        const messages = { ...s.messages }; delete messages[ev.channelId];
        return { channels, messages };
      });
      break;

    case 'channel:state':
      useStore.setState((s) => ({ states: { ...s.states, [ev.state.channelId]: ev.state } }));
      updateBadge();
      break;

    case 'typing':
      useStore.setState((s) => ({
        typing: {
          ...s.typing,
          [ev.channelId]: { ...(s.typing[ev.channelId] ?? {}), [ev.userId]: Date.now() },
        },
      }));
      break;

    case 'presence':
      useStore.setState((s) => {
        const user = s.users[ev.userId];
        if (!user) return {};
        return {
          users: {
            ...s.users,
            [ev.userId]: { ...user, status: ev.status, statusEmoji: ev.statusEmoji, statusText: ev.statusText, lastSeenAt: ev.lastSeenAt },
          },
        };
      });
      break;

    case 'user:upsert':
      useStore.setState((s) => ({ users: { ...s.users, [ev.user.id]: ev.user } }));
      break;

    case 'self:updated':
      applyTheme(ev.self.theme, ev.self.density);
      useStore.setState({ self: ev.self });
      break;

    case 'scheduled:upsert':
      useStore.setState((s) => ({ scheduled: [...s.scheduled.filter((x) => x.id !== ev.item.id), ev.item].sort((a, b) => a.sendAt - b.sendAt) }));
      break;

    case 'scheduled:removed':
      useStore.setState((s) => ({ scheduled: s.scheduled.filter((x) => x.id !== ev.scheduledId) }));
      break;

    case 'compose:preview': settle(ev.requestId, ev.text); break;
    case 'ai:catchup': settle(ev.requestId, ev.summary); break;
    case 'ai:thread-summary': settle(ev.requestId, ev.summary); break;
    case 'ai:smart-replies': settle(ev.requestId, ev.replies); break;
    case 'ai:rewrite': settle(ev.requestId, ev.text); break;
    case 'ai:ask': settle(ev.requestId, { answer: ev.answer, citedMessageIds: ev.citedMessageIds }); break;

    case 'error':
      if (ev.requestId) settle(ev.requestId, null, new Error(ev.message));
      else store.toast({ kind: 'error', title: 'Serverfehler', body: ev.message });
      break;
  }
});

/* ── Benachrichtigungen & Badge ─────────────────────────────── */

function inQuietHours(self: SelfUser): boolean {
  if (self.quietHoursStart == null || self.quietHoursEnd == null) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const { quietHoursStart: start, quietHoursEnd: end } = self;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function notifyIfNeeded(msg: Message): void {
  const s = useStore.getState();
  const self = s.self;
  if (!self || msg.userId === self.id || msg.systemKind) return;
  if (self.notifyOn === 'none') return;

  const channel = s.channels[msg.channelId];
  const isDm = channel?.kind === 'dm';
  const isMention = msg.mentionUserIds.includes(self.id);
  if (self.notifyOn === 'mentions' && !isMention && !isDm) return;
  if (s.states[msg.channelId]?.muted && !isMention) return;

  // Ruhezeiten: nur direkte Erwähnungen kommen durch.
  if (inQuietHours(self) && !isMention) return;

  const focused = document.hasFocus() && s.activeChannelId === msg.channelId;
  if (focused) return;

  const author = s.users[msg.userId];
  const title = isDm ? (author?.displayName ?? 'Neue Nachricht') : `#${channel?.name ?? 'Kanal'}`;
  const prefix = isDm ? '' : `${author?.displayName ?? ''}: `;
  // Übersetzung bevorzugen, damit die Vorschau in der eigenen Sprache steht.
  const body = `${prefix}${msg.translation?.text ?? msg.text}`.slice(0, 180);

  void window.stellium?.notify({ title, body, channelId: msg.channelId });
  void window.stellium?.flashWindow();
}

function markReadIfViewing(msg: Message): void {
  const s = useStore.getState();
  if (s.activeChannelId !== msg.channelId || !document.hasFocus()) return;
  socket.send({ t: 'read', channelId: msg.channelId, lastMessageId: msg.id });
}

function updateBadge(): void {
  const s = useStore.getState();
  const total = Object.values(s.states).reduce((sum, st) => sum + (st.muted ? 0 : st.unreadCount), 0);
  void window.stellium?.setBadge(total);
}

/* Alte Tipp-Indikatoren regelmäßig aufräumen. */
window.setInterval(() => {
  const s = useStore.getState();
  const now = Date.now();
  let changed = false;
  const typing: StoreState['typing'] = {};
  for (const [channelId, users] of Object.entries(s.typing)) {
    const fresh: Record<string, number> = {};
    for (const [userId, ts] of Object.entries(users)) {
      if (now - ts < 5000) fresh[userId] = ts;
      else changed = true;
    }
    if (Object.keys(fresh).length) typing[channelId] = fresh;
  }
  if (changed) useStore.setState({ typing });
}, 2000);
