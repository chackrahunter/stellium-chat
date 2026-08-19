/** WebSocket-Protokoll zwischen Desktop-Client und Server. */

import type {
  AiSummary, CalendarEvent, Channel, ChannelState, Draft, LinkPreview, Message,
  Idea, IdeaComment, IdeaStatus, MeetingProtocol, Poll, Reaction, ReleaseInfo, Reminder, ScheduledMessage, SelfUser, SmartReply, StoredFile, StorageUsage,
  Task, TaskEvent, TaskPriority, TaskStatus, TranslationView, User,
  UserStatus, VoiceNote,
} from './types.js';

export const WS_PROTOCOL_VERSION = 1;

/* ── Client -> Server ─────────────────────────────────────────── */

export type ClientEvent =
  | { t: 'auth'; token: string; protocol: number }
  | { t: 'ping'; ts: number }
  | { t: 'channel:open'; channelId: string; before?: string; limit?: number }
  | { t: 'channel:create'; kind: 'public' | 'private'; name: string; topic?: string; memberIds?: string[]; primaryLanguage?: string | null }
  | { t: 'channel:join'; channelId: string }
  | { t: 'channel:leave'; channelId: string }
  | { t: 'channel:update'; channelId: string; name?: string; topic?: string; purpose?: string; primaryLanguage?: string | null; archived?: boolean; readOnly?: boolean }
  | { t: 'channel:delete'; channelId: string }
  | { t: 'channel:hide'; channelId: string }
  | { t: 'channel:members'; channelId: string; add?: string[]; remove?: string[] }
  | { t: 'channel:mute'; channelId: string; muted: boolean }
  | { t: 'channel:star'; channelId: string; starred: boolean }
  | { t: 'dm:open'; userId: string }
  | { t: 'message:send'; clientId: string; channelId: string; text: string; parentId?: string | null; attachmentIds?: string[]; sourceLang?: string | null }
  | { t: 'message:edit'; messageId: string; text: string }
  | { t: 'message:delete'; messageId: string; scope?: 'all' | 'me' }
  | { t: 'message:react'; messageId: string; emoji: string }
  | { t: 'message:pin'; messageId: string; pinned: boolean }
  | { t: 'message:save'; messageId: string; saved: boolean }
  | { t: 'message:schedule'; channelId: string; text: string; sendAt: number; parentId?: string | null }
  | { t: 'message:unschedule'; scheduledId: string }
  | { t: 'thread:open'; messageId: string }
  | { t: 'typing'; channelId: string; parentId?: string | null }
  | { t: 'read'; channelId: string; lastMessageId: string }
  | { t: 'presence:set'; status: UserStatus; statusEmoji?: string | null; statusText?: string | null; statusExpiresAt?: number | null }
  | { t: 'prefs:update'; patch: Partial<Pick<SelfUser,
      'language' | 'autoTranslate' | 'notifyOn' | 'theme' | 'density' |
      'composeTargetPreview' | 'quietHoursStart' | 'quietHoursEnd' |
      'displayName' | 'title' | 'timezone' | 'notificationSound' | 'translationSpeed'
      | 'uiLanguage'>> }
  | { t: 'translate:request'; messageId: string; targetLang: string; force?: boolean }
  | { t: 'translate:roundtrip'; messageId: string; targetLang: string }
  | { t: 'compose:preview'; requestId: string; text: string; targetLang: string; channelId: string }
  | { t: 'ai:catchup'; requestId: string; channelId: string; sinceMessageId?: string | null }
  | { t: 'ai:thread-summary'; requestId: string; messageId: string }
  | { t: 'ai:smart-replies'; requestId: string; channelId: string; parentId?: string | null }
  | { t: 'ai:rewrite'; requestId: string; text: string; tone: RewriteTone; targetLang?: string | null }
  | { t: 'ai:ask'; requestId: string; channelId: string; question: string }

  /* Umfragen */
  | { t: 'poll:create'; clientId: string; channelId: string; question: string; options: string[]; multiple: boolean; anonymous: boolean; closesAt?: number | null; parentId?: string | null }
  | { t: 'poll:vote'; pollId: string; optionIds: string[] }
  | { t: 'poll:close'; pollId: string }

  /* Weiterleiten */
  | { t: 'message:forward'; clientId: string; messageId: string; toChannelId: string; comment?: string }

  /* Erinnerungen */
  | { t: 'reminder:create'; messageId?: string | null; channelId: string; note?: string | null; remindAt: number }
  | { t: 'reminder:cancel'; reminderId: string }
  | { t: 'reminder:done'; reminderId: string }

  /* Entwürfe */
  | { t: 'draft:save'; channelId: string; parentId?: string | null; text: string }

  /* Sprachnachrichten */
  | { t: 'voice:send'; clientId: string; channelId: string; attachmentId: string; durationMs: number; parentId?: string | null }
  | { t: 'voice:retranscribe'; messageId: string }

  /* KI-Assistent als Gesprächspartner */
  | { t: 'ai:open-chat' }
  | { t: 'ai:open-team-channel' }
  | { t: 'ai:set-mode'; channelId: string; mode: 'off' | 'mention' | 'always' }

  /* Aufgaben */
  | { t: 'task:list'; channelId?: string | null; assigneeId?: string | null }
  | { t: 'task:create'; title: string; description?: string | null; assigneeId?: string | null; channelId?: string | null; messageId?: string | null; dueAt?: number | null; priority?: TaskPriority; status?: TaskStatus }
  | { t: 'task:update'; taskId: string; patch: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigneeId?: string | null; dueAt?: number | null } }
  | { t: 'task:move'; taskId: string; status: TaskStatus; afterId?: string | null }
  | { t: 'task:comment'; taskId: string; text: string }
  | { t: 'task:watch'; taskId: string; watching: boolean }
  | { t: 'task:delete'; taskId: string }
  | { t: 'task:history'; taskId: string }
  | { t: 'ai:extract-tasks'; requestId: string; channelId: string }
  | { t: 'ai:protocol'; channelId: string; sinceMessageId?: string | null }

  /* Ideenboard */
  | { t: 'idea:list' }
  | { t: 'idea:create'; title: string; body?: string | null; tag?: string; channelId?: string | null }
  | { t: 'idea:update'; ideaId: string; patch: { title?: string; body?: string | null; tag?: string; channelId?: string | null } }
  | { t: 'idea:status'; ideaId: string; status: IdeaStatus; decision?: string | null }
  | { t: 'idea:vote'; ideaId: string; wert: 1 | -1 }
  | { t: 'idea:comments'; ideaId: string }
  | { t: 'idea:comment'; ideaId: string; text: string }
  | { t: 'idea:comment-delete'; commentId: string; ideaId: string }
  | { t: 'idea:delete'; ideaId: string }

  /* Kalender */
  | { t: 'event:list'; from: number; to: number }
  | { t: 'event:create'; title: string; description?: string | null; kind?: string; startsAt: number; endsAt: number; allDay?: boolean; location?: string | null; channelId?: string | null; attendeeIds?: string[] }
  | { t: 'event:update'; eventId: string; patch: { title?: string; description?: string | null; startsAt?: number; endsAt?: number; allDay?: boolean; location?: string | null; kind?: string } }
  | { t: 'event:respond'; eventId: string; response: 'yes' | 'no' | 'maybe' }
  | { t: 'event:attendees'; eventId: string; add?: string[]; remove?: string[] }
  | { t: 'event:delete'; eventId: string }

  /* Dateiablage */
  | { t: 'file:list'; channelId?: string | null; folder?: string }
  | { t: 'file:update'; fileId: string; name?: string; description?: string | null; folder?: string }
  | { t: 'file:delete'; fileId: string };

