/**
 * Der Abruf aus einem fremden Postfach: holt er das Richtige, und steht
 * danach jede Mail GENAU EINMAL da?
 *
 * DIE FRAGE, DIE DIESER LAUF BEANTWORTET
 * Seit dem 30.08.2026 gibt es zwei Wege in denselben Posteingang: den
 * Cloudflare-Worker an die Stellium-Domäne und den IMAP-Abruf aus einem
 * Gmail-Postfach. Ein Teil der Firmenpost liegt an BEIDEN Stellen — genau
 * deshalb wurde die naheliegende Gmail-Weiterleitung verworfen. Damit hängt
 * alles an Zusagen, die man nur messen kann:
 *
 *   1 DUBLETTENFREI  Dieselbe Mail über beide Wege eingeliefert steht
 *                    EINMAL in der Datenbank — in beiden Reihenfolgen.
 *   2 KEIN FALSCHES  Zwei VERSCHIEDENE Mails fallen nie zusammen: nicht
 *     ZUSAMMENFALLEN ohne Message-ID, nicht bei gleicher Message-ID von
 *                    verschiedenen Absendern.
 *   3 ERSTABRUF      Der erste Lauf holt nur ein Fenster, nicht das Archiv,
 *                    und der Zeitraum steht wirklich im Suchbefehl.
 *   4 NUR NEUES      Jeder weitere Lauf sucht ab der zuletzt gesehenen UID.
 *   5 FEHLSCHLAG     Eine abgelehnte Anmeldung verliert keine Post, verrät
 *                    das Passwort nicht und lässt den nächsten Lauf alles
 *                    nachholen.
 *   6 RECHT          Ein gewöhnliches Mitglied kommt an keinen dieser Werte,
 *                    und das App-Passwort kommt nie zurück.
 *   7 ANTWORT        Eine Antwort auf abgerufene Post geht aus der
 *                    STELLIUM-Adresse hinaus, an den richtigen Empfänger,
 *                    mit In-Reply-To und References — nichts über Google.
 *   8 HERKUNFT       Man sieht einer Mail an, über welchen der beiden Wege
 *                    sie hereinkam.
 *
 * WARUM EIN DOPPELGÄNGER UND KEIN ECHTES KONTO
 * Es gibt hier kein Gmail-Konto, kein App-Passwort und keine Verbindung zu
 * Google — dieselbe Entscheidung wie bei src/pruefungen/ki-schluessel.mts
 * („Warum ein Doppelgänger und nicht die echte Schnittstelle"). Stattdessen
 * läuft ein winziger IMAP-Server auf 127.0.0.1, der die Befehle MITSCHREIBT.
 * Nur so lassen sich Punkt 3 und 4 überhaupt belegen: die Frage ist nicht,
 * ob am Ende die richtigen Mails dastehen, sondern ob im Suchbefehl wirklich
 * `SINCE` bzw. `UID n:*` steht. Am Ergebnis allein wäre ein Abruf, der
 * jedesmal alles holt und sich auf die Entdublettung verlässt, von einem
 * sparsamen nicht zu unterscheiden.
 *
 * ER SPRICHT ECHTES TLS, mit einem Zertifikat, das der Aufrufer
 * (scripts/post-abruf-pruefen.mjs) frisch erzeugt und über
 * `NODE_EXTRA_CA_CERTS` bekannt macht. Punkt 0 unten verbindet sich einmal
 * über den EINGEBAUTEN Weg (`abrufen()` ohne eigenen Verbindungsbauer) — nur
 * so ist auch der Produktionspfad gemessen und nicht bloß eine Attrappe
 * daneben.
 *
 * KEIN GEHEIMNIS IN DER AUSGABE
 * Das „App-Passwort" ist bei jedem Lauf frisch gewürfelt und trägt ein
 * sichtbares `probe`. Jeder Vergleich damit wird VORHER zu true/false
 * gerechnet; gedruckt werden nur Wahrheitswerte, Zahlen und Namen.
 *
 * Aufruf:  node scripts/post-abruf-pruefen.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

let fehler = 0;
const gruen = '\u001b[32m';
const rot = '\u001b[31m';
const aus = '\u001b[0m';
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? `${gruen}\u2713${aus}` : `${rot}\u2717${aus}`} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/* ── Proben ───────────────────────────────────────────────────── */
const PROBEN = {
  /* 16 Zeichen wie ein echtes App-Passwort, damit die Längenprüfung der
     Route dieselbe Strecke geht wie im Ernstfall. */
  appPasswort: `probe${crypto.randomBytes(6).toString('hex').slice(0, 11)}`,
  verboten: `verbotenXX${crypto.randomBytes(6).toString('hex').slice(0, 6)}`,
  eingangGeheimnis: `eingang-${crypto.randomBytes(24).toString('hex')}`,
  versandSchluessel: `re_probe_${crypto.randomBytes(12).toString('hex')}`,
};
const POSTFACH = 'don.probe@example-gmail.invalid';
const DOMAENE = 'stellium.invalid';

