import {
  detectLanguage, maskText, normalizeLang, placeholdersIntact,
  translatableLength, unmaskText, type TranslationView,
} from '@stellium/shared';
import { config, aiConfigured } from '../config.js';
import { db, reindexMessage } from '../db/index.js';
import { newId, sha1 } from '../util/id.js';
import { DeepLProvider } from './providers/deepl.js';
import { DemoProvider } from './providers/demo.js';
import { LibreProvider } from './providers/libre.js';
import { createGroqProvider, createOpenAIProvider, OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { ProviderError, type AssistantProvider, type TranslationProvider } from './providers/types.js';

/* ── Provider-Auswahl ─────────────────────────────────────────── */

function build(): TranslationProvider {
  if (!aiConfigured()) {
    console.warn(`[ai] Kein Schlüssel für "${config.ai.provider}" gefunden — Demo-Provider aktiv (keine echte Übersetzung).`);
    return new DemoProvider();
  }
  switch (config.ai.provider) {
    case 'groq': return createGroqProvider();
    case 'openai': return createOpenAIProvider();
    case 'deepl': return new DeepLProvider();
    case 'libre': return new LibreProvider();
    default: return new DemoProvider();
  }
}

export const provider: TranslationProvider = build();

export function assistant(): AssistantProvider | null {
  return provider instanceof OpenAICompatibleProvider ? provider : null;
}

/** Modell-Liste beim Anbieter holen, damit die Auswahl aktuell ist. */
export async function warmUpModels(): Promise<void> {
  if (!(provider instanceof OpenAICompatibleProvider)) return;
  await provider.registry.refresh();
  provider.registry.startAutoRefresh();
}

export function modelRegistry() {
  return provider instanceof OpenAICompatibleProvider ? provider.registry : null;
}

export function aiCapabilities() {
  const a = assistant();
  const registry = modelRegistry();
  const selection = registry?.current ?? null;
  return {
    provider: provider.name,
    model: provider.model,
    fastModel: provider instanceof OpenAICompatibleProvider ? provider.fastModel : null,
    modelSource: selection?.source ?? null,
    modelsAvailable: registry ? registry.usable.length || null : null,
    translation: provider.name !== 'demo',
    assistant: a !== null,
    note: provider.name === 'demo'
      ? 'Kein API-Schlüssel gesetzt. Trage GROQ_API_KEY in die .env ein, um Übersetzung und KI zu aktivieren.'
      : a === null
        ? `${provider.name} übersetzt, kann aber keine KI-Zusammenfassungen. Für alle Funktionen AI_PROVIDER=groq setzen.`
        : null,
  };
}

/* ── Glossar ──────────────────────────────────────────────────── */

interface GlossaryRow { id: string; term: string; translations: string | null; case_sensitive: number }

let glossaryCache: { rows: GlossaryRow[]; at: number } | null = null;
const GLOSSARY_TTL = 30_000;

function glossary(): GlossaryRow[] {
  if (glossaryCache && Date.now() - glossaryCache.at < GLOSSARY_TTL) return glossaryCache.rows;
  const rows = db.all<GlossaryRow>('SELECT id, term, translations, case_sensitive FROM glossary');
  glossaryCache = { rows, at: Date.now() };
  return rows;
}

export function invalidateGlossary(): void { glossaryCache = null; }

/** Begriffe ohne Zielübersetzung werden maskiert, der Rest als Vorgabe mitgegeben. */
function glossaryFor(targetLang: string): { protectedTerms: string[]; mapping: Record<string, string> } {
  const protectedTerms: string[] = [];
  const mapping: Record<string, string> = {};
  for (const row of glossary()) {
    if (!row.translations) { protectedTerms.push(row.term); continue; }
    try {
      const map = JSON.parse(row.translations) as Record<string, string>;
      const hit = map[targetLang];
      if (hit) mapping[row.term] = hit;
      else protectedTerms.push(row.term);
    } catch {
      protectedTerms.push(row.term);
    }
  }
  return { protectedTerms, mapping };
}

/* ── Caches ───────────────────────────────────────────────────── */

class Lru<T> {
  private map = new Map<string, T>();
  constructor(private limit: number) {}
  get(k: string): T | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: string, v: T): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
  }
}

const memory = new Lru<{ text: string; provider: string; model: string | null; confidence: number | null }>(
  config.ai.memoryCacheSize,
);

const tmKey = (src: string, tgt: string, text: string) => sha1(`${src}|${tgt}|${text}`);

