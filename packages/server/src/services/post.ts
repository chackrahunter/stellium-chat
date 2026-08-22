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
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db, reindexMail, removeMailFromIndex } from '../db/index.js';
import { newId } from '../util/id.js';
import { verschluesseln, entschluesseln } from '../crypto/nachrichten.js';
import { zugangLesen, zugangStand } from './mailzugang.js';
import { config } from '../config.js';
import * as ablage from './ablage.js';
import { saubererDateiname } from '../util/dateiname.js';
import type { MailAnhang } from '@stellium/shared';

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
  anhaenge: MailAnhang[];
  /** Aus dem Blickfeld genommen, ohne gelöscht zu sein — Zeitpunkt oder null.
      Siehe archiviertSetzen() weiter unten. */
  archiviertAm: number | null;
  /** „Aus dem Weg geräumt", umkehrbar — Zeitpunkt oder null. Siehe
      entferntSetzen() weiter unten. */
  entferntAm: number | null;
  /** Wann die Aufbewahrungsfrist des FACHS dieser Mail ablaufen würde — null,
      solange für dieses Fach keine Frist gesetzt ist. Siehe fristenStand()
      weiter unten; muss in der Oberfläche sichtbar sein, BEVOR sie zuschlägt. */
  verfaelltAm: number | null;
}

interface Zeile {
  id: string; fach: string; richtung: string; von: string; an: string;
  betreff: string; text: string; html: string | null; message_id: string | null;
  referenzen: string | null; thread_id: string | null; am: number;
  gelesen: number; anhaenge: string | null;
  archiviert_am: number | null; entfernt_am: number | null;
}

/** Millisekunden je Tag — für die Aufbewahrungsfrist weiter unten. */
const TAG_MS = 24 * 60 * 60 * 1000;

/**
 * Die Anhang-Übersicht auspacken — seit Kurzem verschlüsselt wie jedes andere
 * Feld dieser Nachricht (Name und Typ können genauso viel über Kunden
 * verraten wie der Betreff selbst). `entschluesseln()` lässt Klartext aus der
 * Zeit vor dieser Umstellung unverändert durch (siehe dort: ein Wert ohne
 * "m1:"-Vorspann gilt schon als Klartext) — alte Zeilen bleiben also ohne
 * jede Nachrüstung lesbar.
 */
function anhaengeAuspacken(gespeichert: string | null): MailAnhang[] {
  if (!gespeichert) return [];
  try {
    const wert = JSON.parse(entschluesseln(gespeichert));
    return Array.isArray(wert) ? wert : [];
  } catch {
    // Kaputter Wert reißt sonst die ganze Liste mit, nicht nur diese eine Zeile.
    return [];
  }
}

/** `fristTage` fehlt in keinem echten Aufruf (siehe liste()/nachricht()/
    verlauf()) — optional nur, damit ein Aufruf ohne Fristenkontext nicht
    bricht, sondern schlicht `verfaelltAm: null` liefert. */
function auspacken(z: Zeile, fristTage?: Map<string, number>): Nachricht {
  const frist = fristTage?.get(z.fach);
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
    anhaenge: anhaengeAuspacken(z.anhaenge),
    archiviertAm: z.archiviert_am,
    entferntAm: z.entfernt_am,
    verfaelltAm: frist ? z.am + frist * TAG_MS : null,
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

/** Alle Fächer, inklusive des Auffangbeckens „sonstiges" — für die
    Aufbewahrungsfrist weiter unten, die auch für nicht zugeordnete Post
    gelten soll. Unzugeordnete Post ist nicht weniger schutzwürdig als
    zugeordnete. */
export const ALLE_FAECHER = [...FAECHER, FACH_SONST] as const;

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

/**
 * Dieselben Grenzen wie im Cloudflare-Worker (ANHANG_MAX / ANHAENGE_MAX_GESAMT
 * in server-setup/postfach/worker/src/index.ts) — hier UNABHÄNGIG nachgeprüft
 * an den tatsächlich dekodierten Bytes, nicht nur der Behauptung `uebergross`
 * des Workers geglaubt. Der Worker ist die erste Hürde, nicht die einzige: wer
 * das geteilte Geheimnis kennt oder dessen Fassung des Workers einen Fehler
 * hat, soll hier trotzdem scheitern — genau das Prinzip, mit dem diese Datei
 * schon die Message-ID und die Absenderadresse behandelt.
 */
const ANHANG_MAX = 1 * 1024 * 1024;
const ANHAENGE_MAX_GESAMT = 5 * 1024 * 1024;
/** Nur die Zeichen, aus denen Base64 wirklich besteht — `Buffer.from()` ist
    sonst zu gutmütig und schluckt beliebigen Müll klaglos, statt zu melden,
    dass da kein gültiger Anhang stand. */
const BASE64_FORM = /^[A-Za-z0-9+/]*={0,2}$/;

interface AnhangVorbereitet {
  name: string; typ: string; groesse: number; uebergross: boolean;
  /** Gesetzt, wenn (und nur wenn) Bytes wirklich auf der Platte liegen. */
  attId: string | null;
  tempPfad: string | null;
}

/**
 * Die rohe Anhangliste des Workers in etwas Verwendbares verwandeln — und
 * dabei NACHPRÜFEN statt glauben. Schreibt kleine Zwischendateien, aber noch
 * keine Datenbankzeile in `mail_anhaenge`: die Mail selbst existiert an
 * dieser Stelle noch nicht, und `mail_anhaenge.mail_id` zeigt per
 * Fremdschlüssel auf eine Zeile, die erst eingangAufnehmen() gleich danach
 * anlegt (schema.sql setzt `PRAGMA foreign_keys = ON` — eine Kindzeile vor
 * der Elternzeile lehnt SQLite deshalb ab).
 *
 * Der Dateiname landet dabei NIRGENDS im Dateisystempfad — die einzige Wehr
 * gegen `../` und Konsorten, die sich nicht durch eine vergessene Prüfung
 * umgehen lässt. Der Zwischenpfad entsteht ausschließlich aus einer selbst
 * erzeugten Kennung.
 */
function anhaengeVorbereiten(rohListe: unknown[]): AnhangVorbereitet[] {
  let gesamtBytes = 0;
  return rohListe.map((a) => {
    const x = a as {
      name?: unknown; typ?: unknown; groesse?: unknown; uebergross?: unknown; inhalt?: unknown;
    };
    const name = saubererDateiname(kappen(x.name, 200) || 'ohne-namen');
    const typ = kappen(x.typ, 120) || 'application/octet-stream';

    let bytes: Buffer | null = null;
    let zuGross = x.uebergross === true;
    if (typeof x.inhalt === 'string' && x.inhalt.length > 0) {
      if (BASE64_FORM.test(x.inhalt)) {
        try {
          const dekodiert = Buffer.from(x.inhalt, 'base64');
          if (dekodiert.length > 0
            && dekodiert.length <= ANHANG_MAX
            && gesamtBytes + dekodiert.length <= ANHAENGE_MAX_GESAMT) {
            bytes = dekodiert;
            gesamtBytes += dekodiert.length;
          } else {
            zuGross = true;
          }
        } catch {
          zuGross = true; // kaputtes Base64 -- Bytes gelten als nicht angekommen
        }
      } else {
        zuGross = true; // keine Base64-Form -- dieselbe Behandlung wie "kam nicht an"
      }
    }

    const groesse = bytes
      ? bytes.length
      : (typeof x.groesse === 'number' && x.groesse >= 0 ? Math.trunc(x.groesse) : 0);

    let attId: string | null = null;
    let tempPfad: string | null = null;
    if (bytes) {
      attId = newId('ma_');
      tempPfad = path.join(config.uploadDir, attId);
      try {
        fs.writeFileSync(tempPfad, bytes);
      } catch (fehler) {
        console.error('[post] Anhang ließ sich nicht ablegen:', (fehler as Error).message);
        try { fs.rmSync(tempPfad, { force: true }); } catch { /* nie entstanden */ }
        attId = null;
        tempPfad = null;
      }
    }

    return { name, typ, groesse, uebergross: zuGross, attId, tempPfad };
  });
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

  const rohAnhaenge = Array.isArray(roh.anhaenge) ? roh.anhaenge.slice(0, 25) : [];
  /* Bytes ablegen (falls vorhanden) und Grenzen unabhängig nachprüfen, BEVOR
     die Mail selbst in der Datenbank steht — siehe anhaengeVorbereiten(). */
  const vorbereitet = anhaengeVorbereiten(rohAnhaenge);
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
    /* Die Übersicht -- verschlüsselt wie jedes andere Feld dieser Nachricht
       (siehe anhaengeAuspacken() oben). `id` verweist auf `mail_anhaenge`, wo
       der eigentliche Inhalt liegt; ohne Bytes bleibt `id` null UND
       `uebergross` macht das für die Oberfläche sichtbar, statt den Anhang
       einfach verschwinden zu lassen. */
    verschluesseln(JSON.stringify(vorbereitet.map((v) => ({
      name: v.name, typ: v.typ, groesse: v.groesse, uebergross: v.uebergross, id: v.attId,
    })))),
  );

  /* Erst JETZT, NACH der Zeile oben: mail_anhaenge.mail_id zeigt per
     Fremdschlüssel auf mail_nachrichten(id) (ON DELETE CASCADE, schema.sql
     setzt PRAGMA foreign_keys = ON) -- eine Kindzeile vor der Elternzeile
     lehnt SQLite ab. */
  vorbereitet.forEach((v, nummer) => {
    if (!v.attId || !v.tempPfad) return;
    db.run(
      `INSERT INTO mail_anhaenge (id, mail_id, nummer, name, mime, size, path, encoding, stored_size, uploaded_by, created_at)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?)`,
      v.attId, id, nummer, v.name, v.typ, v.groesse, v.tempPfad, Date.now(),
    );
    /* Angemeldet, nicht abgewartet -- derselbe Weg wie jeder andere Upload
       (siehe ablage.spaeterUebernehmen()): sofort ausliefer- und lesbar, im
       Hintergrund in den Blockspeicher zerlegt. */
    ablage.spaeterUebernehmen({ id: v.attId, art: 'mail', pfad: v.tempPfad, mime: v.typ });
  });

  /* Aus dem Text lernen, welche Sprache dieser Briefpartner spricht — hier
     beim Eintreffen, nicht erst beim Antworten. Sonst hinge es davon ab, ob
     jemand antwortet, und die nächste Rechnung ginge wieder auf Englisch
     hinaus. */
  spracheLernen(von, kappen(roh.text, 4000));

  /* Nach der Zeile, nicht davor: der Suchindex liest dieselbe Zeile noch
     einmal aus der Datenbank (siehe reindexMail() in db/index.ts), die muss
     also schon stehen. Über den Anhang-Namen hinaus deckt das auch den
     Normalfall ab, in dem `vorbereitet` oben nichts zu tun hatte. */
  reindexMail(id);

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
  /** Kennungen zuvor hochgeladener, noch nicht verknüpfter mail_anhaenge-
      Zeilen (siehe ausgehenderAnhangAnlegen() weiter unten) — höchstens 25,
      Reihenfolge = Reihenfolge in der Mail. */
  anhaenge?: string[];
}

