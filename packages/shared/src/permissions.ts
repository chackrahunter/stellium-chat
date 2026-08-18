/**
 * Rechte-Katalog.
 *
 * Jedes Recht ist eine einzelne Erlaubnis. Rollen sind nur Vorlagen: sie geben
 * einen Satz Vorgaben, und für einzelne Personen kann davon abgewichen werden.
 * Durchgesetzt wird alles auf dem Server — die Oberfläche blendet Dinge nur
 * zusätzlich aus, damit niemand gegen Wände läuft.
 */

export type PermissionKey =
  /* Nachrichten */
  | 'message.send'
  | 'message.edit_own'
  | 'message.delete_own'
  | 'message.delete_any'
  | 'message.pin'
  | 'message.forward'
  | 'message.schedule'
  | 'reaction.add'
  /* Erwähnungen */
  | 'mention.user'
  | 'mention.everyone'
  /* Kanäle */
  | 'channel.create'
  | 'channel.create_private'
  | 'channel.manage'
  | 'channel.archive'
  | 'channel.delete'
  | 'channel.members'
  | 'dm.start'
  /* Inhalte */
  | 'file.upload'
  | 'voice.send'
  | 'poll.create'
  | 'poll.close_any'
  /* KI und Übersetzung */
  | 'ai.translate'
  | 'ai.assistant'
  | 'ai.model_select'
  | 'glossary.manage'
  /* Verwaltung */
  | 'user.invite'
  | 'user.manage'
  | 'user.delete'
  | 'permission.manage';

export interface PermissionInfo {
  key: PermissionKey;
  /** Gruppe für die Darstellung in den Einstellungen. */
  group: 'nachrichten' | 'kanaele' | 'inhalte' | 'ki' | 'verwaltung';
  labelDe: string;
  labelEn: string;
  hintDe: string;
  hintEn: string;
  /** Nur Owner darf dieses Recht vergeben. */
  ownerOnly?: boolean;
}

