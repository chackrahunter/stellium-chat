/**
 * Post aus einem fremden Postfach holen — der ZWEITE Weg in den Posteingang.
 *
 * WARUM ABHOLEN UND NICHT WEITERLEITEN LASSEN. Bei Google eine Weiterleitung
 * an die Stellium-Domäne einzurichten wäre in fünf Minuten getan und wurde
 * verworfen: ein Teil der Firmenpost, die an die Stellium-Domäne geht, liegt
 * ZUSÄTZLICH in diesem Gmail-Postfach. Weitergeleitet käme jedes solche Stück
 * ein zweites Mal herein, und der Posteingang zeigte es doppelt. Wer selbst
 * abholt, kann vergleichen — und genau das tut `eingangAufnehmen()` in
 * services/post.ts über den `abdruck`. Die Weiterleitung könnte das nicht:
 * dort entstünde eine echte zweite Mail mit eigener Message-ID.
 *
 * DERSELBE EINGANG WIE FÜR DEN WORKER. Dieser Dienst baut sich keinen eigenen
 * Weg in die Datenbank. Er stellt aus der rohen Mail dasselbe `EingangRoh`
 * zusammen, das der Cloudflare-Worker schickt, und reicht es an
 * `eingangAufnehmen()` weiter. Jede Prüfung, jede Grenze, jede
 * Verschlüsselung und jede Verlaufsbildung dort gilt dadurch für beide Wege,
 * ohne dass sie zweimal geschrieben werden müsste — und ohne dass eine
 * spätere Änderung an einer der beiden Stellen vorbeigeht.
 *
 * WAS DIESER DIENST NICHT TUT: senden. Antworten gehen weiter über den
 * bestehenden Versand aus der Stellium-Adresse (`post.senden()`), nie über
 * Google. Der Abruf ist eine Einbahnstraße, und der IMAP-Client kann nicht
 * einmal schreiben (siehe services/imap.ts).
 */
import {
  abrufen, imapDatum, ImapFehler, type ImapZugang, type VerbindungBauer,
} from './imap.js';
import { zerlegen } from './mailzerlegen.js';
import { eingangAufnehmen, ALLE_FAECHER, type EingangRoh } from './post.js';
import { sichtungAnstossen } from './post-sichtung.js';
import { abrufAktiv, abrufZugangLesen, zugangStand } from './mailzugang.js';
import { getSetting, setSetting } from './settings.js';
import { abweisung } from '../util/abweisung.js';

/* ── Feste Größen ─────────────────────────────────────────────── */

/** Fest verdrahtet, ausdrücklich keine Einstellung — siehe den Abschnitt
    „Der ZWEITE Weg herein" in services/mailzugang.ts: ein Feld, in das sich
    ein Rechnername eintragen lässt, ist ein Feld, mit dem sich das
    hinterlegte App-Passwort woandershin schicken lässt. */
const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

/**
 * DER TAKT: alle fünf Minuten.
 *
 * Die Begründung hat drei Teile.
 *
 *   · WARUM NICHT SCHNELLER. Jeder Lauf ist eine vollständige
 *     TLS-Verbindung, eine Anmeldung und mindestens zwei Umläufe zu Google —
 *     auf einem Raspberry Pi, der nebenbei den Chat bedient. Schneller
 *     brächte nichts: die Post, um die es hier geht (Bestätigungen, Codes,
 *     Firmenpost), verträgt fünf Minuten mühelos. Und Firmenpost an die
 *     Stellium-Domäne ist ohnehin binnen Sekunden da — die kommt über den
 *     Worker, nicht über diesen Weg.
 *
 *   · WARUM NICHT LANGSAMER. Ein Anmeldecode aus einer Mail ist nach zehn
 *     Minuten wertlos. Fünf Minuten ist der größte Takt, bei dem der Fall
 *     „ich warte auf einen Code" noch funktioniert.
 *
 *   · WAS ES KOSTET. 288 Anmeldungen am Tag. Googles Grenze für IMAP liegt
 *     um Größenordnungen darüber; das ist kein knapper Wert, sondern ein
 *     unauffälliger.
 *
 * KEIN IDLE. IMAP kann mit `IDLE` sofort melden, dass etwas angekommen ist.
 * Das hieße aber eine dauerhaft offene Verbindung zu Google, die alle paar
 * Minuten erneuert werden muss und bei jedem Netzwackler wieder aufgebaut
 * wird — mehr beweglicher Teile für einen Gewinn, den niemand bemerkt.
 */
