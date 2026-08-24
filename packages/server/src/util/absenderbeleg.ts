/**
 * Welchen BELEG es dafür gibt, dass eine Absenderadresse wirklich dem
 * gehört, der sie behauptet — für die Gruppe „intern"
 * (services/post-partnergruppen.ts).
 *
 * WARUM ES DIESE DATEI GIBT
 *
 * `mail_nachrichten.von` ist der `From:`-Kopf, nicht der Umschlagabsender —
 * db/schema.sql sagt es bei der Spalte selbst: „Der Umschlagabsender ist
 * NICHT der sichtbare. 'From:' steht im Mailprogramm, 'MAIL FROM' zaehlt
 * fuer SPF." Ein `From:`-Kopf ist frei erfunden, solange ihn niemand prüft:
 * jeder Fremde kann `From: <irgendwer>@<unsere-domaene>` schreiben. Ein
 * reiner Domänenvergleich auf diesem Feld beantwortet deshalb NICHT die
 * Frage „ist das ein Kollege?", sondern nur „behauptet der Absender, einer
 * zu sein?".
 *
 * Der Beleg, der die Lücke schließt, liegt längst daneben:
 * `mail_nachrichten.pruefung` — was Cloudflare zu SPF/DKIM/DMARC gemeldet
 * hat (services/post.ts, eingangAufnehmen()). DMARC ist genau die Prüfung,
 * die sich auf den `From:`-Kopf bezieht (SPF allein prüft den Umschlag und
 * sagt über `From:` nichts aus) — `dmarc=pass` ist also der eine Beleg, der
 * zur gestellten Frage passt.
 *
 * SIGNAL, NIE SPERRE. Diese Datei entscheidet NICHT, ob eine Mail
 * angenommen wird — das bleibt, wie es ist (schema.sql: „Als Signal, nie als
 * Sperre: Post zu verlieren waere schlimmer"). Sie entscheidet nur, ob eine
 * Adresse als Kollege GILT oder ob danach noch ein Mensch gefragt wird.
 *
 * ABGRENZUNG ZU istBestaetigt() IN services/post.ts: das dort beantwortet
 * eine schwächere Frage („trägt diese Mail überhaupt ein bestandenes DMARC?")
 * und bewacht damit das Einhängen in einen bestehenden Verlauf. Hier geht es
 * um mehr: der Beleg muss zu GENAU DIESER Adresse gehören, und ein
 * widersprüchlicher Beleg zählt als keiner. Deshalb eine eigene, strengere
 * Funktion statt eine gemeinsame, die an einer der beiden Stellen zu locker
 * oder zu streng wäre.
 *
 * EIGENE, ABHÄNGIGKEITSFREIE DATEI — wie util/domaene.ts, aus demselben
 * Grund: kein Zugriff auf `db`, keine Verschlüsselung, kein Import aus
 * `services/`. So bleibt sie ohne Datenbank und ohne Netz prüfbar
 * (pruefungen/partnergruppen.mts).
 */
import { istAdresseAufDomaene } from './domaene.js';

/**
 * Worauf eine automatische „intern"-Einordnung beruht.
 *
 *   · `dmarc`      — die Mail, die zu dieser Einordnung führte, trug ein
 *                    bestandenes DMARC für genau diese Absenderdomäne.
 *                    Belegt, nicht behauptet: gilt als Tatsache.
 *   · `ungeprueft` — die Domäne stimmt, aber der Beleg fehlt oder ist
 *                    durchgefallen. Kein Grund, die Mail wegzuwerfen, aber
 *                    auch keiner, den Absender ungefragt zum Kollegen zu
 *                    erklären: wird als VORSCHLAG eingetragen.
 *   · `altbestand` — Zeile aus der Zeit vor dieser Prüfung. Der Beleg ist
 *                    nicht etwa durchgefallen, er ist gar nicht mehr
 *                    feststellbar. Bewusst ein eigener Wert: „unbekannt" ist
 *                    nicht „durchgefallen", und ein Mensch soll den
 *                    Unterschied sehen können.
 */
export type AbsenderBeleg = 'dmarc' | 'ungeprueft' | 'altbestand';

