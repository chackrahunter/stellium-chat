/**
 * Eine rohe Mail in Felder zerlegen — so weit, wie der Posteingang sie braucht.
 *
 * WARUM ES DAS ÜBERHAUPT GIBT. Für den Weg über die Stellium-Domäne macht
 * diese Arbeit der Cloudflare-Worker mit `postal-mime`, und sein Dateikopf
 * sagt auch, warum sie dort liegt: „das Zerlegen echter Post ist die
 * unangenehme Arbeit … Der Stellium-Server bekommt nur noch Felder und
 * braucht dafür kein einziges fremdes Paket." Für den Abruf aus einem
 * fremden Postfach gibt es diesen Worker nicht — was per IMAP hereinkommt,
 * ist eine rohe RFC-5322-Nachricht und sonst nichts. Also muss der Pi es
 * diesmal selbst tun.
 *
 * DAS ERGEBNIS IST ABSICHTLICH DASSELBE wie das, was der Worker schickt
 * (`EingangRoh` in services/post.ts). Damit läuft der Abruf durch DIESELBE
 * Eintrittstür wie die Worker-Post — `eingangAufnehmen()` — und nicht an ihr
 * vorbei. Jede Prüfung, jede Grenze und jede Verschlüsselung dort gilt
 * dadurch für beide Wege, ohne dass sie zweimal geschrieben werden müsste.
 *
 * WAS ES NICHT KANN, und zwar mit Ansage: verschachtelte `message/rfc822`
 * werden als Anhang behandelt und nicht weiter zerlegt; RFC-2231-geteilte
 * Parameter (`filename*0=`) werden nicht zusammengesetzt; S/MIME und PGP
 * bleiben unentschlüsselt. Alle drei enden nicht in einem Fehler, sondern in
 * einem Anhang oder einem leeren Feld — die Mail geht nie verloren, sie ist
 * nur weniger schön zerlegt. Das ist die Reihenfolge, in der dieses Haus
 * entscheidet: lieber gekürzt zustellen als vollständig verlieren
 * (services/post.ts, `kappen()`).
 */

/** Grenzen, damit eine böswillige Mail den Pi nicht beschäftigt. Sie liegen
    über allem, was echte Post braucht, und weit unter allem, was wehtut. */
const TEILE_MAX = 200;
const TIEFE_MAX = 12;

export interface ZerlegteMail {
  von: string;
  vonName: string | null;
  /** Alle Empfänger aus `To:` und `Cc:`, in dieser Reihenfolge — daraus sucht
      sich postabruf.ts das Fach. */
  empfaenger: string[];
  antwortAn: string | null;
  betreff: string;
  messageId: string | null;
  /** `References` und `In-Reply-To` zusammengezogen, wie der Worker es tut. */
  referenzen: string | null;
  /** Aus `Date:` — `null`, wenn keine oder eine unlesbare Angabe dastand. */
  datum: number | null;
  /** Die ERSTE `Authentication-Results`-Zeile, siehe `kopfWerte()` unten. */
  pruefung: string | null;
  text: string;
  html: string | null;
  anhaenge: Array<{ name: string; typ: string; inhalt: Buffer }>;
}

/* ── Kopfzeilen ──────────────────────────────────────────────── */

/**
 * Kopf und Rumpf trennen und die Kopfzeilen entfalten.
 *
 * „Entfalten" heißt: eine Kopfzeile darf über mehrere Zeilen laufen, wenn
 * die Fortsetzungen mit Leerzeichen oder Tabulator beginnen. Wer das nicht
 * zusammenzieht, liest von einer langen `References:` nur das erste Stück —
 * und hängt die Antwort dann an den falschen Verlauf.
 *
 * Zeilenenden: `\r\n` ist die Norm, `\n` kommt trotzdem vor (etwa wenn eine
 * Mail schon einmal durch ein Werkzeug gelaufen ist). Beides wird
 * verstanden, sonst fände die Trennung zwischen Kopf und Rumpf nicht statt
 * und die ganze Mail wäre ein einziger Kopf.
 */
