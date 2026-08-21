/**
 * Die Wischzone am unteren Rand als CSS-Variable — dort, wo env() sie nicht
 * mehr meldet.
 *
 * Vorgeschichte: Das Viewport-Meta trug `viewport-fit=cover`. Auf iOS 26
 * löst das einen Fehler aus (WebKit #301994) — die Startbildschirm-App
 * bekommt einen um die Statusleistenhöhe verkleinerten Ausschnitt, und zwar
 * festgenagelt am OBEREN Schirmrand. Auf dem iPhone 17 Pro gemessen: 812 von
 * 874 Punkten, die unteren 62 tot. Ohne `cover` ist der Ausschnitt gleich
 * groß, liegt aber bei 62..874 — er reicht bis zur letzten Bildschirmzeile.
 * Deshalb steht die Angabe nicht mehr im HTML.
 *
 * Das hat einen Preis, und der ist der Grund für diese Datei: ohne `cover`
 * meldet env() ÜBERALL 0, auch für die Wischleiste. Für Regeln im
 * Stylesheet ist das richtig — die Eingabeleiste soll bis an den Rand
 * reichen, und dass sie dort nicht angeschnitten wird, löst ihre Rundung
 * (siehe mobil.css). Für frei schwebende Menüs ist es falsch: die klemmen
 * ihre Lage in JavaScript an window.innerHeight, und der endet jetzt am
 * echten Schirmrand. Ohne eigenen Wert lägen Kontextmenü, Statusmenü und
 * Aufgabenkarte mitten in der Wischgeste.
 *
 * Deshalb eine EIGENE Variable statt --sicher-unten: die beiden wollen
 * Verschiedenes. --sicher-unten bleibt 0, damit die Eingabeleiste unten
 * bleibt; --wischzone hält alles frei Schwebende darüber.
 */

/* Schirmhöhe passend zur aktuellen Ausrichtung — iOS meldet screen.height
   immer als lange Kante, auch im Querformat. */
function schirmHoehe(): number {
  return window.innerWidth > window.innerHeight
    ? Math.min(screen.width, screen.height)
    : Math.max(screen.width, screen.height);
}

/* Apples Maß für diese Geräte. Der Balken selbst ist schmaler, die Geste
   greift aber darüber hinaus. */
const WISCHZONE = 34;

function anwenden(): void {
  const wurzel = document.documentElement.style;

  /* Fehlt am unteren Rand nichts, weil der Browser seine Leisten dort selbst
     unterbringt (Safari mit Adressleiste), ist schon alles frei — dann
     wäre ein eigener Abstand der zweite.
     Die Bedingung prüft, ob der Ausschnitt kleiner ist als der Schirm: nur
     dann steht er UNTER der Statusleiste, und nur solche Geräte haben
     überhaupt eine Wischleiste statt eines Home-Knopfes. */
  const fehl = schirmHoehe() - window.innerHeight;
  if (fehl <= 8) {
    wurzel.removeProperty('--wischzone');
    return;
  }
  wurzel.setProperty('--wischzone', `${WISCHZONE}px`);
}

export function sichereBereicheVerbinden(): void {
  /* Nur die iOS-Startbildschirm-App. Im Browser verwaltet Safari seine
     Leisten selbst und der Ausschnitt endet ohnehin darüber; auf Android
     rückt Chrome den Ausschnitt von der Navigationsleiste weg. */
  if ((navigator as { standalone?: boolean }).standalone !== true) return;

  anwenden();
  /* Beim Kaltstart stehen die Maße noch nicht überall; einmal nachfassen.
     Und nach jeder Drehung, weil sich die Schirmhöhe dabei vertauscht. */
  setTimeout(anwenden, 1200);
  window.addEventListener('orientationchange', () => setTimeout(anwenden, 300));
}
