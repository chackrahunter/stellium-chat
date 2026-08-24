import { config, istLokal, lokaleEinstellung } from '../config.js';

/**
 * Antwortet der Rechner mit dem lokalen Modell gerade?
 *
 * Zwei Dinge hingen daran, und beide gingen schief, solange niemand nachsah:
 *
 * 1. Die Konsole meldete „Übersetzung an", weil ein Anbieter *eingestellt*
 *    war — nicht, weil je jemand geantwortet hätte. Auf dem Pi stand dort
 *    grün „ollama · qwen3-8b", während der Windows-Rechner schlief.
 * 2. Jede Nachricht lief in drei Versuche à 25 Sekunden. Bei mehreren
 *    Zielsprachen und einer Warteschlange, die nacheinander abarbeitet,
 *    steht der Übersetzungsbetrieb dann faktisch still. Ein Rechner, der aus
 *    ist, ist kein Fall für Geduld, sondern für eine schnelle Absage.
 *
 * Gefragt wird deshalb höchstens alle paar Minuten, und die Antwort gilt für
 * alle. Ein Test pro Nachricht wäre Unfug.
 */

export type LokalerZustand = 'erreichbar' | 'antwortet-nicht' | 'kein-modell';

export interface LokaleLage {
  zustand: LokalerZustand;
  /** Was dort zuletzt geladen war. Bleibt stehen, wenn gerade niemand antwortet. */
  modelle: string[];
  /** Klartext-Grund, wenn es klemmt. */
  fehler: string | null;
  /**
   * Kennung aus dem Wörterbuch der Oberfläche zu `fehler`, wenn dieser ein
   * selbst geschriebener Satz ist (nicht: `${status} ${statusText}` oder eine
   * fremde Ausnahme-Nachricht — die bleiben unübersetzt, dieselbe Grenze wie
   * überall sonst in dieser Datei). null, wenn `fehler` selbst schon null ist
   * oder keine Kennung dazu existiert. Diese Datei läuft auf dem Server, ohne
   * Wörterbuch-Kontext — übersetzt wird erst in der Oberfläche.
   */
  fehlerCode: string | null;
  geprueftAm: number;
  /** Wann zuletzt wirklich jemand geantwortet hat — auch wenn er es jetzt nicht tut. */
  letzterErfolgAm: number | null;
}

/**
 * Läuft es, genügt ein Blick alle paar Minuten. Klemmt es, wird öfter
 * nachgesehen: sonst bliebe die Übersetzung nach dem Aufwachen des Rechners
 * unnötig lange tot.
 */
const FRIST_LAEUFT = 5 * 60_000;
const FRIST_KLEMMT = 30_000;

/**
 * Der Test darf nie länger dauern als ein einzelner Übersetzungsversuch —
 * sonst wäre er teurer als das, was er einspart. Sechs Sekunden reichen für
 * eine Modell-Liste; steht die allgemeine Frist niedriger, gilt sie.
 */
const PRUEF_TIMEOUT = Math.min(6000, config.ai.requestTimeoutMs);

let lage: LokaleLage | null = null;
let laufend: Promise<LokaleLage> | null = null;

/**
 * Die Modell-Liste eines OpenAI-kompatiblen Dienstes holen — ohne
 * Zwischenspeicher, für die Prüfung einer Adresse, die noch nicht gilt.
 */
