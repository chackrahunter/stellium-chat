import crypto from 'node:crypto';
import { db } from '../db/index.js';

/**
 * Zeitlich sortierbare IDs — der Rest des Systems verlässt sich darauf, dass
 * eine später vergebene ID auch lexikalisch später kommt: Ungelesen-Zähler
 * (services/store.ts:unreadCounts, Vergleich `id > marke`), Lesebestätigungen
 * (services/messages.ts:readReceiptsBatch, Vergleich `last_read_message_id
 * >= m.id`) und dieselbe Wasserstandsmarke bei der Post-Auswertung
 * (services/post-lernen.ts, services/post-partnergruppen.ts, Tabelle
 * mail_nachrichten). Format: `${prefix}${zeit}${lauf}${zufall}` — neun
 * Basis-36-Stellen Zeit (padStart), drei Basis-36-Stellen Laufnummer
 * (padStart) und genau elf Base64url-Zeichen Zufall (die feste Länge von
 * `randomBytes(8).toString('base64url')` — 8 Byte ergeben immer exakt elf
 * Zeichen, ohne Padding). Auf diesen festen Längen beruht `markeAusKennung()`
 * unten.
 *
 * DER FEHLER, DEN DIESES MODUL ABFÄNGT: Der Pi hat keine batteriegepufferte
 * Uhr. `stellium.service` startet nach `network-online.target`, aber
 * ausdrücklich NICHT erst nach vollzogenem Zeitabgleich (siehe Begründung in
 * server-setup/stellium-installieren.sh — ein Dienst, der nie startet,
 * solange kein Netz da ist, wäre schlimmer als eine kurze Zeitungenauigkeit).
 * Nach einem Stromausfall läuft die Uhr beim Boot mit dem letzten von
 * systemd gespeicherten Stand los (`/var/lib/systemd/timesync/clock`) — der
 * liegt fast immer ein Stück VOR dem tatsächlichen Absturzzeitpunkt, weil er
 * vom letzten erfolgreichen Abgleich stammt, nicht vom letzten Herzschlag vor
 * dem Ausfall. Schreibt jemand in den paar Sekunden bis zum nächsten
 * NTP-Abgleich eine Nachricht, bekäme sie ohne Gegenmaßnahme eine ID mit
 * dieser zu alten Zeit — sie sortierte VOR die letzte Nachricht des vorigen
 * Laufs und damit unter jede schon gesetzte Lesemarke. Lautlos „gelesen",
 * für immer, ohne Fehlermeldung.
 *
 * DIE ABWEHR: eine Wasserlinie, die nie sinkt, plus eine Laufnummer, die
 * ausschließlich unter ihr weiterzählt. Läuft die Uhr voraus, folgt die
 * Wasserlinie ihr und die Laufnummer beginnt neu bei null — der Normalfall.
 * Läuft die Uhr rückwärts oder steht sie still (auch der ganz gewöhnliche
 * Fall zweier Aufrufe in derselben Millisekunde), bleibt die Zeit auf der
 * Wasserlinie stehen und die Laufnummer zählt hoch. Das Paar (Zeit,
 * Laufnummer) wächst dadurch bei JEDEM Aufruf echt — nie eine ID, die unter
 * die vorige oder unter eine ältere fällt, egal wie oft die Uhr stehen
 * bleibt oder zurückspringt. Der Zufallsteil bleibt trotzdem dabei: nicht
 * für die Sortierung (die trägt jetzt die Laufnummer), sondern damit eine ID
 * — etwa ein Anhang-Verweis — sich nicht aus Zeitpunkt und Reihenfolge
 * erraten lässt.
 *
 * Der Prozessneustart ist gerade der gefährliche Moment (er FÄLLT mit der
 * kaputten Uhr zusammen) — ein rein prozessinterner Merker allein wäre
 * nutzlos, er begänne bei jedem Neustart wieder bei null. Die Wasserlinie
 * (und die zugehörige Laufnummer, damit ein Neustart mitten in einer
 * eingefrorenen Millisekunde nicht wieder bei null anfängt) werden deshalb
 * beim ersten newId()-Aufruf nach dem Start aus der Datenbank rekonstruiert
 * (siehe sicherstellenWasserlinie()) — kein separater Marker, der verloren
 * gehen könnte: die Datenbank IST hier der dauerhafte Speicher.
 *
 * DIESELBE KLEMMUNG FÜR EIN `created_at` NEBENAN: eine `id` allein schützt
 * nur, WOMIT sie selbst verglichen wird. `messages.created_at` wird in
 * `channelHistory()` (store.ts) in DERSELBEN Abfrage sortierend neben der
 * `id` benutzt (`id < before ... ORDER BY created_at DESC`) — ein zweiter,
 * unabhängiger `Date.now()`-Aufruf für dieses Feld könnte im selben
 * Neustart-Fenster einen anderen Wert liefern als den, der schon in die
 * Wasserlinie eingeflossen ist, und die Blätterei durcheinanderbringen, ganz
 * ohne dass die `id` selbst je zurückspränge. `newIdMitZeit()` unten gibt
 * deshalb Kennung UND geklemmte Zeit aus EINER Vergabe zurück. Nicht jede
 * Zeile braucht das: nur wo ein `created_at`-artiges Feld wie hier NEBEN der
 * `id` in derselben Sortierung mitspielt, sonst bleibt ein gewöhnlicher
 * `Date.now()`-Aufruf richtig (siehe `newIdMitZeit()` für die Abgrenzung).
 */

