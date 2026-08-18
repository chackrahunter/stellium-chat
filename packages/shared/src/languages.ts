/** Sprachliste + heuristische Spracherkennung ohne externe Abhängigkeiten. */

export interface LanguageInfo {
  code: string;      // "de"
  name: string;      // englisch
  native: string;    // in der Sprache selbst
  flag: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'de', name: 'German',     native: 'Deutsch',    flag: '🇩🇪' },
  { code: 'en', name: 'English',    native: 'English',    flag: '🇬🇧' },
  { code: 'fr', name: 'French',     native: 'Français',   flag: '🇫🇷' },
  { code: 'es', name: 'Spanish',    native: 'Español',    flag: '🇪🇸' },
  { code: 'it', name: 'Italian',    native: 'Italiano',   flag: '🇮🇹' },
  { code: 'pt', name: 'Portuguese', native: 'Português',  flag: '🇵🇹' },
  { code: 'nl', name: 'Dutch',      native: 'Nederlands', flag: '🇳🇱' },
  { code: 'pl', name: 'Polish',     native: 'Polski',     flag: '🇵🇱' },
  { code: 'cs', name: 'Czech',      native: 'Čeština',    flag: '🇨🇿' },
  { code: 'ro', name: 'Romanian',   native: 'Română',     flag: '🇷🇴' },
  { code: 'tr', name: 'Turkish',    native: 'Türkçe',     flag: '🇹🇷' },
  { code: 'ru', name: 'Russian',    native: 'Русский',    flag: '🇷🇺' },
  { code: 'uk', name: 'Ukrainian',  native: 'Українська', flag: '🇺🇦' },
  { code: 'ar', name: 'Arabic',     native: 'العربية',     flag: '🇸🇦' },
  { code: 'hi', name: 'Hindi',      native: 'हिन्दी',       flag: '🇮🇳' },
  { code: 'zh', name: 'Chinese',    native: '中文',        flag: '🇨🇳' },
  { code: 'ja', name: 'Japanese',   native: '日本語',      flag: '🇯🇵' },
  { code: 'ko', name: 'Korean',     native: '한국어',      flag: '🇰🇷' },
  { code: 'sv', name: 'Swedish',    native: 'Svenska',    flag: '🇸🇪' },
  { code: 'da', name: 'Danish',     native: 'Dansk',      flag: '🇩🇰' },
  { code: 'fi', name: 'Finnish',    native: 'Suomi',      flag: '🇫🇮' },
  { code: 'no', name: 'Norwegian',  native: 'Norsk',      flag: '🇳🇴' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function languageInfo(code: string | null | undefined): LanguageInfo {
  if (!code) return { code: 'unknown', name: 'Unknown', native: '—', flag: '🌐' };
  return BY_CODE.get(normalizeLang(code)) ?? { code, name: code, native: code, flag: '🌐' };
}

/** "de-DE" -> "de", "zh-Hans" -> "zh" */
export function normalizeLang(code: string): string {
  return code.toLowerCase().split(/[-_]/)[0];
}

export function isSupportedLang(code: string): boolean {
  return BY_CODE.has(normalizeLang(code));
}

/* ── Heuristische Erkennung ───────────────────────────────────────
 * Reicht für die Frage "muss ich das überhaupt übersetzen?".
 * Der KI-Provider liefert bei Bedarf die genaue Sprache nach.
 */

const SCRIPT_RANGES: [RegExp, string][] = [
  [/[぀-ゟ゠-ヿ]/, 'ja'],
  [/[가-힯ᄀ-ᇿ]/, 'ko'],
  [/[一-鿿]/, 'zh'],
  [/[؀-ۿݐ-ݿ]/, 'ar'],
  [/[ऀ-ॿ]/, 'hi'],
];

const STOPWORDS: Record<string, string[]> = {
  de: ['der','die','das','und','ist','nicht','ich','wir','mit','auf','für','ein','eine','sich','noch','schon','aber','auch','kann','wird','haben','sind','beim','wenn','dass','oder','mal','doch','vom','zum','zur','bitte','danke','heute','morgen'],
  en: ['the','and','is','not','you','we','with','for','a','an','this','that','have','are','was','will','can','should','would','about','there','their','from','just','please','thanks','today','tomorrow','been','what'],
  fr: ['le','la','les','et','est','pas','je','nous','avec','pour','une','des','que','qui','dans','sur','vous','plus','être','avoir','mais','tout','merci','bonjour','aujourd'],
  es: ['el','la','los','las','y','es','no','yo','nosotros','con','para','una','que','en','por','pero','todo','gracias','hola','hoy','mañana','está','muy'],
  it: ['il','lo','la','gli','e','è','non','io','noi','con','per','una','che','del','sono','anche','ciao','grazie','oggi','domani','molto'],
  pt: ['o','a','os','as','e','é','não','eu','nós','com','para','uma','que','do','da','mas','também','obrigado','olá','hoje','amanhã'],
  nl: ['de','het','een','en','is','niet','ik','wij','met','voor','dat','die','op','zijn','maar','ook','graag','bedankt','vandaag','morgen'],
  pl: ['nie','jest','się','to','na','że','ale','jak','czy','dla','przez','jeszcze','dziękuję','dzień','dobry','proszę','dzisiaj'],
  tr: ['bir','ve','bu','için','ile','ama','değil','çok','var','yok','olarak','teşekkür','merhaba','bugün','yarın'],
  sv: ['och','att','det','som','inte','för','med','har','jag','vi','men','tack','hej','idag','imorgon'],
  ru: ['не','что','это','как','для','или','его','был','привет','спасибо','сегодня','завтра','пожалуйста'],
  uk: ['не','що','це','як','для','або','його','був','привіт','дякую','сьогодні','завтра','будь'],
  cs: ['je','na','se','že','ale','pro','jak','nebo','děkuji','ahoj','dnes','zítra','prosím'],
};

/** Wörter, die in DE und EN gleich aussehen, aber unterschiedlich gewichtet werden müssen. */
const DIACRITICS: Record<string, RegExp> = {
  de: /[äöüßÄÖÜ]/,
  fr: /[àâçéèêëîïôûùüÿœ]/i,
  es: /[áéíóúñ¿¡]/i,
  pt: /[ãõáéíóúâêôç]/i,
  it: /[àèéìòù]/i,
  pl: /[ąćęłńóśźż]/i,
  tr: /[çğıöşü]/i,
  cs: /[áčďéěíňóřšťúůýž]/i,
  ro: /[ăâîșț]/i,
  sv: /[åäö]/i,
  da: /[æøå]/i,
  no: /[æøå]/i,
  fi: /[äöå]/i,
};

export interface DetectionResult {
  lang: string;
  confidence: number;   // 0..1
}

/**
 * Anteil der großgeschriebenen Wörter, die nicht am Satzanfang stehen.
 * Im Deutschen liegt der Wert hoch (alle Substantive), im Englischen niedrig.
 */
function capitalizedMidSentenceRatio(text: string): number {
  // Satzanfänge und Eigennamen am Beginn ausklammern
  const saetze = text.split(/(?<=[.!?:\n])\s+/);
  let mittig = 0;
  let gross = 0;
  for (const satz of saetze) {
    const woerter = satz.trim().split(/\s+/).filter((w) => /^\p{L}/u.test(w));
    for (let i = 1; i < woerter.length; i++) {
      const w = woerter[i];
      if (w.length < 3) continue;
      // Durchgehend groß ist eine Abkürzung, kein Substantiv
      if (w === w.toUpperCase()) continue;
      mittig++;
      if (w[0] === w[0].toUpperCase() && w[0] !== w[0].toLowerCase()) gross++;
    }
  }
  return mittig >= 2 ? gross / mittig : 0;
}

export function detectLanguage(rawText: string): DetectionResult {
  const text = rawText.trim();
  if (text.length < 2) return { lang: 'unknown', confidence: 0 };

  for (const [re, lang] of SCRIPT_RANGES) {
    if (re.test(text)) {
      // Kyrillisch getrennt behandeln (ru vs uk)
      return { lang, confidence: 0.95 };
    }
  }
  if (/[Ѐ-ӿ]/.test(text)) {
    const ukOnly = /[іїєґ]/i.test(text);
    return { lang: ukOnly ? 'uk' : 'ru', confidence: ukOnly ? 0.9 : 0.8 };
  }

  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return { lang: 'unknown', confidence: 0 };

  const scores = new Map<string, number>();
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    if (hits > 0) scores.set(lang, hits / Math.sqrt(words.length));
  }
  for (const [lang, re] of Object.entries(DIACRITICS)) {
    if (re.test(text)) scores.set(lang, (scores.get(lang) ?? 0) + 0.9);
  }

  // Deutsch schreibt alle Substantive groß. Großgeschriebene Wörter mitten im
  // Satz sind deshalb ein starkes Signal — und retten kurze Texte ohne
  // Stoppwörter, etwa "Test — automatischer Durchlauf".
  const germanCaps = capitalizedMidSentenceRatio(text);
  if (germanCaps > 0.25) scores.set('de', (scores.get('de') ?? 0) + germanCaps * 2.2);

  // Typisch deutsche Wortendungen als zweites schwaches Signal.
  const germanSuffixes = words.filter((w) =>
    w.length > 5 && /(ung|heit|keit|schaft|lich|isch|chen|lein|ieren)$/.test(w)).length;
  if (germanSuffixes > 0) scores.set('de', (scores.get('de') ?? 0) + Math.min(germanSuffixes, 3) * 0.5);

  if (scores.size === 0) {
    // Nur ASCII, keine Anhaltspunkte. Englisch ist die häufigste Annahme,
    // aber die niedrige Konfidenz sagt dem Aufrufer: bitte nachprüfen lassen.
    return { lang: 'en', confidence: 0.15 };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bestLang, bestScore] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const margin = bestScore - second;
  const confidence = Math.max(0.2, Math.min(0.98, 0.45 + margin * 0.35 + Math.min(words.length, 20) * 0.012));
  return { lang: bestLang, confidence };
}
