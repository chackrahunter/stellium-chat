/**
 * Der Türsteher für eingehende SMS — das Gegenstück zu
 * `http/posteingang.ts`, für Twilio statt für den Cloudflare-Worker.
 *
 * Diese Route hängt öffentlich am Tunnel und nimmt Inhalt von Fremden
 * entgegen, genau wie die dortige — jede Zeile hier gehört zur Angriffsfläche.
 * Die Reihenfolge der Prüfungen folgt derselben Regel („billig vor teuer")
 * und ist unten Schritt für Schritt begründet. Wer hier etwas ändert, liest
 * zuerst den Kopf von posteingang.ts; was dort steht, gilt auch hier, außer
 * an den drei Stellen, an denen es ausdrücklich anders begründet ist.
 *
 * DER NACHWEIS IST EINE SIGNATUR, KEIN GETEILTES WORT. posteingang.ts
 * vergleicht ein Geheimnis, das der Worker mitschickt — das geht dort, weil
 * beide Seiten dasselbe Wort kennen und wir die eine davon selbst gebaut
 * haben. Twilio kennt kein solches Wort. Es signiert stattdessen jede Anfrage
 * mit dem Auth Token des Kontos:
 *
 *     zeichenfolge = <vollständige URL>
 *     für jeden Formularschlüssel in ALPHABETISCHER Reihenfolge:
 *         zeichenfolge += schluessel + wert
 *     Signatur = base64( HMAC-SHA1( AuthToken, zeichenfolge ) )
 *
 * und legt das Ergebnis als `X-Twilio-Signature` bei. Ohne gültige Signatur
 * wird nichts angenommen — und ohne hinterlegten Token oder ohne hinterlegte
 * Adresse wird ebenfalls nichts angenommen (fail closed), denn dann lässt
 * sich gar nichts nachrechnen.
 *
 * DIE URL MUSS DIE VON AUSSEN SICHTBARE SEIN. Das ist die Stelle, an der
 * diese Prüfung am leichtesten still kaputtgeht. Twilio signiert die Adresse,
 * die im Konto eingetragen ist — `https://chat.stellium.club/api/sms/eingang`
 * — nicht die, die hinter dem Tunnel ankommt (`http://127.0.0.1:8787/...`).
 * Sie aus `req.headers.host` zu bauen wäre der naheliegende Weg und wäre
 * falsch, und zwar nicht nur technisch: `Host` kommt vom Aufrufer. Wer eine
 * gültige Signatur zu IRGENDEINER Adresse desselben Twilio-Kontos
 * mitschneidet, könnte sie hier einreichen und den `Host` so setzen, dass die
 * Rechnung aufgeht. Deshalb kommt die Adresse aus dem hinterlegten Zugang
 * (services/smszugang.ts, `webhookAdresse()`) und aus nichts sonst.
 *
 * WARUM DIE FORMULARKODIERUNG NUR HIER GILT. Twilio schickt
 * `application/x-www-form-urlencoded`, kein JSON. Fastify kennt diesen Typ
 * ohne Zutun nicht und antwortet sonst mit 415. Der Parser wird deshalb in
 * einem EIGENEN Bereich (`app.register`) angemeldet und gilt nur für diese
 * eine Route. Ihn global anzumelden wäre kein Komfort, sondern eine
 * Schwächung: ein Formular auf einer fremden Seite kann `POST` mit
 * Formularkodierung an jede Adresse dieses Servers schicken, ohne dass der
 * Browser vorher fragt (JSON kann es nicht). Dass alle anderen Routen so
 * etwas mit 415 abweisen, ist ein Schutz — und der bleibt.
 *
 * WELCHER STATUSCODE WAS BEDEUTET — und wo das von posteingang.ts abweicht.
 * Twilio wiederholt bei 5xx und bei Zeitüberschreitung, bei 4xx nicht. Beim
 * Worker war ein Fehlschlag teuer (die Mail geht dann an ein privates
 * Ersatzpostfach), deshalb ist dort selbst der unerwartete Fehler ein 400.
 * Hier ist es umgekehrt: eine nicht angenommene SMS ist schlicht weg, und
 * eine Wiederholung ist dank des Abdruck-Dublettenschutzes gefahrlos (siehe
 * unten, Schritt 6). Ein unerwarteter Fehler geht darum als 500 hinaus,
 * damit Twilio es noch einmal versucht — beschriftet und protokolliert, nie
 * als nackte Ausnahme.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { gleich } from '../crypto/vertraulich.js';
import { authToken, webhookAdresse, EINGANG_PFAD, E164 } from '../services/smszugang.js';
import { eingangAufnehmenSms } from '../services/sms.js';

/** Die Kopfzeile, in der Twilio die Signatur mitschickt. */
const KOPF_SIGNATUR = 'x-twilio-signature';

