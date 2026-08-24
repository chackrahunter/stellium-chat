/**
 * Geheimnisteilung nach Shamir über GF(2^8) — „3 von 5".
 *
 * WOZU
 *
 * Der Notzugang (services/notzugang.ts, lib/notzugang.ts) zerlegt einen
 * zufälligen 32-Byte-Schlüssel in fünf Anteile und verteilt sie an fünf
 * Kolleginnen und Kollegen. Drei beliebige davon setzen ihn wieder zusammen,
 * zwei ergeben nichts. Das ist die einzige Antwort auf die zwei Wünsche, die
 * sich sonst widersprechen: „die Verwaltung soll jemanden wieder hereinlassen
 * können" und „niemand außer der besitzenden Person soll mitlesen können".
 * Beide gelten, wenn KEINE EINZELNE PERSON beides kann.
 *
 * WARUM SELBST GESCHRIEBEN
 *
 * Weil es im Haus nichts Fertiges gibt. Weder die Web Crypto API noch
 * node:crypto kennen Geheimnisteilung, und ein npm-Paket dafür ist in diesem
 * Baum nicht installiert. Das ist ein schlechter Grund, Kryptografie selbst
 * zu schreiben — deshalb ist der Umfang bewusst winzig und die Prüfung
 * ungewöhnlich streng (scripts/notzugang-pruefen.mjs, Teil 1): das Körperfeld
 * wird gegen die AES-S-Box und die AES-Rundenkonstanten aus FIPS-197 gemessen
 * und die ganze Multiplikation zusätzlich gegen die AES-Umsetzung von
 * OpenSSL, die node:crypto mitbringt. Beides sind Maßstäbe von AUSSEN; eine
 * Prüfung, die dieselbe Rechnung noch einmal aufschreibt und mit sich selbst
 * vergleicht, prüft nichts.
 *
 * DAS KÖRPERFELD
 *
 * GF(2^8) modulo x^8 + x^4 + x^3 + x + 1 (0x11B) — dasselbe Feld wie AES.
 * Kein eigenwilliges Polynom: an diesem hier lässt sich jede Zeile gegen
 * veröffentlichte Tafeln halten, an einem selbst gewählten gegen nichts.
 * Addition ist XOR, Multiplikation läuft über Logarithmentafeln zur Basis
 * 0x03 (ein Erzeuger der multiplikativen Gruppe).
 *
 * EIN EIGENES POLYNOM JE BYTE
 *
 * Das ist die Stelle, an der eine falsche Umsetzung wie eine richtige
 * aussieht. Wer für alle 32 Bytes DIESELBEN Zufallskoeffizienten nimmt, teilt
 * kein Geheimnis mehr: aus zwei Anteilen ließe sich das Verhältnis der Bytes
 * zueinander ablesen, und mit einem einzigen erratenen Byte fiele der ganze
 * Schlüssel. Jedes Byte bekommt deshalb seine eigenen k-1 Koeffizienten aus
 * dem Zufallsgenerator des Systems; `teilen()` fordert sie in einem Stück an
 * und schneidet sie je Byte auseinander.
 *
 * KEINE KONSTANTE LAUFZEIT — UND WARUM DAS HIER IN ORDNUNG IST
 *
 * Die Tafelzugriffe unten sind nicht zeitkonstant, ihre Adressen hängen vom
 * Geheimnis ab. Das ist eine bewusste Entscheidung, keine Auslassung: beide
 * Rechnungen laufen genau einmal, auf dem eigenen Gerät, ohne Gegenüber, das
 * wiederholt messen könnte. Es gibt kein Orakel — niemand kann `teilen()`
 * millionenfach mit gewählten Eingaben anstoßen und Zeiten mitschreiben. Wer
 * diese Datei je in einen Dienst einbaut, der auf Zuruf teilt oder
 * zusammensetzt, muss das hier neu bewerten.
 *
 * WAS DIESE DATEI NICHT LEISTET
 *
 * Sie erkennt keinen verfälschten Anteil. Shamir kann das prinzipiell nicht:
 * drei Punkte legen immer genau eine Parabel fest, auch drei falsche. Die
 * Erkennung liegt eine Ebene höher — jeder Anteil trägt den Abdruck des
 * Geheimnisses bei sich, und nach dem Zusammensetzen wird er nachgerechnet
 * (lib/notzugang.ts). Fällt er anders aus, bricht der Vorgang ab, statt mit
 * einem falschen Schlüssel weiterzurechnen.
 */

