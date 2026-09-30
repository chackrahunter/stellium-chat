/**
 * SMS über Twilio: kommt nur herein, was Twilio wirklich geschickt hat — und
 * steht dieselbe SMS danach GENAU EINMAL da?
 *
 * DIE FRAGE, DIE DIESER LAUF BEANTWORTET
 * Seit dem 30.08.2026 hängt mit `POST /api/sms/eingang` ein dritter Endpunkt
 * öffentlich am Tunnel, und er nimmt Inhalt von Fremden entgegen. Anders als
 * beim Posteingang ist der Nachweis kein geteiltes Wort, sondern eine
 * Signatur, die Twilio über Adresse und Formularfelder rechnet. Daran hängen
 * Zusagen, die man alle nur MESSEN kann:
 *
 *   1 SIGNATUR      Ohne oder mit falscher Signatur wird nichts angenommen —
 *                   und es entsteht keine Zeile. Auch nicht mit einer
 *                   Signatur über die INTERNE Adresse statt der öffentlichen,
 *                   und auch nicht mit einer, die zu einem anderen Token
 *                   gehört.
 *   2 FAIL CLOSED   Ohne hinterlegten Token und ohne hinterlegte Adresse wird
 *                   ebenfalls nichts angenommen — nicht etwa alles.
 *   3 WIEDERHOLUNG  Twilio stellt bei Zeitüberschreitung erneut zu. Dieselbe
 *                   SMS zweimal ergibt EINE Zeile.
 *   4 KEIN FALSCHES Zwei VERSCHIEDENE SMS fallen nie zusammen.
 *     ZUSAMMENFALLEN
 *   5 FELDER        From/To in E.164, MessageSid in Twilios Form; doppelte
 *                   Formularschlüssel werden abgelehnt statt zusammengefasst.
 *   6 RECHT         Ein gewöhnliches Mitglied kommt an keinen der drei Werte,
 *                   und keiner kommt je zurück.
 *   7 ANTWORT       Eine Antwort geht an den Absender, aus der eigenen
 *                   Twilio-Nummer, mit Basic-Auth aus SID und Token — und
 *                   landet im selben Verlauf.
 *   8 EHRLICHKEIT   Lehnt Twilio wegen Trial oder wegen fehlender
 *                   10DLC-Registrierung ab, steht genau das in der Meldung.
 *   9 HERKUNFT      Man sieht einer Zeile an, dass sie eine SMS ist — auch
 *                   der eigenen Antwort.
 *
 * WARUM EIN DOPPELGÄNGER UND KEIN ECHTES KONTO
 * Es gibt hier kein Twilio-Konto, keinen echten Auth Token und keine
 * Verbindung zu Twilio — dieselbe Entscheidung wie bei
 * src/pruefungen/ki-schluessel.mts („Warum ein Doppelgänger und nicht die
 * echte Schnittstelle") und bei post-abruf.mts. Für den VERSAND läuft ein
 * winziger HTTP-Dienst auf 127.0.0.1, `TWILIO_ENDE` zeigt auf ihn, und er
 * schreibt mit, welche Kopfzeilen und welche Felder ankommen. Nur so lässt
 * sich Punkt 7 überhaupt belegen: die Frage ist nicht, ob am Ende eine Zeile
 * dasteht, sondern ob in `From` wirklich die eigene Nummer steht und in der
 * `Authorization` wirklich SID und Token.
 *
 * DIE SIGNATUREN RECHNET DIESER LAUF SELBST — nach dem dokumentierten
 * Verfahren, nicht mit der Funktion des Servers. `signaturRechnen()` aus
 * http/smseingang.ts hier einzubinden hieße, den Prüfling gegen sich selbst
 * zu messen: ein Fehler in der Sortierung stünde dann auf beiden Seiten und
 * fiele nie auf. Deshalb steht die Rechnung unten noch einmal, unabhängig
 * aus Twilios Beschreibung abgeleitet:
 *
 *     zeichenfolge = URL; für jeden Schlüssel alphabetisch: += Schlüssel+Wert
 *     Signatur     = base64( HMAC-SHA1( AuthToken, zeichenfolge ) )
 *
 * KEIN GEHEIMNIS IN DER AUSGABE
 * Token, SID und Nummer sind bei jedem Lauf frisch gewürfelt und tragen ein
 * sichtbares `probe`. Jeder Vergleich damit wird VORHER zu true/false
 * gerechnet; gedruckt werden nur Wahrheitswerte, Zahlen und Namen.
 *
 * Aufruf:  node scripts/sms-pruefen.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

let fehler = 0;
const gruen = '\u001b[32m';
const rot = '\u001b[31m';
const aus = '\u001b[0m';
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? `${gruen}✓${aus}` : `${rot}✗${aus}`} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/* ── Proben: frisch gewürfelt, offensichtlich unecht ──────────────── */
const PROBEN = {
  /* Twilios Form: „AC" und 32 Hexziffern. Die Route prüft sie, also muss die
     Probe dieselbe Strecke gehen wie im Ernstfall. */
  sid: `AC${crypto.randomBytes(16).toString('hex')}`,
  token: `probe${crypto.randomBytes(14).toString('hex').slice(0, 27)}`,
  /* Ein zweiter Token, der NIE hinterlegt wird — mit ihm wird eine Signatur
     gerechnet, die scheitern muss. */
  fremderToken: `fremd${crypto.randomBytes(14).toString('hex').slice(0, 27)}`,
  /* Der Wert, den ein Mitglied vergeblich zu setzen versucht. Er darf nach
     dem Lauf nirgends stehen. */
  verboten: `verbot${crypto.randomBytes(14).toString('hex').slice(0, 26)}`,
};
const EIGENE_NUMMER = '+15550001111';
const GEGENSTELLE = '+15557772222';
const ANDERE_NUMMER = '+15558883333';
const WEBHOOK_BASIS = 'https://probe.stellium.invalid';
const WEBHOOK_ADRESSE = `${WEBHOOK_BASIS}/api/sms/eingang`;
/* Die INTERNE Adresse hinter dem Tunnel — eine Signatur über sie muss
   scheitern, sonst wäre der ganze Aufwand um die hinterlegte Adresse
   vergeblich. */