export type RewriteTone =
  | 'polish' | 'formal' | 'friendly' | 'concise' | 'expand' | 'bullets' | 'apologize';

/* ── Server -> Client ─────────────────────────────────────────── */

export type ServerEvent =
  | { t: 'ready'; self: SelfUser; users: User[]; channels: Channel[]; states: ChannelState[]; scheduled: ScheduledMessage[]; reminders: Reminder[]; drafts: Draft[]; serverTime: number; /** Stand, der auf dem Server läuft. */ serverVersion: string;
      /** Fassung, die für den Server bereitliegt und noch nicht eingespielt ist. */
      serverUpdate: string | null; ai: AiCapabilities }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: string; message: string; requestId?: string }
  | { t: 'channel:history'; channelId: string; messages: Message[]; hasMore: boolean }
  | { t: 'channel:upsert'; channel: Channel }
  | { t: 'channel:removed'; channelId: string }
  | { t: 'channel:state'; state: ChannelState }
  | { t: 'message:new'; message: Message; clientId?: string }
  | { t: 'message:updated'; message: Message }
  | { t: 'message:deleted'; messageId: string; channelId: string }
  | { t: 'reaction:updated'; messageId: string; channelId: string; reactions: Reaction[] }
  | { t: 'thread:history'; parentId: string; channelId: string; messages: Message[] }
  | { t: 'typing'; channelId: string; userId: string; parentId: string | null }
  | { t: 'presence'; userId: string; status: UserStatus; statusEmoji: string | null; statusText: string | null; statusExpiresAt: number | null; lastSeenAt: number | null }
  | { t: 'read'; channelId: string; userId: string; lastMessageId: string }
  | { t: 'user:upsert'; user: User }
  | { t: 'self:updated'; self: SelfUser }
  | { t: 'translation'; messageId: string; translation: TranslationView }
  | { t: 'roundtrip'; messageId: string; targetLang: string; backTranslation: string; similarity: number }
  | { t: 'compose:preview'; requestId: string; text: string; targetLang: string; sourceLang: string }
  | { t: 'scheduled:upsert'; item: ScheduledMessage }
  | { t: 'scheduled:removed'; scheduledId: string }
  | { t: 'ai:catchup'; requestId: string; summary: AiSummary }
  | { t: 'ai:thread-summary'; requestId: string; messageId: string; summary: AiSummary }
  | { t: 'ai:smart-replies'; requestId: string; replies: SmartReply[] }
  | { t: 'ai:rewrite'; requestId: string; text: string }
  | { t: 'ai:ask'; requestId: string; answer: string; citedMessageIds: string[] }

  | { t: 'poll:updated'; poll: Poll; channelId: string }
  | { t: 'reminder:upsert'; reminder: Reminder }
  | { t: 'reminder:removed'; reminderId: string }
  | { t: 'reminder:fire'; reminder: Reminder; message: Message | null }
  | { t: 'drafts'; drafts: Draft[] }
  | { t: 'voice:transcript'; messageId: string; voice: VoiceNote }
  | { t: 'links'; messageId: string; links: LinkPreview[] }
  | { t: 'ai:model-changed'; ai: AiCapabilities }
  /** Der Assistent formuliert gerade eine Antwort. */
  | { t: 'ai:thinking'; channelId: string; active: boolean }

  | { t: 'task:list'; tasks: Task[] }
  | { t: 'task:upsert'; task: Task }
  | { t: 'task:removed'; taskId: string }
  | { t: 'task:history'; taskId: string; events: TaskEvent[] }
  | {
      t: 'ai:extract-tasks'; requestId: string;
      tasks: { title: string; assigneeId: string | null; dueAt: number | null }[];
      /** Gleich angelegte Aufgaben — die Erkennung fragt nicht mehr nach. */
      erstellt: Task[];
      /** Wie viele es schon gab und darum nicht doppelt entstanden sind. */
      uebersprungen: number;
    }
  | { t: 'ai:protocol'; protocol: MeetingProtocol }
  | { t: 'idea:list'; ideas: Idea[] }
  | { t: 'idea:upsert'; idea: Idea }
  | { t: 'idea:removed'; ideaId: string }
  | { t: 'idea:comments'; ideaId: string; comments: IdeaComment[] }
  | { t: 'release:available'; release: ReleaseInfo }
  /** Bitte diesen Kanal anzeigen — etwa, wenn er gerade erst entstanden ist. */
  | { t: 'channel:focus'; channelId: string }
  /**
   * Der Server aktualisiert sich gleich selbst und ist dabei kurz weg.
   * Alle Angaben in Millisekunden seit der Epoche, damit alle Uhren
   * dieselbe Zeit anzeigen — eine mitgeschickte Restdauer liefe auf jedem
   * Gerät anders, je nachdem wann die Meldung ankam.
   */
  | { t: 'server:update'; version: string; notes: string | null; startetUm: number; dauertEtwa: number; serverZeit: number }
  | { t: 'server:update-abgesagt' }

  | { t: 'event:list'; events: CalendarEvent[] }
  | { t: 'event:upsert'; event: CalendarEvent }
  | { t: 'event:removed'; eventId: string }

  | { t: 'file:list'; files: StoredFile[]; usage: { used: number; quota: number; fileCount: number } }
  | { t: 'file:upsert'; file: StoredFile; usage?: StorageUsage }
  | { t: 'file:removed'; fileId: string };

export interface AiCapabilities {
  provider: string;
  /** Kann der Anbieter Sprachnachrichten transkribieren? */
  transcription: boolean;
  transcriptionModel: string | null;
  /** Modell für Übersetzung und Zusammenfassungen. */
  model: string | null;
  /** Kleineres Modell für Antwortvorschläge und kurze Aufgaben. */
  fastModel: string | null;
  /** Wie das Modell zustande kam. */
  modelSource: 'auto' | 'pinned' | 'manual' | 'fallback' | null;
  /** Wie viele brauchbare Modelle der Anbieter gerade anbietet. */
  modelsAvailable: number | null;
  translation: boolean;
  assistant: boolean;
  /** Menschenlesbarer Hinweis, wenn KI deaktiviert ist. */
  note: string | null;
}

export function encode(ev: ClientEvent | ServerEvent): string {
  return JSON.stringify(ev);
}

export function decode<T = ClientEvent | ServerEvent>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}
