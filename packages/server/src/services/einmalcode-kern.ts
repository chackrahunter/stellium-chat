/**
 * Die Rechnung hinter einem Einmalcode — RFC 6238 (TOTP) auf RFC 4226 (HOTP),
 * das Geheimnis in Base32 nach RFC 4648.
 *
 * DIESE DATEI KENNT DAS ÜBRIGE HAUS NICHT. Keine Datenbank, keine
 * Einstellungen, kein Fastify — nur `node:crypto`. Das ist Absicht: eine reine
 * Rechnung lässt sich gegen die Prüfwerte der RFC halten, ohne einen Server zu
 * starten (scripts/einmalcode-pruefen.mjs tut genau das). Alles, was Zustand
 * hat, steht in services/einmalcode.ts daneben.
 *
 * WARUM KEIN FREMDES PAKET
 *
 * Das Haus verzichtet bewusst auf native Bausteine, und `node:crypto` bringt
 * HMAC über SHA-1, SHA-256 und SHA-512 mit. Übrig bleiben eine Base32-Lesung
 * und zwanzig Zeilen Abschneiderei — dafür eine Abhängigkeit aufzunehmen,
 * die den zweiten Faktor des Unternehmens in die Finger bekommt, wäre der
 * schlechtere Tausch.
 *
 * DIE STELLE, AN DER MAN SICH VERTUT
 *
 * Anhang B der RFC 6238 nennt im Fließtext EIN Geheimnis
 * ("12345678901234567890", 20 Byte) und listet darunter Prüfwerte für SHA-1,
 * SHA-256 UND SHA-512. Das ist irreführend: der Java-Code in Anhang A
 * derselben RFC verwendet drei verschiedene Schlüssel — 20, 32 und 64 Byte,
 * jeweils "1234567890" so oft wiederholt, bis die Blocklänge des Verfahrens
 * voll ist. Wer mit dem 20-Byte-Schlüssel gegen die SHA-256-Zeile prüft,
 * bekommt eine sechsstellige Zahl, die völlig richtig AUSSIEHT und falsch
 * ist. Siehe scripts/einmalcode-pruefen.mjs, dort stehen alle drei.
 *
 * Zweite Stelle: der Versatz für das Abschneiden kommt aus dem LETZTEN Byte
 * des Hashwerts, nicht aus Byte 19. Bei SHA-1 ist das dasselbe (20 Byte), bei
 * SHA-256 und SHA-512 nicht — `hash[hash.length - 1] & 0xf`, so steht es auch
 * im Referenzcode der RFC.
 */
import crypto from 'node:crypto';

/** Die drei Verfahren, die RFC 6238 zulässt. */
export const HASHVERFAHREN = ['SHA1', 'SHA256', 'SHA512'] as const;
export type Hashverfahren = (typeof HASHVERFAHREN)[number];

/** Voreinstellungen nach RFC 6238 und dem Key-Uri-Format — Google nutzt genau die. */
export const VORGABE_ALGORITHMUS: Hashverfahren = 'SHA1';
export const VORGABE_STELLEN = 6;
export const VORGABE_PERIODE = 30;

/** Was ein Code braucht: Geheimnis und die drei Kennzahlen. */
export interface Einmalcodevorgabe {
  /** Das gemeinsame Geheimnis in Base32 — so, wie der Dienst es ausgibt. */
  geheimnisBase32: string;
  algorithmus: Hashverfahren;
  stellen: number;
  periode: number;
}

/* ── Base32 (RFC 4648, Tabelle 3) ─────────────────────────────── */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/* Rückwärts: Zeichen → Wert. Einmal gebaut statt bei jedem Aufruf indexOf. */
const WERT = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i += 1) WERT.set(ALPHABET[i], i);

export class Base32Fehler extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base32Fehler';
  }
}

/**
 * Base32 → Bytes.
 *
 * Nachsichtig genau dort, wo Menschen und Dienste tatsächlich abweichen:
 *
 *   · **Kleinbuchstaben.** Das Alphabet ist groß, aber niemand tippt so ab.
 *   · **Leerzeichen und Bindestriche.** Google druckt das Geheimnis in
 *     Vierergruppen ("abcd efgh ijkl mnop"); wer es markiert und einfügt,
 *     bringt die Lücken mit. Auch Zeilenumbrüche fliegen raus.
 *   · **Füllzeichen.** Das Key-Uri-Format sagt ausdrücklich, "=" solle
 *     weggelassen werden — vorhanden ist es trotzdem oft genug.
 *
 * NICHT nachsichtig bei einem falschen Zeichen: "0", "1" und "8" gibt es im
 * Alphabet nicht (sie sehen O, I/L und B zu ähnlich). Wer sie schickt, hat
 * sich vertippt oder eine andere Kodierung erwischt — dann ist ein Fehler
 * ehrlicher als ein Geheimnis, das stillschweigend anders lautet als gemeint
 * und jeden Code falsch macht, ohne dass irgendwo etwas kaputt aussieht.
 */
