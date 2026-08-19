/**
 * Gemeinsame Sprache für vertrauliche Kanäle und private Dateien.
 *
 * Server und App müssen sich über die Form der Chiffrate einig sein, ohne
 * dass der Server je einen Schlüssel besitzt. Deshalb liegt hier nur das
 * Vokabular: wie ein Chiffrat aussieht, woran man es erkennt, wie ein
 * Freigabecode gebaut ist. Gerechnet wird auf beiden Seiten woanders — in der
 * App mit der Web Crypto API, auf dem Server gar nicht.
 *
 * Diese Datei wird auch im Browser geladen. Deshalb steht hier nichts aus
 * node:crypto, sondern ausschließlich Zeichenkettenarbeit.
 */

/**
 * Kennung am Anfang jedes Ende-zu-Ende-Chiffrats.
 *
 * Sie steht bewusst vorn und nicht in einer eigenen Spalte: der Server reicht
 * Nachrichtentexte durch Dutzende Stellen, und an jeder davon muss ohne
 * Zusatzwissen erkennbar sein, dass hier nichts Lesbares steht. Eine Spalte
 * hätte man an einer dieser Stellen vergessen.
 */
export const E2E_PREFIX = 'e1:';

/** Dasselbe für Dateien. Eigene Kennung, weil das Format ein anderes ist. */
export const E2E_DATEI_PREFIX = 'd1:';

/**
 * Ist das ein Ende-zu-Ende-Chiffrat?
 *
 * Der Server benutzt das als Sicherung: was so aussieht, darf nicht an
 * Übersetzung, Zusammenfassung oder Volltextindex weitergereicht werden. Die
 * Prüfung am Kanal wäre der genauere Weg, aber sie hilft nicht, wenn eine
 * Nachricht aus einem vertraulichen Kanal weitergereicht wird — hier greift
 * sie am Inhalt selbst.
 */
export function istE2EChiffrat(text: string | null | undefined): boolean {
  return Boolean(text && text.startsWith(E2E_PREFIX));
}

/**
 * Nutzlast einer verschlüsselten Nachricht.
 *
 * `fassung` sagt, mit welcher Fassung des Kanalschlüssels sie verschlossen
 * wurde. Ohne diese Angabe wäre jede Schlüsselrotation ein Bruch: alte
 * Nachrichten ließen sich nach dem Entfernen eines Mitglieds nicht mehr lesen,
 * obwohl der alte Schlüssel noch in jeder App liegt.
 */
export interface E2ENutzlast {
  fassung: number;
  iv: string;
  daten: string;
}

/** E2ENutzlast → "e1:<fassung>:<iv>:<daten>". */
export function nutzlastSchreiben(n: E2ENutzlast): string {
  return `${E2E_PREFIX}${n.fassung}:${n.iv}:${n.daten}`;
}

/** Umkehrung. Gibt null zurück, wenn die Form nicht stimmt. */
export function nutzlastLesen(text: string | null | undefined): E2ENutzlast | null {
  if (!istE2EChiffrat(text)) return null;
  const teile = (text as string).slice(E2E_PREFIX.length).split(':');
  if (teile.length !== 3) return null;
  const fassung = Number(teile[0]);
  if (!Number.isInteger(fassung) || fassung < 1) return null;
  if (!teile[1] || !teile[2]) return null;
  return { fassung, iv: teile[1], daten: teile[2] };
}

/**
 * Ein für ein einzelnes Konto verpackter Schlüssel.
 *
 * `von` ist das Konto, dessen öffentlicher Teil beim Aushandeln mitgewirkt hat.
 * Ohne diese Angabe könnte die empfangende App das gemeinsame Geheimnis nicht
 * nachbilden — sie wüsste nicht, mit wem sie es teilt.
 */
export interface SchluesselPaket {
  /** Immer "ecdh-p256+aes-gcm". Steht mit dabei, damit ein späterer Wechsel
   *  des Verfahrens alte Pakete nicht unlesbar macht, sondern erkennbar. */
  alg: string;
  von: string;
  iv: string;
  daten: string;
}

export const PAKET_ALG = 'ecdh-p256+aes-gcm';

/**
 * Zeichenvorrat für Freigabecodes und Wiederherstellungscodes.
 *
 * Ohne 0/O und 1/I/L, weil beide Codes vorgelesen oder abgeschrieben werden —
 * derselbe Grund wie beim Einmal-Passwort in services/users.ts.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Form eines Freigabecodes: zwei Dreiergruppen, z.B. K7M-2QX. */
export const FREIGABE_CODE_MUSTER = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{3}$/;