const INTERNE_ADRESSE = 'http://127.0.0.1:8787/api/sms/eingang';

/* ── Der Twilio-Doppelgänger (nur für den VERSAND) ────────────────── */

interface Mitschnitt { pfad: string; auth: string; felder: Record<string, string> }
const gesehen: Mitschnitt[] = [];
/** Was der Doppelgänger als Nächstes antwortet. `null` = Erfolg. */
let antwortet: { status: number; koerper: string } | null = null;

const doppelgaenger = http.createServer((req, res) => {
  let rumpf = '';
  req.on('data', (stueck) => { rumpf += stueck; });
  req.on('end', () => {
    const felder: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(rumpf)) felder[k] = v;
    gesehen.push({ pfad: req.url ?? '', auth: String(req.headers.authorization ?? '(keine)'), felder });
    res.setHeader('content-type', 'application/json');
    if (antwortet) {
      res.statusCode = antwortet.status;
      res.end(antwortet.koerper);
      return;
    }
    res.statusCode = 201;
    res.end(JSON.stringify({ sid: `SM${crypto.randomBytes(16).toString('hex')}`, status: 'queued' }));
  });
});
await new Promise<void>((fertig) => doppelgaenger.listen(0, '127.0.0.1', fertig));
const port = (doppelgaenger.address() as AddressInfo).port;

/* ── Die Umgebung, bevor irgendetwas sie liest ────────────────────── */
/* Ein eigenes Masterpasswort statt der Keychain: der Lauf soll auf jedem
   Rechner gleich ausgehen — auf dem Pi, auf dem es keine Keychain gibt,
   genauso wie auf einem Mac mit ganz anderem Inhalt darin. */
process.env.STELLIUM_MASTER_PASSPHRASE = `pruef-${crypto.randomBytes(24).toString('hex')}`;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_NUMMER;
process.env.TWILIO_ENDE = `http://127.0.0.1:${port}`;

/* Dynamisch, aus demselben Grund wie in ki-schluessel.mts: config.ts liest
   `TWILIO_ENDE` und das Masterpasswort EINMAL beim Laden, und ein gewöhnlicher
   `import` oben liefe vor dem Dateirumpf — der Doppelgänger hätte seinen Port
   dann noch gar nicht. */
const { geheimStand } = await import('../config.js');
const { db, initDb } = await import('../db/index.js');
const { entschluesseln } = await import('../crypto/nachrichten.js');
const { registerRoutes } = await import('../http/routes.js');
const { signToken } = await import('../auth.js');
const users = await import('../services/users.js');
const { Vault } = await import('../secrets.js');
const path = await import('node:path');

initDb();

function konto(rolle: string, id: string): string {
  db.run(
    'INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)',
    id, id, id, 'x', rolle, Date.now(),
  );
  return id;
}
const inhaber = konto('owner', 'u_inhaber');
const verwalter = konto('admin', 'u_verwalter');
const mitglied = konto('member', 'u_mitglied');

const app = Fastify({ logger: false });
await registerRoutes(app);

const hole = (pfad: string, wer: string) => app.inject({
  method: 'GET', url: pfad, headers: { authorization: `Bearer ${signToken(wer)}` },
});
const schicke = (pfad: string, wer: string, rumpf: unknown) => app.inject({
  method: 'POST', url: pfad, headers: { authorization: `Bearer ${signToken(wer)}` }, payload: rumpf as object,
});
const loesche = (pfad: string, wer: string) => app.inject({
  method: 'DELETE', url: pfad, headers: { authorization: `Bearer ${signToken(wer)}` },
});

