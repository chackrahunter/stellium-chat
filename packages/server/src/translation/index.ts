import {
  detectLanguage, dezimaltrennzeichenFuerSprache, findMeasurements, maskText, messwertPlatzhalter,
  messwerteInTextEinsetzen, normalizeLang, placeholdersIntact, PLACEHOLDER, translatableLength, unmaskText,
  type AiCapabilities, type Massregion, type Messwert, type TranslationView,
} from '@stellium/shared';
import {
  config, aiConfigured, aktiverAnbieter, istLokal, laufzeitSetzen, lokaleEinstellung, type AiProvider,
} from '../config.js';
import {
  getSetting, setSetting, SETTING_AI_PROVIDER, SETTING_LOCAL_FAST, SETTING_LOCAL_MODEL,
  SETTING_LOCAL_URL, SETTING_MODEL_FAST, SETTING_MODEL_QUALITY,
} from '../services/settings.js';
import { db, reindexMessage } from '../db/index.js';
import { newId, sha1 } from '../util/id.js';
import { abdruck, entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { DeepLProvider } from './providers/deepl.js';
import { DemoProvider } from './providers/demo.js';
import { LibreProvider } from './providers/libre.js';
import {
  createGroqProvider, createLokalProvider, createOpenAIProvider, OpenAICompatibleProvider,
} from './providers/openai-compatible.js';
import { ProviderError, type AssistantProvider, type TranslationProvider } from './providers/types.js';
import {
  ECHO_MIN_WOERTER, istEcho, woerter, wortAehnlichkeit,
} from './echo.js';
import {
  ausfallMelden, erfolgMelden, lageVergessen, lokaleLage, lokaleLageJetzt, modelleAbfragen,
  type LokaleLage,
} from './erreichbarkeit.js';
import * as stimme from '../services/stimme.js';

/* ── Provider-Auswahl ─────────────────────────────────────────── */

function build(): TranslationProvider {
  if (!aiConfigured()) {
    console.warn(`[ai] Kein Schlüssel für "${aktiverAnbieter()}" gefunden — Demo-Provider aktiv (keine echte Übersetzung).`);
    return new DemoProvider();
  }
  switch (aktiverAnbieter()) {
    case 'groq': return createGroqProvider();
    case 'openai': return createOpenAIProvider();
    case 'ollama':
    case 'llamacpp':
    case 'local': return createLokalProvider();
    case 'deepl': return new DeepLProvider();
    case 'libre': return new LibreProvider();
    default: return new DemoProvider();
  }
}

let aktiv: TranslationProvider = build();

/* ── Ausweichen, wenn das eigene Modell schweigt ─────────────────
   Ein Modell im eigenen Netz ist genau so lange verfügbar wie der Rechner,
   auf dem es läuft. Steht der still, fällt bisher die ganze KI aus:
   keine Übersetzung, kein Protokoll, kein Assistent — genau so ist Dons
   Protokoll heute zweimal ins Leere gelaufen, während ein brauchbarer
   Groq-Schlüssel im Tresor lag.

   Deshalb ein Ersatz auf Zeit: Meldet die Erreichbarkeitsprüfung einen
   Ausfall, übernimmt der erste eingerichtete Dienst im Netz. Meldet sie
   wieder Erfolg, tritt er zurück — die Einstellung bleibt unangetastet, es
   ist eine Vertretung und kein Wechsel. */
let ersatz: TranslationProvider | null = null;

/** Welcher Dienst im Netz einspringen könnte — der erste mit Schlüssel. */
function ersatzBauen(): TranslationProvider | null {
  if (config.ai.groq.apiKey) return createGroqProvider();
  if (config.ai.openai.apiKey) return createOpenAIProvider();
  return null;
}

/**
 * Das eigene Modell antwortet nicht — jemanden anderen ranlassen.
 *
 * Tut nichts, wenn ohnehin kein lokales Modell eingestellt ist, wenn die
 * Vertretung schon läuft oder wenn es niemanden gibt, der einspringen könnte.
 */
export function ersatzUebernimmt(grund: string): void {
  if (!istLokal() || ersatz) return;
  const vertretung = ersatzBauen();
  if (!vertretung) return;
  ersatz = vertretung;
  console.warn(`[ai] ${aktiv.name} antwortet nicht (${grund}) — `
    + `"${vertretung.name}" übernimmt, bis es wieder da ist.`);
}

/** Das eigene Modell ist zurück — die Vertretung tritt ab. */
export function ersatzTrittAb(): void {
  if (!ersatz) return;
  console.log(`[ai] ${aktiv.name} antwortet wieder — "${ersatz.name}" tritt ab.`);
  ersatz = null;
}

/** Springt gerade jemand ein? Für die Auskunft in den Einstellungen. */
export function ersatzLaeuft(): string | null {
  return ersatz?.name ?? null;
}

/** Wer gerade wirklich arbeitet: die Vertretung, sonst der eingestellte. */
function derzeit(): TranslationProvider {
  return ersatz ?? aktiv;
}

/**
 * Der Anbieter lässt sich im Betrieb wechseln.
 *
 * Alles im Server greift auf `provider` zu; wäre das eine feste Bindung, wäre
 * ein Wechsel erst nach einem Neustart sichtbar. Der Stellvertreter hier leitet
 * jeden Zugriff an den gerade gültigen Anbieter weiter — so bleibt jede
 * bestehende Verwendung gültig und die Umschaltung wirkt sofort.
 */
export const provider: TranslationProvider = new Proxy({} as TranslationProvider, {
  get(_ziel, name) {
    const wer = derzeit();
    const wert = (wer as unknown as Record<string | symbol, unknown>)[name];
    return typeof wert === 'function' ? wert.bind(wer) : wert;
  },
  // instanceof muss weiter funktionieren — daran hängt, ob der Assistent kann.
  getPrototypeOf() { return Object.getPrototypeOf(derzeit()); },
  has(_ziel, name) { return name in (derzeit() as object); },
});

/** Nach einer Änderung in den Einstellungen neu aufbauen. */
export async function providerNeuAufbauen(): Promise<void> {
  aktiv = build();
  /* Wer von Hand umstellt, meint es so — eine Vertretung von vorhin hat sich
     damit erledigt. */
  ersatz = null;
  lageVergessen();
  await warmUpModels();
  console.log(`[ai] Anbieter gewechselt auf "${aktiv.name}"${aktiv.model ? ` (${aktiv.model})` : ''}.`);
}

export function assistant(): AssistantProvider | null {
  return provider instanceof OpenAICompatibleProvider ? provider : null;
}

/**
 * Übersetzungen wegwerfen, die ein anderer Provider erzeugt hat.
 * Typischer Fall: Die App lief erst ohne Schlüssel mit dem Demo-Provider,
 * dann wurde ein Groq-Schlüssel eingetragen. Ohne das hier bliebe der
 * unübersetzte Demo-Text für immer stehen.
 */
export function dropForeignTranslations(): void {
  const veraltet = db.run('DELETE FROM message_translations WHERE provider <> ?', provider.name);
  const phrasen = db.run('DELETE FROM translation_memory WHERE provider <> ?', provider.name);
  if (veraltet.changes || phrasen.changes) {
    console.log(
      `[translate] ${veraltet.changes} Nachrichten- und ${phrasen.changes} Phrasen-Übersetzungen`
      + ` von einem anderen Anbieter verworfen — sie werden mit "${provider.name}" neu erzeugt.`,
    );
  }
}

/** Modell-Liste beim Anbieter holen, damit die Auswahl aktuell ist. */
/**
 * Die gespeicherte Anbieterwahl übernehmen — beim Start, bevor gebaut wird.
 *
 * Ohne diesen Schritt gälte nach jedem Neustart wieder das, was in der
 * Umgebung steht, und die Einstellung wäre nur bis zum Neustart wirksam.
 */
export async function anbieterAusEinstellungen(): Promise<void> {
  const gewaehlt = getSetting(SETTING_AI_PROVIDER) as AiProvider | null;
  laufzeitSetzen({
    anbieter: gewaehlt,
    baseUrl: getSetting(SETTING_LOCAL_URL) ?? '',
    model: getSetting(SETTING_LOCAL_MODEL) ?? '',
    fastModel: getSetting(SETTING_LOCAL_FAST) ?? '',
  });
  if (gewaehlt && gewaehlt !== config.ai.provider) await providerNeuAufbauen();
}

/**
 * Anbieter umstellen und dauerhaft merken.
 * Ein leerer Wert heißt: wieder das nehmen, was in der Umgebung steht.
 */
export async function anbieterWaehlen(input: {
  anbieter: AiProvider | null; baseUrl?: string; model?: string; fastModel?: string; userId: string;
}): Promise<void> {
  setSetting(SETTING_AI_PROVIDER, input.anbieter, input.userId);
  if (input.baseUrl !== undefined) setSetting(SETTING_LOCAL_URL, input.baseUrl || null, input.userId);
  if (input.model !== undefined) setSetting(SETTING_LOCAL_MODEL, input.model || null, input.userId);
  if (input.fastModel !== undefined) setSetting(SETTING_LOCAL_FAST, input.fastModel || null, input.userId);

  laufzeitSetzen({
    anbieter: input.anbieter,
    baseUrl: input.baseUrl ?? '',
    model: input.model ?? '',
    fastModel: input.fastModel ?? '',
  });
  await providerNeuAufbauen();
}

/**
 * Erreichbarkeit eines lokalen Dienstes prüfen, ohne etwas umzustellen.
 * Damit man in den Einstellungen sieht, ob die Adresse stimmt und welche
 * Modelle dort geladen sind — vor dem Umschalten, nicht danach.
 */
export async function lokalePruefung(baseUrl: string): Promise<{
  erreichbar: boolean; modelle: string[]; fehler: string | null;
}> {
  return modelleAbfragen(baseUrl);
}

export async function warmUpModels(): Promise<void> {
  // Damit die Konsole gleich nach dem Start sagen kann, ob jemand antwortet.
  void lokaleLage();
  if (!(provider instanceof OpenAICompatibleProvider)) return;
  await provider.registry.refresh();
  // Von Hand gewählte Modelle haben Vorrang vor der automatischen Auswahl.
  provider.registry.applyManualChoice(getSetting(SETTING_MODEL_QUALITY), getSetting(SETTING_MODEL_FAST));
  provider.registry.startAutoRefresh();
}

/**
 * Modell von Hand festlegen. null für beide Werte schaltet zurück auf
 * automatische Auswahl. Wird dauerhaft gespeichert.
 */
export function chooseModels(quality: string | null, fast: string | null, userId: string): void {
  setSetting(SETTING_MODEL_QUALITY, quality, userId);
  setSetting(SETTING_MODEL_FAST, fast, userId);
  modelRegistry()?.applyManualChoice(quality, fast);
}

/**
 * Kann jemand Sprachnachrichten abtippen, und auf welchem Weg?
 *
 * Das hängt nicht am gewählten Textmodell: Ollama und llama.cpp können kein
 * Whisper, und das lokale Textmodell darf auf einer ganz anderen Maschine
 * liegen. Gefragt sind deshalb zwei andere Dinge — läuft nebenan ein
 * Sprachdienst, und liegt ein Groq-Schlüssel vor.
 *
 * Der lokale Weg hat Vorrang. Die Begründung steht in services/voice.ts.
 */
export function transcriptionWeg(): 'lokal' | 'groq' | null {
  if (stimme.bekanntErreichbar()) return 'lokal';
  if (config.ai.groq.apiKey) return 'groq';
  return null;
}

export function transcriptionAvailable(): boolean {
  return transcriptionWeg() !== null;
}

/** Womit abgetippt wird — der lokale Dienst oder das beste Whisper bei Groq. */
export function transcriptionModel(): string | null {
  if (transcriptionWeg() === 'lokal') return config.ai.stimme.modell || 'whisper';
  if (transcriptionWeg() !== 'groq') return null;
  const whisper = modelRegistry()?.discovered.filter((m) => /whisper/i.test(m.id)) ?? [];
  if (!whisper.length) return 'whisper-large-v3-turbo';
  // "turbo" ist deutlich schneller und für Chat-Länge genau genug.
  return whisper.find((m) => /turbo/i.test(m.id))?.id ?? whisper[0].id;
}

export function modelRegistry() {
  return provider instanceof OpenAICompatibleProvider ? provider.registry : null;
}

export function aiCapabilities() {
  const a = assistant();
  const registry = modelRegistry();
  const selection = registry?.current ?? null;

  /* null heißt: kein lokales Modell, also nichts zu prüfen. Steht noch kein
     Ergebnis, wird im Hintergrund nachgesehen und bis dahin nichts
     behauptet — ein „aus" beim Hochfahren wäre genauso falsch wie das
     dauerhafte „an" von vorher. */
  const lage = lokaleLage();
  const lokalAntwortet = !lage || lage.zustand === 'erreichbar';

  return {
    provider: provider.name,
    model: provider.model,
    fastModel: provider instanceof OpenAICompatibleProvider ? provider.fastModel : null,
    modelSource: selection?.source ?? null,
    modelsAvailable: registry ? registry.usable.length || null : null,
    transcription: transcriptionAvailable(),
    transcriptionModel: transcriptionModel(),
    /* Damit in den Einstellungen nicht nur steht, *dass* abgetippt wird,
       sondern auch *wo*. Bei einem lokalen Textmodell ist das der Unterschied
       zwischen „nichts verlässt das Haus" und dem Gegenteil. */
    transcriptionLokal: transcriptionWeg() === 'lokal',
    /* Hing bisher allein am eingestellten Anbieter und war damit für ein
       lokales Modell immer wahr — auch wenn der Rechner schlief. Jetzt hängt
       es an einer tatsächlichen Antwort. */
    translation: provider.name !== 'demo' && lokalAntwortet,
    assistant: a !== null,
    /* Direkt aus den Einstellungen statt über den Vorschlagsdienst: der
       importiert die Übersetzung, und ein Ring aus zwei Modulen bricht beim
       Laden an der Stelle, an der man ihn am wenigsten erwartet. */
    selbstEintragen: getSetting('ki_traegt_ein') === 'an',
    /* Springt gerade ein anderer Dienst ein, weil das eigene Modell schweigt?
       Ohne diese Auskunft wundert man sich über plötzlich andere Antworten —
       und übersieht, dass der eigene Rechner aus ist. */
    vertretung: ersatzLaeuft(),
    lokal: istLokal(),
    lokaleAdresse: istLokal() ? lokaleEinstellung().baseUrl : null,
    lokalerZustand: lage?.zustand ?? null,
    lokaleModelle: lage?.modelle ?? null,
    lokalerFehler: lage?.fehler ?? null,
    lokalGeprueftAm: lage?.geprueftAm ?? null,
    lokalErfolgAm: lage?.letzterErfolgAm ?? null,
    ...hinweis(lage),
  };
}

/**
 * Der Hinweis unter „Übersetzungs-Dienst" in den Einstellungen.
 *
 * Er geht als Kennung hinaus, nicht als Satz: der deutsche Text daneben ist
 * nur der Rückfall für ältere Clients. Vorher stand hier fester deutscher
 * Text — und den las jede Person, egal welche Sprache sie eingestellt hatte.
 */
function hinweis(lage: LokaleLage | null): Pick<AiCapabilities, 'note' | 'noteCode' | 'noteWerte'> {
  const a = assistant();
  const leer = { note: null, noteCode: null, noteWerte: null };

  /* Zuerst, weil es alles andere aufhebt: steht das Modell nicht zur
     Verfügung, nützt der beste Schlüssel nichts. */
  if (lage && lage.zustand === 'antwortet-nicht') {
    return {
      noteCode: 'hinweis.lokalStumm',
      noteWerte: { adresse: lokaleEinstellung().baseUrl, fehler: lage.fehler ?? '—' },
      note: `Das Modell unter ${lokaleEinstellung().baseUrl} antwortet nicht `
        + `(${lage.fehler ?? 'keine Antwort'}). Nachrichten bleiben unübersetzt, bis es wieder läuft.`,
    };
  }
  if (lage && lage.zustand === 'kein-modell') {
    return {
      noteCode: 'hinweis.lokalOhneModell', noteWerte: { adresse: lokaleEinstellung().baseUrl },
      note: `Unter ${lokaleEinstellung().baseUrl} ist kein Modell geladen. `
        + 'Dort eines starten, sonst bleibt alles unübersetzt.',
    };
  }

  if (provider.name === 'demo') {
    return {
      noteCode: 'hinweis.keinSchluessel', noteWerte: null,
      note: 'Kein API-Schlüssel gesetzt. Trage GROQ_API_KEY in die .env ein oder stelle auf ein lokales Modell um.',
    };
  }
  if (a === null) {
    return {
      noteCode: 'hinweis.keinAssistent', noteWerte: { anbieter: provider.name },
      note: `${provider.name} übersetzt, kann aber keine KI-Zusammenfassungen. Für alle Funktionen Groq, OpenAI oder ein lokales Modell wählen.`,
    };
  }
  if (!transcriptionAvailable()) {
    return {
      noteCode: 'hinweis.keinAbtippen', noteWerte: null,
      note: 'Sprachnachrichten werden nicht abgetippt. Dafür bräuchte es den Sprachdienst auf dem Server '
        + '(server-setup/dienste/stimme-einrichten.sh) oder einen Groq-Schlüssel.',
    };
  }
  if (istLokal() && transcriptionWeg() === 'groq') {
    return {
      noteCode: 'hinweis.stimmeBeiGroq', noteWerte: null,
      note: 'Das Textmodell läuft im eigenen Netz, Sprachnachrichten gehen aber an Groq. '
        + 'Mit server-setup/dienste/stimme-einrichten.sh bleiben auch sie hier.',
    };
  }
  return leer;
}

/* ── Glossar ──────────────────────────────────────────────────── */

interface GlossaryRow { id: string; term: string; translations: string | null; case_sensitive: number }

let glossaryCache: { rows: GlossaryRow[]; at: number } | null = null;
const GLOSSARY_TTL = 30_000;

function glossary(): GlossaryRow[] {
  if (glossaryCache && Date.now() - glossaryCache.at < GLOSSARY_TTL) return glossaryCache.rows;
  const rows = db.all<GlossaryRow>('SELECT id, term, translations, case_sensitive FROM glossary');
  glossaryCache = { rows, at: Date.now() };
  return rows;
}

export function invalidateGlossary(): void { glossaryCache = null; }

/** Begriffe ohne Zielübersetzung werden maskiert, der Rest als Vorgabe mitgegeben. */
function glossaryFor(targetLang: string): { protectedTerms: string[]; mapping: Record<string, string> } {
  const protectedTerms: string[] = [];
  const mapping: Record<string, string> = {};
  for (const row of glossary()) {
    if (!row.translations) { protectedTerms.push(row.term); continue; }
    try {
      const map = JSON.parse(row.translations) as Record<string, string>;
      const hit = map[targetLang];
      if (hit) mapping[row.term] = hit;
      else protectedTerms.push(row.term);
    } catch {
      protectedTerms.push(row.term);
    }
  }
  return { protectedTerms, mapping };
}

/* ── Caches ───────────────────────────────────────────────────── */

class Lru<T> {
  private map = new Map<string, T>();
  constructor(private limit: number) {}
  get(k: string): T | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: string, v: T): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
  }
}

