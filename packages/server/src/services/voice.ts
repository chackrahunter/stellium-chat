import { detectLanguage, type VoiceNote } from '@stellium/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import * as ablage from './ablage.js';
import { transcriptionAvailable, transcriptionModel, transcriptionWeg } from '../translation/index.js';
import * as stimme from './stimme.js';
import * as vertraulich from './vertraulich.js';

/**
 * Sprachnachrichten: die Aufnahme wird abgetippt, das Transkript wird danach
 * wie normaler Text behandelt — also auch übersetzt, durchsucht und von der
 * KI gelesen. Eine japanische Sprachnachricht ist damit auf Deutsch lesbar.
 *
 * Es gibt zwei Wege dorthin, und die Reihenfolge ist Absicht:
 *
 *  1. **Der eigene Rechner.** Läuft nebenan ein Sprachdienst (whisper.cpp),
 *     geht die Aufnahme dorthin. Sie verlässt das Haus nicht.
 *  2. **Groq**, falls ein Schlüssel hinterlegt ist und sonst nichts da ist.
 *
 * Der lokale Weg hat Vorrang, und zwar nicht nur, weil er billiger ist: wer
 * auf ein lokales Modell umgestellt hat, hat sich dafür entschieden, dass
 * nichts über Nachrichten das Netz verlässt. Eine Sprachnachricht, die
 * trotzdem zu einem fremden Dienst ginge, wäre genau das Loch in dieser
 * Zusage — und das leiseste, weil man es der Oberfläche nicht ansieht.
 */

export class TranscriptionUnavailable extends Error {
  constructor(reason: string) { super(`Transkription nicht möglich: ${reason}`); }
}

export { transcriptionAvailable, transcriptionModel, transcriptionWeg };

export interface TranscriptResult {
  text: string;
  lang: string | null;
  durationMs: number | null;
  model: string;
  /** "lokal" oder "groq" — wandert ins Transkript, damit man es später sieht. */
  provider: string;
}

/** Größer nimmt Groq nicht an; der lokale Dienst hätte sonst Aufnahmen ohne Ende. */
const HOECHSTENS = 25 * 1024 * 1024;

/**
 * Gehört diese Aufnahme in einen vertraulichen Kanal?
 *
 * Der Aufrufer prüft das schon — und trotzdem steht es hier noch einmal. Der
 * Grund ist derselbe, aus dem `klartextNoetig` im Gateway an jeder Fundstelle
 * einzeln steht: eine Prüfung, die nur oben hängt, schützt genau die Wege, die
 * heute jemand durch sie hindurchführt. Der nächste Aufrufer von `transcribe`
 * — ein Nachzieh-Lauf für alte Aufnahmen, ein Knopf „nochmal versuchen",
 * irgendetwas in einem halben Jahr — bringt sie nicht von selbst mit.
 *
 * Und der Schaden wäre hier größer als anderswo: das Transkript wäre der
 * einzige lesbare Klartext in einem Kanal, dessen ganzer Zweck ist, dass der
 * Server nichts lesen kann. Bei einem fremden Dienst käme dazu, dass die
 * Aufnahme das Haus verlässt.
 */
function inVertraulichemKanal(attachmentId: string): boolean {
  const zeile = db.get<{ channel_id: string | null }>(
    `SELECT m.channel_id FROM attachments a
     LEFT JOIN messages m ON m.id = a.message_id
     WHERE a.id = ?`, attachmentId,
  );
  return Boolean(zeile?.channel_id) && vertraulich.istVertraulich(zeile!.channel_id!);
}

export async function transcribe(attachmentId: string): Promise<TranscriptResult> {
  if (inVertraulichemKanal(attachmentId)) {
    throw new TranscriptionUnavailable('vertraulicher Kanal — hier wird nicht abgetippt');
  }

  const attachment = db.get<{
    path: string; mime: string; name: string; size: number; encoding: string | null;
  }>('SELECT path, mime, name, size, encoding FROM attachments WHERE id = ?', attachmentId);
  if (!attachment) throw new TranscriptionUnavailable('Aufnahme nicht gefunden');
  if (attachment.size > HOECHSTENS) throw new TranscriptionUnavailable('Aufnahme ist größer als 25 MB');

  const bytes = await lesen(attachmentId, attachment);
  const aufnahme: Aufnahme = { bytes, mime: attachment.mime, name: attachment.name };

  if (await stimme.erreichbar()) return lokalAbtippen(aufnahme);
  if (config.ai.groq.apiKey) return beiGroqAbtippen(aufnahme);

  throw new TranscriptionUnavailable(
    stimme.eingerichtet()
      ? `Sprachdienst antwortet nicht (${config.ai.stimme.baseUrl})`
      : 'kein Sprachdienst eingerichtet und kein Groq-Schlüssel gesetzt',
  );
}

interface Aufnahme { bytes: Buffer; mime: string; name: string }

