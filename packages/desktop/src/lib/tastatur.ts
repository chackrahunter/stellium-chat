/**
 * Die Bildschirmtastatur in eine CSS-Variable übersetzen.
 *
 * `interactive-widget=resizes-content` im Viewport-Meta versteht nur
 * Chromium/Android. iOS Safari ignoriert die Angabe: dort bleibt die
 * Fensterhöhe bei offener Tastatur stehen, 100vh/100dvh rechnen sie nicht
 * heraus, und Fenster mit max-height in vh können mit ihren Fußknöpfen
 * unter der Tastatur verschwinden.
 *
 * visualViewport sieht die Tastatur auf beiden Plattformen. Ist sie offen,
 * steht in `--vv-hoehe` die tatsächlich sichtbare Höhe; geschlossen wird die
 * Variable entfernt und die vh-Werte im Stylesheet gelten unverändert
 * (dort per `min(…, var(--vv-hoehe, …))` verknüpft).
 */

/* Kleiner als dieser Unterschied ist keine Tastatur, sondern Leisten-Zappeln
   des Browsers — dann die Variable nicht anfassen. */
const MINDEST_DIFFERENZ = 60;

/**
 * Ist die Bildschirmtastatur gerade offen? Gemessen, nicht geraten: ein
 * fokussiertes Feld allein sagt nichts (die App fokussiert den Composer
 * selbst, ohne dass iOS dafür die Tastatur zeigt), und ein Fingerzoom
 * verkleinert visualViewport ebenfalls — deshalb zählt nur eine
 * Höhendifferenz OHNE Zoom als Tastatur.
 */
export function tastaturOffen(): boolean {
  const vv = window.visualViewport;
  if (!vv) return false;
  return vv.scale <= 1.05 && vv.height < window.innerHeight - MINDEST_DIFFERENZ;
}

export function tastaturVerbinden(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  /* Auf Geräten ohne Fingereingabe gibt es keine überlagernde
     Bildschirmtastatur — dort gar nicht erst horchen, sonst feuert jedes
     Ziehen der Fenstergröße nutzlose Style-Zugriffe. */
  if (!window.matchMedia('(pointer: coarse)').matches) return;

  const wurzel = document.documentElement;
  let gesetzt = false;
  const setzen = () => {
    if (tastaturOffen()) {
      /* Die sichtbare Höhe. Das Gerüst hängt seine Gesamthöhe daran, damit
         die drei Zeilen — Kopf, Verlauf, Eingabe — zusammen in den Rest
         über der Tastatur passen. Ohne das läge die Eingabezeile weiter am
         unteren Rand des Layout-Viewports, also UNTER der Tastatur. */
      wurzel.style.setProperty('--vv-hoehe', `${Math.round(vv.height)}px`);
      /* Schiebt iOS die Seite hoch, um das Feld freizustellen, wandert der
         sichtbare Ausschnitt mit. Ein am Layout-Viewport festgemachtes
         Gerüst bliebe zurück. Normalerweise 0, weil die Seite selbst nicht
         scrollt — aber verlassen sollte man sich darauf nicht. */
      wurzel.style.setProperty('--vv-oben', `${Math.round(vv.offsetTop)}px`);
      /* Als Klasse, nicht als Variable: --sicher-unten wird auch aus
         tokens.css gespeist. Zwei Stellen, die dieselbe Variable setzen,
         überschreiben sich gegenseitig je nach Reihenfolge der Ereignisse —
         eine Klasse kann das nicht. */
      wurzel.classList.add('tastatur-offen');
      gesetzt = true;
    } else if (gesetzt) {
      wurzel.style.removeProperty('--vv-hoehe');
      wurzel.style.removeProperty('--vv-oben');
      wurzel.classList.remove('tastatur-offen');
      gesetzt = false;
    }
  };
  vv.addEventListener('resize', setzen);
  /* Auch auf scroll horchen: beim Auf- und Zuklappen ändert iOS erst die
     Höhe und schiebt danach den Ausschnitt — das zweite Ereignis ist ein
     scroll, kein resize. */
  vv.addEventListener('scroll', setzen);
  setzen();
}