/*
 * Kurzes Gedächtnis für Texte, die das Modell unverändert zurückgab.
 *
 * Ein Echo darf NICHT dauerhaft gemerkt werden — dann bekäme dieser Text nie
 * wieder eine Chance, und genau das hat bis 1.0.26 Übersetzungen dauerhaft
 * ausfallen lassen. Es darf aber auch nicht bei jeder Anfrage neu versucht
 * werden: nach dem Fix gingen dieselben sechs Texte bei JEDEM Aufruf zweimal
 * ans Modell (Anlauf und Nachfassen), im Protokoll gemessen. Aus „dauerhaft
 * falsch" war „dauerhaft teuer" geworden.
 *
 * Deshalb ein Merker mit Verfall: eine Viertelstunde nicht noch einmal
 * fragen, danach wieder. Nur im Arbeitsspeicher, nicht in der Datenbank —
 * ein Neustart soll jedem Text wieder eine Chance geben.
 */
const ECHO_FRIST_MS = 15 * 60_000;
const echoNotiz = new Map<string, number>();

function echoGemerkt(key: string): boolean {
  const seit = echoNotiz.get(key);
  if (seit === undefined) return false;
  if (Date.now() - seit < ECHO_FRIST_MS) return true;
  echoNotiz.delete(key);
  return false;
}