/** Der rohe Tresorinhalt — nur für die Gegenprobe, nie gedruckt. */
const tresorRoh = (): string => {
  const datei = path.join(process.env.DATA_DIR ?? 'data', 'secrets.enc');
  const v = new Vault(path.resolve(datei));
  return v.exists() ? JSON.stringify(v.load(process.env.STELLIUM_MASTER_PASSPHRASE as string)) : '{}';
};

/* ── Twilios Signaturverfahren, unabhängig nachgebaut ─────────────── */

/**
 * Adresse, dann jeder Formularschlüssel ALPHABETISCH mit seinem Wert
 * unmittelbar dahinter — ohne Trenner. Über diese Zeichenfolge ein HMAC-SHA1
 * mit dem Auth Token, das Ergebnis base64.
 */
function signatur(url: string, felder: Record<string, string>, token: string): string {
  let daten = url;
  for (const schluessel of Object.keys(felder).sort()) daten += schluessel + felder[schluessel];
  return crypto.createHmac('sha1', token).update(daten, 'utf8').digest('base64');
}

/** Ein Webhook-Aufruf, wie Twilio ihn schickt. `sig` ausdrücklich mitgeben,
    um absichtlich falsch zu signieren; `null` heißt „gar keine Kopfzeile". */
const webhook = (felder: Record<string, string>, sig: string | null | undefined = undefined) => {
  const rumpf = new URLSearchParams(felder).toString();
  const kopf: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const wert = sig === undefined ? signatur(WEBHOOK_ADRESSE, felder, PROBEN.token) : sig;
  if (wert !== null) kopf['x-twilio-signature'] = wert;
  return app.inject({ method: 'POST', url: '/api/sms/eingang', headers: kopf, payload: rumpf });
};

/** Eine SMS, wie Twilio sie beilegt — mit den Feldern, die wirklich zählen,
    und ein paar, die Twilio sonst noch mitschickt (sie gehen in die Signatur
    ein und müssen deshalb mitgerechnet werden). */
const sms = (text: string, sid: string, von = GEGENSTELLE, an = EIGENE_NUMMER) => ({
  ToCountry: 'US', ToState: 'CA', SmsMessageSid: sid, NumMedia: '0',
  From: von, To: an, Body: text, MessageSid: sid, AccountSid: PROBEN.sid,
  NumSegments: '1', ApiVersion: '2010-04-01',
});

const sidNeu = () => `SM${crypto.randomBytes(16).toString('hex')}`;

/** Wie viele eingegangene SMS-Zeilen stehen in der Datenbank? */
const smsZeilen = (): number => db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM mail_nachrichten WHERE quelle = 'sms' AND richtung = 'ein'")?.n ?? 0;

/* ── 0) Ausgangslage ──────────────────────────────────────────────── */
console.log('\n0) Ausgangslage');
pruef('Die Proben sind alle verschieden', new Set(Object.values(PROBEN)).size, Object.keys(PROBEN).length);
pruef('Keine der Proben ist leer', Object.values(PROBEN).every((w) => w.length > 20), true);
pruef('Keine TWILIO-Variable in der Umgebung (der Lauf setzt sie selbst)',
  Boolean(process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_NUMMER), false);
pruef('Der Tresor ist beschreibbar (Masterpasswort vorhanden)',
  geheimStand('TWILIO_AUTH_TOKEN', 'twilio_token').schreibbar, true);
pruef('Noch liegt kein Token vor', geheimStand('TWILIO_AUTH_TOKEN', 'twilio_token').hinterlegt, false);
pruef('Der Inhaber trägt sms.verwalten', users.may(inhaber, 'sms.verwalten'), true);
/* Bewusst so entschieden, nicht durchgerutscht: ADMIN ist ALLE minus drei
   (permissions.ts). Diese Zeile hält die Entscheidung fest — ändert sie
   jemand, fällt sie hier auf und nicht erst im Betrieb. */
pruef('Der Administrator ebenfalls', users.may(verwalter, 'sms.verwalten'), true);
pruef('Ein gewöhnliches Mitglied NICHT', users.may(mitglied, 'sms.verwalten'), false);
pruef('Ein Mitglied darf auch nicht senden', users.may(mitglied, 'mail.senden'), false);

/* ── 1) Fail closed, BEVOR irgendetwas hinterlegt ist ─────────────── */
console.log('\n1) Ohne Zugang wird nichts angenommen — nicht etwa alles');
const ohneAlles = await webhook(sms('Hallo', sidNeu()));
pruef('Webhook ohne hinterlegten Token: 503', ohneAlles.statusCode, 503);
pruef('...und es entsteht keine Zeile', smsZeilen(), 0);

/* ── 2) Recht ─────────────────────────────────────────────────────── */
console.log('\n2) Recht — nur wer den Zugang einrichten darf');
pruef('GET  /api/sms/zugang — Inhaber: 200', (await hole('/api/sms/zugang', inhaber)).statusCode, 200);
pruef('GET  /api/sms/zugang — Administrator: 200', (await hole('/api/sms/zugang', verwalter)).statusCode, 200);
pruef('GET  /api/sms/zugang — Mitglied: 403', (await hole('/api/sms/zugang', mitglied)).statusCode, 403);
pruef('POST /api/sms/zugang — Mitglied: 403',
  (await schicke('/api/sms/zugang', mitglied, { token: PROBEN.verboten })).statusCode, 403);