/** Länge des Zeitanteils (Basis-36, padStart) am Anfang jeder Kennung. */
const ZEIT_STELLEN = 9;
/** Länge der Laufnummer (Basis-36, padStart), direkt hinter der Zeit. */
const LAUF_STELLEN = 3;
/** Feste Länge von randomBytes(8).toString('base64url') — siehe Kopfkommentar. */
const ZUFALL_STELLEN = 11;
/** Werte, die eine Laufnummer bei LAUF_STELLEN Basis-36-Stellen annehmen kann. */
const LAUF_GRENZE = 36 ** LAUF_STELLEN; // 46 656 — weit über jedem realistischen Ausbruch in einer Millisekunde

/** Höchste bislang vergebene Zeit (ms seit Epoche) — sinkt nie. */
let wasserlinie = 0;
/** Laufnummer innerhalb der aktuellen Wasserlinie — sinkt nie, solange die Wasserlinie steht. */
let laufnummer = 0;
/** Läuft die aktuelle Systemuhr gerade hinter der Wasserlinie her? Für die Meldung unten. */
let hinterher = false;
/** Wie viele IDs während des laufenden Rückstands mit der Wasserlinie statt der Uhr vergeben wurden. */
let hinterherAnzahl = 0;
/** Wurde die Wasserlinie schon aus der Datenbank rekonstruiert? Nur einmal pro Prozess nötig. */
let wasserlinieGelesen = false;

interface Marke { zeit: number; lauf: number; }

/** Länge des ALTFORMATS (vor dieser Ausgabe) nach dem Präfix: Zeit + Zufall,
    OHNE Laufnummer-Stelle — exakt LAUF_STELLEN Zeichen kürzer als heute
    (siehe Kopfkommentar, „Format: …"). Jede Kennung, die vor diesem Release
    vergeben wurde, hat diese kürzere Form. */
const GESAMT_ALT = ZEIT_STELLEN + ZUFALL_STELLEN;
/** Länge des aktuellen Formats nach dem Präfix. */
const GESAMT_NEU = ZEIT_STELLEN + LAUF_STELLEN + ZUFALL_STELLEN;

