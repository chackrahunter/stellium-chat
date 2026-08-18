import { config } from '../../config.js';
import { languageInfo } from '@stellium/shared';
import { ModelRegistry } from './model-registry.js';
import {
  type AssistantProvider, type ChatMessage, type ChatOptions,
  ProviderError, type TranslateRequest, type TranslateResult, type TranslationProvider,
} from './types.js';

interface Endpoint {
  name: string;
  apiKey: string;
  baseUrl: string;
}

/**
 * Deckt Groq und jede andere OpenAI-kompatible API ab.
 * Groq ist der Standard: sehr schnell, damit Live-Übersetzung nicht ruckelt.
 *
 * Welches Modell benutzt wird, entscheidet die ModelRegistry anhand der
 * Modell-Liste des Anbieters — feste IDs stehen nur noch als Notnagel in der
 * Konfiguration.
 */
export class OpenAICompatibleProvider implements TranslationProvider, AssistantProvider {
  readonly supportsAssistant = true;

  constructor(private readonly ep: Endpoint, readonly registry: ModelRegistry) {}

  get name(): string { return this.ep.name; }
  get model(): string | null { return this.registry.current.quality; }
  get fastModel(): string { return this.registry.current.fast; }

  private async request(body: Record<string, unknown>, modelId: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.ai.requestTimeoutMs);
    try {
      const res = await fetch(`${this.ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.ep.apiKey}`,
        },
        body: JSON.stringify({ ...body, model: modelId }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // Modell weg oder kann kein JSON-Format? Aussortieren und neu wählen.
        if (looksLikeModelProblem(res.status, detail) && this.registry.markBroken(modelId)) {
          throw new ProviderError(
            `${this.ep.name}: ${modelId} nicht verwendbar, wechsle das Modell`,
            res.status,
            true,   // erneut versuchen — jetzt mit dem Nachfolger
          );
        }
        throw new ProviderError(
          `${this.ep.name} ${res.status}: ${detail.slice(0, 400)}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new ProviderError(`${this.ep.name}: Zeitüberschreitung`, 408, true);
      }
      throw new ProviderError(`${this.ep.name}: ${(err as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const modelId = opts.fast ? this.fastModel : this.registry.current.quality;
    const data = await this.request({
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }, modelId);

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new ProviderError(`${this.ep.name}: leere Antwort`);
    return content.trim();
  }

  async json<T>(messages: ChatMessage[], opts: ChatOptions = {}): Promise<T> {
    const raw = await this.chat(messages, { ...opts, json: true });
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Manche Modelle packen JSON in einen Codeblock oder stellen Text voran.
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]) as T; } catch { /* fällt durch */ }
      }
      throw new ProviderError(`${this.ep.name}: Antwort war kein gültiges JSON`);
    }
  }

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const target = languageInfo(req.targetLang);
    const source = req.sourceLang ? languageInfo(req.sourceLang) : null;

    const rules = [
      `Übersetze den Text ins ${target.name} (${target.native}).`,
      source ? `Ausgangssprache ist ${source.name}.` : 'Erkenne die Ausgangssprache selbst.',
      'Es handelt sich um Nachrichten aus einem Firmen-Chat. Behalte den Tonfall bei: locker bleibt locker, förmlich bleibt förmlich.',
      'Platzhalter der Form {{0}}, {{1}} usw. sind Code, Links, @Erwähnungen oder Produktnamen. Gib sie unverändert und vollzählig zurück.',
      'Übersetze keine Emojis und erfinde keine zusätzlichen Sätze.',
      'Behalte Zeilenumbrüche und Markdown-Struktur bei.',
    ];

    if (req.glossary && Object.keys(req.glossary).length) {
      const pairs = Object.entries(req.glossary).map(([k, v]) => `"${k}" -> "${v}"`).join(', ');
      rules.push(`Verwende diese Firmen-Terminologie zwingend: ${pairs}.`);
    }
    if (req.context) {
      rules.push(`Kontext des Gesprächs (nur zur Orientierung, nicht übersetzen): ${req.context}`);
    }
    rules.push('Antworte ausschließlich als JSON: {"translation": "...", "detected_source_language": "<ISO-639-1>", "confidence": <0..1>}');

    const data = await this.json<{ translation?: string; detected_source_language?: string; confidence?: number }>(
      [
        { role: 'system', content: rules.join('\n') },
        { role: 'user', content: req.text },
      ],
      { temperature: 0, maxTokens: Math.min(4096, Math.max(256, req.text.length * 3)) },
    );

    if (typeof data.translation !== 'string') {
      throw new ProviderError(`${this.ep.name}: Feld "translation" fehlt`);
    }
    return {
      text: data.translation,
      detectedSourceLang: data.detected_source_language?.toLowerCase().slice(0, 2) ?? null,
      confidence: typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : null,
      model: this.registry.current.quality,
    };
  }
}

/** Fehler, die am gewählten Modell liegen — nicht an der Anfrage. */
function looksLikeModelProblem(status: number, detail: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /model|decommission|deprecat|does not exist|not found|response_format|json_object/i.test(detail);
}

export function createGroqProvider(): OpenAICompatibleProvider {
  const baseUrl = config.ai.groq.baseUrl.replace(/\/+$/, '');
  const registry = new ModelRegistry({
    name: 'groq',
    baseUrl,
    apiKey: config.ai.groq.apiKey,
    pinnedQuality: config.ai.groq.model || undefined,
    pinnedFast: config.ai.groq.fastModel || undefined,
    fallbackQuality: 'llama-3.3-70b-versatile',
    fallbackFast: 'llama-3.1-8b-instant',
  });
  return new OpenAICompatibleProvider({ name: 'groq', apiKey: config.ai.groq.apiKey, baseUrl }, registry);
}

export function createOpenAIProvider(): OpenAICompatibleProvider {
  const baseUrl = config.ai.openai.baseUrl.replace(/\/+$/, '');
  const registry = new ModelRegistry({
    name: 'openai',
    baseUrl,
    apiKey: config.ai.openai.apiKey,
    pinnedQuality: config.ai.openai.model || undefined,
    pinnedFast: config.ai.openai.fastModel || undefined,
    fallbackQuality: 'gpt-4o-mini',
    fallbackFast: 'gpt-4o-mini',
  });
  return new OpenAICompatibleProvider({ name: 'openai', apiKey: config.ai.openai.apiKey, baseUrl }, registry);
}