/**
 * Dieselben zwei Grenzen wie beim Eingang (ANHANG_MAX/ANHAENGE_MAX_GESAMT),
 * aber eigene, großzügigere Werte: ein ausgehender Anhang stammt von einem
 * angemeldeten Kollegen, nicht von einem Fremden — die Vorsicht gilt hier der
 * harten Grenze von Resend, nicht dem Absender. Laut
 * resend.com/docs/dashboard/emails/attachments (Abschnitt „Attachment
 * Limitations", Stand 22.08.2026): „Emails can be no larger than 40MB
 * (including attachments after Base64 encoding)." Base64 vergrößert Rohbytes
 * um rund ein Drittel — 20 MB Rohanhänge werden daraus rund 26,7 MB, mit
 * reichlich Luft für Text, Kopfzeilen und das JSON drumherum, bevor Resend
 * selbst ablehnt.
 */
const AUSGANG_ANHANG_MAX = 15 * 1024 * 1024;
const AUSGANG_ANHAENGE_MAX_GESAMT = 20 * 1024 * 1024;

/**
 * Genau eine Mailadresse — wortgleich mit der Prüfung in post-sichtung.ts.
 *
 * Duplikat statt Import: post-sichtung.ts exportiert sie nicht, und die Datei
 * dort anzufassen ist gerade nicht möglich — dieselbe Lage wie bei
 * `absenderBestaetigt()` dort, nur seitenverkehrt (siehe der Kommentar an
 * jener Stelle: „post.ts anzufassen ist gerade nicht möglich"; hier ist es
 * post-sichtung.ts).
 *
 * „kunde@firma.de, angreifer@boese.tld" käme sonst unverändert durch
 * `nurAdresse()` (die nur „Name <a@b.de>" auspackt, aber nicht prüft, ob am
 * Ende EINE Adresse übrig bleibt) und stünde als `to` beim Versanddienst —
 * der macht daraus bereitwillig zwei Empfänger.
 *
 * Geprüft wird HIER, in `senden()` selbst, und nicht nur in der Route, aus
 * demselben Grund wie beim Eingang oben: `senden()` ist die einzige Stelle,
 * durch die jeder Versand läuft — von Hand verfasst über die Oberfläche,
 * eine freigegebene KI-Antwort, jede künftige dritte Aufrufstelle. Wer hier
 * prüft, muss es an keiner Aufrufstelle wiederholen und kann es dort auch
 * nicht vergessen.
 */
const EINE_ADRESSE = /^[^\s@,;:<>"'()[\]\\]+@[^\s@,;:<>"'()[\]\\]+\.[^\s@,;:<>"'()[\]\\]{2,}$/;

/**
 * Die acht Fächer als vollständige Adressen — für die Auswahl beim freien
 * Verfassen einer neuen Mail.
 *
 * Die Domäne kommt aus `zugangStand()`, nicht aus `zugangLesen()`: die Liste
 * soll auch erscheinen, wenn der Versandschlüssel (noch) fehlt — sonst sähe
 * die schreibende Person gar keine Fächer und wüsste nicht, woran das liegt.
 * `senden()` meldet den fehlenden Schlüssel dann für sich, beim Versuch zu
 * senden. Ist gar keine Absenderadresse hinterlegt, gibt es noch keine
 * Domäne und damit auch keine Liste — leer statt geraten.
 */
export function absenderFaecher(): string[] {
  const domaene = zugangStand().absender?.split('@')[1];
  return domaene ? FAECHER.map((lokal) => `${lokal}@${domaene}`) : [];
}

interface AnhangZumVersand { id: string; name: string; mime: string; size: number; inhaltBase64: string }

