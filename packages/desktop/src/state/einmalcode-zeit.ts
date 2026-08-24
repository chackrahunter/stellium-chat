/**
 * Die Zeitrechnung der Einmalcode-Tafel — reine Funktionen, kein React.
 *
 * WARUM DAS ÜBERHAUPT EIGEN STEHT
 *
 * Ein Einmalcode hängt an genau zwei Dingen: dem Geheimnis und der Uhr. Das
 * Geheimnis liegt auf dem Pi und wird dort verrechnet (siehe
 * server/services/einmalcode.ts). Bleibt die Uhr — und die ist der Teil, der
 * im Alltag tatsächlich kaputtgeht, ohne dass es jemand sieht. Deshalb steht
 * die Rechnung hier für sich und nicht in der Komponente: so lässt sie sich
 * gegen erfundene Abweichungen halten, ohne ein Fenster zu öffnen
 * (scripts/einmalcode-uhr-pruefen.mjs tut genau das).
 *
 * WAS EINE SCHIEFE LAPTOP-UHR HIER (NICHT) ANRICHTET
 *
 * Der Code kommt fertig vom Server. Geht die Uhr DIESES Rechners falsch, ist
 * er trotzdem richtig — anders als bei einem Authenticator auf dem Telefon,
 * wo eine schiefe Uhr jeden Code wertlos macht. Falsch würde nur der Balken
 * darunter: „noch 25 Sekunden", während in Wahrheit drei übrig sind. Wer
 * danach tippt, kommt zu spät und weiß nicht, warum.
 *
 * Deshalb wird die eigene Uhr nicht angeprangert, sondern HERAUSGERECHNET:
 * `versatzMessen()` misst einmal, um wie viel sie danebenliegt, und jede
 * Anzeige rechnet ab da in Serverzeit. Gemeldet wird sie erst, wenn sie so
 * weit weg ist, dass sie ohnehin an anderer Stelle auffällt.
 *
 * WAS EINE SCHIEFE SERVER-UHR ANRICHTET
 *
 * Alles. Geht die Uhr des Pi falsch, ist JEDER Code falsch, für alle. Das
 * merkt man erst bei Google. Dieses Urteil kommt nicht von hier, sondern vom
 * Server selbst (server/services/einmalcode-uhr.ts, der sich gegen Googles
 * eigenen `Date`-Kopf hält) — hier wird es nur in eine Anzeige übersetzt.
 */

/** Was `POST /api/einmalcode/konten/:id/codes` an Zeitangaben zurückgibt. */
export interface Codefenster {
  fenster: string;
  code: string;
  gueltigAbMs: number;
  gueltigBisMs: number;
}

/** Das Urteil des Servers über seine eigene Uhr. */
export interface Uhrstand {
  zustand: 'unbekannt' | 'inOrdnung' | 'abweichung' | 'nichtAbgeglichen';
  abweichungMs: number | null;
  ungenauigkeitMs: number | null;
  geprueftAm: number | null;
  abgeglichen: boolean | null;
}

/** Wie weit die eigene Uhr von der des Servers abweicht. */
export interface Zeitabgleich {
  /** Serverzeit minus eigene Zeit. Positiv: der Server ist voraus, wir gehen nach. */
  versatzMs: number;
  /** Wie genau diese Zahl ist — die halbe Umlaufzeit der Anfrage. */
  ungenauigkeitMs: number;
  /** Wann gemessen wurde (eigene Uhr). */
  gemessenAm: number;
}

/**
 * Ab welchem Anteil einer Periode eine Abweichung zählt.
 *
 * Eine halbe Periode ist die Grenze, ab der die Fensternummer kippen KANN.
 * Prüfer lassen üblicherweise ein Fenster nach jeder Seite zu — RFC 6238,
 * Abschnitt 5.2 EMPFIEHLT „höchstens einen Zeitschritt" für die Laufzeit im
 * Netz —, deshalb geht es bis dahin meist noch gut. „Meist noch gut" ist aber
 * genau der Zustand, in dem sich ein Fehler versteckt, statt aufzufallen.
 * Dieselbe Zahl steht auf der Serverseite (einmalcode-uhr.ts,
 * `warnschwelleMs`); sie ist beide Male aus derselben Überlegung abgeleitet
 * und nicht abgeschrieben.
 */
export const SCHWELLE_ANTEIL = 0.5;

/** Die Schwelle in Millisekunden für eine gegebene Periodenlänge. */
export function schwelleMs(periodeSekunden: number): number {
  return Math.floor(periodeSekunden * 1000 * SCHWELLE_ANTEIL);
}