/**
 * Die Aufnahme holen — über die Ablage, nicht über den Pfad.
 *
 * Der Pfad in `attachments.path` gilt nur so lange, bis der Blockspeicher die
 * Datei übernommen hat, und das passiert bei einer Sprachnachricht direkt nach
 * dem Hochladen: sie ist klein und damit zerlegt, bevor die Antwort auf den
 * Upload geschrieben ist. Wer hier `fs.readFile(path)` aufruft, gewinnt ein
 * Rennen oder verliert es — gemessen: von drei Aufnahmen hintereinander kam
 * genau die erste durch, die beiden anderen scheiterten mit „Datei fehlt auf
 * der Platte". Und weil das Scheitern nur eine Zeile ins Journal schreibt,
 * sah es in der App aus wie eine Sprachnachricht, zu der es eben kein
 * Transkript gibt.
 */
async function lesen(
  id: string,
  attachment: { path: string; encoding: string | null },
): Promise<Buffer> {
  const strom = ablage.oeffnen({
    id, art: 'attachment', pfad: attachment.path, encoding: attachment.encoding,
  });
  if (!strom) throw new TranscriptionUnavailable('Aufnahme ist weder auf der Platte noch im Blockspeicher');
  const teile: Buffer[] = [];
  for await (const stueck of strom) teile.push(Buffer.from(stueck as Uint8Array));
  return Buffer.concat(teile);
}

/* ── Der eigene Rechner ───────────────────────────────────────── */

async function lokalAbtippen(aufnahme: Aufnahme): Promise<TranscriptResult> {
  try {
    const roh = await stimme.abtippen(aufnahme);
    return auswerten(roh.text, roh.sprache, roh.sekunden, config.ai.stimme.modell, 'lokal');
  } catch (err) {
    if (err instanceof TranscriptionUnavailable) throw err;
    throw new TranscriptionUnavailable((err as Error).message);
  }
}

/* ── Groq ─────────────────────────────────────────────────────── */

async function beiGroqAbtippen(aufnahme: Aufnahme): Promise<TranscriptResult> {
  const model = transcriptionModel() ?? 'whisper-large-v3-turbo';
  const form = new FormData();
  form.append('file', new Blob([aufnahme.bytes], { type: aufnahme.mime || 'audio/webm' }), aufnahme.name || 'aufnahme.webm');
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
    return auswerten(data.text, data.language, data.duration, model, 'groq');
  } catch (err) {
    if (err instanceof TranscriptionUnavailable) throw err;
    if ((err as Error).name === 'AbortError') throw new TranscriptionUnavailable('Zeitüberschreitung');
    throw new TranscriptionUnavailable((err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/* ── Gemeinsame Auswertung ────────────────────────────────────── */

/**
 * Beide Wege antworten in derselben Form — deshalb steht die Auswertung
 * einmal hier und nicht zweimal daneben.
 */
function auswerten(
  text: string | undefined,
  sprache: string | undefined,
  sekunden: number | undefined,
  model: string,
  provider: string,
): TranscriptResult {
  const sauber = (text ?? '').trim();
  if (!sauber) throw new TranscriptionUnavailable('nichts Verständliches in der Aufnahme');
  return {
    text: sauber,
    lang: normalizeWhisperLanguage(sprache) ?? detectLanguage(sauber).lang,
    durationMs: typeof sekunden === 'number' ? Math.round(sekunden * 1000) : null,
    model,
    provider,
  };
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
    attachmentId, verschluesseln(result.text), result.lang, result.durationMs,
    result.provider, result.model, Date.now(),
  );
}

/**
 * `deleted_at IS NULL` ist hier bewusst dazugekommen: ohne den Join gegen
 * `messages` lieferte diese Funktion Anhang UND Transkript unverändert
 * weiter, auch wenn die Nachricht längst gelöscht war. hydrateMessages()
 * (services/store.ts) redigiert `text` für eine gelöschte Nachricht zwar
 * korrekt, ruft dieses `voice`-Feld bei kind === 'voice' aber unbedingt auf —
 * ohne die Prüfung hier lag das Transkript trotzdem im Klartext in der
 * Antwort. Denselben Weg nimmt ws/gateway.ts::runTranscription() über das
 * eigene {t:'voice:transcript', voice: voiceNoteFor(id)}-Ereignis, das an
 * hydrateMessages() ganz vorbei geht — auch dort greift die Sperre jetzt,
 * weil sie an der einen gemeinsamen Quelle sitzt statt an zwei Stellen
 * einzeln nachgebildet zu sein.
 */
export function voiceNoteFor(messageId: string): VoiceNote | null {
  const attachment = db.get<{ id: string }>(
    `SELECT a.id FROM attachments a
     JOIN messages m ON m.id = a.message_id
     WHERE a.message_id = ? AND a.mime LIKE 'audio/%' AND m.deleted_at IS NULL LIMIT 1`, messageId,
  );
  if (!attachment) return null;
  const transcript = db.get<{ text: string; lang: string | null; duration_ms: number | null }>(
    'SELECT text, lang, duration_ms FROM voice_transcripts WHERE attachment_id = ?', attachment.id,
  );
  return {
    attachmentId: attachment.id,
    url: `/files/${attachment.id}`,
    durationMs: transcript?.duration_ms ?? null,
    transcript: transcript?.text ? entschluesseln(transcript.text) : null,
    transcriptLang: transcript?.lang ?? null,
    translatedTranscript: null,
  };
}
