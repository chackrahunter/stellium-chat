/**
 * Wer gerade auf stellium.club ist — gezählt aus einem kleinen Signal der
 * Seite selbst, nicht aus dem Protokoll.
 *
 * Warum zusätzlich zum Zugriffsprotokoll (stellium-konsole.mjs): das zählt
 * jeden Abruf, den Caddy sieht — auch Abfragen der Konto-Schnittstelle und
 * Maschinen mit gewöhnlichem Browsernamen —, und es sieht nichts, was
 * Cloudflare aus dem Zwischenspeicher beantwortet. Das Signal kommt nur von
 * Seiten, die wirklich in einem Browser mit JavaScript geöffnet wurden.
 * Außerdem darf der Chat-Server das Protokoll nicht lesen und bekommt dessen
 * Zahlen nur, wenn ein anderer Lauf sie hinterlegt hat.
 *
 * Datenschutz, damit es keine Einwilligung braucht: auf dem Gerät wird nichts
 * gespeichert (kein Cookie, kein Web Storage). Wiedererkannt wird über einen
 * Hash aus Adresse und Browsername mit einem Salz, das nur im Speicher liegt
 * und jeden Tag neu gewürfelt wird — dasselbe Verfahren wie Plausible. Weder
 * Adresse, Browsername noch Hash landen je auf der Platte; dort stehen nur
 * Tagessummen (Besucher, Aufrufe, Seiten, Länder, Sprachen, Gerätearten).
 */
import crypto from 'node:crypto';
import { db } from '../db/index.js';

/* Berliner Tage statt UTC (praesenz.ts) oder der Ortszeit des Pi (Alaska):
   „heute" soll um Mitternacht dort anfangen, wo die Zahlen gelesen werden. */
const TAGFORMAT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
export function tagVon(ms: number = Date.now()): string {
  return TAGFORMAT.format(ms);
}

const LIVE_MS = 5 * 60_000;
const PFADE_JE_TAG = 300;      // Klopfer mit erfundenen Pfaden sollen die Tabelle nicht aufblähen
const JE_MINUTE = 30;          // mehr Signale je Adresse und Minute sind kein Mensch

let salz = { tag: '', wert: '' };
const heuteGesehen = new Set<string>();
const live = new Map<string, number>();
const takt = new Map<string, { minute: number; n: number }>();

function kennung(adresse: string, browser: string): string {
  const tag = tagVon();
  if (salz.tag !== tag) {
    salz = { tag, wert: crypto.randomBytes(16).toString('hex') };
    heuteGesehen.clear();
  }
  return crypto.createHash('sha256').update(`${salz.wert}|${adresse}|${browser}`).digest('hex').slice(0, 20);
}

function zaehlen(tag: string, art: string, wert: string, n = 1): void {
  db.run(
    `INSERT INTO webbesuch_tage (tag, art, wert, anzahl) VALUES (?, ?, ?, ?)
     ON CONFLICT(tag, art, wert) DO UPDATE SET anzahl = anzahl + excluded.anzahl`,
    tag, art, wert, n,
  );
}

export function geraetVon(browser: string): 'mobil' | 'tablet' | 'desktop' {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(browser)) return 'tablet';
  if (/Mobi|iPhone|Android/i.test(browser)) return 'mobil';
  return 'desktop';
}

const MASCHINE = /bot|crawl|spider|slurp|headless|lighthouse|preview|python|curl|wget|httpclient/i;