pruef('DELETE /api/sms/zugang — Mitglied: 403', (await loesche('/api/sms/zugang', mitglied)).statusCode, 403);
pruef('...und der abgewiesene Wert steht danach nirgends im Tresor',
  tresorRoh().includes(PROBEN.verboten), false);
pruef('GET  /api/sms/zugang — ohne Anmeldung: 401',
  (await app.inject({ method: 'GET', url: '/api/sms/zugang' })).statusCode, 401);

/* ── 3) Formprüfung der Eingaben ──────────────────────────────────── */
console.log('\n3) Die Route prüft die Form, bevor etwas im Tresor landet');
pruef('Eine SID ohne „AC" wird abgewiesen',
  (await schicke('/api/sms/zugang', inhaber, { sid: 'XX0123456789abcdef0123456789abcd' })).statusCode, 400);
pruef('Eine abgeschnittene Nummer wird abgewiesen',
  (await schicke('/api/sms/zugang', inhaber, { nummer: '5550001111' })).statusCode, 400);
pruef('Eine http-Webhook-Adresse wird abgewiesen (nur https)',
  (await schicke('/api/sms/zugang', inhaber, { webhookBasis: 'http://probe.stellium.invalid' })).statusCode, 400);
pruef('Eine Adresse mit Abfrageteil wird abgewiesen',
  (await schicke('/api/sms/zugang', inhaber, { webhookBasis: `${WEBHOOK_BASIS}/?x=1` })).statusCode, 400);
pruef('...und nach all dem liegt immer noch nichts im Tresor',
  geheimStand('TWILIO_AUTH_TOKEN', 'twilio_token').hinterlegt, false);

/* ── 4) Hinterlegen ───────────────────────────────────────────────── */
console.log('\n4) Hinterlegen — und die Webhook-Adresse ablesen können');
const gesetzt = await schicke('/api/sms/zugang', inhaber, {
  sid: PROBEN.sid, token: PROBEN.token, nummer: EIGENE_NUMMER, webhookBasis: WEBHOOK_BASIS,
});
pruef('POST /api/sms/zugang — Inhaber: 200', gesetzt.statusCode, 200);
const stand = JSON.parse(gesetzt.body) as {
  sid: { hinterlegt: boolean; quelle: string | null };
  token: { hinterlegt: boolean; quelle: string | null };
  nummer: { hinterlegt: boolean };
  webhookAdresse: string | null; sendenBereit: boolean; eingangBereit: boolean;
};
pruef('Der Server meldet alle drei als hinterlegt, Quelle Tresor',
  [stand.sid.hinterlegt, stand.token.hinterlegt, stand.nummer.hinterlegt, stand.token.quelle],
  [true, true, true, 'tresor']);
pruef('Senden und Empfangen melden sich bereit', [stand.sendenBereit, stand.eingangBereit], [true, true]);
/* DER PUNKT FÜR DEN MENSCHEN: die Adresse steht vollständig da, nicht halb —
   sie wird von Hand in die Twilio-Console übertragen, und ein Zeichen daneben
   lässt jede Signaturprüfung fehlschlagen. */
pruef('Die vollständige Webhook-Adresse kommt zurück', stand.webhookAdresse, WEBHOOK_ADRESSE);

/* ── 5) Kein Geheimnis kommt zurück ───────────────────────────────── */
console.log('\n5) Die Werte selbst kommen nie zurück');
const nachStand = await hole('/api/sms/zugang', inhaber);
const geheim = [PROBEN.sid, PROBEN.token, EIGENE_NUMMER];
pruef('Weder SID noch Token noch Nummer stehen im Rumpf von GET',
  geheim.filter((w) => nachStand.body.includes(w)).length, 0);
pruef('...auch nicht im Rumpf von POST', geheim.filter((w) => gesetzt.body.includes(w)).length, 0);
pruef('...auch nicht in den Kopfzeilen',
  geheim.filter((w) => JSON.stringify(nachStand.headers).includes(w)).length, 0);
pruef('Auch kein Anfangsstück des Tokens', nachStand.body.includes(PROBEN.token.slice(0, 12)), false);
pruef('Auch kein Endstück', nachStand.body.includes(PROBEN.token.slice(-6)), false);
/* Die Gegenprobe: die Werte SIND da — nur eben im Tresor und nicht in der
   Antwort. Ohne diese Zeile wären die vier darüber von einer kaputten Suche
   nicht zu unterscheiden. */
pruef('Gegenprobe: dieselbe Suche findet Token und SID sehr wohl im Tresor',
  [tresorRoh().includes(PROBEN.token), tresorRoh().includes(PROBEN.sid)], [true, true]);

