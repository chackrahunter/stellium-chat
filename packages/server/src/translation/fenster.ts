/**
 * Wie viel Verlauf ein Modell überhaupt entgegennimmt — und wie man mehr
 * hineinbekommt, als hineinpasst.
 *
 * DER FEHLER, DER DAS AUSGELÖST HAT
 *
 *   ollama 400: {"error":{"code":400,"message":"request (10340 tokens)
 *   exceeds the available context size (8192 tokens), …
 *
 * Das „Protokoll" eines gut gefüllten Kanals nahm 400 Nachrichten, klebte sie
 * zu einem Text zusammen und schickte ihn ab — ohne je zu fragen, ob das
 * Gegenüber so viel annehmen kann. Für Groq mit 128k fiel das jahrelang nicht
 * auf; ein llama.cpp auf einem Windows-Rechner mit 8k Fenster beendet es in
 * der ersten Woche.
 *
 * WARUM NICHT EINFACH DAS FENSTER VERGRÖSSERN
 *
 * Weil es nicht unseres ist. Das Modell läuft bei jemand anderem
 * (Tailscale-Adresse, fremder Rechner, fremde Startparameter), und beim
 * nächsten Modell steht dort wieder eine andere Zahl. Eine Software, die nur
 * mit einer bestimmten fremden Einstellung läuft, ist nicht fertig. Also
 * fragen wir, wie groß das Fenster ist, ziehen einen Sicherheitsabstand ab und
 * passen hinein.
 *
 * WIE GEZÄHLT WIRD
 *
 * Ohne den Tokenizer des Modells lässt sich die Zahl nur schätzen — und eine
 * Schätzung, die zu niedrig liegt, ist genau der Fehler von oben. Deshalb wird
 * bewusst großzügig nach oben geschätzt:
 *
 *   · lateinische Schrift, Ziffern, Leerzeichen  →  3 Zeichen je Marke
 *   · alles andere (CJK, Kyrillisch, Arabisch,
 *     Emoji, Kennungen wie `msg_a1b2…`)          →  1 Zeichen je Marke
 *
 * Der zweite Fall ist der Grund für die Vorsicht: bei chinesischem Text ist
 * ein Zeichen oft eine ganze Marke, manchmal mehr, und der Verlauf in diesem
 * Haus ist mehrsprachig. An der echten Meldung nachgerechnet — 10.340 Marken
 * bei 33.216 Zeichen deutschem Chat — liegt diese Schätzung bei 11.072, also
 * 7 % über der Wahrheit. Genau so soll sie liegen.
 */

/** Kleinstes Fenster, mit dem wir überhaupt rechnen. */
export const KLEINSTES_FENSTER = 8192;

/**
 * Was neben dem Verlauf noch ins Fenster muss und hier nicht gezählt werden
 * kann: die Antwort des Modells, seine Denkschritte, der Aufschlag des
 * Chat-Formats um jede Nachricht herum. Ein fester Abschlag oben drauf, damit
 * eine Schätzung, die um ein paar Prozent danebenliegt, nicht gleich einen
 * Fehlschlag bedeutet.
 */
const ABSTAND_FEST = 512;
/** Und noch ein Anteil des Fensters — bei großen Fenstern ist der Aufschlag größer. */
const ABSTAND_ANTEIL = 0.08;

