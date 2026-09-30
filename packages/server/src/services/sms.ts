/**
 * SMS über Twilio — herein und hinaus, im BESTEHENDEN Posteingang.
 *
 * WARUM KEIN ZWEITER NACHRICHTENBEREICH. Eine SMS ist für dieses Haus
 * dasselbe wie eine Mail aus dem abgerufenen Fremdpostfach: Post von außen,
 * die jemand lesen und beantworten soll. Es gibt dafür bereits einen Weg —
 * `post.eingangAufnehmen()` — und an ihm hängt alles, was nicht zweimal
 * gebaut werden darf: die Verschlüsselung in der Datenbank, der
 * wegübergreifende Dublettenschutz (`abdruckBilden()`), der Volltextindex,
 * die Aufbewahrungsfristen, das Archivieren, die Suche. Ein eigener
 * SMS-Bereich hieße, das alles ein zweites Mal zu haben oder gar nicht.
 *
 * WAS EINE SMS NICHT HAT, UND WAS DARAUS FOLGT
 *
 *   · KEINEN BETREFF. Sie geht mit leerem Betreff hinein; die Oberfläche
 *     zeigt dafür längst `post.ohneBetreff` — „(ohne Betreff)". Der Text in
 *     den Betreff zu kopieren wäre die schlechtere Wahl: dann stünde
 *     derselbe Satz zweimal untereinander.
 *
 *   · KEINE ANHÄNGE. `NumMedia` wird gelesen und als Zeile im Text vermerkt
 *     (siehe `textMitMedienhinweis()`), aber es wird nichts geholt. Bilder
 *     einer MMS lägen bei Twilio unter einer Adresse, die ohne Anmeldung
 *     erreichbar ist — sie herunterzuladen wäre eine eigene Aufgabe mit
 *     eigenem Bedrohungsmodell. Verschweigen ist die falsche Alternative:
 *     dann stünde eine Bildnachricht als leere Zeile da.
 *
 *   · KEINE MESSAGE-ID im Sinne von RFC 5322 — aber eine `MessageSid`, die
 *     bei Twilio ebenso eindeutig ist. Aus ihr wird eine formgerechte
 *     Message-ID gebaut (`messageIdAusSid()`), und damit greift derselbe
 *     Dublettenschutz wie bei Mail, ohne dass hier ein zweiter erfunden
 *     werden müsste. Das ist der Kern der Wiederholungsfestigkeit: Twilio
 *     stellt bei Zeitüberschreitung erneut zu, mit DERSELBEN SID.
 *
 * DIE FÄCHER BLEIBEN, WIE SIE SIND. Eine SMS landet in `sonstiges` — das
 * Auffangbecken für Post an eine Adresse, die keinem der acht Fächer
 * entspricht (services/post.ts, `fachPruefen()`). Ein neuntes Fach „sms"
 * anzulegen hieße, es in `FAECHER` einzutragen, und damit böte die
 * Oberfläche `sms@<domaene>` als ABSENDERADRESSE zum Mailschreiben an —
 * eine Adresse, die es nicht gibt. Erkennbar sind SMS über die Spalte
 * `quelle`, genau wie die abgerufene Gmail-Post: ein Schild in der Zeile.
 */
import { db, reindexMail } from '../db/index.js';
import { newId } from '../util/id.js';
import { verschluesseln } from '../crypto/nachrichten.js';
import { eingangAufnehmen, nurAdresse, PostFehler, type EingangRoh } from './post.js';
import { kontoSid, authToken, eigeneNummer, E164 } from './smszugang.js';

/**
 * Wohin der Versand geht.
 *
 * Dieselbe Bauart und derselbe Grund wie `VERSAND_ENDE` in services/post.ts:
 * ohne diese Möglichkeit wäre der einzige Weg, den `senden()` tatsächlich
 * geht, für keinen Prüflauf messbar — entweder man verschickt echte SMS oder
 * man prüft gar nicht. Es ist KEINE Einstellung und steht in keiner
 * Oberfläche; wer sie setzen will, braucht die Umgebung des Serverprozesses.
 * Ohne die Variable gilt unverändert Twilio.
 */
const TWILIO_WURZEL = process.env.TWILIO_ENDE?.trim() || 'https://api.twilio.com';

/** Die Domäne in den erzeugten Message-IDs. `.invalid` ist nach RFC 2606
    dauerhaft für genau diesen Zweck reserviert und wird nie aufgelöst — eine
    erfundene Kennung soll nicht zufällig auf einen echten Rechner zeigen. */