function kopfUndRumpf(roh: Buffer): { kopf: Array<[string, string]>; rumpf: Buffer } {
  let trenner = roh.indexOf('\r\n\r\n');
  let trennerLaenge = 4;
  const trennerLf = roh.indexOf('\n\n');
  if (trenner < 0 || (trennerLf >= 0 && trennerLf < trenner)) {
    trenner = trennerLf;
    trennerLaenge = 2;
  }
  const kopfText = (trenner < 0 ? roh : roh.subarray(0, trenner)).toString('latin1');
  const rumpf = trenner < 0 ? Buffer.alloc(0) : roh.subarray(trenner + trennerLaenge);

  const kopf: Array<[string, string]> = [];
  let aktuell: [string, string] | null = null;
  for (const zeile of kopfText.split(/\r\n|\n/)) {
    if (/^[ \t]/.test(zeile)) {
      /* Fortsetzung. Der Faltungsumbruch selbst wird durch ein Leerzeichen
         ersetzt — so steht in `References:` zwischen zwei Kennungen genau
         ein Trennzeichen, egal wie das Postfach umgebrochen hat. */
      if (aktuell) aktuell[1] += ` ${zeile.trim()}`;
      continue;
    }
    const doppelpunkt = zeile.indexOf(':');
    if (doppelpunkt <= 0) continue;
    aktuell = [zeile.slice(0, doppelpunkt).trim().toLowerCase(), zeile.slice(doppelpunkt + 1).trim()];
    kopf.push(aktuell);
  }
  return { kopf, rumpf };
}

/** Alle Werte zu einem Namen, in der Reihenfolge, in der sie in der Mail
    standen. Die Reihenfolge ist bei `Authentication-Results` die ganze
    Sicherheitsaussage: empfangende Server stellen ihre Zeile VORNE an, ein
    Absender kann also nur weiter hinten etwas behaupten. Wer hier den
    letzten Wert nähme, prüfte am Ende die Behauptung des Absenders — genau
    der Fehler, den der Cloudflare-Worker in seinem Dateikopf beschreibt. */
function kopfWerte(kopf: Array<[string, string]>, name: string): string[] {
  return kopf.filter(([n]) => n === name).map(([, w]) => w);
}

function kopfWert(kopf: Array<[string, string]>, name: string): string | null {
  return kopfWerte(kopf, name)[0] ?? null;
}

/* ── Kodierungen ─────────────────────────────────────────────── */

/**
 * Bytes in Text — mit dem Zeichensatz, den die Mail nennt.
 *
 * Ohne das steht in einer deutschen Mail aus einem älteren Postfach „Grüße"
 * statt „Grüße", und die KI-Sichtung liest anschließend Zeichenmüll. Ein
 * unbekannter Name endet in `latin1` und nicht in einer Ausnahme: jedes Byte
 * hat dort eine Bedeutung, es geht also nichts verloren, auch wenn es
 * hässlich aussieht.
 */
