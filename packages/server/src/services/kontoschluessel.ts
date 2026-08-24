import type { KontoSchluesselBlob } from '@stellium/shared';
import { db } from '../db/index.js';
import { abweisung } from '../util/abweisung.js';
import { hartVerwerfen, kontoPaketeWegraeumen } from './kontoverwerfen.js';
import * as notzugang from './notzugang.js';

/**
 * Der Kontoschlüssel — verwahrt, nie gelesen.
 *
 * WAS HIER PASSIERT UND WAS AUSDRÜCKLICH NICHT
 *
 * Diese Datei nimmt einen Haufen Bytes entgegen und gibt ihn wieder heraus.
 * Sie rechnet an keiner Stelle mit einem Schlüssel, leitet nichts aus einem
 * Passwort ab und sieht nie einen Klartext. Der Schlüssel, mit dem `daten`
 * verschlossen ist, entsteht ausschließlich auf dem Gerät (PBKDF2 über das
 * Passwort, siehe lib/kontoschluessel.ts) und erreicht den Server nie —
 * genau wie der private ECDH-Teil in services/vertraulich.ts.
 *
 * WARUM ES DEN KONTOSCHLÜSSEL GIBT
 *
 * `notiz_schluessel_pakete` hält eine Zeile je (Notiz, KONTO), gerechnet
 * wurde sie aber mit dem privaten Teil EINES Geräts. Ein zweites Gerät
 * desselben Kontos kann sie deshalb nie öffnen — es schlägt beim Auspacken
 * den öffentlichen Teil "des Kontos" nach und bekommt seinen eigenen. Der
 * Kontoschlüssel gehört dem Konto statt einem Gerät und hebt diese
 * Verwechslung auf.
 *
 * DIE EINE ENTSCHEIDUNG, AUF DER ALLES RUHT: DER ABDRUCK
 *
 * `hinterlegen()` unterscheidet zwei ganz verschiedene Vorgänge — und es
 * unterscheidet sie nicht daran, was der Client BEHAUPTET, sondern am
 * Abdruck des Schlüssels selbst:
 *
 *   Derselbe Abdruck  ->  UMSCHLIESSEN. Derselbe Kontoschlüssel, neue Hülle
 *                         (das Passwort hat gewechselt). `fassung` bleibt,
 *                         und damit bleibt jedes Notiz-Kontopaket gültig.
 *
 *   Anderer Abdruck   ->  ERSATZ. Ein neuer Kontoschlüssel. `fassung` zählt
 *                         hoch, und JEDES bestehende Kontopaket fällt weg —
 *                         das der Notizen wie das des Passwort-Tresors (die
 *                         vollständige Liste steht unten in
 *                         KONTO_PAKET_TABELLEN). Es wäre mit dem alten
 *                         Schlüssel verpackt und niemand könnte es je wieder
 *                         öffnen.
 *
 * Der zweite Fall ist der wichtige. Bliebe die alte Zeile stehen, stünde in
 * der Datenbank ein Paket, das richtig aussieht und sich nie öffnen lässt —
 * schlimmer als eine ehrliche Lücke, denn eine Lücke füllt der Kontoweg von
 * selbst wieder auf (siehe notizenOhneKontoPaket in services/notizen.ts),
 * ein falsches Paket nicht.
 *
 * Der Abdruck ist SHA-256 über den rohen Schlüssel mit eigenem Vorspann. Er
 * verrät den Schlüssel nicht — 256 Bit Zufall lassen sich nicht
 * zurückrechnen — und ist trotzdem genau die Auskunft, die dieser Server
 * braucht: "ist das noch derselbe?".
 *
 * DER NOTZUGANG — DIE EINE AUSNAHME VON „LEERE DATEN HEISST WEG"
 *
 * Seit es den Notzugang gibt (services/notzugang.ts), kann derselbe
 * Kontoschlüssel eine ZWEITE Hülle haben: eine, die nicht am Passwort hängt,
 * sondern an einem Notschlüssel, der in fünf Anteile zerlegt bei fünf
 * Menschen liegt. Drei davon setzen ihn zusammen.
 *
 * Für diese Datei ändert das genau zwei Stellen, und beide entscheiden
 * darüber, ob eine Wiederherstellung rettet oder zerstört:
 *
 *   verwerfen()  räumt die Kontopakete NICHT weg, solange ein Notzugang für
 *                dieses Konto steht. Nur die Passworthülle stirbt; `abdruck`
 *                und `fassung` bleiben stehen, denn der Schlüssel dahinter
 *                lebt weiter. Ein zweiter Aufruf über dieselbe, schon leere
 *                Hülle tut nichts — er läuft auf dem gewöhnlichen Weg
 *                (zurücksetzen, dann Ersteinrichtung), und ein zweiter
 *                Aufruf, der das Gegenteil des ersten tut, ist kein
 *                Sonderfall, sondern der Normalfall.
 *
 *   hinterlegen() erkennt die zurückkehrende Hülle am Abdruck AUCH DANN als
 *                „derselbe Schlüssel", wenn `daten` gerade leer ist — und
 *                weist umgekehrt jeden ERSATZ ab, solange ein Notzugang
 *                aussteht. Ohne das zweite wäre das erste wertlos: eine App,
 *                die die leere Spalte sieht und nach ihrer eigenen Regel
 *                einen frischen Schlüssel mintet, räumte alles weg, was
 *                gerade gerettet werden soll.
 *
 * Was hier trotzdem NICHT passiert: der Server sieht weder den Notschlüssel
 * noch einen Anteil im Klartext noch den Kontoschlüssel. Er vergleicht
 * Abdrücke, mehr nicht.
 */

