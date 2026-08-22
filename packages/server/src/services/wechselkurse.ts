/**
 * Historische Wechselkurse — ein Kurs zu einem VERGANGENEN Datum, dauerhaft
 * zwischengespeichert.
 *
 * Der Grund, warum das eine eigene Datei ist und nicht einfach eine Kopie
 * der Kurslogik aus stellium-konsole.mjs: dort wird nur der HEUTIGE Kurs
 * gebraucht ("latest"), hier dagegen der Kurs zu einem bestimmten Tag in der
 * Vergangenheit — dem Tag eines Verkaufs. Beide Fälle nutzen zwar dieselbe
 * Quelle (api.frankfurter.dev), aber unterschiedliche Pfade, und ein
 * historisches Datum liefert immer denselben Wert: einmal geholt, bleibt er
 * für immer gültig. Deshalb hier ein reiner Zwischenspeicher (Tabelle
 * `wechselkurse`, Schlüssel Datum+Basis+Ziel) statt einer Frist wie beim
 * "latest"-Kurs — es gibt nichts, was hier veralten könnte.
 *
 * Genau das ist auch die Antwort auf die Aufgabe "der Wechselkurs eines
 * alten Verkaufs bleibt stabil, wenn sich der heutige Kurs ändert": ein
 * Verkauf vom 15.6. fragt IMMER nach dem Kurs vom 15.6., nie nach "heute" —
 * ändert sich der Kurs von heute, betrifft das nur Verkäufe von heute.
 */
import { db } from '../db/index.js';

const FRANKFURTER_BASIS_URL = process.env.STELLIUM_KURS_HISTORISCH_URL
  ?? 'https://api.frankfurter.dev/v1';

/** Höflichkeitszeitlimit — dieselbe Größenordnung wie beim "latest"-Kurs in
 *  stellium-konsole.mjs, ein hängender Drittanbieter soll einen Sync-Lauf
 *  nicht minutenlang aufhalten. */
const ZEITLIMIT_MS = 9000;

export interface Kurs {
  kurs: number;
  quelldatum: string | null;
}

/** Wie oft `holen()` in einem einzigen Lauf höchstens NEUE (noch nicht
 *  zwischengespeicherte) Tage nachfragen darf. Diese Firma hat heute null
 *  Verkäufe — der Fall, in dem plötzlich hunderte verschiedene Tage auf
 *  einmal aufgelöst werden müssten, ist der einer sehr späten Ersteinrichtung
 *  mit langer Verkaufshistorie. Der Deckel verteilt so einen Rückstand über
 *  mehrere Sync-Läufe, statt einen fremden Dienst mit hunderten Anfragen
 *  hintereinander zu behelligen. */
export const NEUE_KURSE_JE_LAUF = 30;

type HolenFn = (datum: string, basis: string, ziel: string) => Promise<Kurs | null>;

async function standardHolen(datum: string, basis: string, ziel: string): Promise<Kurs | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ZEITLIMIT_MS);
  try {
    const res = await fetch(
      `${FRANKFURTER_BASIS_URL}/${encodeURIComponent(datum)}?base=${encodeURIComponent(basis)}&symbols=${encodeURIComponent(ziel)}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const json = await res.json() as { date?: string; rates?: Record<string, number> };
    const wert = json.rates?.[ziel];
    if (typeof wert !== 'number' || !Number.isFinite(wert) || wert <= 0) return null;
    return { kurs: wert, quelldatum: json.date ?? null };
  } catch {
    /* Kein Netz, Zeitlimit, kaputtes JSON — der Aufrufer bekommt null und
       lässt die Zeile ohne Kurs stehen, statt eine falsche Zahl zu erfinden. */
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let neueKurseIndiesemLauf = 0;
/** Vor jedem Sync-Lauf zurücksetzen (siehe services/gumroad.ts) — der Deckel
 *  gilt je Lauf, nicht für die Lebenszeit des Prozesses. */
export function kursZaehlerZuruecksetzen(): void {
  neueKurseIndiesemLauf = 0;
}

/**
 * Der Kurs für ein bestimmtes, vergangenes Datum — aus dem Zwischenspeicher,
 * sonst frisch geholt und dort abgelegt.
 *
 * `holen` ist austauschbar (Tests): wer die Funktion mit einem `holen`
 * aufruft, das bei einem Cache-Fehlschlag wirft, kann damit beweisen, dass
 * ein Treffer im Zwischenspeicher NIE einen Netzzugriff auslöst — genau das
 * Verhalten, das "der Kurs eines alten Verkaufs bleibt stabil" trägt.
 */
export async function kursFuerDatum(
  datum: string, basis = 'USD', ziel = 'EUR', holen: HolenFn = standardHolen,
): Promise<Kurs | null> {
  const zeile = db.get<{ kurs: number; quelldatum: string | null }>(
    'SELECT kurs, quelldatum FROM wechselkurse WHERE datum = ? AND basis = ? AND ziel = ?',
    datum, basis, ziel,
  );
  if (zeile) return { kurs: zeile.kurs, quelldatum: zeile.quelldatum };

  if (neueKurseIndiesemLauf >= NEUE_KURSE_JE_LAUF) return null;
  neueKurseIndiesemLauf += 1;

  const antwort = await holen(datum, basis, ziel);
  if (!antwort) return null;

  db.run(
    `INSERT INTO wechselkurse (datum, basis, ziel, kurs, quelldatum, geholt_am)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(datum, basis, ziel) DO NOTHING`,
    datum, basis, ziel, antwort.kurs, antwort.quelldatum, Date.now(),
  );
  return antwort;
}