function alsText(bytes: Buffer, zeichensatz: string | null): string {
  const name = (zeichensatz ?? 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (name === 'utf-8' || name === 'utf8' || name === 'us-ascii' || name === 'ascii') {
    return bytes.toString('utf8');
  }
  try {
    return new TextDecoder(name, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

function quotedPrintable(text: string): Buffer {
  /* Weiche Umbrüche (`=` am Zeilenende) zuerst — sie sind kein Zeichen,
     sondern nur eine Notlösung für die 76-Zeichen-Grenze. */
  const ohneWeich = text.replace(/=\r?\n/g, '');
  const raus: number[] = [];
  for (let i = 0; i < ohneWeich.length; i += 1) {
    if (ohneWeich[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(ohneWeich.slice(i + 1, i + 3))) {
      raus.push(parseInt(ohneWeich.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      raus.push(ohneWeich.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(raus);
}

/** Den Rumpf eines Teils in seine wahren Bytes zurückverwandeln. */
function entkodieren(rumpf: Buffer, kodierung: string | null): Buffer {
  const k = (kodierung ?? '7bit').trim().toLowerCase();
  if (k === 'base64') {
    /* `latin1` und nicht `utf8`: base64 ist reines ASCII, und ein kaputtes
       Byte darf die Umwandlung nicht verschieben. */
    return Buffer.from(rumpf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (k === 'quoted-printable') return quotedPrintable(rumpf.toString('latin1'));
  return rumpf;
}

/**
 * RFC-2047-Wörter in Kopfzeilen auflösen: `=?utf-8?B?…?=` wird zu Text.
 *
 * Ohne das steht der Betreff jeder nicht-englischen Mail als Buchstabensalat
 * in der Liste — und die Suche findet ihn nie, weil der Index den Salat
 * indiziert und nicht das Wort.
 */
function kopfEntschluesseln(wert: string): string {
  /* Zwei unmittelbar aufeinander folgende kodierte Wörter dürfen nur durch
     Zwischenraum getrennt sein, und dieser Zwischenraum gehört NICHT zum
     Text (RFC 2047 §6.2) — sonst steht mitten in einem Wort ein Leerzeichen. */
  const zusammen = wert.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return zusammen.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (ganz, satz: string, art: string, inhalt: string) => {
      try {
        const bytes = art.toLowerCase() === 'b'
          ? Buffer.from(inhalt, 'base64')
          /* In der Q-Form steht `_` für ein Leerzeichen — der einzige
             Unterschied zu quoted-printable. */
          : quotedPrintable(inhalt.replace(/_/g, ' '));
        return alsText(bytes, satz);
      } catch {
        return ganz;
      }
    },
  );
}

/* ── Content-Type und Konsorten ──────────────────────────────── */

interface Kopfangabe { wert: string; parameter: Record<string, string> }

function angabeLesen(zeile: string | null): Kopfangabe {
  if (!zeile) return { wert: '', parameter: {} };
  const [erstes, ...rest] = zeile.split(';');
  const parameter: Record<string, string> = {};
  for (const stueck of rest) {
    const gleich = stueck.indexOf('=');
    if (gleich <= 0) continue;
    const name = stueck.slice(0, gleich).trim().toLowerCase();
    const roh = stueck.slice(gleich + 1).trim();
    parameter[name] = roh.replace(/^"(.*)"$/s, '$1');
  }
  return { wert: erstes.trim().toLowerCase(), parameter };
}

/* ── Der eigentliche Zerleger ────────────────────────────────── */

interface Teil { typ: string; name: string | null; inhalt: Buffer; zeichensatz: string | null; anhang: boolean }

/**
 * Einen Teil (oder die ganze Mail) in flache Teile auflösen.
 *
 * `multipart/*` wird an seiner Grenzzeile zerschnitten und rekursiv weiter
 * behandelt; alles andere ist ein Blatt. Die Grenzzeile ist dabei die
 * einzige Wahrheit — nicht der Zeilenumbruch, nicht die Einrückung: `--` +
 * Grenze am Zeilenanfang trennt, `--` + Grenze + `--` beendet.
 */
function teileSammeln(
  rumpf: Buffer, kopf: Array<[string, string]>, tiefe: number, raus: Teil[],
): void {
  if (tiefe > TIEFE_MAX || raus.length >= TEILE_MAX) return;

  const inhaltstyp = angabeLesen(kopfWert(kopf, 'content-type'));
  const lage = angabeLesen(kopfWert(kopf, 'content-disposition'));
  const typ = inhaltstyp.wert || 'text/plain';

  if (typ.startsWith('multipart/')) {
    const grenze = inhaltstyp.parameter.boundary;
    if (!grenze) return;
    const marke = `--${grenze}`;
    /* Über `latin1` gesucht, damit Byte-Positionen und Zeichen-Positionen
       eins zu eins zusammenfallen — bei `utf8` täten sie das nicht, und die
       ausgeschnittenen Teile lägen um mehrere Bytes daneben. */
    const text = rumpf.toString('latin1');
    const stellen: number[] = [];
    let suche = text.indexOf(marke);
    while (suche >= 0) {
      if (suche === 0 || text[suche - 1] === '\n') stellen.push(suche);
      suche = text.indexOf(marke, suche + marke.length);
    }
    for (let i = 0; i < stellen.length - 1; i += 1) {
      const start = text.indexOf('\n', stellen[i]);
      if (start < 0) continue;
      /* Das Zeilenende VOR der nächsten Grenzzeile gehört noch zur Grenze
         und nicht zum Inhalt — sonst hängt an jedem Teil ein CRLF zu viel,
         und base64 mit Prüfsumme bricht daran. */
      let ende = stellen[i + 1];
      if (text[ende - 1] === '\n') ende -= 1;
      if (text[ende - 1] === '\r') ende -= 1;
      if (ende <= start) continue;
      const stueck = rumpf.subarray(start + 1, ende);
      const zerlegt = kopfUndRumpf(stueck);
      teileSammeln(zerlegt.rumpf, zerlegt.kopf, tiefe + 1, raus);
      if (raus.length >= TEILE_MAX) return;
    }
    return;
  }

  const name = lage.parameter.filename ?? inhaltstyp.parameter.name ?? null;
  raus.push({
    typ,
    name: name ? kopfEntschluesseln(name) : null,
    inhalt: entkodieren(rumpf, kopfWert(kopf, 'content-transfer-encoding')),
    zeichensatz: inhaltstyp.parameter.charset ?? null,
    /* Anhang ist, was einen Dateinamen trägt ODER ausdrücklich als solcher
       ausgezeichnet ist ODER kein Text ist. `inline` mit Dateinamen zählt
       mit: ein eingebettetes Bild ist für den Leser ein Anhang, auch wenn
       das Mailprogramm es im Fließtext zeigt. */
    anhang: Boolean(name) || lage.wert === 'attachment' || !typ.startsWith('text/'),
  });
}

/** Eine nackte Adresse aus `Name <a@b>` oder `a@b`. Kleingeschrieben, weil
    Adressen im Haus überall so verglichen werden (post.ts, `nurAdresse()`). */
function adresse(wert: string): string {
  const spitz = /<([^>]*)>/.exec(wert);
  return (spitz ? spitz[1] : wert).trim().toLowerCase();
}

/** Aus `To:`/`Cc:` alle Adressen. Kommas in Anführungszeichen und in
    Klammern trennen NICHT — ein Anzeigename wie `"Meier, Anna" <a@b>` wäre
    sonst zwei Empfänger, von denen einer keine Adresse hat. */
function adressen(wert: string): string[] {
  const raus: string[] = [];
  let stueck = '';
  let inAnfuehrung = false;
  let inSpitz = false;
  for (const z of wert) {
    if (z === '"') inAnfuehrung = !inAnfuehrung;
    else if (z === '<') inSpitz = true;
    else if (z === '>') inSpitz = false;
    if (z === ',' && !inAnfuehrung && !inSpitz) { raus.push(stueck); stueck = ''; continue; }
    stueck += z;
  }
  raus.push(stueck);
  return raus.map((s) => adresse(s)).filter((s) => s.includes('@'));
}

/** Der Anzeigename vor der Adresse, falls einer dasteht. */
function anzeigename(wert: string): string | null {
  const vorSpitz = /^([^<]*)</.exec(wert);
  if (!vorSpitz) return null;
  const name = kopfEntschluesseln(vorSpitz[1].trim()).replace(/^"(.*)"$/s, '$1').trim();
  return name || null;
}

export function zerlegen(roh: Buffer): ZerlegteMail {
  const { kopf, rumpf } = kopfUndRumpf(roh);
  const teile: Teil[] = [];
  teileSammeln(rumpf, kopf, 0, teile);

  const textTeile = teile.filter((t) => !t.anhang && t.typ === 'text/plain');
  const htmlTeile = teile.filter((t) => !t.anhang && t.typ === 'text/html');
  const anhaenge = teile.filter((t) => t.anhang);

  const vonRoh = kopfWert(kopf, 'from') ?? '';
  const datumRoh = kopfWert(kopf, 'date');
  const datum = datumRoh ? Date.parse(datumRoh) : NaN;

  /* `References` zuerst, `In-Reply-To` als Rückfall — dieselbe Rangfolge wie
     im Worker (`post.references`, das postal-mime aus beidem füllt). Beide
     zusammen, wenn beide dastehen: post.ts siebt anschließend ohnehin auf
     gültige Kennungen und nimmt höchstens zwanzig. */
  const referenzen = [kopfWert(kopf, 'references'), kopfWert(kopf, 'in-reply-to')]
    .filter((w): w is string => Boolean(w)).join(' ').trim() || null;

  return {
    von: adresse(vonRoh),
    vonName: anzeigename(vonRoh),
    empfaenger: [
      ...adressen(kopfWert(kopf, 'to') ?? ''),
      ...adressen(kopfWert(kopf, 'cc') ?? ''),
    ],
    antwortAn: kopfWert(kopf, 'reply-to') ? adresse(kopfWert(kopf, 'reply-to') as string) : null,
    betreff: kopfEntschluesseln(kopfWert(kopf, 'subject') ?? ''),
    messageId: kopfWert(kopf, 'message-id'),
    referenzen,
    datum: Number.isFinite(datum) ? datum : null,
    pruefung: kopfWerte(kopf, 'authentication-results')[0] ?? null,
    text: textTeile.map((t) => alsText(t.inhalt, t.zeichensatz)).join('\n\n'),
    html: htmlTeile.length ? htmlTeile.map((t) => alsText(t.inhalt, t.zeichensatz)).join('\n') : null,
    anhaenge: anhaenge.map((a) => ({
      name: a.name ?? 'ohne-namen',
      typ: a.typ || 'application/octet-stream',
      inhalt: a.inhalt,
    })),
  };
}
