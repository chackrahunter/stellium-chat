import { create } from 'zustand';
import {
  normalizeLang,
  type AiCapabilities, type AiSummary, type Channel, type ChannelState,
  type Draft, type LinkPreview, type Message, type Poll, type Reminder,
  type RewriteTone, type ScheduledMessage, type SearchHit,
  type SelfUser, type ServerEvent, type SmartReply, type User, type UserStatus,
  type VoiceNote, type Task, type TaskEvent, type TaskStatus, type CalendarEvent,
  type StoredFile, type StorageUsage, type MeetingProtocol,
  type Idea, type IdeaComment, type IdeaStatus, type ReleaseInfo,
} from '@stellium/shared';
import { api, serverUrl, setToken, token } from '../net/api.js';
import { socket, type ConnectionState } from '../net/socket.js';
import { titelZaehler, zeigen } from '../lib/benachrichtigung.js';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'ok';
  title: string;
  body?: string;
}

export type Overlay =
  | null | 'quick' | 'search' | 'settings' | 'newChannel' | 'glossary'
  | 'catchup' | 'schedule' | 'people' | 'poll' | 'reminders' | 'models' | 'team'
  | 'channelSettings' | 'tour' | 'tasks' | 'calendar' | 'files' | 'taskExtract' | 'protocol' | 'ideas';

interface PendingRequest<T> { resolve: (value: T) => void; reject: (err: Error) => void; timer: number }

interface StoreState {
  /* Verbindung & Identität */
  connection: ConnectionState;
  connectionDetail: string | null;
  booted: boolean;
  self: SelfUser | null;
  ai: AiCapabilities | null;
  /** Stand, der auf dem Server läuft — für die Aktualisierungsansicht. */
  serverVersion: string | null;
  /** Fassung, die für den Server bereitliegt, aber noch nicht läuft. */
  serverBereitVersion: string | null;

  /* Daten */
  users: Record<string, User>;
  channels: Record<string, Channel>;
  states: Record<string, ChannelState>;
  messages: Record<string, Message[]>;         // channelId -> chronologisch
  hasMore: Record<string, boolean>;
  threads: Record<string, Message[]>;          // parentId -> [root, ...replies]
  scheduled: ScheduledMessage[];
  reminders: Reminder[];
  drafts: Record<string, string>;          // "channelId:parentId" -> Text

  /* Übersetzung */
  translating: Record<string, boolean>;        // messageId -> läuft gerade
  showOriginal: Record<string, boolean>;       // messageId -> Original einblenden
  roundTrips: Record<string, { backTranslation: string; similarity: number }>;

  /* UI */
  tasks: Record<string, Task>;
  events: Record<string, CalendarEvent>;
  files: StoredFile[];
  storageUsage: StorageUsage | null;
  taskHistory: Record<string, TaskEvent[]>;
  /** Ergebnis der Aufgabenerkennung — sie legt die Aufgaben selbst an. */
  extractErgebnis: { erstellt: { id: string; title: string }[]; uebersprungen: number } | null;
  extractingTasks: boolean;
  /** Stand der Selbstaktualisierung. Im Browser bleibt er auf 'aus'. */
  update: {
    zustand: 'aus' | 'suche' | 'gefunden' | 'laedt' | 'bereit' | 'installiert' | 'aktuell' | 'fehler';
    version?: string;
    notes?: string | null;
    anteil?: number;
    fehler?: string;
    /** Sekunden bis zur automatischen Installation. */
    restSekunden?: number;
    verschoben?: boolean;
  };
  /**
   * Angekündigte Auszeit des Servers. Die Zeiten sind bereits auf die
   * eigene Uhr umgerechnet — der Server schickt seine mit, damit eine
   * falsch gestellte Uhr hier keinen anderen Countdown ergibt.
   */
  serverUpdate: {
    version: string;
    notes: string | null;
    startetUm: number;
    dauertEtwa: number;
  } | null;
  ideas: Record<string, Idea>;
  ideaComments: Record<string, IdeaComment[]>;
  protocol: MeetingProtocol | null;
  protocolLoading: boolean;
  /** Auf schmalen Geräten liegt die Seitenleiste über dem Chat. */
  schubladeOffen: boolean;
  activeChannelId: string | null;
  /** Zuletzt geöffneter Kanal außerhalb des KI-Reiters. */
  lastHumanChannelId: string | null;
  threadParentId: string | null;
  overlay: Overlay;
  sidebarCollapsed: boolean;
  typing: Record<string, Record<string, number>>;   // channelId -> userId -> ts
  readMarkers: Record<string, string | null>;       // channelId -> Grenze beim Öffnen
  /** Zuletzt geöffnete Kanäle, neuester zuerst — für das Aufräumen. */
  zuletztOffen: string[];
  toasts: Toast[];
  smartReplies: SmartReply[];
  smartRepliesLoading: boolean;
  catchup: AiSummary | null;
  catchupLoading: boolean;
  lightbox: string | null;
  searchHits: SearchHit[];
  searching: boolean;
  /** Nachricht, die gerade weitergeleitet werden soll. */
  forwarding: Message | null;
  /** Nachricht, für die eine Erinnerung gesetzt wird. */
  remindingAbout: Message | null;
  /** Profilkarte, die gerade offen ist. */
  profileUserId: string | null;
  /** Nachricht, die kurz hervorgehoben wird (nach Sprung aus der Suche). */
  highlightMessageId: string | null;
  /** Kanäle, in denen der Assistent gerade eine Antwort formuliert. */
  aiThinking: Record<string, boolean>;

