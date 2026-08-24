import dns from 'node:dns/promises';
import net from 'node:net';
import type { LinkPreview } from '@stellium/shared';
import { db } from '../db/index.js';
import { sha1 } from '../util/id.js';

/**
 * Holt Titel und Beschreibung zu Links, die jemand in den Chat stellt.
 *
 * Der Server ruft hier URLs ab, die Nutzer bestimmen — deshalb wird geprüft,
 * dass das Ziel nicht im internen Netz liegt. Sonst könnte man den Server als
 * Sprungbrett auf interne Dienste benutzen.
 *
 * WAS DIE PRÜFUNG LEISTET — und was nicht
 *
 * Geprüft wird JEDER Sprung, nicht nur der erste. Umleitungen folgt der
 * Server selbst (`redirect: 'manual'`), und vor jedem Folgen läuft
 * targetIsSafe() erneut: Schema muss http/https bleiben, der Hostname darf
 * weder als IP noch nach DNS-Auflösung im internen Netz liegen. Relative
 * Location-Angaben werden vorher gegen die aktuelle URL aufgelöst. Die Kette
 * ist auf MAX_UMLEITUNGEN Sprünge begrenzt und teilt sich EIN Zeitlimit —
 * eine Kette darf das Budget nicht vervielfachen.
 *
 * NICHT abgedeckt ist DNS-Rebinding: ein Hostname, der bei der Prüfung eine
 * öffentliche und beim Verbinden eine interne Adresse liefert, kommt weiterhin
 * durch. Dagegen hülfe nur, die geprüfte Adresse in die Verbindung zu zwingen
 * (eigener Socket statt fetch) — das kann Nodes fetch nicht. Der Schaden
 * bliebe auch dann klein: zurück kommen nur <title> und og:*, und nur bei
 * text/html. Es ist ein blindes GET zur Erkundung, kein Datenkanal.
 */

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 6_000;
const CACHE_TTL = 7 * 86_400_000;

/**
 * Wie viele Umleitungen der Server folgt, bevor er aufgibt.
 *
 * Echte Vorschau-Links brauchen selten mehr als drei: http->https, nackte
 * Domain->www, Kurzlink->Ziel, dazu eine Sprach-/Regionsweiche. Fünf lässt
 * dafür Luft und deckelt den schlimmsten Fall bei sechs Abrufen — auf einem
 * Raspberry Pi zählt jeder davon, und eine endlose Kette wäre ein Selbst-DoS.
 */
const MAX_UMLEITUNGEN = 5;

/** Statuscodes, denen auch ein Browser folgt. 300 und 304 gehören nicht dazu. */
function istUmleitung(status: number): boolean {
  return status === 301 || status === 302 || status === 303
    || status === 307 || status === 308;
}

export function extractUrls(text: string): string[] {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  const found = withoutCode.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const clean = found
    .map((u) => u.replace(/[.,;:!?]+$/, ''))
    .filter((u) => u.length < 2000);
  return [...new Set(clean)].slice(0, 3);   // höchstens drei Vorschauen pro Nachricht
}

/** Zeigt die Adresse ins interne Netz? Dann nicht abrufen. */
function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower === '::'
    || lower.startsWith('fc') || lower.startsWith('fd')     // eindeutig lokal
    || lower.startsWith('fe80')                              // link-local
    || lower.startsWith('::ffff:');                          // IPv4 in IPv6-Schreibweise
}

/** Zeigt das Ziel ins interne Netz oder auf ein fremdes Schema? Dann nicht abrufen.
 *  Exportiert, damit der Prüflauf gegen die ECHTE Prüfung laufen kann. */
