/** Domänenmodelle — von Server und Desktop-Client geteilt. */

import type { MemberRoleName, PermissionKey } from './permissions.js';

export type UserStatus = 'online' | 'away' | 'dnd' | 'offline';
export type ChannelKind = 'public' | 'private' | 'dm';
export type MemberRole = MemberRoleName;

export interface User {
  id: string;
  handle: string;              // eindeutig, z.B. "don"
  displayName: string;
  email: string;
  avatarColor: string;         // Fallback-Avatar (Gradient-Seed)
  avatarUrl: string | null;
  title: string | null;        // Jobtitel
  timezone: string;            // IANA, z.B. "Europe/Berlin"
  language: string;            // Anzeigesprache (BCP-47 kurz: "de")
  autoTranslate: boolean;
  status: UserStatus;
  statusEmoji: string | null;
  statusText: string | null;
  /** Zeitpunkt, ab dem der Status automatisch zurückgesetzt wird. */
  statusExpiresAt: number | null;
  lastSeenAt: number | null;
  role: MemberRole;
  /** Gesperrte Konten können sich nicht anmelden, bleiben aber im Verlauf sichtbar. */
  disabled: boolean;
  createdAt: number;
}

/** Was der Client über sich selbst weiß (inkl. privater Felder). */
export interface SelfUser extends User {
  notifyOn: 'all' | 'mentions' | 'none';
  quietHoursStart: number | null;  // Minuten seit Mitternacht, lokal
  quietHoursEnd: number | null;
  composeTargetPreview: boolean;   // Übersetzungs-Vorschau vor dem Senden
  theme: 'system' | 'dark' | 'light';
  density: 'comfortable' | 'compact';
  /** Klang bei Benachrichtigungen — "aus" schaltet ihn ab. */
  notificationSound: string;
  /** "fast" nutzt das kleine Modell, "accurate" das große, "balanced" entscheidet nach Textlänge. */
  translationSpeed: 'fast' | 'balanced' | 'accurate';
  /** Sprache der Oberfläche — unabhängig von der Übersetzungssprache. */
  uiLanguage: string;
  /** Was diese Person darf. Vom Server berechnet, hier nur zur Anzeige. */
  permissions: Record<PermissionKey, boolean>;
  /** Erstanmeldung mit Einmal-Passwort: eigenes Passwort setzen. */
  mustChangePassword: boolean;
  /** Benutzername und E-Mail fehlen noch. */
  mustCompleteProfile: boolean;
  email: string;
}

/** Was die Verwaltung über ein Konto sieht. */
export interface ManagedUser {
  id: string;
  handle: string;
  displayName: string;
  /** Aus Datenschutzgründen nur angedeutet, z.B. "an•••@firma.de". */
  emailMasked: string;
  role: MemberRole;
  disabled: boolean;
  mustChangePassword: boolean;
  lastSeenAt: number | null;
  createdAt: number;
  createdBy: string | null;
  /** Abweichungen von der Rollenvorgabe. */
  overrides: Partial<Record<PermissionKey, boolean>>;
  permissions: Record<PermissionKey, boolean>;
}

/** Ergebnis, wenn ein Konto angelegt oder ein Passwort zurückgesetzt wurde. */
export interface OneTimeCredential {
  userId: string;
  handle: string;
  displayName: string;
  oneTimePassword: string;
  /** Nur ein einziges Mal sichtbar — danach nicht mehr abrufbar. */
  expiresAt: number;
}

export interface Channel {
  id: string;
  kind: ChannelKind;
  name: string;                // bei DMs leer -> Client rendert Teilnehmer
  topic: string | null;
  purpose: string | null;
  /** "Lingua Franca" des Kanals — Basis für die Compose-Vorschau. */
  primaryLanguage: string | null;
  /** Mischt der KI-Assistent hier mit? "off" | "mention" | "always" */
  aiMode: 'off' | 'mention' | 'always';
  /** Nur Berechtigte dürfen schreiben — für Ankündigungskanäle. */
  readOnly: boolean;
  archived: boolean;
  createdBy: string;
  createdAt: number;
  memberIds: string[];
  /** Nur bei DMs gefüllt. */
  dmPeerId?: string | null;
}

export interface ChannelState {
  channelId: string;
  lastReadMessageId: string | null;
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
  starred: boolean;
}

export interface Attachment {
  id: string;
  messageId: string;
  name: string;
  mime: string;
  size: number;
  url: string;                 // relativ zum Server: /files/<id>
  width: number | null;
  height: number | null;
}

export interface Reaction {
  emoji: string;
  userIds: string[];
}

/** Ergebnis einer Übersetzung, wie es der Client sieht. */
export interface TranslationView {
  lang: string;                // Zielsprache
  text: string;
  provider: string;            // "groq" | "deepl" | "libre" | "demo"
  model: string | null;
  /** 0..1 — Heuristik aus Round-Trip-Ähnlichkeit bzw. Provider-Angabe. */
  confidence: number | null;
  cached: boolean;
}

