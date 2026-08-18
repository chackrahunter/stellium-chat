import { languageInfo } from '@stellium/shared';
import type { TranslateRequest, TranslateResult, TranslationProvider } from './types.js';

/**
 * Fallback ohne API-Key. Übersetzt NICHT wirklich — er macht nur sichtbar,
 * wo eine Übersetzung erscheinen würde, damit die App ohne Schlüssel bedienbar
 * bleibt. Ein kleines Wörterbuch deckt die häufigsten Chat-Floskeln ab.
 */
export class DemoProvider implements TranslationProvider {
  readonly name = 'demo';
  readonly model = null;
  readonly supportsAssistant = false;

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const dict = DICT[`${req.sourceLang ?? 'en'}>${req.targetLang}`];
    let text = req.text;
    if (dict) {
      for (const [from, to] of Object.entries(dict)) {
        text = text.replace(new RegExp(`\\b${from}\\b`, 'gi'), to);
      }
    }
    const tag = languageInfo(req.targetLang).flag;
    return {
      text: text === req.text ? `${tag} ${text}` : text,
      detectedSourceLang: req.sourceLang ?? null,
      confidence: 0.1,
      model: null,
    };
  }
}

const DICT: Record<string, Record<string, string>> = {
  'en>de': {
    hello: 'Hallo', hi: 'Hi', thanks: 'Danke', 'thank you': 'Danke',
    yes: 'Ja', no: 'Nein', please: 'Bitte', today: 'heute', tomorrow: 'morgen',
    meeting: 'Besprechung', 'good morning': 'Guten Morgen', team: 'Team',
    release: 'Release', bug: 'Fehler', done: 'erledigt', ready: 'fertig',
  },
  'de>en': {
    hallo: 'Hello', danke: 'thanks', ja: 'yes', nein: 'no', bitte: 'please',
    heute: 'today', morgen: 'tomorrow', besprechung: 'meeting',
    'guten morgen': 'Good morning', fehler: 'bug', erledigt: 'done', fertig: 'ready',
  },
};