  /* Aktionen */
  boot: () => Promise<void>;
  login: (login: string, password: string) => Promise<void>;
  logout: () => void;

  openChannel: (channelId: string) => void;
  loadOlder: (channelId: string) => void;
  openThread: (parentId: string | null) => void;
  openDm: (userId: string) => void;

  sendMessage: (input: { channelId: string; text: string; parentId?: string | null; attachmentIds?: string[] }) => void;
  editMessage: (messageId: string, text: string) => void;
  deleteMessage: (messageId: string, scope?: 'all' | 'me') => void;
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
  updateChannel: (channelId: string, patch: {
    name?: string; topic?: string; purpose?: string;
    primaryLanguage?: string | null; archived?: boolean; readOnly?: boolean;
  }) => void;
  deleteChannel: (channelId: string) => void;
  hideChannel: (channelId: string) => void;
  setChannelMembers: (channelId: string, add?: string[], remove?: string[]) => void;
  muteChannel: (channelId: string, muted: boolean) => void;
  starChannel: (channelId: string, starred: boolean) => void;

  updatePrefs: (patch: Partial<SelfUser>) => void;
  setStatus: (status: UserStatus, emoji?: string | null, text?: string | null) => void;

  runCatchup: (channelId: string) => void;
  loadSmartReplies: (channelId: string, parentId?: string | null) => void;
  clearSmartReplies: () => void;
  rewrite: (text: string, tone: RewriteTone, targetLang?: string | null) => Promise<string>;
  askChannel: (channelId: string, question: string) => Promise<{ answer: string; citedMessageIds: string[] }>;
  runSearch: (q: string, channelId?: string | null) => Promise<void>;

  /* Umfragen */
  createPoll: (input: { channelId: string; question: string; options: string[]; multiple: boolean; anonymous: boolean; parentId?: string | null }) => void;
  votePoll: (pollId: string, optionIds: string[]) => void;
  closePoll: (pollId: string) => void;

  /* Weiterleiten, Erinnern, Entwürfe */
  startForward: (message: Message | null) => void;
  forwardMessage: (messageId: string, toChannelId: string, comment?: string) => void;
  startReminder: (message: Message | null) => void;
  createReminder: (input: { channelId: string; messageId?: string | null; note?: string | null; remindAt: number }) => void;
  cancelReminder: (id: string) => void;
  saveDraft: (channelId: string, parentId: string | null, text: string) => void;
  draftFor: (channelId: string, parentId: string | null) => string;

  /* Sprachnachrichten */
  sendVoice: (input: { channelId: string; attachmentId: string; durationMs: number; parentId?: string | null }) => void;
  retranscribe: (messageId: string) => void;

  /* KI als Gesprächspartner */
  openAiChat: () => void;
  openLastHumanChannel: () => void;
  setSchublade: (offen: boolean) => void;

  loadTasks: (filter?: { channelId?: string; assigneeId?: string }) => void;
  createTask: (input: {
    title: string; description?: string | null; assigneeId?: string | null;
    channelId?: string | null; dueAt?: number | null; priority?: Task['priority'];
  }) => void;
  updateTask: (taskId: string, patch: Partial<Pick<Task,
    'title' | 'description' | 'status' | 'priority' | 'assigneeId' | 'dueAt' | 'channelId'>>) => void;
  moveTask: (taskId: string, status: TaskStatus, afterId?: string | null) => void;
  commentTask: (taskId: string, text: string) => void;
  watchTask: (taskId: string, watching: boolean) => void;
  deleteTask: (taskId: string) => void;
  loadTaskHistory: (taskId: string) => void;
  extractTasks: (channelId: string) => void;
  clearExtractedTasks: () => void;
  /** Die eben automatisch angelegten Aufgaben wieder entfernen. */
  extractRueckgaengig: () => void;
  loadProtocol: (channelId: string) => void;
  clearProtocol: () => void;

  checkForUpdate: () => void;
  installUpdate: () => void;
  postponeUpdate: () => void;
  loadIdeas: () => void;
  createIdea: (input: { title: string; body?: string | null; tag?: string; channelId?: string | null }) => void;
  updateIdea: (ideaId: string, patch: { title?: string; body?: string | null; tag?: string; channelId?: string | null }) => void;
  setIdeaStatus: (ideaId: string, status: IdeaStatus, decision?: string | null) => void;
  voteIdea: (ideaId: string, wert: 1 | -1) => void;
  loadIdeaComments: (ideaId: string) => void;
  commentIdea: (ideaId: string, text: string) => void;
  deleteIdeaComment: (ideaId: string, commentId: string) => void;
  deleteIdea: (ideaId: string) => void;