/* ── Kernfunktion ─────────────────────────────────────────────── */

export interface TranslateOptions {
  text: string;
  targetLang: string;
  sourceLang?: string | null;
  context?: string | null;
  /** Cache überspringen (z.B. für den Round-Trip-Check). */
  skipCache?: boolean;
}

export interface TranslateOutcome {
  text: string;
  sourceLang: string;
  provider: string;
  model: string | null;
  confidence: number | null;
  cached: boolean;
  /** true, wenn Ausgangs- und Zielsprache gleich sind — nichts zu tun. */
  noop: boolean;
}

export async function translate(opts: TranslateOptions): Promise<TranslateOutcome> {
  const target = normalizeLang(opts.targetLang);
  const detected = opts.sourceLang ? normalizeLang(opts.sourceLang) : detectLanguage(opts.text).lang;
  const source = detected === 'unknown' ? 'en' : detected;

  const base = {
    sourceLang: source, provider: provider.name, model: provider.model,
    confidence: null as number | null, cached: false, noop: false,
  };

  if (source === target) return { ...base, text: opts.text, noop: true, confidence: 1 };

  const { protectedTerms, mapping } = glossaryFor(target);
  const { masked, tokens } = maskText(opts.text, { protectedTerms });

  // Reiner Code / nur Links / nur Emojis -> nichts Übersetzbares übrig.
  if (translatableLength(masked) === 0) {
    return { ...base, text: opts.text, noop: true, confidence: 1 };
  }

  const key = tmKey(source, target, masked);

  if (!opts.skipCache) {
    const hot = memory.get(key);
    if (hot) return { ...base, ...hot, text: unmaskText(hot.text, tokens), cached: true };

    const row = db.get<{ target_text: string; provider: string }>(
      'SELECT target_text, provider FROM translation_memory WHERE key = ?', key,
    );
    if (row) {
      db.run('UPDATE translation_memory SET hits = hits + 1 WHERE key = ?', key);
      const entry = { text: row.target_text, provider: row.provider, model: provider.model, confidence: 0.9 };
      memory.set(key, entry);
      return { ...base, ...entry, text: unmaskText(row.target_text, tokens), cached: true };
    }
  }

  let result;
  try {
    result = await withRetry(() => provider.translate({
      text: masked,
      targetLang: target,
      sourceLang: source,
      context: opts.context ?? null,
      glossary: mapping,
    }));
  } catch (err) {
    console.error('[translate]', (err as Error).message);
    // Lieber das Original zeigen als gar nichts.
    return { ...base, text: opts.text, confidence: 0, noop: true };
  }

  let out = result.text;
  if (!placeholdersIntact(masked, out)) {
    // Modell hat Platzhalter verschluckt — Original zurückgeben statt Kauderwelsch.
    console.warn('[translate] Platzhalter beschädigt, nutze Original');
    return { ...base, text: opts.text, confidence: 0, noop: true };
  }

  const finalSource = result.detectedSourceLang ? normalizeLang(result.detectedSourceLang) : source;
  if (finalSource === target) {
    return { ...base, sourceLang: finalSource, text: opts.text, noop: true, confidence: 1 };
  }

  const entry = { text: out, provider: provider.name, model: result.model, confidence: result.confidence };
  memory.set(key, entry);
  db.run(
    `INSERT INTO translation_memory (key, source_lang, target_lang, source_text, target_text, provider, hits, created_at)
     VALUES (?,?,?,?,?,?,1,?)
     ON CONFLICT(key) DO UPDATE SET hits = hits + 1`,
    key, finalSource, target, masked, out, provider.name, Date.now(),
  );

  return { ...base, ...entry, sourceLang: finalSource, text: unmaskText(out, tokens) };
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof ProviderError ? err.retryable : false;
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 350 * 2 ** i + Math.random() * 200));
    }
  }
  throw lastErr;
}

/* ── Nachrichten-Übersetzung mit persistentem Cache ───────────── */

interface MessageRow {
  id: string; channel_id: string; text: string; source_lang: string | null; deleted_at: number | null;
}

