/**
 * Ein sehr kleiner IMAP-Client — nur so viel, wie der Abruf aus Gmail braucht.
 *
 * WARUM SELBST GEBAUT UND NICHT `imapflow` ODER `node-imap`.
 * packages/server hat heute fünf Laufzeit-Abhängigkeiten (fastify, drei
 * fastify-Erweiterungen, dotenv, sharp) und sonst nichts — das ganze
 * Zerlegen echter Post liegt bewusst im Cloudflare-Worker, damit der Pi
 * "kein einziges fremdes Paket" dafür braucht (siehe dessen Dateikopf). Ein
 * IMAP-Paket samt Abhängigkeitsbaum auf den Pi zu ziehen, nur um alle fünf
 * Minuten ein Postfach anzusehen, wäre ein schlechtes Geschäft: es ist
 * Code, der Netzverkehr von einem fremden Dienst entgegennimmt, er müsste
 * mitgepflegt und mitgeprüft werden, und der Teil von IMAP, den es hier
 * braucht, ist klein genug, um ihn zu lesen.
 *
 * WAS ES KANN: anmelden, INBOX auswählen, nach UIDs suchen, eine Mail roh
 * holen, abmelden. Kein IDLE, kein CONDSTORE, keine Erweiterungen, kein
 * Schreiben — dieser Client verändert NICHTS im fremden Postfach. `BODY.PEEK[]`
 * statt `BODY[]` ist dabei kein Detail: `BODY[]` setzt das Kennzeichen
 * `\Seen`, und dann wäre in Dons Gmail plötzlich alles gelesen, nur weil
 * Stellium nachgesehen hat.
 *
 * EINE MAIL JE FETCH, nicht ein FETCH über eine ganze UID-Liste. Das kostet
 * eine Umlaufzeit je Mail und erspart dafür den unangenehmsten Teil eines
 * IMAP-Parsers: mehrere Literale in einer Antwort den richtigen Nachrichten
 * zuzuordnen. Bei einem Takt von fünf Minuten und einer Handvoll neuer Mails
 * je Lauf ist die Umlaufzeit ohne Bedeutung; der falsch zugeordnete Rumpf
 * wäre es nicht.
 *
 * FRISTEN AN JEDER STELLE. Ein hängender Lesevorgang gegen einen fremden
 * Dienst blockiert sonst den Abruf für immer — und mit ihm den nächsten und
 * übernächsten Takt, weil `postabruf.ts` Läufe nicht überlappen lässt.
 * Deshalb hat jede einzelne Antwort ihre Frist, und der Aufrufer setzt
 * darüber noch eine für den ganzen Lauf.
 */
import net from 'node:net';
import tls from 'node:tls';

export interface ImapZugang {
  host: string;
  port: number;
  benutzer: string;
  /** Bei Gmail das 16-stellige App-Passwort, nie das Kontopasswort. */
  passwort: string;
}

/** Wie lange auf EINE Antwort gewartet wird. Gmail antwortet in Millisekunden;
    eine halbe Minute ist reichlich und liegt weit unter der Gesamtfrist. */
const ANTWORT_FRIST_MS = 30_000;

/** Eine Zeile darf lang sein (Kopfzeilen sind es), aber nicht endlos: ohne
    Grenze könnte eine Gegenstelle, die nie ein CRLF schickt, den Speicher des
    Pi füllen. 64 KiB ist mehr als jede echte IMAP-Statuszeile. */
const ZEILE_MAX = 64 * 1024;

/** Obergrenze für EINE rohe Mail. Größere werden übersprungen statt geholt —
    der Worker-Weg deckelt Anhänge bei 5 MiB, und post.ts kappt Text bei 1 MiB
    und HTML bei 4 MiB; alles darüber wäre ohnehin Ausschuss. */
export const MAIL_MAX_BYTES = 12 * 1024 * 1024;

export class ImapFehler extends Error {
  /** `true`, wenn die Gegenstelle die Anmeldung abgelehnt hat — ein falsches
      App-Passwort oder ein gesperrtes Konto. Der Aufrufer wartet danach
      länger, statt es im Takt weiter zu versuchen: Google sperrt Konten, die
      im Minutentakt mit falschem Passwort anklopfen. */
  readonly anmeldung: boolean;
  constructor(nachricht: string, anmeldung = false) {
    super(nachricht);
    this.anmeldung = anmeldung;
    this.name = 'ImapFehler';
  }
}