/* Die Liste der Kontopaket-Tabellen und das harte Verwerfen stehen in
   services/kontoverwerfen.ts — nicht mehr hier. Der Grund steht dort im
   Dateikopf, kurz: services/notzugang.ts braucht dieselbe Rechnung
   (aufheben()), und diese Datei bindet notzugang.ts bereits ein. Eine dritte
   Datei, die keinen der beiden kennt, spart die gegenseitige Einbindung. */

/** Für die Prüfläufe, unverändert erreichbar: dieselbe eine Liste. */
export { kontoPaketTabellen } from './kontoverwerfen.js';

/** Was `holen()` herausgibt. `null` heißt: es gibt gerade keinen. */
export function holen(userId: string): KontoSchluesselBlob | null {
  const r = db.get<any>(
    'SELECT kdf, salz, runden, alg, iv, daten, abdruck, fassung FROM konto_schluessel WHERE user_id = ?',
    userId,
  );
  // Leere `daten` heißt: die Zeile steht nur noch da, damit `fassung` weiter
  // zählt (siehe verwerfen()). Ein Kontoschlüssel ist das nicht.
  if (!r || !r.daten) return null;
  return {
    kdf: r.kdf, salz: r.salz, runden: r.runden, alg: r.alg,
    iv: r.iv, daten: r.daten, abdruck: r.abdruck, fassung: r.fassung,
  };
}

/**
 * Die Fassung des BRAUCHBAREN Kontoschlüssels — oder 0, wenn es gerade
 * keinen gibt.
 *
 * Jedes Notizpaket wird gegen diese Zahl geprüft, und die 0 ist dabei kein
 * Sonderfall, sondern die Antwort: ohne Kontoschlüssel gibt es nichts, womit
 * sich ein Kontopaket packen ODER öffnen ließe, also darf auch keines
 * angenommen oder herausgegeben werden.
 *
 * Bewusst NICHT der rohe Zähler aus der Zeile: nach verwerfen() steht dort
 * eine Zahl, zu der es keinen Schlüssel gibt. Sie zählt weiter (damit eine
 * spätere Fassung nie mit einer früheren zusammenfällt), aber sie wird
 * keinem Gerät je zugeteilt — hinterlegen() zählt beim nächsten echten
 * Schlüssel noch einmal hoch. Deshalb kann kein Gerät ein Paket unter
 * dieser Zahl schreiben, und deshalb steht hier 0 statt ihrer.
 */
export function aktuelleFassung(userId: string): number {
  const r = db.get<{ fassung: number; daten: string }>(
    'SELECT fassung, daten FROM konto_schluessel WHERE user_id = ?', userId,
  );
  return r && r.daten ? r.fassung : 0;
}