export function ausBase32(text: string): Buffer {
  const sauber = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!sauber) throw new Base32Fehler('Leeres Geheimnis');

  const bytes: number[] = [];
  let sammler = 0;
  let bits = 0;
  for (const zeichen of sauber) {
    const wert = WERT.get(zeichen);
    if (wert === undefined) {
      /* Nur die STELLE nennen, nie den Rest — diese Zeichenkette ist das
         Geheimnis. Ein Fehlertext, der es mitschleppt, landet im Protokoll
         und in der Oberfläche. */
      throw new Base32Fehler(`Ungültiges Base32-Zeichen an Stelle ${sauber.indexOf(zeichen) + 1}`);
    }
    sammler = (sammler << 5) | wert;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((sammler >> bits) & 0xff);
    }
  }
  if (!bytes.length) throw new Base32Fehler('Geheimnis zu kurz');
  /* Die letzten ein bis vier Bits sind Auffüllung und gehören verworfen —
     RFC 4648, Abschnitt 6: eine Base32-Eingabe ist immer eine ganze Zahl
     von Oktetten, der Rest ist mit Nullen aufgefüllt. */
  return Buffer.from(bytes);
}

/* ── HOTP (RFC 4226, Abschnitt 5.3) ───────────────────────────── */

/** 10^n für n = 0…8, wie DIGITS_POWER im Referenzcode der RFC. */
const ZEHNERPOTENZ = [1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000];

const KRYPTONAME: Record<Hashverfahren, string> = {
  SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512',
};

/**
 * Ein Code zu einem Zählerstand.
 *
 * Der Zähler geht als 8 Byte in Netzreihenfolge in den HMAC — deshalb BigInt
 * und nicht `number`: `2^53` reicht heute zwar bequem, aber die Schreibweise
 * mit `writeBigUInt64BE` sagt selbst, dass hier acht Byte gemeint sind, und
 * kann bei keiner Periodenlänge überlaufen.
 */
export function hotp(
  geheimnis: Buffer, zaehler: bigint, stellen: number, algorithmus: Hashverfahren,
): string {
  const block = Buffer.alloc(8);
  block.writeBigUInt64BE(zaehler);
  const hash = crypto.createHmac(KRYPTONAME[algorithmus], geheimnis).update(block).digest();

  /* Dynamisches Abschneiden: die niedrigen vier Bits des LETZTEN Bytes sagen,
     wo die vier Byte anfangen. Bei SHA-256/512 ist das nicht Byte 19 —
     siehe Dateikopf. */
  const versatz = hash[hash.length - 1] & 0x0f;
  const zahl = ((hash[versatz] & 0x7f) << 24)
    | ((hash[versatz + 1] & 0xff) << 16)
    | ((hash[versatz + 2] & 0xff) << 8)
    | (hash[versatz + 3] & 0xff);

  return String(zahl % ZEHNERPOTENZ[stellen]).padStart(stellen, '0');
}

/* ── TOTP (RFC 6238, Abschnitt 4) ─────────────────────────────── */

/**
 * Die laufende Nummer des Zeitfensters: `T = (Unixzeit - T0) / X`, mit T0 = 0
 * und X = Periodenlänge. Ganzzahlig abgerundet — RFC 6238, Abschnitt 4.2.
 */
export function periodenNummer(sekunden: number, periode: number): bigint {
  return BigInt(Math.floor(sekunden / periode));
}

/** Wie viele Sekunden das laufende Fenster noch gilt (1 … periode). */
export function restSekunden(sekunden: number, periode: number): number {
  return periode - (Math.floor(sekunden) % periode);
}

/** Der Code zu einem Zeitpunkt (Unix-SEKUNDEN, nicht Millisekunden). */
export function totp(vorgabe: Einmalcodevorgabe, sekunden: number): string {
  return hotp(
    ausBase32(vorgabe.geheimnisBase32),
    periodenNummer(sekunden, vorgabe.periode),
    vorgabe.stellen,
    vorgabe.algorithmus,
  );
}

/**
 * Mehrere aufeinanderfolgende Codes auf einmal — ab dem Fenster von
 * `sekunden`, dann `anzahl - 1` weitere.
 *
 * Das Geheimnis wird dafür EINMAL gelesen statt je Code, und der Aufrufer
 * bekommt zu jedem Code die Nummer seines Fensters mit. Wozu ein Vorrat gut
 * ist, steht in services/einmalcode.ts (Stichwort: ohne Verbindung).
 */
