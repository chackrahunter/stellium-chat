import fs from 'node:fs';
import { umschlagLesen, type DateiHuelle, type DateiUmschlag } from '@stellium/shared';

/**
 * Wie der Server erkennt, dass eine Datei verschlüsselt ist.
 *
 * Diese Datei ist das Gegenstück zu `crypto/vertraulich.ts`: auch hier steht
 * kein Schlüssel und keine Entschlüsselung. Übrig bleibt eine einzige Frage —
 * liegt hier Chiffrat oder Klartext?
 *
 * Beantwortet wird sie **am Inhalt** und nicht an einer Angabe des Clients.
 * Das ist der ganze Punkt. Ein Formularfeld "privat=1" wäre eine Behauptung,
 * und eine Zusage, die auf einer Behauptung ruht, ist keine: eine ältere App,
 * eine selbstgebaute, ein Tippfehler im Formular — und die Datei läge offen da,
 * während überall "privat" danebenstünde. Der Umschlag am Anfang der Datei
 * lässt sich dagegen nicht vortäuschen, ohne die Datei tatsächlich zu
 * verschlüsseln: er trägt einen verpackten Schlüssel und einen verschlossenen
 * Kopf, und beides muss beim Öffnen aufgehen.
 *
 * Es ist derselbe Gedanke wie bei `istE2EChiffrat` für Nachrichtentexte, nur
 * eine Ebene gründlicher — dort genügt eine Kennung am Anfang, hier wird die
 * ganze Wegbeschreibung gelesen und auf Form geprüft.
 */

/* Wie weit in die Datei hineingesehen wird, um den Umschlag zu finden. Er ist
   die erste Zeile und misst je nach Hülle 300 bis 500 Byte; vier Kilobyte sind
   reichlich Luft und trotzdem ein einziger Lesevorgang. */
const KOPF_FENSTER = 4096;

/** Die erste Zeile einer Datei — oder null, wenn keine da ist. */
function ersteZeile(pfad: string): string | null {
  let griff: number | null = null;
  try {
    griff = fs.openSync(pfad, 'r');
    const puffer = Buffer.alloc(KOPF_FENSTER);
    const gelesen = fs.readSync(griff, puffer, 0, KOPF_FENSTER, 0);
    const ende = puffer.subarray(0, gelesen).indexOf(0x0a);
    /* Kein Zeilenumbruch im Fenster heißt: das ist kein Umschlag. Eine echte
       verschlüsselte Datei hat ihn weit vorher — und eine beliebige andere
       Datei ohne Zeilenumbruch als ganzen Kopf zu lesen wäre der Anfang
       davon, hier doch wieder Inhalt anzusehen. */
    if (ende < 0) return null;
    return puffer.subarray(0, ende).toString('utf8');
  } catch {
    return null;
  } finally {
    if (griff !== null) { try { fs.closeSync(griff); } catch { /* schon zu */ } }
  }
}

/**
 * Der Umschlag einer Datei auf der Platte — oder null, wenn sie offen daliegt.
 */
export function umschlagVonDatei(pfad: string): DateiUmschlag | null {
  return umschlagLesen(ersteZeile(pfad), (s) => Buffer.from(s, 'base64url').toString('utf8'));
}

/** Die Hülle als Zeichenkette für die Datenbankspalte. */
export function huelleSchreiben(umschlag: DateiUmschlag | null): string | null {
  return umschlag ? JSON.stringify(umschlag.huelle) : null;
}

/** Umkehrung — die Hülle aus der Spalte. */
export function huelleLesen(wert: string | null | undefined): DateiHuelle | null {
  if (!wert) return null;
  try {
    const h = JSON.parse(wert) as DateiHuelle;
    if (h?.art === 'kanal' && h.channelId && Number.isInteger(h.fassung)) return h;
    if (h?.art === 'konto' && h.userId) return h;
    return null;
  } catch {
    return null;
  }
}
