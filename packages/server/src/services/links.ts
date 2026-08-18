import dns from 'node:dns/promises';
import net from 'node:net';
import type { LinkPreview } from '@stellium/shared';
import { db } from '../db/index.js';
import { sha1 } from '../util/id.js';

/**
 * Holt Titel und Beschreibung zu Links, die jemand in den Chat stellt.
 *
 * Der Server ruft hier URLs ab, die Nutzer bestimmen — deshalb wird vorher
 * geprüft, dass das Ziel nicht im internen Netz liegt. Sonst könnte man den
 * Server als Sprungbrett auf interne Dienste benutzen.
 */

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 6_000;
const CACHE_TTL = 7 * 86_400_000;

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

async function targetIsSafe(url: URL): Promise<boolean> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (net.isIP(url.hostname) && isPrivateAddress(url.hostname)) return false;
  try {
    const records = await dns.lookup(url.hostname, { all: true });
    return records.length > 0 && !records.some((r) => isPrivateAddress(r.address));
  } catch {
    return false;
  }
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
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // Ohne User-Agent liefern viele Seiten keine Metadaten aus.
        'user-agent': 'Mozilla/5.0 (compatible; StelliumBot/1.0; +Link-Vorschau)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') ?? '')) {
      remember(hash, rawUrl, null, false);
      return null;
    }

    // Nur den Anfang lesen — die Metadaten stehen im <head>.
    const reader = res.body?.getReader();
    if (!reader) { remember(hash, rawUrl, null, false); return null; }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (/<\/head>/i.test(Buffer.concat(chunks).toString('utf8'))) break;
    }
    void reader.cancel().catch(() => {});

    const html = Buffer.concat(chunks).toString('utf8');
    const preview = parseHtml(html, res.url || rawUrl);
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
    try { image = new URL(image, finalUrl).toString(); } catch { image = null; }
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
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
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