/* ── Der IMAP-Doppelgänger ────────────────────────────────────── */

interface Ablage { uid: number; interndatum: Date; roh: Buffer }

const postfach: Ablage[] = [];
/** Jeder empfangene Befehl, ohne die LOGIN-Zeile (die trüge das Passwort). */
const befehle: string[] = [];
let anmeldungAblehnen = false;
const uidValidity = 900_001;

const imapDoppel = tls.createServer(
  {
    key: fs.readFileSync(process.env.PROBE_SCHLUESSEL as string),
    cert: fs.readFileSync(process.env.PROBE_ZERT as string),
  },
  (sock) => {
    sock.write('* OK Doppelgaenger bereit\r\n');
    let rest = '';
    sock.on('data', (stueck: Buffer) => {
      rest += stueck.toString('utf8');
      for (;;) {
        const ende = rest.indexOf('\r\n');
        if (ende < 0) break;
        const zeile = rest.slice(0, ende);
        rest = rest.slice(ende + 2);
        const leer = zeile.indexOf(' ');
        const marke = zeile.slice(0, leer);
        const befehl = zeile.slice(leer + 1);
        const gross = befehl.toUpperCase();

        if (gross.startsWith('LOGIN')) {
          /* Der Befehl selbst wird NICHT mitgeschrieben — er trägt das
             Passwort, und dieser Mitschnitt wird ausgewertet und gedruckt. */
          befehle.push('LOGIN');
          sock.write(anmeldungAblehnen
            ? `${marke} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`
            : `${marke} OK LOGIN completed\r\n`);
          continue;
        }
        befehle.push(befehl);

        if (gross.startsWith('SELECT')) {
          sock.write(`* ${postfach.length} EXISTS\r\n`);
          sock.write(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n`);
          sock.write(`${marke} OK [READ-WRITE] SELECT completed\r\n`);
          continue;
        }

        if (gross.startsWith('UID SEARCH')) {
          const seit = /SINCE (\d{2}-[A-Za-z]{3}-\d{4})/.exec(befehl)?.[1];
          const abUid = /UID (\d+):\*/.exec(befehl)?.[1];
          const grenze = seit ? Date.parse(seit.replace(/-/g, ' ')) : null;
          const treffer = postfach.filter((m) => {
            if (abUid && m.uid < Number(abUid)) return false;
            if (grenze !== null && m.interndatum.getTime() < grenze) return false;
            return true;
          });
          sock.write(`* SEARCH${treffer.map((m) => ` ${m.uid}`).join('')}\r\n`);
          sock.write(`${marke} OK SEARCH completed\r\n`);
          continue;
        }

        if (gross.startsWith('UID FETCH')) {
          const uid = Number(/UID FETCH (\d+)/i.exec(befehl)?.[1] ?? 0);
          const m = postfach.find((x) => x.uid === uid);
          if (m) {
            sock.write(`* 1 FETCH (UID ${m.uid} BODY[] {${m.roh.length}}\r\n`);
            sock.write(m.roh);
            sock.write(')\r\n');
          }
          sock.write(`${marke} OK FETCH completed\r\n`);
          continue;
        }

        if (gross.startsWith('LOGOUT')) {
          sock.write('* BYE\r\n');
          sock.write(`${marke} OK LOGOUT completed\r\n`);
          sock.end();
          continue;
        }
        sock.write(`${marke} BAD unbekannt\r\n`);
      }
    });
    sock.on('error', () => { /* abgebrochene Verbindung ist kein Fehler des Laufs */ });
  },
);
await new Promise<void>((fertig) => imapDoppel.listen(0, '127.0.0.1', fertig));
const imapPort = (imapDoppel.address() as AddressInfo).port;

/* ── Der Versand-Doppelgänger (Punkt 7) ───────────────────────── */

const versendet: Array<Record<string, unknown>> = [];
const versandDoppel = http.createServer((req, res) => {
  let rumpf = '';
  req.on('data', (s) => { rumpf += s; });
  req.on('end', () => {
    try { versendet.push(JSON.parse(rumpf)); } catch { versendet.push({ kaputt: true }); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'probe-versand-id' }));
  });
});
await new Promise<void>((fertig) => versandDoppel.listen(0, '127.0.0.1', fertig));
const versandPort = (versandDoppel.address() as AddressInfo).port;

/* ── Umgebung, bevor irgendetwas sie liest ────────────────────── */
/* Eigenes Masterpasswort statt der Keychain: der Lauf soll auf jedem Rechner
   gleich ausgehen — auf dem Pi ohne Keychain genauso wie auf einem Mac, auf
   dem eine mit ganz anderem Inhalt liegt. Dieselbe Entscheidung wie in
   ki-schluessel.mts. */
process.env.STELLIUM_MASTER_PASSPHRASE = `pruef-${crypto.randomBytes(24).toString('hex')}`;
process.env.RESEND_ENDE = `http://127.0.0.1:${versandPort}/emails`;
delete process.env.GROQ_API_KEY;

const { db, initDb } = await import('../db/index.js');
const post = await import('../services/post.js');
const postabruf = await import('../services/postabruf.js');
const imap = await import('../services/imap.js');
const mailzugang = await import('../services/mailzugang.js');
const { registerRoutes } = await import('../http/routes.js');
const { signToken } = await import('../auth.js');

initDb();

function konto(rolle: string, id: string): string {
  db.run(
    'INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)',
    id, id, id, 'x', rolle, Date.now(),
  );
  return id;
}
const inhaber = konto('owner', 'u_inhaber');
const mitglied = konto('member', 'u_mitglied');

const app = Fastify({ logger: false });
await registerRoutes(app);

const hole = (pfad: string, wer: string) => app.inject({
  method: 'GET', url: pfad, headers: { authorization: `Bearer ${signToken(wer)}` },
});
const schicke = (pfad: string, wer: string, rumpf: unknown) => app.inject({
  method: 'POST', url: pfad, headers: { authorization: `Bearer ${signToken(wer)}` }, payload: rumpf as object,
});

/* Der Verbindungsbauer für alles, was über postabruf.einLauf() läuft: der
   Rechnername steht dort fest verdrahtet (`imap.gmail.com`, ausdrücklich
   keine Einstellung — siehe services/mailzugang.ts). Ein Prüflauf, der das
   über eine Umgebungsvariable umstellen könnte, hätte genau das Loch
   gerissen, das die feste Verdrahtung schließt. Also wird stattdessen der Weg
   zur Verbindung ausgetauscht, und das geht nur aus dem Code heraus. */
const zumDoppelgaenger = (): Promise<net.Socket> => new Promise((fertig, scheitern) => {
  /* Kein `servername`: Node lehnt eine IP-Adresse als SNI-Namen ab — siehe
     tlsVerbinden() in services/imap.ts, das dieselbe Unterscheidung trifft. */
  const sock = tls.connect({ host: '127.0.0.1', port: imapPort }, () => {
    sock.removeListener('error', scheitern);
    fertig(sock);
  });
  sock.setTimeout(30_000);
  sock.once('error', scheitern);
});

/* ── Probemails ───────────────────────────────────────────────── */

interface Probe {
  messageId: string | null; von: string; an: string; betreff: string; text: string; datum: Date;
}

/**
 * Eine rohe Mail bauen — absichtlich so, wie sie WIRKLICH aussieht: CRLF,
 * Betreff in RFC-2047-Kodierung, Rumpf in quoted-printable mit weichen
 * Umbrüchen. Der Worker-Weg bekommt gleich denselben Inhalt in KLARER, anders
 * umbrochener Form. Genau das ist der Kern von Punkt 1: die Entdublettung darf
 * nicht daran hängen, dass beide Wege zufällig dieselben Bytes liefern — im
 * Ernstfall tun sie es nie.
 */
function roheMail(o: Probe): Buffer {
  const kopf = [
    'Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=pass',
    `Date: ${o.datum.toUTCString()}`,
    `From: "Probe Absender" <${o.von}>`,
    `To: <${o.an}>`,
    `Subject: =?utf-8?B?${Buffer.from(o.betreff, 'utf8').toString('base64')}?=`,
    ...(o.messageId ? [`Message-ID: ${o.messageId}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
  ].join('\r\n');
  /* Quoted-printable mit weichen Umbrüchen alle 20 Zeichen — der härteste
     Fall für die Normalisierung in abdruckBilden(). */
  const qp = Buffer.from(o.text, 'utf8').toString('latin1')
    .replace(/[^\x20-\x3C\x3E-\x7E]/g, (z) => `=${z.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
    .replace(/(.{20})/g, '$1=\r\n');
  return Buffer.from(`${kopf}\r\n\r\n${qp}\r\n`, 'latin1');
}

/** Dasselbe für den Worker-Weg: klarer Text, kein kodierter Betreff — so wie
    postal-mime ihn dort liefert. */
function alsWorkerRumpf(o: Probe): Record<string, unknown> {
  return {
    an: o.an, von: o.von, vonName: 'Probe Absender', umschlagVon: o.von, antwortAn: null,
    betreff: o.betreff, text: o.text, html: null,
    messageId: o.messageId, referenzen: null,
    pruefung: 'mx.cloudflare.net; dkim=pass; spf=pass; dmarc=pass',
    am: o.datum.getTime(), anhaenge: [],
  };
}

const jetzt = Date.now();
const MAIL1: Probe = {
  messageId: '<rechnung-4711@lieferant.invalid>', von: 'buchhaltung@lieferant.invalid',
  an: `billing@${DOMAENE}`, betreff: 'Rechnung 4711 für März — Übersicht',
  text: 'Sehr geehrte Damen und Herren,\n\nanbei die Rechnung 4711.\n\nMit freundlichen Grüßen',
  datum: new Date(jetzt - 2 * 86400_000),
};
const MAIL2: Probe = {
  messageId: '<bestaetigung-88@dienst.invalid>', von: 'noreply@dienst.invalid',
  an: POSTFACH, betreff: 'Dein Bestätigungscode',
  text: 'Dein Code lautet 447 991. Er gilt zehn Minuten.',
  datum: new Date(jetzt - 3600_000),
};
/* Der ALTBESTAND: eine Mail, die über den Worker kam, BEVOR es die Spalte
   `abdruck` gab. Solche Zeilen liegen in Dons Datenbank zu Tausenden, und der
   Erstabruf greift 30 Tage weit genau in sie hinein. */
const MAIL7: Probe = {
  messageId: '<vor-der-umstellung@lieferant.invalid>', von: 'buchhaltung@lieferant.invalid',
  an: `billing@${DOMAENE}`, betreff: 'Lieferschein 12', text: 'Der Lieferschein liegt bei.',
  datum: new Date(jetzt - 4 * 86400_000),
};
/* Zwei Mails OHNE Message-ID, ansonsten in jedem Feld gleich — der Fall, in
   dem eine reine Inhaltsprüfung eine davon verschlucken würde. */
const MAIL3: Probe = {
  messageId: null, von: 'formular@shop.invalid', an: POSTFACH,
  betreff: 'Bestellung eingegangen', text: 'Vielen Dank für Ihre Bestellung.',
  datum: new Date(jetzt - 7200_000),
};
const MAIL4: Probe = { ...MAIL3 };
/* Gleiche Message-ID, ANDERER Absender — zwei verschiedene Mails, die bei
   einem UNIQUE-Index auf message_id zu einer geworden wären. */
const MAIL5: Probe = {
  messageId: '<gleiche-kennung@irgendwo.invalid>', von: 'echt@kunde.invalid', an: POSTFACH,
  betreff: 'Angebot', text: 'Wir hätten gern ein Angebot.', datum: new Date(jetzt - 5400_000),
};
const MAIL6: Probe = {
  ...MAIL5, von: 'faelscher@fremd.invalid',
  text: 'Bitte überweisen Sie auf ein anderes Konto.',
};
/* Älter als das Erstabruf-Fenster — darf beim ersten Lauf NICHT geholt werden. */
const MAIL_ALT: Probe = {
  messageId: '<uralt-1@archiv.invalid>', von: 'archiv@alt.invalid', an: POSTFACH,
  betreff: 'Aus dem Archiv', text: 'Das ist zu alt.',
  datum: new Date(jetzt - 90 * 86400_000),
};

const einliefern = (o: Probe, uid: number) => {
  postfach.push({ uid, interndatum: o.datum, roh: roheMail(o) });
};

const perWorker = (o: Probe) => app.inject({
  method: 'POST', url: '/api/post/eingang',
  headers: {
    'x-stellium-eingang': PROBEN.eingangGeheimnis,
    'x-stellium-schluessel': crypto.randomBytes(16).toString('base64url'),
  },
  payload: alsWorkerRumpf(o),
});

const zeilen = (): number => db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM mail_nachrichten WHERE richtung = 'ein'")?.n ?? 0;
const mitMessageId = (mid: string | null): number => db.get<{ n: number }>(
  'SELECT COUNT(*) AS n FROM mail_nachrichten WHERE message_id = ?', mid)?.n ?? 0;

/* ── 0) Ausgangslage ──────────────────────────────────────────── */
console.log('\n0) Ausgangslage — die Sicherung liegt in der Datenbank, nicht in einer Absicht');

const indizes = db.all<{ name: string; sql: string | null }>(
  "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mail_nachrichten'");
pruef('Es gibt einen EINDEUTIGEN Index auf `abdruck`',
  indizes.some((i) => i.name === 'idx_mail_abdruck' && /UNIQUE/i.test(i.sql ?? '')), true);
/* Die Gegenprobe, und sie ist keine Formalie: ein UNIQUE auf message_id wäre
   genau die Zustellsperre, vor der db/schema.sql warnt — wer eine fremde
   Message-ID vorher anmeldet, ließe die echte Mail lautlos verschwinden. */
pruef('...und ausdrücklich KEINEN eindeutigen Index auf `message_id`',
  indizes.some((i) => /message_id/.test(i.sql ?? '') && /UNIQUE/i.test(i.sql ?? '')), false);
pruef('Der Abdruck ist ohne Message-ID leer',
  post.abdruckBilden({ messageId: null, von: 'a@b.invalid', betreff: 'x', text: 'y', html: null }), null);
pruef('Zwei verschiedene Absender mit gleicher Message-ID ergeben verschiedene Abdrücke',
  post.abdruckBilden({ messageId: '<x@y>', von: 'a@b.invalid', betreff: 't', text: 'i', html: null })
  === post.abdruckBilden({ messageId: '<x@y>', von: 'c@d.invalid', betreff: 't', text: 'i', html: null }),
  false);
pruef('Derselbe Inhalt, anders umbrochen, ergibt DENSELBEN Abdruck',
  post.abdruckBilden({ messageId: '<x@y>', von: 'a@b.invalid', betreff: 'Der Betreff', text: 'Zeile eins\r\nZeile zwei', html: null })
  === post.abdruckBilden({ messageId: '<x@y>', von: 'a@b.invalid', betreff: 'Der  Betreff', text: 'Zeile eins Zeile zwei', html: null }),
  true);

/* Der eingebaute TLS-Weg, einmal — damit nicht nur die Attrappe daneben
   gemessen ist, sondern der Pfad, den der Betrieb wirklich geht. */
postfach.push({ uid: 1, interndatum: new Date(), roh: roheMail(MAIL2) });
const tlsProbe = await imap.abrufen(
  { host: '127.0.0.1', port: imapPort, benutzer: POSTFACH, passwort: PROBEN.appPasswort },
  () => ({ auftrag: { abUid: 999_999 }, hoechstens: 0 }), () => { /* nichts holen */ });
pruef('Der eingebaute TLS-Verbindungsweg spricht mit dem Doppelgänger',
  tlsProbe.uidValidity, uidValidity);
postfach.length = 0;
befehle.length = 0;

/* ── 1) Recht und Verschwiegenheit ────────────────────────────── */
console.log('\n1) Recht — und das App-Passwort kommt nie zurück');
pruef('GET  /api/post/abruf — ohne Anmeldung: 401',
  (await app.inject({ method: 'GET', url: '/api/post/abruf' })).statusCode, 401);
pruef('GET  /api/post/abruf — Mitglied: 403', (await hole('/api/post/abruf', mitglied)).statusCode, 403);
pruef('POST /api/post/abruf — Mitglied: 403',
  (await schicke('/api/post/abruf', mitglied,
    { adresse: POSTFACH, passwort: PROBEN.verboten })).statusCode, 403);
pruef('POST /api/post/abruf/jetzt — Mitglied: 403',
  (await schicke('/api/post/abruf/jetzt', mitglied, {})).statusCode, 403);
pruef('GET  /api/post/abruf — Inhaber: 200', (await hole('/api/post/abruf', inhaber)).statusCode, 200);

pruef('Ein zu kurzes App-Passwort wird abgewiesen',
  (await schicke('/api/post/abruf', inhaber, { passwort: 'zukurz' })).statusCode, 400);
pruef('Eine kaputte Adresse wird abgewiesen',
  (await schicke('/api/post/abruf', inhaber, { adresse: 'kein-at-zeichen' })).statusCode, 400);

const gesetzt = await schicke('/api/post/abruf', inhaber,
  { adresse: POSTFACH, passwort: PROBEN.appPasswort, aktiv: true });
pruef('POST /api/post/abruf — Inhaber: 200', gesetzt.statusCode, 200);
pruef('Danach gilt der Zugang als hinterlegt', JSON.parse(gesetzt.body).passwortHinterlegt, true);
pruef('Die Adresse wird gezeigt — sie ist kein Geheimnis', JSON.parse(gesetzt.body).adresse, POSTFACH);

const standAntwort = await hole('/api/post/abruf', inhaber);
pruef('Das App-Passwort steht NICHT im Rumpf', standAntwort.body.includes(PROBEN.appPasswort), false);
pruef('Auch kein Anfangsstück davon', standAntwort.body.includes(PROBEN.appPasswort.slice(0, 8)), false);
pruef('Auch nicht in den Kopfzeilen',
  JSON.stringify(standAntwort.headers).includes(PROBEN.appPasswort), false);
/* Die Gegenprobe: der Wert IST da — nur eben verschlüsselt in der Datenbank
   und nicht in der Antwort. Ohne diese Zeile wären die drei darüber von einer
   kaputten Suche nicht zu unterscheiden. */
pruef('Gegenprobe: der Dienst selbst kennt ihn sehr wohl',
  mailzugang.abrufZugangLesen()?.passwort, PROBEN.appPasswort);
pruef('...und in der Datenbank steht er NICHT im Klartext',
  JSON.stringify(db.all('SELECT key, value FROM app_settings')).includes(PROBEN.appPasswort), false);

/* Der Rest des Laufs braucht Domäne, Versandschlüssel und Eingangsgeheimnis. */
mailzugang.zugangSetzen({
  domaene: DOMAENE, name: 'Stellium Probe',
  versandSchluessel: PROBEN.versandSchluessel, eingangGeheimnis: PROBEN.eingangGeheimnis,
}, inhaber);

/* ── 2) Erstabruf: nur das Fenster ────────────────────────────── */
console.log(`\n2) Erstabruf — nur ${postabruf.ERSTABRUF_TAGE} Tage, und das steht wirklich im Suchbefehl`);

/* Reihenfolge mit Absicht: Mail 1 kommt ZUERST über den Worker herein und
   liegt danach im Postfach des Doppelgängers — der Fall, um den es geht. */
const workerMail1 = await perWorker(MAIL1);
pruef('Der Worker liefert Mail 1 ein: 200', workerMail1.statusCode, 200);
pruef('...und sie steht als neu in der Datenbank', JSON.parse(workerMail1.body).doppelt, false);

einliefern(MAIL_ALT, 100);
einliefern(MAIL1, 101);
einliefern(MAIL2, 102);

const lauf1 = await postabruf.einLauf(zumDoppelgaenger);
const suche1 = befehle.find((b) => b.startsWith('UID SEARCH')) ?? '';
pruef('Der erste Suchbefehl trägt ein SINCE', /SINCE \d{2}-[A-Za-z]{3}-\d{4}/.test(suche1), true);
pruef('...und KEINE UID-Untergrenze (die gibt es beim ersten Mal nicht)',
  /UID \d+:\*/.test(suche1), false);
pruef('Der erste Lauf gilt als Erstabruf', lauf1.erstabruf, true);
pruef('Die uralte Mail wurde gar nicht erst geholt',
  befehle.some((b) => b.startsWith('UID FETCH 100')), false);
pruef('...und steht folglich nicht in der Datenbank', mitMessageId(MAIL_ALT.messageId), 0);

/* ── 3) DUBLETTENFREI — der Kern ──────────────────────────────── */
console.log('\n3) Dublettenfrei — dieselbe Mail über beide Wege, in beiden Reihenfolgen');
pruef('Mail 1 (erst Worker, dann Abruf) wurde beim Abruf als Dublette erkannt', lauf1.doppelt, 1);
pruef('...und steht GENAU EINMAL in der Datenbank', mitMessageId(MAIL1.messageId), 1);
pruef('Mail 2 kam über den Abruf neu herein', lauf1.aufgenommen, 1);
pruef('...und steht einmal da', mitMessageId(MAIL2.messageId), 1);

/* Die andere Reihenfolge: Mail 2 liegt schon aus dem Abruf da, JETZT liefert
   der Worker sie ein. Ohne die Prüfung in eingangAufnehmen() entstünde hier
   eine zweite Zeile — der Zustellschlüssel des Workers ist ein anderer. */
const workerMail2 = await perWorker(MAIL2);
pruef('Der Worker meldet Mail 2 als Dublette zurück', JSON.parse(workerMail2.body).doppelt, true);
pruef('...und sie steht weiterhin GENAU EINMAL da', mitMessageId(MAIL2.messageId), 1);
pruef('Der Worker bekommt dafür 200 und keinen Fehler', workerMail2.statusCode, 200);
/* Und es ist DIESELBE Zeile, nicht irgendeine — sonst zeigte die Oberfläche
   auf eine Mail, die es nicht gibt. */
pruef('Beide Wege nennen dieselbe Kennung',
  JSON.parse(workerMail2.body).id,
  db.get<{ id: string }>('SELECT id FROM mail_nachrichten WHERE message_id = ?', MAIL2.messageId)?.id);
pruef('Zwei Mails, vier Einlieferungen, zwei Zeilen', zeilen(), 2);

/* ── 3b) Der Altbestand ───────────────────────────────────────
 *
 * WARUM DIESER ABSCHNITT EIGENS EXISTIERT. Alles bisher Geprüfte hängt am
 * eindeutigen Index über `abdruck` — der greift aber nur bei Zeilen, die
 * einen haben. Jede Mail, die vor dieser Umstellung über den Worker kam, hat
 * `abdruck IS NULL`, und genau dorthin greift der Erstabruf mit seinen 30
 * Tagen zurück. Für sie rechnet `dubletteFinden()` den Abdruck über die
 * Message-ID nach. Ohne diesen Abschnitt bliebe der Wächter grün, während
 * Dons Postfach beim ERSTEN Abruf alles doppelt zeigte — der einzige Lauf,
 * bei dem es am meisten auffiele.
 */
console.log('\n3b) Der Altbestand — Zeilen ohne Abdruck, wie sie vor dieser Umstellung entstanden');
const workerMail7 = await perWorker(MAIL7);
const idMail7 = JSON.parse(workerMail7.body).id as string;
/* Genau so sieht eine Zeile von vor der Umstellung aus: alles da, nur der
   Abdruck fehlt. */
db.run('UPDATE mail_nachrichten SET abdruck = NULL WHERE id = ?', idMail7);
pruef('Die Altzeile trägt keinen Abdruck',
  db.get<{ abdruck: string | null }>(
    'SELECT abdruck FROM mail_nachrichten WHERE id = ?', idMail7)?.abdruck ?? null, null);

einliefern(MAIL7, 103);
const laufAlt = await postabruf.einLauf(zumDoppelgaenger);
pruef('Der Abruf erkennt sie trotzdem als Dublette', laufAlt.doppelt, 1);
pruef('...nimmt also nichts Neues auf', laufAlt.aufgenommen, 0);
pruef('...und sie steht GENAU EINMAL da', mitMessageId(MAIL7.messageId), 1);
/* Und der Altbestand wird dabei GEHEILT: die Zeile trägt ihren Abdruck jetzt,
   der nächste Abruf findet sie über den Index statt über die Nachrechnung. */
pruef('Die Altzeile hat ihren Abdruck nachgetragen bekommen',
  typeof db.get<{ abdruck: string | null }>(
    'SELECT abdruck FROM mail_nachrichten WHERE id = ?', idMail7)?.abdruck, 'string');
pruef('Drei Zeilen insgesamt', zeilen(), 3);

/* ── 4) Zwei verschiedene Mails fallen nie zusammen ───────────── */
console.log('\n4) Kein falsches Zusammenfallen — ohne Message-ID und bei gleicher Message-ID');
einliefern(MAIL3, 104);
einliefern(MAIL4, 105);
einliefern(MAIL5, 106);
einliefern(MAIL6, 107);
const lauf2 = await postabruf.einLauf(zumDoppelgaenger);
pruef('Vier weitere Mails aufgenommen', lauf2.aufgenommen, 4);
pruef('...keine davon als Dublette verworfen', lauf2.doppelt, 0);
pruef('Zwei Mails OHNE Message-ID stehen beide da (identischer Inhalt!)',
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mail_nachrichten WHERE message_id IS NULL')?.n, 2);
pruef('Gleiche Message-ID, verschiedene Absender: beide stehen da',
  mitMessageId(MAIL5.messageId), 2);
pruef('Insgesamt sieben Zeilen', zeilen(), 7);

/* ── 5) Nur Neues ─────────────────────────────────────────────── */
console.log('\n5) Danach nur noch Neues — gemessen am Suchbefehl, nicht am Ergebnis');
const suche2 = befehle.filter((b) => b.startsWith('UID SEARCH')).slice(-1)[0] ?? '';
pruef('Der nächste Suchbefehl fragt ab einer UID', /UID 104:\*/.test(suche2), true);
pruef('...und trägt kein SINCE mehr', /SINCE/.test(suche2), false);
befehle.length = 0;
const lauf3 = await postabruf.einLauf(zumDoppelgaenger);
pruef('Ein Lauf ohne neue Post holt nichts', lauf3.aufgenommen, 0);
pruef('...und fasst auch keine schon geholte Mail an',
  befehle.some((b) => b.startsWith('UID FETCH')), false);

/* ── 6) Fehlschlag ────────────────────────────────────────────── */
console.log('\n6) Fehlschlag — kein Verlust, kein Passwort in der Meldung, keine Schleife');
const uidVorher = db.get<{ value: string }>(
  "SELECT value FROM app_settings WHERE key = 'mail.abruf.letzteUid'")?.value;
anmeldungAblehnen = true;
einliefern({
  ...MAIL2, messageId: '<waehrend-der-stoerung@dienst.invalid>', betreff: 'Während der Störung',
}, 108);
let meldung = '';
try {
  await postabruf.einLauf(zumDoppelgaenger);
  pruef('Ein abgelehnter Login muss werfen', 'kein Wurf', 'ein Wurf');
} catch (err) {
  meldung = (err as Error).message;
}
pruef('Der Fehlschlag wird gemeldet', meldung.length > 0, true);
pruef('...und die Meldung enthält das Passwort NICHT', meldung.includes(PROBEN.appPasswort), false);
pruef('...auch keinen Teil davon', meldung.includes(PROBEN.appPasswort.slice(0, 6)), false);
pruef('Der Merkpunkt bewegt sich nicht',
  db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'mail.abruf.letzteUid'")?.value,
  uidVorher);
pruef('Es geht keine Post verloren: es steht weiterhin bei sieben Zeilen', zeilen(), 7);
pruef('Der Stand zeigt den Fehler an', typeof postabruf.laufStand().letzterFehler, 'string');

anmeldungAblehnen = false;
const lauf4 = await postabruf.einLauf(zumDoppelgaenger);
pruef('Nach der Störung holt der nächste Lauf das Liegengebliebene nach', lauf4.aufgenommen, 1);
pruef('...und der Stand meldet keinen Fehler mehr', postabruf.laufStand().letzterFehler, null);
pruef('Jetzt acht Zeilen', zeilen(), 8);

/* ── 7) Herkunft ──────────────────────────────────────────────── */
console.log('\n7) Herkunft — man sieht einer Mail an, über welchen Weg sie kam');
const idMail1 = db.get<{ id: string }>(
  'SELECT id FROM mail_nachrichten WHERE message_id = ?', MAIL1.messageId)?.id as string;
const idMail2 = db.get<{ id: string }>(
  'SELECT id FROM mail_nachrichten WHERE message_id = ?', MAIL2.messageId)?.id as string;
pruef('Mail 1 kam über den Worker', post.nachricht(idMail1)?.quelle, 'worker');
/* Mail 2 kam über den Abruf herein; der Worker meldete sie danach nur als
   Dublette. Die Herkunft gehört der ERSTEN Einlieferung — eine spätere
   Dublette darf die Zeile nicht umschreiben. */
pruef('Mail 2 kam über den Abruf — auch nach der Worker-Dublette',
  post.nachricht(idMail2)?.quelle, 'abruf');

/* ── 8) Antwort geht aus Stellium hinaus ──────────────────────── */
console.log('\n8) Antwort auf abgerufene Post — aus der Stellium-Adresse, mit Verlaufsbezug');
const abgerufen = post.nachricht(idMail2);
pruef('Die abgerufene Mail trägt ihre Message-ID', abgerufen?.messageId, MAIL2.messageId);
pruef('...und den richtigen Absender als Antwortziel', abgerufen?.von, MAIL2.von);
await post.senden({
  fach: 'support',
  an: abgerufen?.von as string,
  betreff: `Re: ${abgerufen?.betreff}`,
  text: 'Danke für die Nachricht.',
  antwortAuf: {
    messageId: abgerufen?.messageId ?? null,
    referenzen: abgerufen?.referenzen ?? null,
    threadId: abgerufen?.threadId ?? null,
  },
});
const hinaus = versendet[versendet.length - 1] as {
  from?: string; to?: string[]; headers?: Record<string, string>;
};
pruef('Genau eine Mail ging hinaus', versendet.length, 1);
pruef('Sie kommt aus der Stellium-Domäne', /@stellium\.invalid>?$/.test(hinaus.from ?? ''), true);
pruef('...und nicht aus dem Gmail-Postfach', (hinaus.from ?? '').includes(POSTFACH), false);
pruef('Sie geht an den Absender der abgerufenen Mail', hinaus.to, [MAIL2.von]);
pruef('In-Reply-To zeigt auf die abgerufene Mail',
  hinaus.headers?.['In-Reply-To'], MAIL2.messageId);
pruef('References enthält sie ebenfalls',
  (hinaus.headers?.References ?? '').includes(MAIL2.messageId as string), true);

/* ── 9) Abschalten und Löschen ────────────────────────────────── */
console.log('\n9) Abschalten und Löschen');
const abgeschaltet = await schicke('/api/post/abruf', inhaber, { aktiv: false });
pruef('Der Takt lässt sich anhalten, ohne den Zugang wegzuwerfen',
  [JSON.parse(abgeschaltet.body).aktiv, JSON.parse(abgeschaltet.body).passwortHinterlegt],
  [false, true]);
const geloescht = await app.inject({
  method: 'DELETE', url: '/api/post/abruf', headers: { authorization: `Bearer ${signToken(inhaber)}` },
});
pruef('Löschen: 200', geloescht.statusCode, 200);
pruef('...danach ist nichts mehr hinterlegt', JSON.parse(geloescht.body).passwortHinterlegt, false);
pruef('...und der Merkpunkt ist mit weggeräumt',
  db.get("SELECT value FROM app_settings WHERE key = 'mail.abruf.letzteUid'") ?? null, null);
pruef('Der vom Mitglied abgewiesene Wert steht nirgends',
  JSON.stringify(db.all('SELECT key, value FROM app_settings')).includes(PROBEN.verboten), false);

/* ── Abbau ────────────────────────────────────────────────────── */
await app.close();
imapDoppel.close();
versandDoppel.close();

console.log(fehler
  ? `\n${rot}${fehler} Fehler.${aus}\n`
  : `\n${gruen}Der Postabruf: dieselbe Mail über beide Wege steht einmal da, verschiedene Mails nie `
    + `zusammen, der Erstabruf bleibt im Fenster, ein Fehlschlag verliert nichts — und Antworten `
    + `gehen aus Stellium hinaus.${aus}\n`);
process.exit(fehler ? 1 : 0);
