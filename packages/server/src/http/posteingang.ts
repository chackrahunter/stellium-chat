/**
 * Der Türsteher für eingehende Post — Gegenstück zu
 * server-setup/postfach/worker/src/index.ts. Der Worker läuft bei
 * Cloudflare, zerlegt eine eingegangene Mail dort und schickt das Ergebnis
 * als JSON über den bestehenden Tunnel hierher.
 *
 * Diese Route hängt öffentlich am Tunnel und nimmt Inhalt von Fremden
 * entgegen — jede Zeile hier gehört zur Angriffsfläche. Die Reihenfolge der
 * Prüfungen unten stammt aus einem Bedrohungsmodell und folgt zwei Regeln:
 *
 *   · billig vor teuer — eine Flut soll möglichst wenig kosten, bevor sie
 *     abgewiesen wird. Erst der zwischengespeicherte Blick auf das
 *     Geheimnis, dann die Ratenbremse, dann erst Kryptografie, dann erst die
 *     Feldprüfung, erst ganz am Ende die Datenbank (in post.ts).
 *
 *   · keine Ausnahme darf ungeklärt zu einem 500 werden — beim Worker heißt
 *     ein Fehlschlag: die Mail geht nach drei Versuchen an ein privates
 *     Ersatzpostfach statt in die verschlüsselte Datenbank (siehe dort,
 *     RUECKFALL_ADRESSE). 5xx und 429 sind für den Worker "versuch's
 *     nochmal", jedes andere 4xx ist "verstanden und endgültig abgelehnt,
 *     nicht weiterleiten". Jeder Statuscode hier unten ist genau mit dieser
 *     Unterscheidung gewählt — deshalb z. B. 503 (nicht 400) für ein
 *     fehlendes Geheimnis, und 200 (nie 409) für eine Dublette: eine
 *     Dublette ist kein Fehler, den man dem Worker meldet, sondern schon
 *     erledigte Arbeit.
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eingangAufnehmen, type EingangRoh } from '../services/post.js';
import { eingangGeheimnis } from '../services/mailzugang.js';
import { gleich } from '../crypto/vertraulich.js';
import { sichtungAnstossen } from '../services/post-sichtung.js';

/** Kopfzeilen, wie der Worker sie mitschickt (dort Zeile ~123–127). */
const KOPF_GEHEIMNIS = 'x-stellium-eingang';
const KOPF_SCHLUESSEL = 'x-stellium-schluessel';

/* Das globale bodyLimit in index.ts liegt bei 2 MiB — für jede andere Route
   reicht das. Diese hier bekommt Anhänge mit: der Worker erlaubt bis zu
   5 MiB Anhänge zusammen (server-setup/postfach/worker/src/index.ts,
   ANHAENGE_MAX_GESAMT), base64 kodiert das rund ein Drittel größer, dazu
   kommen Text, HTML und das JSON drumherum. 8 MiB lassen davon reichlich
   Luft, ohne die Grenze bedeutungslos weit zu öffnen. */
const EINGANG_BODY_LIMIT = 8 * 1024 * 1024;

/* ── Feldgrößen (Schritt 4) ────────────────────────────────────────
   Kappen statt ablehnen: eine echte, große Mail soll ankommen. Ablehnen
   hieße, der Worker leitet sie nach drei Versuchen an das private
   Ersatzpostfach weiter — genau das soll die Ausnahme bleiben, nicht die
   Antwort auf eine lange Signatur oder einen dicken Anhang. post.ts kappt
   dieselben Felder im Anschluss selbst noch einmal auf dieselben Maße; das
   hier ist die billige Vorstufe, bevor post.ts mit Regex und Verschlüsselung
   anfängt. */
const BETREFF_MAX = 998;
const TEXT_MAX = 1024 * 1024;
const HTML_MAX = 4 * 1024 * 1024;
const REFERENZEN_MAX = 2 * 1024;
const MESSAGE_ID_MAX = 250;
const ANHAENGE_MAX = 25;
/** Ein Zustellschlüssel ist ein SHA-256 als base64url — 43 Zeichen. Alles
    darüber ist ohnehin ungültig und findet nie eine Zeile; gedeckelt wird
    trotzdem, damit kein beliebig langer Wert in der indizierten Spalte
    landet. */
const SCHLUESSEL_MAX = 200;

function sha256Hex(wert: string): string {
  return crypto.createHash('sha256').update(wert, 'utf8').digest('hex');
}

/** Eine einzelne Kopfzeile als String — nie als Liste. Für einen eigenen
    Namen wie diesen fasst Node mehrfach gesendete Kopfzeilen ohnehin
    zusammen (nur wenige feste Namen wie set-cookie werden zur Liste); der
    Fall wird trotzdem abgefangen und zählt als "nichts Eindeutiges", nicht
    als Zufallstreffer auf den ersten Eintrag. */
