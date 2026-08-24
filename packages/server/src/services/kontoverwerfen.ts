import { db } from '../db/index.js';

/**
 * Das HARTE Verwerfen — an einer Stelle, die beide Aufrufer erreichen.
 *
 * WARUM DAS EINE EIGENE DATEI IST
 *
 * Zwei ganz verschiedene Vorgänge müssen dasselbe niederbrennen:
 *
 *   · services/kontoschluessel.ts, verwerfen() — ein Passwort wird gesetzt,
 *     ohne dass das bisherige bekannt war (Zurücksetzen, Ersteinrichtung).
 *   · services/notzugang.ts, aufheben() — die Rettungsleine wird gekappt,
 *     nachdem ein schonendes Verwerfen die Pakete stehen ließ.
 *
 * Der zweite Aufrufer ist der Grund für diese Datei. kontoschluessel.ts bindet
 * notzugang.ts schon ein (verwerfen() und hinterlegenInTransaktion() fragen
 * dort nach dem gedeckten Abdruck). Bände notzugang.ts nun umgekehrt
 * kontoschluessel.ts ein, hätten sich zwei Module gegenseitig eingebunden —
 * genau das, was einrichten() in services/notzugang.ts an einer anderen Stelle
 * schon einmal umgangen hat, indem es eine einzige Spalte direkt liest. Eine
 * dritte Datei, die keinen der beiden kennt, löst das ohne Wette auf die
 * Ladereihenfolge.
 *
 * ABGESCHRIEBEN WIRD HIER NICHTS. Die Tabellenliste steht genau einmal, und
 * das harte Verwerfen ebenso. Wer eine der beiden Hälften kopierte, hätte
 * dieselbe Lücke wie damals beim Passwort-Tresor: `notiz_konto_pakete` stand
 * seit dem ersten Tag da, `passwort_konto_pakete` kam später dazu und wurde an
 * der zweiten Stelle nie mitgeräumt.
 */

/**
 * ALLE Tabellen, deren Zeilen mit dem KONTOSCHLÜSSEL verpackt sind.
 *
 * Diese Liste ist der Kern der zweiten Hälfte des Versprechens aus
 * shared/vertraulich.ts (KontoPaket): der Server filtert beim Lesen nach
 * Fassung UND wirft beim Ersetzen alles Alte weg. Der Lesefilter allein
 * genügt nicht — er entscheidet, was HERAUSGEGEBEN wird, nicht, was in der
 * Datenbank STEHT. Eine liegengebliebene Zeile ist mit dem Kontoschlüssel
 * aus dem ALTEN Passwort verpackt: wer dieses Passwort kennt (nach einem
 * Zurücksetzen ist das genau die Lage, die man gerade beenden wollte) und an
 * eine Sicherung von vorher plus die heutige Platte kommt, leitet daraus die
 * alte KEK, daraus den alten Kontoschlüssel, daraus den Eintragsschlüssel ab
 * — und öffnet damit das HEUTIGE Chiffrat, denn `schluessel_fassung` eines
 * Eintrags wechselt nur beim Entfernen eines Mitglieds, nicht bei einem
 * Passwortwechsel.
 *
 * WER HIER EINE TABELLE ANLEGT, TRÄGT SIE HIER EIN. Genau das wurde beim
 * Passwort-Tresor vergessen: `notiz_konto_pakete` stand seit dem ersten Tag
 * da, `passwort_konto_pakete` kam später dazu und wurde nie mitgeräumt.
 * Die Liste ist deshalb eine Liste und keine zweite abgeschriebene
 * DELETE-Zeile — und pruefungen/passwort-tresor.mts prüft sie gegen die
 * Tabellen, die der Kontoweg tatsächlich beschreibt.
 */
const KONTO_PAKET_TABELLEN = ['notiz_konto_pakete', 'passwort_konto_pakete'] as const;

/** Für die Prüfläufe: dieselbe Liste, damit eine Probe sie nicht abschreiben muss. */
export const kontoPaketTabellen: readonly string[] = KONTO_PAKET_TABELLEN;

/**
 * Jedes Kontopaket dieser Person wegräumen — in JEDER Tabelle der Liste.
 *
 * Die Tabellennamen stammen ausschließlich aus der Konstante oben, nie aus
 * einer Eingabe; nur `user_id` ist ein gebundener Wert.
 */
export function kontoPaketeWegraeumen(userId: string): void {
  for (const tabelle of KONTO_PAKET_TABELLEN) {
    db.run(`DELETE FROM ${tabelle} WHERE user_id = ?`, userId);
  }
}

/**
 * Niederbrennen: jedes Kontopaket weg, `abdruck` leer, `fassung` eins weiter.
 *
 * Die ZEILE bleibt stehen, nur ihr Inhalt stirbt. Der Grund ist `fassung`:
 * verschwände die Zeile, finge ein späterer Kontoschlüssel wieder bei 1 an,
 * und ein liegengebliebenes Kontopaket aus einer früheren Runde sähe plötzlich
 * wieder aktuell aus. Die Pakete werden hier zwar ohnehin weggeräumt — aber
 * diese Sicherung soll nicht davon abhängen, dass das Wegräumen wirklich jede
 * Zeile erwischt hat.
 *
 * Auch `abdruck` wird geleert, und das ist keine Kosmetik: solange er
 * dastünde, erkennte hinterlegenInTransaktion() einen zurückkehrenden
 * Schlüssel weiterhin als „denselben" und ließe `fassung` stehen — unter der
 * dann nichts mehr liegt.
 *
 * Ohne eigene db.transaction(): läuft immer innerhalb der Transaktion des
 * Aufrufers (services/users.ts über verwerfen(), services/notzugang.ts über
 * aufheben()). Die Datenbankhülle hier im Haus kennt keine verschachtelten
 * Transaktionen — kein SAVEPOINT, siehe db/index.ts.
 */
export function hartVerwerfen(userId: string): void {
  const jetzt = Date.now();
  kontoPaketeWegraeumen(userId);
  db.run(
    `INSERT INTO konto_schluessel (user_id, kdf, salz, runden, alg, iv, daten, abdruck, fassung, erstellt_am, geaendert_am)
     VALUES (?,'','',0,'','','','',1,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       salz = '', runden = 0, iv = '', daten = '', abdruck = '',
       fassung = konto_schluessel.fassung + 1, geaendert_am = excluded.geaendert_am`,
    userId, jetzt, jetzt,
  );
}
