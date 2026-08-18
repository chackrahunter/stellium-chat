import fs from 'node:fs';
import { detectLanguage, type VoiceNote } from '@stellium/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { transcriptionAvailable, transcriptionModel } from '../translation/index.js';

/**
 * Sprachnachrichten: die Aufnahme geht an Groqs Whisper, das Transkript
 * wird danach wie normaler Text behandelt — also auch übersetzt.
 * Eine japanische Sprachnachricht ist damit auf Deutsch lesbar.
 */

export class TranscriptionUnavailable extends Error {
  constructor(reason: string) { super(`Transkription nicht möglich: ${reason}`); }
}

export { transcriptionAvailable, transcriptionModel };

export interface TranscriptResult {
  text: string;
  lang: string | null;
  durationMs: number | null;
  model: string;
}

export async function transcribe(attachmentId: string): Promise<TranscriptResult> {
  if (!transcriptionAvailable()) throw new TranscriptionUnavailable('kein Groq-Schlüssel gesetzt');

  const attachment = db.get<{ path: string; mime: string; name: string; size: number }>(
    'SELECT path, mime, name, size FROM attachments WHERE id = ?', attachmentId,
  );
  if (!attachment) throw new TranscriptionUnavailable('Aufnahme nicht gefunden');
  if (!fs.existsSync(attachment.path)) throw new TranscriptionUnavailable('Datei fehlt auf der Platte');
  if (attachment.size > 25 * 1024 * 1024) throw new TranscriptionUnavailable('Aufnahme ist größer als 25 MB');

  const model = transcriptionModel()!;
  const form = new FormData();
  const bytes = await fs.promises.readFile(attachment.path);
  form.append('file', new Blob([bytes], { type: attachment.mime || 'audio/webm' }), attachment.name || 'aufnahme.webm');
  form.append('model', model);
  // verbose_json liefert zusätzlich die erkannte Sprache und die Dauer.
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(`${config.ai.groq.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.ai.groq.apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new TranscriptionUnavailable(`${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json() as { text?: string; language?: string; duration?: number };
    const text = (data.text ?? '').trim();
    if (!text) throw new TranscriptionUnavailable('nichts Verständliches in der Aufnahme');

    return {
      text,
      lang: normalizeWhisperLanguage(data.language) ?? detectLanguage(text).lang,
      durationMs: typeof data.duration === 'number' ? Math.round(data.duration * 1000) : null,
      model,
    };
  } catch (err) {
    if (err instanceof TranscriptionUnavailable) throw err;
    if ((err as Error).name === 'AbortError') throw new TranscriptionUnavailable('Zeitüberschreitung');
    throw new TranscriptionUnavailable((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** Whisper meldet "german", wir brauchen "de". */
function normalizeWhisperLanguage(value: string | undefined): string | null {
  if (!value) return null;
  const short = value.toLowerCase().slice(0, 2);
  const names: Record<string, string> = {
    german: 'de', english: 'en', french: 'fr', spanish: 'es', italian: 'it',
    portuguese: 'pt', dutch: 'nl', polish: 'pl', czech: 'cs', romanian: 'ro',
    turkish: 'tr', russian: 'ru', ukrainian: 'uk', arabic: 'ar', hindi: 'hi',
    chinese: 'zh', japanese: 'ja', korean: 'ko', swedish: 'sv', danish: 'da',
    finnish: 'fi', norwegian: 'no',
  };
  return names[value.toLowerCase()] ?? (short.length === 2 ? short : null);
}

export function saveTranscript(attachmentId: string, result: TranscriptResult): void {
  db.run(
    `INSERT INTO voice_transcripts (attachment_id, text, lang, duration_ms, provider, model, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(attachment_id) DO UPDATE SET
       text = excluded.text, lang = excluded.lang, duration_ms = excluded.duration_ms,
       provider = excluded.provider, model = excluded.model, created_at = excluded.created_at`,
    attachmentId, result.text, result.lang, result.durationMs, 'groq', result.model, Date.now(),
  );
}

export function voiceNoteFor(messageId: string): VoiceNote | null {
  const attachment = db.get<{ id: string }>(
    `SELECT a.id FROM attachments a WHERE a.message_id = ? AND a.mime LIKE 'audio/%' LIMIT 1`, messageId,
  );
  if (!attachment) return null;
  const transcript = db.get<{ text: string; lang: string | null; duration_ms: number | null }>(
    'SELECT text, lang, duration_ms FROM voice_transcripts WHERE attachment_id = ?', attachment.id,
  );
  return {
    attachmentId: attachment.id,
    url: `/files/${attachment.id}`,
    durationMs: transcript?.duration_ms ?? null,
    transcript: transcript?.text ?? null,
    transcriptLang: transcript?.lang ?? null,
    translatedTranscript: null,
  };
}