export interface Message {
  id: string;
  channelId: string;
  userId: string;
  parentId: string | null;     // Thread-Wurzel
  text: string;                // IMMER das Original
  sourceLang: string | null;   // erkannt oder vom Client gesetzt
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  systemKind: string | null;   // "join" | "leave" | "topic" | null
  attachments: Attachment[];
  reactions: Reaction[];
  replyCount: number;
  lastReplyAt: number | null;
  threadParticipantIds: string[];
  mentionUserIds: string[];
  pinned: boolean;
  /** "text" | "voice" | "poll" — bestimmt, wie die Nachricht dargestellt wird. */
  kind: string;
  /** Gesetzt, wenn die Nachricht aus einem anderen Kanal weitergeleitet wurde. */
  forwardedFrom: { messageId: string; channelId: string; userId: string } | null;
  /** Umfrage, falls kind === "poll". */
  poll: Poll | null;
  /** Sprachnachricht, falls kind === "voice". */
  voice: VoiceNote | null;
  /** Vorschauen zu Links im Text. */
  links: LinkPreview[];
  /** Für den Empfänger vorbereitete Übersetzung (falls Sprache abweicht). */
  translation: TranslationView | null;
  /** Für mich ausgeblendet (nicht für alle gelöscht). */
  hiddenForMe?: boolean;
  /** Optimistisch gesendete Nachricht — nur clientseitig gesetzt. */
  pending?: boolean;
  failed?: boolean;
  clientId?: string;
}

export interface SearchHit {
  message: Message;
  channelId: string;
  /** Textausschnitt mit <em>-Markierungen. */
  snippet: string;
  /** true, wenn der Treffer in der Übersetzung lag, nicht im Original. */
  matchedTranslation: boolean;
  score: number;
}

export interface GlossaryEntry {
  id: string;
  term: string;
  /** null = Begriff bleibt in jeder Sprache unverändert (z.B. Produktnamen). */
  translations: Record<string, string> | null;
  caseSensitive: boolean;
  note: string | null;
  createdBy: string;
  createdAt: number;
}

export interface ScheduledMessage {
  id: string;
  channelId: string;
  userId: string;
  text: string;
  sendAt: number;
  parentId: string | null;
  createdAt: number;
}

export interface AiSummary {
  channelId: string;
  fromMessageId: string | null;
  language: string;
  headline: string;
  bullets: string[];
  actionItems: { text: string; assigneeId: string | null }[];
  decisions: string[];
  messageCount: number;
  generatedAt: number;
  model: string;
}

export interface SmartReply {
  text: string;
  tone: 'kurz' | 'freundlich' | 'formell' | 'nachfrage';
}

/* ── Umfragen ─────────────────────────────────────────────────── */

export interface PollOption {
  id: string;
  text: string;
  voterIds: string[];      // bei anonymen Umfragen leer
  votes: number;
}

export interface Poll {
  id: string;
  messageId: string;
  question: string;
  options: PollOption[];
  multiple: boolean;
  anonymous: boolean;
  closed: boolean;
  closesAt: number | null;
  createdBy: string;
  totalVoters: number;
  /** Optionen, die der Betrachter gewählt hat. */
  myVotes: string[];
}

/* ── Link-Vorschau ────────────────────────────────────────────── */

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
}

/* ── Sprachnachricht ──────────────────────────────────────────── */

export interface VoiceNote {
  attachmentId: string;
  url: string;
  durationMs: number | null;
  /** Von Whisper erzeugtes Transkript — null, solange es noch läuft. */
  transcript: string | null;
  transcriptLang: string | null;
  /** Transkript in der Sprache des Betrachters. */
  translatedTranscript: string | null;
}

/* ── Erinnerungen ─────────────────────────────────────────────── */

export interface Reminder {
  id: string;
  messageId: string | null;
  channelId: string;
  note: string | null;
  remindAt: number;
  done: boolean;
  createdAt: number;
}

/* ── Entwürfe ─────────────────────────────────────────────────── */

export interface Draft {
  channelId: string;
  parentId: string | null;
  text: string;
  updatedAt: number;
}

/* ── Modellwahl ───────────────────────────────────────────────── */

export interface AiModelInfo {
  id: string;
  contextWindow: number;
  params: number | null;
  ownedBy: string;
  usable: boolean;
  rejected: string | null;
}

export interface AiModelSelection {
  quality: string;
  fast: string;
  source: 'auto' | 'pinned' | 'manual' | 'fallback';
  refreshedAt: number;
}

/* ── Aufgaben ─────────────────────────────────────────────────── */

export type TaskStatus = 'pending' | 'working' | 'review' | 'finished' | 'blocked';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Reihenfolge der Spalten auf dem Brett. */
export const TASK_STATUSES: TaskStatus[] = ['pending', 'working', 'review', 'finished', 'blocked'];
export const TASK_PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  channelId: string | null;
  messageId: string | null;
  dueAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  watcherIds: string[];
}

export interface TaskEvent {
  id: string;
  taskId: string;
  userId: string;
  kind: 'created' | 'status' | 'assignee' | 'due' | 'priority' | 'title' | 'comment';
  von: string | null;
  nach: string | null;
  text: string | null;
  createdAt: number;
}

/* ── Kalender ─────────────────────────────────────────────────── */

export type EventKind = 'meeting' | 'deadline' | 'absence' | 'holiday' | 'reminder';
export type AttendeeResponse = 'pending' | 'yes' | 'no' | 'maybe';

export const EVENT_KINDS: EventKind[] = ['meeting', 'deadline', 'absence', 'holiday', 'reminder'];

export interface EventAttendee {
  userId: string;
  response: AttendeeResponse;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  kind: EventKind;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location: string | null;
  channelId: string | null;
  createdBy: string;
  createdAt: number;
  attendees: EventAttendee[];
}

/* ── Dateiablage ──────────────────────────────────────────────── */

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  folder: string;
  channelId: string | null;
  description: string | null;
  uploadedBy: string;
  createdAt: number;
  updatedAt: number;
  url: string;
}

export interface StorageUsage {
  used: number;
  quota: number;
  fileCount: number;
}

/** Wie eine Nachricht gelöscht wird. */
export type DeleteScope = 'all' | 'me';