/**
 * Wartet für dieses Konto eine Wiederherstellung?
 *
 * DIE EINE STELLE, an der diese Frage beantwortet wird — und zwar für beide
 * Seiten. Die Oberfläche bekommt sie als `notzugangWartet` über
 * GET /api/konto/schluessel (http/routes.ts) und lässt daraufhin die Finger
 * vom Minten eines frischen Schlüssels; hinterlegenInTransaktion() oben
 * weist einen Ersatz auf derselben Tatsache ab. Zwei Rechnungen für eine
 * Frage liefen bisher auseinander: die Route fragte
 * `notzugang.standFuer().eingerichtet`, der Server `alt.abdruck &&
 * deckt(...)`. Sie widersprachen sich in beide Richtungen — nach einem
 * harten Verwerfen sagte die Route „Finger weg", während der Server einen
 * Ersatz bereitwillig annahm.
 *
 * `holen()` und nicht die rohe Spalte: „es gibt keine Hülle zum Öffnen"
 * heißt hier genau dasselbe wie überall sonst in dieser Datei.
 */
export function notzugangWartet(userId: string): boolean {
  return !holen(userId) && Boolean(notzugang.gedeckterAbdruck(userId));
}

function vollstaendig(blob: KontoSchluesselBlob | undefined | null): boolean {
  return Boolean(
    blob && blob.kdf && blob.salz && blob.alg && blob.iv && blob.daten && blob.abdruck
    && Number.isInteger(blob.runden) && blob.runden > 0,
  );
}

/**
 * Hinterlegen — Umschließen oder Ersatz, entschieden am Abdruck (siehe
 * Dateikopf).
 *
 * Gibt die Fassung zurück, unter der der Schlüssel jetzt steht. Das ist
 * keine Höflichkeit: das Gerät braucht sie, um überhaupt ein Notizpaket
 * schreiben zu dürfen.
 */
export function hinterlegen(userId: string, blob: KontoSchluesselBlob): number {
  return db.transaction(() => hinterlegenInTransaktion(userId, blob));
}

/**
 * Dasselbe ohne eigene Transaktion — für changeOwnPassword() in
 * services/users.ts, wo Passwort und Hülle gemeinsam stehen oder gemeinsam
 * fallen müssen. Die Datenbankhülle hier im Haus kennt keine
 * verschachtelten Transaktionen (kein SAVEPOINT, siehe db/index.ts); ein
 * zweites BEGIN mitten in einem laufenden risse den ganzen Wechsel mit.
 */