/* ── Das Körperfeld ───────────────────────────────────────────── */

/** x^8 + x^4 + x^3 + x + 1 — das Polynom von AES (FIPS-197, Abschnitt 4.2). */
const POLYNOM = 0x11b;

/* Zwei Tafeln, einmal beim Laden gefüllt. EXP ist doppelt so lang wie nötig,
   damit `EXP[LOG[a] + LOG[b]]` ohne ein Modulo auskommt: die Summe zweier
   Logarithmen bleibt unter 510. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    /* x mal 0x03, also (x mal 2) plus x — in diesem Feld heißt „plus" XOR.
       Ein einziger Reduktionsschritt genügt: x<<1 bleibt unter 0x200. */
    let weiter = (x << 1) ^ x;
    if (weiter & 0x100) weiter ^= POLYNOM;
    x = weiter & 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  /* LOG[0] bleibt 0 und wird nie gelesen — `mal()` fängt die Null vorher ab.
     Die Null hat keinen Logarithmus; sie hier mit einem zu belegen wäre die
     Art Bequemlichkeit, aus der später ein falsches Ergebnis wird. */
}

/** Multiplikation im Körper. */
export function mal(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]]!;
}

/** Der Kehrwert. Nur die Null hat keinen — das ist ein Fehler, kein Sonderfall. */
export function kehrwert(a: number): number {
  if (a === 0) throw new Error('Die Null hat keinen Kehrwert.');
  return EXP[255 - LOG[a]!]!;
}

/* ── Zufall ───────────────────────────────────────────────────── */

/**
 * Zufall ausschließlich aus dem Generator des Systems.
 *
 * Über `globalThis` und nicht als Einfuhr, weil diese Datei im Browser (Web
 * Crypto) und in node (node:crypto, seit 19 global) läuft. Fehlt der
 * Generator, bricht die Teilung ab, statt auf etwas Schwächeres
 * auszuweichen — `Math.random` ist kein Zufallsgenerator für Schlüssel und
 * darf hier nicht einmal als Rückfall dastehen.
 */
function zufallsbytes(anzahl: number): Uint8Array {
  const quelle = (globalThis as {
    crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
  }).crypto;
  if (!quelle?.getRandomValues) {
    throw new Error('Kein Zufallsgenerator des Systems verfügbar — die Teilung bricht ab.');
  }
  return quelle.getRandomValues(new Uint8Array(anzahl));
}

/* ── Anteile ──────────────────────────────────────────────────── */

/**
 * Ein Anteil: die Stelle (das x) und je ein y-Wert pro Byte des Geheimnisses.
 *
 * `stelle` beginnt bei 1 und nie bei 0. Die Stelle 0 IST das Geheimnis — ein
 * Anteil dort wäre kein Anteil, sondern der Schlüssel im Klartext.
 */
export interface Anteil {
  stelle: number;
  werte: Uint8Array;
}

/** Grenzen, die überall gelten sollen — auch dort, wo jemand später andere
 *  Zahlen einsetzt. Über 255 hinaus gibt es im Feld keine Stellen mehr. */
export const HOECHSTE_STELLE = 255;

/**
 * Ein Geheimnis in `anzahl` Anteile zerlegen, von denen `schwelle` genügen.
 *
 * Für jedes Byte s ein eigenes Polynom f(x) = s + a1·x + … + a(k-1)·x^(k-1)
 * mit frischen Zufallskoeffizienten; der Anteil an der Stelle x ist f(x).
 * Ausgewertet nach Horner, damit keine Potenz von Hand gebildet werden muss.
 *
 * Die Koeffizienten werden nach der Auswertung überschrieben. Sie sind so
 * gut wie das Geheimnis selbst: wer a1…a(k-1) kennt, rechnet aus EINEM Anteil
 * den Schlüssel aus.
 */
