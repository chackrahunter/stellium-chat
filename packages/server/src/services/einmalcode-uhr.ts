/**
 * Geht die Uhr des Servers richtig?
 *
 * WARUM DAS HIER STEHT UND NICHT IRGENDWO SONST
 *
 * Ein Einmalcode braucht nur zweierlei: das Geheimnis und die Uhrzeit. Das
 * Geheimnis liegt fest; die Uhrzeit ist der einzige bewegliche Teil — und
 * damit die einzige Stelle, an der alles still danebengehen kann. Geht die Uhr
 * um mehr als eine halbe Periode falsch, ist JEDER Code falsch. Auf dem Schirm
 * sieht man das nicht: sechs Ziffern, ein Balken, alles wie immer. Google sagt
 * „falscher Code", und es sieht aus, als sei die App kaputt.
 *
 * DER PI IST DER SCHLECHTESTE ORT FÜR EINE UHR
 *
 * Ein Raspberry Pi hat keine gepufferte Echtzeituhr. Ohne Knopfzelle beginnt
 * er nach einem Stromausfall irgendwo in der Vergangenheit und holt sich die
 * Zeit erst per NTP — was voraussetzt, dass das Netz schon steht. Genau in dem
 * Fenster zwischen Start und erstem Abgleich sind alle Codes Müll. Das ist
 * kein erfundener Fall, sondern der Normalfall nach einem Stromausfall.
 *
 * ZWEI PRÜFUNGEN, ABSICHTLICH VERSCHIEDEN
 *
 *   · `timedatectl` fragt das Betriebssystem, ob es seine Uhr für abgeglichen
 *     hält. Kostet nichts, braucht kein Netz, und beantwortet genau die Frage
 *     „hat NTP schon zugeschlagen?". Auf allem, was kein systemd hat (Dons
 *     Mac beim Entwickeln), fällt sie stillschweigend aus.
 *
 *   · Der Kopf `Date` einer HTTPS-Antwort sagt, um WIE VIEL die Uhr daneben
 *     liegt — das kann `timedatectl` nicht. Gefragt wird Google, und das ist
 *     kein beliebiger Server: Google ist die Gegenstelle, die den Code am Ende
 *     prüft. Mit dessen Uhr übereinzustimmen ist nicht ungefähr das Ziel,
 *     sondern buchstäblich die Anforderung.
 *
 * NICHTS DAVON HÄLT JEMANDEN AUF. Beide Prüfungen laufen nebenher und
 * gecacht; wer einen Code holt, wartet nie auf sie. Steht noch kein Ergebnis
 * fest, heißt die Antwort ehrlich „unbekannt" statt beruhigend „in Ordnung".
 */
import { execFile } from 'node:child_process';
import https from 'node:https';

/** Wie lange ein Ergebnis gilt, bevor neu nachgesehen wird. */
const FRISCH_MS = 10 * 60 * 1000;
/** Nach einem Fehlschlag früher wieder versuchen — vielleicht war nur das Netz weg. */
const FRISCH_FEHLER_MS = 60 * 1000;
/** Länger als das darf keine der beiden Prüfungen brauchen. */
const GEDULD_MS = 3000;

/**
 * Wogegen geprüft wird. Nicht die Startseite: `generate_204` ist Googles
 * Endpunkt für „bin ich online?", antwortet mit einem leeren 204 und trägt
 * trotzdem den `Date`-Kopf. Ein paar hundert Byte, kein Inhalt, kein Cookie.
 */
const ZEITQUELLE = 'https://www.google.com/generate_204';

export type Uhrzustand = 'unbekannt' | 'inOrdnung' | 'abweichung' | 'nichtAbgeglichen';

export interface Uhrstand {
  zustand: Uhrzustand;
  /** Um wie viel die Serveruhr vorgeht (positiv) oder nachgeht (negativ). */
  abweichungMs: number | null;
  /** Wie genau diese Zahl ist — die halbe Umlaufzeit der Anfrage. */
  ungenauigkeitMs: number | null;
  /** Wann zuletzt nachgesehen wurde. */
  geprueftAm: number | null;
  /** Hält das Betriebssystem seine Uhr für abgeglichen? `null` = nicht feststellbar. */
  abgeglichen: boolean | null;
}

const UNBEKANNT: Uhrstand = {
  zustand: 'unbekannt', abweichungMs: null, ungenauigkeitMs: null, geprueftAm: null, abgeglichen: null,
};

let letzter: Uhrstand = UNBEKANNT;
let laeuft: Promise<void> | null = null;

/**
 * Ab wann eine Abweichung zählt.
 *
 * Eine halbe Periode ist die Grenze, ab der die Fensternummer kippen KANN:
 * liegt die Uhr um mehr als das daneben, rechnet man mindestens zeitweise im
 * falschen Fenster. Prüfer lassen üblicherweise ein Fenster nach jeder Seite
 * zu (RFC 6238, Abschnitt 5.2 EMPFIEHLT „höchstens einen Zeitschritt" für die
 * Laufzeit im Netz), deshalb geht es bis dahin meist noch gut — aber „meist
 * noch gut" ist genau der Zustand, in dem ein Fehler sich versteckt, statt
 * aufzufallen. Darum wird ab hier gewarnt, nicht erst, wenn nichts mehr geht.
 */
export function warnschwelleMs(periode: number): number {
  return Math.floor((periode * 1000) / 2);
}