const TAKT_MS = 5 * 60_000;

/** Der erste Lauf erst eine Minute nach dem Start. Beim Hochfahren hat der
    Pi genug zu tun (Migration, Modell-Liste, Wiederherstellung der Sitzungen)
    — ein Netzaufruf zu Google gehört nicht in diese Minute. */
const ERSTER_LAUF_MS = 60_000;

/** Wie weit der ERSTE Abruf zurückgeht. Ein Postfach kann Zehntausende Mails
    enthalten; alles zu holen hieße, den Server minutenlang zu beschäftigen
    und ein Archiv zu importieren, das niemand angefordert hat. Dreißig Tage
    sind der Zeitraum, in dem Post noch „aktuell" ist — und derselbe, den
    `eingangAufnehmen()` ohnehin als frühesten Zeitstempel zulässt (dort
    `jetzt - 30 * 86400_000`); ältere Mails bekämen dort ein falsches Datum
    aufgedrückt und stünden mit dem heutigen Tag in der Liste. */
export const ERSTABRUF_TAGE = 30;

/** Und selbst innerhalb dieser dreißig Tage: höchstens so viele, die
    JÜNGSTEN. Ein Postfach mit tausend Mails im Monat soll den ersten Lauf
    nicht in eine Stunde verwandeln. Steht so auch in der Oberfläche. */
export const ERSTABRUF_MAX = 200;

/** Danach je Lauf. Großzügig genug für jeden Rückstand nach einer Störung,
    klein genug, dass ein Lauf in Sekunden durch ist. */
const LAUF_MAX = 100;

/** Wie oft dieselbe Mail scheitern darf, bevor sie übersprungen wird. Ohne
    diese Grenze bliebe der Abruf für immer an einer einzigen kaputten Mail
    stehen und holte nie wieder etwas — der Fehlerfall, bei dem niemand merkt,
    dass nichts mehr ankommt. */
const STOLPER_MAX = 3;

/** Nach einem Fehlschlag wird der Abstand verdoppelt, bis hierher. Vor allem
    für den Fall „falsches App-Passwort": Google sperrt Konten, die im
    Minutentakt mit falschem Passwort anklopfen. Eine Stunde ist lang genug,
    dass das nicht passiert, und kurz genug, dass ein korrigiertes Passwort
    noch am selben Vormittag greift. */
const RUHE_MAX_MS = 60 * 60_000;

/* ── Merkposten ───────────────────────────────────────────────── */

const S_UIDVALIDITY = 'mail.abruf.uidvalidity';
const S_LETZTE_UID = 'mail.abruf.letzteUid';
const S_STAND = 'mail.abruf.stand';

/** Wer die Merkposten schreibt — es gibt keinen Menschen dahinter, und
    `setSetting()` verlangt eine Kennung für die Spalte `updated_by`. */
const SYSTEM = 'system';

/** Was die Oberfläche über den letzten Lauf erfährt. Enthält keine
    Adressen und keinen Inhalt — nur Zahlen, Zeitpunkte und die Meldung
    eines Fehlschlags. */
export interface AbrufLaufStand {
  letzterLaufAm: number | null;
  letzterErfolgAm: number | null;
  /** Die Meldung des letzten Fehlschlags — `null`, sobald ein Lauf wieder
      geklappt hat. Steht sie da, ist sie das Einzige, woran jemand merkt,
      dass seit Tagen nichts mehr hereinkommt. */
  letzterFehler: string | null;
  /** Wie viele Mails der letzte erfolgreiche Lauf aufgenommen bzw. als
      Dublette verworfen hat. */
  zuletztAufgenommen: number;
  zuletztDoppelt: number;
  /** Wurde schon einmal abgerufen? Steuert den Hinweis auf das
      Erstabruf-Fenster in der Oberfläche. */
  erstabrufErledigt: boolean;
}