/**
 * Eine SMS ist klein. Twilios Rumpf fasst höchstens 1600 Zeichen, dazu die
 * gut zwei Dutzend Felder, die Twilio beilegt — 64 KiB sind dafür reichlich
 * und trotzdem eine echte Grenze. Das globale `bodyLimit` in index.ts liegt
 * bei 2 MiB; das hier ist die kleinere, billigere Schranke davor.
 */
const EINGANG_BODY_LIMIT = 64 * 1024;

/**
 * So lang darf ein einzelnes Formularfeld sein, das WEITERVERARBEITET wird.
 *
 * WICHTIG, WO DAS GREIFT: erst NACH der Signaturprüfung, nie davor. Hier
 * stand die Kappung zuerst in `felderLesen()`, also VOR der Rechnung — und
 * das war ein Fehler mit einer sehr unangenehmen Wirkung: die Signatur wäre
 * über GEKAPPTE Werte gerechnet worden, Twilio hat sie aber über die
 * vollständigen gebildet. Jede echte SMS, die irgendein Feld über dieser
 * Grenze mitbringt, wäre als „Signatur falsch" abgewiesen worden — nicht
 * sichtbar kaputt, sondern still. Was eine übergroße Anfrage abfängt, ist
 * ohnehin nicht diese Zahl, sondern `EINGANG_BODY_LIMIT` darüber; die
 * Signatur wird deshalb immer über das gerechnet, was wirklich ankam.
 *
 * Gekappt und nicht abgelehnt — dieselbe Regel wie im Postfach: lieber
 * gekürzt zustellen als verlieren (services/post.ts, `kappen()`).
 */
const FELD_MAX = 4000;

/** Twilios Kennung einer Nachricht: zwei Buchstaben, dann 32 Hexziffern.
    Sie wird zur Message-ID (services/sms.ts) und damit zum Angelpunkt des
    Dublettenschutzes — ein Wert in fremder Form hätte dort nichts zu suchen. */
const MESSAGE_SID = /^[A-Z]{2}[0-9a-f]{32}$/;

function sha256Hex(wert: string): string {
  return crypto.createHash('sha256').update(wert, 'utf8').digest('hex');
}

/** Eine einzelne Kopfzeile als String — nie als Liste. Wortgleich mit
    posteingang.ts, und aus demselben Grund: eine mehrfach gesendete Kopfzeile
    zählt als „nichts Eindeutiges", nicht als Zufallstreffer auf den ersten
    Eintrag. */
function einzelnerKopf(wert: string | string[] | undefined): string {
  return typeof wert === 'string' ? wert : '';
}

/**
 * Twilios Signatur über Adresse und Felder nachrechnen.
 *
 * DIE SORTIERUNG IST TEIL DES VERFAHRENS, nicht Kosmetik: Twilio sortiert die
 * Schlüssel und hängt jeweils Schlüssel UND Wert unmittelbar aneinander.
 * `Array.prototype.sort()` ohne Vergleichsfunktion sortiert nach
 * UTF-16-Codepunkten — genau die Ordnung, die Twilios Bibliotheken
 * verwenden.
 *
 * OHNE TRENNZEICHEN zwischen den Feldern — auch das gehört zum Verfahren und
 * ist der Grund, warum `felderLesen()` unten doppelte Schlüssel ablehnt:
 * ohne Trenner ergäbe „ab"+"c" dieselbe Zeichenfolge wie „a"+"bc", und zwei
 * verschiedene Feldbelegungen hätten dieselbe Signatur.
 */
function signaturRechnen(url: string, felder: Map<string, string>, token: string): string {
  let daten = url;
  for (const schluessel of [...felder.keys()].sort()) daten += schluessel + felder.get(schluessel);
  return crypto.createHmac('sha1', token).update(daten, 'utf8').digest('base64');
}

