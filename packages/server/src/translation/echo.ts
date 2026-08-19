/**
 * Kam statt einer Übersetzung die Eingabe zurück?
 *
 * Kleine Modelle auf eigener Hardware halten sich nicht immer an die
 * Anweisung. Statt zu übersetzen geben sie den Eingabetext „aufgeräumt"
 * zurück — mit Kommas und Großbuchstaben, sonst Wort für Wort derselbe Satz.
 * Gemessen mit qwen3-8b trat das bei 29 % aller Nachrichten auf, bei
 * englischer Umgangssprache ohne Satzzeichen deutlich häufiger.
 *
 * Ein Zeichenvergleich findet das nicht: die Zeichenketten unterscheiden sich
 * ja. Verglichen wird deshalb wortweise und ohne alles, was eine Übersetzung
 * nicht ausmacht — Groß-/Kleinschreibung, Satzzeichen, Akzente.
 *
 * Diese Datei hängt bewusst an nichts: so lässt sich die Erkennung ohne
 * Datenbank und ohne Konfiguration prüfen (scripts/echo-pruefen.mjs).
 */

/** Ab dieser wortweisen Übereinstimmung gilt die Antwort als Eingabe-Echo. */
export const ECHO_SCHWELLE = 0.85;

/**
 * Kürzere Texte werden nicht geprüft.
 *
 * „ok", „+1" oder ein Firmenname lauten in beiden Sprachen gleich — dort ist
 * die unveränderte Rückgabe die richtige Antwort und kein Fehler.
 */
export const ECHO_MIN_WOERTER = 3;

/**
 * Der Wortbestand eines Textes.
 *
 * Erst die Akzente von den Buchstaben lösen und wegwerfen, dann alles
 * Nicht-Buchstabige zu Leerzeichen: sonst zerfiele „über" in „u" und „ber",
 * weil das abgetrennte Zeichen selbst kein Buchstabe mehr ist.
 */
export function woerter(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Wortweise Übereinstimmung zweier Texte, 0..1 (Dice-Koeffizient). */
export function wortAehnlichkeit(a: string, b: string): number {
  const A = woerter(a);
  const B = woerter(b);
  if (!A.length || !B.length) return 0;
  const vorrat = new Map<string, number>();
  for (const w of A) vorrat.set(w, (vorrat.get(w) ?? 0) + 1);
  let treffer = 0;
  for (const w of B) {
    const c = vorrat.get(w) ?? 0;
    if (c > 0) { treffer++; vorrat.set(w, c - 1); }
  }
  return (2 * treffer) / (A.length + B.length);
}

/**
 * true, wenn die „Übersetzung" praktisch der Eingabetext ist.
 *
 * Absichtlich nicht auf Zeichengleichheit geprüft — der beobachtete Fall
 * unterschied sich in Satzzeichen und Großschreibung und wäre so durchgerutscht.
 */
export function istEcho(original: string, uebersetzung: string): boolean {
  if (woerter(original).length < ECHO_MIN_WOERTER) return false;
  return wortAehnlichkeit(original, uebersetzung) >= ECHO_SCHWELLE;
}
