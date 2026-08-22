/**
 * Fehlschläge der KI in etwas verwandeln, das die Oberfläche übersetzen kann.
 *
 * Bis hierher ging der rohe Text des Anbieters hinaus. Don sah in der App ein
 * Meldungsfenster mit dem JSON von ollama darin — englisch, mit Token-Zahlen
 * und einem Ratschlag an den Betreiber („try increasing it"). Das ist keine
 * Meldung, das ist ein Protokollauszug.
 *
 * Und es blieb nicht bei Meldungsfenstern: scheiterte der Assistent, schrieb
 * der Gateway den Fehlertext als **Chat-Nachricht** in den Kanal — „Ich konnte
 * gerade nicht antworten: groq: fetch failed". Deshalb liegt diese Umsetzung
 * hier und nicht in einer einzelnen Datei: jeder Weg, der ein Modell fragt,
 * geht hindurch.
 *
 * Der deutsche Satz bleibt als Rückfall stehen, wie überall sonst (siehe
 * util/abweisung.ts). Die Kennungen stehen in packages/desktop/src/i18n/ in
 * allen 22 Sprachen; scripts/e2e-fehlertexte.mjs schlägt an, wenn eine davon
 * ins Leere zeigt.
 */
import { abweisung, Abweisung } from '../util/abweisung.js';
import { ProviderError } from './providers/types.js';
import { ausfallMelden } from './erreichbarkeit.js';

export function alsAbweisung(fehler: unknown): Abweisung {
  if (fehler instanceof Abweisung) return fehler;

  if (fehler instanceof ProviderError) {
    if (fehler.art === 'zuLang') {
      return abweisung('fehler.verlaufZuLang',
        'Der Verlauf ist zu lang für das eingestellte Modell. Bitte einen kleineren Ausschnitt wählen.',
        undefined, fehler);
    }
    if (fehler.art === 'zeit') {
      return abweisung('fehler.kiZeitueberschreitung',
        'Die KI hat nicht rechtzeitig geantwortet. Bitte noch einmal versuchen.',
        undefined, fehler);
    }
    if (fehler.art === 'ueberlastet') {
      return abweisung('fehler.kiUeberlastet',
        'Die KI ist gerade ausgelastet. Bitte gleich noch einmal versuchen.',
        undefined, fehler);
    }
    if (fehler.art === 'unerreichbar') {
      /* Auch der Assistent meldet den Ausfall — sonst wüsste nur die
         Übersetzung davon, und die Vertretung spränge erst ein, wenn
         zufällig jemand eine Nachricht schreibt. Beim nächsten Anlauf
         antwortet dann schon der Ersatzdienst. */
      ausfallMelden(fehler.message);
      return abweisung('fehler.kiUnerreichbar',
        'Die KI ist gerade nicht erreichbar — läuft das Modell?',
        undefined, fehler);
    }
  }

  /*
   * Zweiter Anlauf, ohne auf die Klasse zu bauen.
   *
   * Die Einordnung oben verlangt `instanceof ProviderError`. Das trägt
   * genau so weit, wie der Fehler seine Klasse behält — und im Betrieb tut
   * er das nicht immer: im Protokoll standen nebeneinander
   *   [ai] http://…/v1: keine Antwort.      (richtig eingeordnet)
   *   [ai] ollama: fetch failed             (hier gelandet)
   * für denselben Ausfall. Im Chat erschien dann „Die KI konnte das gerade
   * nicht erledigen" statt „läuft das Modell?" — und wer das liest, sucht
   * den Fehler bei sich statt am ausgeschalteten Rechner.
   *
   * Deshalb hier noch einmal am Text. Eine Meldung ist ein schlechteres
   * Merkmal als ein Feld, aber ein vorhandenes schlägt ein fehlendes.
   */
  const text = String((fehler as Error)?.message ?? fehler ?? '');
  const ursache = String((fehler as { cause?: unknown })?.cause ?? '');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|socket hang up|ETIMEDOUT|keine Antwort/i
      .test(`${text} ${ursache}`)) {
    ausfallMelden(text);
    return abweisung('fehler.kiUnerreichbar',
      'Die KI ist gerade nicht erreichbar — läuft das Modell?',
      undefined, fehler);
  }

  /* Der ursprüngliche Text geht nicht verloren — er steht im Protokoll des
     Servers, wo ihn jemand lesen kann, der ihn deuten kann. Beim Benutzer hat
     er nichts zu suchen.
     Mit Klasse und Art: landet hier noch einmal etwas, das eingeordnet
     gehört hätte, steht im Protokoll, WORAN die Einordnung scheiterte —
     und nicht nur, DASS sie scheiterte. */
  const art = (fehler as { art?: string })?.art ?? '—';
  const klasse = (fehler as object)?.constructor?.name ?? typeof fehler;
  console.error(`[ai] nicht eingeordnet (${klasse}, art=${art}):`, text || fehler);
  return abweisung('fehler.kiFehlgeschlagen', 'Die KI konnte das gerade nicht erledigen.',
    undefined, fehler);
}

/**
 * Jede Anfrage an ein Modell geht hier hindurch.
 *
 * Ein Fehlschlag muss beim Client ankommen — als Fehlschlag, mit einer
 * Kennung, nicht als roher Anbietertext und schon gar nicht als ausbleibende
 * Antwort.
 */
export async function mitKennung<T>(arbeit: () => Promise<T>): Promise<T> {
  try {
    return await arbeit();
  } catch (fehler) {
    throw alsAbweisung(fehler);
  }
}