/* ── Die Ratenbremse ──────────────────────────────────────────────
 *
 * Ein einziger, globaler Token-Eimer, kein Zählwerk je Herkunft — dieselbe
 * Begründung wie in posteingang.ts: Fastify läuft hinter cloudflared ohne
 * `trustProxy`, und `req.ip` ist für jede Anfrage von außen 127.0.0.1.
 *
 * Ein EIGENER Eimer und nicht der des Posteingangs: sonst schöbe eine Flut
 * von SMS die eingehende Firmenpost beiseite und umgekehrt. Zwei Wege, die
 * nichts miteinander zu tun haben, sollen sich auch keine Grenze teilen.
 *
 * DIESELBEN ZAHLEN WIE DORT, und das ist eine Korrektur: hier stand zuerst
 * ein kleinerer Eimer, mit dem Argument, SMS kämen einzeln und von Menschen
 * getippt. Das Argument stimmt, die Schlussfolgerung nicht. Wer den Eimer
 * überhaupt anrührt, hat die Signaturprüfung schon bestanden — er kennt also
 * den Auth Token, und gegen den ist eine Ratenbremse ohnehin nicht die
 * Verteidigung. Was der Eimer wirklich abfängt, ist ein Schub echter
 * Nachrichten auf eine SQLite-Datenbank auf einem Raspberry Pi; und dort ist
 * zu knapp die schlechtere Seite des Irrtums. Ein 429 bestellt bei Twilio
 * zwar eine Wiederholung (die dank des Dublettenschutzes gefahrlos ist),
 * aber jede unnötige Wiederholung ist eine verzögerte Nachricht.
 */
const EIMER_GROESSE = 30;
const EIMER_PRO_SEKUNDE = 1;
let eimerStand = EIMER_GROESSE;
let eimerLetzterStand = Date.now();

function eimerZiehen(): boolean {
  const jetzt = Date.now();
  const vergangeneSekunden = (jetzt - eimerLetzterStand) / 1000;
  eimerLetzterStand = jetzt;
  eimerStand = Math.min(EIMER_GROESSE, eimerStand + vergangeneSekunden * EIMER_PRO_SEKUNDE);
  if (eimerStand < 1) return false;
  eimerStand -= 1;
  return true;
}

/**
 * Den Formularrumpf in eine Karte lesen — oder sagen, warum nicht.
 *
 * DOPPELTE SCHLÜSSEL WERDEN ABGELEHNT, nicht zusammengefasst und nicht
 * überschrieben. Twilio schickt keine; wer welche schickt, versucht etwas.
 * Der Grund steht bei `signaturRechnen()` oben: die signierte Zeichenfolge
 * kennt keine Trenner, und wer zwei Belegungen mit derselben Signatur bauen
 * kann, hat die Prüfung nicht gebrochen, sondern umgangen. „Der erste
 * gewinnt" oder „der letzte gewinnt" wären beides eine Entscheidung darüber,
 * WELCHE der beiden Bedeutungen gilt — hier gilt keine.
 */
function felderLesen(rumpf: string): { ok: true; felder: Map<string, string> } | { ok: false; hinweis: string } {
  const felder = new Map<string, string>();
  for (const [schluessel, wert] of new URLSearchParams(rumpf)) {
    if (felder.has(schluessel)) {
      return { ok: false, hinweis: `Das Feld "${schluessel}" kam doppelt.` };
    }
    /* UNGEKAPPT — siehe FELD_MAX oben. Was gespeichert wird, kappt `feld()`
       weiter unten, nach der Signaturprüfung. */
    felder.set(schluessel, wert);
  }
  return { ok: true, felder };
}

/**
 * Registriert `POST /api/sms/eingang`.
 *
 * Aufgerufen aus routes.ts, direkt neben `registerPostEingang()` — und wie
 * jene ohne `requireUser`/`requirePermission`: der Nachweis ist hier die
 * Signatur Twilios, kein angemeldetes Konto.
 */
