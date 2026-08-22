/**
 * Wie lange jemand online war.
 *
 * Gezählt wird in Sekunden je Tag und Konto, aufsummiert von der Statusuhr
 * im Gateway: alle 30 Sekunden bekommt jeder, der gerade `online` ist, 30
 * Sekunden gutgeschrieben.
 *
 * Warum eine Summe und keine Liste von Zeitspannen: eine Spanne muss beim
 * Abmelden geschlossen werden, und genau das passiert bei einem Absturz,
 * einem Neustart oder einer abgerissenen Leitung nicht. Dann steht dort eine
 * offene Spanne, die entweder ewig weiterläuft oder verworfen werden muss —
 * beides falsch. Eine Summe kann keinen halben Zustand haben; schlimmstenfalls
 * fehlen die letzten 30 Sekunden.
 *
 * `online` und nicht `verbunden`: gezählt werden soll die Zeit vor der App,
 * nicht die Zeit mit offener Leitung. Seit der Status dem Fenster folgt, ist
 * das genau die Zeit, in der jemand die App wirklich vorn hatte.
 */
import { db } from '../db/index.js';

/** UTC-Datum als 'YYYY-MM-DD'. Siehe schema.sql, warum UTC. */
export function tagVon(zeit: number = Date.now()): string {
  return new Date(zeit).toISOString().slice(0, 10);
}

/** Sekunden gutschreiben. Legt den Tageseintrag bei Bedarf an. */
export function gutschreiben(userIds: string[], sekunden: number): void {
  if (!userIds.length || sekunden <= 0) return;
  const tag = tagVon();
  /* Alle in einem Zug: bei acht Konten sind das acht Schreibvorgänge, und
     einzeln kostet jeder eine eigene Festschreibung auf die Karte. */
  db.transaction(() => {
    for (const id of userIds) {
      db.run(
        `INSERT INTO praesenz_tage (user_id, tag, sekunden) VALUES (?, ?, ?)
         ON CONFLICT(user_id, tag) DO UPDATE SET sekunden = sekunden + excluded.sekunden`,
        id, tag, sekunden,
      );
    }
  });
}

export type Zeitraum = 'heute' | 'woche' | 'monat' | 'jahr';

/** Wie viele Tage ein Zeitraum zurückreicht, den heutigen mitgezählt. */
const TAGE: Record<Zeitraum, number> = { heute: 1, woche: 7, monat: 30, jahr: 365 };

export interface Tageswert { tag: string; sekunden: number }

/**
 * Der Verlauf für einen Zeitraum — ein Wert je Tag, Lücken als Null.
 *
 * Die Lücken werden hier gefüllt und nicht in der Oberfläche: eine Linie, die
 * fehlende Tage überspringt, zeigt eine Steigung, die es nie gab. Ein Tag ohne
 * Eintrag ist ein Tag mit null Sekunden, und genau so muss er gezeichnet
 * werden.
 */
export function verlauf(userId: string, zeitraum: Zeitraum): Tageswert[] {
  const tage = TAGE[zeitraum] ?? 7;
  const von = tagVon(Date.now() - (tage - 1) * 86_400_000);
  const roh = db.all<{ tag: string; sekunden: number }>(
    'SELECT tag, sekunden FROM praesenz_tage WHERE user_id = ? AND tag >= ? ORDER BY tag',
    userId, von,
  );
  const nach = new Map(roh.map((r) => [r.tag, r.sekunden]));
  const aus: Tageswert[] = [];
  for (let i = tage - 1; i >= 0; i--) {
    const t = tagVon(Date.now() - i * 86_400_000);
    aus.push({ tag: t, sekunden: nach.get(t) ?? 0 });
  }
  return aus;
}

/** Summe über alle vier Zeiträume auf einmal — ein Abruf statt vier. */
export function summen(userId: string): Record<Zeitraum, number> {
  const aus = {} as Record<Zeitraum, number>;
  for (const z of Object.keys(TAGE) as Zeitraum[]) {
    const von = tagVon(Date.now() - (TAGE[z] - 1) * 86_400_000);
    const r = db.get<{ s: number }>(
      'SELECT COALESCE(SUM(sekunden), 0) AS s FROM praesenz_tage WHERE user_id = ? AND tag >= ?',
      userId, von,
    );
    aus[z] = r?.s ?? 0;
  }
  return aus;
}
