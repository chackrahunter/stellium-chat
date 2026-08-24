/**
 * Die Fußzeile, die eine KI-beteiligte Antwort am Ende einer ausgehenden
 * Mail trägt — und die eine Vergleichsrechnung, die entscheidet, OB und
 * WELCHE.
 *
 * Reine Textbausteine und eine reine Rechnung, keine Datenbank, kein Modell,
 * keine Route — derselbe Schnitt wie zwischen post-ki.ts (Anweisung) und
 * post-wissen-ki.ts (Auswahl/Vergleich): services/post.ts::senden() ist der
 * EINE Ort, der diese Datei tatsächlich aufruft, weil er der eine Ort ist,
 * durch den jeder Versand läuft (siehe Dateikopf dort).
 *
 * DREI FÄLLE, VOM AUFTRAGGEBER SO VORGEGEBEN
 *
 *   · Die KI hat allein geschrieben, ein Mensch hat nur bestätigt ->
 *     KENNZEICHNUNG_DE/KENNZEICHNUNG_EN ("automatisch … erstellt").
 *   · Die KI hat einen Entwurf geliefert, ein Mensch hat ihn inhaltlich
 *     verändert -> KENNZEICHNUNG_BEARBEITET_DE/KENNZEICHNUNG_BEARBEITET_EN
 *     ("mithilfe von … bearbeitet").
 *   · Ein Mensch hat ganz ohne KI geschrieben -> gar keine Fußzeile.
 *
 * WAS ALS „VERÄNDERT" ZÄHLT — UND WAS NICHT
 *
 * `kiHerkunft()` unten entscheidet mit `veraenderung()` aus
 * post-wissen-ki.ts — derselben Rechnung, mit der auch post-lernen.ts
 * einen unverändert freigegebenen Entwurf erkennt (MINDEST_VERAENDERUNG
 * dort). Sie vergleicht WORTMENGEN, nicht Zeichen: Leerraum, ein
 * angehängter Zeilenumbruch, eine umgestellte Anrede verändern die Wortmenge
 * nicht und zählen deshalb NICHT als Bearbeitung — wer nur ein Leerzeichen
 * verschoben hat, hat den Text nicht zu seinem eigenen gemacht. Das ist
 * ausdrücklich so gewollt (siehe Auftrag): im Zweifel gilt eine Antwort als
 * von der KI erstellt, nie umgekehrt — das ist die ehrliche Richtung, weil
 * sie der KI mehr statt weniger Anteil zuschreibt.
 *
 * Jede WIRKLICHE Wortänderung dagegen zählt sofort, ohne eigene Schwelle:
 * anders als post-lernen.ts (das erst ab 15 % geänderter Wörter überhaupt
 * fragt, weil ein Tippfehler keine Karte im Reiter wert ist) gibt es hier
 * keinen Grund, kleine Änderungen zu übersehen — eine Fußzeile zu setzen
 * kostet niemanden einen Modellaufruf oder einen Blick, der sonst nicht
 * ohnehin fällig wäre.
 */
import {
  KENNZEICHNUNG_DE, KENNZEICHNUNG_EN, KENNZEICHNUNG_BEARBEITET_DE, KENNZEICHNUNG_BEARBEITET_EN,
} from './post-ki.js';
import { veraenderung } from './post-wissen-ki.js';

/**
 * 'ki'            — unverändert von der KI übernommen (oder kein Vergleich
 *                    möglich, weil `text_ki` erst seit Kurzem existiert —
 *                    siehe kiHerkunft() unten für den Unterschied zu `null`).
 * 'ki_bearbeitet' — ein Mensch hat den KI-Entwurf inhaltlich verändert.
 *
 * Dieselben zwei Werte stehen unverschlüsselt in
 * `mail_nachrichten.ki_art` (schema.sql/migrate.ts) — die GESENDETE Zeile
 * trägt den Fakt, nicht nur diese Berechnung hier, damit
 * services/post-lernen.ts ihn nachschlagen kann, ohne den Fließtext nach
 * einer Zeichenkette zu durchsuchen (siehe dort).
 */
export type KiHerkunft = 'ki' | 'ki_bearbeitet';

/**
 * Woher eine ausgehende Antwort stammt — oder `null`, wenn keine KI beteiligt
 * war (kein `textKi`, also rein von Hand geschrieben).
 *
 * `textKi` ist entweder `mail_entwuerfe.text_ki` (die automatische Sichtung,
 * niemals überschrieben — siehe schema.sql) oder der Wortlaut, den
 * `entwurfSchreiben()` (post-entwurf-ki.ts, Knopf „KI schreibt") geliefert
 * hat, bevor ein Mensch ihn im Schreibfenster weiter bearbeitet hat. Beide
 * Wege münden hier in dieselbe Rechnung — es gibt nur EINE Stelle, die
 * entscheidet, was „bearbeitet" heißt.
 */
export function kiHerkunft(textKi: string | null | undefined, gesendet: string): KiHerkunft | null {
  if (!textKi) return null;
  return veraenderung(textKi, gesendet) === 0 ? 'ki' : 'ki_bearbeitet';
}

/**
 * Die Fußzeile für eine gegebene Herkunft und Sprache.
 *
 * Sprache: nur 'de' bekommt den deutschen Satz, jede andere den englischen —
 * dieselbe Rückfallregel wie zuvor schon in post-entwurf-ki.ts
 * (`kennzeichnungFuer()`, jetzt hier zusammengeführt). Der Server kennt für
 * eine dritte Sprache keinen geprüften Wortlaut mehr, seit die KI die
 * Kennzeichnung nicht mehr selbst in der Sprache der Antwort formuliert
 * (siehe post-ki.ts) — English statt eines geratenen Satzes ist die
 * ehrlichere Wahl.
 */
export function fussnoteFuer(art: KiHerkunft, sprache: string): string {
  if (art === 'ki') return sprache === 'de' ? KENNZEICHNUNG_DE : KENNZEICHNUNG_EN;
  return sprache === 'de' ? KENNZEICHNUNG_BEARBEITET_DE : KENNZEICHNUNG_BEARBEITET_EN;
}