/** `timedatectl` fragen. Gibt `null`, wo es das Werkzeug nicht gibt. */
function abgeglichenFragen(): Promise<boolean | null> {
  return new Promise((fertig) => {
    /* execFile statt exec: keine Shell dazwischen, also nichts zu zitieren. */
    execFile('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'],
      { timeout: GEDULD_MS },
      (fehler, aus) => {
        if (fehler) { fertig(null); return; }          // kein systemd, kein Urteil
        fertig(aus.trim() === 'yes');
      });
  });
}

/**
 * Die Uhr gegen den `Date`-Kopf einer fremden Antwort halten.
 *
 * Gerechnet wird wie bei NTP: die Antwort entsteht irgendwann ZWISCHEN dem
 * Absenden und dem Eintreffen, also ist die Mitte der beste Schätzwert für
 * „unsere Uhr in dem Augenblick". Die halbe Umlaufzeit ist dann die
 * Unsicherheit — sie kommt als eigene Zahl zurück, statt stillschweigend
 * unterschlagen zu werden. Ohne sie sähe eine lahme Leitung wie eine falsche
 * Uhr aus, und die Tafel schlüge Alarm, wo nichts ist.
 */
function abweichungMessen(): Promise<{ abweichungMs: number; ungenauigkeitMs: number } | null> {
  return new Promise((fertig) => {
    let erledigt = false;
    const schluss = (wert: { abweichungMs: number; ungenauigkeitMs: number } | null) => {
      if (erledigt) return;
      erledigt = true;
      fertig(wert);
    };

    const vorher = Date.now();
    const anfrage = https.request(ZEITQUELLE, { method: 'HEAD', timeout: GEDULD_MS }, (antwort) => {
      const nachher = Date.now();
      antwort.resume();                                 // Rumpf verwerfen, Verbindung freigeben
      const kopf = antwort.headers.date;
      if (!kopf) { schluss(null); return; }
      const fremd = Date.parse(kopf);
      if (!Number.isFinite(fremd)) { schluss(null); return; }
      const mitte = vorher + (nachher - vorher) / 2;
      schluss({
        abweichungMs: Math.round(mitte - fremd),
        /* Die Sekundenauflösung des `Date`-Kopfs kommt zur halben Umlaufzeit
           dazu: mehr als auf 500 ms genau kann eine auf Sekunden gerundete
           Angabe grundsätzlich nicht sein. */
        ungenauigkeitMs: Math.round((nachher - vorher) / 2) + 500,
      });
    });
    anfrage.on('timeout', () => { anfrage.destroy(); schluss(null); });
    anfrage.on('error', () => schluss(null));
    anfrage.end();
  });
}

/** Beide Prüfungen einmal durchführen und das Ergebnis merken. */
async function nachsehen(periode: number): Promise<void> {
  const [abgeglichen, messung] = await Promise.all([abgeglichenFragen(), abweichungMessen()]);
  const jetzt = Date.now();

  let zustand: Uhrzustand;
  if (messung) {
    /* Die Unsicherheit geht zu Gunsten des Servers ab: gemeldet wird nur, was
       auch nach Abzug der Messungenauigkeit noch über der Schwelle liegt. */
    const sicher = Math.max(0, Math.abs(messung.abweichungMs) - messung.ungenauigkeitMs);
    zustand = sicher > warnschwelleMs(periode) ? 'abweichung' : 'inOrdnung';
  } else if (abgeglichen === false) {
    /* Ohne Messung, aber das System sagt selbst, dass es nicht abgeglichen
       ist — das ist der Zustand direkt nach dem Start ohne Netz. */
    zustand = 'nichtAbgeglichen';
  } else {
    zustand = 'unbekannt';
  }

  letzter = {
    zustand,
    abweichungMs: messung?.abweichungMs ?? null,
    ungenauigkeitMs: messung?.ungenauigkeitMs ?? null,
    geprueftAm: jetzt,
    abgeglichen,
  };

  /* Ins Protokoll nur, wenn wirklich etwas nicht stimmt — und ohne jeden
     Bezug zu einem Konto oder Geheimnis. Ein Zeitfehler betrifft alle Codes
     gleichermaßen, da hilft kein Konto in der Zeile. */
  if (zustand === 'abweichung') {
    console.warn(
      `[einmalcode] Die Uhr des Servers geht um ${Math.round((letzter.abweichungMs ?? 0) / 1000)} s falsch. `
      + 'Solange das so bleibt, weist Google jeden Einmalcode ab. Auf dem Pi prüfen: timedatectl status',
    );
  } else if (zustand === 'nichtAbgeglichen') {
    console.warn('[einmalcode] Die Uhr des Servers ist noch nicht per NTP abgeglichen — Einmalcodes können falsch sein.');
  }
}

/**
 * Der zuletzt bekannte Stand — sofort, ohne zu warten.
 *
 * Ist er alt oder gibt es noch keinen, wird NEBENHER nachgesehen und beim
 * nächsten Aufruf das frischere Ergebnis geliefert. Wer einen Code holt,
 * wartet dadurch nie auf eine Netzanfrage; die Tafel fragt ohnehin im Takt
 * nach und bekommt den richtigen Stand ein paar Sekunden später.
 */
export function uhrstand(periode: number): Uhrstand {
  const alter = letzter.geprueftAm === null ? Infinity : Date.now() - letzter.geprueftAm;
  const grenze = letzter.zustand === 'unbekannt' ? FRISCH_FEHLER_MS : FRISCH_MS;
  if (alter > grenze && !laeuft) {
    laeuft = nachsehen(periode)
      .catch(() => { /* eine Uhrprüfung darf nie etwas kaputt machen */ })
      .finally(() => { laeuft = null; });
  }
  return letzter;
}

/** Nur für Prüfläufe: den gemerkten Stand vergessen. */
export function zuruecksetzen(): void {
  letzter = UNBEKANNT;
}