function einzelnerKopf(wert: string | string[] | undefined): string {
  return typeof wert === 'string' ? wert : '';
}

/* ── Schritt 1: das Geheimnis, zwischengespeichert ────────────────
 *
 * eingangGeheimnis() entschlüsselt bei jedem Aufruf neu über den
 * Feldschlüssel — für eine Handvoll Aufrufe unerheblich, für eine Flut
 * unnötige Arbeit auf SQLite. Zwischengespeichert wird der DIGEST und nicht
 * der Klartext: ein Geheimnis, das minutenlang im Speicher dieses Prozesses
 * steht, ist ein unnötiges Risiko, wenn Schritt 3 unten ohnehin nur den
 * Digest braucht.
 *
 * 30 Sekunden: kurz genug, dass ein frisch eingerichteter oder gelöschter
 * Zugang zügig wirkt, lang genug, dass eine Flut die Datenbank nicht hämmert.
 */
const GEHEIMNIS_CACHE_MS = 30_000;
let geheimnisCache: { digest: string | null; bis: number } | null = null;

function geheimnisDigestGecacht(): string | null {
  const jetzt = Date.now();
  if (geheimnisCache && geheimnisCache.bis > jetzt) return geheimnisCache.digest;

  const klartext = eingangGeheimnis();
  const digest = klartext ? sha256Hex(klartext) : null;
  if (!digest) {
    /* Laut protokollieren: der Worker versucht es drei Mal gegen 503 und
       leitet die Mail danach an das private Ersatzpostfach weiter — leise,
       denn dort sieht sie niemand außer wer es eingerichtet hat. Steht hier
       und nicht in jeder einzelnen Anfrage, weil der Zwischenspeicher oben
       dafür sorgt, dass dieser Zweig höchstens alle 30 Sekunden läuft, auch
       mitten in einer Flut. */
    console.error('[post/eingang] kein Eingangsgeheimnis eingerichtet — Post wird abgewiesen (fail closed)');
  }
  geheimnisCache = { digest, bis: jetzt + GEHEIMNIS_CACHE_MS };
  return digest;
}

/* ── Schritt 2: eine einzige, globale Ratenbremse ─────────────────
 *
 * Nicht nach Herkunft, wie die Anmeldebremse in routes.ts (die
 * `versuche`-Map) es für den Login tut: Fastify läuft hier ohne trustProxy
 * hinter cloudflared, und req.ip ist für JEDE Anfrage von außen 127.0.0.1 —
 * der Tunnel, nicht der wahre Absender. Eine Bremse "je Herkunft" liefe
 * damit in Wahrheit auf einen einzigen gemeinsamen Schlüssel hinaus, nur
 * mit dem Umweg über eine Map, die dafür keinen Sinn mehr ergibt. Ein
 * simpler, globaler Token-Eimer sagt dasselbe direkter.
 */
const EIMER_GROESSE = 30; // Anfragen, die sich aufstauen dürfen
const EIMER_PRO_SEKUNDE = 1; // Nachfüllrate danach
let eimerStand = EIMER_GROESSE;
let eimerLetzterStand = Date.now();

/** Zieht ein Zeichen aus dem Eimer. `false` heißt: abweisen, bevor
    überhaupt Kryptografie läuft. */
function eimerZiehen(): boolean {
  const jetzt = Date.now();
  const vergangeneSekunden = (jetzt - eimerLetzterStand) / 1000;
  eimerLetzterStand = jetzt;
  eimerStand = Math.min(EIMER_GROESSE, eimerStand + vergangeneSekunden * EIMER_PRO_SEKUNDE);
  if (eimerStand < 1) return false;
  eimerStand -= 1;
  return true;
}

/* ── Schritt 4/5: Größen kappen, dann Typen prüfen ────────────────
 *
 * Reihenfolge bewusst: Ein .slice() kostet nichts, egal wie lang der Rumpf
 * war — das läuft zuerst. Der Typ-Blick danach ist zwar auch billig, bei
 * anhaenge aber schon eine Schleife über die Liste; die soll nicht auf
 * einem beliebig langen String laufen, wenn ein einziges .slice() das
 * vorher verhindert.
 *
 * post.ts prüft im Anschluss selbst noch einmal nach (kappen(),
 * messageIdPruefen(), referenzenPruefen() …) — das hier ersetzt das nicht,
 * sondern kommt davor: eine grobe, billige Vorsortierung, die verhindert,
 * dass ein falscher Typ tief in post.ts auf einen Feldzugriff trifft, den
 * dort niemand abfängt.
 */
