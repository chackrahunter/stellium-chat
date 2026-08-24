import { aktiverAnbieter, config, lokaleEinstellung } from '../../config.js';
import { ModelRegistry } from './model-registry.js';
import { translationBudget, uebersetzungsRegeln, uebersetzungsTemperatur } from '../prompt.js';
import { fensterFuer, fensterVerkleinern, verlaufsBudget } from '../fenster.js';
import { uebersetzungAusAntwort } from '../antwort.js';
import {
  type AssistantProvider, type ChatMessage, type ChatOptions,
  klingtNachZuLang,
  ProviderError, type TranslateRequest, type TranslateResult, type TranslationProvider,
  type Verbrauch,
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

        /* Die Anfrage war größer als das Fenster des Modells.
           Ausdrücklich **vor** looksLikeModelProblem(): dessen Muster enthält
           „model", und die Meldung von ollama enthält es auch — das Modell
           flöge sonst als kaputt aus der Liste, obwohl es nichts dafür kann
           und der nächste Versuch mit demselben zu langen Verlauf genauso
           endete. Nicht wiederholbar: derselbe Verlauf passt beim zweiten Mal
           genauso wenig. Der Aufrufer muss kürzen, und mit `art` weiß er
           auch, warum. */
        if (klingtNachZuLang(detail)) {
          throw new ProviderError(
            `${this.ep.name}: Anfrage größer als das Kontextfenster des Modells`,
            res.status, false, 'zuLang',
          );
        }

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
          res.status === 429 ? 'ueberlastet' : 'sonst',
        );
      }
      return await res.json();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new ProviderError(`${this.ep.name}: Zeitüberschreitung`, 408, true, 'zeit');
      }
      /* „fetch failed", ECONNREFUSED, DNS — der Dienst war nicht da. Das ist
         keine KI-Panne, sondern ein ausgeschalteter Rechner oder ein Netz
         dazwischen, und die Meldung soll das sagen: „Die KI konnte das gerade
         nicht erledigen" schickt sonst jemanden auf die Suche nach einem
         Fehler in der Anfrage. */
      const nachricht = (err as Error).message ?? '';
      const wegGewesen = /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|socket hang up|ETIMEDOUT/i
        .test(nachricht) || /fetch failed/i.test(String((err as { cause?: unknown }).cause ?? ''));
      throw new ProviderError(
        `${this.ep.name}: ${nachricht}`, undefined, true, wegGewesen ? 'unerreichbar' : 'sonst',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Wie viel dieses Modell annimmt. Kommt aus der Modell-Liste des Anbieters;
   * fehlt die Angabe, gilt der kleinste Wert, mit dem wir überhaupt rechnen.
   */
  /* Modell und Anbieter zusammen: dasselbe Modell hinter zwei Diensten kann
     verschieden große Fenster haben, und genau das ist der Fall, den das
     gelernte Maß fangen soll. */
  get kennung(): string { return `${this.name}:${this.registry.current.quality ?? this.model ?? '?'}`; }

  kontextfenster(opts: { fast?: boolean } = {}): number {
    return this.registry.kontextfenster(opts.fast ? this.fastModel : this.registry.current.quality);
  }

  /* Der Verbrauch der letzten Anfrage. Steht am Anbieter und nicht im
     Rückgabewert: sonst müsste jede Aufrufstelle ein zweites Feld
     durchreichen, nur damit eine Anzeige eine Zahl bekommt. */
  #verbrauch: Verbrauch | null = null;

  letzterVerbrauch(): Verbrauch | null { return this.#verbrauch; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const modelId = opts.fast ? this.fastModel : this.registry.current.quality;
    const data = await this.request({
      messages,
      temperature: opts.temperature ?? 0.2,
      max_completion_tokens: opts.maxTokens ?? 2048,
      ...reasoningOptions(modelId, opts.reasoning ?? 'low'),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }, modelId);

    /* Kommt aus der Antwort des Anbieters. Fehlt sie (llama.cpp lässt sie
       gelegentlich weg), bleibt der letzte Stand stehen statt einer 0 —
       eine 0 wäre eine Behauptung, kein fehlender Wert. */
    const nutzung = data?.usage;
    if (nutzung) {
      this.#verbrauch = {
        eingabe: Number(nutzung.prompt_tokens ?? 0),
        ausgabe: Number(nutzung.completion_tokens ?? 0),
        modell: modelId ?? null,
      };
    }

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
    const system = rules.join('\n');

    /* Wie viel Antwort-Platz translationBudget() sich WÜNSCHT, ohne Rücksicht
       auf ein Fenster — das war früher schon alles, was hier zählte, und
       genau das ist der Fehler: bei rund 4300 Zeichen reservierte die
       Faustregel mehr Antwort-Marken, als nach Abzug von System-Anweisung und
       Anfrage überhaupt noch im Fenster des Modells übrig blieben. Deshalb
       hier dieselbe Rechnung wie bei Zusammenfassung und Assistent
       (services/ai.ts, services/post-entwurf-ki.ts): gelerntes statt
       behauptetes Fenster (fensterFuer/fensterVerkleinern, translation/
       fenster.ts — Ollama bedient ein Modell mitunter kleiner, als es
       könnte), und der tatsächlich freie Platz danach (verlaufsBudget) statt
       der bloßen Faustregel. */
    let fenster = fensterFuer(this.kennung, this.kontextfenster());
    let roh: string | null = null;

    while (roh === null) {
      const verfuegbar = verlaufsBudget({ fenster, fest: `${system}\n${req.text}`, antwort: 0 });
      if (verfuegbar <= 0) {
        /* Passt schon die Anfrage selbst nicht mehr neben die
           System-Anweisung ins Fenster — kein Grund, es trotzdem zu
           versuchen: das Modell lehnte ohnehin ab, nur langsamer und mit
           einer Meldung, die nichts über den wahren Grund sagt. Sichtbar
           statt still: 'zuLang' läuft in translate() (index.ts) auf
           `unuebersetzt: true`, nicht auf ein stilles Original-Echo. */
        throw new ProviderError(
          `${this.ep.name}: Text zu lang für das Kontextfenster des Modells (${fenster} Marken)`,
          undefined, false, 'zuLang',
        );
      }
      // Was die Übersetzung selbst braucht, aber gedeckelt auf das, was neben
      // Anweisung und Anfrage tatsächlich noch frei ist.
      const maxTokens = Math.min(translationBudget(req.text), verfuegbar);

      try {
        /* Roh entgegennehmen statt über json() gehen: llama.cpp hält sich
           nicht zuverlässig an response_format und antwortet mitunter mit
           der blanken Übersetzung. Über json() flöge die weg, obwohl sie
           brauchbar ist. */
        roh = await this.chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: req.text },
          ],
          {
            json: true,
            temperature: uebersetzungsTemperatur(req),
            maxTokens,
            reasoning: 'low',
          },
        );
      } catch (err) {
        // Nur eine Absage wegen Länge wird kleiner versucht — ein Netzfehler
        // bleibt ein Netzfehler, den kleiner zu wiederholen hilft niemandem.
        if ((err as { art?: string })?.art !== 'zuLang') throw err;
        const kleiner = fensterVerkleinern(this.kennung, fenster);
        if (!kleiner) throw err;
        fenster = kleiner;
      }
    }

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
