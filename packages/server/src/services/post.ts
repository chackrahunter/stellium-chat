/**
 * Das Unternehmenspostfach.
 *
 * Anders als beim Chat liegt hier die Post SELBST in der Datenbank, nicht nur
 * ein Verweis darauf. Das ist der Unterschied zum ersten Entwurf über Gmail:
 * dort blieb die Nachricht bei Google und wurde bei Bedarf geholt. Jetzt
 * nimmt Cloudflare sie an, ein Worker zerlegt sie und schickt sie einmal
 * hierher — danach gibt es sie nirgends sonst. Wer sie nicht aufhebt,
 * verliert sie.
 *
 * Verschlüsselt wie Chatnachrichten, aus demselben Grund: das ist
 * Schriftwechsel mit Kunden und Fremden. Wer die Datenbankdatei in die Hand
 * bekommt, soll ihn nicht lesen können.
 *
 * Die Ordner der Oberfläche entstehen aus dem `fach` — also aus der Adresse,
 * an die geschrieben wurde. `support@` und `billing@` landen im selben
 * Postfach und sind trotzdem getrennt zu lesen.
 */
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { verschluesseln, entschluesseln } from '../crypto/nachrichten.js';
import { zugangLesen } from './mailzugang.js';

const VERSAND_ENDE = 'https://api.resend.com/emails';

export class PostFehler extends Error {
  constructor(public code: string, nachricht: string, public status = 502) {
    super(nachricht);
  }
}

export interface Nachricht {
  id: string;
  fach: string;
  richtung: 'ein' | 'aus';
  von: string;
  an: string;
  betreff: string;
  text: string;
  html: string | null;
  messageId: string | null;
  referenzen: string | null;
  threadId: string | null;
  am: number;
  gelesen: boolean;
  anhaenge: Array<{ name: string; typ: string; groesse: number }>;
}

interface Zeile {
  id: string; fach: string; richtung: string; von: string; an: string;
  betreff: string; text: string; html: string | null; message_id: string | null;
  referenzen: string | null; thread_id: string | null; am: number;
  gelesen: number; anhaenge: string | null;
}

function auspacken(z: Zeile): Nachricht {
  return {
    id: z.id,
    fach: z.fach,
    richtung: z.richtung === 'aus' ? 'aus' : 'ein',
    von: entschluesseln(z.von),
    an: entschluesseln(z.an),
    betreff: entschluesseln(z.betreff),
    text: entschluesseln(z.text),
    html: z.html ? entschluesseln(z.html) : null,
    messageId: z.message_id,
    referenzen: z.referenzen,
    threadId: z.thread_id,
    am: z.am,
    gelesen: z.gelesen === 1,
    anhaenge: z.anhaenge ? JSON.parse(z.anhaenge) : [],
  };
}

/* ── Eingang ───────────────────────────────────────────────────
 *
 * Alles hier drin kommt von Fremden. Geprüft wird deshalb IM DIENST und
 * nicht in der Route: eine zweite Stelle, die später einliest (ein Import,
 * ein Prüflauf, eine Wiedereinspielung), käme sonst an der Prüfung vorbei.
 */

/** Die Fächer, die es wirklich gibt. Alles andere landet in `sonstiges`. */
export const FAECHER = [
  'info', 'support', 'billing', 'sales', 'security', 'privacy', 'abuse', 'jobs',
] as const;
const FACH_SONST = 'sonstiges';

/* Eine Message-ID ist ein sehr enges Format. Sie ungeprüft zu übernehmen
   hieße, sie später ungeprüft in eine ausgehende Kopfzeile zu schreiben —
   und dann hängt an der freigegebenen Antwort ein `Bcc:` des Absenders. Die
   Prüfung gehört an den EINGANG: danach ist jeder spätere Aufrufer von
   `senden()` automatisch sauber. */
const MESSAGE_ID = /^<[^\s<>@]{1,120}@[^\s<>@]{1,120}>$/;

function messageIdPruefen(wert: unknown): string | null {
  if (typeof wert !== 'string') return null;
  const w = wert.trim();
  return MESSAGE_ID.test(w) ? w : null;
}