export function codeReihe(
  vorgabe: Einmalcodevorgabe, sekunden: number, anzahl: number,
): Array<{ fenster: string; code: string; gueltigAbMs: number; gueltigBisMs: number }> {
  const schluessel = ausBase32(vorgabe.geheimnisBase32);
  const start = periodenNummer(sekunden, vorgabe.periode);
  const reihe = [];
  for (let i = 0; i < anzahl; i += 1) {
    const fenster = start + BigInt(i);
    reihe.push({
      /* Als Zeichenkette: JSON kennt kein BigInt, und `JSON.stringify` wirft
         darüber, statt es zu runden — ein Fehler, der erst in der Antwort
         auffiele. */
      fenster: fenster.toString(),
      code: hotp(schluessel, fenster, vorgabe.stellen, vorgabe.algorithmus),
      gueltigAbMs: Number(fenster) * vorgabe.periode * 1000,
      gueltigBisMs: (Number(fenster) + 1) * vorgabe.periode * 1000,
    });
  }
  return reihe;
}

/* ── otpauth:// (Key-Uri-Format) ──────────────────────────────── */

export class UriFehler extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UriFehler';
  }
}

export interface GeleseneUri extends Einmalcodevorgabe {
  /** Wer den Zugang stellt — "Google", "GitHub". Aus `issuer=` oder dem Etikett. */
  aussteller: string;
  /** Welches Konto — meist die Mailadresse. Aus dem Etikett hinter dem Doppelpunkt. */
  konto: string;
}

/** Ein Verfahren aus fremder Schreibweise — "sha-256", "SHA256", "Sha512". */
export function algorithmusLesen(roh: string | null | undefined): Hashverfahren {
  if (!roh) return VORGABE_ALGORITHMUS;
  const norm = roh.replace(/[\s-]/g, '').toUpperCase();
  const treffer = HASHVERFAHREN.find((h) => h === norm);
  if (!treffer) throw new UriFehler(`Unbekanntes Verfahren: ${norm}`);
  return treffer;
}

/**
 * Stellenzahl prüfen. RFC 4226 verlangt mindestens sechs; das Key-Uri-Format
 * nennt 6 und 8. Sieben kommt bei einzelnen Diensten vor und kostet nichts,
 * mehr als acht sprengt die Zehnerpotenz-Tabelle der RFC.
 */
export function stellenLesen(roh: string | null | undefined): number {
  if (roh === null || roh === undefined || roh === '') return VORGABE_STELLEN;
  const n = Number(roh);
  if (!Number.isInteger(n) || n < 6 || n > 8) throw new UriFehler(`Ungültige Stellenzahl: ${roh}`);
  return n;
}

/**
 * Periodenlänge prüfen. Voreinstellung 30 Sekunden (RFC 6238 EMPFIEHLT genau
 * die). Die Obergrenze ist willkürlich weit gewählt — sie soll nur einen
 * Zahlendreher abfangen, keine Meinung über brauchbare Werte äußern.
 */
export function periodeLesen(roh: string | null | undefined): number {
  if (roh === null || roh === undefined || roh === '') return VORGABE_PERIODE;
  const n = Number(roh);
  if (!Number.isInteger(n) || n < 5 || n > 600) throw new UriFehler(`Ungültige Periode: ${roh}`);
  return n;
}

/**
 * Das Etikett zerlegen: `aussteller:konto`, mit dem Doppelpunkt buchstäblich
 * oder als `%3A`, gefolgt von beliebig vielen Leerzeichen.
 *
 * Geteilt wird VOR dem Dekodieren und nur am ERSTEN Trenner. Beides steht so
 * in der ABNF des Key-Uri-Formats: weder Aussteller noch Kontoname dürfen
 * selbst einen Doppelpunkt tragen, also gehört alles hinter dem ersten zum
 * Kontonamen. Andersherum — erst dekodieren, dann teilen — würde ein `%3A`
 * IM Kontonamen zu einem zweiten Trenner, und aus
 * "Big Corporation: alice@bigco.com" wäre der Aussteller "Big Corporation"
 * mit dem Konto " alice@bigco.com" geworden statt umgekehrt etwas Falsches.
 */
