/**
 * Die Sicherheitsabstände des Geräts als Zahlen — für alles, was seine
 * Position selbst rechnet.
 *
 * CSS-Regeln bekommen die Ränder über var(--sicher-*). Frei positionierte
 * Menüs und Karten (Kontextmenü, Statusmenü, Aufgaben-Pop, Tour) klemmen
 * ihre Lage aber in JavaScript an window.innerWidth/innerHeight — und
 * landeten damit im Querformat unter der Kamera-Aussparung oder in der
 * Wischzone der Home-Leiste. Hier kommt dieselbe Wahrheit wie im CSS her:
 * die --sicher-*-Variablen tragen die env()-Werte aus tokens.css.
 *
 * Unten kommt --wischzone dazu, und ohne die wäre diese Datei auf dem
 * Telefon wirkungslos: seit das Viewport-Meta ohne `viewport-fit=cover`
 * auskommt (siehe sichere-bereiche.ts), meldet env() überall 0 — der
 * Ausschnitt reicht dafür bis zur echten Unterkante des Schirms. Ein Menü,
 * das nur an innerHeight klemmt, läge damit mitten in der Wischgeste.
 * Beide Werte werden verrechnet und nicht der größere genommen: sie
 * schließen einander nicht aus, aber doppelt zählen soll auch keiner —
 * deshalb das Maximum. */
export function sichereRaender(): { oben: number; unten: number; links: number; rechts: number } {
  const stil = getComputedStyle(document.documentElement);
  const wert = (name: string) => parseFloat(stil.getPropertyValue(name)) || 0;
  return {
    oben: wert('--sicher-oben'),
    unten: Math.max(wert('--sicher-unten'), wert('--wischzone')),
    links: wert('--sicher-links'),
    rechts: wert('--sicher-rechts'),
  };
}