function referenzenPruefen(wert: unknown): string | null {
  if (typeof wert !== 'string') return null;
  const gut = wert.trim().split(/\s+/).filter((s) => MESSAGE_ID.test(s)).slice(0, 20);
  return gut.length ? gut.join(' ') : null;
}

/** Aus „Vorname Nachname <adresse@example.com>" die nackte Adresse. */
export function nurAdresse(wert: string): string {
  const spitz = /<([^>]+)>/.exec(wert);
  return (spitz ? spitz[1] : wert).trim().toLowerCase();
}

function fachPruefen(an: unknown): string {
  if (typeof an !== 'string') return FACH_SONST;
  const lokal = nurAdresse(an).split('@')[0];
  return (FAECHER as readonly string[]).includes(lokal) ? lokal : FACH_SONST;
}

/* Text auf ein erträgliches Maß bringen, statt die Mail abzulehnen. Ablehnen
   hieße beim Worker: Weiterleiten an ein Privatpostfach. Lieber gekürzt
   zustellen als vollständig verlieren. */
function kappen(wert: unknown, max: number): string {
  return typeof wert === 'string' ? wert.slice(0, max) : '';
}

export interface EingangRoh {
  an?: unknown; von?: unknown; vonName?: unknown; umschlagVon?: unknown;
  antwortAn?: unknown; betreff?: unknown; text?: unknown; html?: unknown;
  messageId?: unknown; referenzen?: unknown; pruefung?: unknown; am?: unknown;
  anhaenge?: unknown;
}

/**
 * Ob eine Mail einem bestehenden Verlauf beitreten darf.
 *
 * Nicht behaupten, sondern prüfen. Eine `thread_id` ist eine Message-ID —
 * die kennt jeder, der je eine Mail von uns bekommen hat. Wer sie in seine
 * `References` schreibt, hängt sich sonst in einen fremden Verlauf, und die
 * KI bekommt beim Entwurf echten internen Schriftwechsel zu sehen. Der
 * Mensch, der freigibt, sieht einen zusammenhängenden Verlauf und nickt ihn
 * ab.
 *
 * Beitreten darf nur, wer schon Teilnehmer ist — und nur, wenn der Absender
 * bestätigt wurde.
 */
function verlaufErlaubt(threadId: string, absender: string, bestaetigt: boolean): boolean {
  if (!bestaetigt) return false;
  const domaene = absender.split('@')[1];
  if (!domaene) return false;
  const teilnehmer = db.all<{ von: string; an: string }>(
    'SELECT von, an FROM mail_nachrichten WHERE thread_id = ? LIMIT 50', threadId);
  if (!teilnehmer.length) return false;
  return teilnehmer.some((z) => entschluesseln(z.von).toLowerCase().endsWith(`@${domaene}`)
    || entschluesseln(z.an).toLowerCase().endsWith(`@${domaene}`));
}

/** Hat Cloudflare den Absender bestätigt? Signal, keine Sperre. */
function istBestaetigt(pruefung: unknown): boolean {
  return typeof pruefung === 'string' && /dmarc=pass/i.test(pruefung);
}

