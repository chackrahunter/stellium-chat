/**
 * Doppelten Sicherheitsabstand erkennen und wegnehmen — gemessen, nicht geraten.
 *
 * Seit iOS 26 beginnt der Viewport einer Startbildschirm-App nicht mehr
 * hinter der Statusleiste, aber `env(safe-area-inset-top)` meldet weiterhin
 * ihre Höhe. Wer den Wert brav als Abstand setzt, schiebt seinen Inhalt
 * damit ZWEIMAL nach unten: einmal durch das System, einmal selbst. Auf dem
 * iPhone 17 Pro gemessen: die Kopfzeile saß bei 124 statt 68 Punkten, mit
 * einem 56-Punkte-Leerband unter der Uhr.
 *
 * Tückisch daran: Die frühere Fassung, in der eine Kurzschreibweise den
 * Abstand versehentlich löschte, sah in der Startbildschirm-App genau
 * deshalb RICHTIG aus. Die Reparatur des einen Fehlers machte den anderen
 * sichtbar.
 *
 * Statt an einer iOS-Fassung zu schnüffeln, wird gemessen: Nimmt der
 * Viewport den ganzen Schirm ein (dann braucht es unsere Abstände), oder hat
 * das System oben/unten schon Platz weggenommen (dann wären unsere doppelt)?
 * Zwei Probe-Elemente liefern die env()-Werte, der Vergleich von
 * `innerHeight` mit `screen.height` sagt, was das System schon abgezogen hat.
 */

function envWert(eigenschaft: string): number {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;height:env(${eigenschaft},0px)`;
  document.body.appendChild(el);
  const wert = el.getBoundingClientRect().height;
  el.remove();
  return wert;
}

function anwenden(): void {
  /* Nur die installierte Web-App ist betroffen. Im Browser verwaltet Safari
     seine Leisten selbst, und dort ist env() ohnehin 0. */
  if (!window.matchMedia('(display-mode: standalone)').matches) return;

  const oben = envWert('safe-area-inset-top');
  const unten = envWert('safe-area-inset-bottom');
  /* Was das System bereits abgezogen hat. Bei einem Viewport über den ganzen
     Schirm ist das 0 — dann stimmen die env()-Werte und bleiben stehen. */
  const abgezogen = screen.height - window.innerHeight;

  const wurzel = document.documentElement.style;
  if (abgezogen >= oben + unten - 6 && oben + unten > 0) {
    wurzel.setProperty('--sicher-oben', '0px');
    wurzel.setProperty('--sicher-unten', '0px');
  } else if (oben > 0 && abgezogen >= oben - 6) {
    wurzel.setProperty('--sicher-oben', '0px');
  } else {
    /* Voller Schirm — die Werte aus tokens.css gelten unverändert. Vorher
       gesetzte Übersteuerungen zurücknehmen (Drehung des Geräts). */
    wurzel.removeProperty('--sicher-oben');
    wurzel.removeProperty('--sicher-unten');
  }
}

export function sichereBereicheVerbinden(): void {
  /* Vor dem ersten Zeichnen einmal, danach nur bei Drehung. NICHT bei jedem
     resize: die Tastatur verkleinert innerHeight ebenfalls, und das darf die
     Messung nicht als Systemleiste missverstehen. */
  anwenden();
  window.addEventListener('orientationchange', () => setTimeout(anwenden, 300));
}