export const PERMISSIONS: PermissionInfo[] = [
  { key: 'message.send', group: 'nachrichten',
    labelDe: 'Nachrichten senden', labelEn: 'Send messages',
    hintDe: 'Ohne dieses Recht kann jemand nur mitlesen.', hintEn: 'Without this, the person can only read along.' },
  { key: 'message.edit_own', group: 'nachrichten',
    labelDe: 'Eigene Nachrichten bearbeiten', labelEn: 'Edit own messages',
    hintDe: 'Tippfehler nachträglich korrigieren.', hintEn: 'Fix typos after sending.' },
  { key: 'message.delete_own', group: 'nachrichten',
    labelDe: 'Eigene Nachrichten löschen', labelEn: 'Delete own messages',
    hintDe: '', hintEn: '' },
  { key: 'message.delete_any', group: 'nachrichten',
    labelDe: 'Fremde Nachrichten löschen', labelEn: 'Delete anyone’s messages',
    hintDe: 'Für Moderation. Sparsam vergeben.', hintEn: 'For moderation. Grant sparingly.' },
  { key: 'message.pin', group: 'nachrichten',
    labelDe: 'Nachrichten anpinnen', labelEn: 'Pin messages',
    hintDe: '', hintEn: '' },
  { key: 'message.forward', group: 'nachrichten',
    labelDe: 'Weiterleiten', labelEn: 'Forward messages',
    hintDe: 'Nachrichten in andere Kanäle tragen.', hintEn: 'Carry messages into other channels.' },
  { key: 'message.schedule', group: 'nachrichten',
    labelDe: 'Später senden', labelEn: 'Schedule messages',
    hintDe: '', hintEn: '' },
  { key: 'reaction.add', group: 'nachrichten',
    labelDe: 'Reagieren', labelEn: 'React with emoji',
    hintDe: '', hintEn: '' },

  { key: 'mention.user', group: 'nachrichten',
    labelDe: 'Personen erwähnen', labelEn: 'Mention people',
    hintDe: 'Löst bei der erwähnten Person eine Benachrichtigung aus.', hintEn: 'Triggers a notification for that person.' },
  { key: 'mention.everyone', group: 'nachrichten',
    labelDe: 'Alle erwähnen', labelEn: 'Mention everyone',
    hintDe: '@alle benachrichtigt den gesamten Kanal.', hintEn: '@everyone notifies the whole channel.' },

  { key: 'channel.create', group: 'kanaele',
    labelDe: 'Kanäle anlegen', labelEn: 'Create channels',
    hintDe: '', hintEn: '' },
  { key: 'channel.create_private', group: 'kanaele',
    labelDe: 'Private Kanäle anlegen', labelEn: 'Create private channels',
    hintDe: 'Private Kanäle sind für Nichtmitglieder unsichtbar.', hintEn: 'Private channels are invisible to non-members.' },
  { key: 'channel.manage', group: 'kanaele',
    labelDe: 'Kanäle bearbeiten', labelEn: 'Edit channels',
    hintDe: 'Thema, Zweck und Kanalsprache ändern.', hintEn: 'Change topic, purpose and channel language.' },
  { key: 'channel.archive', group: 'kanaele',
    labelDe: 'Kanäle archivieren', labelEn: 'Archive channels',
    hintDe: 'Archivierte Kanäle verschwinden aus der Liste, bleiben aber lesbar.',
    hintEn: 'Archived channels leave the list but stay readable.' },
  { key: 'channel.delete', group: 'kanaele',
    labelDe: 'Kanäle löschen', labelEn: 'Delete channels',
    hintDe: 'Unwiderruflich, samt aller Nachrichten. Meist ist Archivieren die bessere Wahl.',
    hintEn: 'Irreversible, including all messages. Archiving is usually the better choice.' },
  { key: 'channel.members', group: 'kanaele',
    labelDe: 'Mitglieder verwalten', labelEn: 'Manage members',
    hintDe: 'Personen zu Kanälen hinzufügen und entfernen.',
    hintEn: 'Add people to channels and remove them.' },
  { key: 'dm.start', group: 'kanaele',
    labelDe: 'Direktnachrichten schreiben', labelEn: 'Start direct messages',
    hintDe: '', hintEn: '' },

  { key: 'file.upload', group: 'inhalte',
    labelDe: 'Dateien hochladen', labelEn: 'Upload files',
    hintDe: '', hintEn: '' },
  { key: 'voice.send', group: 'inhalte',
    labelDe: 'Sprachnachrichten senden', labelEn: 'Send voice messages',
    hintDe: 'Wird von Whisper transkribiert und übersetzt.', hintEn: 'Transcribed by Whisper and translated.' },
  { key: 'poll.create', group: 'inhalte',
    labelDe: 'Umfragen starten', labelEn: 'Create polls',
    hintDe: '', hintEn: '' },
  { key: 'poll.close_any', group: 'inhalte',
    labelDe: 'Fremde Umfragen beenden', labelEn: 'Close anyone’s polls',
    hintDe: '', hintEn: '' },

  { key: 'ai.translate', group: 'ki',
    labelDe: 'Live-Übersetzung nutzen', labelEn: 'Use live translation',
    hintDe: 'Ohne dieses Recht bleiben Nachrichten im Original.', hintEn: 'Without this, messages stay in their original language.' },
  { key: 'ai.assistant', group: 'ki',
    labelDe: 'KI-Funktionen nutzen', labelEn: 'Use AI features',
    hintDe: 'Zusammenfassungen, Antwortvorschläge, Umformulieren.', hintEn: 'Summaries, smart replies, rewriting.' },
  { key: 'ai.model_select', group: 'ki',
    labelDe: 'KI-Modell festlegen', labelEn: 'Choose the AI model',
    hintDe: 'Gilt für den gesamten Arbeitsbereich.', hintEn: 'Applies to the whole workspace.' },
  { key: 'glossary.manage', group: 'ki',
    labelDe: 'Glossar pflegen', labelEn: 'Manage the glossary',
    hintDe: 'Begriffe, die nie falsch übersetzt werden dürfen.', hintEn: 'Terms that must never be mistranslated.' },

  { key: 'user.invite', group: 'verwaltung',
    labelDe: 'Konten anlegen', labelEn: 'Create accounts',
    hintDe: 'Erzeugt ein Einmal-Passwort für neue Kolleg:innen.', hintEn: 'Generates a one-time password for new colleagues.' },
  { key: 'user.manage', group: 'verwaltung',
    labelDe: 'Konten verwalten', labelEn: 'Manage accounts',
    hintDe: 'Passwörter zurücksetzen, sperren, Rollen ändern.', hintEn: 'Reset passwords, disable accounts, change roles.' },
  { key: 'user.delete', group: 'verwaltung', ownerOnly: true,
    labelDe: 'Konten löschen', labelEn: 'Delete accounts',
    hintDe: 'Unwiderruflich. Nachrichten bleiben erhalten.', hintEn: 'Irreversible. Messages are kept.' },
  { key: 'permission.manage', group: 'verwaltung', ownerOnly: true,
    labelDe: 'Rechte vergeben', labelEn: 'Grant permissions',
    hintDe: 'Wer das hat, kann sich selbst alles geben.', hintEn: 'Whoever has this can grant themselves anything.' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export type MemberRoleName =
  | 'owner' | 'admin' | 'moderator' | 'teamlead'
  | 'member' | 'contributor' | 'guest' | 'readonly' | 'bot';

export interface RoleInfo {
  name: MemberRoleName;
  labelDe: string;
  labelEn: string;
  hintDe: string;
  hintEn: string;
  /** Nur der Owner darf diese Rolle vergeben. */
  ownerOnly?: boolean;
  /** Nicht für Menschen gedacht. */
  technical?: boolean;
}

/* ── Rechteprofile ────────────────────────────────────────────── */

const ALLE = PERMISSION_KEYS;

/** Nur mitlesen. Für Praktikanten in der Einarbeitung, Archiv-Zugänge, Audits. */
const NUR_LESEN: PermissionKey[] = [
  'ai.translate',
];

/** Darf antworten und reagieren, aber nichts Eigenes anstoßen. */
const GAST: PermissionKey[] = [
  ...NUR_LESEN,
  'message.send', 'message.edit_own', 'message.delete_own', 'reaction.add',
];

/** Arbeitet mit, legt aber keine Struktur an. Für Externe und Werkstudenten. */
const MITWIRKEND: PermissionKey[] = [
  ...GAST,
  'mention.user', 'file.upload', 'voice.send', 'message.forward', 'dm.start',
  'ai.assistant',
];

/** Der Normalfall im Team. */
const MITGLIED: PermissionKey[] = [
  ...MITWIRKEND,
  'message.pin', 'message.schedule', 'channel.create', 'poll.create',
];

/** Hält die Kanäle in Ordnung, verwaltet aber keine Konten. */
const MODERATOR: PermissionKey[] = [
  ...MITGLIED,
  'message.delete_any', 'mention.everyone', 'poll.close_any',
  'channel.create_private', 'channel.manage', 'channel.archive', 'channel.members',
  'glossary.manage',
];

/** Führt ein Team: nimmt Leute auf und setzt Passwörter zurück. */
const TEAMLEITUNG: PermissionKey[] = [
  ...MITGLIED,
  'mention.everyone', 'channel.create_private', 'channel.manage', 'channel.members',
  'user.invite', 'user.manage',
];

/** Alles außer den Owner-Vorbehalten (Löschen und Rechtevergabe). */
const ADMIN: PermissionKey[] = ALLE.filter(
  (k) => k !== 'user.delete' && k !== 'permission.manage' && k !== 'channel.delete',
);

/** Integrationen und der KI-Assistent: schreiben, aber nichts verwalten. */
const BOT: PermissionKey[] = [
  'message.send', 'message.edit_own', 'message.delete_own',
  'reaction.add', 'file.upload', 'ai.translate',
];

export const ROLES: RoleInfo[] = [
  { name: 'owner', ownerOnly: true,
    labelDe: 'Inhaber', labelEn: 'Owner',
    hintDe: 'Darf alles und kann nicht eingeschränkt werden. Nur der Inhaber vergibt diese Rolle.',
    hintEn: 'May do everything and cannot be restricted. Only the owner grants this role.' },
  { name: 'admin',
    labelDe: 'Administrator', labelEn: 'Administrator',
    hintDe: 'Verwaltet Konten, Kanäle und die KI. Kann keine Konten löschen und keine Rechte vergeben.',
    hintEn: 'Manages accounts, channels and the AI. Cannot delete accounts or grant permissions.' },
  { name: 'moderator',
    labelDe: 'Moderation', labelEn: 'Moderator',
    hintDe: 'Hält die Kanäle in Ordnung: fremde Nachrichten löschen, Umfragen beenden, Glossar pflegen. Ohne Kontoverwaltung.',
    hintEn: 'Keeps channels tidy: delete others’ messages, close polls, maintain the glossary. No account management.' },
  { name: 'teamlead',
    labelDe: 'Teamleitung', labelEn: 'Team lead',
    hintDe: 'Nimmt neue Leute auf und setzt Passwörter zurück. Vergibt keine Einzelrechte.',
    hintEn: 'Onboards people and resets passwords. Does not grant individual permissions.' },
  { name: 'member',
    labelDe: 'Mitglied', labelEn: 'Member',
    hintDe: 'Der Normalfall: schreiben, Kanäle anlegen, Umfragen starten, KI nutzen.',
    hintEn: 'The normal case: write, create channels, start polls, use the AI.' },
  { name: 'contributor',
    labelDe: 'Mitwirkend', labelEn: 'Contributor',
    hintDe: 'Arbeitet mit, legt aber keine Kanäle oder Umfragen an. Passend für Externe und Werkstudierende.',
    hintEn: 'Takes part but creates no channels or polls. Suits externals and working students.' },
  { name: 'guest',
    labelDe: 'Gast', labelEn: 'Guest',
    hintDe: 'Antwortet und reagiert. Keine Dateien, keine Erwähnungen, keine KI-Hilfen.',
    hintEn: 'Replies and reacts. No files, no mentions, no AI assistance.' },
  { name: 'readonly',
    labelDe: 'Nur lesen', labelEn: 'Read only',
    hintDe: 'Liest mit, schreibt nichts. Für Einarbeitung, Prüfungen und Archivzugänge.',
    hintEn: 'Reads along, writes nothing. For onboarding, audits and archive access.' },
  { name: 'bot', technical: true,
    labelDe: 'Bot', labelEn: 'Bot',
    hintDe: 'Für den KI-Assistenten und Integrationen. Schreibt, verwaltet aber nichts.',
    hintEn: 'For the AI assistant and integrations. Writes but manages nothing.' },
];

export const ROLE_DEFAULTS: Record<MemberRoleName, PermissionKey[]> = {
  owner: [...ALLE],
  admin: ADMIN,
  moderator: MODERATOR,
  teamlead: TEAMLEITUNG,
  member: MITGLIED,
  contributor: MITWIRKEND,
  guest: GAST,
  readonly: NUR_LESEN,
  bot: BOT,
};

export function roleInfo(name: MemberRoleName): RoleInfo | undefined {
  return ROLES.find((r) => r.name === name);
}

/** Rechte einer Rolle als Nachschlagetabelle. */
export function defaultsFor(role: MemberRoleName): Record<PermissionKey, boolean> {
  const erlaubt = new Set(ROLE_DEFAULTS[role] ?? MITGLIED);
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, erlaubt.has(k)])) as Record<PermissionKey, boolean>;
}

