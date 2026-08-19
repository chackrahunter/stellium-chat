import crypto from 'node:crypto';
import { abdruck } from './nachrichten.js';

/**
 * Was der Server bei der Ende-zu-Ende-Verschlüsselung tun darf.
 *
 * Bemerkenswert an dieser Datei ist, was nicht darin steht: kein Schlüssel,
 * keine Entschlüsselung, kein Zugriff auf irgendeinen Klartext. Bei
 * `nachrichten.ts` ist der Server der Schlüsselinhaber — dort schützt die
 * Verschlüsselung gegen den gestohlenen Datenträger, nicht gegen den Server
 * selbst. Hier ist er das ausdrücklich nicht: geschützt wird gegen ihn.
 *
 * Übrig bleibt genau eine Aufgabe — festzustellen, ob jemand einen Code kennt,
 * ohne den Code zu kennen.
 */

/**
 * Der Abdruck, unter dem ein Freigabecode in der Datenbank steht.
 *
 * Hereingereicht wird bereits ein Abdruck aus der App (SHA-256 über den Code),
 * nie der Code selbst. Darüber kommt noch der Hausschlüssel: sechs Zeichen aus
 * einunddreißig sind knapp neunhundert Millionen Möglichkeiten, und die hat
 * eine Grafikkarte in Sekunden durch. Mit dem Hausschlüssel als Grundlage
 * bringt der gestohlene Datenbankinhalt allein niemanden weiter.
 *
 * Selbst wer beides bricht, hat damit noch nichts geöffnet — das freigegebene
 * Paket ist zusätzlich für den privaten Schlüssel der Verwaltung verschlossen,
 * und der liegt nicht auf dem Server.
 */
export function freigabeAbdruck(abdruckAusApp: string): string {
  return abdruck(`freigabe:${abdruckAusApp}`);
}

/**
 * Vergleich ohne Zeitverrat.
 *
 * Ein gewöhnliches === bricht beim ersten abweichenden Zeichen ab. Wer die
 * Antwortzeit misst, kann den erwarteten Wert daran Zeichen für Zeichen
 * ablesen, statt ihn zu raten.
 */
export function gleich(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Ein Freigabecode in der Form K7M-2QX.
 *
 * Erzeugt wird er hier, damit er aus einer geprüften Zufallsquelle stammt —
 * ausgegeben wird er ausschließlich an die meldende Person, und gespeichert
 * wird er nie. Verwendet der Client einen eigenen Code, ist das genauso
 * richtig; der Server erfährt in beiden Fällen nur den Abdruck.
 */
export function freigabeCodeErzeugen(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const zeichen = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]);
  return `${zeichen.slice(0, 3).join('')}-${zeichen.slice(3).join('')}`;
}