export function teilen(geheimnis: Uint8Array, schwelle: number, anzahl: number): Anteil[] {
  if (!Number.isInteger(schwelle) || !Number.isInteger(anzahl)) {
    throw new Error('Schwelle und Anzahl müssen ganze Zahlen sein.');
  }
  if (schwelle < 2) throw new Error('Eine Schwelle unter 2 teilt nichts.');
  if (anzahl < schwelle) throw new Error('Es müssen mindestens so viele Anteile wie die Schwelle entstehen.');
  if (anzahl > HOECHSTE_STELLE) throw new Error('Mehr Anteile als Stellen im Körper gibt es nicht.');
  if (geheimnis.length === 0) throw new Error('Es gibt nichts zu teilen.');

  const grad = schwelle - 1;
  /* Ein Stück Zufall für alle Bytes zusammen, danach je Byte
     auseinandergeschnitten — nicht ein Aufruf je Byte, aber auch nicht ein
     Satz Koeffizienten für alle. Jedes Byte bekommt seine eigenen `grad`
     Bytes aus diesem Block; keiner wird zweimal gelesen. */
  const koeffizienten = zufallsbytes(geheimnis.length * grad);

  try {
    const anteile: Anteil[] = [];
    for (let stelle = 1; stelle <= anzahl; stelle++) {
      const werte = new Uint8Array(geheimnis.length);
      for (let i = 0; i < geheimnis.length; i++) {
        /* Horner von oben nach unten: (((a_grad·x + a_grad-1)·x + …)·x + s). */
        let y = koeffizienten[i * grad + (grad - 1)]!;
        for (let j = grad - 2; j >= 0; j--) {
          y = mal(y, stelle) ^ koeffizienten[i * grad + j]!;
        }
        werte[i] = mal(y, stelle) ^ geheimnis[i]!;
      }
      anteile.push({ stelle, werte });
    }
    return anteile;
  } finally {
    koeffizienten.fill(0);
  }
}

/**
 * Anteile wieder zusammensetzen — Lagrange-Interpolation an der Stelle 0.
 *
 * Die Gewichte hängen allein von den Stellen ab, nicht von den Werten;
 * sie werden deshalb einmal gerechnet und dann auf jedes Byte angewandt.
 *
 * WAS HIER GEPRÜFT WIRD UND WAS NICHT: doppelte Stellen fliegen auf (zwei
 * gleiche x sind kein zweiter Punkt, und der Nenner wäre null), zu wenige
 * Anteile ebenso — aber nur gegen die MITGEGEBENE Schwelle. Ob die Werte
 * echt sind, weiß diese Funktion nicht und kann es nicht wissen. Das prüft
 * der Aufrufer am Abdruck des Ergebnisses.
 */
export function zusammenfuegen(anteile: readonly Anteil[], schwelle: number): Uint8Array {
  if (!Number.isInteger(schwelle) || schwelle < 2) throw new Error('Eine Schwelle unter 2 teilt nichts.');
  if (anteile.length < schwelle) {
    throw new Error(`Zu wenige Anteile: ${anteile.length} von ${schwelle} nötigen.`);
  }

  const laenge = anteile[0]!.werte.length;
  const stellen = new Set<number>();
  for (const a of anteile) {
    if (!Number.isInteger(a.stelle) || a.stelle < 1 || a.stelle > HOECHSTE_STELLE) {
      throw new Error('Eine Stelle liegt außerhalb des Körpers.');
    }
    if (stellen.has(a.stelle)) throw new Error('Dieselbe Stelle zweimal — das ist kein zweiter Punkt.');
    stellen.add(a.stelle);
    if (a.werte.length !== laenge) throw new Error('Die Anteile sind unterschiedlich lang.');
  }

  /* Mehr als nötig schadet nicht: die Punkte liegen alle auf derselben Kurve,
     jede Teilmenge der Größe k ergibt dasselbe. Genommen werden trotzdem
     genau `schwelle` — mehr zu verrechnen kostet nur Zeit. */
  const benutzt = anteile.slice(0, schwelle);

  const gewichte = new Uint8Array(benutzt.length);
  for (let i = 0; i < benutzt.length; i++) {
    let zaehler = 1;
    let nenner = 1;
    for (let j = 0; j < benutzt.length; j++) {
      if (i === j) continue;
      zaehler = mal(zaehler, benutzt[j]!.stelle);
      // Im Körper ist Minus dasselbe wie Plus, also XOR.
      nenner = mal(nenner, benutzt[i]!.stelle ^ benutzt[j]!.stelle);
    }
    gewichte[i] = mal(zaehler, kehrwert(nenner));
  }

  const geheimnis = new Uint8Array(laenge);
  for (let b = 0; b < laenge; b++) {
    let summe = 0;
    for (let i = 0; i < benutzt.length; i++) summe ^= mal(benutzt[i]!.werte[b]!, gewichte[i]!);
    geheimnis[b] = summe;
  }
  return geheimnis;
}