/**
 * Den Versatz zur Serveruhr messen — nach Art von NTP.
 *
 * Die Antwort entsteht irgendwann ZWISCHEN dem Absenden und dem Eintreffen.
 * Die Mitte der beiden eigenen Zeitpunkte ist deshalb der beste Schätzwert
 * dafür, wie spät es bei uns war, als der Server seine Zeit notierte. Die
 * halbe Umlaufzeit bleibt als Unsicherheit stehen, statt unterschlagen zu
 * werden — ohne sie sähe eine lahme Leitung aus wie eine falsche Uhr, und die
 * Tafel schlüge Alarm, wo nichts ist.
 */
export function versatzMessen(vorherMs: number, nachherMs: number, serverMs: number): Zeitabgleich {
  const mitte = vorherMs + (nachherMs - vorherMs) / 2;
  return {
    versatzMs: Math.round(serverMs - mitte),
    ungenauigkeitMs: Math.round(Math.abs(nachherMs - vorherMs) / 2),
    gemessenAm: nachherMs,
  };
}

/**
 * Wie spät es auf dem Server ist — jetzt.
 *
 * Ohne Messung die eigene Uhr; das ist der Zustand vor der ersten Antwort und
 * besser als gar keine Anzeige.
 */
export function serverJetzt(abgleich: Zeitabgleich | null, jetztMs = Date.now()): number {
  return jetztMs + (abgleich?.versatzMs ?? 0);
}

/**
 * Was von der gemessenen Abweichung nach Abzug der Messungenauigkeit sicher
 * übrig bleibt. Im Zweifel zu Gunsten der Uhr — eine Warnung, die auf einer
 * lahmen Leitung beruht, verbrennt das Vertrauen in alle weiteren.
 */
export function sichereAbweichung(versatzMs: number, ungenauigkeitMs: number): number {
  return Math.max(0, Math.abs(versatzMs) - Math.abs(ungenauigkeitMs));
}

/**
 * Geht die Uhr DIESES Rechners so falsch, dass man es sagen sollte?
 *
 * Nicht, weil der Code dadurch falsch würde — er kommt vom Server. Sondern
 * weil eine Uhr, die um mehr als eine halbe Periode danebenliegt, an
 * anderen Stellen längst Unfug anrichtet (Zeitstempel an Nachrichten,
 * Erinnerungen), und weil derjenige, der später doch zum Telefon greift, dort
 * dann sehr wohl falsche Codes bekommt.
 */
export function laptopUrteil(
  abgleich: Zeitabgleich | null, periodeSekunden: number,
): 'unbekannt' | 'inOrdnung' | 'auffaellig' {
  if (!abgleich) return 'unbekannt';
  return sichereAbweichung(abgleich.versatzMs, abgleich.ungenauigkeitMs) > schwelleMs(periodeSekunden)
    ? 'auffaellig'
    : 'inOrdnung';
}

/** Welches Fenster aus dem Vorrat gerade gilt — oder keins mehr. */
export function aktuellesFenster(codes: Codefenster[], serverMs: number): Codefenster | null {
  return codes.find((c) => serverMs >= c.gueltigAbMs && serverMs < c.gueltigBisMs) ?? null;
}

/** Wie viele Sekunden das laufende Fenster noch gilt. Aufgerundet, nie negativ. */
export function restSekunden(fenster: Codefenster | null, serverMs: number): number {
  if (!fenster) return 0;
  return Math.max(0, Math.ceil((fenster.gueltigBisMs - serverMs) / 1000));
}

/**
 * Ab wann geraten wird, lieber auf den nächsten Code zu warten.
 *
 * Sechs Ziffern abzulesen, in ein fremdes Feld zu tippen und abzuschicken
 * dauert ein paar Sekunden. Wer bei zwei Restsekunden anfängt, tippt einen
 * Code, der beim Abschicken schon dem vorigen Fenster gehört. Prüfer lassen
 * üblicherweise ein Fenster rückwärts zu, dann geht es gerade noch gut — aber
 * darauf soll sich niemand verlassen müssen, und ein „gleich kommt ein
 * frischer" ist eine ehrlichere Auskunft als ein Code auf der Kippe.
 */
export const KNAPP_SEKUNDEN = 5;

export function istKnapp(rest: number): boolean {
  return rest > 0 && rest <= KNAPP_SEKUNDEN;
}

