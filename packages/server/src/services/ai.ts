import { languageInfo, type AiSummary, type SmartReply, type RewriteTone } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { assistant } from '../translation/index.js';

export class AiUnavailable extends Error {
  constructor() { super('KI ist nicht konfiguriert. Setze AI_PROVIDER=groq und GROQ_API_KEY.'); }
}

interface TranscriptRow {
  id: string; user_id: string; text: string; created_at: number;
  handle: string; display_name: string; parent_id: string | null;
}

/** Nachrichtenverlauf als kompakter, für ein Modell lesbarer Text. */
function transcript(rows: TranscriptRow[]): string {
  return rows.map((r) => {
    const time = new Date(r.created_at).toISOString().slice(11, 16);
    const thread = r.parent_id ? ' (Antwort im Thread)' : '';
    return `[${r.id}] ${time} ${r.display_name} (@${r.handle})${thread}: ${r.text}`;
  }).join('\n');
}

function fetchMessages(channelId: string, sinceMessageId: string | null, limit: number): TranscriptRow[] {
  const params: any[] = [channelId];
  let where = 'm.channel_id = ? AND m.deleted_at IS NULL AND m.system_kind IS NULL';
  if (sinceMessageId) { where += ' AND m.id > ?'; params.push(sinceMessageId); }
  return db.all<TranscriptRow>(
    `SELECT m.id, m.user_id, m.text, m.created_at, m.parent_id, u.handle, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE ${where}
     ORDER BY m.created_at DESC LIMIT ?`,
    ...params, limit,
  ).reverse();
}

/* ── "Was habe ich verpasst?" ─────────────────────────────────── */

export async function catchUp(input: {
  channelId: string; sinceMessageId: string | null; language: string; channelName: string;
}): Promise<AiSummary> {
  const ai = assistant();
  if (!ai) throw new AiUnavailable();

  const rows = fetchMessages(input.channelId, input.sinceMessageId, 300);
  const lang = languageInfo(input.language);

  if (rows.length === 0) {
    return {
      channelId: input.channelId, fromMessageId: input.sinceMessageId, language: input.language,
      headline: 'Nichts verpasst', bullets: [], actionItems: [], decisions: [],
      messageCount: 0, generatedAt: Date.now(), model: 'none',
    };
  }

  const people = [...new Map(rows.map((r) => [r.user_id, r])).values()]
    .map((r) => `${r.display_name} = @${r.handle} (id: ${r.user_id})`).join('; ');

  const data = await ai.json<{
    headline?: string; bullets?: string[];
    action_items?: { text: string; assignee_id?: string | null }[];
    decisions?: string[];
  }>([
    {
      role: 'system',
      content: [
        `Du fasst den Verlauf eines Firmen-Chats zusammen. Antworte vollständig auf ${lang.name} (${lang.native}).`,
        'Der Verlauf kann mehrsprachig sein — fasse trotzdem einheitlich in der Zielsprache zusammen.',
        'Sei knapp und konkret. Keine Floskeln, keine Wiederholung des Offensichtlichen.',
        `Bekannte Personen: ${people}`,
        'Antworte als JSON:',
        '{"headline": "ein Satz, max 90 Zeichen",',
        ' "bullets": ["3-6 Stichpunkte zum Wesentlichen"],',
        ' "action_items": [{"text": "konkrete Aufgabe", "assignee_id": "<user-id oder null>"}],',
        ' "decisions": ["getroffene Entscheidungen, sonst leeres Array"]}',
      ].join('\n'),
    },
    { role: 'user', content: `Kanal: #${input.channelName}\n\n${transcript(rows)}` },
  ], { temperature: 0.25, maxTokens: 1200 });

  const summary: AiSummary = {
    channelId: input.channelId,
    fromMessageId: input.sinceMessageId,
    language: input.language,
    headline: data.headline?.trim() || 'Zusammenfassung',
    bullets: (data.bullets ?? []).filter((b) => typeof b === 'string').slice(0, 8),
    actionItems: (data.action_items ?? [])
      .filter((a) => a && typeof a.text === 'string')
      .slice(0, 10)
      .map((a) => ({ text: a.text, assigneeId: a.assignee_id ?? null })),
    decisions: (data.decisions ?? []).filter((d) => typeof d === 'string').slice(0, 6),
    messageCount: rows.length,
    generatedAt: Date.now(),
    model: ai === null ? 'none' : 'assistant',
  };

  db.run(
    'INSERT INTO ai_summaries (id, channel_id, scope, ref_id, language, payload, created_at) VALUES (?,?,?,?,?,?,?)',
    newId('sum_'), input.channelId, 'catchup', input.sinceMessageId, input.language, JSON.stringify(summary), Date.now(),
  );
  return summary;
}