/* ── 6) DIE SIGNATURPRÜFUNG ───────────────────────────────────────── */
console.log('\n6) Signatur — ohne gültige wird nichts angenommen und nichts angelegt');
const s1 = sms('Erste echte SMS', sidNeu());

pruef('GAR KEINE Signaturkopfzeile: 403', (await webhook(s1, null)).statusCode, 403);
pruef('Leere Signaturkopfzeile: 403', (await webhook(s1, '')).statusCode, 403);
pruef('Erfundene Signatur: 403', (await webhook(s1, 'ZmFsc2NoZXNpZ25hdHVyMDAwMDAwMDA=')).statusCode, 403);
pruef('Signatur mit einem FREMDEN Token: 403',
  (await webhook(s1, signatur(WEBHOOK_ADRESSE, s1, PROBEN.fremderToken))).statusCode, 403);
/* DER KERN DER ADRESSFRAGE: dieselbe Rechnung, derselbe Token — nur über die
   INTERNE Adresse hinter dem Tunnel statt über die öffentliche. Ginge das
   durch, wäre die hinterlegte Adresse Zierrat und `Host` wieder maßgeblich. */
pruef('Gültig gerechnet, aber über die INTERNE Adresse: 403',
  (await webhook(s1, signatur(INTERNE_ADRESSE, s1, PROBEN.token))).statusCode, 403);
/* Signatur zu einem anderen Feldsatz: der Beleg, dass wirklich der INHALT
   signiert ist und nicht bloß die Adresse. */
pruef('Signatur zu einem anderen Text: 403',
  (await webhook(s1, signatur(WEBHOOK_ADRESSE, sms('anderer Text', s1.MessageSid), PROBEN.token))).statusCode, 403);
/* DER ANGRIFF, GEGEN DEN DIE HINTERLEGTE ADRESSE SCHÜTZT — und die
   Gegenrichtung zur Zeile darüber. `Host` kommt vom Aufrufer. Baute der
   Server die signierte Adresse daraus, könnte jemand mit einer irgendwo
   mitgeschnittenen Signatur desselben Kontos einfach den passenden Host
   dazusetzen, und die Rechnung ginge auf. Hier steht genau dieser Versuch:
   Signatur und Host stimmen zueinander, nur eben nicht zur hinterlegten
   Adresse. */
const erfundenerHost = 'angreifer.invalid';
pruef('Signatur samt passend GEFÄLSCHTEM Host-Kopf: 403', (await app.inject({
  method: 'POST',
  url: '/api/sms/eingang',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    host: erfundenerHost,
    'x-twilio-signature': signatur(`http://${erfundenerHost}/api/sms/eingang`, s1, PROBEN.token),
  },
  payload: new URLSearchParams(s1).toString(),
})).statusCode, 403);
pruef('Nach SIEBEN abgewiesenen Versuchen steht keine einzige Zeile da', smsZeilen(), 0);

/* Und die Gegenprobe — sonst wäre alles darüber von „der Endpunkt nimmt
   grundsätzlich nichts an" nicht zu unterscheiden. */
const echt = await webhook(s1);
pruef('Mit gültiger Signatur: 200', echt.statusCode, 200);
pruef('...und JETZT steht genau eine Zeile da', smsZeilen(), 1);
/* Twilio liest die Antwort als Anweisung — leeres TwiML heißt „angekommen,
   nichts zu tun" und verhindert eine automatische Rückantwort. */
pruef('Die Antwort ist leeres TwiML, kein JSON',
  [String(echt.headers['content-type']).includes('xml'), echt.body.includes('<Response>')], [true, true]);

/* ── 7) Ohne hinterlegte Adresse: ebenfalls dicht ─────────────────── */
console.log('\n7) Fail closed auch ohne Webhook-Adresse — sie ist die Rechengrundlage');
const { setSetting } = await import('../services/settings.js');
setSetting('sms.webhookBasis', null, inhaber);
const s2 = sms('Darf nicht ankommen', sidNeu());
pruef('Webhook ohne hinterlegte Adresse: 503',
  (await webhook(s2, signatur(WEBHOOK_ADRESSE, s2, PROBEN.token))).statusCode, 503);
pruef('...und es entsteht keine Zeile', smsZeilen(), 1);
await schicke('/api/sms/zugang', inhaber, { webhookBasis: WEBHOOK_BASIS });
pruef('Mit wieder hinterlegter Adresse geht dieselbe SMS durch: 200',
  (await webhook(s2, signatur(WEBHOOK_ADRESSE, s2, PROBEN.token))).statusCode, 200);
pruef('...und jetzt sind es zwei Zeilen', smsZeilen(), 2);