const SMS_DOMAENE = 'sms.twilio.invalid';

/**
 * Twilios Höchstmaß für den Rumpf einer Nachricht. Längeres nimmt die
 * Schnittstelle nicht an.
 *
 * EINGEHEND wird gekappt, AUSGEHEND abgelehnt — und das ist kein
 * Widerspruch, sondern dieselbe Regel wie im ganzen Postfach: was von außen
 * kommt, wird lieber gekürzt zugestellt als verworfen (services/post.ts,
 * `kappen()`); was jemand hier gerade selbst geschrieben hat, soll ihm nicht
 * stillschweigend zur Hälfte abgeschnitten hinausgehen.
 */
const SMS_TEXT_MAX = 1600;

/**
 * Ist das eine Telefonnummer und keine Mailadresse?
 *
 * Diese eine Frage entscheidet in `/api/post/senden`, ob eine Antwort über
 * Twilio oder über den Mailversand geht. Sie darf nie mehrdeutig sein, und
 * sie ist es auch nicht: E.164 verlangt ein führendes „+" und danach nur
 * Ziffern, `EINE_ADRESSE` in post.ts verlangt ein „@" mit Punkt dahinter.
 * Kein Wert erfüllt beides — die Weiche hat keine Mitte.
 */
export function istTelefonnummer(wert: string): boolean {
  return E164.test(wert.trim());
}

/** Aus Twilios `MessageSid` eine formgerechte Message-ID. Sie ist das
    Bindeglied zum bestehenden Dublettenschutz: `abdruckBilden()` in post.ts
    gibt ohne Message-ID `null` zurück und entdublettet dann gar nicht. */
function messageIdAusSid(sid: string): string {
  return `<${sid}@${SMS_DOMAENE}>`;
}

/**
 * Der Verlaufsanker einer SMS-Unterhaltung: eine Kennung je Gegenstelle.
 *
 * WARUM NICHT EIN VERLAUF JE NACHRICHT. Ohne Anker bekäme jede eingehende SMS
 * ihre eigene Message-ID als `thread_id` — dann stünde jede einzelne SMS
 * derselben Person als eigener Verlauf da, und eine Antwort darauf hinge an
 * genau einer davon. Bei Mail ist das richtig (jede Mail ist ein eigener
 * Vorgang, `References` verbindet sie), bei SMS falsch: dort gibt es keine
 * Verlaufskopfzeilen, und eine SMS-Unterhaltung IST die Folge aller
 * Nachrichten mit derselben Nummer.
 *
 * WARUM DAS NICHT ZU FREMDER POST DURCHSCHLÄGT. Der Anker sieht aus wie eine
 * Message-ID und ließe sich als `References` einer Mail behaupten. Er greift
 * trotzdem nicht: `verlaufErlaubt()` in post.ts lässt eine Mail nur dann
 * einem bestehenden Verlauf beitreten, wenn sie `dmarc=pass` trägt UND schon
 * ein Teilnehmer dieses Verlaufs dieselbe Absenderdomäne hat. Die
 * Teilnehmer eines SMS-Verlaufs sind zwei Telefonnummern ohne „@" — keine
 * Mail kann diese Bedingung je erfüllen. Umgekehrt genauso: eine SMS
 * bekommt ihren Verlauf ausschließlich hier zugewiesen, nie aus dem, was der
 * Absender behauptet.
 */
function verlaufAnker(gegenstelle: string): string {
  return `<sms-${gegenstelle.replace(/[^\d]/g, '')}@${SMS_DOMAENE}>`;
}

/** Was Twilio an einer eingehenden SMS mitschickt, soweit es hier zählt. */
export interface SmsEingang {
  /** Absender, E.164. */
  von: string;
  /** Die angerufene eigene Nummer, E.164. */
  an: string;
  text: string;
  messageSid: string;
  /** Anzahl angehängter Medien laut `NumMedia`. Wird NICHT geholt — siehe
      Dateikopf. */
  medien?: number;
}

/**
 * Der Hinweis auf nicht geholte Medien, direkt im Text.
 *
 * Er steht IM TEXT und nicht in einem eigenen Feld, weil es dafür kein Feld
 * gibt, das die Oberfläche zeigen würde — und weil eine Bildnachricht ohne
 * jeden Hinweis als leere Zeile im Posteingang stünde. Deutsch fest
 * verdrahtet ist er trotzdem nicht schön; er ist aber INHALT einer
 * gespeicherten Nachricht, kein Bedienelement, und Inhalt wird in diesem Haus
 * nie nachträglich übersetzt (dieselbe Linie wie bei den Fußzeilen fremder
 * Post, die in der Sprache des Empfängers entstehen und dann feststehen).
 */