export function registerSmsEingang(app: FastifyInstance): void {
  void app.register(async (bereich) => {
    /* Nur in diesem Bereich, siehe Dateikopf. `parseAs: 'string'`, weil die
       Signatur über die DEKODIERTEN Felder gerechnet wird und nicht über die
       rohen Bytes — die Zerlegung übernimmt `felderLesen()` oben, damit
       genau eine Stelle im Haus entscheidet, was ein Feld ist. */
    bereich.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: EINGANG_BODY_LIMIT },
      (_req, rumpf, fertig) => { fertig(null, rumpf); },
    );

    bereich.post(EINGANG_PFAD, { bodyLimit: EINGANG_BODY_LIMIT }, async (req, reply) => {
      /* ── Schritt 1: fail closed, zweimal getrennt ───────────────
         Erst „gibt es überhaupt einen Token", dann — nur wenn ja — „stimmt
         die Signatur". Dieselbe Falle wie in posteingang.ts, Schritt 1: ein
         zusammengezogenes `if (token && signatur !== erwartet)` liefe am
         Vergleich vollständig vorbei, sobald `token` leer ist, und der
         Endpunkt nähme jede Anfrage an. Leer wird er nicht nur, wenn niemand
         ihn eingetragen hat, sondern auch, wenn der Tresor verschlossen ist —
         `secret()` gibt dann einen leeren String zurück, keinen Fehler.

         503 und nicht 400: für Twilio heißt das „später noch einmal", und
         genau das ist richtig, solange nur die Einrichtung fehlt. */
      const token = authToken();
      if (!token) {
        console.error('[sms/eingang] kein Twilio-Auth-Token hinterlegt — SMS werden abgewiesen (fail closed)');
        return reply.code(503).send({
          error: 'Der SMS-Eingang ist nicht eingerichtet.', code: 'fehler.smsNichtEingerichtet',
        });
      }
      /* Ohne hinterlegte Adresse ist die Signatur nicht nachrechenbar — siehe
         Dateikopf. Aus der Anfrage darf sie nicht kommen. */
      const adresse = webhookAdresse();
      if (!adresse) {
        console.error('[sms/eingang] keine Webhook-Adresse hinterlegt — ohne sie ist die Signatur nicht prüfbar (fail closed)');
        return reply.code(503).send({
          error: 'Der SMS-Eingang ist nicht eingerichtet.', code: 'fehler.smsNichtEingerichtet',
        });
      }

      /* ── Schritt 2: den Rumpf zerlegen ─────────────────────────
         Vor der Kryptografie, weil die Signatur über die FELDER geht: ohne
         Zerlegung gibt es nichts zu rechnen. Teuer wird dabei nichts — der
         Rumpf ist durch `EINGANG_BODY_LIMIT` schon gedeckelt, bevor diese
         Funktion ihn zu sehen bekommt. Gekappt wird hier bewusst NICHTS,
         siehe FELD_MAX oben. */
      const rumpf = typeof req.body === 'string' ? req.body : '';
      const gelesen = felderLesen(rumpf);
      if (!gelesen.ok) {
        return reply.code(400).send({ error: gelesen.hinweis, code: 'fehler.smsKoerper' });
      }

      /* ── Schritt 3: die Signatur ───────────────────────────────
         Zeitunabhängig verglichen, und zwar über SHA-256-Digests statt über
         die Signaturen selbst — dieselbe Überlegung wie in posteingang.ts:
         `gleich()` bricht bei ungleicher Länge sofort ab, und über den
         Rohwert verglichen wäre schon das ein kleiner Zeit-Hinweis. Über den
         Digest sind die verglichenen Längen immer gleich.

         403 und nicht 401: für Twilio ist das „verstanden und endgültig
         abgelehnt". Eine Wiederholung würde dieselbe ungültige Signatur
         tragen und wieder scheitern — sie zu bestellen wäre sinnlos.
         Der Rumpf ist konstant und nennt keinen Grund: ob die Kopfzeile
         fehlte, leer war oder schlicht falsch, bleibt dieselbe Antwort. */
      const erwartet = signaturRechnen(adresse, gelesen.felder, token);
      const mitgeschickt = einzelnerKopf(req.headers[KOPF_SIGNATUR]);
      if (!gleich(sha256Hex(mitgeschickt), sha256Hex(erwartet))) {
        return reply.code(403).send({ error: 'Nicht autorisiert.', code: 'fehler.smsAbgelehnt' });
      }

      /* ── Schritt 4: erst NUN der Eimer ─────────────────────────
         Die Reihenfolge ist keine Geschmacksfrage, sondern dieselbe
         Entscheidung wie in posteingang.ts: stünde die Bremse VOR der
         Signaturprüfung, könnte jeder Fremde ohne Token den gemeinsamen Eimer
         leerziehen und echte SMS abschotten — ein DoS mit einer Handvoll
         Anfragen. Nur angenommene Anfragen dürfen den Platz verbrauchen.

         429 ist für Twilio ein Wiederholungsgrund; die Dublettensperre
         (Schritt 6) macht die Wiederholung gefahrlos. */
      if (!eimerZiehen()) {
        return reply.code(429).send({ error: 'Zu viele Anfragen.', code: 'fehler.smsUeberlastet' });
      }

      /* ── Schritt 5/6: Felder prüfen, dann die Datenbank ────────
         Ab hier ist die Anfrage beglaubigt, der INHALT bleibt trotzdem Text
         von Fremden. Alles Weitere in try/catch — keine Ausnahme darf
         ungeklärt bis zu Fastifys Standardbehandlung durchreichen. */
      try {
        /* JETZT kappen, nicht vorher: die Signatur ist gerechnet und bestanden,
           ab hier geht es nur noch darum, was in die Datenbank wandert. */
        const feld = (name: string): string =>
          (gelesen.felder.get(name) ?? '').slice(0, FELD_MAX).trim();
        const von = feld('From');
        const an = feld('To');
        const sid = feld('MessageSid');

        /* Drei Felder MÜSSEN stimmen, sonst entsteht keine Zeile:
           · `From`/`To` als E.164 — sie werden als Adressen gespeichert und
             entscheiden über den Verlauf (services/sms.ts, `verlaufAnker()`).
           · `MessageSid` in Twilios Form — aus ihr entsteht die Message-ID,
             und an ihr hängt der ganze Dublettenschutz. Ein Wert in fremder
             Form ließe `abdruckBilden()` zwar arbeiten, aber mit einer
             Kennung, die niemand wiedererkennt.
           400: eine Anfrage, die diese Prüfung nicht besteht, besteht sie
           auch beim zehnten Versuch nicht. */
        if (!E164.test(von) || !E164.test(an)) {
          return reply.code(400).send({
            error: 'From oder To ist keine Nummer in E.164-Form.', code: 'fehler.smsNummer',
          });
        }
        if (!MESSAGE_SID.test(sid)) {
          return reply.code(400).send({
            error: 'MessageSid hat nicht Twilios Form.', code: 'fehler.smsSid',
          });
        }

        const medienRoh = Number.parseInt(feld('NumMedia'), 10);
        /* Der Rückgabewert wird nicht gebraucht: Twilio bekommt in beiden
           Fällen dieselbe Antwort (siehe darunter), und die Kennung der Zeile
           hat außerhalb der Datenbank keinen Empfänger. */
        eingangAufnehmenSms({
          von, an, text: (gelesen.felder.get('Body') ?? '').slice(0, FELD_MAX), messageSid: sid,
          medien: Number.isFinite(medienRoh) && medienRoh > 0 ? medienRoh : 0,
        });

        /* 200 mit LEEREM TwiML, nicht mit JSON. Twilio liest die Antwort als
           Anweisung: steht dort nichts Verwertbares, protokolliert es eine
           Warnung (Fehler 12300, „Content-Type nicht erlaubt"). Ein leeres
           `<Response/>` heißt genau das Richtige — „angekommen, nichts zu
           tun" — und verhindert insbesondere eine automatische Rückantwort
           an den Absender.

           Auch eine DUBLETTE bekommt 200. Sie ist kein Fehler, den man
           meldet, sondern schon erledigte Arbeit — dieselbe Entscheidung wie
           in posteingang.ts. Genau hier greift die Wiederholungsfestigkeit:
           Twilio stellt nach einer Zeitüberschreitung erneut zu, mit
           derselben `MessageSid`, daraus wird dieselbe Message-ID, daraus
           derselbe Abdruck — und `eingangAufnehmen()` gibt die bestehende
           Zeile zurück, statt eine zweite anzulegen. */
        return reply.code(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      } catch (err) {
        /* Nie den Klartext der SMS protokollieren — nur, dass und woran es
           scheiterte. Verschlüsselt in der Datenbank zu liegen bringt nichts,
           wenn derselbe Inhalt unverschlüsselt im Protokoll landet.

           500 und nicht 400 — der eine Punkt, an dem diese Datei bewusst von
           posteingang.ts abweicht (siehe Dateikopf): Twilio wiederholt
           daraufhin, und die Wiederholung ist dank des Dublettenschutzes
           gefahrlos. Eine SMS, die hier verloren geht, ist sonst weg. */
        const hinweis = err instanceof Error ? err.message : String(err);
        console.error('[sms/eingang] Verarbeitung fehlgeschlagen:', hinweis);
        return reply.code(500).send({
          error: 'Die SMS ließ sich nicht verarbeiten.', code: 'fehler.smsUngueltig',
        });
      }
    });
  });
}
