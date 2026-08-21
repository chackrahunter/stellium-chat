/**
 * Die Sicherheitsabstände des Geräts als Zahlen — für alles, was seine
 * Position selbst rechnet.
 *
 * CSS-Regeln bekommen die Ränder über var(--sicher-*). Frei positionierte
 * Menüs und Karten (Kontextmenü, Statusmenü, Aufgaben-Pop, Tour) klemmen
 * ihre Lage aber in JavaScript an window.innerWidth/innerHeight — und
 * landeten damit im Querformat unter der Kamera-Aussparung oder in der
 * Wischzone der Home-Leiste. Hier kommt dieselbe Wahrheit wie im CSS her:
 * die --sicher-*-Variablen tragen die env()-Werte aus tokens.css UND die
 * Laufzeit-Übersteuerungen aus sichere-bereiche.ts (iOS-26-Ausgleich).
 */
export function sichereRaender(): { oben: number; unten: number; links: number; rechts: number } {
  const stil = getComputedStyle(document.documentElement);
  const wert = (name: string) => parseFloat(stil.getPropertyValue(name)) || 0;
  return {
    oben: wert('--sicher-oben'),
    unten: wert('--sicher-unten'),
    links: wert('--sicher-links'),
    rechts: wert('--sicher-rechts'),
  };
}