function standLesen(): AbrufLaufStand {
  const leer: AbrufLaufStand = {
    letzterLaufAm: null, letzterErfolgAm: null, letzterFehler: null,
    zuletztAufgenommen: 0, zuletztDoppelt: 0, erstabrufErledigt: false,
  };
  const roh = getSetting(S_STAND);
  if (!roh) return { ...leer, erstabrufErledigt: getSetting(S_LETZTE_UID) !== null };
  try {
    return { ...leer, ...(JSON.parse(roh) as Partial<AbrufLaufStand>),
      erstabrufErledigt: getSetting(S_LETZTE_UID) !== null };
  } catch {
    return { ...leer, erstabrufErledigt: getSetting(S_LETZTE_UID) !== null };
  }
}

function standSchreiben(teil: Partial<AbrufLaufStand>): void {
  const neu = { ...standLesen(), ...teil };
  setSetting(S_STAND, JSON.stringify({
    letzterLaufAm: neu.letzterLaufAm, letzterErfolgAm: neu.letzterErfolgAm,
    letzterFehler: neu.letzterFehler,
    zuletztAufgenommen: neu.zuletztAufgenommen, zuletztDoppelt: neu.zuletztDoppelt,
  }), SYSTEM);
}

/* ── Von der rohen Mail zum Eingang ───────────────────────────── */

/**
 * An welche Adresse gilt diese Mail als gerichtet?
 *
 * Der Posteingang macht aus dieser Adresse das FACH (services/post.ts,
 * `fachPruefen()`), und daran hängt mehr als ein Ordnername: aus welchem
 * Fach die Antwort hinausgeht, welche Aufbewahrungsfrist greift, welchen
 * Teamnamen die KI unterschreibt.
 *
 * Deshalb zuerst die Empfänger der Mail selbst durchsehen: Firmenpost, die
 * auch in diesem Gmail-Postfach liegt, trägt in `To:`/`Cc:` regelmäßig noch
 * die Stellium-Adresse, an die sie eigentlich ging. Findet sich dort eines
 * der eingerichteten Fächer auf der eigenen Domäne, gehört die Mail genau
 * dorthin — und liegt damit im selben Ordner wie die Kopie, die über den
 * Worker kam.
 *
 * Sonst gilt die abgerufene Adresse selbst. Das landet in `sonstiges`, und
 * das ist die ehrliche Antwort: diese Post ging an kein Firmenfach. Antworten
 * kann man trotzdem — die Oberfläche wählt dann das erste sendbare Fach
 * (PostPanel.tsx, `antwortFach`), und `senden()` schickt sie aus der
 * Stellium-Domäne hinaus.
 */
function empfaengerBestimmen(empfaenger: string[], eigeneAdresse: string): string {
  const domaene = zugangStand().domaene;
  if (domaene) {
    const treffer = empfaenger.find((a) => {
      const [lokal, dom] = a.split('@');
      return dom === domaene && (ALLE_FAECHER as readonly string[]).includes(lokal);
    });
    if (treffer) return treffer;
  }
  return eigeneAdresse;
}

/** Grenzen wie im Worker (dort ANHANG_MAX / ANHAENGE_MAX_GESAMT). post.ts
    prüft sie anschließend UNABHÄNGIG noch einmal nach; das hier erspart nur,
    Bytes zu kodieren, die dort ohnehin verworfen würden. */
const ANHANG_MAX = 1 * 1024 * 1024;
const ANHAENGE_MAX_GESAMT = 5 * 1024 * 1024;
const ANHAENGE_MAX = 25;

