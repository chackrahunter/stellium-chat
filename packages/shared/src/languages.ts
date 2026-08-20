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

/*
 * Deutsch trug lange nur Wörter, die es in keiner anderen Sprache gibt — und
 * war damit ausgerechnet bei kurzen Sätzen blind. „Was meinst du?" enthielt
 * kein einziges deutsches Stoppwort, wohl aber das englische „was": der Satz
 * galt als Englisch, wurde in der Anzeige mit EN ausgezeichnet und dem
 * Übersetzer als englisch untergeschoben. Dasselbe bei „Wie sieht es aus?",
 * das über das spanische „es" stolperte.
 *
 * Deshalb stehen hier jetzt auch die häufigen deutschen Funktionswörter, die
 * anderswo ebenfalls vorkommen. Ein geteiltes Wort schadet nicht: gezählt
 * werden Treffer, und ein deutscher Satz bringt fast immer mehrere davon mit,
 * während ein englischer Satz mit „was" nur diesen einen deutschen Treffer
 * hat. Entscheidend ist der Abstand zwischen erster und zweiter Sprache, nicht
 * die Einzigartigkeit der Wörter.
 */
const STOPWORDS: Record<string, string[]> = {
  /* Ein Wort, das mehrere Sprachen teilen, ist kein Problem — solange es in
     jeder dieser Listen steht. Dann bringt es beiden Seiten gleich viele
     Treffer und hebt sich auf; entschieden wird über die Wörter, die nur eine
     Sprache hat. Schaden richtet erst die Lücke an: „was" stand nur bei
     Englisch, „to" nur bei Polnisch, „no" nur bei Spanisch. Jeder englische
     Satz, dessen einziges Stoppwort „to" war, galt darum als polnisch — mit
     einer Konfidenz von 0,67, also hoch genug für die Datenbank.

     Deshalb sind die Listen jetzt nach derselben Regel gebaut: die häufigsten
     Funktionswörter der Sprache, ohne Rücksicht darauf, ob eine andere sie
     auch führt. Und deshalb sind sie ungefähr gleich lang — eine kurze Liste
     verliert sonst systematisch gegen eine lange. */
  de: ['der','die','das','und','ist','nicht','ich','wir','mit','auf','für','ein','eine','sich','noch',
    'schon','aber','auch','kann','wird','haben','sind','beim','wenn','dass','oder','mal','doch','vom','zum',
    'zur','bitte','danke','heute','morgen','was','es','du','dir','dich','mir','mich','uns','euch','ihr',
    'sie','er','ihn','ihm','wie','wo','wer','wann','warum','den','dem','im','am','zu','aus','bei','nach',
    'über','unter','vor','ohne','gegen','um','nur','sehr','immer','wieder','jetzt','dann','hier','man',
    'muss','soll','war','hat','habe','bin','sein','werden','wurde','gibt','geht','machen','nichts','etwas',
    'alles','alle','kein','keine','mehr','gut','nein','so','wirklich','vielleicht'],
  en: ['the','and','is','not','you','we','with','for','a','an','this','that','have','are','was','will',
    'can','should','would','about','there','their','from','just','please','thanks','today','tomorrow',
    'been','what','to','of','in','it','on','at','but','or','if','as','be','so','me','my','i','all','how',
    'when','where','who','why','no','yes','ok','know','think','need','make','get','let','see','more','then',
    'they','he','she','him','her','us','our','your','by','also','only','very','much','many','well','here',
    'out','up','one','now','some','than','them','into','back','still','sure','good','does','did','going',
    'want'],
  fr: ['le','la','les','et','est','pas','je','nous','avec','pour','une','des','que','qui','dans','sur',
    'vous','plus','être','avoir','mais','tout','merci','bonjour','aujourd','de','à','il','elle','on','ce',
    'se','ne','en','du','au','aux','si','comme','quoi','quand','où','comment','pourquoi','oui','non','très',
    'bien','faire','peux','veux','suis','alors','aussi','encore','déjà','toujours','moi','toi','cela','ça',
    'demain','hier','maintenant','ici'],
  es: ['el','la','los','las','y','es','no','yo','nosotros','con','para','una','que','en','por','pero',
    'todo','gracias','hola','hoy','mañana','está','muy','de','un','se','lo','le','me','te','su','al','del',
    'si','como','cuando','dónde','qué','quién','porque','bien','ya','más','también','ahora','aquí','sí',
    'vale','puedes','tengo','hacer','son','estoy','esto','a','todos','hay','problema','nos','cuándo'],
  it: ['il','lo','la','gli','e','è','non','io','noi','con','per','una','che','del','sono','anche','ciao',
    'grazie','oggi','domani','molto','di','a','da','in','un','si','mi','ti','ci','come','quando','dove',
    'cosa','perché','bene','più','adesso','qui','sì','posso','fare','ho','ma','se','questo','tutti','ne',
    'problema'],
  pt: ['o','a','os','as','e','é','não','eu','nós','com','para','uma','que','do','da','mas','também',
    'obrigado','olá','hoje','amanhã','de','em','um','se','me','te','seu','ao','na','no','por','como',
    'quando','onde','quem','porque','muito','bem','mais','já','agora','aqui','sim','posso','fazer','tenho',
    'está','você','isso','tudo','nos','mim','bom','problema','todos'],
  nl: ['de','het','een','en','is','niet','ik','wij','met','voor','dat','die','op','zijn','maar','ook',
    'graag','bedankt','vandaag','morgen','je','jij','we','wat','hoe','wanneer','waar','wie','waarom','heel',
    'goed','nu','hier','ja','nee','kan','kun','zien','doen','hebben','ben','er','om','te','van','in','naar',
    'nog','als','dan','deze','alle','geen'],
  pl: ['nie','jest','się','to','na','że','ale','jak','czy','dla','przez','jeszcze','dziękuję','dzień',
    'dobry','proszę','dzisiaj','w','i','z','do','co','tak','tylko','może','bardzo','teraz','dobrze','mam',
    'jestem','będzie','po','od','za','tym','tego','kiedy','gdzie','dlaczego','wszystkim','ma','są'],
  cs: ['je','na','se','že','ale','pro','jak','nebo','děkuji','ahoj','dnes','zítra','prosím','a','v','to',
    'co','tak','ano','ne','dobře','díky','jsem','můžeš','kdy','proč','kde','moc','všem','si','o','tom',
    'není','jsou','bude','jen','už','také','tady'],
  ro: ['și','de','la','un','o','este','nu','că','să','cu','pentru','ce','mai','bine','mulțumesc','bună',
    'ziua','când','cum','unde','da','foarte','acum','aici','poți','sunt','am','ai','sau','dar','din','pe',
    'ne','vedem'],
  tr: ['bir','ve','bu','için','ile','ama','değil','çok','var','yok','olarak','teşekkür','merhaba','bugün',
    'yarın','ne','zaman','nasıl','nerede','kim','evet','hayır','şimdi','burada','sorun','edebilir','misin',
    'benim','senin','de','da','mi','bana','sana','çünkü'],
  sv: ['och','att','det','som','inte','för','med','har','jag','vi','men','tack','hej','idag','imorgon','du',
    'vad','kan','här','är','på','till','om','hur','när','var','bra','nej','ska','mycket','ja','en','ett',
    'den','av','så','vill','ses','allihopa','inga'],
  da: ['og','er','det','en','at','til','på','for','med','ikke','jeg','du','vi','har','kan','hvad','hvor',
    'hvornår','tak','hej','nej','godt','men','som','af','meget','alle','ja','jer','dig','mig','os','den',
    'så','vil','synes','tjekke','mange','intet','ses','tilbage','mødet','bekræftet','lidt'],
  no: ['og','er','det','en','til','på','for','med','ikke','jeg','du','vi','har','kan','hva','hvor','når',
    'takk','hei','nei','godt','men','som','av','mye','alle','ja','deg','meg','oss','dere','den','så','vil',
    'synes','sjekke','tusen','ingen','ses','tilbake','møtet','bekreftet','litt'],
  fi: ['ja','on','ei','se','että','mutta','kiitos','hei','mitä','miten','milloin','voitko','tämä',
    'kaikille','joo','ole','olet','ongelmaa','paljon','nyt','täällä','kuka','missä','miksi','mieltä',
    'tarkistaa','tapaamme','me','sinä','minä','hyvä','en','ihan','tätä','sitä','vielä','vain','niin'],
  ru: ['не','что','это','как','для','или','его','был','привет','спасибо','сегодня','завтра','пожалуйста',
    'и','в','на','я','ты','он','она','мы','вы','а','но','да','нет','можешь','проверить','очень','сейчас',
    'здесь','когда','где','почему','кто','думаешь','большое','всем','проблем','уже','хорошо','нужно',
    'можно','потом','можем','скоро','вернусь','отправил'],
  uk: ['не','що','це','як','для','або','його','був','привіт','дякую','сьогодні','завтра','будь','і','в',
    'на','я','ти','він','вона','ми','ви','а','але','так','ні','можеш','перевірити','дуже','зараз','тут',
    'коли','де','чому','хто','думаєш','усім','немає','проблем','вже','добре','треба','можна','потім',
    'можемо','скоро','повернуся','надіслав'],
};