function textMitMedienhinweis(text: string, medien: number): string {
  if (medien <= 0) return text;
  const hinweis = `[${medien} Anhang/Anhänge in dieser SMS — Stellium holt Medien nicht ab.]`;
  return text ? `${text}\n\n${hinweis}` : hinweis;
}

/**
 * Eine eingegangene SMS in den Posteingang legen.
 *
 * Sie geht durch `eingangAufnehmen()` wie jede andere Post von außen — jede
 * Grenze, jede Verschlüsselung, jeder Dublettenschutz dort gilt damit auch
 * hier, ohne dass eine Zeile davon zweimal steht. `doppelt: true` heißt: das
 * war eine Wiederholung, es ist keine neue Zeile entstanden.
 */
export function eingangAufnehmenSms(e: SmsEingang): { id: string; doppelt: boolean } {
  const von = e.von.trim();
  const roh: EingangRoh = {
    von,
    an: e.an.trim(),
    /* Leer, nicht der Textanfang — siehe Dateikopf. */
    betreff: '',
    text: textMitMedienhinweis(e.text, e.medien ?? 0).slice(0, SMS_TEXT_MAX),
    messageId: messageIdAusSid(e.messageSid),
    /* KEIN `pruefung`. Das Feld trägt bei Mail das Ergebnis von SPF/DKIM/DMARC
       und entscheidet über `istBestaetigt()`. Für eine SMS gibt es nichts
       Vergleichbares: die einzige Beglaubigung ist die Signatur des Webhooks,
       und die sagt „Twilio hat das geschickt", nicht „die Nummer gehört
       wirklich diesem Absender". Hier `dmarc=pass` einzutragen wäre eine
       Behauptung über den Absender, die niemand geprüft hat. */
  };

  const ergebnis = eingangAufnehmen(roh, undefined, 'sms');

  /* Den Verlauf erst NACH dem Aufnehmen setzen, und nur bei einer wirklich
     neuen Zeile: bei einer Wiederholung gehört die gefundene Zeile schon
     ihrem Verlauf an, und ein zweites UPDATE darauf änderte nichts außer der
     Gewissheit, dass es nichts ändert. */
  if (!ergebnis.doppelt) {
    db.run('UPDATE mail_nachrichten SET thread_id = ? WHERE id = ?', verlaufAnker(von), ergebnis.id);
  }
  return ergebnis;
}

/* ── Hinaus ────────────────────────────────────────────────────── */

export interface SmsAusgang {
  /** Die Gegenstelle, E.164. */
  an: string;
  text: string;
}

/**
 * Twilios Fehlerantworten in Sätze übersetzen, die den Grund WIRKLICH nennen.
 *
 * ZWEI EIGENSCHAFTEN VON DONS KONTO STEHEN HIER AUSDRÜCKLICH DRIN, weil sie
 * kein Fehler dieser Anwendung sind und sich auch nicht wegprogrammieren
 * lassen — man kann sie nur erklärbar machen:
 *
 *   · TRIAL. Ein Twilio-Testkonto darf ausschließlich an Nummern senden, die
 *     vorher in der Twilio-Console verifiziert wurden. Empfangen geht
 *     uneingeschränkt. Twilio meldet das als Code 21608.
 *
 *   · 10DLC. Für SMS an US-Nummern verlangen die amerikanischen Netze eine
 *     Registrierung der Absendernummer (A2P 10DLC). Ohne sie werden
 *     Nachrichten abgewiesen oder still verworfen; Twilio führt das unter
 *     Code 30034.
 *
 * Ohne diese zwei Sätze sähe ein Fehlschlag aus wie ein Programmfehler, und
 * jemand suchte ihn dort, wo er nicht ist. EHRLICH BLEIBT DABEI AUCH: 30034
 * ist bei Twilio in erster Linie ein ZUSTELLZUSTAND und kommt oft erst
 * später über einen Status-Rückruf, nicht schon in der Antwort auf diesen
 * Aufruf — deshalb steht der 10DLC-Hinweis zusätzlich fest in der
 * Oberfläche und hängt nicht allein an diesem Zweig.
 *
 * Alles, was hier nicht aufgeführt ist, geht mit Twilios EIGENEM Wortlaut und
 * seinem Code hinaus statt unter einer selbst erfundenen Sammelmeldung zu
 * verschwinden. Der Rumpf einer Twilio-Fehlerantwort trägt kein Geheimnis:
 * Code, Meldung, ein Verweis auf die Dokumentation.
 */