/** Aus der rohen Mail dasselbe Gebilde, das der Cloudflare-Worker schickt. */
export function alsEingang(roh: Buffer, eigeneAdresse: string): EingangRoh {
  const m = zerlegen(roh);
  let gesamt = 0;
  const anhaenge = m.anhaenge.slice(0, ANHAENGE_MAX).map((a) => {
    const passt = a.inhalt.length <= ANHANG_MAX && gesamt + a.inhalt.length <= ANHAENGE_MAX_GESAMT;
    if (passt) gesamt += a.inhalt.length;
    return {
      name: a.name, typ: a.typ, groesse: a.inhalt.length,
      uebergross: !passt,
      inhalt: passt ? a.inhalt.toString('base64') : null,
    };
  });

  return {
    an: empfaengerBestimmen(m.empfaenger, eigeneAdresse),
    von: m.von,
    vonName: m.vonName,
    /* Es gibt beim Abruf keinen Umschlagabsender: der steckt im SMTP-Dialog,
       und der ist längst vorbei, wenn eine Mail im Postfach liegt. Den
       sichtbaren Absender einzusetzen ist die ehrliche Näherung — die Spalte
       existiert, damit man SIEHT, ob beide auseinandergehen, und beim Abruf
       weiß niemand, ob sie es taten. Das steht so auch in der Oberfläche. */
    umschlagVon: m.von,
    antwortAn: m.antwortAn,
    betreff: m.betreff,
    text: m.text,
    html: m.html,
    messageId: m.messageId,
    referenzen: m.referenzen,
    /* Die ERSTE Authentication-Results-Zeile, aus demselben Grund wie im
       Worker: empfangende Server stellen ihre Zeile vorne an, ein Absender
       kann nur weiter hinten etwas behaupten. Beim Abruf aus Gmail ist die
       vorderste die von Google — sie kam dort ins Haus. */
    pruefung: m.pruefung,
    am: m.datum ?? Date.now(),
    anhaenge,
  };
}

/* ── Ein Lauf ─────────────────────────────────────────────────── */

export interface LaufErgebnis {
  aufgenommen: number;
  doppelt: number;
  /** Wie viele Mails übersprungen wurden, weil sie wiederholt scheiterten. */
  uebersprungen: number;
  /** Ob dieser Lauf der ERSTE war (also über das 30-Tage-Fenster ging). */
  erstabruf: boolean;
}

let laeuftGerade = false;

/**
 * Einen Abruf durchführen. Wirft, wenn er scheitert — der Aufrufer entscheidet,
 * was daraus wird (der Takt wartet länger, die Route meldet es).
 *
 * DER MERKPUNKT WANDERT JE MAIL, nicht am Ende des Laufs. Bricht der Lauf in
 * der Mitte ab (Netz weg, Gmail wirft raus), bleibt alles Verarbeitete
 * verarbeitet, und der nächste Lauf setzt genau dahinter an. Am Ende
 * fortzuschreiben hieße: entweder alles noch einmal holen (und sich auf die
 * Entdublettung verlassen, die es für Mails ohne Message-ID nicht gibt) oder
 * das Verarbeitete überspringen (und Post verlieren).
 */