/** Jedes Vorkommen von `dmarc=<wert>` im Prüfergebnis, klein geschrieben.
 *
 *  Wortgrenze davor (`(?:^|[\s;(])`), damit ein erfundener Schlüsselname wie
 *  `x-mein-dmarc=pass` nicht als DMARC-Ergebnis durchgeht. */
const DMARC_ERGEBNISSE = /(?:^|[\s;(])dmarc\s*=\s*([a-z]+)/gi;

/** Die Domäne, auf die sich das DMARC-Ergebnis bezieht (`header.from=…`). */
const KOPF_ABSENDER = /header\.from\s*=\s*"?([^\s;)"]+)"?/i;

/**
 * Ist BELEGT, dass diese Adresse tatsächlich von ihrer eigenen Domäne kam?
 *
 * Drei Bedingungen, alle nötig:
 *
 *  1. Es steht überhaupt ein DMARC-Ergebnis da. Fehlt `pruefung` (alte Mail,
 *     eigener Einlieferungsweg, Worker älterer Fassung), ist nichts belegt —
 *     `false`, ohne dass daraus „gefälscht" würde. Der Aufrufer entscheidet,
 *     was er mit „unbelegt" macht; hier wird nichts behauptet.
 *  2. JEDES gefundene DMARC-Ergebnis lautet `pass`. Der Cloudflare-Worker
 *     nimmt bereits nur die ERSTE `Authentication-Results`-Zeile, gerade weil
 *     ein Absender eine eigene mitschicken darf (siehe dort). Diese Regel ist
 *     die zweite Reihe dahinter: käme je eine zusammengefügte Kopfzeile hier
 *     an, stünde darin neben dem echten `dmarc=fail` das angehängte
 *     `dmarc=pass` des Fälschers — widersprüchliche Belege zählen als kein
 *     Beleg, statt dass der freundlichere gewinnt.
 *  3. Nennt das Ergebnis die geprüfte Absenderdomäne (`header.from=`), muss
 *     sie zu DIESER Adresse gehören. Sonst genügte ein zweiter `From:`-Kopf:
 *     der Mailparser läse den einen, DMARC hätte den anderen geprüft, und ein
 *     fremdes `pass` beglaubigte eine Adresse, für die es nie galt. Fehlt die
 *     Angabe, wird sie nicht erfunden — dann tragen Punkt 1 und 2 die
 *     Entscheidung.
 *
 * Der Domänenvergleich selbst ist derselbe wie überall sonst
 * (`istAdresseAufDomaene()`, util/domaene.ts): exakter Vergleich statt
 * `endsWith()`, klein geschrieben, Plus-Adressierung eingeschlossen — hier
 * mit einer Liste aus genau einem Eintrag, damit es NICHT zwei Fassungen
 * desselben Vergleichs gibt.
 */
export function absenderIstBelegt(adresse: string, pruefung: unknown): boolean {
  if (typeof pruefung !== 'string' || !pruefung) return false;

  let gefunden = 0;
  DMARC_ERGEBNISSE.lastIndex = 0; // /g ist zustandsbehaftet — sonst hinge das Ergebnis am vorigen Aufruf
  let treffer: RegExpExecArray | null;
  while ((treffer = DMARC_ERGEBNISSE.exec(pruefung))) {
    gefunden += 1;
    if (treffer[1].toLowerCase() !== 'pass') return false;
  }
  if (!gefunden) return false;

  const kopfAbsender = KOPF_ABSENDER.exec(pruefung)?.[1]?.trim().toLowerCase();
  if (kopfAbsender && !istAdresseAufDomaene(adresse, [kopfAbsender])) return false;

  return true;
}

/**
 * Der Beleg für eine laufend eingehende Mail — `altbestand` kommt hier nie
 * heraus, den vergibt nur der einmalige Nachtrag für Zeilen, deren Mail
 * niemand mehr zuordnen kann (siehe internBackfillEinmalig()).
 */
export function belegFuerEingang(adresse: string, pruefung: unknown): AbsenderBeleg {
  return absenderIstBelegt(adresse, pruefung) ? 'dmarc' : 'ungeprueft';
}