/**
 * Zeit- und Laufnummer-Anteil aus einer vorhandenen Kennung zurückgewinnen —
 * unabhängig vom Präfix, weil dessen Länge je nach Aufrufer wechselt (`m_`,
 * `po_`, `otpa_`, …): der Zufallsteil hat immer exakt ZUFALL_STELLEN Zeichen,
 * die Laufnummer davor immer exakt LAUF_STELLEN — beide stehen also immer an
 * derselben Stelle vom Ende der Kennung her gezählt.
 *
 * ZWEI Formate, ein zweiter Versuch: eine produktive Datenbank enthält beim
 * ersten Boot nach dieser Ausgabe ausschließlich ALTE Kennungen — die
 * Laufnummer-Stelle gibt es erst ab hier. Schlägt der erste Versuch (neues
 * Format, mit Laufnummer) fehl, wird deshalb NICHT sofort `null` gemeldet,
 * sondern das alte Format probiert (Zeit + Zufall, ohne Laufnummer). Fehlt
 * dieser zweite Versuch, fände `sicherstellenWasserlinie()` unten auf einer
 * echten Datenbank grundsätzlich nichts — die Wasserlinie bliebe 0, und die
 * Abwehr aus dem Kopfkommentar wäre ausgerechnet bei dem Neustart aus, für
 * den sie gebaut wurde.
 *
 * WARUM DIE ALTE ZEIT UM EINE MILLISEKUNDE ANGEHOBEN ZURÜCKKOMMT, NICHT
 * UNVERÄNDERT: eine alte Kennung hat an genau der Stelle, an der eine neue
 * ihre Laufnummer trägt, stattdessen schon den ERSTEN Teil ihres eigenen
 * Zufallsanteils stehen — Base64url, nicht Basis-36, mit Großbuchstaben und
 * `_`. Käme die alte Zeit unverändert zurück, würde die nächste, NEUE
 * Kennung bei gleicher Zeit mit Laufnummer 0/1 („00…"/„01…") anfangen — und
 * ein alter Zufallsanteil, der zufällig mit einem Kleinbuchstaben oder `_`
 * beginnt (in der Praxis die deutliche Mehrheit aller möglichen Werte, ASCII
 * 95/97–122 gegenüber „0"–„9" bei ASCII 48–57), sortierte dann als Zeichen
 * VOR der neuen Laufnummer — die neue Kennung fiele lexikalisch UNTER die
 * alte, obwohl sie später vergeben wurde. Genau das darf laut Kopfkommentar
 * nie passieren, und ausgerechnet der Neustart mit hinterherhinkender Uhr
 * (jetzt <= wasserlinie, siehe newId() unten) ist der Fall, in dem die
 * nächste Kennung dieselbe Zeit wie die alte trägt und die Kollision
 * tatsächlich einträte. Ein um EINE Millisekunde erhöhter Zeitanteil macht
 * das unmöglich, ohne die Laufnummer selbst zu bemühen: der Zeitanteil
 * (immer die ERSTEN 9 Zeichen nach dem Präfix, in JEDEM Format) entscheidet
 * einen String-Vergleich, bevor überhaupt ein späteres Zeichen angesehen
 * wird, und eine um 1 erhöhte, gleich breit aufgefüllte Basis-36-Zahl ist
 * IMMER lexikalisch größer als die unerhöhte — unabhängig davon, was in der
 * alten Kennung dahinter steht. `lauf: 0` bleibt trotzdem der einzig
 * ehrliche Wert für das zweite Feld: eine alte Kennung hatte nie eine
 * Laufnummer, und diese Funktion erfindet keine.
 *
 * Kennungen, die aus keinem der beiden Formate stammen (z. B. handvergebene
 * IDs in Testdaten), sind zu kurz oder ergeben kein gültiges Basis-36 —
 * beides liefert hier `null`, nie einen falschen Wert.
 */
function markeAusKennung(id: string): Marke | null {
  if (id.length >= GESAMT_NEU) {
    const zeitTeil = id.slice(-GESAMT_NEU, -(LAUF_STELLEN + ZUFALL_STELLEN));
    const laufTeil = id.slice(-(LAUF_STELLEN + ZUFALL_STELLEN), -ZUFALL_STELLEN);
    if (/^[0-9a-z]{9}$/.test(zeitTeil) && /^[0-9a-z]{3}$/.test(laufTeil)) {
      const zeit = parseInt(zeitTeil, 36);
      const lauf = parseInt(laufTeil, 36);
      if (Number.isFinite(zeit) && Number.isFinite(lauf)) return { zeit, lauf };
    }
  }
  if (id.length >= GESAMT_ALT) {
    const zeitTeil = id.slice(-GESAMT_ALT, -ZUFALL_STELLEN);
    if (/^[0-9a-z]{9}$/.test(zeitTeil)) {
      const zeit = parseInt(zeitTeil, 36);
      // +1: siehe Funktionskopf -- ohne den Sprung könnte der alte
      // Zufallsanteil, der ab hier steht, lexikalisch über die Laufnummer
      // der nächsten neuen Kennung geraten.
      if (Number.isFinite(zeit)) return { zeit: zeit + 1, lauf: 0 };
    }
  }
  return null;
}