export async function einLauf(verbindungBauen?: VerbindungBauer): Promise<LaufErgebnis> {
  /* Mit Kennung statt als nackter Error: der Satz geht über
     `/api/post/abruf/jetzt` bis in die Oberfläche, und die liegt in 22
     Sprachen vor (siehe util/abweisung.ts). Der deutsche Text bleibt als
     Rückfall daneben stehen. */
  const zugang = abrufZugangLesen();
  if (!zugang) {
    throw abweisung('post.abrufKeinZugang', 'Für den Abruf ist kein Postfach hinterlegt.');
  }
  if (laeuftGerade) throw abweisung('post.abrufLaeuft', 'Es läuft bereits ein Abruf.');
  laeuftGerade = true;

  const imap: ImapZugang = {
    host: IMAP_HOST, port: IMAP_PORT, benutzer: zugang.adresse, passwort: zugang.passwort,
  };

  let aufgenommen = 0;
  let doppelt = 0;
  let uebersprungen = 0;
  let erstabruf = false;
  let gueltigkeit = 0;

  try {
    await abrufen(imap, (uidValidity) => {
      gueltigkeit = uidValidity;
      const gemerkteGueltigkeit = Number(getSetting(S_UIDVALIDITY) ?? '0');
      const gemerkteUid = Number(getSetting(S_LETZTE_UID) ?? '0');
      /* Wechselt die UIDVALIDITY, sind alle gemerkten Nummern wertlos — das
         Postfach wurde neu aufgebaut, und dieselbe Nummer meint jetzt eine
         andere Mail. Dann wie beim ersten Mal: das 30-Tage-Fenster, nicht
         „ab UID x". Ohne diese Prüfung holte der Abruf entweder nie wieder
         etwas oder wahllos fremde Post. */
      const brauchbar = gemerkteGueltigkeit === uidValidity && gemerkteUid > 0;
      if (!brauchbar && gemerkteGueltigkeit && gemerkteGueltigkeit !== uidValidity) {
        console.warn(`[postabruf] UIDVALIDITY gewechselt (${gemerkteGueltigkeit} → ${uidValidity}) — `
          + `es wird wieder über das ${ERSTABRUF_TAGE}-Tage-Fenster gesucht.`);
      }
      if (brauchbar) return { auftrag: { abUid: gemerkteUid + 1 }, hoechstens: LAUF_MAX };
      erstabruf = true;
      const seit = new Date(Date.now() - ERSTABRUF_TAGE * 86400_000);
      console.log(`[postabruf] Erstabruf: nur ab ${imapDatum(seit)}, höchstens ${ERSTABRUF_MAX} Mails.`);
      return { auftrag: { seit }, hoechstens: ERSTABRUF_MAX };
    }, (uid, roh) => {
      try {
        const { id, doppelt: schonDa } = eingangAufnehmen(
          alsEingang(roh, zugang.adresse), undefined, 'abruf');
        if (schonDa) doppelt += 1;
        else {
          aufgenommen += 1;
          /* Wie auf dem Worker-Weg (http/posteingang.ts): die KI-Sichtung
             läuft NACH dem Aufnehmen an und blockiert diesen Lauf nicht.
             Bei einer Dublette nichts anstoßen — die Mail ist längst
             gesichtet. */
          sichtungAnstossen(id);
        }
        merkpunktSetzen(gueltigkeit, uid);
        stolperVergessen();
      } catch (err) {
        /* EINE kaputte Mail darf den Abruf nicht für immer anhalten. Beim
           dritten Anlauf wird sie übersprungen — laut, mit UID, damit
           jemand nachsehen kann. Verloren ist dabei nichts: sie liegt
           weiterhin im Gmail-Postfach. */
        const versuche = stolperZaehlen(uid);
        console.error(`[postabruf] Mail UID ${uid} ließ sich nicht aufnehmen `
          + `(Versuch ${versuche}/${STOLPER_MAX}):`, (err as Error).message);
        if (versuche < STOLPER_MAX) throw err;
        uebersprungen += 1;
        merkpunktSetzen(gueltigkeit, uid);
        stolperVergessen();
      }
    }, verbindungBauen);

    standSchreiben({
      letzterLaufAm: Date.now(), letzterErfolgAm: Date.now(), letzterFehler: null,
      zuletztAufgenommen: aufgenommen, zuletztDoppelt: doppelt,
    });
    return { aufgenommen, doppelt, uebersprungen, erstabruf };
  } catch (err) {
    /* Die Meldung geht in den Stand und damit in die Oberfläche. Sie darf
       niemals das Passwort enthalten — deshalb wirft services/imap.ts bei
       LOGIN einen eigenen, inhaltslosen Satz statt der Serverantwort. */
    standSchreiben({ letzterLaufAm: Date.now(), letzterFehler: (err as Error).message });
    throw err;
  } finally {
    laeuftGerade = false;
  }
}

function merkpunktSetzen(uidValidity: number, uid: number): void {
  setSetting(S_UIDVALIDITY, String(uidValidity), SYSTEM);
  setSetting(S_LETZTE_UID, String(uid), SYSTEM);
}