function etikettZerlegen(roh: string): { aussteller: string; konto: string } {
  const treffer = /:|%3A/i.exec(roh);
  if (!treffer) return { aussteller: '', konto: entschaerft(roh) };
  const vorne = roh.slice(0, treffer.index);
  /* `*"%20"` in der ABNF: die Leerzeichen hinter dem Doppelpunkt gehören
     nicht zum Kontonamen. Erst nach dem Dekodieren zu entfernen wäre falsch,
     wenn ein Name absichtlich mit einem Leerzeichen begänne — den Fall gibt
     es nicht, aber die Reihenfolge kostet nichts. */
  const hinten = roh.slice(treffer.index + treffer[0].length).replace(/^(?:%20|\s)+/i, '');
  return { aussteller: entschaerft(vorne), konto: entschaerft(hinten) };
}

/**
 * Prozentkodierung auflösen — und eine kaputte Kodierung nicht zum Absturz
 * werden lassen. `decodeURIComponent('%zz')` wirft; ein Etikett ist Beiwerk,
 * und daran soll das Einlesen eines gültigen Geheimnisses nicht scheitern.
 */
function entschaerft(roh: string): string {
  try {
    return decodeURIComponent(roh).trim();
  } catch {
    return roh.trim();
  }
}

/**
 * Eine `otpauth://totp/...`-Adresse lesen — das, was hinter dem QR-Code von
 * Googles Einrichtungsseite steckt.
 *
 * Warum überhaupt: das Geheimnis von Hand abzutippen ist die eine Stelle, an
 * der ein einzelner Buchstabendreher einen Code erzeugt, der richtig
 * aussieht und nie stimmt — und niemand weiß, woran es lag. Eine Adresse
 * fügt man am Stück ein.
 *
 * `hotp` wird ausdrücklich ABGEWIESEN und nicht stillschweigend als `totp`
 * gelesen: ein zählerbasierter Code, gegen die Uhr gerechnet, ist immer
 * falsch — und diese Tafel hat keinen Zähler.
 */
export function otpauthLesen(roh: string): GeleseneUri {
  const text = roh.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UriFehler('Keine gültige Adresse');
  }
  if (url.protocol.toLowerCase() !== 'otpauth:') throw new UriFehler('Keine otpauth-Adresse');

  /* Bei einem fremden Schema steht die Art in der Rolle des Rechnernamens:
     otpauth://totp/… → host "totp". */
  const art = url.host.toLowerCase();
  if (art === 'hotp') throw new UriFehler('Zählerbasierte Codes (hotp) kennt diese Tafel nicht');
  if (art !== 'totp') throw new UriFehler(`Unbekannte Art: ${art || '(keine)'}`);

  const geheimnisBase32 = (url.searchParams.get('secret') ?? '').trim();
  if (!geheimnisBase32) throw new UriFehler('In der Adresse steht kein secret');
  /* Einmal probeweise lesen: lieber hier scheitern, wo die Meldung „diese
     Adresse taugt nicht" heißt, als später beim ersten Code. Das Ergebnis
     wird verworfen — gebraucht wird nur die Gegenprobe. */
  ausBase32(geheimnisBase32);

  const { aussteller: ausEtikett, konto } = etikettZerlegen(url.pathname.replace(/^\//, ''));
  /* Steht `issuer=` dabei, gilt es. Das Key-Uri-Format sagt: sind beide da,
     sollten sie gleich lauten, und neuere Programme richten sich nach dem
     Feld. Nur das Feld kann einen Doppelpunkt tragen (im Etikett wäre er der
     Trenner) — deshalb ist es auch die einzige Stelle, an der ein Aussteller
     wie "Firma: Technik" heil ankommt. */
  const ausFeld = (url.searchParams.get('issuer') ?? '').trim();

  return {
    geheimnisBase32,
    aussteller: ausFeld || ausEtikett,
    konto,
    algorithmus: algorithmusLesen(url.searchParams.get('algorithm')),
    stellen: stellenLesen(url.searchParams.get('digits')),
    periode: periodeLesen(url.searchParams.get('period')),
  };
}

/**
 * Was jemand in das Feld geschrieben hat — eine ganze `otpauth://`-Adresse
 * oder das nackte Geheimnis in Base32.
 *
 * Beides muss gehen: Googles Einrichtungsseite bietet den QR-Code (dahinter
 * die Adresse) UND darunter den Text zum Abschreiben. Wer den Text nimmt, hat
 * keine Adresse, und ihn zu einer zusammenzubauen wäre eine Zumutung.
 */
export function eingabeLesen(roh: string): GeleseneUri {
  const text = roh.trim();
  if (/^otpauth:/i.test(text)) return otpauthLesen(text);
  ausBase32(text);              // wirft, wenn es auch kein Geheimnis ist
  return {
    geheimnisBase32: text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase(),
    aussteller: '',
    konto: '',
    algorithmus: VORGABE_ALGORITHMUS,
    stellen: VORGABE_STELLEN,
    periode: VORGABE_PERIODE,
  };
}