/**
 * Zuvor hochgeladene Anhänge für den Versand lesen — Eigentum und Zustand
 * geprüft, nicht angenommen.
 *
 * Nur Zeilen, die (a) wirklich `hochgeladenVon` gehören und (b) noch an
 * KEINER Mail hängen (`mail_id IS NULL`), kommen durch — dieselbe Regel wie
 * bei `attachments.message_id` im Chat (siehe messages.ts): eine fremde oder
 * schon verbrauchte Kennung ergibt dieselbe Meldung wie eine erfundene, sonst
 * verriete der Unterschied, ob sie überhaupt existiert.
 */
async function anhaengeZumVersandLesen(ids: string[], hochgeladenVon: string): Promise<AnhangZumVersand[]> {
  const gefunden: AnhangZumVersand[] = [];
  let gesamt = 0;
  for (const anhangId of ids) {
    const zeile = db.get<{
      id: string; name: string; mime: string; size: number; path: string;
      encoding: string | null; uploaded_by: string | null; mail_id: string | null;
    }>('SELECT id, name, mime, size, path, encoding, uploaded_by, mail_id FROM mail_anhaenge WHERE id = ?', anhangId);
    if (!zeile || zeile.uploaded_by !== hochgeladenVon || zeile.mail_id !== null) {
      throw new PostFehler('post.anhangUngueltig',
        'Ein Anhang ist nicht mehr verfügbar — bitte erneut anhängen.', 400);
    }
    if (zeile.size > AUSGANG_ANHANG_MAX || gesamt + zeile.size > AUSGANG_ANHAENGE_MAX_GESAMT) {
      throw new PostFehler('post.anhaengeZuGross',
        `Die Anhänge sind zusammen zu groß (je Datei höchstens ${Math.round(AUSGANG_ANHANG_MAX / 1024 / 1024)} MB, `
        + `insgesamt höchstens ${Math.round(AUSGANG_ANHAENGE_MAX_GESAMT / 1024 / 1024)} MB).`, 400);
    }
    gesamt += zeile.size;

    const strom = ablage.oeffnen({ id: zeile.id, art: 'mail', pfad: zeile.path, encoding: zeile.encoding });
    if (!strom) {
      throw new PostFehler('post.anhangUngueltig',
        'Ein Anhang ist nicht mehr verfügbar — bitte erneut anhängen.', 400);
    }
    const stuecke: Buffer[] = [];
    for await (const stueck of strom as AsyncIterable<Buffer>) stuecke.push(Buffer.from(stueck));
    const inhalt = Buffer.concat(stuecke);
    gefunden.push({
      id: zeile.id, name: zeile.name, mime: zeile.mime, size: inhalt.length,
      inhaltBase64: inhalt.toString('base64'),
    });
  }
  return gefunden;
}

/**
 * @param hochgeladenVon Wer angemeldet ist, wenn `m.anhaenge` gesetzt ist —
 * fehlt es trotz gesetzter Anhänge, ist das ein Programmierfehler eines
 * künftigen Aufrufers und wird laut gemeldet, nicht still ignoriert (sonst
 * ginge eine Mail hinaus, die ihren erwarteten Anhang lautlos verliert).
 */