/** Nur lateinische Buchstaben, Ziffern, Leerraum und übliche Satzzeichen. */
const SPARSAM = /[\p{Script=Latin}\p{Nd}\s.,;:!?'"()\[\]{}\-–—/\\@#*_=+<>|~^$%&`]/u;

/**
 * Wie viele Marken dieser Text ungefähr kostet — nach oben geschätzt.
 *
 * Bewusst zeichenweise und nicht über eine Division durch die Gesamtlänge:
 * ein Verlauf, in dem ein deutscher und ein chinesischer Absatz nebeneinander
 * stehen, wird sonst nach dem Durchschnitt bewertet und damit für den
 * chinesischen Teil zu niedrig.
 */
export function markenSchaetzung(text: string): number {
  let sparsam = 0;
  let teuer = 0;
  for (const zeichen of text) {
    if (SPARSAM.test(zeichen)) sparsam += 1; else teuer += 1;
  }
  return Math.ceil(sparsam / 3) + teuer;
}

/**
 * Wie viel Platz für den Verlauf bleibt.
 *
 * `fenster` ist, was das Modell annimmt; `fest` ist alles, was ohnehin
 * mitgeschickt wird (Systemanweisung, Frage, Personenliste); `antwort` ist das
 * Token-Budget, das die Antwort bekommen soll. Was übrig bleibt, minus
 * Sicherheitsabstand, darf der Verlauf kosten.
 *
 * Kommt dabei nichts Sinnvolles heraus — ein winziges Fenster, eine riesige
 * Systemanweisung —, gibt es 0 zurück. Der Aufrufer muss diesen Fall
 * behandeln; stillschweigend doch zu schicken wäre der Fehler von oben.
 */
export function verlaufsBudget(input: {
  fenster: number; fest: string; antwort: number;
}): number {
  const abstand = ABSTAND_FEST + Math.ceil(input.fenster * ABSTAND_ANTEIL);
  const frei = input.fenster - markenSchaetzung(input.fest) - input.antwort - abstand;
  return Math.max(0, frei);
}

/**
 * Zeilen in Abschnitte teilen, von denen jeder für sich ins Budget passt.
 *
 * Die Reihenfolge bleibt erhalten — ein Protokoll, dessen Abschnitte
 * durcheinandergeraten, ist kein Protokoll. Eine einzelne Zeile, die für sich
 * allein schon zu lang ist, wird auf das Budget gekürzt und mit `…` versehen:
 * sie ganz wegzulassen hieße, eine Nachricht aus dem Verlauf verschwinden zu
 * lassen, ohne dass es jemand merkt.
 */
export function inAbschnitte(zeilen: string[], budget: number): string[][] {
  if (budget <= 0) return [];
  const abschnitte: string[][] = [];
  let laufend: string[] = [];
  let kosten = 0;

  for (const zeile of zeilen) {
    let text = zeile;
    let preis = markenSchaetzung(text) + 1;   // +1 für den Zeilenumbruch
    if (preis > budget) {
      text = `${text.slice(0, budget * 3)}…`;
      preis = markenSchaetzung(text) + 1;
    }
    if (kosten + preis > budget && laufend.length) {
      abschnitte.push(laufend);
      laufend = [];
      kosten = 0;
    }
    laufend.push(text);
    kosten += preis;
  }
  if (laufend.length) abschnitte.push(laufend);
  return abschnitte;
}

/**
 * Die jüngsten Zeilen, die noch ins Budget passen.
 *
 * Für alles, was nicht zusammengefasst, sondern gelesen wird —
 * Antwortvorschläge, Aufgabenerkennung, eine Frage an den Kanal. Dort ist das
 * Neueste das Wichtigste, und ein Abschnitt von vorgestern hilft niemandem.
 * Zurück kommt außerdem, wie viel weggefallen ist: der Aufrufer soll dem
 * Modell sagen können, dass es nur einen Ausschnitt sieht, statt es im Glauben
 * zu lassen, das sei der ganze Kanal.
 */
export function juengsteZeilen(
  zeilen: string[], budget: number,
): { zeilen: string[]; weggelassen: number } {
  const genommen: string[] = [];
  let kosten = 0;
  for (let i = zeilen.length - 1; i >= 0; i -= 1) {
    const preis = markenSchaetzung(zeilen[i]) + 1;
    if (kosten + preis > budget) break;
    genommen.unshift(zeilen[i]);
    kosten += preis;
  }
  return { zeilen: genommen, weggelassen: zeilen.length - genommen.length };
}
