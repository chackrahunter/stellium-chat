import { languageInfo, mentionsEveryone, extractMentions } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { assistant as aiProvider } from '../translation/index.js';
import { createAccount } from './users.js';
import { encryptField, blindIndex } from '../crypto/pii.js';
import { entschluesseln } from '../crypto/nachrichten.js';

/**
 * Der KI-Assistent als Gesprächspartner.
 *
 * Er ist ein ganz normales Konto mit der Rolle "bot" — dadurch erscheinen
 * seine Antworten als echte Nachrichten, laufen durch die Übersetzung und
 * landen in der Suche. Kein Sonderweg in der Darstellung.
 *
 * Zwei Betriebsarten:
 *   Privater Chat    eine Direktnachricht mit ihm, die nur die Person sieht.
 *   Gemeinsamer Kanal ein Kanal, in dem das ganze Team mit ihm spricht.
 */

export const ASSISTANT_HANDLE = 'stelliumai';
export const ASSISTANT_NAME = 'StelliumAI';

/** Frühere Namen des Assistenten — nötig, um Altbestände umzuziehen. */
const FRUEHERE_HANDLES = ['ki'];
export const TEAM_CHANNEL = 'ki-team';

export type AiMode = 'off' | 'mention' | 'always';

/** Konto des Assistenten, bei Bedarf angelegt. */
export function ensureAssistant(): string {
  const vorhanden = db.get<{ id: string }>(
    'SELECT id FROM users WHERE handle_bidx = ?', blindIndex(ASSISTANT_HANDLE),
  );
  if (vorhanden) return vorhanden.id;

  // Die KI hieß früher @ki. Bestehende Installationen sollen dabei nicht
  // plötzlich zwei Assistenten haben — also umbenennen statt neu anlegen.
  for (const alt of FRUEHERE_HANDLES) {
    const bot = db.get<{ id: string }>(
      "SELECT id FROM users WHERE handle_bidx = ? AND role = 'bot'", blindIndex(alt),
    );
    if (!bot) continue;
    db.run(
      'UPDATE users SET handle = ?, handle_bidx = ?, display_name = ? WHERE id = ?',
      encryptField(ASSISTANT_HANDLE), blindIndex(ASSISTANT_HANDLE), ASSISTANT_NAME, bot.id,
    );
    console.log(`[ki] Assistent von @${alt} auf @${ASSISTANT_HANDLE} umbenannt.`);
    return bot.id;
  }

  const konto = createAccount({
    displayName: ASSISTANT_NAME,
    handle: ASSISTANT_HANDLE,
    role: 'bot',
    language: 'de',
    timezone: 'UTC',
    createdBy: 'system',
  });

  // Ein Bot richtet nichts ein und meldet sich nie selbst an.
  db.run(
    `UPDATE users SET must_change_password = 0, must_complete_profile = 0,
            status = 'online', avatar_color = '#7c5cff', title = 'Assistent',
            auto_translate = 0
     WHERE id = ?`,
    konto.userId,
  );
  console.log(`[ki] Assistenten-Konto @${ASSISTANT_HANDLE} angelegt.`);
  return konto.userId;
}

/**
 * Bestehende Direktchats mit dem Assistenten auf "antwortet immer" setzen.
 * Nötig für Chats, die über die normale DM-Liste entstanden sind, bevor die
 * Zuordnung am Gesprächspartner hing.
 */
export function repairAssistantChats(): void {
  const bot = assistantUserId();
  if (!bot) return;
  const betroffen = db.all<{ id: string }>(
    `SELECT c.id FROM channels c
     JOIN channel_members m ON m.channel_id = c.id
     WHERE c.kind = 'dm' AND m.user_id = ? AND c.ai_mode <> 'always'`,
    bot,
  );
  for (const c of betroffen) {
    db.run("UPDATE channels SET ai_mode = 'always' WHERE id = ?", c.id);
  }
  if (betroffen.length) {
    console.log(`[ki] ${betroffen.length} stumme Direktchats mit dem Assistenten aktiviert.`);
  }
}

export function assistantUserId(): string | null {
  return db.get<{ id: string }>('SELECT id FROM users WHERE handle_bidx = ?', blindIndex(ASSISTANT_HANDLE))?.id ?? null;
}

export function isAssistant(userId: string): boolean {
  return userId === assistantUserId();
}