export function hinterlegenInTransaktion(userId: string, blob: KontoSchluesselBlob): number {
  if (!vollstaendig(blob)) throw abweisung('fehler.schluesselUnvollstaendig', 'Der Schlüssel ist unvollständig.');

  const jetzt = Date.now();
  let fassung = 0;
  {
    const alt = db.get<{ abdruck: string; daten: string; fassung: number }>(
      'SELECT abdruck, daten, fassung FROM konto_schluessel WHERE user_id = ?', userId,
    );

    /* Welchen Schlüssel deckt der Notzugang dieses Kontos? Der Abdruck
       kommt aus der Zeile des NOTZUGANGS und nicht mehr aus
       `konto_schluessel.abdruck` — das ist der ganze Unterschied. Die
       bisherige Zeile lautete

           Boolean(alt && alt.abdruck && notzugang.deckt(userId, alt.abdruck))

       und stützte damit die Sicherung auf genau die Spalte, die das harte
       Verwerfen unten leert: `gedeckt` war wahr, solange der Zustand ohnehin
       heil war, und wurde in dem Augenblick falsch, in dem er gefährlich
       wurde. Die Zeile des Notzugangs leert niemand nebenbei. */
    const notAbdruck = notzugang.gedeckterAbdruck(userId);
    const gedeckt = Boolean(notAbdruck);

    /* DERSELBE Schlüssel, auch wenn `daten` gerade leer ist: nach einem
       schonenden Verwerfen (verwerfen() unten) steht dort nichts mehr, der
       Abdruck aber schon — und genau daran erkennt der Server die
       Wiederherstellung als das, was sie ist: eine neue Hülle um den ALTEN
       Schlüssel. Ohne diesen Zusatz liefe sie in den Ersatzzweig und räumte
       jedes Notiz- und Tresorpaket weg, das sie retten sollte.

       Der zweite Zweig ist die Heimkehr aus einem Konto, dem der Abdruck
       schon abhanden gekommen ist (eine Datenbank aus der Zeit, in der das
       zweite verwerfen() der Ersteinrichtung ihn wegräumte). Dort ist die
       Zeile des Notzugangs die einzige verbliebene Auskunft darüber, welcher
       Schlüssel hierher gehört. Ausdrücklich NUR, solange weder Hülle noch
       Abdruck dastehen: läge ein anderer, gültiger Schlüssel in der Zeile,
       machte diese Bedingung aus einem Ersatz stillschweigend ein
       Umschließen — die Kontopakete blieben unter einem Schlüssel stehen,
       der sie nicht öffnet. */
    const heimkehrOhneAbdruck = Boolean(alt && !alt.daten && !alt.abdruck && notAbdruck === blob.abdruck);
    const derselbe = Boolean(alt && alt.abdruck === blob.abdruck && (alt.daten || gedeckt))
      || heimkehrOhneAbdruck;

    /* Und die Gegenrichtung, fail closed: solange ein Notzugang für dieses
       Konto steht, wird KEIN Ersatz angenommen. Eine ältere App, die die
       leere Spalte sieht und nach ihrer eigenen Regel einen frischen
       Kontoschlüssel mintet (lib/kontoschluessel.ts, dritter Ausgang), würde
       sonst genau in dem Augenblick alles wegräumen, in dem drei Leute
       gerade dabei sind, es zu retten. Wer wirklich einen neuen Schlüssel
       will, hebt vorher den Notzugang auf.

       Dass daraus keine Aussperrung wird, hängt am zweiten Zweig von
       `derselbe` oben: ein Konto ohne Hülle UND ohne Abdruck könnte sonst
       überhaupt keinen Schlüssel mehr hinterlegen, denn jeder wäre „nicht
       derselbe". Der zurückkehrende, echte Schlüssel geht durch, jeder
       andere nicht. */
    if (!derselbe && gedeckt) {
      throw abweisung(
        'fehler.notzugangWartet',
        'Für dieses Konto steht eine Wiederherstellung aus. Erst einlösen oder den Notzugang aufheben.',
      );
    }

    fassung = derselbe ? alt!.fassung : (alt?.fassung ?? 0) + 1;

    if (!derselbe) {
      /* Ersatz: alles, was mit dem vorigen Kontoschlüssel verpackt wurde,
         ist ab jetzt nicht mehr zu öffnen. Wegräumen und nicht stehen
         lassen — eine fehlende Zeile heilt von selbst nach (das Gerät, das
         die Notiz über den Geräteweg öffnen kann, schreibt sie neu), eine
         falsche Zeile nie. Über die Liste und nicht Tabelle für Tabelle von
         Hand: hier stand jahrelang nur `notiz_konto_pakete`, und der
         Passwort-Tresor kam später dazu, ohne dass es jemandem auffiel. */
      kontoPaketeWegraeumen(userId);
    }

    db.run(
      `INSERT INTO konto_schluessel (user_id, kdf, salz, runden, alg, iv, daten, abdruck, fassung, erstellt_am, geaendert_am)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         kdf = excluded.kdf, salz = excluded.salz, runden = excluded.runden, alg = excluded.alg,
         iv = excluded.iv, daten = excluded.daten, abdruck = excluded.abdruck,
         fassung = excluded.fassung, geaendert_am = excluded.geaendert_am`,
      userId, blob.kdf, blob.salz, blob.runden, blob.alg,
      blob.iv, blob.daten, blob.abdruck, fassung, jetzt, jetzt,
    );

    /* Nur im zweiten Zweig: dort — und nur dort — ist bekannt, dass die
       Fassung in der Zeile des Notzugangs veraltet ist. Das alte, harte
       Verwerfen hat `konto_schluessel.fassung` hochgezählt und
       `konto_notzugang.konto_fassung` stehen lassen; solange die beiden
       auseinandergehen, meldet jedes Gerät bei jeder Wiederherstellung einen
       Fehlschlag, den es nicht gibt. Die ausgeschriebene Begründung — auch
       dazu, warum die Prüfung im Gerät dabei streng bleibt — steht bei
       kontoFassungNachziehen() in services/notzugang.ts. */
    if (heimkehrOhneAbdruck) notzugang.kontoFassungNachziehen(userId, fassung);
  }
  return fassung;
}