/* ── 8) DIE WIEDERHOLUNG ──────────────────────────────────────────── */
console.log('\n8) Twilio wiederholt bei Zeitüberschreitung — es bleibt bei EINER Zeile');
const vorher = smsZeilen();
const s3 = sms('Wird zweimal zugestellt', sidNeu());
const erst = await webhook(s3);
const nochmal = await webhook(s3);
pruef('Erste Zustellung: 200', erst.statusCode, 200);
/* 200 und nicht 409: eine Dublette ist kein Fehler, den man Twilio meldet,
   sondern schon erledigte Arbeit — dieselbe Entscheidung wie im Posteingang.
   Ein 4xx hieße für Twilio „endgültig abgelehnt". */
pruef('Zweite Zustellung derselben SMS: ebenfalls 200', nochmal.statusCode, 200);
pruef('Und es ist GENAU EINE Zeile dazugekommen', smsZeilen() - vorher, 1);
/* Ein dritter Anlauf mit abweichenden NEBENfeldern: Twilio schickt bei einer
   Wiederholung dieselbe MessageSid, aber die Nebenfelder gehören nicht zu
   dem, was eine SMS ausmacht. Auch das darf keine zweite Zeile geben. */
const s3b = { ...s3, ToState: 'NY', NumSegments: '2' };
pruef('Wiederholung mit abweichenden Nebenfeldern: 200', (await webhook(s3b)).statusCode, 200);
pruef('...und noch immer nur eine Zeile mehr als vorher', smsZeilen() - vorher, 1);

/* ── 8b) Ein LANGES Feld darf die Signatur nicht kippen ───────────── */
console.log('\n8b) Die Signatur wird über das gerechnet, was ankam — nicht über eine gekappte Fassung');
/* WARUM DIESER PUNKT EXISTIERT: hier wurden die Feldwerte zuerst gekappt und
   DANN signaturgeprüft. Twilio bildet die Signatur über die vollständigen
   Werte — jede SMS mit einem Feld über der Kappungsgrenze wäre als „Signatur
   falsch" abgewiesen worden. Nicht sichtbar kaputt, sondern still: im
   Posteingang fehlte einfach etwas. Ein Wächter, der nur mit kurzen Texten
   misst, hätte davon nie etwas gemerkt. */
const vorherLang = smsZeilen();
const langerText = 'A'.repeat(5000);
const langeSms = sms(langerText, sidNeu());
pruef('Eine SMS mit einem sehr langen Feld: 200', (await webhook(langeSms)).statusCode, 200);
pruef('...und sie steht als Zeile da', smsZeilen() - vorherLang, 1);

/* ── 9) Zwei VERSCHIEDENE SMS fallen nie zusammen ─────────────────── */
console.log('\n9) Kein falsches Zusammenfallen');
const vorher2 = smsZeilen();
await webhook(sms('Ja', sidNeu()));
await webhook(sms('Ja', sidNeu()));
pruef('Zweimal derselbe kurze Text, verschiedene MessageSid: zwei Zeilen',
  smsZeilen() - vorher2, 2);
await webhook(sms('Von zwei verschiedenen Nummern', sidNeu(), GEGENSTELLE));
await webhook(sms('Von zwei verschiedenen Nummern', sidNeu(), ANDERE_NUMMER));
pruef('Derselbe Text von zwei Nummern: noch einmal zwei Zeilen', smsZeilen() - vorher2, 4);

/* ── 10) Felder ───────────────────────────────────────────────────── */
console.log('\n10) Feldprüfung — mit GÜLTIGER Signatur, damit wirklich die Felder gemessen werden');
const vorher3 = smsZeilen();
const krummeNummer = { ...sms('x', sidNeu()), From: '5551234' };
pruef('From ohne E.164-Form: 400',
  (await webhook(krummeNummer, signatur(WEBHOOK_ADRESSE, krummeNummer, PROBEN.token))).statusCode, 400);
const krummeSid = { ...sms('x', sidNeu()), MessageSid: 'nicht-twilios-form' };
pruef('MessageSid in fremder Form: 400',
  (await webhook(krummeSid, signatur(WEBHOOK_ADRESSE, krummeSid, PROBEN.token))).statusCode, 400);
/* Doppelte Schlüssel: ohne Trenner in der signierten Zeichenfolge ließen sich
   sonst zwei Belegungen mit derselben Signatur bauen. */
const doppelteFelder = `${new URLSearchParams(sms('x', sidNeu())).toString()}&Body=zweiter`;
pruef('Ein doppelt gesendetes Formularfeld: 400', (await app.inject({
  method: 'POST', url: '/api/sms/eingang',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'egal' },
  payload: doppelteFelder,
})).statusCode, 400);
pruef('Keiner dieser drei Versuche hat eine Zeile angelegt', smsZeilen() - vorher3, 0);

/* ── 11) Was in der Datenbank steht ───────────────────────────────── */
console.log('\n11) Die Zeile im Posteingang — Herkunft, Fach, Verschlüsselung');
const zeile = db.get<{
  id: string; fach: string; quelle: string; von: string; an: string;
  betreff: string; text: string; thread_id: string;
}>('SELECT id, fach, quelle, von, an, betreff, text, thread_id FROM mail_nachrichten WHERE message_id = ?',
  `<${s3.MessageSid}@sms.twilio.invalid>`);
