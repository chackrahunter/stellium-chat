export interface TranslateRequest {
  text: string;
  targetLang: string;
  sourceLang?: string | null;
  /** Kanal-/Gesprächskontext hilft Modellen bei Anrede und Fachbegriffen. */
  context?: string | null;
  /** Begriffe, die in der Zielsprache exakt so lauten müssen. */
  glossary?: Record<string, string>;
  /**
   * Zweiter Anlauf, nachdem der erste den Eingabetext zurückgegeben hat.
   * Provider, die einen Prompt schreiben, formulieren dann deutlicher.
   * Wer fest übersetzt (DeepL, Libre), darf das Feld übergehen.
   */
  nachdruck?: boolean;
}

export interface TranslateResult {
  text: string;
  detectedSourceLang: string | null;
  confidence: number | null;
  model: string | null;
}

export interface TranslationProvider {
  readonly name: string;
  readonly model: string | null;
  readonly supportsAssistant: boolean;
  translate(req: TranslateRequest): Promise<TranslateResult>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** true erzwingt ein JSON-Objekt als Antwort. */
  json?: boolean;
  fast?: boolean;
  /**
   * Wie viel das Modell vor der Antwort nachdenken soll. Übersetzen kommt mit
   * 'low' aus; Zusammenfassungen dürfen mehr. Wirkt nur bei Modellen, die den
   * Parameter kennen.
   */
  reasoning?: 'low' | 'medium' | 'high';
}

/** Provider, die mehr können als übersetzen (Groq, OpenAI-kompatible). */
export interface AssistantProvider {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  json<T>(messages: ChatMessage[], opts?: ChatOptions): Promise<T>;
  /**
   * Wie viele Marken das Modell insgesamt annimmt — Anfrage und Antwort
   * zusammen. Wer einen Verlauf zusammenstellt, muss das vorher wissen; siehe
   * translation/fenster.ts.
   */
  kontextfenster(opts?: { fast?: boolean }): number;
  /**
   * Woran sich das gelernte Kontextfenster merken lässt.
   *
   * Die Angabe eines Modells über sein Fenster ist eine Behauptung über die
   * Gewichte, keine über den Dienst davor — ollama bedient ein 32k-Modell
   * auch mal mit 4096. Das tatsächliche Maß wird deshalb gelernt und unter
   * dieser Kennung gemerkt (translation/fenster.ts). */
  readonly kennung: string;
}

/**
 * Woran es lag — grob genug, dass die Oberfläche einen Satz dazu setzen kann.
 *
 * Ohne diese Einordnung landete der rohe Text des Anbieters beim Benutzer:
 * Don sah ein Meldungsfenster mit dem JSON von ollama darin, auf Englisch.
 */
export type Fehlerart =
  /** Die Anfrage war größer als das Kontextfenster des Modells. */
  | 'zuLang'
  /** Das Modell hat nicht rechtzeitig geantwortet. */
  | 'zeit'
  /** Zu viele Anfragen, Modell überlastet. */
  | 'ueberlastet'
  /** Der Dienst war gar nicht erst zu erreichen (Rechner aus, Netz weg). */
  | 'unerreichbar'
  /** Alles Übrige. */
  | 'sonst';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly art: Fehlerart = 'sonst',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Sagt der Anbieter, die Anfrage sei zu groß?
 *
 * Jeder formuliert es anders — llama.cpp/ollama mit „exceeds the available
 * context size", OpenAI mit „maximum context length", andere mit
 * „context_length_exceeded". Deshalb wird am Text erkannt und nicht an einem
 * Code, den es nur bei einem von ihnen gibt.
 */
export function klingtNachZuLang(text: string): boolean {
  return /exceed[s]?_?\s*(the\s+)?(available\s+)?context|context[_ ]length[_ ]exceeded|context size|too many tokens|maximum context|prompt is too long|reduce the length of the messages/i
    .test(text);
}