/** Was die Tafel gerade zeigen soll. */
export interface Anzeigeurteil {
  /** Darf ein Code auf den Schirm? */
  codeZeigen: boolean;
  /**
   * Wörterbuchkennung des Hinweises darüber — oder `null`, wenn alles
   * stimmt. Bewusst nur die KENNUNG: hier steht kein Satz in irgendeiner
   * Sprache, den setzt die Komponente über t() zusammen.
   */
  hinweis: string | null;
  /** Wiegt der Hinweis schwer genug, um ihn rot zu setzen? */
  schwer: boolean;
}

/**
 * Das Urteil, in der Reihenfolge, in der es zählt.
 *
 * Zuerst die Uhr des SERVERS: liegt sie nachweislich daneben, wird KEIN Code
 * gezeigt. Das ist der Kern der ganzen Übung — sechs Ziffern anzuzeigen, von
 * denen man weiß, dass Google sie ablehnt, wäre schlimmer als nichts
 * anzuzeigen: der Benutzer tippt sie, es geht schief, und die App sieht kaputt
 * aus statt ehrlich.
 *
 * Danach der leere Vorrat (die Verbindung ist weg und die vorgehaltenen
 * Fenster sind abgelaufen), dann die eigene Uhr als bloßer Hinweis, zuletzt
 * die Warnung vor dem knappen Fenster.
 */
export function anzeigeUrteil(eingabe: {
  uhr: Uhrstand | null;
  abgleich: Zeitabgleich | null;
  periodeSekunden: number;
  fenster: Codefenster | null;
  rest: number;
}): Anzeigeurteil {
  const { uhr, abgleich, periodeSekunden, fenster, rest } = eingabe;

  if (uhr?.zustand === 'abweichung') {
    return { codeZeigen: false, hinweis: 'einmalcode.uhrServerFalsch', schwer: true };
  }
  if (!fenster) {
    return { codeZeigen: false, hinweis: 'einmalcode.vorratLeer', schwer: true };
  }
  if (uhr?.zustand === 'nichtAbgeglichen') {
    /* Nicht dasselbe wie „nachweislich falsch": das Betriebssystem sagt nur,
       dass es seine Uhr nicht bestätigen konnte. Den Code deswegen ganz
       einzubehalten wäre zu streng — ohne Weg nach draußen ist der Pi immer
       in diesem Zustand, und dann stünde die Tafel dauerhaft leer. */
    return { codeZeigen: true, hinweis: 'einmalcode.uhrServerUngeprueft', schwer: true };
  }
  if (uhr?.zustand === 'unbekannt' && uhr.geprueftAm !== null) {
    /* `unbekannt` heißt nicht immer dasselbe. Direkt nach einem Neustart des
       Servers steht `geprueftAm` noch auf `null` — die erste Prüfung LÄUFT
       nur erst (server/services/einmalcode-uhr.ts, `uhrstand()` liefert dann
       sofort den alten, leeren Stand zurück und stößt die Prüfung nebenher
       an). Das dauert ein paar Sekunden und ist kein Grund zur Unruhe; dafür
       fällt dieser Zweig hier bewusst NICHT — er greift erst, wenn wenigstens
       einmal fertig geprüft wurde und das Ergebnis TROTZDEM „unbekannt" blieb.
       Genau das ist der gefährliche Fall: ein Pi ohne gepufferte Uhr, dem die
       Internetverbindung fehlt, meldet über Wochen brav „unbekannt" statt
       „abweichung", während die Systemuhr frei driftet — bis Google jeden Code
       ablehnt und die Tafel bis dahin einen unauffälligen Balken zeigte. Eine
       Warnung bei jedem Neustart würde in einer Woche ignoriert und diesen
       echten Fall mit ignorieren; die Unterscheidung über `geprueftAm` hält
       genau das auseinander. Der Code bleibt trotzdem sichtbar — ihn
       einzubehalten würde denjenigen aussperren, der sich gerade wirklich
       anmelden muss, und „unbekannt" ist keine widerlegte Uhr, nur eine
       unbestätigte. */
    return { codeZeigen: true, hinweis: 'einmalcode.uhrServerUnbekannt', schwer: true };
  }
  if (laptopUrteil(abgleich, periodeSekunden) === 'auffaellig') {
    return { codeZeigen: true, hinweis: 'einmalcode.uhrGeraetSchief', schwer: false };
  }
  if (istKnapp(rest)) {
    return { codeZeigen: true, hinweis: 'einmalcode.gleichNeu', schwer: false };
  }
  return { codeZeigen: true, hinweis: null, schwer: false };
}
