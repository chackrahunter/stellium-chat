/**
 * Wie viele Marken („Tokens") ein Text ungefähr kostet.
 *
 * Steht in shared, weil beide Seiten dieselbe Antwort brauchen: der Server
 * rechnet damit den Verlauf ins Kontextfenster, die Oberfläche zeigt beim
 * Tippen live an, was die Frage kosten wird. Zwei Kopien derselben Regel
 * wären zwei Zahlen, die auseinanderlaufen — und die Anzeige wäre wertlos,
 * sobald sie der Rechnung des Servers widerspricht.
 *
 * Bewusst zeichenweise und nicht über eine Division durch die Gesamtlänge:
 * ein Verlauf, in dem ein deutscher und ein chinesischer Absatz nebeneinander
 * stehen, wird sonst nach dem Durchschnitt bewertet und damit für den
 * chinesischen Teil zu niedrig. Geschätzt wird nach oben — lieber ein Stück
 * Fenster verschenken als eine abgelehnte Anfrage.
 */

/** Nur lateinische Buchstaben, Ziffern, Leerraum und übliche Satzzeichen. */
const SPARSAM = /[\p{Script=Latin}\p{Nd}\s.,;:!?'"()\[\]{}\-–—/\\@#*_=+<>|~^$%&`]/u;

export function markenSchaetzung(text: string): number {
  let sparsam = 0;
  let teuer = 0;
  for (const zeichen of text) {
    if (SPARSAM.test(zeichen)) sparsam += 1; else teuer += 1;
  }
  return Math.ceil(sparsam / 3) + teuer;
}