  loadEvents: (from: number, to: number) => void;
  createEvent: (input: {
    title: string; description?: string | null; kind?: CalendarEvent['kind'];
    startsAt: number; endsAt: number; allDay?: boolean; location?: string | null;
    channelId?: string | null; attendeeIds?: string[];
  }) => void;
  updateEvent: (eventId: string, patch: Partial<Pick<CalendarEvent,
    'title' | 'description' | 'kind' | 'startsAt' | 'endsAt' | 'allDay' | 'location' | 'channelId'>>) => void;
  respondEvent: (eventId: string, response: 'yes' | 'no' | 'maybe') => void;
  deleteEvent: (eventId: string) => void;

  loadFiles: (filter?: { channelId?: string; folder?: string }) => void;
  uploadFile: (
    file: File,
    meta?: { folder?: string; channelId?: string | null; description?: string },
    onProgress?: (anteil: number, bytes: number) => void,
  ) => Promise<void>;
  updateFile: (fileId: string, patch: { name?: string; folder?: string; description?: string | null }) => void;
  deleteFile: (fileId: string) => void;
  openAiTeamChannel: () => void;
  setAiMode: (channelId: string, mode: 'off' | 'mention' | 'always') => void;

  /* Modellwahl */
  selectModels: (input: { quality?: string | null; fast?: string | null; auto?: boolean }) => Promise<void>;
  selectProvider: (input: { anbieter: string | null; baseUrl?: string; model?: string; fastModel?: string }) => Promise<boolean>;