pruef('Die SMS liegt als Zeile vor', Boolean(zeile), true);
pruef('Ihre Herkunft ist „sms"', zeile?.quelle, 'sms');
/* `sonstiges`, nicht ein neuntes Fach — die Begründung steht im Kopf von
   services/sms.ts. */
pruef('Ihr Fach ist „sonstiges"', zeile?.fach, 'sonstiges');
pruef('Absender und Empfänger stehen entschlüsselt richtig da',
  [entschluesseln(zeile!.von), entschluesseln(zeile!.an)], [GEGENSTELLE, EIGENE_NUMMER]);
pruef('Der Betreff ist leer (eine SMS hat keinen)', entschluesseln(zeile!.betreff), '');
pruef('Der Text steht entschlüsselt richtig da', entschluesseln(zeile!.text), 'Wird zweimal zugestellt');
/* Der Punkt, an dem der ganze Rest hängt: der Klartext darf NICHT roh in der
   Spalte stehen. Steht er es doch, ist die Verschlüsselung nicht gelaufen. */
pruef('...und NICHT im Klartext in der Spalte', zeile!.text.includes('Wird zweimal zugestellt'), false);
/* Alle SMS derselben Nummer teilen einen Verlauf — sonst stünde jede einzelne
   SMS als eigene Unterhaltung da (services/sms.ts, verlaufAnker()). */
const verlaeufe = db.all<{ thread_id: string }>(
  "SELECT DISTINCT thread_id FROM mail_nachrichten WHERE quelle = 'sms' AND von = ?", zeile!.von);
pruef('Alle SMS derselben Nummer teilen genau EINEN Verlauf', verlaeufe.length, 1);

/* ── 12) Die Antwort ──────────────────────────────────────────────── */
console.log('\n12) Antworten — an den Absender, aus der eigenen Nummer, über Twilio');
gesehen.length = 0;
antwortet = null;
const antwort = await schicke('/api/post/senden', inhaber, {
  fach: '', an: GEGENSTELLE, betreff: 'Re: ', text: 'Danke für die Nachricht.',
});
pruef('POST /api/post/senden an eine Telefonnummer: 200', antwort.statusCode, 200);
pruef('Genau ein Aufruf beim Twilio-Doppelgänger', gesehen.length, 1);
const ruf = gesehen[0];
/* Die Adresse trägt die Konto-Kennung — der Beleg, dass wirklich SID und
   Token gelten und nicht irgendein Rest von vorher. */
pruef('Er ging an /2010-04-01/Accounts/<SID>/Messages.json',
  ruf.pfad, `/2010-04-01/Accounts/${PROBEN.sid}/Messages.json`);
pruef('Basic-Auth aus SID und Token',
  ruf.auth === `Basic ${Buffer.from(`${PROBEN.sid}:${PROBEN.token}`, 'utf8').toString('base64')}`, true);
pruef('To ist der Absender der eingegangenen SMS', ruf.felder.To, GEGENSTELLE);
pruef('From ist die eigene Twilio-Nummer', ruf.felder.From, EIGENE_NUMMER);
pruef('Body ist der geschriebene Text', ruf.felder.Body, 'Danke für die Nachricht.');
/* Der Betreff, den das Schreibfenster mitschickt, gehört NICHT in eine SMS —
   er nähme dem Empfänger Zeichen aus seinem Kontingent. */
pruef('...und der Betreff „Re: " steht nicht darin', ruf.felder.Body.includes('Re:'), false);

const ausgang = db.get<{ quelle: string; thread_id: string; von: string; an: string }>(
  "SELECT quelle, thread_id, von, an FROM mail_nachrichten WHERE richtung = 'aus' ORDER BY am DESC LIMIT 1");
pruef('Die eigene Antwort steht als Zeile im Postfach', Boolean(ausgang), true);
pruef('Auch sie trägt die Herkunft „sms"', ausgang?.quelle, 'sms');
pruef('...und liegt im selben Verlauf wie die eingegangene SMS',
  ausgang?.thread_id, zeile?.thread_id);
pruef('Absender und Empfänger stehen richtig herum',
  [entschluesseln(ausgang!.von), entschluesseln(ausgang!.an)], [EIGENE_NUMMER, GEGENSTELLE]);
pruef('Ein Mitglied darf nicht senden: 403',
  (await schicke('/api/post/senden', mitglied, { an: GEGENSTELLE, text: 'x' })).statusCode, 403);

/* ── 13) Ehrliche Fehlermeldungen ─────────────────────────────────── */
console.log('\n13) Trial und 10DLC — beides steht in der Meldung, statt wie ein Fehler auszusehen');
const ausgangVorher = db.get<{ n: number }>(
  "SELECT COUNT(*) AS n FROM mail_nachrichten WHERE richtung = 'aus'")?.n ?? 0;

