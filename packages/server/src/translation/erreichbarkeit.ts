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
  erreichbar: boolean; modelle: string[]; fehler: string | null;
}> {
  const adresse = baseUrl.replace(/\/+$/, '');
  if (!adresse) return { erreichbar: false, modelle: [], fehler: 'Keine Adresse eingetragen.' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRUEF_TIMEOUT);
  try {
    const res = await fetch(`${adresse}/models`, { signal: ctrl.signal });
    if (!res.ok) return { erreichbar: false, modelle: [], fehler: `${res.status} ${res.statusText}` };
    const body = await res.json() as { data?: { id?: string }[] };
    const modelle = (body.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    return { erreichbar: true, modelle, fehler: modelle.length ? null : 'Dort ist kein Modell geladen.' };
  } catch (err) {
    const grund = (err as Error).name === 'AbortError' ? 'keine Antwort' : (err as Error).message;
    return { erreichbar: false, modelle: [], fehler: grund };
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
    festhalten(zustand, antwort.modelle, antwort.fehler);
    return lage!;
  })().finally(() => { laufend = null; });
  return laufend;
}

function festhalten(zustand: LokalerZustand, modelle: string[], fehler: string | null): void {
  const vorher = lage;
  lage = {
    zustand,
    modelle: modelle.length ? modelle : vorher?.modelle ?? [],
    fehler,
    geprueftAm: Date.now(),
    letzterErfolgAm: zustand === 'erreichbar' ? Date.now() : vorher?.letzterErfolgAm ?? null,
  };
  // Nur der Wechsel gehört ins Journal — sonst stünde dort alle 30 Sekunden dasselbe.
  if (vorher?.zustand !== zustand) {
    const wo = lokaleEinstellung().baseUrl;
    if (zustand === 'erreichbar') console.log(`[ai] ${wo} antwortet wieder (${lage.modelle.join(', ')}).`);
    else console.warn(`[ai] ${wo}: ${zustand === 'kein-modell' ? 'kein Modell geladen' : fehler ?? 'antwortet nicht'}.`);
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
  festhalten('erreichbar', lage?.modelle ?? [], null);
}

/**
 * Ein Netzfehler beim Übersetzen zählt sofort, statt bis zum Ablauf der Frist
 * zu warten: sonst liefe die nächste Nachricht noch einmal in die volle
 * Wartezeit, obwohl schon feststeht, dass niemand da ist.
 */
export function ausfallMelden(grund: string): void {
  if (!istLokal()) return;
  festhalten('antwortet-nicht', [], grund);
}

/** Nach einem Anbieter- oder Adresswechsel gilt der alte Stand nicht mehr. */
export function lageVergessen(): void {
  lage = null;
}