function echoMerken(key: string): void {
  /* Notbremse gegen unbegrenztes Wachsen: bei vielen verschiedenen Texten
     würde die Karte sonst mitwachsen, ohne dass je jemand aufräumt. */
  if (echoNotiz.size > 2000) echoNotiz.clear();
  echoNotiz.set(key, Date.now());
}

const memory = new Lru<{ text: string; provider: string; model: string | null; confidence: number | null }>(
  config.ai.memoryCacheSize,
);

/**
 * Der Provider gehört in den Schlüssel: sonst liefert der Cache nach einem
 * Wechsel von demo auf groq weiter die alten, nicht übersetzten Ergebnisse.
 */
/* Der Schlüsselwert darf den Text nicht preisgeben — siehe abdruck(). */
const tmKey = (src: string, tgt: string, text: string) =>
  abdruck(`${provider.name}|${src}|${tgt}|${text}`);

/* ── Kernfunktion ─────────────────────────────────────────────── */

export interface TranslateOptions {
  text: string;
  targetLang: string;
  sourceLang?: string | null;
  context?: string | null;
  /** Cache überspringen (z.B. für den Round-Trip-Check). */
  skipCache?: boolean;
  /**
   * Maßangaben (25 °C, 10 kg, 5 km, …) als Sentinel im Ergebnis stehen
   * lassen, statt sie unverändert im Ausgangswortlaut zu belassen — siehe
   * messwerteMaskieren() unten und einheiten.ts. Nur von translateMessage()
   * gesetzt: Umfragen, Kanalnamen und der Rückübersetzungs-Check
   * (roundTrip()) laufen bewusst ohne, damit dort nie ein ungelöster
   * Sentinel stehen bleiben kann — es ruft dort niemand
   * messwerteFuerEmpfaenger() ab, der ihn wieder auflösen würde.
   */
  messwerte?: boolean;
}

export interface TranslateOutcome {
  text: string;
  sourceLang: string;
  provider: string;
  model: string | null;
  confidence: number | null;
  cached: boolean;
  /** true, wenn Ausgangs- und Zielsprache gleich sind — nichts zu tun. */
  noop: boolean;
  /**
   * true, wenn das Modell zwar geantwortet hat, aber mit dem Eingabetext.
   * `text` trägt dann das Original: unübersetzt, und das soll man sehen.
   */
  unuebersetzt: boolean;
  /**
   * Der Schlüssel in translation_memory, den dieses Ergebnis gerade trägt —
   * null, wenn nichts im Satz-Cache stand oder landete (noop, unübersetzt,
   * Echo). Der Aufrufer (translateMessage) verknüpft ihn mit der jeweiligen
   * message_translations-Zeile, damit tmVerweiseNachrechnen() später weiß,
   * welche Phrase noch gebraucht wird und welche nicht mehr.
   */
  memoryKey: string | null;
  /** Siehe TranslationView.measurements — nur gefüllt, wenn opts.messwerte
   *  gesetzt war UND der Text mindestens eine Maßangabe enthielt. */
  measurements?: Record<number, Messwert>;
}

/**
 * Bereits erkannte Maßangaben (siehe einheiten.ts, Positionen bezogen auf
 * `masked` — also NACH Code/Link/Mention/Glossar-Maskierung, damit eine Zahl
 * mitten in einem Codeblock nie mit angefasst wird) zusätzlich wie Code/
 * Links maskieren: genau dieselbe {{n}}-Maschinerie, damit das Sprachmodell
 * sie nie zu Gesicht bekommt. Rückwärts eingesetzt, damit die start/end-
 * Positionen der noch ausstehenden Treffer gültig bleiben.
 *
 * Die Sentinel-Nummerierung (⟦m0⟧, ⟦m1⟧, …) folgt NICHT dem {{n}}-Index
 * (der hängt auch davon ab, wie viel Code/Links/Mentions daneben stehen),
 * sondern schlicht der Position von `funde` — dieselbe Reihenfolge, die eine
 * erneute findMeasurements() auf demselben Text jederzeit reproduzieren
 * kann. Das ist der Grund, warum translateMessage() im Direkttreffer-Zweig
 * (Cache-Zeile ohne LLM-Aufruf) die Sentinel-Zuordnung einfach neu
 * berechnen darf, statt sie mitzuspeichern.
 */