export async function senden(m: Ausgang, hochgeladenVon?: string): Promise<{ id: string }> {
  const z = zugangLesen();
  if (!z) {
    /* „Kein Versandweg hinterlegt" allein sagt nicht, WAS fehlt — und
       Schlüssel und Absenderadresse werden an zwei verschiedenen Stellen im
       Reiter „Post" eingetragen (siehe zugangStand() in mailzugang.ts). Wer
       nur den Schlüssel gesetzt hat, aber keinen Absender, soll das lesen
       können, statt aus einer einzigen pauschalen Meldung zu raten. */
    const stand = zugangStand();
    if (!stand.versandBereit) {
      throw new PostFehler('post.keinSchluessel', 'Kein Versandschlüssel hinterlegt.', 400);
    }
    throw new PostFehler('post.keinAbsender', 'Keine Absenderadresse für den Versand hinterlegt.', 400);
  }

  /* Die einzige Adresse, die tatsächlich verschickt wird — normalisiert wie
     beim Eingang (`nurAdresse()`) und geprüft, bevor irgendetwas an den
     Versanddienst geht. Alles Weitere in dieser Funktion verwendet
     `empfaenger`, nicht mehr `m.an`. */
  const empfaenger = nurAdresse(m.an);
  if (!EINE_ADRESSE.test(empfaenger)) {
    throw new PostFehler('post.ungueltigeAdresse',
      'Das ist keine einzelne, gültige Mailadresse.', 400);
  }

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

  /* Vor dem Versand lesen, nicht erst danach verknüpfen: eine Mail, die
     längst bei Resend war, aber deren Anhang sich als fremd oder verschwunden
     herausstellt, wäre nicht mehr rückgängig zu machen. */
  const anhaengeIds = [...new Set(m.anhaenge ?? [])].slice(0, 25);
  if (anhaengeIds.length && !hochgeladenVon) {
    throw new PostFehler('post.anhangOhneKonto', 'Anhänge ohne bekannten Uploader — interner Fehler.', 500);
  }
  const anhaengeZeilen = anhaengeIds.length
    ? await anhaengeZumVersandLesen(anhaengeIds, hochgeladenVon!)
    : [];

  const antwort = await fetch(VERSAND_ENDE, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${z.versandSchluessel}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `${z.name} <${absender}>`,
      to: [empfaenger],
      subject: m.betreff,
      text: m.text,
      ...(Object.keys(kopf).length ? { headers: kopf } : {}),
      /* `content` (Base64) statt `path`: die Datei liegt in unserem eigenen
         Blockspeicher, nicht unter einer öffentlich erreichbaren Adresse, die
         Resend selbst abrufen könnte (siehe resend.com/docs/dashboard/emails/
         attachments, Abschnitt „Send attachments from a local file"). */
      ...(anhaengeZeilen.length
        ? { attachments: anhaengeZeilen.map((a) => ({ filename: a.name, content: a.inhaltBase64 })) }
        : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch((f) => {
    throw new PostFehler('post.keineVerbindung',
      `Der Versanddienst ist nicht erreichbar: ${(f as Error).message}`, 503);
  });

  if (!antwort.ok) {
    /* Der Rumpf enthält kein Geheimnis. Roh geparst, weil Resend bei einem
       Fehlschlag JSON mit `name` und `message` schickt (siehe
       resend.com/docs/api-reference/errors) — erst daran lassen sich die
       Fälle unten auseinanderhalten. Kommt doch kein JSON zurück, bleibt es
       beim rohen Text als Grund. */
    const roh = await antwort.text().catch(() => '');
    let art = '';
    let dienstMeldung = '';
    try {
      const k = JSON.parse(roh) as { name?: unknown; message?: unknown };
      if (typeof k.name === 'string') art = k.name;
      if (typeof k.message === 'string') dienstMeldung = k.message;
    } catch { /* keine JSON-Antwort — grund bleibt unten der rohe Text */ }
    const grund = (dienstMeldung || roh).slice(0, 200);

    /* 401 und 403 sind bei Resend NICHT dasselbe Problem, auch wenn beide wie
       „abgelehnt" aussehen:
       · ein ungültiger oder gesperrter Schlüssel  → 401, oder 403 mit
         `restricted_api_key`/`suspended_api_key`.
       · der Sandkasten vor der Domainprüfung      → ebenfalls 403, aber mit
         `validation_error` und dem Satz „You can only send testing emails
         to your own email address …". Der Schlüssel ist dabei völlig in
         Ordnung — nur die Domain ist bei Resend noch nicht bestätigt.
       Beides unter „Versandschlüssel gilt nicht mehr" zu zeigen hieß
       zuletzt: ein gültiger Schlüssel im Sandkasten sah aus wie ein
       ungültiger, und niemand kam auf die eigentliche Ursache. */
    if (art === 'restricted_api_key' || art === 'suspended_api_key' || antwort.status === 401) {
      throw new PostFehler('post.schluesselAbgelehnt',
        'Der hinterlegte Versandschlüssel gilt nicht mehr.', 400);
    }
    if (antwort.status === 403) {
      throw new PostFehler('post.sandkasten',
        'Die Domain ist bei Resend noch nicht bestätigt. Im Sandkasten geht Post nur an die eigene '
        + `Kontoadresse — an jede andere Adresse schlägt der Versand fehl, bis eine Domain verifiziert `
        + `ist. Meldung des Diensts: ${grund}`, 400);
    }
    /* Resend unterscheidet Tages- und Monatskontingent von der allgemeinen
       Rate-Bremse — alle drei kommen als 429, aber mit unterschiedlichem
       `name` und unterschiedlicher Abhilfe. Der Gratistarif deckelt bei 100
       Mails am Tag; das ist der Fall, den der Auftraggeber ausdrücklich
       sehen und nicht erraten soll. */
    if (art === 'daily_quota_exceeded') {
      throw new PostFehler('post.kontingentTag',
        'Das Tageskontingent des Versanddiensts ist erschöpft (Gratistarif: 100 Mails am Tag). '
        + 'Es geht erst wieder, wenn 24 Stunden seit der ersten Mail des Tages vergangen sind — oder mit einem größeren Tarif.',
        429);
    }
    if (art === 'monthly_quota_exceeded') {
      throw new PostFehler('post.kontingentMonat',
        'Das Monatskontingent des Versanddiensts ist erschöpft.', 429);
    }
    if (antwort.status === 429) {
      throw new PostFehler('post.rateLimit',
        'Der Versanddienst bremst gerade — zu viele Anfragen kurz hintereinander. Gleich noch einmal versuchen.',
        429);
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
     VALUES (?,?,'aus',?,?,?,?,NULL,?,?,?,?,1,?)`,
    id, absender.toLowerCase(),
    verschluesseln(absender), verschluesseln(empfaenger),
    verschluesseln(m.betreff), verschluesseln(m.text),
    d.id ?? null, kopf.References ?? null,
    m.antwortAuf?.threadId ?? d.id ?? null,
    Date.now(),
    /* Dieselbe verschlüsselte Übersicht wie beim Eingang (siehe
       anhaengeAuspacken() oben) -- `uebergross` ist hier immer false, denn
       AUSGANG_ANHANG_MAX/AUSGANG_ANHAENGE_MAX_GESAMT haben schon vor dem
       Versand geprüft (anhaengeZumVersandLesen() oben). */
    verschluesseln(JSON.stringify(anhaengeZeilen.map((a) => (
      { name: a.name, typ: a.mime, groesse: a.size, uebergross: false, id: a.id }
    )))),
  );

  /* Erst NACH der Zeile oben verknüpfen -- dieselbe Fremdschlüssel-Reihenfolge
     wie beim Eingang (eingangAufnehmen() oben): mail_anhaenge.mail_id zeigt
     auf eine Zeile, die jetzt gerade erst entstanden ist. */
  anhaengeZeilen.forEach((a, nummer) => {
    db.run('UPDATE mail_anhaenge SET mail_id = ?, nummer = ? WHERE id = ?', id, nummer, a.id);
  });

  // Auch das Gesendete muss sich wiederfinden lassen — dieselbe Regel wie
  // beim Eingang oben (eingangAufnehmen()).
  reindexMail(id);

  return { id };
}

/* ── Weiterleiten ──────────────────────────────────────────────
 *
 * Eine bestehende Mail — meistens eine eingegangene — mit ihrem Text und
 * ihren Anhängen an eine andere Adresse geben. Baut bewusst auf `senden()`
 * oben auf statt eine zweite Versandstrecke zu eröffnen: dieselbe Prüfung der
 * Empfängeradresse (`EINE_ADRESSE`), derselbe Weg zum Versanddienst, dieselbe
 * Fehlerübersetzung.
 *
 * DREI DINGE, DIE HIER LEICHT SCHIEFGEHEN KÖNNEN — UND WARUM SIE ES HIER NICHT TUN
 *
 * 1. DER EMPFÄNGER IST FREI EINGEBBAR. Weiterleiten heißt: an eine Adresse
 *    schreiben, mit der bisher niemand Kontakt hatte. `an` läuft deshalb
 *    genauso durch `senden()` wie beim freien Verfassen — `EINE_ADRESSE`
 *    entscheidet, keine Sonderregel für Weiterleitungen.
 *
 * 2. AUS WELCHEM FACH SIE HINAUSGEHT, ENTSCHEIDET, WOHIN GEANTWORTET WIRD.
 *    Das Fach kommt deshalb NICHT automatisch aus der Ursprungsmail, sondern
 *    von der Aufrufstelle (siehe `fach` unten) — die Route lässt es wählen,
 *    mit dem Fach der Ursprungsmail nur als VORGABE (siehe dort). Genau wie
 *    beim freien Verfassen wird das hier nicht noch einmal geprüft — dieselbe,
 *    schon bestehende Lücke wie in `/api/post/senden` (siehe dort: `fach`
 *    landet ungeprüft im „From", solange es ein '@' enthält). Sie zu schließen
 *    ist nicht Teil dieses Auftrags; Weiterleiten öffnet sie nicht neu, sie
 *    war schon vorher da.
 *
 * 3. DER TEXT STAMMT VON EINEM FREMDEN. `senden()` setzt `kopf['In-Reply-To']`
 *    und `kopf.References` ausschließlich aus `antwortAuf` — und genau DAS
 *    wird hier bewusst NIE mitgegeben. Eine Weiterleitung ist keine Antwort:
 *    der neue Empfänger war nie Teil des ursprünglichen Verlaufs, ein
 *    `In-Reply-To` auf eine Nachricht, die er nie bekommen hat, wäre falsch —
 *    und mit `antwortAuf` bliebe außerdem sein einziger Weg zu, um Kopfzeilen
 *    des VERSANDS zu beeinflussen, gleich ganz verschlossen. Betreff und Text
 *    des Fremden werden ausschließlich als JSON-WERTE an den Versanddienst
 *    gereicht (`subject`/`text` in `senden()` oben) — nie zu einer rohen
 *    Kopfzeile zusammengesetzt, in die sich ein eingebettetes Zeilenende
 *    einschmuggeln könnte. Es gibt in dieser Funktion keine einzige Stelle,
 *    an der Text aus `original.betreff`/`original.text`/`original.von` in
 *    ein `headers`-Feld für Resend fließt.
 */
export interface Weiterleitung {
  /** Aus welchem Fach die Weiterleitung hinausgeht — bestimmt die
      Absenderadresse, siehe `senden()`, `Ausgang.fach`. */
  fach?: string;
  an: string;
}

/**
 * @param hochgeladenVon Wer weiterleitet — zugleich „Eigentümer" der ggf.
 * kopierten Anhänge, siehe `anhangFuerWeiterleitungKopieren()` unten.
 */
export async function weiterleiten(
  mailId: string, eingabe: Weiterleitung, hochgeladenVon: string,
): Promise<{ id: string }> {
  const original = nachricht(mailId);
  if (!original) {
    throw new PostFehler('post.mailNichtGefunden', 'Diese Mail gibt es nicht (mehr).', 404);
  }

  const anhaengeIds: string[] = [];
  for (const a of original.anhaenge) {
    if (!a.id) continue; // nie angekommen -- nichts zum Anhängen da (siehe uebergross)
    // eslint-disable-next-line no-await-in-loop -- Anhänge einer Mail sind
    // höchstens 25 (siehe eingangAufnehmen()), eine Reihenfolge kostet hier
    // nichts, was eine Parallelisierung wieder wert wäre.
    const kopie = await anhangFuerWeiterleitungKopieren(a.id, hochgeladenVon);
    if (kopie) anhaengeIds.push(kopie.id);
  }

  const betreffOhnePrefix = (original.betreff || '').trim();
  const betreff = /^(fwd|wg)[:.]/i.test(betreffOhnePrefix) ? betreffOhnePrefix : `Fwd: ${betreffOhnePrefix}`;

  return senden({
    fach: eingabe.fach,
    an: eingabe.an,
    betreff,
    text: original.text,
    anhaenge: anhaengeIds.length ? anhaengeIds : undefined,
    // Kein antwortAuf -- siehe Dateikopf, Punkt 3.
  }, hochgeladenVon);
}

/**
 * Einen bestehenden Anhang für eine Weiterleitung übernehmen, ohne die Bytes
 * ein zweites Mal vom Absender zu verlangen.
 *
 * Bevorzugter Weg: der Ursprung ist längst in den Blockspeicher zerlegt (der
 * Regelfall — eine weitergeleitete Mail ist so gut wie nie taufrisch, die
 * Zerlegung läuft im Hintergrund und ist meist binnen Sekunden durch, siehe
 * ablage.spaeterUebernehmen()). Dann teilt `ablage.bloeckeTeilen()` nur die
 * LISTE der Blöcke — dieselben Bytes, zwei unabhängige Datenbankzeilen, jede
 * für sich später löschbar (siehe verweiseNachrechnen() in bloecke.ts).
 * KEINE zweite Kopie auf der Platte.
 *
 * Liegt der Ursprung ausnahmsweise noch als GANZE Datei da (gerade erst
 * angekommen, die Zerlegung im Hintergrund noch nicht durch), fällt diese
 * Funktion auf denselben Weg zurück, den eingangAufnehmen() für jeden Anhang
 * ohnehin schon geht: Bytes lesen, eine EIGENE Zwischendatei schreiben,
 * eigenständig zur Zerlegung anmelden. Eine zweite Datenbankzeile auf
 * DENSELBEN Pfad wäre hier riskant: die Zerlegung des Originals kann die
 * Ausgangsdatei in genau diesem schmalen Zeitfenster schon wegräumen, während
 * die Kopie noch darauf zeigt — die eigene Zwischendatei umgeht das
 * vollständig, auf Kosten eines kurzlebigen doppelten Schreibvorgangs.
 *
 * `null`, wenn der Ursprung nicht mehr da ist oder sich nicht mehr lesen
 * lässt — dieselbe „lieber ohne diesen einen Anhang weiterleiten als gar
 * nicht" Haltung wie beim ersten Eingang (siehe anhaengeVorbereiten()).
 */
async function anhangFuerWeiterleitungKopieren(
  anhangId: string, hochgeladenVon: string,
): Promise<AusgehenderAnhang | null> {
  const quelle = db.get<{
    id: string; name: string; mime: string; size: number;
    path: string; encoding: string | null; stored_size: number | null;
  }>('SELECT id, name, mime, size, path, encoding, stored_size FROM mail_anhaenge WHERE id = ?', anhangId);
  if (!quelle) return null;

  const neueId = newId('ma_');

  if (quelle.encoding === 'bloecke') {
    db.run(
      `INSERT INTO mail_anhaenge (id, mail_id, nummer, name, mime, size, path, encoding, stored_size, uploaded_by, created_at)
       VALUES (?,NULL,0,?,?,?,NULL,'bloecke',?,?,?)`,
      neueId, quelle.name, quelle.mime, quelle.size, quelle.stored_size, hochgeladenVon, Date.now(),
    );
    ablage.bloeckeTeilen({ id: quelle.id, art: 'mail' }, { id: neueId, art: 'mail' });
    return { id: neueId, name: quelle.name, mime: quelle.mime, size: quelle.size };
  }

  const strom = ablage.oeffnen({ id: quelle.id, art: 'mail', pfad: quelle.path, encoding: quelle.encoding });
  if (!strom) return null;
  const zielPfad = path.join(config.uploadDir, neueId);
  try {
    await pipeline(strom, fs.createWriteStream(zielPfad));
  } catch (fehler) {
    console.error('[post] Anhang ließ sich für die Weiterleitung nicht kopieren:', (fehler as Error).message);
    try { fs.rmSync(zielPfad, { force: true }); } catch { /* nie entstanden */ }
    return null;
  }
  const groesse = fs.statSync(zielPfad).size;
  return ausgehenderAnhangAnlegen({
    id: neueId, name: quelle.name, mime: quelle.mime, size: groesse,
    storedPath: zielPfad, hochgeladenVon,
  });
}

/* ── Lesen ─────────────────────────────────────────────────── */

/** Die Ordner mit ihren Zählständen — daraus entsteht die Seitenleiste.
    Zählt nur AKTIVE Post mit, dieselbe Ansicht, die liste() ohne `ansicht`
    zeigt — sonst stünde in der Seitenleiste eine Zahl, zu der die Liste
    darunter nicht passt, sobald einmal etwas archiviert oder entfernt wurde. */
export function faecher(): Array<{ fach: string; gesamt: number; ungelesen: number }> {
  return db.all<{ fach: string; gesamt: number; ungelesen: number }>(
    `SELECT fach,
            COUNT(*) AS gesamt,
            SUM(CASE WHEN gelesen = 0 AND richtung = 'ein' THEN 1 ELSE 0 END) AS ungelesen
       FROM mail_nachrichten
      WHERE archiviert_am IS NULL AND entfernt_am IS NULL
      GROUP BY fach
      ORDER BY fach`);
}

/** Welcher Ausschnitt: der Alltag, das Archiv, oder der Papierkorb (was aus
    dem Weg geräumt wurde und sich noch zurückholen lässt). */
export type PostAnsicht = 'aktiv' | 'archiviert' | 'papierkorb';

export function liste(fach: string | null, anzahl = 50, vor?: number, ansicht: PostAnsicht = 'aktiv'): Nachricht[] {
  /* Im Dienst deckeln, nicht erst in der Route: ein zweiter Aufrufer käme
     sonst daran vorbei und holte beliebig viele Zeilen — jede davon wird
     entschlüsselt. */
  anzahl = Math.min(Math.max(1, Math.trunc(anzahl) || 50), 200);
  /* Drei sich AUSSCHLIESSENDE Ausschnitte, keine Kombination: der Papierkorb
     zeigt, was entfernt wurde, unabhängig davon, ob es vorher archiviert war
     — sonst verschwände eine archivierte und dann entfernte Mail zwischen
     beiden Ansichten, statt in einer von beiden aufzutauchen. */
  const zustand = ansicht === 'archiviert' ? 'AND archiviert_am IS NOT NULL AND entfernt_am IS NULL'
    : ansicht === 'papierkorb' ? 'AND entfernt_am IS NOT NULL'
      : 'AND archiviert_am IS NULL AND entfernt_am IS NULL';
  const zeilen = fach
    ? db.all<Zeile>(
      `SELECT * FROM mail_nachrichten WHERE fach = ? AND am < ? ${zustand}
        ORDER BY am DESC LIMIT ?`, fach, vor ?? Number.MAX_SAFE_INTEGER, anzahl)
    : db.all<Zeile>(
      `SELECT * FROM mail_nachrichten WHERE am < ? ${zustand}
        ORDER BY am DESC LIMIT ?`, vor ?? Number.MAX_SAFE_INTEGER, anzahl);
  const fristen = fristenTageKarte();
  return zeilen.map((z) => auspacken(z, fristen));
}

export function nachricht(id: string): Nachricht | null {
  const z = db.get<Zeile>('SELECT * FROM mail_nachrichten WHERE id = ?', id);
  return z ? auspacken(z, fristenTageKarte()) : null;
}

/** Der ganze Verlauf zu einer Nachricht, älteste zuerst. */
export function verlauf(threadId: string): Nachricht[] {
  const fristen = fristenTageKarte();
  return db.all<Zeile>(
    'SELECT * FROM mail_nachrichten WHERE thread_id = ? ORDER BY am ASC', threadId,
  ).map((z) => auspacken(z, fristen));
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

/* ── Archivieren, aus dem Weg räumen, endgültig löschen ───────────
 *
 * Drei verschiedene Dinge, drei verschiedene Schwellen — sie heißen nicht
 * zufällig verschieden:
 *
 *   · `archiviertSetzen()` nimmt Post aus dem Blickfeld, ohne sie
 *     anzutasten — für erledigte Vorgänge. Rein umkehrbar, jederzeit.
 *
 *   · `entferntSetzen(id, true)` räumt „aus dem Weg", nach demselben Bild wie
 *     `deleted_at` bei Chatnachrichten (siehe messages.ts, deleteMessage()):
 *     reversibel, aber OHNE Zeitfenster — anders als beim Chat gehört diese
 *     Post nicht einer einzelnen Person, die „ihre" Nachricht gerade eben
 *     zurücknehmen will, sondern der Firma, und es gibt keinen Anlass, das
 *     Rückgängigmachen zu befristen. `entferntSetzen(id, false)` holt sie
 *     zurück — siehe fristenAnwenden() weiter unten dafür, dass ein
 *     „Entfernen" die Aufbewahrungsfrist NICHT anhält: entfernte Post ist
 *     noch da und zählt weiter mit.
 *
 *   · `endgueltigLoeschen()` ist etwas ANDERES als beides zusammen, nicht nur
 *     mehr davon: der Inhalt verschwindet aus der Datenbank, nicht nur aus
 *     der Liste. Das ist das Recht auf Löschung aus Art. 17 DSGVO, kein
 *     Aufräumen — und es reicht tiefer als die beiden Zustände oben: aktive,
 *     archivierte UND schon entfernte Post lässt sich damit endgültig
 *     löschen. Die beiden Spalten oben spielen für `endgueltigLoeschen()`
 *     keine Rolle mehr, sie werden mitgelöscht, nicht abgefragt.
 */

/** Aus dem Blickfeld nehmen (archiviert = true) oder zurückholen (false). */
export function archiviertSetzen(id: string, archiviert: boolean): boolean {
  const r = db.run(
    'UPDATE mail_nachrichten SET archiviert_am = ? WHERE id = ?',
    archiviert ? Date.now() : null, id,
  );
  return r.changes > 0;
}

/** Aus dem Weg räumen (entfernt = true) oder zurückholen (entfernt = false). */
export function entferntSetzen(id: string, entfernt: boolean): boolean {
  const r = db.run(
    'UPDATE mail_nachrichten SET entfernt_am = ? WHERE id = ?',
    entfernt ? Date.now() : null, id,
  );
  return r.changes > 0;
}

/**
 * Adressen, die NACH dem Löschen der übergebenen Zeilen noch irgendwo in
 * mail_nachrichten stehen — als `von` ODER `an`, ohne Rücksicht auf Fach oder
 * Richtung.
 *
 * Ein einziger Durchlauf durch das, was übrig bleibt, statt einer Abfrage je
 * Adresse: bei einem Aufräumlauf mit vielen abgelaufenen Zeilen (siehe
 * fristenAnwenden() weiter unten) wären das sonst n mal m Entschlüsselungen
 * statt einmal n. `von`/`an` sind mit zufälligem IV verschlüsselt — ein
 * SQL-„WHERE von = ?" auf dem Chiffrat geht nicht, es bleibt nur der
 * Durchlauf mit Entschlüsseln (dieselbe Bauart wie in verlaufErlaubt() oben,
 * nur ohne dessen LIMIT: hier muss es vollständig sein, sonst überlebte eine
 * Adresse in mail_partner grundlos einen Treffer, der weiter unten im
 * Ergebnis gar nicht mehr auftaucht).
 */
function nochVorhandeneAdressen(): Set<string> {
  const uebrig = new Set<string>();
  for (const z of db.all<{ von: string; an: string }>('SELECT von, an FROM mail_nachrichten')) {
    uebrig.add(entschluesseln(z.von).toLowerCase());
    uebrig.add(entschluesseln(z.an).toLowerCase());
  }
  return uebrig;
}

/**
 * Eine oder mehrere Mails WIRKLICH löschen — für Art. 17 DSGVO und für die
 * Aufbewahrungsfrist (fristenAnwenden() weiter unten benutzt diese Funktion
 * als Werkzeug, mail für mail ist hier nur der Sonderfall n=1).
 *
 * Nimmt, anders als archiviertSetzen()/entferntSetzen(), auch alles mit, was
 * AUS der Mail entstanden ist:
 *
 *   · mail_sichtung   — die Einordnung der KI zu genau dieser Mail.
 *   · mail_entwuerfe  — ein Antwortentwurf, der an ihr hängt (auch ein noch
 *     offener — eine abgelaufene Frist wartet nicht auf eine Entscheidung,
 *     die niemand getroffen hat).
 *   · mail_anhaenge   — fällt über ON DELETE CASCADE mit der Mail selbst weg,
 *     aber NUR die Datenbankzeile. Die eigentlichen Bytes liegen im
 *     Blockspeicher (bloecke/datei_bloecke) oder noch als ganze Datei da,
 *     solange die Zerlegung im Hintergrund läuft (ablage.spaeterUebernehmen()
 *     in eingangAufnehmen() oben) — beides räumt eine Kaskade NICHT ab,
 *     dieselbe Lücke wie beim Löschen eines Kanals (siehe channels.ts,
 *     deleteChannel(): "was ON DELETE CASCADE abräumt, muss der Blockspeicher
 *     von Hand nach"). Genau dieselben zwei Aufräumschritte deshalb auch
 *     hier: ablage.verwaisteAufraeumen() für Blöcke, ablage.dateienAufraeumen()
 *     für noch ganze Dateien. Ohne das bliebe der Anhang selbst — ein
 *     Lebenslauf, eine Rechnung — lesbar auf der Platte liegen, während die
 *     Mail, die ihn brachte, längst weg ist.
 *   · mail_partner    — NUR, wenn keine der gelöschten Mails und auch keine
 *     verbliebene Mail mehr dieselbe Adresse trägt (weder als `von` noch als
 *     `an`). Sprache und Gruppe eines Briefpartners sind aus Mailtext GELERNT
 *     (spracheLernen() oben, post-partnergruppen.ts) — genau die Art Rest,
 *     die beim Löschen einer Chatnachricht bisher im Übersetzungsspeicher
 *     liegen blieb, bis dropMessageTranslations() das schloss (siehe
 *     messages.ts, deleteMessage()). Bleibt eine andere, NICHT gelöschte Mail
 *     von/an dieselbe Adresse stehen, bleibt auch der Partnereintrag — sonst
 *     verlöre ein bestehender Verlauf grundlos seine gelernte Sprache und
 *     Gruppe.
 *
 * Gibt zurück, wie viele Zeilen aus mail_nachrichten wirklich weg sind.
 */
function mailsHartLoeschen(ids: string[]): number {
  if (!ids.length) return 0;
  const platz = ids.map(() => '?').join(',');
  const zeilen = db.all<{ id: string; von: string; an: string }>(
    `SELECT id, von, an FROM mail_nachrichten WHERE id IN (${platz})`, ...ids);
  if (!zeilen.length) return 0;

  /* VOR dem Löschen gemerkt, nicht danach gesucht: nach dem DELETE (unten)
     weiß niemand mehr, welche Anhangpfade zu diesen Mails gehörten — dieselbe
     Reihenfolge wie in channels.ts, deleteChannel(). */
  const anhangPfade = db.all<{ path: string }>(
    `SELECT path FROM mail_anhaenge WHERE mail_id IN (${platz})`, ...ids,
  ).map((r) => r.path);

  let geloescht = 0;
  db.transaction(() => {
    for (const z of zeilen) {
      geloescht += db.run('DELETE FROM mail_nachrichten WHERE id = ?', z.id).changes;
      db.run('DELETE FROM mail_sichtung WHERE mail_id = ?', z.id);
      db.run('DELETE FROM mail_entwuerfe WHERE mail_id = ?', z.id);
    }

    const betroffeneAdressen = new Set<string>();
    for (const z of zeilen) {
      betroffeneAdressen.add(entschluesseln(z.von).toLowerCase());
      betroffeneAdressen.add(entschluesseln(z.an).toLowerCase());
    }
    const uebrig = nochVorhandeneAdressen();
    for (const adresse of betroffeneAdressen) {
      if (!adresse || uebrig.has(adresse)) continue;
      db.run('DELETE FROM mail_partner WHERE adresse_bidx = ?', blindIndex(adresse));
    }
  });

  /* Auch aus dem Suchindex — sonst fände eine Suche nach einem Wort aus
     genau diesem Betreff oder Text weiterhin eine Mail, die es laut
     mail_nachrichten längst nicht mehr gibt. Nach der Transaktion, nicht
     darin: mail_fts ist eine virtuelle Tabelle ohne Fremdschlüssel und ohne
     Kaskade (siehe removeChannelFromIndex() in db/index.ts für dieselbe
     Einschränkung bei message_fts) — das DELETE oben räumt sie nicht mit ab.
     Deckt beide Aufrufer dieser Funktion ab: endgueltigLoeschen() (ein
     einzelner Wunsch nach Art. 17 DSGVO) und fristenAnwenden() (viele Zeilen
     auf einmal, siehe dort). */
  for (const z of zeilen) removeMailFromIndex(z.id);

  /* mail_anhaenge ist mit der Mail über die Kaskade schon weg — was jetzt noch
     aufzuräumen bleibt, ist der INHALT, den die Kaskade nicht kennt (siehe
     Dateikopf oben). Beide Aufräumfunktionen sind genau für diesen Fall
     gebaut (siehe ablage.ts) und unbedenklich, auch wenn nichts zu tun ist —
     derselbe Aufruf wie in channels.ts, deleteChannel(). */
  ablage.verwaisteAufraeumen();
  ablage.dateienAufraeumen(anhangPfade);

  /* Das DELETE oben nimmt die Zeile aus der Datenbank — aber im WAL-Modus
     (schema.sql: PRAGMA journal_mode = WAL) landet eine Änderung zuerst im
     `-wal`-Nebendatei und erst bei einem Checkpoint in der Hauptdatei. Ohne
     diesen Aufruf bliebe der gelöschte Inhalt dort möglicherweise noch
     tagelang lesbar liegen, bis SQLite von selbst aufräumt (Vorgabe: alle
     1000 Seiten) — für ein Recht auf Löschung ist "irgendwann von selbst"
     zu wenig. TRUNCATE, nicht FULL: FULL setzt nur die Leseposition zurück
     und lässt die Datei so groß, wie sie war — die alten Seiten blieben als
     Datenmüll am Ende der Datei liegen. TRUNCATE schneidet die Datei
     wirklich auf null zurück. Best effort, kein harter Fehler: eine Sperre
     durch einen gerade lesenden Vorgang darf das Löschen selbst (oben schon
     geschehen) nicht rückgängig machen, nur den Aufräumschritt verschieben. */
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.warn('[post] WAL-Checkpoint nach endgültigem Löschen:', (err as Error).message);
  }

  return geloescht;
}

/** Eine einzelne Mail endgültig löschen. `false`, wenn es sie nicht (mehr) gab. */
export function endgueltigLoeschen(id: string): boolean {
  return mailsHartLoeschen([id]) > 0;
}

/* ── Aufbewahrungsfrist ────────────────────────────────────────
 *
 * Jedes Fach kann eine EIGENE Frist bekommen, weil die Fächer verschieden
 * sind: `jobs@` trägt Bewerbungsunterlagen, `billing@` möglicherweise
 * aufbewahrungspflichtige Belege, `abuse@`/`security@` sind Vorfallsakten.
 * Eine einzige Frist fürs ganze Postfach läge für irgendein Fach immer
 * falsch.
 *
 * OHNE gesetzte Frist passiert nichts — das ist die Vorgabe für JEDES Fach,
 * bis jemand mit `mail.verwalten` ausdrücklich eine Zahl einträgt. Erfunden
 * wird hier keine Frist: welche für ein Unternehmen richtig ist, weiß dieser
 * Code nicht, und er tut nicht so, als wüsste er es.
 */

interface FristZeile { fach: string; tage: number; gesetzt_von: string | null; gesetzt_am: number; }

export interface FristStand {
  fach: string;
  /** null = keine Frist gesetzt — Grundlage für den sichtbaren Hinweis in
      der Oberfläche, dass hier (noch) nichts verfällt. */
  tage: number | null;
  gesetztVon: string | null;
  gesetztAm: number | null;
}

/** Nur die gesetzten Fristen, als Nachschlagetabelle fach → tage — für
    auspacken()/verfaelltAm, wo nur die Zahl zählt, nicht wer sie gesetzt hat. */
function fristenTageKarte(): Map<string, number> {
  return new Map(
    db.all<{ fach: string; tage: number }>('SELECT fach, tage FROM post_fristen')
      .map((r) => [r.fach, r.tage]),
  );
}

/** JEDES Fach, mit seiner Frist ODER mit `tage: null` — Grundlage für den
    sichtbaren Hinweis „keine Frist gesetzt" in der Einstellungsansicht. */
export function fristenStand(): FristStand[] {
  const gesetzt = new Map(
    db.all<FristZeile>('SELECT fach, tage, gesetzt_von, gesetzt_am FROM post_fristen')
      .map((r) => [r.fach, r]),
  );
  return ALLE_FAECHER.map((fach) => {
    const z = gesetzt.get(fach);
    return z
      ? { fach, tage: z.tage, gesetztVon: z.gesetzt_von, gesetztAm: z.gesetzt_am }
      : { fach, tage: null, gesetztVon: null, gesetztAm: null };
  });
}

/** Eine Frist setzen oder ändern. `tage` muss eine ganze Zahl ≥ 1 sein. */
export function fristSetzen(fach: string, tage: number, userId: string): FristStand {
  if (!(ALLE_FAECHER as readonly string[]).includes(fach)) {
    throw new PostFehler('post.unbekanntesFach', 'Dieses Fach gibt es nicht.', 400);
  }
  if (!Number.isInteger(tage) || tage < 1) {
    throw new PostFehler('post.ungueltigeFrist',
      'Die Frist muss eine ganze Zahl von mindestens einem Tag sein.', 400);
  }
  const jetzt = Date.now();
  db.run(
    `INSERT INTO post_fristen (fach, tage, gesetzt_von, gesetzt_am) VALUES (?,?,?,?)
     ON CONFLICT(fach) DO UPDATE SET
       tage = excluded.tage, gesetzt_von = excluded.gesetzt_von, gesetzt_am = excluded.gesetzt_am`,
    fach, tage, userId, jetzt,
  );
  return { fach, tage, gesetztVon: userId, gesetztAm: jetzt };
}

/** Die Frist eines Fachs wieder abschalten — ab dann verfällt dort nichts mehr. */
export function fristLoeschen(fach: string): void {
  db.run('DELETE FROM post_fristen WHERE fach = ?', fach);
}

/**
 * Post löschen, deren Frist abgelaufen ist — je Fach, und NUR für Fächer mit
 * gesetzter Frist. Bemisst sich am ALTER der Mail (`am`), nicht an ihrem
 * Zustand: auch gelesene, archivierte oder schon „entfernte" Post verfällt
 * mit — die Frist ist eine Aussage über das Alter der Daten, keine über die
 * Aufmerksamkeit, die ihr bisher jemand geschenkt hat. Ein offener KI-Entwurf
 * zu einer verfallenden Mail geht mit ihr (siehe mailsHartLoeschen() oben) —
 * eine Frist, die auf eine Entscheidung wartet, ist trotzdem eine Frist.
 *
 * Aufgerufen aus dem Hintergrundlauf in ws/gateway.ts (startBackgroundJobs,
 * höchstens einmal am Tag) — und direkt von hier aus für Prüfläufe, die nicht
 * einen Tag auf den nächsten Durchlauf warten wollen.
 *
 * Gibt zurück, wie viele Mails wirklich weg sind — für die Protokollzeile im
 * Aufräumlauf, nach demselben Muster wie vertraulich.abgelaufeneAufraeumen().
 */
export function fristenAnwenden(jetzt = Date.now()): number {
  const fristen = db.all<{ fach: string; tage: number }>('SELECT fach, tage FROM post_fristen');
  if (!fristen.length) return 0;

  let gesamt = 0;
  for (const { fach, tage } of fristen) {
    const grenze = jetzt - tage * TAG_MS;
    const abgelaufen = db.all<{ id: string }>(
      'SELECT id FROM mail_nachrichten WHERE fach = ? AND am < ?', fach, grenze);
    if (!abgelaufen.length) continue;
    gesamt += mailsHartLoeschen(abgelaufen.map((z) => z.id));
  }
  return gesamt;
}

/* ── Anhänge ───────────────────────────────────────────────────
 *
 * Der Inhalt liegt in mail_anhaenge/ablage.ts (art 'mail'), nicht hier —
 * diese drei Funktionen sind die einzige Berührung dieser Datei mit den
 * Bytes selbst: ablegen (eingegangen, s.o., oder gerade erst hochgeladen für
 * einen noch nicht gesendeten Entwurf), ausliefern, verwerfen. Wer eine Mail
 * lesen darf, darf auch ihre Anhänge herunterladen — dieselbe Schwelle
 * (`mail.lesen`), geprüft in der Route, nicht hier: hier steht nur noch die
 * Frage, ob der Anhang überhaupt an einer Mail hängt.
 */

/**
 * Ein Anhang zum Ausliefern — nur wenn er wirklich an einer Mail hängt.
 *
 * Ein noch nicht verknüpfter Anhang (gerade erst hochgeladen, aber noch nicht
 * gesendet) gehört noch niemandem außer seinem Hochlader und läuft nicht über
 * diese Funktion — siehe senden() weiter oben für den Weg, auf dem er an eine
 * Mail kommt. `null` heißt hier immer "gibt es nicht", ohne Unterschied
 * zwischen "nie existiert" und "existiert, aber noch nicht verschickt" — der
 * Unterschied ist für die Auslieferungsroute bedeutungslos, beides ist "noch
 * nicht zu holen".
 */
export function anhangFuerAuslieferung(id: string): {
  id: string; mailId: string; name: string; path: string; encoding: string | null;
} | null {
  const z = db.get<{ id: string; mail_id: string | null; name: string; path: string; encoding: string | null }>(
    'SELECT id, mail_id, name, path, encoding FROM mail_anhaenge WHERE id = ?', id,
  );
  if (!z || !z.mail_id) return null;
  return {
    id: z.id, mailId: z.mail_id, name: z.name, path: z.path, encoding: z.encoding,
  };
}

export interface AusgehenderAnhang { id: string; name: string; mime: string; size: number }

/**
 * Einen Anhang für eine noch nicht gesendete Mail ablegen — vor senden().
 *
 * `mail_id` bleibt NULL, bis senden() ihn tatsächlich verschickt (siehe
 * dort) — dieselbe Reihenfolge wie bei attachments.message_id für den Chat
 * (messages.ts): hochladen, während geschrieben wird; verknüpfen, wenn (und
 * nur wenn) wirklich gesendet wird.
 */
export function ausgehenderAnhangAnlegen(input: {
  /** Von der Route vergeben, VOR dem Schreiben der Datei -- dieselbe Kennung
      benennt Datenbankzeile und Zwischendatei, genau wie bei `/api/uploads`
      für Chatanhänge (siehe dort). */
  id: string;
  name: string; mime: string; size: number; storedPath: string; hochgeladenVon: string;
}): AusgehenderAnhang {
  const { id } = input;
  const name = saubererDateiname(input.name) || 'ohne-namen';
  const mime = input.mime || 'application/octet-stream';
  db.run(
    `INSERT INTO mail_anhaenge (id, mail_id, nummer, name, mime, size, path, encoding, stored_size, uploaded_by, created_at)
     VALUES (?,NULL,0,?,?,?,?,NULL,NULL,?,?)`,
    id, name, mime, input.size, input.storedPath, input.hochgeladenVon, Date.now(),
  );
  ablage.spaeterUebernehmen({ id, art: 'mail', pfad: input.storedPath, mime });
  return {
    id, name, mime, size: input.size,
  };
}

/**
 * Einen noch nicht gesendeten Anhang verwerfen — etwa beim Schließen des
 * Schreibfensters ohne zu senden. Nur der Hochlader selbst, und nur solange
 * er an keiner Mail hängt (dieselbe Regel wie beim Lesen für den Versand,
 * siehe anhaengeZumVersandLesen() weiter oben). `false` heißt: gab es so
 * nicht (falsche Kennung, fremd, oder schon verschickt).
 */
export function ausgehenderAnhangVerwerfen(id: string, userId: string): boolean {
  const z = db.get<{ uploaded_by: string | null; mail_id: string | null; path: string }>(
    'SELECT uploaded_by, mail_id, path FROM mail_anhaenge WHERE id = ?', id,
  );
  if (!z || z.uploaded_by !== userId || z.mail_id !== null) return false;
  ablage.loeschen(id, 'mail');
  db.run('DELETE FROM mail_anhaenge WHERE id = ?', id);
  /* Dieselbe Gegenprobe wie files.ts::deleteFile(): solange die Zerlegung in
     den Blockspeicher noch aussteht, liegt die Datei noch ganz auf der
     Platte, und ablage.loeschen() allein rührt sie nicht an. */
  if (!ablage.nochGebraucht(z.path)) {
    fs.promises.rm(z.path, { force: true }).catch(() => {});
  }
  return true;
}