/**
 * Den Kontoschlüssel für ungültig erklären — ohne einen neuen zu haben.
 *
 * Gerufen, wo ein Passwort gesetzt wird, OHNE dass das bisherige bekannt
 * war: beim Zurücksetzen durch die Verwaltung und bei der Ersteinrichtung.
 * In beiden Fällen kann niemand mehr die Hülle öffnen, in der der
 * Kontoschlüssel steckt — auch die Person selbst nicht.
 *
 * Die ZEILE bleibt trotzdem stehen, nur `daten` wird leer. Der Grund ist
 * `fassung`: verschwände die Zeile, finge ein späterer Kontoschlüssel wieder
 * bei 1 an, und ein liegengebliebenes Kontopaket aus einer früheren Runde
 * sähe plötzlich wieder aktuell aus. Die Pakete werden hier zwar ohnehin
 * weggeräumt — aber diese Sicherung soll nicht davon abhängen, dass das
 * Wegräumen wirklich jede Zeile erwischt hat.
 *
 * „Die Pakete" heißt: die aus JEDER Tabelle in KONTO_PAKET_TABELLEN, also
 * auch die des Passwort-Tresors. Genau daran hing der Zweck dieses Aufrufs
 * beim Zurücksetzen eines Passworts (resetPassword() in services/users.ts):
 * ein Tresor-Kontopaket, das den Wechsel überlebt, ist mit dem alten
 * Passwort weiterhin zu öffnen — dann hätte das Zurücksetzen genau das nicht
 * geschlossen, wofür es da ist.
 *
 * Ohne eigene db.transaction(): läuft innerhalb der Transaktion des
 * Aufrufers (services/users.ts) — die Datenbankhülle hier im Haus kennt
 * keine verschachtelten Transaktionen, siehe kontoBereinigen() in
 * services/notizen.ts für dieselbe Begründung.
 */