/** Pfad auf eine Form bringen, die sich zu zählen lohnt — oder verwerfen. */
export function pfadSaeubern(roh: unknown): string | null {
  if (typeof roh !== 'string' || !roh.startsWith('/')) return null;
  const p = roh.split(/[?#]/)[0].toLowerCase().slice(0, 120);
  return /^[a-z0-9/_.\-%]+$/.test(p) ? p : null;
}

export interface Signal {
  adresse: string;
  browser: string;
  land: string | null;
  pfad: unknown;
  sprache: unknown;
  /** true beim Laden einer Seite, false beim Lebenszeichen danach. */
  aufruf: boolean;
}

/** Ein Signal verbuchen. Was nicht passt, wird still verworfen. */
export function aufnehmen(s: Signal): void {
  if (!s.adresse || !s.browser || MASCHINE.test(s.browser)) return;
  const pfad = pfadSaeubern(s.pfad);
  if (!pfad) return;

  const jetzt = Date.now();
  const minute = Math.floor(jetzt / 60_000);
  const t = takt.get(s.adresse);
  if (t && t.minute === minute) { if (++t.n > JE_MINUTE) return; }
  else {
    // ponytail: Aufräumen nur beim Minutenwechsel einer Adresse; reicht bei ein paar hundert Besuchern am Tag.
    if (takt.size > 5000) takt.clear();
    takt.set(s.adresse, { minute, n: 1 });
  }

  const k = kennung(s.adresse, s.browser);
  live.set(k, jetzt);
  const tag = tagVon(jetzt);

  db.transaction(() => {
    if (!heuteGesehen.has(k)) {
      // ponytail: nach einem Neustart des Servers zählt, wer heute schon da war, ein zweites Mal — selten, und besser als Kennungen auf die Platte zu schreiben.
      heuteGesehen.add(k);
      zaehlen(tag, 'besucher', '');
      const sprache = typeof s.sprache === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i.test(s.sprache)
        ? s.sprache.toLowerCase() : '?';
      zaehlen(tag, 'sprache', sprache);
      zaehlen(tag, 'land', s.land && /^[A-Z]{2}$/.test(s.land) && s.land !== 'XX' ? s.land : '?');
      zaehlen(tag, 'geraet', geraetVon(s.browser));
    }
    if (s.aufruf) {
      zaehlen(tag, 'aufrufe', '');
      const bekannt = db.get('SELECT 1 FROM webbesuch_tage WHERE tag = ? AND art = ? AND wert = ?', tag, 'pfad', pfad);
      const anzahl = bekannt ? 0 : db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM webbesuch_tage WHERE tag = ? AND art = 'pfad'", tag)!.n;
      zaehlen(tag, 'pfad', anzahl >= PFADE_JE_TAG ? '(andere)' : pfad);
    }
  });
}

function liveZahl(): number {
  const grenze = Date.now() - LIVE_MS;
  for (const [k, t] of live) if (t < grenze) live.delete(k);
  return live.size;
}

function summe(art: string, abTag: string): number {
  return db.get<{ s: number }>(
    'SELECT COALESCE(SUM(anzahl), 0) AS s FROM webbesuch_tage WHERE art = ? AND tag >= ?', art, abTag,
  )!.s;
}

function rangliste(art: string, abTag: string, grenze = 10): [string, number][] {
  return db.all<{ wert: string; s: number }>(
    `SELECT wert, SUM(anzahl) AS s FROM webbesuch_tage WHERE art = ? AND tag >= ?
     GROUP BY wert ORDER BY s DESC, wert LIMIT ?`, art, abTag, grenze,
  ).map((r) => [r.wert, r.s]);
}

/**
 * Alle Zahlen für die Anzeige. „Besucher" über mehrere Tage ist die Summe der
 * Tagesbesucher — wer an drei Tagen kommt, zählt dreimal. Mehr gibt ein
 * täglich wechselndes Salz nicht her, und genau das ist gewollt.
 */
export function zahlen() {
  const tagMinus = (n: number) => tagVon(Date.now() - n * 86_400_000);
  const heute = tagVon();
  const ab30 = tagMinus(29);
  const zeitraum = (ab: string) => ({ besucher: summe('besucher', ab), aufrufe: summe('aufrufe', ab) });

  return {
    jetzt: liveZahl(),
    seit: db.get<{ t: string | null }>('SELECT MIN(tag) AS t FROM webbesuch_tage')!.t,
    heute: zeitraum(heute),
    tage7: zeitraum(tagMinus(6)),
    tage30: zeitraum(ab30),
    gesamt: zeitraum(''),
    seiten: rangliste('pfad', ab30),
    laender: rangliste('land', ab30),
    sprachen: rangliste('sprache', ab30),
    geraete: rangliste('geraet', ab30, 3),
  };
}
