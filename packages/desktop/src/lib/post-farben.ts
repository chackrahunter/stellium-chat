/**
 * Farbe nach Bedeutung für die KI-Einordnung eingegangener Firmenpost —
 * geteilt zwischen dem Postfach-Reiter (PostPanel.tsx, Rand/Sortierung je
 * Zeile) und dem Reiter „Post-Sichtung" (PostMeldungen.tsx), damit beide
 * dieselbe Farbe für dieselbe Bedeutung zeigen und keiner seine eigene,
 * mit der Zeit auseinanderlaufende Zuordnung pflegt.
 *
 * Eigene, kleine Datei statt in lib/format.ts: die wird gerade an anderer
 * Stelle bearbeitet, und diese Zuordnung gehört inhaltlich ohnehin eher zu
 * post-sichtung als zu allgemeiner Formatierung.
 *
 * DREI ACHSEN, ALLE AUS DEM VORHANDENEN FARBRAUM (tokens.css) —
 * KEINE NEUE FARBWELT:
 *
 *   · DRINGLICHKEIT — dieselbe Achse wie `PRIO_FARBE` in TasksBoard.tsx:
 *     niedrig -> gedämpft, normal -> Blau, hoch -> Rot. Dieselbe Bedeutung,
 *     die --red/--blue im Rest des Hauses schon tragen (siehe tokens.css:
 *     „--red trägt überfällige Fristen ... --blue die Marken für „neu" und
 *     Erinnerungen" — eine eingegangene, hoch eingestufte Mail IST genau so
 *     eine Frist).
 *   · ABSENDERART — Rosa für eine Privatperson, Violett für eine Firma,
 *     Mintgrün für eine Behörde, gedämpft für einen Automaten. Bewusst OHNE
 *     Rot/Blau/Amber: die tragen schon Dringlichkeit bzw. die
 *     Reply-To-Warnung (siehe PostMeldungen.tsx) — dieselbe Farbe soll nie
 *     zwei verschiedene Dinge gleichzeitig bedeuten.
 *   · RESTFRIST — wie bald eine Mail durch die Aufbewahrungsfrist IHRES
 *     FACHS gelöscht wird (`Nachricht.verfaelltAm`, services/post.ts).
 *     Dieselben drei Farbwerte wie DRINGLICHKEIT oben, aber eine andere
 *     Bedeutung (Zeit bis zum Löschen, nicht Einstufung der KI-Sichtung) —
 *     deshalb ein eigener kleiner Wertebereich statt einer Wiederverwendung
 *     von `Dringlichkeit` selbst, siehe restfristFarbe() unten.
 *
 * Fehlt eine Einordnung (Sichtung läuft noch, ist fehlgeschlagen, oder gibt
 * es schlicht noch nicht), liefert `dringlichkeitFarbe(undefined)` bewusst
 * die neutrale Randfarbe `--line-strong` — NIE die Farbe von „niedrig". Eine
 * Mail, die die KI nicht bewertet hat, ist keine unwichtige Mail.
 */
import type { Absenderart, Dringlichkeit } from '@stellium/shared';
import { tageBis } from './format.js';

export const DRINGLICHKEIT_FARBE: Record<Dringlichkeit, string> = {
  niedrig: 'var(--text-dim)',
  normal: 'var(--blue)',
  hoch: 'var(--red)',
};

export const ABSENDERART_FARBE: Record<Absenderart, string> = {
  privatperson: 'var(--pink)',
  firma: 'var(--violet)',
  behörde: 'var(--mint)',
  automat: 'var(--text-dim)',
};

/** Neutral statt „niedrig", solange keine Dringlichkeit vorliegt — siehe Dateikopf. */
export function dringlichkeitFarbe(d: Dringlichkeit | null | undefined): string {
  return d ? DRINGLICHKEIT_FARBE[d] : 'var(--line-strong)';
}

export function absenderartFarbe(a: Absenderart | null | undefined): string {
  return a ? ABSENDERART_FARBE[a] : 'var(--tx-lo)';
}

/**
 * Farbe der Restfrist-Anzeige (PostFristAnzeige.tsx) — je näher die
 * Löschung, desto auffälliger, dieselben drei Farbwerte wie
 * DRINGLICHKEIT_FARBE oben (siehe Dateikopf für die Begründung, warum
 * trotzdem ein eigener Wertebereich statt `Dringlichkeit` selbst): eine
 * Mail, die in fünf Jahren verfällt, ist eine Randnotiz (gedämpft) — eine,
 * die morgen gelöscht wird, eine Warnung (Rot).
 *
 * Die Grenzen spiegeln GENAU die Einheiten-Wahl von verfaelltIn()
 * (lib/format.ts), über dieselbe tageBis()-Zahl: Rot, solange die Anzeige
 * dort in Tagen rechnet (0–13 Tage, schließt „heute"/„morgen" ein), Blau,
 * solange sie in Wochen rechnet (14–60 Tage), gedämpft ab Monaten/Jahren.
 * Beide Achsen an derselben Zahl aufzuhängen ist Absicht: Text und Farbe
 * dürfen nie an zwei unterschiedlichen Schwellen kippen, sonst stünde „in 3
 * Wochen" irgendwann in der Farbe von „fern".
 *
 * Kein `| null`-Fall wie bei dringlichkeitFarbe(): PostFristAnzeige
 * rendert überhaupt nichts, wenn `verfaelltAm` fehlt (siehe dort) — anders
 * als bei der KI-Einordnung gibt es hier kein „angezeigt, aber neutral",
 * weil eine fehlende Frist keine Einordnung ist, die man ausdrücken müsste.
 */
export function restfristFarbe(verfaelltAm: number): string {
  const diffTage = tageBis(verfaelltAm);
  if (diffTage <= 13) return 'var(--red)';
  if (diffTage <= 60) return 'var(--blue)';
  return 'var(--text-dim)';
}