/**
 * Endgültige Rechte: Rollenvorgabe, überschrieben von persönlichen Ausnahmen.
 * Der Owner behält immer alles — sonst könnte er sich selbst aussperren.
 */
export function effectivePermissions(
  role: MemberRoleName,
  overrides: Partial<Record<PermissionKey, boolean>> = {},
): Record<PermissionKey, boolean> {
  if (role === 'owner') return defaultsFor('owner');
  const base = defaultsFor(role);
  for (const [key, allowed] of Object.entries(overrides)) {
    if (PERMISSION_KEYS.includes(key as PermissionKey)) base[key as PermissionKey] = Boolean(allowed);
  }
  return base;
}

export function permissionInfo(key: PermissionKey): PermissionInfo | undefined {
  return PERMISSIONS.find((p) => p.key === key);
}


/* ── Zeitfenster fürs Bearbeiten und Löschen ──────────────────── */

/**
 * Wie lange eine Nachricht nach dem Senden noch geändert werden darf.
 * Danach ist sie Teil des Gesprächsverlaufs: wer eine Stunde später etwas
 * anderes dort stehen sähe, könnte die Unterhaltung nicht mehr nachvollziehen.
 */
export const EDIT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Wie lange man eine eigene Nachricht für alle zurücknehmen darf.
 * Danach bleibt nur noch das Ausblenden für einen selbst — sonst entstünden
 * Lücken in einem Verlauf, auf den sich andere schon bezogen haben.
 */
export const DELETE_FOR_ALL_WINDOW_MS = 2 * 60 * 60 * 1000;

export function withinEditWindow(createdAt: number, now = Date.now()): boolean {
  return now - createdAt <= EDIT_WINDOW_MS;
}

export function withinDeleteWindow(createdAt: number, now = Date.now()): boolean {
  return now - createdAt <= DELETE_FOR_ALL_WINDOW_MS;
}

/** Verbleibende Zeit in Minuten, für die Anzeige. */
export function minutesLeft(createdAt: number, windowMs: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((createdAt + windowMs - now) / 60000));
}
