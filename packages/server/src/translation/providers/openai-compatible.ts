import { aktiverAnbieter, config, lokaleEinstellung } from '../../config.js';
import { ModelRegistry } from './model-registry.js';
import { translationBudget, uebersetzungsRegeln, uebersetzungsTemperatur } from '../prompt.js';
import { uebersetzungAusAntwort } from '../antwort.js';
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
          // Ohne Schlüssel keinen leeren Bearer schicken: ein lokaler Dienst
          // lehnt das je nach Fassung ab.
          ...(this.ep.apiKey ? { authorization: `Bearer ${this.ep.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...body, model: modelId }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');

        // Das Modell hat das JSON nicht fertig bekommen — praktisch immer zu
        // wenig Token-Budget. Das ist ein vorübergehender Fehler, kein Grund,
        // das Modell auszusortieren.
        if (res.status === 400 && /json_validate_failed|max completion tokens/i.test(detail)) {
          throw new ProviderError(
            `${this.ep.name}: Antwort wurde abgeschnitten, bevor das JSON fertig war`,
            400,
            true,
          );
        }

        // Modell weg oder kann kein JSON-Format? Liste neu holen und ein
        // anderes wählen. Das greift auch, wenn beim Start noch keine Liste
        // vorlag und der Notnagel-Name bei diesem Konto nicht existiert.
        if (looksLikeModelProblem(res.status, detail)) {
          const gewechselt = await this.registry.recoverFrom(modelId);
          if (gewechselt) {
            throw new ProviderError(
              `${this.ep.name}: ${modelId} nicht verwendbar, wechsle auf ${this.registry.current.quality}`,
              res.status,
              true,   // erneut versuchen — jetzt mit dem Nachfolger
            );
          }
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
      max_completion_tokens: opts.maxTokens ?? 2048,
      ...reasoningOptions(modelId, opts.reasoning ?? 'low'),
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
    const rules = uebersetzungsRegeln(req);

    /* Roh entgegennehmen statt über json() gehen: llama.cpp hält sich nicht
       zuverlässig an response_format und antwortet mitunter mit der blanken
       Übersetzung. Über json() flöge die weg, obwohl sie brauchbar ist. */
    const roh = await this.chat(
      [
        { role: 'system', content: rules.join('\n') },
        { role: 'user', content: req.text },
      ],
      {
        json: true,
        temperature: uebersetzungsTemperatur(req),
        // Großzügig rechnen: Denkmodelle wie gpt-oss verbrauchen Tokens, bevor
        // das erste Zeichen der Antwort kommt. Zu knapp bemessen bricht die
        // Ausgabe mitten im JSON ab und Groq antwortet mit 400.
        maxTokens: translationBudget(req.text),
        reasoning: 'low',
      },
    );

    const feld = uebersetzungAusAntwort(roh, req.text);
    if (!feld) throw new ProviderError(`${this.ep.name}: Antwort enthielt keine Übersetzung`);

    return {
      text: feld.translation,
      detectedSourceLang: feld.detected?.toLowerCase().slice(0, 2) ?? null,
      confidence: feld.confidence,
      model: this.registry.current.quality,
    };
  }
}

/**
 * Denkaufwand drosseln, wo das Modell es unterstützt. Eine Chat-Nachricht zu
 * übersetzen braucht keine langen Überlegungen — und jede Denkzeile geht vom
 * Token-Budget ab. Der Parameter existiert nur bei den gpt-oss-Modellen,
 * deshalb wird er nicht blind mitgeschickt.
 */
function reasoningOptions(modelId: string, effort: 'low' | 'medium' | 'high'): Record<string, unknown> {
  if (/gpt-oss/i.test(modelId)) return { reasoning_effort: effort };
  return {};
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

/**
 * Ein Modell auf der eigenen Maschine — Ollama oder llama.cpp.
 *
 * Beide bieten dieselbe Schnittstelle wie OpenAI an, deshalb genügt hier eine
 * andere Adresse und kein Schlüssel. Was nicht geht: Sprachnachrichten
 * abtippen — dafür braucht es Whisper, und das läuft nicht über diesen Weg.
 */
export function createLokalProvider(): OpenAICompatibleProvider {
  const name = aktiverAnbieter();
  const { baseUrl, model, fastModel } = lokaleEinstellung();
  const registry = new ModelRegistry({
    name,
    baseUrl,
    apiKey: '',
    ohneSchluessel: true,
    unbewertet: true,
    pinnedQuality: model || undefined,
    pinnedFast: fastModel || undefined,
    // Weit verbreitet und klein genug für einen Einplatinenrechner.
    fallbackQuality: 'gemma3:4b',
    fallbackFast: 'gemma3:4b',
  });
  return new OpenAICompatibleProvider({ name, apiKey: '', baseUrl }, registry);
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