/** Höchste vorhandene Kennung einer Tabelle — ein einzelner Abstieg über den TEXT-PRIMARY-KEY-Index. */
function hoechsteKennung(tabelle: string): string | undefined {
  try {
    // tabelle ist unten fest verdrahtet (keine Nutzereingabe), zwei Aufrufstellen genügen.
    return db.get<{ id: string }>(`SELECT id FROM ${tabelle} ORDER BY id DESC LIMIT 1`)?.id;
  } catch {
    // Frische Datenbank ohne diese Tabelle, oder ein Aufruf vor initDb() in
    // einem Test — dann beginnt die Wasserlinie bei 0 und newId() hebt sie
    // beim ersten Aufruf sofort auf die Systemuhr an. Kein Absturz hier:
    // eine fehlende Startmarke ist nie schlimmer als das alte Verhalten.
    return undefined;
  }
}

/**
 * Die Wasserlinie (und ihre Laufnummer) beim ersten Aufruf aus der
 * Datenbank rekonstruieren.
 *
 * Nur `messages` und `mail_nachrichten` — das sind die einzigen zwei
 * Tabellen im ganzen Schema, deren `id`-Spalte per `id > marke`/`id >=
 * marke` sortierend verglichen wird (Ungelesen-Zähler, Lesebestätigungen,
 * Kanalreihenfolge, „Was habe ich verpasst", die Wasserstandsmarken der
 * Post-Auswertung). Jede andere newId()-Tabelle (attachments, tasks, polls,
 * Sitzungen, …) wird ausschließlich per Gleichheit nachgeschlagen — eine
 * dort durch die kaputte Uhr zu alt geratene ID wäre unschön, aber
 * funktional folgenlos, weil nichts ihre Reihenfolge zu einer anderen ID
 * prüft. Beide Abfragen laufen über den automatischen Index des TEXT
 * PRIMARY KEY (ein Indexabstieg, keine Tabellensuche) — auf dem Pi neben dem
 * ohnehin folgenden Serverstart nicht messbar, selbst bei Jahren an
 * Chatverlauf.
 */
function sicherstellenWasserlinie(): void {
  if (wasserlinieGelesen) return;
  wasserlinieGelesen = true;
  let beste: Marke | null = null;
  for (const tabelle of ['messages', 'mail_nachrichten']) {
    const id = hoechsteKennung(tabelle);
    if (!id) continue;
    const marke = markeAusKennung(id);
    if (!marke) {
      // Die Tabelle hat eine höchste Kennung, aber keines der beiden
      // bekannten Formate passt darauf — die Wasserlinie bleibt für diese
      // Tabelle bei 0, GENAU wie bei einer leeren Tabelle, nur dass hier
      // tatsächlich Zeilen daliegen. Auf einer echten Datenbank ist das der
      // eine Fall, den der Kopfkommentar als Gefahr beschreibt: eine stumme
      // Rückstufung der Abwehr. Deshalb laut, nicht `continue` ohne Meldung.
      console.warn(
        `[id] Höchste Kennung in ${tabelle} ("${id}") passt zu keinem bekannten Format — `
        + 'Wasserlinie bleibt für diese Tabelle bei 0. Das ist die produktive Datenbank vor '
        + 'diesem Release, wenn es hier fehlschlägt.',
      );
      continue;
    }
    if (!beste || marke.zeit > beste.zeit || (marke.zeit === beste.zeit && marke.lauf > beste.lauf)) {
      beste = marke;
    }
  }
  if (beste) {
    wasserlinie = beste.zeit;
    // Nicht bei null weiter: sonst könnte die erste ID nach einem Neustart,
    // der mitten in einer eingefrorenen Millisekunde passiert, wieder unter
    // die letzte ID des vorigen Laufs fallen (gleiche Zeit, Laufnummer 0
    // statt fortgesetzt).
    laufnummer = beste.lauf;
  }
}

/**
 * Kern von newId(): die nächste Marke (geklemmte Zeit + Laufnummer)
 * vergeben, ohne sie schon zu einer Kennung zusammenzusetzen — ausgelagert,
 * damit `newIdMitZeit()` unten dieselbe Vergabe (und damit dieselbe
 * Wasserlinie) benutzen kann wie `newId()` selbst, statt sie nachzubilden
 * und dabei zwangsläufig aus dem Takt zu geraten.
 */