function twilioFehler(status: number, code: number | null, meldung: string): PostFehler {
  if (code === 21608) {
    return new PostFehler('sms.trialUnverifiziert',
      'Twilio lehnt ab: Das ist ein Trial-Konto — es darf nur an Nummern senden, die vorher in der '
      + 'Twilio-Console verifiziert wurden. Empfangen geht davon unberührt weiter. Entweder die Nummer '
      + `dort verifizieren oder das Konto aufwerten. Twilio (${code}): ${meldung}`, 400);
  }
  if (code === 30034) {
    return new PostFehler('sms.zehnDlcFehlt',
      'Twilio lehnt ab: Für SMS an US-Nummern verlangen die amerikanischen Netze eine '
      + 'A2P-10DLC-Registrierung der Absendernummer. Sie liegt für dieses Konto nicht vor. '
      + `Twilio (${code}): ${meldung}`, 400);
  }
  if (code === 21610) {
    return new PostFehler('sms.abbestellt',
      `Diese Nummer hat den Empfang abbestellt (STOP). Twilio (${code}): ${meldung}`, 400);
  }
  if (code === 21211 || code === 21614) {
    return new PostFehler('sms.zielUngueltig',
      `Twilio kennt diese Nummer nicht als gültiges SMS-Ziel. Twilio (${code}): ${meldung}`, 400);
  }
  if (code === 21606 || code === 21659 || code === 21212) {
    return new PostFehler('sms.absenderUngueltig',
      'Die hinterlegte eigene Nummer gehört nicht zu diesem Twilio-Konto oder kann keine SMS senden. '
      + `Twilio (${code}): ${meldung}`, 400);
  }
  if (status === 401 || status === 403) {
    /* Der Wortlaut von Twilio geht hier ABSICHTLICH nicht mit hinaus: bei
       einer abgelehnten Anmeldung nennt die Meldung mitunter die verwendete
       Konto-Kennung. */
    return new PostFehler('sms.zugangAbgelehnt',
      'Twilio weist die hinterlegten Zugangsdaten ab (Account SID oder Auth Token).', 400);
  }
  if (status === 429) {
    return new PostFehler('sms.rateLimit',
      'Twilio bremst gerade — zu viele Anfragen kurz hintereinander. Gleich noch einmal versuchen.', 429);
  }
  return new PostFehler('sms.abgelehnt',
    `Twilio lehnt ab (${status}${code === null ? '' : `, Code ${code}`}): ${meldung}`, 502);
}

/**
 * Eine SMS hinausschicken — und sie im Posteingang ablegen.
 *
 * Bewusst KEIN Weg über `post.senden()`: dort entsteht die Absenderadresse
 * aus Fach und Maildomäne, dort hängen Fußzeile, HTML-Teil und Anhänge dran,
 * und dort geht es an Resend. Für eine SMS ist von alldem nichts richtig. Was
 * geteilt wird, ist das, was wirklich gemeinsam ist: dieselbe Tabelle,
 * dieselbe Verschlüsselung, derselbe Volltextindex — und darum steht der
 * INSERT unten so nah wie möglich an dem in `post.senden()`.
 */
