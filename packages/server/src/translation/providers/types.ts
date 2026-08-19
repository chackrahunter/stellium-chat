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
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}