/* ── Thread-Zusammenfassung ───────────────────────────────────── */

export async function summarizeThread(parentId: string, language: string): Promise<AiSummary> {
  const ai = assistant();
  if (!ai) throw new AiUnavailable();

  const root = db.get<TranscriptRow & { channel_id: string }>(
    `SELECT m.id, m.channel_id, m.user_id, m.text, m.created_at, m.parent_id, u.handle, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`, parentId,
  );
  if (!root) throw new Error('Thread nicht gefunden');

  const replies = db.all<TranscriptRow>(
    `SELECT m.id, m.user_id, m.text, m.created_at, m.parent_id, u.handle, u.display_name
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.parent_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 200`, parentId,
  );
  const lang = languageInfo(language);

  const data = await ai.json<{ headline?: string; bullets?: string[]; decisions?: string[]; action_items?: { text: string; assignee_id?: string | null }[] }>([
    {
      role: 'system',
      content: [
        `Fasse diesen Chat-Thread auf ${lang.name} (${lang.native}) zusammen.`,
        'Wichtig ist: Worum ging es, was wurde entschieden, was ist offen?',
        'JSON: {"headline": "...", "bullets": ["..."], "decisions": ["..."], "action_items": [{"text": "...", "assignee_id": null}]}',
      ].join('\n'),
    },
    { role: 'user', content: transcript([root, ...replies]) },
  ], { temperature: 0.25, maxTokens: 900 });

  return {
    channelId: root.channel_id,
    fromMessageId: parentId,
    language,
    headline: data.headline?.trim() || 'Thread',
    bullets: (data.bullets ?? []).slice(0, 8),
    actionItems: (data.action_items ?? []).map((a) => ({ text: a.text, assigneeId: a.assignee_id ?? null })).slice(0, 10),
    decisions: (data.decisions ?? []).slice(0, 6),
    messageCount: replies.length + 1,
    generatedAt: Date.now(),
    model: 'assistant',
  };
}

/* ── Smart Replies ────────────────────────────────────────────── */

export async function smartReplies(input: {
  channelId: string; parentId: string | null; language: string; selfName: string;
}): Promise<SmartReply[]> {
  const ai = assistant();
  if (!ai) throw new AiUnavailable();

  const rows = input.parentId
    ? db.all<TranscriptRow>(
        `SELECT m.id, m.user_id, m.text, m.created_at, m.parent_id, u.handle, u.display_name
         FROM messages m JOIN users u ON u.id = m.user_id
         WHERE (m.id = ? OR m.parent_id = ?) AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC LIMIT 12`, input.parentId, input.parentId).reverse()
    : fetchMessages(input.channelId, null, 12);

  if (rows.length === 0) return [];
  const lang = languageInfo(input.language);

  const data = await ai.json<{ replies?: { text: string; tone?: string }[] }>([
    {
      role: 'system',
      content: [
        `Du schlägst kurze Antworten für ${input.selfName} in einem Firmen-Chat vor.`,
        `Schreibe die Vorschläge auf ${lang.name} (${lang.native}).`,
        'Genau 3 Vorschläge, jeder höchstens 120 Zeichen, klingt wie ein echter Mensch, keine Anrede-Floskeln.',
        'Tonarten: "kurz" (Bestätigung), "freundlich", "nachfrage" (klärende Rückfrage).',
        'JSON: {"replies": [{"text": "...", "tone": "kurz"}, ...]}',
      ].join('\n'),
    },
    { role: 'user', content: transcript(rows) },
  ], { temperature: 0.6, maxTokens: 400, fast: true });

  const allowed = new Set(['kurz', 'freundlich', 'formell', 'nachfrage']);
  return (data.replies ?? [])
    .filter((r) => r && typeof r.text === 'string')
    .slice(0, 3)
    .map((r) => ({
      text: r.text.trim().slice(0, 200),
      tone: (allowed.has(r.tone ?? '') ? r.tone : 'freundlich') as SmartReply['tone'],
    }));
}

/* ── Umformulieren / Schreibhilfe ─────────────────────────────── */

const TONE_PROMPT: Record<RewriteTone, string> = {
  polish: 'Korrigiere Rechtschreibung und Grammatik. Ändere Stil und Bedeutung nicht.',
  formal: 'Formuliere den Text höflich und geschäftlich, ohne steif zu klingen.',
  friendly: 'Formuliere den Text wärmer und zugänglicher, ohne anbiedernd zu wirken.',
  concise: 'Kürze den Text auf das Wesentliche. Behalte alle Fakten.',
  expand: 'Ergänze den Text um den fehlenden Kontext, damit ihn auch jemand ohne Vorwissen versteht.',
  bullets: 'Wandle den Text in eine kompakte Stichpunktliste um.',
  apologize: 'Formuliere den Text als sachliche Entschuldigung mit klarem nächsten Schritt.',
};