function eingangFelderPruefen(
  roh: Record<string, unknown>,
): { ok: true; wert: EingangRoh } | { ok: false; hinweis: string } {
  const kappen = (wert: unknown, max: number): unknown => (typeof wert === 'string' ? wert.slice(0, max) : wert);

  const gekappt: Record<string, unknown> = {
    ...roh,
    betreff: kappen(roh.betreff, BETREFF_MAX),
    text: kappen(roh.text, TEXT_MAX),
    html: kappen(roh.html, HTML_MAX),
    referenzen: kappen(roh.referenzen, REFERENZEN_MAX),
    messageId: kappen(roh.messageId, MESSAGE_ID_MAX),
    anhaenge: Array.isArray(roh.anhaenge) ? roh.anhaenge.slice(0, ANHAENGE_MAX) : roh.anhaenge,
  };

  /* Freitextfelder: dürfen fehlen oder null sein, aber wenn sie da sind,
     müssen es Strings sein. Ein Objekt oder eine Zahl würde in post.ts an
     jeder Stelle still zu '' oder null (die dortigen typeof-Prüfungen) —
     das ließe eine fehlerhafte Anfrage klaglos durchlaufen, statt sie mit
     einer eigenen Kennung zu melden. */
  const textfelder = [
    'an', 'von', 'vonName', 'umschlagVon', 'antwortAn',
    'betreff', 'text', 'html', 'messageId', 'referenzen', 'pruefung',
  ] as const;
  for (const feld of textfelder) {
    const wert = gekappt[feld];
    if (wert !== undefined && wert !== null && typeof wert !== 'string') {
      return { ok: false, hinweis: `Feld "${feld}" hat den falschen Typ.` };
    }
  }

  if (gekappt.am !== undefined && typeof gekappt.am !== 'number') {
    return { ok: false, hinweis: 'Feld "am" hat den falschen Typ.' };
  }

  if (gekappt.anhaenge !== undefined) {
    if (!Array.isArray(gekappt.anhaenge)) {
      return { ok: false, hinweis: 'Feld "anhaenge" ist keine Liste.' };
    }
    /* post.ts liest von jedem Eintrag direkt x.name, x.typ, x.groesse —
       ein `null` in der Liste bräche dort mit "Cannot read properties of
       null" ab, eine Ausnahme, die post.ts nicht kennt und nicht abfängt.
       Deshalb hier: jeder Eintrag muss ein Objekt sein, das kein Array ist. */
    for (const eintrag of gekappt.anhaenge) {
      if (typeof eintrag !== 'object' || eintrag === null || Array.isArray(eintrag)) {
        return { ok: false, hinweis: 'Ein Eintrag in "anhaenge" ist kein Objekt.' };
      }
    }
  }

  return { ok: true, wert: gekappt as EingangRoh };
}

/**
 * Registriert `POST /api/post/eingang`. Aufgerufen aus routes.ts, direkt
 * neben den übrigen Postfach-Routen — anders als diese aber ohne
 * `requireUser`/`requirePermission`: der Nachweis ist hier das geteilte
 * Geheimnis mit dem Worker, kein angemeldetes Konto.
 */