/** Wie eine Verbindung entsteht. Nur damit der Prüflauf einen Doppelgänger
    ohne echtes Zertifikat einsetzen kann — im Betrieb ist es immer `tls`,
    und es gibt keinen Schalter, der das von außen umstellt (kein
    Umgebungsname, keine Einstellung): wer hier etwas anderes einsetzen will,
    muss Code schreiben, nicht eine Variable setzen. */
export type VerbindungBauer = (zugang: ImapZugang) => Promise<net.Socket>;

const tlsVerbinden: VerbindungBauer = (zugang) => new Promise((fertig, scheitern) => {
  /* `servername` (SNI) nur bei einem echten Rechnernamen: Node lehnt eine
     IP-Adresse an dieser Stelle mit einem harten Fehler ab, und die
     TLS-Norm verbietet sie dort auch. Für `imap.gmail.com` ist sie nötig —
     ohne SNI liefert Google unter Umständen ein anderes Zertifikat. */
  const sock = tls.connect({
    host: zugang.host,
    port: zugang.port,
    servername: net.isIP(zugang.host) ? undefined : zugang.host,
  }, () => {
    sock.removeListener('error', scheitern);
    fertig(sock);
  });
  sock.setTimeout(ANTWORT_FRIST_MS);
  sock.once('error', scheitern);
});

/**
 * Der Leser: macht aus dem Byte-Strom Zeilen und Literale.
 *
 * IMAP mischt beides in derselben Antwort — `* 1 FETCH (UID 7 BODY[] {2345}`
 * heißt „ab hier folgen exakt 2345 Bytes, DANN geht die Zeile weiter". Wer
 * nur nach CRLF trennt, zerschneidet mitten in einer Mail, und jede Mail mit
 * einer Zeile, die wie eine IMAP-Antwort aussieht, wird zur Sicherheitslücke.
 * Deshalb liest dieser Leser Bytes und nicht Zeilen, und die Byteanzahl aus
 * `{n}` ist die einzige Wahrheit über die Länge eines Literals.
 */
class Leser {
  private puffer: Buffer = Buffer.alloc(0);
  private wecker: (() => void) | null = null;
  private fehler: Error | null = null;
  private zuEnde = false;

  constructor(private readonly sock: net.Socket) {
    sock.on('data', (stueck: Buffer) => { this.puffer = Buffer.concat([this.puffer, stueck]); this.wecken(); });
    sock.on('error', (err: Error) => { this.fehler = err; this.wecken(); });
    sock.on('close', () => { this.zuEnde = true; this.wecken(); });
    sock.on('timeout', () => { this.fehler = new ImapFehler('Zeitüberschreitung beim Lesen.'); this.wecken(); });
  }

  private wecken(): void {
    const w = this.wecker;
    this.wecker = null;
    if (w) w();
  }

  /** Wartet, bis neue Bytes da sind — oder bis die Frist abläuft. */
  private async nachschub(): Promise<void> {
    if (this.fehler) throw this.fehler;
    if (this.zuEnde) throw new ImapFehler('Die Gegenstelle hat die Verbindung geschlossen.');
    await new Promise<void>((fertig, scheitern) => {
      const uhr = setTimeout(() => {
        this.wecker = null;
        scheitern(new ImapFehler('Zeitüberschreitung: die Gegenstelle antwortet nicht.'));
      }, ANTWORT_FRIST_MS);
      this.wecker = () => { clearTimeout(uhr); fertig(); };
    });
    if (this.fehler) throw this.fehler;
  }

  /** Eine Zeile bis einschließlich CRLF — zurück kommt sie OHNE das CRLF. */
  async zeile(): Promise<string> {
    for (;;) {
      const ende = this.puffer.indexOf('\r\n');
      if (ende >= 0) {
        const wert = this.puffer.subarray(0, ende).toString('utf8');
        this.puffer = this.puffer.subarray(ende + 2);
        return wert;
      }
      if (this.puffer.length > ZEILE_MAX) throw new ImapFehler('Antwortzeile ohne Ende.');
      await this.nachschub();
    }
  }

  /** Genau `anzahl` Bytes — der Inhalt eines Literals. */
  async bytes(anzahl: number): Promise<Buffer> {
    while (this.puffer.length < anzahl) await this.nachschub();
    const wert = this.puffer.subarray(0, anzahl);
    this.puffer = this.puffer.subarray(anzahl);
    return Buffer.from(wert);
  }
}

/** Was eine abgeschlossene Antwort hergibt. */
interface Antwort {
  /** Alle Zeilen mit `*` davor, ohne Literale — für SEARCH und SELECT. */
  zeilen: string[];
  /** Die Literale in der Reihenfolge ihres Auftretens. Bei `UID FETCH` einer
      einzelnen Mail ist das genau eines: die rohe Mail. */
  literale: Buffer[];
}