export async function targetIsSafe(url: URL): Promise<boolean> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (net.isIP(url.hostname) && isPrivateAddress(url.hostname)) return false;
  try {
    const records = await dns.lookup(url.hostname, { all: true });
    return records.length > 0 && !records.some((r) => isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

/**
 * Ruft `start` ab und folgt Umleitungen SELBST, damit vor jedem Sprung wieder
 * geprüft werden kann. `redirect: 'follow'` würde Node die Folgesprünge
 * überlassen — und damit an targetIsSafe() vorbeiführen: eine öffentliche
 * Seite, die mit `302 -> http://192.168.1.1/` antwortet, stünde sonst direkt
 * im Heimnetz des Pi.
 *
 * `init.signal` gilt für die ganze Kette, nicht pro Sprung — sonst könnte eine
 * lange Kette das Zeitlimit vervielfachen.
 *
 * `istSicher` ist nur für den Prüflauf da: der braucht einen lokalen
 * Attrappenserver, der als „öffentlich" durchgeht, während für alle anderen
 * Ziele die echte Prüfung entscheidet. Im Betrieb greift immer targetIsSafe().
 *
 * Gibt `null` zurück, wenn ein Sprung abgelehnt wurde oder die Kette zu lang
 * war — ununterscheidbar für die aufrufende Seite, dort wird ohnehin nur
 * „keine Vorschau" daraus.
 */
export async function holeMitUmleitungspruefung(
  start: URL,
  init: RequestInit,
  istSicher: (url: URL) => Promise<boolean> = targetIsSafe,
): Promise<{ antwort: Response; endUrl: string } | null> {
  let aktuell = start;
  // <= : ein Abruf für den Start, dann höchstens MAX_UMLEITUNGEN weitere.
  for (let sprung = 0; sprung <= MAX_UMLEITUNGEN; sprung++) {
    const antwort = await fetch(aktuell, { ...init, redirect: 'manual' });
    if (!istUmleitung(antwort.status)) return { antwort, endUrl: aktuell.toString() };

    const location = antwort.headers.get('location');
    // Der Körper einer Umleitung interessiert nicht — Verbindung freigeben,
    // sonst hängt sie auf dem Pi bis zum Zeitlimit.
    void antwort.body?.cancel().catch(() => {});
    if (!location) return null;

    let naechste: URL;
    // Relative Location ist erlaubt und üblich ("/de/", "../ziel") — gegen die
    // AKTUELLE URL auflösen, nicht gegen die ursprüngliche.
    try { naechste = new URL(location, aktuell); } catch { return null; }
    if (!(await istSicher(naechste))) return null;
    aktuell = naechste;
  }
  return null;   // Grenze erreicht: sauber aufgeben statt endlos weiterlaufen
}

export async function fetchPreview(rawUrl: string): Promise<LinkPreview | null> {
  const hash = sha1(rawUrl);
  const cached = db.get<any>('SELECT * FROM link_previews WHERE url_hash = ?', hash);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL) {
    return cached.ok ? toPreview(cached) : null;
  }

  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!(await targetIsSafe(url))) {
    remember(hash, rawUrl, null, false);
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const geholt = await holeMitUmleitungspruefung(url, {
      signal: ctrl.signal,
      headers: {
        // Ohne User-Agent liefern viele Seiten keine Metadaten aus.
        'user-agent': 'Mozilla/5.0 (compatible; StelliumBot/1.0; +Link-Vorschau)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!geholt) { remember(hash, rawUrl, null, false); return null; }
    const { antwort: res, endUrl } = geholt;
    if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      void res.body?.cancel().catch(() => {});
      remember(hash, rawUrl, null, false);
      return null;
    }

    // Nur den Anfang lesen — die Metadaten stehen im <head>.
    const reader = res.body?.getReader();
    if (!reader) { remember(hash, rawUrl, null, false); return null; }
    const chunks: Uint8Array[] = [];
    let total = 0;
    /* Nur das NEUE Stück nach </head> absuchen, mit ein paar Zeichen Überlappung
       zum vorigen — der Tag kann auf einer Stückgrenze zerfallen. Vorher wurde
       bei jedem Stück der ganze Puffer neu zusammengesetzt und dekodiert; bei
       512 KB in kleinen Stücken ist das quadratisch und würde den Pi allein
       durch eine langsam tröpfelnde Seite beschäftigen. latin1, weil das Byte
       für Byte dekodiert und an einer zerschnittenen UTF-8-Folge nicht
       stolpert — </head> ist ohnehin reines ASCII. */
    let ueberlappung = '';
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      const stueck = ueberlappung + Buffer.from(value).toString('latin1');
      if (/<\/head>/i.test(stueck)) break;
      ueberlappung = stueck.slice(-8);
    }
    void reader.cancel().catch(() => {});

    const html = Buffer.concat(chunks).toString('utf8');
    const preview = parseHtml(html, endUrl || rawUrl);
    remember(hash, rawUrl, preview, true);
    return preview;
  } catch {
    remember(hash, rawUrl, null, false);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseHtml(html: string, finalUrl: string): LinkPreview {
  const meta = (...names: string[]): string | null => {
    for (const name of names) {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
      const alt = new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
      const m = re.exec(html) ?? alt.exec(html);
      if (m?.[1]) return decodeEntities(m[1]).slice(0, 400);
    }
    return null;
  };

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let image = meta('og:image', 'twitter:image');
  if (image) {
    /* Die Bildadresse kommt aus fremdem HTML und wird später von JEDEM Client
       geladen. Nur http/https durchlassen: sonst könnte eine Seite mit
       og:image="data:..." oder einem file:-Verweis die Clients steuern. Der
       Server ruft das Bild selbst nie ab — gegen ein Ziel im LAN der Clients
       hilft diese Prüfung folglich nicht. */
    try {
      const ziel = new URL(image, finalUrl);
      image = ziel.protocol === 'http:' || ziel.protocol === 'https:' ? ziel.toString() : null;
    } catch { image = null; }
  }

  return {
    url: finalUrl,
    title: meta('og:title', 'twitter:title') ?? (titleTag ? decodeEntities(titleTag[1].trim()).slice(0, 200) : null),
    description: meta('og:description', 'twitter:description', 'description'),
    image,
    site: meta('og:site_name') ?? new URL(finalUrl).hostname.replace(/^www\./, ''),
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    /* fromCodePoint wirft bei Werten über 0x10FFFF. Eine Seite mit
       "&#99999999;" im Titel hätte damit die ganze Vorschau verschluckt —
       lieber die Zeichenfolge stehen lassen. */
    .replace(/&#(\d+);/g, (ganz, d) => {
      const nr = Number(d);
      return nr <= 0x10ffff ? String.fromCodePoint(nr) : ganz;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function remember(hash: string, url: string, preview: LinkPreview | null, ok: boolean): void {
  db.run(
    `INSERT INTO link_previews (url_hash, url, title, description, image, site, ok, fetched_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(url_hash) DO UPDATE SET
       title = excluded.title, description = excluded.description, image = excluded.image,
       site = excluded.site, ok = excluded.ok, fetched_at = excluded.fetched_at`,
    hash, url, preview?.title ?? null, preview?.description ?? null,
    preview?.image ?? null, preview?.site ?? null, ok ? 1 : 0, Date.now(),
  );
}

function toPreview(row: any): LinkPreview {
  return {
    url: row.url, title: row.title, description: row.description,
    image: row.image, site: row.site,
  };
}

export function linkPreviewsFor(messageId: string): LinkPreview[] {
  return db.all<any>(
    `SELECT p.* FROM message_links l JOIN link_previews p ON p.url_hash = l.url_hash
     WHERE l.message_id = ? AND p.ok = 1 ORDER BY l.position`, messageId,
  ).map(toPreview);
}

/** Vorschauen für eine Nachricht holen und zuordnen. */
export async function attachPreviews(messageId: string, text: string): Promise<LinkPreview[]> {
  const urls = extractUrls(text);
  if (!urls.length) return [];
  const out: LinkPreview[] = [];
  for (const [position, url] of urls.entries()) {
    const preview = await fetchPreview(url);
    if (!preview) continue;
    db.run('INSERT OR IGNORE INTO message_links (message_id, url_hash, position) VALUES (?,?,?)',
      messageId, sha1(url), position);
    out.push(preview);
  }
  return out;
}
