/**
 * Wer gerade Leitwert benutzt (stellium.club/leitwert/) — gezählt aus einem
 * kleinen Signal der Seite selbst.
 *
 * Warum nicht aus dem Zugriffsprotokoll wie die Webseite in den Systemwerten
 * (stellium-konsole.mjs): Leitwert ist eine Anwendung auf einer Seite. Das
 * Protokoll sieht dort vor allem Schnittstellenabrufe und Klangdateien, aber
 * keine Besucher. Das Signal kommt beim Öffnen und danach jede Minute,
 * solange die Seite sichtbar ist (oberflaeche/gemeinsam/besuch.js im
 * Konto-Repo).
 *
 * Datenschutz, damit es keine Einwilligung braucht: auf dem Gerät wird nichts
 * gespeichert (kein Cookie, kein Web Storage). Wiedererkannt wird über einen
 * Hash aus Adresse und Browsername mit einem Salz, das nur im Speicher liegt
 * und jeden Tag neu gewürfelt wird — dasselbe Verfahren wie Plausible. Weder
 * Adresse, Browsername noch Hash landen je auf der Platte; dort stehen nur
 * Tagessummen.
 */
import crypto from 'node:crypto';
import { db } from '../db/index.js';

/* Berliner Tage statt UTC (praesenz.ts) oder der Ortszeit des Pi (Alaska):
   „heute" soll um Mitternacht dort anfangen, wo die Zahlen gelesen werden. */
const TAGFORMAT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
export function tagVon(ms: number = Date.now()): string {
  return TAGFORMAT.format(ms);
}

/* „Gerade da" zählt offene Seiten, nicht Personen: jede geöffnete Seite
   trägt eine Zufallskennung, die nur in ihrem Speicher lebt, meldet sich alle
   15 Sekunden und beim Schließen oder Wegschalten ab. Wer ohne Abmeldung
   verschwindet (Akku leer, Netz weg), fällt nach 45 Sekunden heraus — ein
   verlorenes Lebenszeichen hält das aus. */
const LIVE_MS = 45_000;
const JE_MINUTE = 120;         // mehr Signale je Adresse und Minute sind kein Mensch (ein Netz kann viele Geräte haben)

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

function zaehlen(tag: string, art: 'besucher' | 'aufrufe'): void {
  db.run(
    `INSERT INTO webbesuch_tage (tag, art, wert, anzahl) VALUES (?, ?, '', 1)
     ON CONFLICT(tag, art, wert) DO UPDATE SET anzahl = anzahl + 1`,
    tag, art,
  );
}

const MASCHINE = /bot|crawl|spider|slurp|headless|lighthouse|preview|python|curl|wget|httpclient/i;

export interface Signal {
  adresse: string;
  browser: string;
  pfad: unknown;
  /** Zufallskennung der offenen Seite. */
  seite?: unknown;
  /** true beim Öffnen der Seite, false beim Lebenszeichen danach. */
  aufruf: boolean;
  /** true, wenn die Seite geschlossen oder weggeschaltet wurde. */
  weg?: boolean;
}

/** Ein Signal verbuchen. Was nicht von Leitwert kommt, wird still verworfen. */
export function aufnehmen(s: Signal): void {
  if (!s.adresse || !s.browser || MASCHINE.test(s.browser)) return;
  if (typeof s.pfad !== 'string' || !s.pfad.startsWith('/leitwert/')) return;

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
  const seite = typeof s.seite === 'string' && /^[a-z0-9-]{8,40}$/i.test(s.seite) ? s.seite : k;
  if (s.weg) { live.delete(seite); return; }
  live.set(seite, jetzt);
  const tag = tagVon(jetzt);
  if (!heuteGesehen.has(k)) {
    // ponytail: nach einem Neustart des Servers zählt, wer heute schon da war, ein zweites Mal — selten, und besser als Kennungen auf die Platte zu schreiben.
    heuteGesehen.add(k);
    zaehlen(tag, 'besucher');
  }
  if (s.aufruf) zaehlen(tag, 'aufrufe');
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

/**
 * Die Zahlen für die Systemwerte. „Besucher" über mehrere Tage ist die Summe
 * der Tagesbesucher — wer an drei Tagen kommt, zählt dreimal. Mehr gibt ein
 * täglich wechselndes Salz nicht her, und genau das ist gewollt.
 */
export function zahlen() {
  const tagMinus = (n: number) => tagVon(Date.now() - n * 86_400_000);
  const zeitraum = (ab: string) => ({ besucher: summe('besucher', ab), aufrufe: summe('aufrufe', ab) });
  return {
    jetzt: liveZahl(),
    seit: db.get<{ t: string | null }>('SELECT MIN(tag) AS t FROM webbesuch_tage')!.t,
    heute: zeitraum(tagVon()),
    woche: zeitraum(tagMinus(6)),
    monat: zeitraum(tagMinus(29)),
    gesamt: zeitraum(''),
  };
}