antwortet = {
  status: 400,
  koerper: JSON.stringify({
    code: 21608,
    message: 'The number is unverified. Trial accounts may only send messages to verified numbers.',
  }),
};
const trial = await schicke('/api/post/senden', inhaber, { an: GEGENSTELLE, text: 'Test' });
const trialK = JSON.parse(trial.body) as { code?: string; error?: string };
pruef('Trial-Ablehnung kommt als 400 zurück', trial.statusCode, 400);
pruef('...mit der Kennung sms.trialUnverifiziert', trialK.code, 'sms.trialUnverifiziert');
pruef('...und der Satz nennt Trial UND das Verifizieren',
  [/[Tt]rial/.test(trialK.error ?? ''), /verifizier/i.test(trialK.error ?? '')], [true, true]);
pruef('...und sagt ausdrücklich, dass Empfangen davon unberührt bleibt',
  /[Ee]mpfangen/.test(trialK.error ?? ''), true);

antwortet = {
  status: 400,
  koerper: JSON.stringify({ code: 30034, message: 'US A2P 10DLC - Message from an Unregistered Number' }),
};
const dlc = await schicke('/api/post/senden', inhaber, { an: GEGENSTELLE, text: 'Test' });
const dlcK = JSON.parse(dlc.body) as { code?: string; error?: string };
pruef('10DLC-Ablehnung kommt als 400 zurück', dlc.statusCode, 400);
pruef('...mit der Kennung sms.zehnDlcFehlt', dlcK.code, 'sms.zehnDlcFehlt');
pruef('...und der Satz nennt 10DLC', /10DLC/.test(dlcK.error ?? ''), true);

antwortet = { status: 401, koerper: JSON.stringify({ code: 20003, message: 'Authenticate' }) };
const abgelehnt = await schicke('/api/post/senden', inhaber, { an: GEGENSTELLE, text: 'Test' });
const abgelehntK = JSON.parse(abgelehnt.body) as { code?: string; error?: string };
pruef('Abgelehnte Zugangsdaten: Kennung sms.zugangAbgelehnt', abgelehntK.code, 'sms.zugangAbgelehnt');
/* Bei einer abgelehnten Anmeldung geht Twilios Wortlaut absichtlich NICHT mit
   hinaus — er nennt mitunter die verwendete Konto-Kennung. */
pruef('...und die Meldung nennt die SID nicht', (abgelehntK.error ?? '').includes(PROBEN.sid), false);

pruef('KEIN einziger dieser drei Fehlschläge hat eine Ausgangszeile angelegt',
  (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mail_nachrichten WHERE richtung = 'aus'")?.n ?? 0)
    - ausgangVorher, 0);

/* ── 14) Entfernen ────────────────────────────────────────────────── */
console.log('\n14) Entfernen — alle vier Angaben zugleich, und danach ist wieder dicht');
antwortet = null;
const entfernt = await loesche('/api/sms/zugang', inhaber);
pruef('DELETE /api/sms/zugang — Inhaber: 200', entfernt.statusCode, 200);
const nachher = JSON.parse(entfernt.body) as {
  sid: { hinterlegt: boolean }; token: { hinterlegt: boolean }; nummer: { hinterlegt: boolean };
  webhookAdresse: string | null; sendenBereit: boolean; eingangBereit: boolean;
};
pruef('Danach ist nichts mehr hinterlegt',
  [nachher.sid.hinterlegt, nachher.token.hinterlegt, nachher.nummer.hinterlegt,
    nachher.webhookAdresse, nachher.sendenBereit, nachher.eingangBereit],
  [false, false, false, null, false, false]);
/* Nicht „leerer Text abgelegt", sondern wirklich weg: ein leerer Eintrag
   stünde in der Tresorliste als vorhanden und wäre trotzdem nichts. */
const tresorNachher = JSON.parse(tresorRoh()) as Record<string, unknown>;
pruef('Die drei Namen sind aus dem Tresor verschwunden, nicht bloß geleert',
  [tresorNachher.twilio_sid, tresorNachher.twilio_token, tresorNachher.twilio_nummer],
  [undefined, undefined, undefined]);
const nachLoeschen = smsZeilen();
const s4 = sms('Nach dem Entfernen', sidNeu());
pruef('Ein Webhook mit der alten, gültigen Signatur: 503',
  (await webhook(s4, signatur(WEBHOOK_ADRESSE, s4, PROBEN.token))).statusCode, 503);
pruef('...und es entsteht keine Zeile', smsZeilen(), nachLoeschen);

await app.close();
doppelgaenger.close();

console.log(fehler
  ? `\n${rot}${fehler} Fehler.${aus}\n`
  : `\n${gruen}SMS: ohne gültige Signatur kommt nichts herein, eine Wiederholung legt nichts doppelt an, `
    + `die Zugangsdaten kommen nie zurück — und Trial wie 10DLC stehen ehrlich in der Meldung.${aus}\n`);
process.exit(fehler ? 1 : 0);