/* Der Stolperzähler lebt nur im Speicher: er soll einen Neustart NICHT
   überleben. Ein Neustart ist der häufigste Grund, warum eine Mail beim
   ersten Anlauf scheiterte (halb geschriebene Ablage, ein Fehler, der
   inzwischen behoben ist) — nach einem Neustart hat sie drei frische
   Versuche verdient, statt schon mit zwei Strafpunkten anzutreten. */
let stolperUid = 0;
let stolperVersuche = 0;

function stolperZaehlen(uid: number): number {
  if (stolperUid !== uid) { stolperUid = uid; stolperVersuche = 0; }
  stolperVersuche += 1;
  return stolperVersuche;
}

function stolperVergessen(): void { stolperUid = 0; stolperVersuche = 0; }

/* ── Der Takt ─────────────────────────────────────────────────── */

/** Was die Oberfläche über den Abruf insgesamt erfährt. */
export function laufStand(): AbrufLaufStand & { naechsterLaufIn: number | null } {
  return {
    ...standLesen(),
    naechsterLaufIn: naechsterLauf ? Math.max(0, naechsterLauf - Date.now()) : null,
  };
}

let uhr: NodeJS.Timeout | null = null;
let ruhe = TAKT_MS;
let naechsterLauf: number | null = null;

/**
 * Den Takt starten. Zurück kommt, wie überall in ws/gateway.ts, die Funktion
 * zum Anhalten.
 *
 * KEIN `setInterval`, sondern ein jedes Mal neu gestellter `setTimeout`: mit
 * einem festen Intervall liefen zwei Läufe übereinander, sobald einer länger
 * braucht als der Takt (ein Erstabruf mit 200 Mails tut das leicht), und der
 * Abstand nach einem Fehlschlag ließe sich nicht verlängern. So wartet der
 * nächste Lauf immer erst, nachdem der vorige fertig ist.
 *
 * `unref()`, damit dieser Wecker den Prozess nicht am Leben hält: ein
 * Prüflauf, der den Server nur kurz hochfährt, soll nicht fünf Minuten auf
 * einen Abruf warten müssen, den niemand bestellt hat.
 */
export function beobachten(): () => void {
  const stellen = (inMs: number): void => {
    naechsterLauf = Date.now() + inMs;
    uhr = setTimeout(() => { void takt(); }, inMs);
    uhr.unref?.();
  };

  const takt = async (): Promise<void> => {
    /* Bei jedem Takt neu gefragt und nicht beim Starten einmal: Zugang und
       Schalter ändern sich über die Oberfläche, ohne Neustart. */
    if (!abrufAktiv() || !abrufZugangLesen()) {
      ruhe = TAKT_MS;
      stellen(TAKT_MS);
      return;
    }
    try {
      const e = await einLauf();
      if (e.aufgenommen || e.doppelt || e.uebersprungen) {
        console.log(`[postabruf] ${e.aufgenommen} neu, ${e.doppelt} schon da`
          + `${e.uebersprungen ? `, ${e.uebersprungen} übersprungen` : ''}.`);
      }
      ruhe = TAKT_MS;
    } catch (err) {
      /* Verdoppeln statt im Takt weiterklopfen. Bei einem abgelehnten
         Passwort ist das keine Höflichkeit, sondern Selbstschutz: Google
         sperrt Konten, gegen die im Minutentakt mit falschem Passwort
         angemeldet wird — und dann hilft auch das richtige Passwort nicht
         mehr weiter. */
      ruhe = Math.min(RUHE_MAX_MS, ruhe * 2);
      const grund = err instanceof ImapFehler && err.anmeldung
        ? 'Anmeldung abgelehnt (App-Passwort prüfen)'
        : (err as Error).message;
      console.error(`[postabruf] Lauf fehlgeschlagen: ${grund} — nächster Versuch in `
        + `${Math.round(ruhe / 60_000)} Minuten.`);
    }
    stellen(ruhe);
  };

  stellen(ERSTER_LAUF_MS);
  return () => {
    if (uhr) clearTimeout(uhr);
    uhr = null;
    naechsterLauf = null;
  };
}