function messwerteMaskieren(
  masked: string, tokens: string[], funde: Messwert[],
): { masked: string; measurementTokens: Map<number, Messwert> } {
  const measurementTokens = new Map<number, Messwert>();
  let out = masked;
  for (const m of [...funde].sort((a, b) => b.start - a.start)) {
    const idx = tokens.length;
    tokens.push(m.rohtext);
    measurementTokens.set(idx, m);
    out = out.slice(0, m.start) + PLACEHOLDER(idx) + out.slice(m.end);
  }
  return { masked: out, measurementTokens };
}

export async function translate(opts: TranslateOptions): Promise<TranslateOutcome> {
  const target = normalizeLang(opts.targetLang);
  const detected = opts.sourceLang ? normalizeLang(opts.sourceLang) : detectLanguage(opts.text).lang;
  const source = detected === 'unknown' ? 'en' : detected;

  const base = {
    sourceLang: source, provider: provider.name, model: provider.model,
    confidence: null as number | null, cached: false, noop: false, unuebersetzt: false,
  };

  const { protectedTerms, mapping } = glossaryFor(target);
  const { masked: maskedOhneMesswerte, tokens } = maskText(opts.text, { protectedTerms });

  /* Maßangaben auf dem BEREITS maskierten Text suchen (siehe Kommentar an
     messwerteMaskieren) und dieselbe Sentinel-Ersetzung schon hier bereit-
     stellen — für jeden Rückgabepfad unten, der gar nicht erst übersetzt
     (schon Zielsprache, nichts Übersetzbares, Modell nicht erreichbar,
     Fehler, Echo). Ohne das bekäme eine Empfängerin ihre eigene Einheit nur
     dann, wenn tatsächlich übersetzt wurde — bei zwei Leuten mit derselben
     Zielsprache (z. B. zwei „en"-Konten, eins in Denver, eins in London) ist
     das aber gerade der HÄUFIGE Fall: source === target, nichts zu tun außer
     der Maßangabe. */
  const gefundeneMesswerte = opts.messwerte ? findMeasurements(maskedOhneMesswerte) : [];
  const { masked, measurementTokens } = gefundeneMesswerte.length
    ? messwerteMaskieren(maskedOhneMesswerte, tokens, gefundeneMesswerte)
    : { masked: maskedOhneMesswerte, measurementTokens: new Map<number, Messwert>() };
  const messwertIndex = new Map(gefundeneMesswerte.map((m, i) => [m, i] as const));
  const messwerteRecord = gefundeneMesswerte.length
    ? Object.fromEntries(gefundeneMesswerte.map((m, i) => [i, m])) : undefined;
  /** Sentinel statt Rohtext für jede erkannte Maßangabe, alles andere unverändert. */
  const mitMesswertSentinels = (text: string) => unmaskText(text, tokens, (idx, roh) => {
    const mw = measurementTokens.get(idx);
    return mw ? messwertPlatzhalter(messwertIndex.get(mw)!) : roh;
  });
  const mitSentinels = mitMesswertSentinels(masked);

  if (source === target) {
    return { ...base, text: mitSentinels, noop: true, confidence: 1, memoryKey: null, measurements: messwerteRecord };
  }

  // Reiner Code / nur Links / nur Emojis -> nichts Übersetzbares übrig.
  if (translatableLength(masked) === 0) {
    return { ...base, text: mitSentinels, noop: true, confidence: 1, memoryKey: null, measurements: messwerteRecord };
  }

  const key = tmKey(source, target, masked);

  /**
   * Gemeinsamer Ausgang für alle Wege — frisch übersetzt wie aus dem Cache.
   *
   * Hier fällt die Entscheidung, ob am Ende wirklich eine Übersetzung steht.
   * Kommt der Eingabetext zurück, wird er als Original ausgegeben und nicht
   * als Übersetzung ausgegeben: lieber sichtbar unübersetzt als falsch
   * beschriftet.
   */
  const fertig = (
    uebersetzt: string,
    zusatz: {
      provider: string; model: string | null; confidence: number | null;
      cached: boolean; sourceLang?: string;
      /** Nur setzen, wenn dieser Aufruf wirklich einen Cache-Treffer oder
          einen frischen Eintrag in translation_memory abbildet — siehe die
          beiden Echo-Zweige unten, die absichtlich keinen mitgeben. */
      memoryKey?: string | null;
    },
  ): TranslateOutcome => {
    if (istEcho(masked, uebersetzt)) {
      /*
       * Zwei sehr verschiedene Fälle sehen hier gleich aus, und sie
       * auseinanderzuhalten ist der Sinn dieser Zeilen.
       *
       * Steht die erkannte Ausgangssprache bereits auf der Zielsprache, ist
       * ein unveränderter Text die RICHTIGE Antwort — es gibt nichts zu
       * übersetzen. Das trifft ständig zu: der Assistent antwortet auf
       * Deutsch, die Kanalsprache ist Englisch, und dann läuft eine
       * Anfrage en → de über einen Text, der schon Deutsch ist.
       *
       * Vorher stand für beide Fälle derselbe Satz im Protokoll — „gab den
       * Eingabetext zurück statt ihn zu übersetzen". Der liest sich wie ein
       * Fehlschlag des Modells und ist meistens keiner. Er hat mich am
       * 22.08.2026 durch eine halbe Fehlersuche geschickt: Endpunkt
       * geprüft, Modell geprüft, Anweisung nachgestellt — alles in Ordnung,
       * und die Meldung meinte von Anfang an etwas anderes.
       */
      const schonZiel = (zusatz.sourceLang ?? source) === target;
      console.warn(
        schonZiel
          ? `[translate] ${provider.name}: nichts zu übersetzen — Text ist bereits ${target}`
            + ` (${masked.length} Zeichen).`
          : `[translate] ${provider.name} gab den Eingabetext zurück statt ihn zu übersetzen`
            + ` (${zusatz.sourceLang ?? source} → ${target}, ${masked.length} Zeichen,`
            + ` ${Math.round(wortAehnlichkeit(masked, uebersetzt) * 100)} % Übereinstimmung)`
            + ' — wird als unübersetzt gekennzeichnet.',
      );
      // Ein Echo landet nie im Satz-Cache (siehe weiter unten) — memoryKey
      // deshalb hier zwingend null, auch falls zusatz versehentlich einen trüge.
      return {
        ...base, ...zusatz, text: mitSentinels, noop: true, unuebersetzt: true, confidence: 0,
        memoryKey: null, measurements: messwerteRecord,
      };
    }
    return {
      ...base, ...zusatz, text: mitMesswertSentinels(uebersetzt),
      measurements: messwerteRecord, memoryKey: zusatz.memoryKey ?? null,
    };
  };

  if (!opts.skipCache) {
    const hot = memory.get(key);
    if (hot) {
      return fertig(hot.text, {
        provider: hot.provider, model: hot.model, confidence: hot.confidence, cached: true, memoryKey: key,
      });
    }

    const row = db.get<{ target_text: string; provider: string }>(
      'SELECT target_text, provider FROM translation_memory WHERE key = ?', key,
    );
    if (row) {
      db.run('UPDATE translation_memory SET hits = hits + 1 WHERE key = ?', key);
      const entry = {
        text: entschluesseln(row.target_text), provider: row.provider,
        model: provider.model, confidence: 0.9,
      };
      memory.set(key, entry);
      return fertig(entry.text, {
        provider: entry.provider, model: entry.model, confidence: entry.confidence, cached: true, memoryKey: key,
      });
    }
  }

  /* Vor einer Minute schon einmal unübersetzbar gewesen? Dann nicht noch
     einmal fragen — das kostete zwei Modellaufrufe für dasselbe Ergebnis.
     `skipCache` (also eine ausdrücklich erzwungene Übersetzung) hebt den
     Merker auf: wer von Hand nachfordert, soll einen echten neuen Versuch
     bekommen. */
  if (!opts.skipCache && echoGemerkt(key)) {
    return {
      ...base, text: mitSentinels, confidence: 0, noop: true, unuebersetzt: true,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  /* Erst nachsehen, ob überhaupt jemand da ist. Ein Modell im eigenen Netz
     läuft auf einem Rechner, der auch mal aus ist — ohne diesen Test liefe
     jede Nachricht in drei Versuche à 25 Sekunden, und bei mehreren
     Zielsprachen steht der Betrieb. Der Test steht bewusst hinter den
     Zwischenspeichern: was schon übersetzt ist, soll auch dann ankommen,
     wenn gerade niemand antwortet. */
  const lage = await lokaleLageJetzt();
  if (lage && lage.zustand !== 'erreichbar') {
    console.warn(
      `[translate] ${lokaleEinstellung().baseUrl}: ${lage.fehler ?? 'antwortet nicht'}`
      + ' — nicht übersetzt, wird beim nächsten Mal erneut versucht.',
    );
    return {
      ...base, text: mitSentinels, confidence: 0, noop: true, unuebersetzt: true,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  const anfrage = {
    text: masked,
    targetLang: target,
    sourceLang: source,
    context: opts.context ?? null,
    glossary: mapping,
  };

  let result;
  try {
    result = await withRetry(() => provider.translate(anfrage));
    // Wer antwortet, ist erreichbar — billiger als jede weitere Nachfrage.
    erfolgMelden();

    /* Der Eingabetext kam zurück — einmal mit deutlicherer Anweisung
       nachfassen. Ein zweiter Versuch mit demselben Prompt wäre sinnlos:
       bei temperature 0 antwortet das Modell Wort für Wort dasselbe,
       dreimal von drei Läufen gemessen.

       Nicht nachgefasst wird, wenn das Modell selbst sagt, der Text stehe
       schon in der Zielsprache: dann ist die unveränderte Rückgabe richtig
       und Nachdruck würde eine Übersetzung erzwingen, die keine ist. */
    const erkannt = result.detectedSourceLang ? normalizeLang(result.detectedSourceLang) : source;
    if (erkannt !== target && istEcho(masked, result.text)) {
      const zweiter = await withRetry(() => provider.translate({ ...anfrage, nachdruck: true }))
        .catch((err) => {
          console.warn('[translate] Nachfassen fehlgeschlagen:', (err as Error).message);
          return null;
        });
      if (zweiter && !istEcho(masked, zweiter.text)) result = zweiter;
    }
  } catch (err) {
    /* Bei einem Modell im eigenen Netz gehört die Adresse dazu. Sonst steht im
       Journal nur „fetch failed", und die häufigste Ursache — der Rechner mit
       dem Modell ist aus oder aus dem Tailscale-Netz gefallen — sieht genauso
       aus wie jeder andere Fehler. */
    const wo = istLokal() ? ` (${lokaleEinstellung().baseUrl})` : '';
    console.error(`[translate]${wo}`, (err as Error).message);

    /* Kam gar keine Antwort — Verbindung abgelehnt oder Zeitüberschreitung —,
       dann sofort merken. Sonst liefe die nächste Nachricht noch einmal in
       die volle Wartezeit, obwohl längst feststeht, dass niemand da ist.
       Ein 400er oder 429er sagt dagegen nichts über die Erreichbarkeit. */
    const status = err instanceof ProviderError ? err.status : undefined;
    if (status === undefined || status === 408) ausfallMelden((err as Error).message);
    // Lieber das Original zeigen als gar nichts.
    return {
      ...base, text: mitSentinels, confidence: 0, noop: true, unuebersetzt: true,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  const out = result.text;
  if (!placeholdersIntact(masked, out)) {
    // Modell hat Platzhalter verschluckt — Original zurückgeben statt Kauderwelsch.
    console.warn('[translate] Platzhalter beschädigt, nutze Original');
    return {
      ...base, text: mitSentinels, confidence: 0, noop: true, unuebersetzt: true,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  const finalSource = result.detectedSourceLang ? normalizeLang(result.detectedSourceLang) : source;
  if (finalSource === target) {
    return {
      ...base, sourceLang: finalSource, text: mitSentinels, noop: true, confidence: 1,
      memoryKey: null, measurements: messwerteRecord,
    };
  }

  const entry = { text: out, provider: provider.name, model: result.model, confidence: result.confidence };

  /*
   * Ein Echo darf NICHT in den Zwischenspeicher.
   *
   * Hier lagen `memory.set` und der Datenbank-Eintrag vor `fertig(...)` — und
   * erst dort wird geprüft, ob überhaupt übersetzt wurde. Ein Text, den das
   * Modell unverändert zurückgab, landete damit als gültige Übersetzung im
   * Speicher. Von da an war er **dauerhaft** unübersetzt: jeder spätere
   * Treffer kam aus dem Speicher, meldete die Warnung und bekam nie wieder
   * eine Chance — obwohl das Nachfassen bei Temperatur 0,4 beim nächsten
   * Anlauf sehr wahrscheinlich gelungen wäre.
   *
   * Gemessen am 22.08.2026: 356 Meldungen „gab den Eingabetext zurück" in 24
   * Stunden, dabei KEIN einziges gescheitertes Nachfassen. Am laufenden
   * Modell gemessen echot der erste Anlauf bei 10 von 27 Texten (37 %), nach
   * dem Nachfassen bei 0 von 27. Die Zahlen passten nicht zusammen — bis auf
   * diese Reihenfolge.
   *
   * Lieber jedes Mal neu fragen als einmal falsch merken: ein Fehlversuch
   * kostet eine Anfrage, ein gemerkter Fehlversuch kostet die Übersetzung
   * für immer.
   */
  if (istEcho(masked, out)) {
    echoMerken(key);
    return fertig(out, {
      provider: entry.provider, model: entry.model, confidence: entry.confidence,
      cached: false, sourceLang: finalSource,
    });
  }

  memory.set(key, entry);
  db.run(
    `INSERT INTO translation_memory (key, source_lang, target_lang, source_text, target_text, provider, hits, created_at)
     VALUES (?,?,?,?,?,?,1,?)
     ON CONFLICT(key) DO UPDATE SET hits = hits + 1`,
    /* Auch hier verschlüsselt.
       Dieser Zwischenspeicher lag als einziger Ort noch im Klartext: Quelle
       und Übersetzung jeder je übersetzten Nachricht, sauber nebeneinander.
       Wer die Datenbankdatei hat, hätte damit ganze Gespräche lesen können,
       obwohl die Nachrichtentabelle selbst verschlüsselt ist. */
    key, finalSource, target, verschluesseln(masked), verschluesseln(out), provider.name, Date.now(),
  );

  return fertig(out, {
    provider: entry.provider, model: entry.model, confidence: entry.confidence,
    cached: false, sourceLang: finalSource, memoryKey: key,
  });
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof ProviderError ? err.retryable : false;
      if (!retryable || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 350 * 2 ** i + Math.random() * 200));
    }
  }
  throw lastErr;
}

/* ── Nachrichten-Übersetzung mit persistentem Cache ───────────── */

interface MessageRow {
  id: string; channel_id: string; user_id: string; text: string; source_lang: string | null; deleted_at: number | null;
}

/**
 * Ausgangssprache, mit der eine Übersetzung tatsächlich anläuft, wenn die
 * Nachricht selbst keine feststehende trägt (`source_lang` ist dann null —
 * siehe messages.ts, dieselbe 0,35-Schwelle).
 *
 * Die Heuristik allein reicht bei kurzen Antworten nicht: „ok", „vale" oder
 * „ya" fallen für sie überzeugend auf eine andere Sprache, obwohl es Wörter
 * sind, die mehrere Sprachen teilen oder die dort zufällig eindeutig
 * scheinen. Drei Wörter oder weniger ist dieselbe Grenze, unter der auch die
 * Echo-Prüfung nichts mehr beurteilt (ECHO_MIN_WOERTER in echo.ts) — darunter
 * kippt ein einziger Treffer die Konfidenz, ohne dass genug Text für einen
 * echten Anhaltspunkt da wäre.
 *
 * Unterhalb der Wort- oder der Sicherheitsgrenze zählt die Sprache, die diese
 * Person sich selbst eingestellt hat, mehr als ein einzelnes mehrdeutiges
 * Wort: Wer sein Konto auf Englisch führt, schreibt ein kurzes „ok" nicht
 * plötzlich auf Spanisch. Das Ergebnis fließt weiter in `translate()` als
 * `source` und wird bei Erfolg auch in die Nachricht zurückgeschrieben (siehe
 * unten) — ein besserer erster Wert hier verbessert also auch das, was
 * dauerhaft in der Datenbank landet.
 */
/**
 * Für jeden Ort, der eine Zeile aus message_translations OHNE Umweg über
 * translate()/translateMessage() liest — hier für den Direkttreffer unten,
 * genauso gebraucht von ws/gateway.ts: fillCachedTranslations() dort liest
 * dieselbe Tabelle über eine EIGENE SQL-Abfrage (siehe Bericht) und braucht
 * darum dieselbe Nachbildung der Sentinel-Nummerierung. Exportiert genau
 * dafür — ws/gateway.ts ist für diese Änderung gerade gesperrt, die Stelle
 * ist beschrieben statt gesetzt.
 *
 * Liefert dieselbe Sentinel-Nummerierung wie ein frischer translate()-
 * Aufruf, aber ohne dessen ganze Maschinerie — nur Erkennung, kein LLM-
 * Aufruf nötig. Funktioniert, weil findMeasurements() rein und
 * deterministisch ist: derselbe (glossar-maskierte) Text liefert immer
 * dieselben Treffer in derselben Reihenfolge, egal ob heute oder beim
 * ursprünglichen Entstehen der Cache-Zeile.
 */
export function messwerteRecordFuer(text: string, targetLang: string): Record<number, Messwert> | undefined {
  const { protectedTerms } = glossaryFor(targetLang);
  const { masked } = maskText(text, { protectedTerms });
  const funde = findMeasurements(masked);
  return funde.length ? Object.fromEntries(funde.map((m, i) => [i, m])) : undefined;
}

function quellspracheSchaetzen(text: string, userId: string): string {
  const erkannt = detectLanguage(text);
  const genugText = woerter(text).length >= ECHO_MIN_WOERTER;
  if (erkannt.lang !== 'unknown' && erkannt.confidence >= 0.35 && genugText) {
    return erkannt.lang;
  }
  const eigene = db.get<{ language: string }>('SELECT language FROM users WHERE id = ?', userId)?.language;
  return eigene ? normalizeLang(eigene) : (erkannt.lang !== 'unknown' ? erkannt.lang : 'en');
}

export async function translateMessage(
  messageId: string,
  targetLang: string,
  opts: { force?: boolean; context?: string | null } = {},
): Promise<TranslationView | null> {
  const target = normalizeLang(targetLang);
  const roh = db.get<MessageRow>(
    'SELECT id, channel_id, user_id, text, source_lang, deleted_at FROM messages WHERE id = ?', messageId,
  );
  if (!roh || roh.deleted_at) return null;
  // In der Tabelle liegt nur das Chiffrat — ab hier wird mit Klartext gearbeitet.
  const msg = { ...roh, text: entschluesseln(roh.text) };

  const hash = sha1(msg.text);

  if (!opts.force) {
    const cached = db.get<{ text: string; provider: string; model: string | null; confidence: number | null; source_hash: string }>(
      'SELECT text, provider, model, confidence, source_hash FROM message_translations WHERE message_id = ? AND lang = ?',
      messageId, target,
    );
    // Nur gültig, wenn Text UND Provider noch dieselben sind. Sonst zeigt die
    // App nach einem Providerwechsel ewig die alten Ergebnisse an.
    if (cached && cached.source_hash === hash && cached.provider === provider.name) {
      return {
        lang: target, text: entschluesseln(cached.text), provider: cached.provider, model: cached.model,
        confidence: cached.confidence, cached: true, measurements: messwerteRecordFuer(msg.text, target),
      };
    }
  }

  const outcome = await translate({
    text: msg.text,
    targetLang: target,
    sourceLang: msg.source_lang ?? quellspracheSchaetzen(msg.text, msg.user_id),
    context: opts.context ?? null,
    skipCache: opts.force,
    messwerte: true,
  });

  // Hat das Modell die Ausgangssprache bestimmt, wo wir unsicher waren?
  // Dann festhalten — davon profitieren alle weiteren Empfänger und die Suche.
  if (!msg.source_lang && outcome.sourceLang && outcome.sourceLang !== 'unknown') {
    db.run('UPDATE messages SET source_lang = ? WHERE id = ?', outcome.sourceLang, messageId);
  }

  /* Es kam eine Antwort, aber keine Übersetzung — der Eingabetext, ein
     zerschossener Platzhalter oder ein Fehler beim Anbieter. Nichts
     speichern: die Nachricht bleibt unübersetzt stehen. Der Vermerk geht
     trotzdem hinaus, damit die Oberfläche „Original in Englisch" schreiben
     kann statt „Übersetzt aus Englisch". */
  if (outcome.unuebersetzt) {
    return {
      lang: target, text: outcome.text, provider: outcome.provider, model: outcome.model,
      confidence: 0, cached: outcome.cached, unuebersetzt: true, measurements: outcome.measurements,
    };
  }

  /* "noop" hieß bisher immer: nichts weiterzugeben, der Client zeigt ohnehin
     schon message.text. Das stimmt nicht mehr uneingeschränkt — Ausgangs-
     und Zielsprache können gleich sein (zwei „en"-Konten, eine Nachricht auf
     Englisch) und TROTZDEM eine Maßangabe enthalten, die für genau diese
     Empfängerin noch in ihre Einheit übersetzt werden muss (25 °C bleibt
     Englisch -> Englisch, aber für Denver trotzdem 77 °F). Ohne diese
     Ausnahme bekäme so ein Fall nie eine TranslationView — und der Sentinel
     aus messwerteMaskieren() hätte nie eine Chance, aufgelöst zu werden. */
  if (outcome.noop) {
    if (!outcome.measurements) return null;
    return {
      lang: target, text: outcome.text, provider: outcome.provider, model: outcome.model,
      confidence: outcome.confidence, cached: outcome.cached, measurements: outcome.measurements,
    };
  }

  /* Ersetzt diese Übersetzung eine frühere (Provider gewechselt, erzwungener
     Neuversuch), hing die alte Zeile an einem eigenen Schlüssel in
     translation_memory — den holt niemand mehr, wenn die neue Zeile ihn
     überschreibt. Deshalb vorher lesen, nicht raten. */
  const vorherigerSchluessel = db.get<{ tm_key: string | null }>(
    'SELECT tm_key FROM message_translations WHERE message_id = ? AND lang = ?', messageId, target,
  )?.tm_key ?? null;

  db.run(
    `INSERT INTO message_translations (message_id, lang, text, provider, model, confidence, source_hash, tm_key, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(message_id, lang) DO UPDATE SET
       text = excluded.text, provider = excluded.provider, model = excluded.model,
       confidence = excluded.confidence, source_hash = excluded.source_hash,
       tm_key = excluded.tm_key, created_at = excluded.created_at`,
    messageId, target, verschluesseln(outcome.text), outcome.provider, outcome.model, outcome.confidence,
    hash, outcome.memoryKey, Date.now(),
  );
  reindexMessage(messageId);
  // Alter und neuer Schlüssel können sich dadurch geändert haben, wie viele
  // Nachrichten sie noch halten — siehe tmVerweiseNachrechnen().
  tmVerweiseNachrechnen([vorherigerSchluessel, outcome.memoryKey]);

  return {
    lang: target, text: outcome.text, provider: outcome.provider,
    model: outcome.model, confidence: outcome.confidence, cached: outcome.cached,
    measurements: outcome.measurements,
  };
}

/**
 * DER KNACKPUNKT (siehe Auftrag): message_translations/translation_memory
 * sind pro (Nachricht, Zielsprache) zwischengespeichert — bewusst geteilt
 * zwischen allen Empfänger:innen dieser Sprache, siehe translate()/
 * translateMessage() oben. Zwei Personen mit target=lang="en", eine in
 * Denver, eine in London, bekommen deshalb GENAU dieselbe TranslationView
 * aus dem Cache — mit ⟦m0⟧-Sentinels statt fertiger Zahlen an der Stelle
 * jeder Maßangabe (siehe messwerteMaskieren, einheiten.ts).
 *
 * Diese Funktion ist der einzige Ort, an dem ein Sentinel durch eine
 * fertige, für EINE bestimmte Person passende Zahl ersetzt wird — reine,
 * synchrone Zeichenkettenarbeit, kein Netz- oder Datenbankzugriff, beliebig
 * oft wiederholbar für beliebig viele Empfänger:innen derselben gecachten
 * Übersetzung. `region` kommt aus regionFuerZeitzone(user.timezone), `sprache`
 * aus DEMSELBEN `target`/`lang`, das an dieser Stelle ohnehin schon für
 * translateMessage() gilt (User.language — die Sprache, IN DIE übersetzt
 * wird — NICHT SelfUser.uiLanguage, das nur Menüs/Knöpfe betrifft und mit der
 * Übersetzungssprache auseinanderfallen kann).
 *
 * WICHTIG: das muss an JEDER Stelle laufen, die eine TranslationView über die
 * Leitung an genau eine Person schickt. Stand bei der Untersuchung für dieses
 * Modul (ws/gateway.ts ist gesperrt, eine andere Änderung läuft dort gerade —
 * hier nur beschrieben, nicht gesetzt):
 *   - jeder der sechs Orte, die ein `{ t: 'translation', … }`-Ereignis
 *     verschicken (sendToUser bzw. send(session, …), aktuell in etwa bei den
 *     Zeilen 431, 564, 1217, 1485, 1526, 2812 — Zeilennummern verschieben
 *     sich, der Text `{ t: 'translation'` findet sie zuverlässiger);
 *   - fillCachedTranslations() (aktuell ~Zeile 397): liest message_
 *     translations über eine EIGENE SQL-Abfrage, ohne über translateMessage()
 *     zu gehen, und setzt `m.translation` von Hand — dieselbe Stelle braucht
 *     zusätzlich `measurements: messwerteRecordFuer(m.text, target)` (jetzt
 *     exportiert, siehe oben), SONST bleibt für jede Nachricht, die NUR über
 *     den Verlauf geladen wird (nicht frisch über translateInBackground),
 *     ein ungelöster ⟦m0⟧-Sentinel im Text stehen;
 *   - jede Stelle, die `m.translation` unverändert weiterreicht (z. B. das
 *     `if (m.translation) send(session, { t: 'translation', … })` beim
 *     Öffnen eines Threads).
 *
 * Das zurückgegebene Objekt trägt `measurements` NICHT mehr — es ist bereits
 * aufgelöst und muss (und soll) nicht über die Leitung gehen.
 */
export function messwerteFuerEmpfaenger(
  view: TranslationView, region: Massregion, sprache: string,
): TranslationView {
  if (!view.measurements) return view;
  const text = messwerteInTextEinsetzen(
    view.text, view.measurements, region, dezimaltrennzeichenFuerSprache(sprache),
  );
  const { measurements: _messwerte, ...ohneMesswerte } = view;
  return { ...ohneMesswerte, text };
}

/**
 * Alle Übersetzungen einer Nachricht wegwerfen — bei einem Edit (der Text
 * passt nicht mehr) und beim Löschen (siehe services/messages.ts).
 *
 * Nimmt dabei den Übersetzungsspeicher mit: jede betroffene Zeile trug einen
 * tm_key, und der Schlüssel in translation_memory dahinter darf nur bestehen
 * bleiben, wenn ihn noch eine ANDERE Nachricht hält. Ohne diesen Schritt
 * überlebte der Inhalt einer gelöschten Nachricht — Quelle UND Übersetzung —
 * unter einem anderen Namen im Übersetzungsspeicher weiter, obwohl die
 * Nachricht selbst als gelöscht gilt.
 */
export function dropMessageTranslations(messageId: string): void {
  const schluessel = db.all<{ tm_key: string | null }>(
    'SELECT tm_key FROM message_translations WHERE message_id = ?', messageId,
  ).map((r) => r.tm_key);
  db.run('DELETE FROM message_translations WHERE message_id = ?', messageId);
  tmVerweiseNachrechnen(schluessel);
}

/**
 * Den Verweiszähler dieser Schlüssel aus der Wahrheit neu bestimmen — und
 * freigeben, was keine bestehende Nachricht mehr braucht.
 *
 * Dieselbe Machart wie verweiseNachrechnen()/freigeben() für den
 * Blockspeicher (services/bloecke.ts): nicht hoch- und runterzählen, sondern
 * nachsehen, wie viele Zeilen in message_translations gerade noch auf den
 * Schlüssel zeigen (message_translations.tm_key). Ein Zähler, den man
 * einzeln fortschreibt, läuft irgendwann auseinander — hier genügt ein Weg,
 * auf dem eine Übersetzung verschwindet, ohne dass diese Funktion gerufen
 * wird, und schon zählt es nicht mehr. Nachsehen kann sich nicht verzählen.
 *
 * Aufgeräumt wird ausdrücklich nur unter den übergebenen Schlüsseln, nicht
 * mit einem Rundumschlag über die ganze Tabelle: Zeilen, die eine Umfrage
 * oder eine Kanalangabe im selben Übersetzungsspeicher angelegt hat, tragen
 * `verweise = 0` und werden von dieser Funktion nie angefasst, wenn niemand
 * ihren Schlüssel hier übergibt — sie sind nicht Gegenstand dieser Zählung.
 *
 * Erreicht ein übergebener Schlüssel 0, heißt das: keine bestehende Nachricht
 * hält ihn mehr. Dann wird die Zeile GELÖSCHT, nicht nur auf 0 gesetzt — der
 * Übersetzungsspeicher wäre sonst der einzige Ort, an dem Quelle und
 * Übersetzung einer gelöschten Nachricht überleben.
 */
export function tmVerweiseNachrechnen(keys: Iterable<string | null | undefined>): void {
  const eindeutig = new Set<string>();
  for (const k of keys) if (k) eindeutig.add(k);
  for (const key of eindeutig) {
    db.run(
      `UPDATE translation_memory SET verweise =
         (SELECT COUNT(*) FROM message_translations WHERE tm_key = translation_memory.key)
       WHERE key = ?`,
      key,
    );
    db.run('DELETE FROM translation_memory WHERE key = ? AND verweise <= 0', key);
  }
}

/* ── Round-Trip-Prüfung ───────────────────────────────────────── */

/**
 * Übersetzt die Übersetzung zurück in die Ausgangssprache. Weicht das Ergebnis
 * stark vom Original ab, ist die Übersetzung vermutlich schief — der Nutzer
 * sieht das als Warnhinweis.
 */
export async function roundTrip(messageId: string, targetLang: string): Promise<{ backTranslation: string; similarity: number } | null> {
  const roh = db.get<MessageRow>('SELECT id, channel_id, user_id, text, source_lang, deleted_at FROM messages WHERE id = ?', messageId);
  if (!roh || roh.deleted_at) return null;
  const msg = { ...roh, text: entschluesseln(roh.text) };
  const gespeichert = db.get<{ text: string }>(
    'SELECT text FROM message_translations WHERE message_id = ? AND lang = ?', messageId, normalizeLang(targetLang),
  );
  if (!gespeichert) return null;
  const translated = { text: entschluesseln(gespeichert.text) };

  // Dieselbe Schätzung wie oben — sonst schlägt der Rückweg für dieselben
  // kurzen, mehrdeutigen Nachrichten dieselbe Kapriole wie die Hinübersetzung.
  const sourceLang = msg.source_lang ?? quellspracheSchaetzen(msg.text, msg.user_id);
  const back = await translate({
    text: translated.text,
    targetLang: sourceLang,
    sourceLang: normalizeLang(targetLang),
    skipCache: true,
  });
  // Dieselbe Messlatte wie bei der Echo-Erkennung — eine Ähnlichkeit, ein Maß.
  return { backTranslation: back.text, similarity: wortAehnlichkeit(msg.text, back.text) };
}

/* ── Glossar-Verwaltung ───────────────────────────────────────── */

export function addGlossaryEntry(input: {
  term: string; translations: Record<string, string> | null; caseSensitive?: boolean; note?: string | null; userId: string;
}) {
  const id = newId('gl_');
  db.run(
    `INSERT INTO glossary (id, term, translations, case_sensitive, note, created_by, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(lower(term)) DO UPDATE SET
       translations = excluded.translations, case_sensitive = excluded.case_sensitive, note = excluded.note`,
    id, input.term, input.translations ? JSON.stringify(input.translations) : null,
    input.caseSensitive ? 1 : 0, input.note ?? null, input.userId, Date.now(),
  );
  invalidateGlossary();
  return id;
}

export function removeGlossaryEntry(id: string): void {
  db.run('DELETE FROM glossary WHERE id = ?', id);
  invalidateGlossary();
}

export function listGlossary() {
  return db.all<{ id: string; term: string; translations: string | null; case_sensitive: number; note: string | null; created_by: string; created_at: number }>(
    'SELECT * FROM glossary ORDER BY term COLLATE NOCASE',
  ).map((r) => ({
    id: r.id,
    term: r.term,
    translations: r.translations ? JSON.parse(r.translations) as Record<string, string> : null,
    caseSensitive: Boolean(r.case_sensitive),
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/* ── Umfragen übersetzen ──────────────────────────────────────── */

/** Frage und Antwortmöglichkeiten in einer Zielsprache. */
export interface PollView {
  lang: string;
  question: string;
  /** Nach Optionskennung, damit die Reihenfolge egal ist. */
  options: Record<string, string>;
  provider: string;
}

/**
 * Bereits übersetzte Umfrage aus dem Zwischenspeicher — ohne Netzzugriff.
 * Für den Verlauf: dort muss die Antwort sofort stehen.
 */
export function cachedPollView(pollId: string, targetLang: string): PollView | null {
  const target = normalizeLang(targetLang);
  const row = db.get<{ payload: string; provider: string }>(
    'SELECT payload, provider FROM poll_translations WHERE poll_id = ? AND lang = ?', pollId, target,
  );
  if (!row) return null;
  try {
    const daten = JSON.parse(entschluesseln(row.payload)) as { question: string; options: Record<string, string> };
    return { lang: target, ...daten, provider: row.provider };
  } catch { return null; }
}

/**
 * Eine Umfrage ist mehr als ihr Nachrichtentext: Frage und Antworten stehen in
 * eigenen Zeilen und blieben deshalb bisher in der Ausgangssprache stehen —
 * mitten in einem sonst übersetzten Gespräch.
 *
 * Übersetzt wird jede Zeichenkette einzeln. Zusammengefasst in einen Aufruf
 * wäre billiger, aber dann müsste man die Antwort wieder auseinandernehmen,
 * und genau daran gehen solche Verfahren zugrunde, sobald ein Modell die
 * Nummerierung anders setzt als erwartet.
 */
export async function translatePoll(
  pollId: string,
  targetLang: string,
  opts: { force?: boolean; sourceLang?: string | null } = {},
): Promise<PollView | null> {
  const target = normalizeLang(targetLang);

  const pollRoh = db.get<{ question: string }>('SELECT question FROM polls WHERE id = ?', pollId);
  if (!pollRoh) return null;
  const poll = { question: entschluesseln(pollRoh.question) };
  const optionen = db.all<{ id: string; text: string }>(
    'SELECT id, text FROM poll_options WHERE poll_id = ? ORDER BY position', pollId,
  ).map((o) => ({ ...o, text: entschluesseln(o.text) }));

  const quelle = JSON.stringify([poll.question, ...optionen.map((o) => o.text)]);
  const hash = sha1(quelle);

  if (!opts.force) {
    const cached = db.get<{ payload: string; source_hash: string; provider: string }>(
      'SELECT payload, source_hash, provider FROM poll_translations WHERE poll_id = ? AND lang = ?',
      pollId, target,
    );
    if (cached && cached.source_hash === hash && cached.provider === provider.name) {
      const daten = JSON.parse(entschluesseln(cached.payload)) as { question: string; options: Record<string, string> };
      return { lang: target, ...daten, provider: cached.provider };
    }
  }

  // Die Ausgangssprache einmal an der Frage bestimmen und für alle Antworten
  // übernehmen. Einzeln betrachtet ist "Ja, sehr" zu kurz, um erkannt zu
  // werden — die Antwort bliebe dann als Einzige stehen.
  let quellSprache = opts.sourceLang ?? null;
  const frageErgebnis = await translate({
    text: poll.question, targetLang: target, sourceLang: quellSprache, skipCache: opts.force,
  });
  if (!quellSprache && frageErgebnis.sourceLang && frageErgebnis.sourceLang !== 'unknown') {
    quellSprache = frageErgebnis.sourceLang;
  }

  const uebersetze = async (text: string): Promise<string | null> => {
    const ergebnis = await translate({
      text, targetLang: target, sourceLang: quellSprache, skipCache: opts.force,
    });
    return ergebnis.noop ? null : ergebnis.text;
  };

  const frage = frageErgebnis.noop ? null : frageErgebnis.text;
  const antworten = await Promise.all(optionen.map((o) => uebersetze(o.text)));

  // Ist gar nichts zu tun — die Umfrage steht schon in der Zielsprache —,
  // hat der Aufrufer nichts anzuzeigen.
  if (frage === null && antworten.every((a) => a === null)) return null;

  const daten = {
    question: frage ?? poll.question,
    options: Object.fromEntries(
      optionen.map((o, i) => [o.id, antworten[i] ?? o.text]),
    ),
  };

  db.run(
    `INSERT INTO poll_translations (poll_id, lang, payload, source_hash, provider, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(poll_id, lang) DO UPDATE SET
       payload = excluded.payload, source_hash = excluded.source_hash,
       provider = excluded.provider, created_at = excluded.created_at`,
    pollId, target, verschluesseln(JSON.stringify(daten)), hash, provider.name, Date.now(),
  );

  return { lang: target, ...daten, provider: provider.name };
}

/* ── Kanäle übersetzen ────────────────────────────────────────── */

export interface ChannelView {
  lang: string;
  name: string | null;
  topic: string | null;
  purpose: string | null;
  provider: string;
}

/** Bereits übersetzter Kanal aus dem Zwischenspeicher — ohne Netzzugriff. */
export function cachedChannelView(channelId: string, targetLang: string): ChannelView | null {
  const target = normalizeLang(targetLang);
  const row = db.get<{ payload: string; provider: string }>(
    'SELECT payload, provider FROM channel_translations WHERE channel_id = ? AND lang = ?',
    channelId, target,
  );
  if (!row) return null;
  try {
    // entschluesseln reicht Klartext unverändert durch — Altbestand bleibt lesbar.
    const daten = JSON.parse(entschluesseln(row.payload)) as Omit<ChannelView, 'lang' | 'provider'>;
    return { lang: target, ...daten, provider: row.provider };
  } catch { return null; }
}

/**
 * Name, Thema und Zweck eines Kanals in einer Zielsprache.
 *
 * Der Name bleibt technisch, wie er ist — Erwähnungen wie #vertrieb müssen
 * für alle dieselben bleiben, sonst zeigt ein Link ins Leere. Übersetzt wird
 * nur, was angezeigt wird. Ein Name aus einem einzigen Wort wird dabei
 * mitgenommen, ein Kürzel wie "q3-2026" bleibt stehen.
 */
export async function translateChannel(
  channelId: string,
  targetLang: string,
  opts: { force?: boolean } = {},
): Promise<ChannelView | null> {
  const target = normalizeLang(targetLang);
  const kanal = db.get<{ name: string; topic: string | null; purpose: string | null; kind: string }>(
    'SELECT name, topic, purpose, kind FROM channels WHERE id = ?', channelId,
  );
  if (!kanal || kanal.kind === 'dm') return null;

  const quelle = JSON.stringify([kanal.name, kanal.topic, kanal.purpose]);
  const hash = sha1(quelle);

  if (!opts.force) {
    const cached = db.get<{ payload: string; source_hash: string; provider: string }>(
      'SELECT payload, source_hash, provider FROM channel_translations WHERE channel_id = ? AND lang = ?',
      channelId, target,
    );
    if (cached && cached.source_hash === hash && cached.provider === provider.name) {
      const daten = JSON.parse(cached.payload) as Omit<ChannelView, 'lang' | 'provider'>;
      return { lang: target, ...daten, provider: cached.provider };
    }
  }

  const uebersetze = async (text: string | null): Promise<string | null> => {
    if (!text?.trim()) return null;
    const ergebnis = await translate({ text, targetLang: target, sourceLang: null });
    return ergebnis.noop ? null : ergebnis.text;
  };

  // Namen mit Ziffern, Bindestrichen oder Punkten sind Kürzel und bleiben.
  const nameUebersetzbar = /^[\p{L}][\p{L}\s-]{2,}$/u.test(kanal.name) && !/\d/.test(kanal.name);

  const [name, topic, purpose] = await Promise.all([
    nameUebersetzbar ? uebersetze(kanal.name) : Promise.resolve(null),
    uebersetze(kanal.topic),
    uebersetze(kanal.purpose),
  ]);

  if (!name && !topic && !purpose) return null;

  const daten = { name, topic, purpose };
  db.run(
    `INSERT INTO channel_translations (channel_id, lang, payload, source_hash, provider, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(channel_id, lang) DO UPDATE SET
       payload = excluded.payload, source_hash = excluded.source_hash,
       provider = excluded.provider, created_at = excluded.created_at`,
    // Thema und Zweck eines Kanals sind Inhalt, kein Beiwerk — sie gehören
    // genauso verschlüsselt wie jede Nachricht.
    channelId, target, verschluesseln(JSON.stringify(daten)), hash, provider.name, Date.now(),
  );
  return { lang: target, ...daten, provider: provider.name };
}
