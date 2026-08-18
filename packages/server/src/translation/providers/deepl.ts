import { config } from '../../config.js';
import { ProviderError, type TranslateRequest, type TranslateResult, type TranslationProvider } from './types.js';

/** DeepL — beste reine Übersetzungsqualität, kann aber keine KI-Features. */
export class DeepLProvider implements TranslationProvider {
  readonly name = 'deepl';
  readonly model = null;
  readonly supportsAssistant = false;

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const params = new URLSearchParams();
    params.append('text', req.text);
    params.append('target_lang', toDeepLTarget(req.targetLang));
    if (req.sourceLang) params.append('source_lang', req.sourceLang.toUpperCase());
    params.append('tag_handling', 'html');       // schützt unsere {{n}}-Platzhalter schlechter als html-Tags,
    params.append('preserve_formatting', '1');   // deshalb zusätzlich Formatierung erzwingen

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.ai.requestTimeoutMs);
    try {
      const res = await fetch(`${config.ai.deepl.baseUrl}/translate`, {
        method: 'POST',
        headers: {
          authorization: `DeepL-Auth-Key ${config.ai.deepl.apiKey}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: params,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new ProviderError(`deepl ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
      }
      const data = await res.json() as { translations?: { text: string; detected_source_language?: string }[] };
      const first = data.translations?.[0];
      if (!first) throw new ProviderError('deepl: leere Antwort');
      return {
        text: first.text,
        detectedSourceLang: first.detected_source_language?.toLowerCase().slice(0, 2) ?? null,
        confidence: 0.95,
        model: null,
      };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`deepl: ${(err as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** DeepL erwartet für einige Sprachen Regionalvarianten. */
function toDeepLTarget(lang: string): string {
  const map: Record<string, string> = { en: 'EN-GB', pt: 'PT-PT', zh: 'ZH' };
  return map[lang] ?? lang.toUpperCase();
}