export function registerPostEingang(app: FastifyInstance): void {
  app.post('/api/post/eingang', { bodyLimit: EINGANG_BODY_LIMIT }, async (req, reply) => {
    /* Schritt 1 — fail closed.
       ACHTUNG, die Falle an genau dieser Stelle: ein naheliegendes
       `if (geheimnis && kopfWert !== geheimnis) return 401` läuft am
       Vergleich komplett vorbei, sobald `geheimnis` leer ist — die
       `&&`-Kurzschluss überspringt dann die ganze Prüfung, und der
       Endpunkt nimmt jeden Wert an. Genau das passiert, wenn der
       Schlüsselbund klemmt: decryptField() liefert dann einen leeren
       String zurück, keinen Fehler, keine Ausnahme. Deshalb hier zwei
       GETRENNTE Zweige: erst "gibt es überhaupt eins" (dieser Block),
       danach — nur wenn ja — "stimmt es überein" (Schritt 3). */
    const erwarteterDigest = geheimnisDigestGecacht();
    if (!erwarteterDigest) {
      return reply.code(503).send({
        error: 'Der Posteingang ist nicht eingerichtet.',
        code: 'fehler.eingangNichtEingerichtet',
      });
    }

    /* Schritt 2 — vor jeder Kryptografie, damit eine Flut möglichst wenig
       kostet. */
    if (!eimerZiehen()) {
      return reply.code(429).send({ error: 'Zu viele Anfragen.', code: 'fehler.eingangUeberlastet' });
    }

    /* Schritt 3 — zeitunabhängig, über SHA-256-Digests statt über die
       Rohwerte: so sind die verglichenen Längen immer gleich (64 Zeichen),
       egal wie lang das echte Geheimnis oder der mitgeschickte Wert war.
       gleich() selbst bricht bei unterschiedlicher Länge sofort ab, bevor
       timingSafeEqual überhaupt läuft — über den Rohwert verglichen wäre
       das schon ein kleiner Zeit-Hinweis auf die Länge des echten
       Geheimnisses. Über den Digest verschwindet dieser Hinweis. */
    const mitgeschickterDigest = sha256Hex(einzelnerKopf(req.headers[KOPF_GEHEIMNIS]));
    if (!gleich(mitgeschickterDigest, erwarteterDigest)) {
      // Konstanter Rumpf, ohne Hinweis worauf — egal ob die Kopfzeile
      // fehlte, leer war oder schlicht falsch: immer dieselbe Antwort.
      return reply.code(401).send({ error: 'Nicht autorisiert.', code: 'fehler.eingangAbgelehnt' });
    }

    /* Schritt 4/5/6 — ab hier ist die Anfrage legitim (das Geheimnis
       stimmte), aber der INHALT bleibt Text von Fremden. Alles Weitere in
       try/catch: keine Ausnahme darf ungeklärt bis zu Fastifys
       Standard-Fehlerbehandlung durchreichen und dort zu einem
       unbeschrifteten 500 werden — siehe Dateikopf, warum das beim Worker
       den Unterschied zwischen verschlüsselter Datenbank und privatem
       Ersatzpostfach macht. */
    try {
      const roh = req.body;
      if (!roh || typeof roh !== 'object' || Array.isArray(roh)) {
        return reply.code(400).send({ error: 'Der Rumpf ist kein JSON-Objekt.', code: 'fehler.eingangKoerper' });
      }

      const geprueft = eingangFelderPruefen(roh as Record<string, unknown>);
      if (!geprueft.ok) {
        return reply.code(400).send({ error: geprueft.hinweis, code: 'fehler.eingangFeldTyp' });
      }

      const zustellSchluessel = einzelnerKopf(req.headers[KOPF_SCHLUESSEL]).slice(0, SCHLUESSEL_MAX) || undefined;
      const { id, doppelt } = eingangAufnehmen(geprueft.wert, zustellSchluessel);

      /* Die KI-Sichtung (services/post-sichtung.ts) läuft NACH dieser
         Antwort an — nie in diesem Aufruf. Ein Modellaufruf blockiert die
         Ereignisschleife des Pi für Sekunden (dieselbe Art Blockade wie bei
         der Blockspeicher-Zerlegung in routes.ts, dort mit Zahlen belegt),
         und genau diese Ereignisschleife bedient nebenbei jeden offenen
         Chat. Der Worker wartet zudem nur zehn Sekunden auf diese Antwort
         (AbortSignal.timeout(10_000)) — ein hängender Modellaufruf träfe
         also nicht nur den Chat, sondern ließe den Worker in seinen eigenen
         Timeout laufen und die Mail ein zweites Mal verschicken.

         `sichtungAnstossen()` bringt selbst schon einen kleinen Puffer mit
         (siehe dort) — der wettet aber auf einen festen Zeitabstand.
         Zuverlässiger ist das tatsächliche Ereignis: `reply.raw` ist der
         rohe Node-`ServerResponse` hinter dieser Antwort, sein `finish`
         feuert genau dann, wenn sie wirklich hinausgegangen ist, nicht
         ungefähr 250ms später. Das ist dieselbe Zusicherung, die ein
         Fastify-`onResponse`-Haken böte — hier aber ohne den Umweg, die
         Mail-Kennung erst über die ganze Anfrage hinweg zwischenzulagern:
         der Zuhörer entsteht direkt dort, wo `id` schon feststeht, und ist
         mit der Anfrage selbst wieder weg, egal ob sie glückt oder
         abbricht. Bei einem doppelt gemeldeten Eingang ist die Mail schon
         gesichtet (oder wird es gerade) — hier also nichts Neues anstoßen. */
      if (!doppelt) reply.raw.once('finish', () => sichtungAnstossen(id));
      return reply.code(200).send({ id, doppelt });
    } catch (err) {
      // Nie den Klartext der Mail protokollieren — nur, dass und woran es
      // scheiterte. Verschlüsselt in der Datenbank zu liegen bringt nichts,
      // wenn derselbe Inhalt unverschlüsselt im Protokoll landet.
      const hinweis = err instanceof Error ? err.message : String(err);
      console.error('[post/eingang] Verarbeitung fehlgeschlagen:', hinweis);
      return reply.code(400).send({ error: 'Die Post ließ sich nicht verarbeiten.', code: 'fehler.eingangUngueltig' });
    }
  });
}