export async function translateMessage(
  messageId: string,
  targetLang: string,
  opts: { force?: boolean; context?: string | null } = {},
): Promise<TranslationView | null> {
  const target = normalizeLang(targetLang);
  const msg = db.get<MessageRow>(
    'SELECT id, channel_id, text, source_lang, deleted_at FROM messages WHERE id = ?', messageId,
  );
  if (!msg || msg.deleted_at) return null;

  const hash = sha1(msg.text);

  if (!opts.force) {
    const cached = db.get<{ text: string; provider: string; model: string | null; confidence: number | null; source_hash: string }>(
      'SELECT text, provider, model, confidence, source_hash FROM message_translations WHERE message_id = ? AND lang = ?',
      messageId, target,
    );
    if (cached && cached.source_hash === hash) {
      return { lang: target, text: cached.text, provider: cached.provider, model: cached.model, confidence: cached.confidence, cached: true };
    }
  }

  const outcome = await translate({
    text: msg.text,
    targetLang: target,
    sourceLang: msg.source_lang,
    context: opts.context ?? null,
    skipCache: opts.force,
  });

  if (outcome.noop) return null;

  db.run(
    `INSERT INTO message_translations (message_id, lang, text, provider, model, confidence, source_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(message_id, lang) DO UPDATE SET
       text = excluded.text, provider = excluded.provider, model = excluded.model,
       confidence = excluded.confidence, source_hash = excluded.source_hash, created_at = excluded.created_at`,
    messageId, target, outcome.text, outcome.provider, outcome.model, outcome.confidence, hash, Date.now(),
  );
  reindexMessage(messageId);

  return {
    lang: target, text: outcome.text, provider: outcome.provider,
    model: outcome.model, confidence: outcome.confidence, cached: outcome.cached,
  };
}

/** Edits invalidieren alle Übersetzungen der Nachricht. */
export function dropMessageTranslations(messageId: string): void {
  db.run('DELETE FROM message_translations WHERE message_id = ?', messageId);
}

/* ── Round-Trip-Prüfung ───────────────────────────────────────── */

/**
 * Übersetzt die Übersetzung zurück in die Ausgangssprache. Weicht das Ergebnis
 * stark vom Original ab, ist die Übersetzung vermutlich schief — der Nutzer
 * sieht das als Warnhinweis.
 */
export async function roundTrip(messageId: string, targetLang: string): Promise<{ backTranslation: string; similarity: number } | null> {
  const msg = db.get<MessageRow>('SELECT id, channel_id, text, source_lang, deleted_at FROM messages WHERE id = ?', messageId);
  if (!msg || msg.deleted_at) return null;
  const translated = db.get<{ text: string }>(
    'SELECT text FROM message_translations WHERE message_id = ? AND lang = ?', messageId, normalizeLang(targetLang),
  );
  if (!translated) return null;

  const sourceLang = msg.source_lang ?? detectLanguage(msg.text).lang;
  const back = await translate({
    text: translated.text,
    targetLang: sourceLang,
    sourceLang: normalizeLang(targetLang),
    skipCache: true,
  });
  return { backTranslation: back.text, similarity: similarity(msg.text, back.text) };
}

/** Token-basierte Ähnlichkeit (Dice-Koeffizient auf Wortebene). */
function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const A = norm(a); const B = norm(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map<string, number>();
  for (const w of A) counts.set(w, (counts.get(w) ?? 0) + 1);
  let overlap = 0;
  for (const w of B) {
    const c = counts.get(w) ?? 0;
    if (c > 0) { overlap++; counts.set(w, c - 1); }
  }
  return (2 * overlap) / (A.length + B.length);
}

/* ── Glossar-Verwaltung ───────────────────────────────────────── */

export function addGlossaryEntry(input: {
  term: string; translations: Record<string, string> | null; caseSensitive?: boolean; note?: string | null; userId: string;
}) {
  const id = newId('gl_');
  db.run(
    `INSERT INTO glossary (id, term, translations, case_sensitive, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(lower(term)) DO UPDATE SET
       translations = excluded.translations, case_sensitive = excluded.case_sensitive, note = excluded.note`,
    id, input.term, input.translations ? JSON.stringify(input.translations) : null,
    input.caseSensitive ? 1 : 0, input.note ?? null, input.userId, Date.now(),
  );
  invalidateGlossary();
  return id;
}

export function removeGlossaryEntry(id: string): void {
  db.run('DELETE FROM glossary WHERE id = ?', id);
  invalidateGlossary();
}

export function listGlossary() {
  return db.all<{ id: string; term: string; translations: string | null; case_sensitive: number; note: string | null; created_by: string; created_at: number }>(
    'SELECT * FROM glossary ORDER BY term COLLATE NOCASE',
  ).map((r) => ({
    id: r.id,
    term: r.term,
    translations: r.translations ? JSON.parse(r.translations) as Record<string, string> : null,
    caseSensitive: Boolean(r.case_sensitive),
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}