/** Ein IMAP-Zeichenkettenwert, wie ihn LOGIN erwartet: in Anführungszeichen,
    Backslash und Anführungszeichen maskiert. Ohne das könnte ein Passwort mit
    einem Anführungszeichen darin den Befehl zerlegen — dieselbe Sorte Loch
    wie eine ungeprüfte SQL-Zeichenkette, nur eine Ebene tiefer. */
function alsZeichenkette(wert: string): string {
  return `"${wert.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

class Sitzung {
  private zaehler = 0;
  private readonly leser: Leser;

  constructor(private readonly sock: net.Socket) {
    this.leser = new Leser(sock);
  }

  /** Die Begrüßung abwarten. Manche Server melden hier schon `* BYE`. */
  async begruessung(): Promise<void> {
    const z = await this.leser.zeile();
    if (!/^\* (OK|PREAUTH)/i.test(z)) throw new ImapFehler(`Unerwartete Begrüßung: ${z.slice(0, 120)}`);
  }

  /**
   * Einen Befehl schicken und seine Antwort einsammeln.
   *
   * `geheim` schneidet den Befehl aus jeder Fehlermeldung heraus — sonst
   * stünde das App-Passwort im Protokoll, sobald LOGIN einmal scheitert.
   */
  async befehl(text: string, geheim = false): Promise<Antwort> {
    this.zaehler += 1;
    const marke = `s${this.zaehler}`;
    this.sock.write(`${marke} ${text}\r\n`);

    const zeilen: string[] = [];
    const literale: Buffer[] = [];
    for (;;) {
      let zeile = await this.leser.zeile();
      /* Literale einsammeln, solange die Zeile auf `{n}` endet. Mehrere
         hintereinander sind erlaubt (`{12}` … `{34}`) — deshalb eine
         Schleife und kein einzelnes `if`. */
      let literal = /\{(\d+)\}$/.exec(zeile);
      while (literal) {
        const laenge = Number(literal[1]);
        if (!Number.isFinite(laenge) || laenge < 0 || laenge > MAIL_MAX_BYTES) {
          throw new ImapFehler(`Literal mit unmöglicher Länge (${literal[1]}).`);
        }
        literale.push(await this.leser.bytes(laenge));
        zeile = `${zeile.slice(0, literal.index)}${await this.leser.zeile()}`;
        literal = /\{(\d+)\}$/.exec(zeile);
      }

      if (zeile.startsWith(`${marke} `)) {
        const rest = zeile.slice(marke.length + 1);
        if (/^OK\b/i.test(rest)) return { zeilen, literale };
        /* NO = abgelehnt, BAD = falsch gestellt. Für den Aufrufer ist beides
           ein Fehlschlag; unterschieden wird nur, ob der Befehl geheim war. */
        throw new ImapFehler(geheim ? 'Der Server hat die Anmeldung abgelehnt.' : `IMAP: ${rest.slice(0, 200)}`,
          geheim);
      }
      if (zeile.startsWith('* ')) zeilen.push(zeile.slice(2));
      /* Alles andere (`+ ` für Fortsetzungsaufforderungen) kommt in diesem
         kleinen Befehlssatz nicht vor und wird bewusst verworfen. */
    }
  }

  schliessen(): void {
    try { this.sock.destroy(); } catch { /* schon zu */ }
  }
}

/** Was ein Lauf über das Postfach erfahren hat. */
export interface Postfachstand {
  /** Wechselt dieser Wert, sind ALLE gemerkten UIDs wertlos — siehe
      postabruf.ts. Ohne diese Prüfung holte der nächste Lauf entweder nichts
      mehr oder wahllos fremde Mails. */
  uidValidity: number;
  /** Die UIDs, die zum Suchauftrag passen, aufsteigend. */
  uids: number[];
}

export interface SuchAuftrag {
  /** Nur Mails ab dieser UID (einschließlich) — der Normalfall nach dem
      ersten Lauf. */
  abUid?: number;
  /** Nur Mails, die nicht älter sind als dieses Datum — der Erstabruf. */
  seit?: Date;
}

const MONATE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP will `01-Aug-2026`, nicht ISO — und immer englische Monatskürzel,
    unabhängig davon, welche Sprache der Server sonst spricht. */
export function imapDatum(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONATE[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

/**
 * Was ein einzelner Abruf tut, von Anfang bis Ende.
 *
 * `jeMail` wird für jede geholte Mail aufgerufen, in aufsteigender
 * UID-Reihenfolge, und darf werfen — dann bricht der Lauf an genau dieser
 * Stelle ab und alles davor ist trotzdem verarbeitet. Das ist der Grund für
 * den Rückruf statt einer zurückgegebenen Liste: der Aufrufer kann seinen
 * Merkpunkt (die zuletzt verarbeitete UID) nach JEDER Mail fortschreiben,
 * statt am Ende alles oder nichts zu haben.
 *
 * `auftragFuer` ist eine FUNKTION und kein fertiger Auftrag, weil die
 * Entscheidung, wonach überhaupt gesucht wird, von der UIDVALIDITY abhängt —
 * und die erfährt man erst nach dem SELECT, also mitten in dieser Funktion.
 * Hat das Postfach seine UIDVALIDITY gewechselt, sind alle gemerkten UIDs
 * wertlos: „ab UID 4711" holte dann entweder nichts oder wahllos fremde
 * Mails. Wer den Auftrag vorher festlegen müsste, könnte das nur mit einer
 * zweiten Anmeldung je Takt herausfinden.
 */
export async function abrufen(
  zugang: ImapZugang,
  auftragFuer: (uidValidity: number) => { auftrag: SuchAuftrag; hoechstens: number },
  jeMail: (uid: number, roh: Buffer) => Promise<void> | void,
  verbindungBauen: VerbindungBauer = tlsVerbinden,
): Promise<Postfachstand> {
  const sock = await verbindungBauen(zugang);
  const sitzung = new Sitzung(sock);
  try {
    await sitzung.begruessung();
    await sitzung.befehl(
      `LOGIN ${alsZeichenkette(zugang.benutzer)} ${alsZeichenkette(zugang.passwort)}`, true);

    const gewaehlt = await sitzung.befehl('SELECT "INBOX"');
    const gueltigkeit = gewaehlt.zeilen
      .map((z) => /UIDVALIDITY (\d+)/i.exec(z)?.[1])
      .find((w): w is string => Boolean(w));
    if (!gueltigkeit) throw new ImapFehler('Der Server nennt keine UIDVALIDITY.');
    const uidValidity = Number(gueltigkeit);
    const { auftrag, hoechstens } = auftragFuer(uidValidity);

    /* Beide Bedingungen zusammen, wenn beide gesetzt sind: der Lauf nach
       einem Wechsel der UIDVALIDITY sucht ab UID 1, will aber trotzdem nicht
       das ganze Archiv. */
    const teile: string[] = [];
    if (auftrag.abUid !== undefined) teile.push(`UID ${Math.max(1, Math.trunc(auftrag.abUid))}:*`);
    if (auftrag.seit) teile.push(`SINCE ${imapDatum(auftrag.seit)}`);
    if (!teile.length) teile.push('ALL');
    const gesucht = await sitzung.befehl(`UID SEARCH ${teile.join(' ')}`);

    const uids = gesucht.zeilen
      .filter((z) => /^SEARCH\b/i.test(z))
      .flatMap((z) => z.slice(6).trim().split(/\s+/))
      .map((w) => Number(w))
      .filter((n) => Number.isInteger(n) && n > 0)
      /* `UID n:*` liefert bei manchen Servern die höchste UID mit, auch wenn
         sie kleiner als n ist (so steht es in RFC 3501) — deshalb hier noch
         einmal aussieben statt der Suche zu glauben. */
      .filter((n) => auftrag.abUid === undefined || n >= auftrag.abUid)
      .sort((a, b) => a - b);

    /* Die JÜNGSTEN, nicht die ältesten, wenn mehr da sind als erlaubt: beim
       Erstabruf will man den letzten Monat sehen und nicht bei der ältesten
       Mail des Fensters anfangen. Dass der Rest damit nie geholt wird, ist
       Absicht und steht so in der Oberfläche. */
    const zuHolen = uids.length > hoechstens ? uids.slice(uids.length - hoechstens) : uids;

    for (const uid of zuHolen) {
      const antwort = await sitzung.befehl(`UID FETCH ${uid} (BODY.PEEK[])`);
      const roh = antwort.literale[0];
      /* Kein Literal heißt: die Mail gibt es nicht mehr (in der Zwischenzeit
         gelöscht). Kein Fehler — überspringen, damit der Lauf weitergeht. */
      if (!roh) continue;
      await jeMail(uid, roh);
    }

    /* LOGOUT darf scheitern, ohne den Lauf zu entwerten: alles ist schon
       verarbeitet, und der Server räumt eine abgebrochene Verbindung selbst
       auf. */
    try { await sitzung.befehl('LOGOUT'); } catch { /* egal */ }
    return { uidValidity, uids: zuHolen };
  } finally {
    sitzung.schliessen();
  }
}
