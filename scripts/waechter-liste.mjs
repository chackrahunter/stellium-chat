/**
 * Welche Wächter es im Haus gibt — abgeleitet, nicht aufgezählt.
 *
 * Diese Regel stand bis zum 29.08. nur in scripts/ausliefern.mjs. Sobald ein
 * zweiter Aufrufer dieselbe Menge braucht (der Abarbeiter aus
 * scripts/berichte-abarbeiten.mjs), gibt es zwei Möglichkeiten: die Regel
 * abschreiben oder sie teilen. Abschreiben heißt, dass die zweite Kopie eines
 * Tages hinterherhinkt — genau der Fehler, den die Ableitung im Ausliefern
 * abgeschafft hat, nur eine Ebene höher. Also: eine Stelle, zwei Aufrufer.
 *
 * Die Datei heißt bewusst NICHT *-pruefen.mjs — sonst fände sie sich selbst.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Sprechende Namen für die Läufe, deren Dateiname zu knapp ist. */
export const BESCHREIBUNG = {
  'mobil-pruefen.mjs': 'Handyansicht',
  'randfarbe-pruefen.mjs': 'Rand',
  'tokens-pruefen.mjs': 'Namen im Stylesheet',
  'praesenz-pruefen.mjs': 'Online-Zeit',
  'push-woerterbuch-pruefen.mjs': 'Push-Wörterbuch (push-i18n.ts deckungsgleich mit den 22 Wörterbüchern)',
  'abarbeiter-pruefen.mjs': 'Berichte-Abarbeiter (Anweisung ohne Berichtsinhalt, Tore, Schutzschirm, Sperre, rote Wächter)',
  'waechter-liste-pruefen.mjs': 'Wächterliste (die Ableitung gegen den Ordner — kein Wächter fällt still weg)',
};

/*
 * Browsergestützte Läufe bleiben draußen: die brauchen Playwright und eine
 * Anzeige und gehören in einen eigenen Lauf. Erkannt werden sie am INHALT,
 * nicht am Namen — ein Name lügt irgendwann.
 */
const brauchtBrowser = (p) => /playwright|chromium|probeserver/.test(fs.readFileSync(p, 'utf8'));

/**
 * Alle Wächter unter <wurzel>/scripts als [relativer Pfad, Beschreibung].
 *
 * `wurzel` ist ein Parameter und keine Konstante, weil der Abarbeiter die
 * Wächter eines FREMDEN Arbeitsbaums braucht — desselben Baums, in dem der
 * Claude-Lauf gerade gearbeitet hat. Ein Wächter, der aus dem eigenen Baum
 * käme, prüfte den falschen Stand.
 */
export function waechterFinden(wurzel) {
  return waechterUebersicht(wurzel).waechter;
}

/**
 * Dasselbe, aber mit Rechenschaft: was liegt im Ordner, was läuft, was wurde
 * warum übersprungen.
 *
 * Warum es das gibt: die Ableitung filtert, und ein Filter kann still zu viel
 * wegnehmen. Ein Namensfilter `n.length < 28` — eine Zeile — ließ den Wächter
 * des Abarbeiters grün und die Ableitung 27 statt 65 Läufe finden; über der
 * Schwelle von 20 in ausliefern.mjs, also lief die Auslieferung durch. 38
 * Wächter waren still weg, und nichts im Haus hat es gemerkt.
 *
 * Eine Schwelle ist eine Katastrophenbremse, kein Nachweis. Nachweisen kann
 * man es nur, indem man die abgeleitete Liste gegen den ORDNER hält und für
 * jede fehlende Datei einen Grund verlangt. Genau dafür ist diese Funktion
 * da — scripts/waechter-liste-pruefen.mjs und scripts/ausliefern.mjs
 * benutzen sie.
 */
export function waechterUebersicht(wurzel) {
  const ordner = path.join(wurzel, 'scripts');
  if (!fs.existsSync(ordner)) return { waechter: [], dateien: [], uebersprungen: [] };
  const dateien = fs.readdirSync(ordner).filter((n) => n.endsWith('-pruefen.mjs')).sort();
  const waechter = [];
  const uebersprungen = [];
  for (const n of dateien) {
    if (brauchtBrowser(path.join(ordner, n))) uebersprungen.push([n, 'browsergestützt (playwright/chromium/probeserver)']);
    else waechter.push([`scripts/${n}`, BESCHREIBUNG[n] ?? n.replace(/-pruefen\.mjs$/, '')]);
  }
  return { waechter, dateien, uebersprungen };
}
