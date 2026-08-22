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
 * ZWEI ACHSEN, BEIDE AUS DEM VORHANDENEN FARBRAUM (tokens.css) —
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
 *
 * Fehlt eine Einordnung (Sichtung läuft noch, ist fehlgeschlagen, oder gibt
 * es schlicht noch nicht), liefert `dringlichkeitFarbe(undefined)` bewusst
 * die neutrale Randfarbe `--line-strong` — NIE die Farbe von „niedrig". Eine
 * Mail, die die KI nicht bewertet hat, ist keine unwichtige Mail.
 */
import type { Absenderart, Dringlichkeit } from '@stellium/shared';

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