/** Gemeinsamer Kanal, in dem das ganze Team mit der KI spricht. */
export function ensureTeamChannel(ownerId: string): string {
  const vorhanden = db.get<{ id: string }>(
    "SELECT id FROM channels WHERE kind = 'public' AND lower(name) = ?", TEAM_CHANNEL,
  );
  const botId = ensureAssistant();
  const jetzt = Date.now();

  if (vorhanden) {
    db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)',
      vorhanden.id, botId, jetzt);
    return vorhanden.id;
  }

  const id = newId('ch_');
  db.transaction(() => {
    db.run(
      `INSERT INTO channels (id, kind, name, topic, purpose, primary_language, archived, ai_mode, created_by, created_at)
       VALUES (?, 'public', ?, ?, ?, NULL, 0, 'always', ?, ?)`,
      id, TEAM_CHANNEL,
      'Gemeinsamer Draht zum KI-Assistenten',
      'Hier redet das ganze Team mit der KI. Sie antwortet auf jede Nachricht und liest den Verlauf mit.',
      ownerId, jetzt,
    );
    for (const uid of db.all<{ id: string }>('SELECT id FROM users').map((u) => u.id)) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', id, uid, jetzt);
    }
  });
  return id;
}

/** Privater Chat zwischen einer Person und dem Assistenten. */
export function openPrivateChat(userId: string): string {
  const botId = ensureAssistant();
  const key = [userId, botId].sort().join(':');
  const vorhanden = db.get<{ id: string }>('SELECT id FROM channels WHERE dm_key = ?', key);
  if (vorhanden) {
    db.run("UPDATE channels SET ai_mode = 'always' WHERE id = ?", vorhanden.id);
    return vorhanden.id;
  }

  const id = newId('dm_');
  const jetzt = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO channels (id, kind, name, topic, purpose, primary_language, archived, dm_key, ai_mode, created_by, created_at)
       VALUES (?, 'dm', '', NULL, NULL, NULL, 0, ?, 'always', ?, ?)`,
      id, key, userId, jetzt,
    );
    for (const uid of [userId, botId]) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', id, uid, jetzt);
    }
  });
  return id;
}

export function aiModeOf(channelId: string): AiMode {
  return (db.get<{ ai_mode: string }>('SELECT ai_mode FROM channels WHERE id = ?', channelId)?.ai_mode ?? 'off') as AiMode;
}

export function setAiMode(channelId: string, mode: AiMode): void {
  db.run('UPDATE channels SET ai_mode = ? WHERE id = ?', mode, channelId);
  const botId = ensureAssistant();
  if (mode === 'off') return;
  db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)',
    channelId, botId, Date.now());
}

/** Soll der Assistent auf diese Nachricht antworten? */
export function shouldAnswer(channelId: string, text: string, authorId: string): boolean {
  if (isAssistant(authorId)) return false;          // nicht mit sich selbst reden
  const mode = aiModeOf(channelId);
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // "mention": nur wenn er direkt angesprochen wird
  const erwaehnt = extractMentions(text);
  // Der alte Name wird weiter verstanden, damit niemand ins Leere schreibt.
  return erwaehnt.includes(ASSISTANT_HANDLE)
    || FRUEHERE_HANDLES.some((alt) => erwaehnt.includes(alt))
    || mentionsEveryone(text);
}

/* ── Antwort erzeugen ─────────────────────────────────────────── */

interface VerlaufZeile {
  user_id: string; text: string; created_at: number;
  display_name: string; handle: string;
}

const VERLAUF_LAENGE = 40;

export class AssistantUnavailable extends Error {
  constructor() { super('Der KI-Assistent ist nicht konfiguriert.'); }
}

/**
 * Antwort auf den bisherigen Verlauf. Der Assistent bekommt bewusst nur den
 * Kanal, in dem er angesprochen wurde — nicht den ganzen Arbeitsbereich.
 */
export async function generateReply(channelId: string, ansprache: 'privat' | 'team'): Promise<string> {
  const ai = aiProvider();
  if (!ai) throw new AssistantUnavailable();

  const botId = assistantUserId();
  const zeilen = db.all<VerlaufZeile>(
    `SELECT m.user_id, m.text, m.created_at, u.display_name, u.handle
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.channel_id = ? AND m.deleted_at IS NULL AND m.system_kind IS NULL
     ORDER BY m.created_at DESC LIMIT ?`,
    channelId, VERLAUF_LAENGE,
  ).reverse().map((z) => ({ ...z, text: entschluesseln(z.text) }));

  if (!zeilen.length) {
    return ansprache === 'team'
      ? 'Ich bin dabei. Schreibt einfach, was ihr braucht — ich lese diesen Kanal mit.'
      : 'Ich bin da. Was brauchst du?';
  }

  // Sprache aus der letzten menschlichen Nachricht — so antwortet er in der
  // Sprache, in der man ihn angesprochen hat.
  const letzte = [...zeilen].reverse().find((z) => z.user_id !== botId);
  const sprache = letzte
    ? db.get<{ source_lang: string | null }>(
        'SELECT source_lang FROM messages WHERE channel_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
        channelId, letzte.user_id,
      )?.source_lang ?? 'de'
    : 'de';
  const zielsprache = languageInfo(sprache);

  const beteiligte = [...new Map(zeilen.filter((z) => z.user_id !== botId).map((z) => [z.user_id, z])).values()]
    .map((z) => z.display_name);

  const system = [
    `Du bist "${ASSISTANT_NAME}", der Assistent in einem Firmen-Chat.`,
    `Antworte auf ${zielsprache.name} (${zielsprache.native}).`,
    ansprache === 'team'
      ? `Du bist in einem Gruppenkanal mit mehreren Personen: ${beteiligte.join(', ')}. Sprich die Person an, die zuletzt geschrieben hat.`
      : 'Du bist in einem Zweiergespräch. Der Verlauf gehört nur zu dieser Person.',
    '',
    '## Was du weißt',
    'Über diese Firma weißt du ausschließlich das, was im Verlauf unten steht.',
    'Du hast keinen Zugriff auf andere Kanäle, Dateien, Kalender, Kundendaten oder',
    'interne Systeme. Du kennst keine Projekte, Abläufe, Produkte, Termine, Zahlen',
    'oder Zuständigkeiten, die dort nicht ausdrücklich genannt werden.',
    '',
    '## Die wichtigste Regel',
    'Wirst du nach etwas gefragt, das nicht im Verlauf steht — ein Projektname, ein',
    'Prozess, ein Kürzel, ein Termin, eine Person, eine Zahl — dann sagst du klar,',
    'dass du es nicht weißt, und bittest um eine kurze Erklärung.',
    'Beispiel: "Dazu steht hier nichts. Was ist X genau? Dann helfe ich weiter."',
    '',
    'Erfinde unter keinen Umständen:',
    '- Arbeitsschritte, Abläufe oder Anleitungen für etwas, das du nicht kennst',
    '- Namen von Werkzeugen, Systemen, Dokumenten oder Kanälen',
    '- Zahlen, Versionen, Fristen oder Zuständigkeiten',
    '- Bedeutungen von Kürzeln und Codes',
    'Eine erfundene Antwort ist schlimmer als keine: im Arbeitsalltag handeln',
    'Menschen danach.',
    '',
    'Namen von Personen und Konten im Verlauf sind Namen — keine Projekte und keine',
    'Prozesse. Aus "Prueflauf 4a2" folgt nicht, dass es einen Prozess dieses Namens gibt.',
    '',
    '## Wobei du wirklich hilfst',
    'Allgemeinwissen, Formulieren, Übersetzen, Zusammenfassen des Verlaufs,',
    'Rechnen, Zeitzonen, Erklären von Technik und Begriffen, Strukturieren von',
    'Gedanken, Code. Dabei bist du ausführlich und genau.',
    '',
    '## Form',
    'Knapp: ein bis fünf Sätze, außer es wird ausdrücklich mehr verlangt.',
    'Keine Begrüßungsfloskeln, kein "Gerne!", keine Wiederholung der Frage.',
    'Markdown ist erlaubt: Listen, Codeblöcke, fett.',
    'Deine Antwort wird für Kolleg:innen mit anderer Sprache automatisch übersetzt —',
    'schreibe deshalb klar und ohne Wortspiele.',
  ].join('\n');

  const verlauf = zeilen.map((z) => ({
    role: (z.user_id === botId ? 'assistant' : 'user') as 'assistant' | 'user',
    content: z.user_id === botId ? z.text : `${z.display_name}: ${z.text}`,
  }));

  const antwort = await ai.chat(
    [{ role: 'system', content: system }, ...verlauf],
    // Niedrige Temperatur: bei Sachfragen ist Treue zum Verlauf wichtiger als
    // sprachliche Abwechslung.
    { temperature: 0.2, maxTokens: 1600, reasoning: 'low' },
  );

  return antwort.trim().slice(0, 6000) || 'Dazu fällt mir gerade nichts ein.';
}