  setProfileUser: (userId: string | null) => void;
  jumpToMessage: (channelId: string, messageId: string) => void;
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
      reject(new Error(ts('toast.aiTimeout')));
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

/** Eine Nachricht in allen Kanallisten anfassen — wir wissen nicht immer, wo sie liegt. */
function patchEverywhere(
  messages: Record<string, Message[]>, messageId: string, patch: Partial<Message>,
): Record<string, Message[]> {
  const out: Record<string, Message[]> = {};
  for (const [channelId, list] of Object.entries(messages)) {
    out[channelId] = list.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
  }
  return out;
}

function patchThreads(
  threads: Record<string, Message[]>, messageId: string, patch: Partial<Message>,
): Record<string, Message[]> {
  const out: Record<string, Message[]> = {};
  for (const [parentId, list] of Object.entries(threads)) {
    out[parentId] = list.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
  }
  return out;
}

/** Nachricht in die chronologisch sortierte Liste einfügen bzw. ersetzen. */
/**
 * Wie viele Nachrichten je Kanal im Speicher bleiben.
 *
 * Vorher wuchs die Liste unbegrenzt: wer einen Vormittag lang scrollt, trägt
 * am Abend jede Nachricht des Jahres mit sich herum — samt Anhängen,
 * Vorschauen und Umfragen. Ältere werden beim Hochscrollen ohnehin wieder
 * nachgeladen, sie müssen nicht dauerhaft liegen bleiben.
 */
const NACHRICHTEN_JE_KANAL = 400;

/** Wie viele Kanäle ihre Nachrichten behalten dürfen. */
const KANAELE_IM_GEDAECHTNIS = 6;

/** Auf die jüngsten Einträge kürzen — die ältesten fallen vorne weg. */
function gekuerzt(list: Message[]): Message[] {
  return list.length > NACHRICHTEN_JE_KANAL ? list.slice(-NACHRICHTEN_JE_KANAL) : list;
}

/**
 * Nachrichten von Kanälen vergessen, die lange nicht offen waren.
 *
 * Der zuletzt geöffnete bleibt immer, dazu die fünf davor. Wer zurückwechselt,
 * bekommt sie in einem Wimpernschlag neu vom Server — dafür trägt niemand
 * zwanzig Kanäle im Arbeitsspeicher mit.
 */
function vergessen(
  messages: Record<string, Message[]>,
  zuletzt: string[],
): Record<string, Message[]> {
  const behalten = new Set(zuletzt.slice(0, KANAELE_IM_GEDAECHTNIS));
  if (Object.keys(messages).length <= KANAELE_IM_GEDAECHTNIS) return messages;
  const neu: Record<string, Message[]> = {};
  for (const [id, liste] of Object.entries(messages)) {
    if (behalten.has(id)) neu[id] = liste;
  }
  return neu;
}

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

import {
  dokumentSpracheSetzen, translate, spracheDesSystems, type TranslationKey,
} from '../i18n/kern.js';

/**
 * Meldungen aus dem Zustand in der Sprache der angemeldeten Person.
 *
 * Bewusst über den Kern statt über i18n/index: der lädt den Zustand, und ein
 * Ringschluss zwischen beiden wäre nur eine Frage der Zeit.
 */
function ts(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(useStore.getState().self?.uiLanguage || spracheDesSystems(), key, werte);
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
  reminders: [],
  drafts: {},

  translating: {},
  showOriginal: {},
  roundTrips: {},

  tasks: {},
  events: {},
  files: [],
  storageUsage: null,
  taskHistory: {},
  extractErgebnis: null,
  extractingTasks: false,
  serverVersion: null,
  serverBereitVersion: null,
  update: { zustand: 'aus' },
  serverUpdate: null,
  ideas: {},
  ideaComments: {},
  protocol: null,
  protocolLoading: false,
  schubladeOffen: false,
  activeChannelId: null,
  lastHumanChannelId: null,
  threadParentId: null,
  overlay: null,
  sidebarCollapsed: false,
  typing: {},
  readMarkers: {},
  zuletztOffen: [],
  toasts: [],
  smartReplies: [],
  smartRepliesLoading: false,
  catchup: null,
  catchupLoading: false,
  lightbox: null,
  searchHits: [],
  searching: false,
  forwarding: null,
  remindingAbout: null,
  profileUserId: null,
  highlightMessageId: null,
  aiThinking: {},

  /* ── Start ──────────────────────────────────────────────── */

  boot: async () => {
    if (!token()) { set({ booted: true }); return; }
    try {
      const { user, ai } = await api.me();
      set({ self: user, ai });
      applyTheme(user.theme, user.density);
      socket.connect();
      const t = token();
      if (t) void window.stellium?.updateSignIn?.(serverUrl(), t);
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
    // Ab jetzt darf der Hauptprozess nach neuen Versionen sehen.
    void window.stellium?.updateSignIn?.(serverUrl(), t);
  },

  logout: () => {
    socket.disconnect();
    setToken(null);
    void window.stellium?.updateSignOut?.();
    set({
      self: null, users: {}, channels: {}, states: {}, messages: {}, threads: {},
      activeChannelId: null, lastHumanChannelId: null, threadParentId: null, overlay: null, scheduled: [],
      catchup: null, smartReplies: [], searchHits: [],
    });
  },

  /* ── Kanäle ─────────────────────────────────────────────── */

  openChannel: (channelId) => {
    const state = get().states[channelId];
    const kanal = get().channels[channelId];
    // Merken, wo der Chat-Reiter zuletzt stand. Die beiden KI-Oberflächen
    // gehören zum KI-Reiter und zählen dafür nicht.
    const istKi = kanal
      && ((kanal.kind === 'dm' && get().users[kanal.dmPeerId ?? '']?.role === 'bot')
        || (kanal.kind === 'public' && kanal.name === 'ki-team'));
    set((s) => ({
      lastHumanChannelId: istKi ? s.lastHumanChannelId : channelId,
      // Auf dem Telefon liegt die Liste über dem Chat; nach der Wahl gehört
      // sie weg, sonst sieht man nicht, was man gerade geöffnet hat.
      schubladeOffen: false,
      activeChannelId: channelId,
      threadParentId: null,
      smartReplies: [],
      catchup: null,
      readMarkers: { ...s.readMarkers, [channelId]: state?.lastReadMessageId ?? null },
      zuletztOffen: [channelId, ...s.zuletztOffen.filter((id) => id !== channelId)],
      // Was lange niemand angesehen hat, muss nicht im Speicher bleiben.
      messages: vergessen(s.messages, [channelId, ...s.zuletztOffen.filter((id) => id !== channelId)]),
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
      kind: 'text', forwardedFrom: null, poll: null, voice: null, links: [],
      pending: true, clientId,
    };

    set((s) => {
      const next: Partial<StoreState> = { messages: { ...s.messages, [channelId]: gekuerzt(upsertMessage(s.messages[channelId], optimistic)) } };
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
      get().toast({ kind: 'info', title: ts('toast.offline'), body: ts('toast.offlineBody') });
    }
  },

  editMessage: (messageId, text) => socket.send({ t: 'message:edit', messageId, text }) as unknown as void,
  deleteMessage: (messageId, scope = 'all') =>
    socket.send({ t: 'message:delete', messageId, scope }) as unknown as void,
  react: (messageId, emoji) => socket.send({ t: 'message:react', messageId, emoji }) as unknown as void,
  pin: (messageId, pinned) => socket.send({ t: 'message:pin', messageId, pinned }) as unknown as void,
  save: (messageId, saved) => {
    socket.send({ t: 'message:save', messageId, saved });
    get().toast({ kind: 'ok', title: saved ? 'Gemerkt' : ts('toast.unsaved') });
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

  deleteChannel: (channelId) => {
    socket.send({ t: 'channel:delete', channelId });
    if (get().activeChannelId === channelId) set({ activeChannelId: null });
  },
  hideChannel: (channelId) => {
    socket.send({ t: 'channel:hide', channelId });
    if (get().activeChannelId === channelId) set({ activeChannelId: null });
  },
  setChannelMembers: (channelId, add = [], remove = []) =>
    socket.send({ t: 'channel:members', channelId, add, remove }) as unknown as void,
  muteChannel: (channelId, muted) => socket.send({ t: 'channel:mute', channelId, muted }) as unknown as void,
  starChannel: (channelId, starred) => socket.send({ t: 'channel:star', channelId, starred }) as unknown as void,

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
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? ts('toast.aiOffBody') });
      return;
    }
    const requestId = uid();
    set({ catchupLoading: true, overlay: 'catchup', catchup: null });
    void awaitReply<AiSummary>(requestId)
      .then((summary) => set({ catchup: summary, catchupLoading: false }))
      .catch((err: Error) => {
        set({ catchupLoading: false });
        get().toast({ kind: 'error', title: ts('toast.summaryFailed'), body: err.message });
      });
    /* Die Grenze mitschicken, die beim Öffnen galt.
       Ohne sie nahm der Server den Lesestand — und der ist, sobald man den
       Kanal ansieht, schon auf der neuesten Nachricht. Die Zusammenfassung
       hatte damit nie etwas zu berichten, egal wie viel aufgelaufen war. */
    socket.send({ t: 'ai:catchup', requestId, channelId, sinceMessageId: get().readMarkers[channelId] ?? null });
  },

  loadSmartReplies: (channelId, parentId) => {
    if (!get().ai?.assistant) return;
    const requestId = uid();
    set({ smartRepliesLoading: true, smartReplies: [] });
    void awaitReply<SmartReply[]>(requestId, 30_000)
      .then((replies) => set({ smartReplies: replies, smartRepliesLoading: false }))
      .catch((err: Error) => {
        set({ smartReplies: [], smartRepliesLoading: false });
        get().toast({ kind: 'error', title: ts('toast.noSuggestions'), body: err.message });
      });
    socket.send({ t: 'ai:smart-replies', requestId, channelId, parentId: parentId ?? null });
  },

  clearSmartReplies: () => set({ smartReplies: [], smartRepliesLoading: false }),

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
      get().toast({ kind: 'error', title: ts('toast.searchFailed'), body: (err as Error).message });
    }
  },