export function eingangAufnehmen(roh: EingangRoh, zustellSchluessel?: string):
{ id: string; doppelt: boolean } {
  /* Idempotenz am Zustellschlüssel des Workers, nicht an der Message-ID des
     Absenders. Der eindeutige Index in der Datenbank ist die eigentliche
     Sperre; diese Abfrage erspart nur die Ausnahme im Normalfall. */
  if (zustellSchluessel) {
    const da = db.get<{ id: string }>(
      'SELECT id FROM mail_nachrichten WHERE zustell_schluessel = ? LIMIT 1', zustellSchluessel);
    if (da) return { id: da.id, doppelt: true };
  }

  const von = nurAdresse(kappen(roh.von, 320));
  const bestaetigt = istBestaetigt(roh.pruefung);
  const messageId = messageIdPruefen(roh.messageId);
  const referenzen = referenzenPruefen(roh.referenzen);

  /* Zeit klemmen. Ein Wert nahe MAX_SAFE_INTEGER heftete die Nachricht wegen
     `ORDER BY am DESC` dauerhaft an die Spitze und zerstörte das
     Weiterblättern. */
  const jetzt = Date.now();
  const roheZeit = typeof roh.am === 'number' && Number.isFinite(roh.am) ? roh.am : jetzt;
  const am = Math.min(Math.max(roheZeit, jetzt - 30 * 86400_000), jetzt + 5 * 60_000);

  const ersteRef = referenzen?.split(' ')[0] ?? null;
  const threadId = ersteRef && verlaufErlaubt(ersteRef, von, bestaetigt) ? ersteRef : messageId;

  const anhaenge = Array.isArray(roh.anhaenge) ? roh.anhaenge.slice(0, 25) : [];
  const id = newId('po_');

  db.run(
    `INSERT INTO mail_nachrichten
       (id, fach, richtung, von, an, betreff, text, html,
        message_id, referenzen, thread_id, umschlag_von, antwort_an, pruefung,
        zustell_schluessel, am, gelesen, anhaenge)
     VALUES (?,?,'ein',?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    id, fachPruefen(roh.an),
    verschluesseln(von), verschluesseln(nurAdresse(kappen(roh.an, 320))),
    verschluesseln(kappen(roh.betreff, 998)), verschluesseln(kappen(roh.text, 1024 * 1024)),
    roh.html ? verschluesseln(kappen(roh.html, 4 * 1024 * 1024)) : null,
    messageId, referenzen, threadId,
    verschluesseln(nurAdresse(kappen(roh.umschlagVon, 320))),
    roh.antwortAn ? verschluesseln(nurAdresse(kappen(roh.antwortAn, 320))) : null,
    kappen(roh.pruefung, 2000) || null,
    zustellSchluessel ?? null,
    am,
    /* Nur die Beschreibung der Anhänge, nicht ihr Inhalt. */
    JSON.stringify(anhaenge.map((a) => {
      const x = a as { name?: unknown; typ?: unknown; groesse?: unknown; uebergross?: unknown };
      return {
        name: kappen(x.name, 200) || 'ohne-namen',
        typ: kappen(x.typ, 120) || 'application/octet-stream',
        groesse: typeof x.groesse === 'number' ? x.groesse : 0,
        uebergross: x.uebergross === true,
      };
    })),
  );

  /* Aus dem Text lernen, welche Sprache dieser Briefpartner spricht — hier
     beim Eintreffen, nicht erst beim Antworten. Sonst hinge es davon ab, ob
     jemand antwortet, und die nächste Rechnung ginge wieder auf Englisch
     hinaus. */
  spracheLernen(von, kappen(roh.text, 4000));

  return { id, doppelt: false };
}

/* ── Ausgang ─────────────────────────────────────────────────── */

export interface Ausgang {
  /** Aus welchem Fach geschrieben wird — bestimmt die Absenderadresse. */
  fach?: string;
  /* Die Sprache steht am Briefpartner, nicht an dieser Nachricht — wer sie
     braucht, holt sie über `spracheFuer(empfaenger)`. Sie hier noch einmal
     mitzugeben hieße, zwei Quellen für dieselbe Angabe zu haben. */
  an: string;
  betreff: string;
  text: string;
  /** Für eine Antwort: die Kennungen der Ursprungsnachricht. */
  antwortAuf?: { messageId: string | null; referenzen: string | null; threadId: string | null };
}

export async function senden(m: Ausgang): Promise<{ id: string }> {
  const z = zugangLesen();
  if (!z) throw new PostFehler('post.nichtEingerichtet', 'Kein Versandweg hinterlegt.', 400);

  /* Aus dem Fach antworten, in dem die Frage ankam: wer an `support@`
     schreibt, soll die Antwort von `support@` bekommen und nicht von
     `info@`. Fehlt das Fach, gilt die hinterlegte Standardadresse. */
  const absender = m.fach && m.fach.includes('@') ? m.fach : z.absender;

  const kopf: Record<string, string> = {};
  if (m.antwortAuf?.messageId) {
    /* Ohne diese beiden Zeilen ist eine Antwort keine Antwort, sondern eine
       neue Nachricht mit „Re:" davor: Mailprogramme hängen den Verlauf an
       `In-Reply-To` und `References` auf, nicht am Betreff. */
    kopf['In-Reply-To'] = m.antwortAuf.messageId;
    kopf.References = m.antwortAuf.referenzen
      ? `${m.antwortAuf.referenzen} ${m.antwortAuf.messageId}`
      : m.antwortAuf.messageId;
  }

  const antwort = await fetch(VERSAND_ENDE, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${z.versandSchluessel}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `${z.name} <${absender}>`,
      to: [m.an],
      subject: m.betreff,
      text: m.text,
      ...(Object.keys(kopf).length ? { headers: kopf } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch((f) => {
    throw new PostFehler('post.keineVerbindung',
      `Der Versanddienst ist nicht erreichbar: ${(f as Error).message}`, 503);
  });

  if (!antwort.ok) {
    /* Der Text des Dienstes enthält kein Geheimnis, wird aber gekürzt: eine
       Fehlermeldung ist keine Protokolldatei. */
    const grund = (await antwort.text().catch(() => '')).slice(0, 200);
    if (antwort.status === 401 || antwort.status === 403) {
      throw new PostFehler('post.schluesselAbgelehnt',
        'Der hinterlegte Versandschlüssel gilt nicht mehr.', 400);
    }
    throw new PostFehler('post.abgelehnt',
      `Der Versanddienst lehnt ab (${antwort.status}). ${grund}`, 502);
  }

  const d = await antwort.json() as { id?: string };

  /* Auch das Gesendete gehört ins Postfach — sonst sieht man beim nächsten
     Öffnen die Frage, aber nicht die eigene Antwort darauf. */
  const id = newId('po_');
  db.run(
    `INSERT INTO mail_nachrichten
       (id, fach, richtung, von, an, betreff, text, html,
        message_id, referenzen, thread_id, am, gelesen, anhaenge)
     VALUES (?,?,'aus',?,?,?,?,NULL,?,?,?,?,1,'[]')`,
    id, absender.toLowerCase(),
    verschluesseln(absender), verschluesseln(m.an),
    verschluesseln(m.betreff), verschluesseln(m.text),
    d.id ?? null, kopf.References ?? null,
    m.antwortAuf?.threadId ?? d.id ?? null,
    Date.now(),
  );
  return { id };
}

/* ── Lesen ─────────────────────────────────────────────────── */

/** Die Ordner mit ihren Zählständen — daraus entsteht die Seitenleiste. */
export function faecher(): Array<{ fach: string; gesamt: number; ungelesen: number }> {
  return db.all<{ fach: string; gesamt: number; ungelesen: number }>(
    `SELECT fach,
            COUNT(*) AS gesamt,
            SUM(CASE WHEN gelesen = 0 AND richtung = 'ein' THEN 1 ELSE 0 END) AS ungelesen
       FROM mail_nachrichten
      GROUP BY fach
      ORDER BY fach`);
}

export function liste(fach: string | null, anzahl = 50, vor?: number): Nachricht[] {
  /* Im Dienst deckeln, nicht erst in der Route: ein zweiter Aufrufer käme
     sonst daran vorbei und holte beliebig viele Zeilen — jede davon wird
     entschlüsselt. */
  anzahl = Math.min(Math.max(1, Math.trunc(anzahl) || 50), 200);
  const zeilen = fach
    ? db.all<Zeile>(
      `SELECT * FROM mail_nachrichten WHERE fach = ? AND am < ?
        ORDER BY am DESC LIMIT ?`, fach, vor ?? Number.MAX_SAFE_INTEGER, anzahl)
    : db.all<Zeile>(
      `SELECT * FROM mail_nachrichten WHERE am < ?
        ORDER BY am DESC LIMIT ?`, vor ?? Number.MAX_SAFE_INTEGER, anzahl);
  return zeilen.map(auspacken);
}

export function nachricht(id: string): Nachricht | null {
  const z = db.get<Zeile>('SELECT * FROM mail_nachrichten WHERE id = ?', id);
  return z ? auspacken(z) : null;
}

/** Der ganze Verlauf zu einer Nachricht, älteste zuerst. */
export function verlauf(threadId: string): Nachricht[] {
  return db.all<Zeile>(
    'SELECT * FROM mail_nachrichten WHERE thread_id = ? ORDER BY am ASC', threadId,
  ).map(auspacken);
}

export function gelesenSetzen(id: string, gelesen: boolean): void {
  db.run('UPDATE mail_nachrichten SET gelesen = ? WHERE id = ?', gelesen ? 1 : 0, id);
}

/* ── Die Sprache eines Briefpartners ───────────────────────────
 *
 * Die Sprache hängt an der ADRESSE, nicht an der einzelnen Mail. Das ist der
 * Unterschied, der zählt: schreiben wir von uns aus (eine Rechnung, eine
 * Ankündigung), gibt es keine eingehende Mail, aus der man sie ableiten
 * könnte. Am Briefpartner steht sie trotzdem.
 *
 * Jede neue Adresse beginnt bei Englisch. Schreibt jemand auf Deutsch,
 * wechselt sie dauerhaft auf Deutsch — und ab dann geht auch Post an diese
 * Adresse auf Deutsch hinaus. Dasselbe für jede andere Sprache.
 */
import { detectLanguage } from '@stellium/shared';
import { blindIndex } from '../crypto/pii.js';

/** Ohne Anhaltspunkt: Englisch. */
export const SPRACHE_VORGABE = 'en';

/*
 * Ab wann eine Erkennung eine bestehende Sprache umwerfen darf.
 *
 * Nicht bei jedem Fetzen. Ein „ok", ein „thanks" oder eine Signatur mit
 * englischen Fachwörtern reichen der Erkennung schon für ein Urteil — und ein
 * deutscher Kunde, der einmal kurz „ok" schreibt, bekäme sonst ab da alles
 * auf Englisch. Deshalb zwei Hürden zugleich: genug Text UND genug Sicherheit.
 *
 * Für die ERSTE Zuordnung gilt dieselbe Schwelle. Bis dahin bleibt es bei
 * Englisch, und das ist die richtige Vorgabe: eine falsch geratene Sprache
 * ist unangenehmer als die neutrale.
 */
const LERN_MIN_ZEICHEN = 40;
const LERN_MIN_SICHER = 0.6;

export function spracheFuer(adresse: string): string {
  const z = db.get<{ sprache: string }>(
    'SELECT sprache FROM mail_partner WHERE adresse_bidx = ?', blindIndex(adresse));
  return z?.sprache || SPRACHE_VORGABE;
}

/**
 * Aus einer eingegangenen Mail lernen, welche Sprache dieser Partner spricht.
 *
 * Gibt die Sprache zurück, die danach gilt — auch wenn nichts geändert wurde.
 */
export function spracheLernen(adresse: string, text: string): string {
  const bidx = blindIndex(adresse);
  const da = db.get<{ sprache: string; sicher: number }>(
    'SELECT sprache, sicher FROM mail_partner WHERE adresse_bidx = ?', bidx);

  const sauber = text.trim();
  if (sauber.length < LERN_MIN_ZEICHEN) return da?.sprache || SPRACHE_VORGABE;

  const erkannt = detectLanguage(sauber);
  if (erkannt.lang === 'unknown' || erkannt.confidence < LERN_MIN_SICHER) {
    return da?.sprache || SPRACHE_VORGABE;
  }
  /* Eine unsicherere Messung wirft eine sicherere nicht um. Sonst genügte ein
     einzelner mehrdeutiger Satz, um eine über Wochen bestätigte Sprache zu
     kippen. */
  if (da && erkannt.confidence < da.sicher && erkannt.lang !== da.sprache) return da.sprache;

  db.run(
    `INSERT INTO mail_partner (adresse_bidx, adresse, sprache, sicher, seit)
     VALUES (?,?,?,?,?)
     ON CONFLICT(adresse_bidx) DO UPDATE SET
       sprache = excluded.sprache, sicher = excluded.sicher, seit = excluded.seit`,
    bidx, verschluesseln(adresse), erkannt.lang, erkannt.confidence, Date.now(),
  );
  return erkannt.lang;
}