export function verwerfen(userId: string): void {
  const jetzt = Date.now();

  /* DER SCHONENDE WEG — wenn ein Notzugang für dieses Konto steht.

     Was hier passiert und warum es nicht dasselbe ist wie unten: die HÜLLE
     stirbt (salz, iv, daten, runden werden leer — mit dem alten Passwort
     lässt sich nichts mehr aufmachen), aber `abdruck` und `fassung` bleiben
     stehen und die Kontopakete auch. Der Kontoschlüssel selbst lebt weiter,
     erreichbar allein über drei von fünf Anteilen.

     WAS DAS KOSTET, ehrlich benannt: das harte Verwerfen unten ist dafür da,
     dass ein DURCHGESICKERTES Passwort mit einer alten Sicherung zusammen
     nichts mehr aufmacht. Diese Sicherung fällt hier weg — wer einen
     Notzugang einrichtet, tauscht sie gegen die Rettung seiner Daten ein.
     Das ist kein Versehen, sondern derselbe Widerspruch wie am Anfang: wer
     wiederherstellen kann, kann lesen. Der Griff für ein durchgesickertes
     Passwort ist deshalb ein anderer und steht ausdrücklich zur Verfügung —
     erst notzugang.aufheben() (das darf eine einzelne Person, es öffnet ja
     nichts), dann zurücksetzen. Dann läuft wieder der Zweig darunter.

     WORAN DIE ENTSCHEIDUNG HÄNGT — UND WORAN SIE FRÜHER HING. Hier stand

         if (alt && alt.daten && alt.abdruck && notzugang.deckt(userId, alt.abdruck))

     also „gibt es hier noch eine PASSWORTHÜLLE, die ein Notzugang deckt?".
     Das ist die falsche Frage, denn diese Funktion läuft auf dem
     gewöhnlichen Weg ZWEIMAL: einmal beim Zurücksetzen durch die Verwaltung
     (resetPassword()) und ein zweites Mal, wenn die Person danach ihr
     eigenes Passwort setzt (completeSetup(), beides in services/users.ts).
     Beim zweiten Mal war `daten` vom ersten Mal längst leer, die Bedingung
     also falsch — und der harte Zweig darunter räumte jedes Notiz- und
     Tresorpaket weg. Der Notzugang holte danach den richtigen
     Kontoschlüssel zurück und fand nichts mehr vor, das er hätte öffnen
     können. Der Weg, für den es diese Funktion gibt, zerstörte, was er
     retten sollte, und zwar auf dem gewöhnlichen Weg, nicht in einem
     Sonderfall.

     Die Frage lautet deshalb jetzt „deckt ein Notzugang den Schlüssel
     dieses Kontos?" — eine Tatsache, die kein Verwerfen verändert. Und der
     zweite Durchgang ist ein NICHTSTUN: die Hülle ist schon tot, es gibt
     nichts mehr zu leeren, und eine zweite `geschont`-Zeile in der Spur
     behauptete ein zweites Ereignis, das es nicht gab.

     UND WELCHEN SCHLÜSSEL DECKT ER? Nicht „steht hier irgendein Notzugang?",
     sondern „deckt er GENAU DEN Schlüssel, der hier liegt?". Der Vergleich
     hing früher an deckt(userId, alt.abdruck) und fiel zusammen mit dem
     Fehler weg, neben dem er stand. Ohne ihn schonte diese Funktion einen
     Kontoschlüssel, den der Notzugang gar nicht zurückholen kann: die Pakete
     blieben unter einem Schlüssel liegen, den niemand mehr hat, und das
     durchgesickerte Passwort öffnete sie mit einer alten Sicherung weiter.

     Die beiden Zustände, in denen der Vergleich NICHT anschlagen darf und
     deshalb ausdrücklich erlaubt sind:

       · nach einem schonenden Verwerfen steht `abdruck` noch und ist gleich
         dem gedeckten — der gewöhnliche zweite Durchgang (completeSetup()).
       · in einer Datenbank aus der Zeit, in der das zweite Verwerfen den
         Abdruck wegräumte, steht dort GAR NICHTS mehr. Dann ist die Zeile
         des Notzugangs die einzige Auskunft darüber, welcher Schlüssel
         hierher gehört, und „leer" darf nicht als „ein anderer" gelesen
         werden — sonst brennt genau hier wieder alles nieder, was der
         Notzugang gleich zurückholen will. Dasselbe Zugeständnis macht der
         zweite Zweig von `derselbe` in hinterlegenInTransaktion() oben, aus
         demselben Grund.

     Bleibt der Fall, für den die Sicherung da ist: ein Abdruck steht da UND
     der Notzugang deckt einen anderen. Das kann in dieser Fassung nicht mehr
     entstehen (einrichten() verlangt Gleichheit, der Ersatzzweig wird bei
     stehendem Notzugang abgewiesen) — es ist eine Wache über einen Zustand,
     den nur eine ältere Fassung hinterlassen haben kann. Eine Wache, die
     heute nicht erreichbar ist, ist trotzdem eine Wache. */
  const alt = db.get<{ abdruck: string; daten: string }>(
    'SELECT abdruck, daten FROM konto_schluessel WHERE user_id = ?', userId,
  );
  const gedeckt = notzugang.gedeckterAbdruck(userId);
  if (alt && gedeckt && (!alt.abdruck || alt.abdruck === gedeckt)) {
    if (!alt.daten) return;   // schon geschont — ein zweiter Aufruf tut nichts
    db.run(
      `UPDATE konto_schluessel SET salz = '', runden = 0, iv = '', daten = '', geaendert_am = ?
       WHERE user_id = ?`,
      jetzt, userId,
    );
    notzugang.geschontVermerken(userId);
    return;
  }

  /* DER HARTE WEG — Pakete weg, Abdruck leer, Fassung eins weiter. Die
     Rechnung steht in services/kontoverwerfen.ts, weil notzugang.aufheben()
     genau dieselbe braucht: wer die Rettungsleine kappt, nachdem ein
     schonendes Verwerfen die Pakete stehen ließ, muss sie hier nachholen. */
  hartVerwerfen(userId);
}
