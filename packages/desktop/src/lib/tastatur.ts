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

  let gesetzt = false;
  const setzen = () => {
    if (tastaturOffen()) {
      document.documentElement.style.setProperty('--vv-hoehe', `${Math.round(vv.height)}px`);
      gesetzt = true;
    } else if (gesetzt) {
      document.documentElement.style.removeProperty('--vv-hoehe');
      gesetzt = false;
    }
  };
  vv.addEventListener('resize', setzen);
  setzen();
}