export async function rewrite(input: { text: string; tone: RewriteTone; targetLang?: string | null }): Promise<string> {
  const ai = assistant();
  if (!ai) throw new AiUnavailable();

  const instructions = [TONE_PROMPT[input.tone] ?? TONE_PROMPT.polish];
  if (input.targetLang) {
    const l = languageInfo(input.targetLang);
    instructions.push(`Gib das Ergebnis auf ${l.name} (${l.native}) aus.`);
  } else {
    instructions.push('Behalte die Sprache des Originals bei.');
  }
  instructions.push('Gib ausschließlich den überarbeiteten Text zurück — keine Erklärung, keine Anführungszeichen.');
  instructions.push('Lasse Codeblöcke, Links und @Erwähnungen unverändert.');

  const out = await ai.chat([
    { role: 'system', content: instructions.join('\n') },
    { role: 'user', content: input.text },
  ], { temperature: 0.35, maxTokens: Math.min(2048, Math.max(256, input.text.length * 3)) });

  return out.replace(/^["'`]+|["'`]+$/g, '').trim();
}

/* ── Frage an den Kanal ───────────────────────────────────────── */

export async function askChannel(input: {
  channelId: string; question: string; language: string; channelName: string;
}): Promise<{ answer: string; citedMessageIds: string[] }> {
  const ai = assistant();
  if (!ai) throw new AiUnavailable();

  const rows = fetchMessages(input.channelId, null, 400);
  if (rows.length === 0) {
    return { answer: 'In diesem Kanal gibt es noch nichts, worauf ich antworten könnte.', citedMessageIds: [] };
  }
  const lang = languageInfo(input.language);

  const data = await ai.json<{ answer?: string; cited_message_ids?: string[] }>([
    {
      role: 'system',
      content: [
        `Beantworte die Frage ausschließlich anhand des Chat-Verlaufs. Antworte auf ${lang.name} (${lang.native}).`,
        'Wenn der Verlauf die Antwort nicht hergibt, sage das klar und rate nicht.',
        'Nenne die IDs der Nachrichten, auf die du dich stützt (die Werte in eckigen Klammern).',
        'JSON: {"answer": "...", "cited_message_ids": ["..."]}',
      ].join('\n'),
    },
    { role: 'user', content: `Kanal: #${input.channelName}\n\n${transcript(rows)}\n\nFrage: ${input.question}` },
  ], { temperature: 0.2, maxTokens: 900 });

  const known = new Set(rows.map((r) => r.id));
  return {
    answer: data.answer?.trim() || 'Dazu finde ich nichts im Verlauf.',
    citedMessageIds: (data.cited_message_ids ?? []).filter((id) => known.has(id)).slice(0, 8),
  };
}

/* ── Aufgaben aus einem Gespräch ziehen ───────────────────────── */

/**
 * Liest den Kanalverlauf und schlägt vor, was daraus eine Aufgabe werden
 * sollte. Bewusst nur ein Vorschlag: angelegt wird erst, was jemand bestätigt.
 */
export async function extractTasks(input: { channelId: string; language: string }): Promise<{
  title: string; assigneeId: string | null; dueAt: number | null;
}[]> {
  const ai = assistant();
  if (!ai) throw new AiUnavailable();

  const rows = fetchMessages(input.channelId, null, 120);
  if (!rows.length) return [];

  const lang = languageInfo(input.language);
  const personen = [...new Map(rows.map((r) => [r.user_id, r])).values()]
    .map((r) => `${r.display_name} = ${r.user_id}`).join('; ');

  const data = await ai.json<{ tasks?: { title: string; assignee_id?: string | null; due_in_days?: number | null }[] }>([
    {
      role: 'system',
      content: [
        `Du liest einen Firmen-Chat und ziehst daraus offene Aufgaben. Antworte auf ${lang.name}.`,
        'Eine Aufgabe ist etwas, das jemand konkret tun muss und das noch offen ist.',
        'Was bereits erledigt gemeldet wurde, ist keine Aufgabe mehr. Reine Meinungen und Fragen auch nicht.',
        'Formuliere jeden Titel als Handlung, höchstens 90 Zeichen, ohne Namen am Anfang.',
        'Findest du nichts Konkretes, gib eine leere Liste zurück — lieber nichts als Erfundenes.',
        `Bekannte Personen: ${personen}`,
        'JSON: {"tasks": [{"title": "...", "assignee_id": "<id oder null>", "due_in_days": <Zahl oder null>}]}',
      ].join('\n'),
    },
    { role: 'user', content: transcript(rows) },
  ], { temperature: 0.2, maxTokens: 1200, reasoning: 'low' });

  const bekannt = new Set(rows.map((r) => r.user_id));
  return (data.tasks ?? [])
    .filter((t) => t && typeof t.title === 'string' && t.title.trim().length > 3)
    .slice(0, 12)
    .map((t) => ({
      title: t.title.trim().slice(0, 300),
      assigneeId: t.assignee_id && bekannt.has(t.assignee_id) ? t.assignee_id : null,
      dueAt: typeof t.due_in_days === 'number' && t.due_in_days > 0
        ? Date.now() + t.due_in_days * 86_400_000
        : null,
    }));
}

/* ── Protokoll ────────────────────────────────────────────────── */

export interface Protokoll {
  channelId: string;
  language: string;
  title: string;
  /** Worum es ging — je ein Absatz pro Thema. */
  topics: { heading: string; points: string[] }[];
  decisions: string[];
  openQuestions: string[];
  actionItems: { text: string; assigneeId: string | null }[];
  messageCount: number;
  generatedAt: number;
}

/**
 * Protokoll eines Kanals — anders als die Zusammenfassung nicht "was habe ich
 * verpasst", sondern ein weitergebbares Ergebnis: Themen, Beschlüsse, offene
 * Fragen. Gedacht für den Abschluss einer Besprechung oder eines Projekts.
 */
export async function protokoll(input: {
  channelId: string; channelName: string; language: string; sinceMessageId?: string | null;
}): Promise<Protokoll> {
  const ai = assistant();
  if (!ai) throw new AiUnavailable();

  const rows = fetchMessages(input.channelId, input.sinceMessageId ?? null, 400);
  const lang = languageInfo(input.language);

  if (!rows.length) {
    return {
      channelId: input.channelId, language: input.language,
      title: `#${input.channelName}`, topics: [], decisions: [], openQuestions: [],
      actionItems: [], messageCount: 0, generatedAt: Date.now(),
    };
  }

  const people = [...new Map(rows.map((r) => [r.user_id, r])).values()]
    .map((r) => `${r.display_name} = ${r.user_id}`).join('; ');

  const data = await ai.json<{
    title?: string;
    topics?: { heading: string; points: string[] }[];
    decisions?: string[];
    open_questions?: string[];
    action_items?: { text: string; assignee_id?: string | null }[];
  }>([
    {
      role: 'system',
      content: [
        `Du schreibst ein Besprechungsprotokoll aus einem Firmen-Chat. Antworte vollständig auf ${lang.name} (${lang.native}).`,
        'Der Verlauf kann mehrsprachig sein — das Protokoll ist trotzdem einsprachig.',
        'Ein Protokoll hält fest, was besprochen wurde, was entschieden wurde und was offen blieb.',
        'Nichts hinzuerfinden: steht etwas nicht im Verlauf, gehört es nicht ins Protokoll.',
        'Gibt es keine Beschlüsse oder offenen Fragen, bleiben die Listen leer.',
        `Bekannte Personen: ${people}`,
        'JSON: {"title": "kurzer Titel", "topics": [{"heading": "Thema", "points": ["Stichpunkt"]}],',
        ' "decisions": ["..."], "open_questions": ["..."],',
        ' "action_items": [{"text": "...", "assignee_id": "<id oder null>"}]}',
      ].join('\n'),
    },
    { role: 'user', content: `Kanal: #${input.channelName}\n\n${transcript(rows)}` },
  ], { temperature: 0.2, maxTokens: 2000, reasoning: 'low' });

  const bekannt = new Set(rows.map((r) => r.user_id));
  const text = (x: unknown) => (typeof x === 'string' ? x.trim() : '');

  return {
    channelId: input.channelId,
    language: input.language,
    title: text(data.title) || `#${input.channelName}`,
    topics: (data.topics ?? [])
      .filter((t) => t && text(t.heading))
      .slice(0, 10)
      .map((t) => ({
        heading: text(t.heading),
        points: (t.points ?? []).map(text).filter(Boolean).slice(0, 8),
      })),
    decisions: (data.decisions ?? []).map(text).filter(Boolean).slice(0, 12),
    openQuestions: (data.open_questions ?? []).map(text).filter(Boolean).slice(0, 12),
    actionItems: (data.action_items ?? [])
      .filter((a) => a && text(a.text))
      .slice(0, 15)
      .map((a) => ({
        text: text(a.text),
        assigneeId: a.assignee_id && bekannt.has(a.assignee_id) ? a.assignee_id : null,
      })),
    messageCount: rows.length,
    generatedAt: Date.now(),
  };
}