/** Wörter, die in DE und EN gleich aussehen, aber unterschiedlich gewichtet werden müssen. */
const DIACRITICS: Record<string, RegExp> = {
  de: /[äöüßÄÖÜ]/,
  /* Ohne u-Umlaut: im Franzoesischen steht er nur in einer Handvoll Woerter,
     im Deutschen und Tuerkischen in jedem zweiten Satz. Mit ihm in der Klasse
     holte sich Franzoesisch bei einem tuerkischen Satz denselben Zuschlag wie
     Tuerkisch und gewann den Gleichstand ueber die Reihenfolge. */
  fr: /[àâçéèêëîïôûùÿœ]/i,
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

/** Text in kleingeschriebene Wortteile zerlegen — einmal fuer alle Zweige. */
function woerterVon(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Wie viele Woerter des Textes in dieser Liste stehen. */
function treffer(woerter: string[], liste: string[]): number {
  const menge = new Set(liste);
  let n = 0;
  for (const w of woerter) if (menge.has(w)) n++;
  return n;
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
    // Diese Buchstaben gibt es im Russischen nicht — das ist unumstoesslich.
    if (/[іїєґ]/i.test(text)) return { lang: 'uk', confidence: 0.9 };
    /* Fehlen sie, entscheiden die Woerter: вже gegen уже, добре gegen хорошо.
       Vorher fiel jeder ukrainische Satz ohne і/ї/є/ґ auf Russisch, und zwar
       mit 0,8 Konfidenz — hoch genug fuer die Datenbank.

       Bei Gleichstand bleibt es bei Russisch, denn es ist die weit haeufigere
       der beiden. Ein leiser Rueckgabewert waere hier gerade falsch: er hat in
       der Messung jeden russischen Satz unter die Schwelle gedrueckt. */
    const kyrillisch = woerterVon(text);
    const uk = treffer(kyrillisch, STOPWORDS.uk);
    if (uk > treffer(kyrillisch, STOPWORDS.ru)) return { lang: 'uk', confidence: 0.75 };
    return { lang: 'ru', confidence: 0.8 };
  }

  const words = woerterVon(text);

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
  /*
   * Die Sicherheit haengt am Abstand, nicht an der Satzlaenge.
   *
   * Vorher lautete sie 0,45 + 0,35 * Abstand + 0,012 * Woerter. Der feste
   * Sockel und die Laenge allein trugen einen Satz schon ueber 0,6 — auch dann,
   * wenn zwei Sprachen exakt gleich viele Treffer hatten und die Entscheidung
   * nur noch an der Reihenfolge der Listen hing. Genau in diesem Band lagen
   * gemessen 19 von 20 Fehlgriffen: „Suena bien" galt als Franzoesisch,
   * „Hemen doenecegim" als Deutsch, jeweils mit Abstand null.
   *
   * Jetzt kann ein Gleichstand die Schwelle nicht mehr ueberschreiten: ohne
   * Abstand bleibt hoechstens 0,20 + 20 * 0,004 = 0,28, und alles unter 0,35
   * wird gar nicht erst als Sprache eingetragen. Wer wirklich etwas weiss,
   * kommt weiterhin hoch hinaus — ein einziger eindeutiger Treffer reicht.
   */
  const confidence = Math.max(0.2, Math.min(0.98, 0.20 + margin * 0.55 + Math.min(words.length, 20) * 0.004));
  return { lang: bestLang, confidence };
}