/**
 * Codes werden vorgelesen, und dabei geht die Groß-/Kleinschreibung verloren.
 * Der Bindestrich auch. Beides hier einfangen, statt es der eintippenden
 * Person als Fehler zurückzugeben.
 */
export function codeNormalisieren(roh: string): string {
  const sauber = (roh ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return sauber.length === 6 ? `${sauber.slice(0, 3)}-${sauber.slice(3)}` : sauber;
}

export function istFreigabeCode(roh: string): boolean {
  return FREIGABE_CODE_MUSTER.test(codeNormalisieren(roh));
}

/**
 * Wiederherstellungscode: sechs Vierergruppen.
 *
 * Er schützt den privaten Schlüssel eines ganzen Kontos und muss deshalb
 * deutlich mehr aushalten als ein Freigabecode, der nur wenige Tage gilt und
 * bei falscher Eingabe schnell gesperrt wird. 31^24 liegt jenseits von allem,
 * was sich durchprobieren lässt.
 */
export const WIEDERHERSTELLUNG_GRUPPEN = 6;
export const WIEDERHERSTELLUNG_GRUPPENLAENGE = 4;

export function wiederherstellungNormalisieren(roh: string): string {
  const sauber = (roh ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const teile: string[] = [];
  for (let i = 0; i < sauber.length; i += WIEDERHERSTELLUNG_GRUPPENLAENGE) {
    teile.push(sauber.slice(i, i + WIEDERHERSTELLUNG_GRUPPENLAENGE));
  }
  return teile.join('-');
}

export function istWiederherstellungscode(roh: string): boolean {
  const sauber = (roh ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (sauber.length !== WIEDERHERSTELLUNG_GRUPPEN * WIEDERHERSTELLUNG_GRUPPENLAENGE) return false;
  return [...sauber].every((z) => CODE_ALPHABET.includes(z));
}

/* ── Freigaben bei Vorfällen ──────────────────────────────────── */

/** Wie lange eine Freigabe gilt, wenn niemand etwas anderes wählt. */
export const FREIGABE_TAGE_VORGABE = 14;
export const FREIGABE_TAGE_HOECHSTENS = 90;

/**
 * Wie oft ein Code falsch eingegeben werden darf.
 *
 * Sechs Zeichen aus 31 sind knapp neunhundert Millionen Möglichkeiten — für
 * einen Menschen unerreichbar, für ein Skript nicht. Nach acht Fehlversuchen
 * ist die Freigabe deshalb verbrannt und muss neu erteilt werden.
 */
export const FREIGABE_VERSUCHE = 8;

export interface Freigabe {
  id: string;
  channelId: string;
  /** Fassung des Kanalschlüssels, die freigegeben wurde. */
  fassung: number;
  /** Wer den Vorfall gemeldet hat. */
  melderId: string;
  grund: string;
  erstelltAm: number;
  laeuftAb: number;
  zurueckgenommenAm: number | null;
  /** Wie viele Fehlversuche der Code schon hatte. */
  fehlversuche: number;
  /** Nur für die meldende Person: der Code steht sonst nirgends mehr. */
  code?: string;
}

/** Was die Verwaltung nach Eingabe des Codes bekommt. */
export interface FreigabeSchluessel {
  freigabeId: string;
  channelId: string;
  fassung: number;
  /** Doppelt verschlossen: außen der Code, innen der eigene Schlüssel. */
  paket: SchluesselPaket;
}

/* ── Öffentliche Schlüssel ────────────────────────────────────── */

export interface OeffentlicherSchluessel {
  userId: string;
  /** JWK des öffentlichen ECDH-Teils, als Zeichenkette. */
  jwk: string;
  /**
   * Kurzer Abdruck zum Vorlesen. Wer sichergehen will, dass niemand
   * dazwischensitzt, vergleicht ihn mündlich — der Server könnte sonst einen
   * eigenen Schlüssel unterschieben und mitlesen.
   */
  abdruck: string;
  erstelltAm: number;
}

/**
 * Was in einem vertraulichen Kanal abgeschaltet ist.
 *
 * Die Liste steht hier und nicht verstreut im Server, damit die Oberfläche
 * dieselbe Auskunft geben kann, die der Server durchsetzt — und damit beim
 * Hinzufügen einer neuen KI-Funktion auffällt, dass sie hier fehlt.
 */
export const VERTRAULICH_ABGESCHALTET = [
  'uebersetzung', 'zusammenfassung', 'antwortvorschlaege',
  'serversuche', 'aufgabenerkennung', 'assistent', 'linkvorschau', 'transkript',
] as const;
export type VertraulichAbgeschaltet = (typeof VERTRAULICH_ABGESCHALTET)[number];
