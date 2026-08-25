/**
 * Der Hintergrundstil — eine Wahl des Geräts, nicht des Kontos.
 *
 * Anders als Thema und Dichte lebt diese Einstellung bewusst NICHT auf dem
 * Server: sie beschreibt, was ein bestimmtes Gerät leisten soll. Ein altes
 * Telefon bekommt den ruhigen Hintergrund, der schnelle Rechner daneben
 * behält den Kosmos — dieselbe Person, zwei sinnvolle Antworten. Über den
 * Server zu gehen hieße außerdem, ein neues Feld im Einstellungsprotokoll,
 * in prefs:update, in der Datenbank und in allen Prüfläufen zu erklären —
 * für eine Wahl, die ohnehin nur lokal wirkt.
 *
 * Drei Stufen:
 *   kosmos — Nebelflecken und funkelnde Sterne (die Vorgabe, wie bisher)
 *   still  — dieselben Farben, aber ohne Sterne und ohne Bewegung
 *   aus    — gar kein Hintergrund, nur die flächige Farbe
 *
 * Die Stufe steht als Datenattribut am Wurzelelement (`data-hintergrund`),
 * damit das Stylesheet allein darüber entscheidet — keine Komponente muss
 * die Wahl kennen, und sie gilt auch auf Anmelde- und Einrichtungsschirm.
 */

export type Hintergrund = 'kosmos' | 'still' | 'aus';

const SCHLUESSEL = 'stellium.hintergrund';

const horcher = new Set<(w: Hintergrund) => void>();

/** Die eingestellte Stufe — oder "kosmos", wenn nie gewählt wurde. */
export function hintergrundLesen(): Hintergrund {
  try {
    const w = localStorage.getItem(SCHLUESSEL);
    if (w === 'still' || w === 'aus') return w;
  } catch { /* ohne Speicher eben die Vorgabe */ }
  return 'kosmos';
}

/** Eine Stufe setzen und sofort anwenden — alle Horcher erfahren davon. */
export function hintergrundSetzen(w: Hintergrund): void {
  try { localStorage.setItem(SCHLUESSEL, w); } catch { /* dann eben nur für diese Sitzung */ }
  anwenden();
  horcher.forEach((h) => h(w));
}

/** Auf Änderungen hören (für die Einstellungsseite). */
export function hintergrundBeobachten(h: (w: Hintergrund) => void): () => void {
  horcher.add(h);
  return () => { horcher.delete(h); };
}

function anwenden(): void {
  document.documentElement.dataset.hintergrund = hintergrundLesen();
}

/* Gleich beim Laden anwenden — nicht erst, wenn React steht. Sonst flackerte
   der Schirm einmal von der Vorgabe zur Wahl, wer etwas anderes als "kosmos"
   eingestellt hat. */
if (typeof document !== 'undefined') anwenden();