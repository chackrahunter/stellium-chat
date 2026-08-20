/** Domänenmodelle — von Server und Desktop-Client geteilt. */

import type { MemberRoleName, PermissionKey } from './permissions.js';
import type { DateiHuelle } from './vertraulich.js';

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
/**
 * Schubladen in der Kontenverwaltung.
 *
 * Bei acht Konten hilft eine Liste, bei achtzig nicht mehr. Die Einordnung
 * geschieht von selbst — neue Konten landen unter "neu", Bots unter
 * "technisch", gelöschte unter "geloescht" — und lässt sich jederzeit von Hand
 * ändern. Nur "geloescht" ist nicht verhandelbar: was gelöscht ist, gehört
 * nirgendwo anders hin.
 */
export const KONTO_KATEGORIEN = [
  'neu', 'mitglieder', 'leitung', 'technisch', 'extern', 'geloescht',
] as const;
export type KontoKategorie = (typeof KONTO_KATEGORIEN)[number];

export interface ManagedUser {
  id: string;
  handle: string;
  displayName: string;
  /** Aus Datenschutzgründen nur angedeutet, z.B. "an•••@firma.de". */
  emailMasked: string;
  role: MemberRole;
  disabled: boolean;
  /** Gelöscht heißt: anonymisiert, damit Nachrichten lesbar bleiben. */
  deletedAt: number | null;
  /** Schublade in der Verwaltung. Leer heißt: von selbst einsortieren. */
  kategorie: KontoKategorie | null;
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
  /**
   * Ende-zu-Ende verschlüsselt: der Server sieht nur Chiffrat.
   *
   * Damit fallen alle Funktionen weg, die Klartext brauchen — Übersetzung,
   * Zusammenfassungen, Antwortvorschläge, serverseitige Suche,
   * Aufgabenerkennung. Das ist kein Versehen, sondern der Preis dafür, dass
   * auch der Server nicht mitliest.
   */
  vertraulich: boolean;
  /**
   * Welche Fassung des Kanalschlüssels gerade gilt.
   *
   * Sie zählt hoch, sobald jemand den Kanal verlässt. Alte Nachrichten bleiben
   * mit der alten Fassung lesbar: wer geht, verliert nicht rückwirkend, was er
   * ohnehin schon gelesen hat — aber alles Neue bleibt ihm verschlossen.
   */
  schluesselFassung: number;
  archived: boolean;
  createdBy: string;
  createdAt: number;
  memberIds: string[];
  /** Nur bei DMs gefüllt. */
  dmPeerId?: string | null;
  /** Angezeigter Name, Thema und Zweck in der Lesesprache. */
  translation?: {
    lang: string;
    name: string | null;
    topic: string | null;
    purpose: string | null;
  } | null;
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
  /**
   * Für welchen Kreis der Dateischlüssel verpackt ist — null heißt: offen.
   *
   * Die Oberfläche braucht das, bevor sie irgendetwas anzeigt: bei einer
   * verschlossenen Datei sind `name` und `mime` nur Platzhalter, die echten
   * stehen im Umschlag der Datei. Ein `<img src>` darauf ergäbe ein kaputtes
   * Bild — geholt, aufgeschlossen und angezeigt wird sie in der App.
   */
  huelle: DateiHuelle | null;
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
  /**
   * true heißt: es gibt keine Übersetzung, `text` ist das Original.
   *
   * Der Anbieter hat entweder den Eingabetext zurückgegeben oder gar nicht
   * geantwortet. Die Oberfläche muss das dann als Original ausweisen — ein
   * „Übersetzt aus …" an unübersetztem Text ist eine Falschauskunft.
   */
  unuebersetzt?: boolean;
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
  /** Frage und Antworten in der Lesesprache, falls übersetzt. */
  translation?: {
    lang: string;
    question: string;
    options: Record<string, string>;
    provider: string;
  } | null;
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

/* ── Ankündigung einer Serverauszeit ──────────────────────────── */

export interface ServerUpdateInfo {
  version: string;
  notes: string | null;
  /** Wann es losgeht — Millisekunden seit der Epoche. */
  startetUm: number;
  /** Wie lange es voraussichtlich dauert, in Millisekunden. */
  dauertEtwa: number;
  /** Uhrzeit des Servers beim Absenden, um Abweichungen auszugleichen. */
  serverZeit: number;
}

/* ── App-Versionen ────────────────────────────────────────────── */

/** Auch der Server selbst bekommt seine Stände über denselben Weg. */
export type ReleasePlatform = 'darwin' | 'win32' | 'linux' | 'server';

export interface ReleaseInfo {
  platform: ReleasePlatform;
  version: string;
  notes: string | null;
  size: number;
  /** Prüfsumme der Datei, damit der Client den Download überprüfen kann. */
  sha256: string;
  fileName: string;
  url: string;
  publishedBy: string;
  publishedAt: number;
}

/* ── Ideenboard ───────────────────────────────────────────────── */

export type IdeaStatus = 'new' | 'working' | 'done' | 'rejected';
export const IDEA_STATUSES: IdeaStatus[] = ['new', 'working', 'done', 'rejected'];

export interface Idea {
  id: string;
  title: string;
  body: string | null;
  status: IdeaStatus;
  tag: string;
  channelId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decision: string | null;
  upvotes: number;
  downvotes: number;
  /** Eigene Stimme: 1 dafür, -1 dagegen, 0 keine. */
  myVote: 1 | -1 | 0;
  commentCount: number;
}

export interface IdeaComment {
  id: string;
  ideaId: string;
  userId: string;
  text: string;
  createdAt: number;
}

/* ── Vorschlagseingang ────────────────────────────────────────── */

/**
 * Woraus ein angenommener Vorschlag wird.
 *
 * Die Art rät das Modell — sie ist der unsicherste Teil eines Vorschlags.
 * Deshalb ist sie auf der Karte umschaltbar und nicht als Reiter verbaut:
 * ein Fehlgriff kostet einen Klick, nicht den ganzen Vorschlag.
 */
export type VorschlagArt = 'aufgabe' | 'idee';

/**
 * Der Weg eines Vorschlags: `offen` -> angenommen, abgelehnt oder verfallen.
 *
 * Abgelehnte und verfallene Zeilen bleiben stehen. Sie belegen weiter ihren
 * Platz in `UNIQUE(channel_id, art, abdruck)` und sind damit das Gedächtnis,
 * das denselben Vorschlag nicht wiederkommen lässt — auch nicht anders
 * formuliert, auch nicht nach einem Neustart.
 */
export type VorschlagZustand = 'offen' | 'angenommen' | 'abgelehnt' | 'verfallen';

/** Was die Oberfläche von einem Vorschlag sieht. */
export interface Vorschlag {
  id: string;
  art: VorschlagArt;
  zustand: VorschlagZustand;
  titel: string;
  channelId: string;
  /** Name des Kanals, damit die Karte ihn ohne zweiten Abruf zeigen kann. */
  channelName: string;
  quelleMessageId: string | null;
  /**
   * Der Wortlaut der Nachricht, aus der er stammt — gekürzt.
   *
   * Aus einem vertraulichen Kanal steht hier immer `null`: der Server kann
   * den Inhalt nicht lesen, und was er nicht lesen kann, gibt er nicht heraus.
   */
  quelleText: string | null;
  quelleUserId: string | null;
  quelleAm: number | null;
  /** Genau ein Adressat — wer ihn annehmen oder ablehnen darf. */
  fuerUserId: string;
  genanntUserId: string | null;
  faelligAm: number | null;
  erstelltAm: number;
  /** Bei angenommenen: die Kennung der entstandenen Aufgabe oder Idee. */
  ergebnisId: string | null;
}

/**
 * Was sich vor dem Annehmen ändern lässt.
 *
 * Genau die vier Felder entscheiden, ob man Ja sagen kann, und genau die
 * trifft das Modell knapp daneben. Beschreibung, Wichtigkeit, Schlagwort und
 * Status gehören dem fertigen Ding und bleiben dem Brett.
 */
export interface VorschlagAenderung {
  titel?: string;
  art?: VorschlagArt;
  zustaendigId?: string | null;
  faelligAm?: number | null;
}

/* ── Protokoll ────────────────────────────────────────────────── */

/** Ergebnis einer Besprechung, weitergabefähig zusammengefasst. */
export interface MeetingProtocol {
  channelId: string;
  language: string;
  title: string;
  topics: { heading: string; points: string[] }[];
  decisions: string[];
  openQuestions: string[];
  actionItems: { text: string; assigneeId: string | null }[];
  messageCount: number;
  generatedAt: number;
}

/* ── Dateiablage ──────────────────────────────────────────────── */

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  /**
   * Privat heißt: der Inhalt wurde in der App verschlüsselt, bevor er den
   * Rechner verlassen hat. Der Server verwahrt ihn, kann ihn aber nicht
   * öffnen — auch nicht mit dem Masterpasswort.
   */
  privat: boolean;
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