  /* ── UI ─────────────────────────────────────────────────── */

  createPoll: ({ channelId, question, options, multiple, anonymous, parentId }) => {
    socket.send({
      t: 'poll:create', clientId: uid(), channelId, question,
      options, multiple, anonymous, parentId: parentId ?? null,
    });
    set({ overlay: null });
  },

  votePoll: (pollId, optionIds) => socket.send({ t: 'poll:vote', pollId, optionIds }) as unknown as void,
  closePoll: (pollId) => socket.send({ t: 'poll:close', pollId }) as unknown as void,

  startForward: (message) => set({ forwarding: message }),
  forwardMessage: (messageId, toChannelId, comment) => {
    socket.send({ t: 'message:forward', clientId: uid(), messageId, toChannelId, comment });
    set({ forwarding: null });
    get().toast({ kind: 'ok', title: ts('toast.forwarded') });
  },

  startReminder: (message) => set({ remindingAbout: message }),
  createReminder: (input) => {
    socket.send({ t: 'reminder:create', ...input, messageId: input.messageId ?? null, note: input.note ?? null });
    set({ remindingAbout: null });
    get().toast({ kind: 'ok', title: ts('toast.reminderSet'),
      body: ts('toast.reminderBody', {
        zeit: new Date(input.remindAt).toLocaleString(
          useStore.getState().self?.uiLanguage || spracheDesSystems(),
          { weekday: 'short', hour: '2-digit', minute: '2-digit' },
        ),
      }) });
  },
  cancelReminder: (id) => socket.send({ t: 'reminder:cancel', reminderId: id }) as unknown as void,