function naechsteMarke(): Marke {
  sicherstellenWasserlinie();

  const jetzt = Date.now();
  let zeit: number;
  if (jetzt > wasserlinie) {
    // Normalfall: die Uhr ist voraus, die Wasserlinie folgt ihr.
    wasserlinie = jetzt;
    laufnummer = 0;
    zeit = jetzt;
    if (hinterher) {
      // Die Uhr hat die Wasserlinie wieder eingeholt (NTP-Abgleich griff) —
      // laut genug, damit ein Blick ins Log zeigt, dass und wie lange die
      // Systemuhr der zuletzt vergebenen ID hinterherlief.
      console.warn(
        `[id] Systemuhr hat aufgeholt: ${hinterherAnzahl} ID(s) liefen mit der zuletzt bekannten Zeit statt der `
        + '(zu alten) Systemuhr — vermutlich ein Neustart ohne batteriegepufferte Uhr.',
      );
      hinterher = false;
      hinterherAnzahl = 0;
    }
  } else {
    // jetzt <= wasserlinie: entweder ein ganz gewöhnlicher zweiter Aufruf in
    // derselben Millisekunde (jetzt === wasserlinie, passiert auch mit
    // intakter Uhr unter Last) oder die Uhr liegt tatsächlich zurück (jetzt
    // < wasserlinie) — nur DANN unten eine Meldung. In beiden Fällen bleibt
    // die Zeit stehen und die Laufnummer trägt die Reihenfolge weiter, statt
    // dass eine ID zurückspringt.
    laufnummer++;
    if (laufnummer >= LAUF_GRENZE) {
      // Praktisch unerreichbar (46 656 Aufrufe in derselben Millisekunde),
      // aber falls doch: eine virtuelle Millisekunde vorborgen statt
      // überzulaufen. Bleibt korrekt, weil die Wasserlinie ohnehin nur eine
      // Sortiermarke ist, keine echte Uhrzeit.
      wasserlinie++;
      laufnummer = 0;
    }
    zeit = wasserlinie;
    if (jetzt < wasserlinie) {
      if (!hinterher) {
        hinterher = true;
        console.warn(
          `[id] Systemuhr liegt ${wasserlinie - jetzt} ms hinter der zuletzt vergebenen ID-Zeit zurück — `
          + 'IDs laufen vorerst mit dieser Marke weiter, keine sortiert unter eine schon vergebene.',
        );
      }
      hinterherAnzahl++;
    }
  }

  return { zeit, lauf: laufnummer };
}

/** Eine Marke zur fertigen Kennung zusammensetzen. */
function kennungAusMarke(prefix: string, marke: Marke): string {
  const time = marke.zeit.toString(36).padStart(ZEIT_STELLEN, '0');
  const lauf = marke.lauf.toString(36).padStart(LAUF_STELLEN, '0');
  const rand = crypto.randomBytes(8).toString('base64url');
  return `${prefix}${time}${lauf}${rand}`;
}

/** Zeitlich sortierbare ID — siehe Kopfkommentar für die Garantie und ihre Herkunft. */
export function newId(prefix = ''): string {
  return kennungAusMarke(prefix, naechsteMarke());
}

/**
 * Wie `newId()`, gibt aber zusätzlich die geklemmte Zeit zurück, die in die
 * Kennung eingeflossen ist — für die seltenen Zeilen, deren `created_at`
 * (oder ein gleichbedeutendes Feld) in DERSELBEN Abfrage sortierend mit der
 * `id` verglichen wird wie `messages`/`channelHistory()` (store.ts: `id < ?
 * ... ORDER BY created_at DESC`). Ein eigener, zweiter `Date.now()`-Aufruf
 * für `created_at` könnte in den paar Sekunden nach einem Neustart mit
 * hinterherhinkender Uhr einen ANDEREN Wert liefern als den, der eben schon
 * in die Wasserlinie und damit in die `id` eingeflossen ist — genau die
 * Lücke, die `newId()` für die `id` selbst schließt, bliebe für
 * `created_at` offen und könnte `channelHistory()`s Blätterei in diesem
 * kurzen Fenster durcheinanderbringen (siehe Kopfkommentar).
 *
 * Für jede andere Tabelle (attachments, tasks, polls, …) gilt weiter das,
 * was der Kopfkommentar über `id` selbst sagt: eine zu alt geratene Zeit ist
 * unschön, aber folgenlos, weil nichts ihre Reihenfolge gegen eine `id`
 * prüft — dort bleibt ein gewöhnlicher `Date.now()`-Aufruf neben `newId()`
 * richtig, WEIL nichts von der Wasserlinie abhängt.
 */
export function newIdMitZeit(prefix = ''): { id: string; zeit: number } {
  const marke = naechsteMarke();
  return { id: kennungAusMarke(prefix, marke), zeit: marke.zeit };
}

export function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}