export async function senden(m: SmsAusgang, userId: string): Promise<{ id: string }> {
  const sid = kontoSid();
  const token = authToken();
  const absender = eigeneNummer();
  if (!sid || !token) {
    throw new PostFehler('sms.keinZugang', 'Es ist kein Twilio-Zugang hinterlegt.', 400);
  }
  if (!E164.test(absender)) {
    throw new PostFehler('sms.keineNummer',
      'Es ist keine eigene Twilio-Nummer hinterlegt (E.164, etwa +15551234567).', 400);
  }

  const empfaenger = nurAdresse(m.an);
  if (!istTelefonnummer(empfaenger)) {
    throw new PostFehler('sms.zielUngueltig',
      'Das ist keine Telefonnummer im Format +49… (E.164).', 400);
  }

  const text = m.text.trim();
  if (!text) throw new PostFehler('sms.textLeer', 'Eine leere SMS lässt sich nicht senden.', 400);
  if (text.length > SMS_TEXT_MAX) {
    /* Ablehnen statt kappen — siehe SMS_TEXT_MAX oben. */
    throw new PostFehler('sms.textZuLang',
      `Eine SMS fasst höchstens ${SMS_TEXT_MAX} Zeichen; dieser Text hat ${text.length}.`, 400);
  }

  const ende = `${TWILIO_WURZEL.replace(/\/+$/, '')}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const antwort = await fetch(ende, {
    method: 'POST',
    headers: {
      /* Basic-Auth aus Konto-Kennung und Auth Token — so verlangt es Twilio.
         `Buffer` statt `btoa()`, weil `btoa` nur Latin-1 kann und ein Token
         mit einem Zeichen darüber hinaus dort mit einer nichtssagenden
         Ausnahme abbräche statt mit einer Antwort von Twilio. */
      authorization: `Basic ${Buffer.from(`${sid}:${token}`, 'utf8').toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: empfaenger, From: absender, Body: text }).toString(),
    signal: AbortSignal.timeout(20_000),
  }).catch((f) => {
    throw new PostFehler('sms.keineVerbindung',
      `Twilio ist nicht erreichbar: ${(f as Error).message}`, 503);
  });

  const rohText = await antwort.text().catch(() => '');
  let code: number | null = null;
  let meldung = rohText.slice(0, 300);
  let twilioSid: string | null = null;
  try {
    const k = JSON.parse(rohText) as { code?: unknown; message?: unknown; sid?: unknown };
    if (typeof k.code === 'number') code = k.code;
    if (typeof k.message === 'string') meldung = k.message.slice(0, 300);
    if (typeof k.sid === 'string') twilioSid = k.sid;
  } catch { /* keine JSON-Antwort — `meldung` bleibt der rohe Text */ }

  if (!antwort.ok) throw twilioFehler(antwort.status, code, meldung);

  /* Auch das Gesendete gehört ins Postfach — sonst sieht man beim nächsten
     Öffnen die Frage, aber nicht die eigene Antwort darauf. Wortgleiche
     Begründung wie in post.senden(); dieselbe Tabelle, dieselben
     verschlüsselten Felder.

     `fach` ist `sonstiges`, weil die eingegangene SMS ebenfalls dort liegt
     (fachPruefen() ordnet eine Telefonnummer keinem der acht Fächer zu) —
     stünde hier etwas anderes, zählte faecher() Frage und Antwort in zwei
     verschiedenen Gruppen.

     `quelle` bleibt `'sms'` auch für die AUSGEHENDE Zeile, obwohl bei Mail
     dort `null` steht. Das ist kein Ausrutscher: `quelle` beantwortet „über
     welchen Weg lief das", und für eine hinausgegangene SMS ist die Antwort
     genauso „Twilio" wie für eine hereingekommene. Ohne das sähe eine
     gesendete SMS im Verlauf aus wie eine Mail. */
  const id = newId('po_');
  db.run(
    `INSERT INTO mail_nachrichten
       (id, fach, richtung, von, an, betreff, text, html,
        message_id, referenzen, thread_id, quelle, am, gelesen, anhaenge)
     VALUES (?,?,'aus',?,?,?,?,NULL,?,NULL,?,'sms',?,1,?)`,
    id, 'sonstiges',
    verschluesseln(absender), verschluesseln(empfaenger),
    verschluesseln(''), verschluesseln(text),
    twilioSid ? messageIdAusSid(twilioSid) : null,
    /* Derselbe Anker wie beim Eingang: die Antwort steht damit im selben
       Verlauf wie die SMS, auf die sie antwortet — auch dann, wenn seither
       weitere SMS derselben Nummer eingetroffen sind. */
    verlaufAnker(empfaenger),
    Date.now(),
    /* Eine SMS trägt keine Anhänge (siehe Dateikopf) — die leere Liste steht
       trotzdem verschlüsselt da, damit `anhaengeAuspacken()` in post.ts auf
       dieselbe Form trifft wie bei jeder anderen Zeile. */
    verschluesseln('[]'),
  );

  /* Auch das Gesendete muss sich wiederfinden lassen — dieselbe Regel wie
     beim Eingang. */
  reindexMail(id);

  /* WER wann eine SMS geschickt hat, gehört ins Protokoll; WOHIN und WAS
     nicht. Eine Telefonnummer ist ein personenbezogenes Datum, und der Text
     liegt aus gutem Grund verschlüsselt in der Datenbank — beides gehörte
     hier im Klartext ins Systemprotokoll. */
  console.log(`[sms] Eine SMS über Twilio verschickt (von ${userId}).`);

  return { id };
}