  saveDraft: (() => {
    let timer: number | null = null;
    return (channelId: string, parentId: string | null, text: string) => {
      const key = `${channelId}:${parentId ?? ''}`;
      useStore.setState((s) => ({ drafts: { ...s.drafts, [key]: text } }));
      // Nicht bei jedem Tastendruck zum Server funken.
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        socket.send({ t: 'draft:save', channelId, parentId: parentId ?? null, text });
      }, 700);
    };
  })(),

  draftFor: (channelId, parentId) => get().drafts[`${channelId}:${parentId ?? ''}`] ?? '',

  sendVoice: ({ channelId, attachmentId, durationMs, parentId }) => {
    socket.send({ t: 'voice:send', clientId: uid(), channelId, attachmentId, durationMs, parentId: parentId ?? null });
  },
  retranscribe: (messageId) => socket.send({ t: 'voice:retranscribe', messageId }) as unknown as void,

  openAiChat: () => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? ts('toast.aiOffBody') });
      return;
    }
    socket.send({ t: 'ai:open-chat' });
  },

  setSchublade: (offen) => set({ schubladeOffen: offen }),

  openLastHumanChannel: () => {
    const gemerkt = get().lastHumanChannelId;
    if (gemerkt && get().channels[gemerkt]) return get().openChannel(gemerkt);
    // Nichts gemerkt: der erste offene Kanal, der nicht zur KI gehört.
    const ersatz = Object.values(get().channels).find(
      (c) => !c.archived && c.kind === 'public' && c.name !== 'ki-team',
    ) ?? Object.values(get().channels).find((c) => !c.archived && c.kind !== 'dm');
    if (ersatz) get().openChannel(ersatz.id);
  },

  /* ── Aufgaben ─────────────────────────────────────────── */

  loadTasks: (filter) => socket.send({ t: 'task:list', ...filter }) as unknown as void,
  createTask: (input) => socket.send({ t: 'task:create', ...input }) as unknown as void,
  updateTask: (taskId, patch) => socket.send({ t: 'task:update', taskId, patch }) as unknown as void,
  moveTask: (taskId, status, afterId) => socket.send({ t: 'task:move', taskId, status, afterId }) as unknown as void,
  commentTask: (taskId, text) => socket.send({ t: 'task:comment', taskId, text }) as unknown as void,
  watchTask: (taskId, watching) => socket.send({ t: 'task:watch', taskId, watching }) as unknown as void,
  deleteTask: (taskId) => socket.send({ t: 'task:delete', taskId }) as unknown as void,
  loadTaskHistory: (taskId) => socket.send({ t: 'task:history', taskId }) as unknown as void,

  extractTasks: (channelId) => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? undefined });
      return;
    }
    set({ extractingTasks: true, extractErgebnis: null });
    socket.send({ t: 'ai:extract-tasks', channelId, requestId: `x_${Date.now()}` });
  },
  clearExtractedTasks: () => set({ extractErgebnis: null, extractingTasks: false }),
  extractRueckgaengig: () => {
    for (const a of get().extractErgebnis?.erstellt ?? []) socket.send({ t: 'task:delete', taskId: a.id });
    set({ extractErgebnis: null });
  },

  loadProtocol: (channelId) => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? undefined });
      return;
    }
    set({ protocolLoading: true, protocol: null });
    socket.send({ t: 'ai:protocol', channelId });
  },
  clearProtocol: () => set({ protocol: null, protocolLoading: false }),

  /* ── Ideenboard ───────────────────────────────────────── */

  checkForUpdate: () => {
    if (!window.stellium?.checkForUpdate) return;
    set({ update: { zustand: 'suche' } });
    void window.stellium.checkForUpdate();
  },
  installUpdate: () => { void window.stellium?.installUpdate?.(); },
  postponeUpdate: () => { void window.stellium?.postponeUpdate?.(); },

  loadIdeas: () => socket.send({ t: 'idea:list' }) as unknown as void,
  createIdea: (input) => socket.send({ t: 'idea:create', ...input }) as unknown as void,
  updateIdea: (ideaId, patch) => socket.send({ t: 'idea:update', ideaId, patch }) as unknown as void,
  setIdeaStatus: (ideaId, status, decision) => socket.send({ t: 'idea:status', ideaId, status, decision }) as unknown as void,
  voteIdea: (ideaId, wert) => socket.send({ t: 'idea:vote', ideaId, wert }) as unknown as void,
  loadIdeaComments: (ideaId) => socket.send({ t: 'idea:comments', ideaId }) as unknown as void,
  commentIdea: (ideaId, text) => socket.send({ t: 'idea:comment', ideaId, text }) as unknown as void,
  deleteIdeaComment: (ideaId, commentId) => socket.send({ t: 'idea:comment-delete', ideaId, commentId }) as unknown as void,
  deleteIdea: (ideaId) => socket.send({ t: 'idea:delete', ideaId }) as unknown as void,

  /* ── Kalender ─────────────────────────────────────────── */

  loadEvents: (from, to) => socket.send({ t: 'event:list', from, to }) as unknown as void,
  createEvent: (input) => socket.send({ t: 'event:create', ...input }) as unknown as void,
  updateEvent: (eventId, patch) => socket.send({ t: 'event:update', eventId, patch }) as unknown as void,
  respondEvent: (eventId, response) => socket.send({ t: 'event:respond', eventId, response }) as unknown as void,
  deleteEvent: (eventId) => socket.send({ t: 'event:delete', eventId }) as unknown as void,

  /* ── Dateiablage ──────────────────────────────────────── */

  loadFiles: (filter) => socket.send({ t: 'file:list', ...filter }) as unknown as void,

  uploadFile: async (file, meta, onProgress) => {
    const form = new FormData();
    form.append('file', file);
    if (meta?.folder) form.append('folder', meta.folder);
    if (meta?.channelId) form.append('channelId', meta.channelId);
    if (meta?.description) form.append('description', meta.description);
    try {
      await api.uploadToLibrary(form, (anteil) => onProgress?.(anteil, Math.round(anteil * file.size)));
      get().loadFiles(meta?.channelId ? { channelId: meta.channelId } : undefined);
    } catch (err) {
      get().toast({ kind: 'error', title: ts('toast.uploadFailed'), body: (err as Error).message });
    }
  },
  updateFile: (fileId, patch) => socket.send({ t: 'file:update', fileId, ...patch }) as unknown as void,
  deleteFile: (fileId) => socket.send({ t: 'file:delete', fileId }) as unknown as void,

  openAiTeamChannel: () => {
    if (!get().ai?.assistant) {
      get().toast({ kind: 'error', title: ts('toast.aiOff'), body: get().ai?.note ?? undefined });
      return;
    }
    socket.send({ t: 'ai:open-team-channel' });
  },

  setAiMode: (channelId, mode) => socket.send({ t: 'ai:set-mode', channelId, mode }) as unknown as void,

  selectProvider: async (input) => {
    try {
      const { ai } = await api.selectProvider(input);
      set({ ai });
      return true;
    } catch (err) {
      get().toast({ kind: 'error', title: (err as Error).message });
      return false;
    }
  },

  selectModels: async (input) => {
    try {
      const { ai } = await api.selectModels(input);
      set({ ai });
      get().toast({
        kind: 'ok',
        title: input.auto ? ts('toast.modelAuto') : ts('toast.modelTaken'),
        body: ai.model ?? undefined,
      });
    } catch (err) {
      get().toast({ kind: 'error', title: ts('toast.modelFailed'), body: (err as Error).message });
    }
  },

  setProfileUser: (profileUserId) => set({ profileUserId }),

  jumpToMessage: (channelId, messageId) => {
    get().openChannel(channelId);
    set({ highlightMessageId: messageId });
    window.setTimeout(() => {
      const el = document.querySelector(`[data-message-id="${messageId}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.setTimeout(() => set({ highlightMessageId: null }), 2600);
    }, 450);
  },

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
  // Sprache und Leserichtung hängen am selben Ereignis wie das Aussehen:
  // beides gilt für das ganze Dokument und ändert sich zusammen.
  dokumentSpracheSetzen(useStore.getState().self?.uiLanguage || spracheDesSystems());
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
        serverVersion: ev.serverVersion,
        serverBereitVersion: ev.serverUpdate,
        users: Object.fromEntries(ev.users.map((u) => [u.id, u])),
        channels: Object.fromEntries(ev.channels.map((c) => [c.id, c])),
        states: Object.fromEntries(ev.states.map((s) => [s.channelId, s])),
        scheduled: ev.scheduled,
        reminders: ev.reminders,
        drafts: Object.fromEntries(ev.drafts.map((d: Draft) => [`${d.channelId}:${d.parentId ?? ''}`, d.text])),
      });
      const active = useStore.getState().activeChannelId
        ?? ev.channels.find((c) => c.kind === 'public')?.id
        ?? ev.channels[0]?.id;
      if (active) useStore.getState().openChannel(active);
      break;
    }

    case 'channel:focus':
      useStore.getState().openChannel(ev.channelId);
      break;

    case 'channel:history': {
      useStore.setState((s) => {
        const existing = s.messages[ev.channelId] ?? [];
        // Ältere Seite: vorne anhängen. Erste Seite: ersetzen.
        const isOlderPage = existing.length > 0 && ev.messages.length > 0
          && ev.messages[ev.messages.length - 1].createdAt < (existing[0]?.createdAt ?? Infinity);
        /* Beim Nachladen älterer Seiten nach hinten kürzen, sonst nach vorn:
           gescrollt wird nach oben, dort braucht man die alten. */
        const zusammen = isOlderPage ? [...ev.messages, ...existing] : ev.messages;
        const merged = zusammen.length > NACHRICHTEN_JE_KANAL
          ? (isOlderPage ? zusammen.slice(0, NACHRICHTEN_JE_KANAL) : zusammen.slice(-NACHRICHTEN_JE_KANAL))
          : zusammen;
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
          messages: { ...s.messages, [msg.channelId]: gekuerzt(upsertMessage(s.messages[msg.channelId], msg)) },
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
          messages: { ...s.messages, [ev.message.channelId]: gekuerzt(upsertMessage(s.messages[ev.message.channelId], ev.message)) },
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

    case 'poll:updated':
      useStore.setState((s) => ({
        messages: {
          ...s.messages,
          [ev.channelId]: (s.messages[ev.channelId] ?? []).map((m) =>
            m.id === ev.poll.messageId ? { ...m, poll: ev.poll } : m),
        },
      }));
      break;

    case 'links':
      useStore.setState((s) => ({ messages: patchEverywhere(s.messages, ev.messageId, { links: ev.links }) }));
      break;

    case 'voice:transcript':
      useStore.setState((s) => ({
        messages: patchEverywhere(s.messages, ev.messageId, { voice: ev.voice }),
        threads: patchThreads(s.threads, ev.messageId, { voice: ev.voice }),
      }));
      break;

    case 'reminder:upsert':
      useStore.setState((s) => ({
        reminders: [...s.reminders.filter((r) => r.id !== ev.reminder.id), ev.reminder]
          .sort((a, b) => a.remindAt - b.remindAt),
      }));
      break;

    case 'reminder:removed':
      useStore.setState((s) => ({ reminders: s.reminders.filter((r) => r.id !== ev.reminderId) }));
      break;

    case 'reminder:fire': {
      useStore.setState((s) => ({ reminders: s.reminders.filter((r) => r.id !== ev.reminder.id) }));
      const channel = store.channels[ev.reminder.channelId];
      const preview = ev.message?.translation?.text ?? ev.message?.text ?? '';
      store.toast({
        kind: 'info',
        title: ev.reminder.note || 'Erinnerung',
        body: preview ? preview.slice(0, 140) : `in ${channel?.name ? `#${channel.name}` : ts('toast.aChannel')}`,
      });
      void window.stellium?.notify({
        title: ev.reminder.note || 'Stellium — Erinnerung',
        body: preview.slice(0, 160) || 'Du wolltest hier noch einmal hinschauen.',
        channelId: ev.reminder.channelId,
      });
      break;
    }

    /* ── Aufgaben ─────────────────────────────────────────── */

    case 'task:list':
      useStore.setState({ tasks: Object.fromEntries(ev.tasks.map((t) => [t.id, t])) });
      break;

    case 'task:upsert':
      useStore.setState((s) => ({ tasks: { ...s.tasks, [ev.task.id]: ev.task } }));
      break;

    case 'task:removed':
      useStore.setState((s) => {
        const rest = { ...s.tasks };
        delete rest[ev.taskId];
        return { tasks: rest };
      });
      break;

    case 'task:history':
      useStore.setState((s) => ({ taskHistory: { ...s.taskHistory, [ev.taskId]: ev.events } }));
      break;

    case 'ai:extract-tasks':
      useStore.setState({
        extractingTasks: false,
        extractErgebnis: {
          erstellt: ev.erstellt.map((a) => ({ id: a.id, title: a.title })),
          uebersprungen: ev.uebersprungen,
        },
      });
      if (!ev.tasks.length) {
        store.toast({ kind: 'info', title: ts('toast.nothingFound'), body: ts('toast.noOpenTask') });
      }
      break;

    case 'ai:protocol':
      useStore.setState({ protocol: ev.protocol, protocolLoading: false });
      break;

    /* ── Ideenboard ───────────────────────────────────────── */

    case 'idea:list':
      useStore.setState({ ideas: Object.fromEntries(ev.ideas.map((i) => [i.id, i])) });
      break;

    case 'idea:upsert':
      useStore.setState((s) => ({ ideas: { ...s.ideas, [ev.idea.id]: ev.idea } }));
      break;

    case 'idea:removed':
      useStore.setState((s) => {
        const rest = { ...s.ideas };
        delete rest[ev.ideaId];
        return { ideas: rest };
      });
      break;

    case 'idea:comments':
      useStore.setState((s) => ({ ideaComments: { ...s.ideaComments, [ev.ideaId]: ev.comments } }));
      break;

    case 'server:update': {
      // Uhren gehen auseinander. Der Server schickt seine mit; die
      // Abweichung rechnen wir einmal heraus, dann zeigt jedes Gerät
      // dieselbe Restzeit.
      const abweichung = Date.now() - ev.serverZeit;
      useStore.setState({
        serverUpdate: {
          version: ev.version,
          notes: ev.notes,
          startetUm: ev.startetUm + abweichung,
          dauertEtwa: ev.dauertEtwa,
        },
      });
      break;
    }

    case 'server:update-abgesagt':
      useStore.setState({ serverUpdate: null });
      break;

    case 'release:available':
      // Der Hauptprozess prüft ohnehin regelmäßig; diese Meldung sorgt nur
      // dafür, dass eine frisch hochgeladene Version sofort ankommt.
      useStore.getState().checkForUpdate();
      break;

    /* ── Kalender ─────────────────────────────────────────── */

    case 'event:list':
      useStore.setState({ events: Object.fromEntries(ev.events.map((e) => [e.id, e])) });
      break;

    case 'event:upsert':
      useStore.setState((s) => ({ events: { ...s.events, [ev.event.id]: ev.event } }));
      break;

    case 'event:removed':
      useStore.setState((s) => {
        const rest = { ...s.events };
        delete rest[ev.eventId];
        return { events: rest };
      });
      break;

    /* ── Dateiablage ──────────────────────────────────────── */

    case 'file:list':
      useStore.setState({ files: ev.files, storageUsage: ev.usage });
      break;

    case 'file:upsert':
      useStore.setState((s) => ({
        files: [ev.file, ...s.files.filter((f) => f.id !== ev.file.id)]
          .sort((a, b) => b.createdAt - a.createdAt),
        storageUsage: ev.usage ?? s.storageUsage,
      }));
      break;

    case 'file:removed':
      useStore.setState((s) => ({ files: s.files.filter((f) => f.id !== ev.fileId) }));
      break;

    case 'drafts':
      useStore.setState({
        drafts: Object.fromEntries(ev.drafts.map((d) => [`${d.channelId}:${d.parentId ?? ''}`, d.text])),
      });
      break;

    case 'ai:model-changed':
      useStore.setState({ ai: ev.ai });
      break;

    case 'ai:thinking':
      useStore.setState((s) => ({ aiThinking: { ...s.aiThinking, [ev.channelId]: ev.active } }));
      break;

    case 'error':
      if (ev.requestId) settle(ev.requestId, null, new Error(ev.message));
      else store.toast({ kind: 'error', title: ts('toast.serverError'), body: ev.message });
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
  const title = isDm ? (author?.displayName ?? ts('toast.newMessage')) : `#${channel?.name ?? 'Kanal'}`;
  const prefix = isDm ? '' : `${author?.displayName ?? ''}: `;
  // Übersetzung bevorzugen, damit die Vorschau in der eigenen Sprache steht.
  const body = `${prefix}${msg.translation?.text ?? msg.text}`.slice(0, 180);

  // In der App über Electron, im Browser über die Web-Benachrichtigung —
  // die Entscheidung darüber, OB benachrichtigt wird, steht oben und gilt für
  // beide gleich.
  zeigen({ titel: title, text: body, kanalId: msg.channelId, gruppe: msg.channelId });
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
  // Im Browser gibt es kein Dock-Symbol — dort trägt der Reitertitel die Zahl.
  titelZaehler(total);
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

/* Im Entwicklungsmodus greifbar, damit die Prüfläufe den Zustand ansehen
   können. In der gebauten App fällt dieser Block weg. */
if (import.meta.env.DEV) {
  (window as unknown as { __stelliumStore?: typeof useStore }).__stelliumStore = useStore;
}