export async function modelleAbfragen(baseUrl: string): Promise<{
  erreichbar: boolean; modelle: string[]; fehler: string | null; fehlerCode: string | null;
}> {
  const adresse = baseUrl.replace(/\/+$/, '');
  // Kein eigener Satz aus dem Wörterbuch: eine leere Adresse ist eine
  // Bedienungsfrage, kein Zustand des fremden Diensts — deshalb ohne
  // fehlerCode, wie schon vor dieser Umstellung.
  if (!adresse) return { erreichbar: false, modelle: [], fehler: 'Keine Adresse eingetragen.', fehlerCode: null };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRUEF_TIMEOUT);
  try {
    const res = await fetch(`${adresse}/models`, { signal: ctrl.signal });
    // `${status} ${statusText}` ist Protokoll-Diagnose, kein eigener Satz —
    // bleibt unübersetzt, wie die Ausnahme-Nachricht im catch-Zweig unten.
    if (!res.ok) return { erreichbar: false, modelle: [], fehler: `${res.status} ${res.statusText}`, fehlerCode: null };
    const body = await res.json() as { data?: { id?: string }[] };
    const modelle = (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    return {
      erreichbar: true, modelle,
      fehler: modelle.length ? null : 'Dort ist kein Modell geladen.',
      fehlerCode: modelle.length ? null : 'fehler.lokalOhneModell',
    };
  } catch (err) {
    const abgebrochen = (err as Error).name === 'AbortError';
    // Nur der eigene, feste Satz ("keine Antwort") bekommt eine Kennung —
    // eine fremde Ausnahme-Nachricht bleibt unübersetzt, dieselbe Grenze wie
    // bei den beiden anderen fehler-Zweigen oben.
    const grund = abgebrochen ? 'keine Antwort' : (err as Error).message;
    return {
      erreichbar: false, modelle: [], fehler: grund,
      fehlerCode: abgebrochen ? 'fehler.lokalKeineAntwort' : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function frisch(l: LokaleLage): boolean {
  return Date.now() - l.geprueftAm < (l.zustand === 'erreichbar' ? FRIST_LAEUFT : FRIST_KLEMMT);
}

function nachsehen(): Promise<LokaleLage> {
  // Fragen mehrere Nachrichten gleichzeitig, fragt trotzdem nur einer nach.
  if (laufend) return laufend;
  laufend = (async () => {
    const antwort = await modelleAbfragen(lokaleEinstellung().baseUrl);
    const zustand: LokalerZustand = !antwort.erreichbar ? 'antwortet-nicht'
      : antwort.modelle.length ? 'erreichbar' : 'kein-modell';
    festhalten(zustand, antwort.modelle, antwort.fehler, antwort.fehlerCode);
    return lage!;
  })().finally(() => { laufend = null; });
  return laufend;
}

function festhalten(
  zustand: LokalerZustand, modelle: string[], fehler: string | null, fehlerCode: string | null,
): void {
  const vorher = lage;
  lage = {
    zustand,
    modelle: modelle.length ? modelle : vorher?.modelle ?? [],
    fehler,
    fehlerCode,
    geprueftAm: Date.now(),
    letzterErfolgAm: zustand === 'erreichbar' ? Date.now() : vorher?.letzterErfolgAm ?? null,
  };
  // Nur der Wechsel gehört ins Journal — sonst stünde dort alle 30 Sekunden dasselbe.
  if (vorher?.zustand !== zustand) {
    const wo = lokaleEinstellung().baseUrl;
    if (zustand === 'erreichbar') console.log(`[ai] ${wo} antwortet wieder (${lage.modelle.join(', ')}).`);
    else console.warn(`[ai] ${wo}: ${zustand === 'kein-modell' ? 'kein Modell geladen' : fehler ?? 'antwortet nicht'}.`);
  }
  /*
   * Hier, und nur hier, steht fest, dass das EIGENE Modell geantwortet hat —
   * unabhängig davon, ob eine Vertretung gerade übersetzt. Zwei Wege führen
   * hierher:
   *
   *   1. nachsehen() fragt direkt die hinterlegte Adresse des eigenen
   *      Modells ab (modelleAbfragen gegen lokaleEinstellung().baseUrl) —
   *      läuft eine Vertretung gerade, übersetzt die zwar jede Nachricht,
   *      aber lokaleLageJetzt()/lokaleLage() prüfen bei jeder Anfrage bzw.
   *      alle paar Minuten trotzdem weiter das EIGENE Modell (siehe
   *      translation/index.ts, wo lokaleLageJetzt() vor jeder Übersetzung
   *      und aiCapabilities() bei jeder Auskunft gerufen wird) — das ist der
   *      einzige Kanal, über den eine laufende Vertretung je erfährt, dass
   *      der Rechner mit dem eigenen Modell zurück ist.
   *   2. erfolgMelden() — aber die ruft translation/index.ts nur, wenn
   *      wirklich das eigene Modell geantwortet hat (antwortendeStelle ===
   *      aktiv, siehe dort); solange eine Vertretung läuft, liefert derzeit()
   *      die Vertretung statt aktiv, und dieser Zweig bleibt unerreichbar.
   *      Ein Erfolg der Vertretung selbst kommt also nie hier vorbei.
   *
   * Der Rücktritt der Vertretung hängt deshalb bewusst an diesem Übergang
   * und nicht an einer geglückten Übersetzung: eine geglückte Übersetzung
   * über die Vertretung sagt nichts über das eigene Modell aus, ein
   * geglückter Test der hinterlegten Adresse schon.
   */
  if (vorher?.zustand !== 'erreichbar' && zustand === 'erreichbar') {
    /* Spät geladen, weil index.ts diese Datei bereits einbindet und ein Ring
       aus zwei Modulen beim Laden an der unerwartetsten Stelle bricht. */
    void import('./index.js').then((m) => m.ersatzTrittAb()).catch(() => { /* egal */ });
  }
}

/**
 * Der zuletzt bekannte Stand, ohne zu warten — für Auskünfte.
 * Ist er alt, wird im Hintergrund nachgesehen; die Antwort kommt dann beim
 * nächsten Mal. null heißt: kein lokales Modell eingestellt, nichts zu prüfen.
 */
export function lokaleLage(): LokaleLage | null {
  if (!istLokal()) return null;
  if (!lage || !frisch(lage)) void nachsehen().catch(() => { /* Zustand bleibt, wie er war */ });
  return lage;
}

/** Derselbe Stand, aber frisch genug — für Entscheidungen, die davon abhängen. */
export async function lokaleLageJetzt(): Promise<LokaleLage | null> {
  if (!istLokal()) return null;
  if (lage && frisch(lage)) return lage;
  try {
    return await nachsehen();
  } catch {
    return lage;
  }
}

/**
 * Eine geglückte Übersetzung ist der beste Beweis für Erreichbarkeit —
 * besser als jede Modell-Liste, und sie kostet nichts extra.
 */
export function erfolgMelden(): void {
  if (!istLokal()) return;
  // Der Rücktritt einer laufenden Vertretung hängt an festhalten() selbst,
  // nicht an diesem Aufruf hier — Begründung dort.
  festhalten('erreichbar', lage?.modelle ?? [], null, null);
}

/**
 * Ein Netzfehler beim Übersetzen zählt sofort, statt bis zum Ablauf der Frist
 * zu warten: sonst liefe die nächste Nachricht noch einmal in die volle
 * Wartezeit, obwohl schon feststeht, dass niemand da ist.
 */
export function ausfallMelden(grund: string): void {
  if (!istLokal()) return;
  // Kommt von außen (translation/fehler.ts) als freie Ausnahme-Nachricht,
  // nie als einer der eigenen, festen Sätze oben — deshalb ohne fehlerCode.
  festhalten('antwortet-nicht', [], grund, null);
  /* Und jemanden einspringen lassen, statt die KI ganz ausfallen zu lassen. */
  void import('./index.js').then((m) => m.ersatzUebernimmt(grund)).catch(() => { /* egal */ });
}

/** Nach einem Anbieter- oder Adresswechsel gilt der alte Stand nicht mehr. */
export function lageVergessen(): void {
  lage = null;
}
