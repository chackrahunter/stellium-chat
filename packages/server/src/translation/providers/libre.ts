import { config } from '../../config.js';
import { ProviderError, type TranslateRequest, type TranslateResult, type TranslationProvider } from './types.js';

/** LibreTranslate — selbst gehostet, wenn Texte das Haus nicht verlassen dürfen. */
export class LibreProvider implements TranslationProvider {
  readonly name = 'libre';
  readonly model = null;
  readonly supportsAssistant = false;

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.ai.requestTimeoutMs);
    try {
      const res = await fetch(`${config.ai.libre.baseUrl.replace(/\/+$/, '')}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          q: req.text,
          source: req.sourceLang ?? 'auto',
          target: req.targetLang,
          format: 'text',
          ...(config.ai.libre.apiKey ? { api_key: config.ai.libre.apiKey } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new ProviderError(`libre ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500);
      }
      const data = await res.json() as { translatedText?: string; detectedLanguage?: { language?: string; confidence?: number } };
      if (typeof data.translatedText !== 'string') throw new ProviderError('libre: leere Antwort');
      return {
        text: data.translatedText,
        detectedSourceLang: data.detectedLanguage?.language ?? null,
        confidence: data.detectedLanguage?.confidence != null ? data.detectedLanguage.confidence / 100 : 0.7,
        model: null,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`libre: ${(err as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }
}
