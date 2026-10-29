/**
 * Die Besucher von stellium.club — Signal annehmen, Zahlen ausgeben.
 *
 * Eigene Datei nach dem Vorbild von http/einmalcode.ts, mit einer Zeile in
 * index.ts eingehängt. Was gezählt wird und warum ohne Einwilligung, steht in
 * services/webbesuch.ts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyToken } from '../auth.js';
import { may } from '../services/users.js';
import * as webbesuch from '../services/webbesuch.js';
import * as systemwerte from '../services/systemwerte.js';
import { keinZwischenspeicher } from './kein-zwischenspeicher.js';

/* Nur die eigene Seite darf melden. Wer das Signal von anderswo nachbaut,
   verfälscht bestenfalls eine Statistik — trotzdem kein Grund, es ihm leicht
   zu machen. */
const HERKUNFT = new Set(['https://stellium.club', 'https://www.stellium.club']);

function anmeldung(req: FastifyRequest): string | null {
  const roh = req.headers.authorization;
  return roh?.startsWith('Bearer ') ? verifyToken(roh.slice(7)) : null;
}

/* Der Tunnel liefert alles von 127.0.0.1 ab; die echte Adresse und das Land
   setzt Cloudflare in die Kopfzeilen. Nur dann glauben, wenn die Anfrage
   wirklich vom Tunnel kommt — sonst könnte jeder sie mitschicken. */
function vomTunnel(req: FastifyRequest): boolean {
  return req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
}

function kopf(req: FastifyRequest, name: string): string | null {
  const w = req.headers[name];
  return typeof w === 'string' ? w : null;
}

export function registerWebbesuch(app: FastifyInstance): void {
  /* sendBeacon schickt text/plain — das ist eine „einfache" Anfrage ohne
     Vorabfrage, und Fastify liest sie von Haus aus als Zeichenkette. Immer
     204 und kein Wort dazu: wer verworfen wurde, soll es nicht merken. */
  app.post('/api/besuch', { bodyLimit: 2048 }, async (req, reply) => {
    reply.code(204);
    if (!HERKUNFT.has(kopf(req, 'origin') ?? '')) return;
    let k: { p?: unknown; s?: unknown; a?: unknown } = {};
    try {
      k = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof k) ?? {};
    } catch { return; }
    const tunnel = vomTunnel(req);
    webbesuch.aufnehmen({
      adresse: (tunnel && kopf(req, 'cf-connecting-ip')) || req.ip,
      browser: kopf(req, 'user-agent') ?? '',
      land: tunnel ? kopf(req, 'cf-ipcountry') : null,
      pfad: k.p,
      sprache: k.s,
      aufruf: k.a === 1,
    });
  });

  /* Dieselbe Schwelle wie /api/systemwerte: der Hinweis zu `system.ansehen`
     verspricht ausdrücklich „Besucher". */
  app.get('/api/webbesuch', async (req, reply) => {
    const wer = anmeldung(req);
    if (!wer) return reply.code(401).send({ error: 'Nicht angemeldet', code: 'fehler.nichtAngemeldet' });
    if (!may(wer, 'system.ansehen')) {
      return reply.code(403).send({ error: 'Die Besucherzahlen sieht nur, wer die Systemwerte sehen darf.',
        code: 'perm.system.ansehen.label' });
    }
    keinZwischenspeicher(reply);
    /* „Insgesamt jemals" kennt nur das Protokoll — das Signal gibt es erst
       seit seinem Einbau. Fehlt die Konsole, fehlt eben diese eine Zahl. */
    let protokoll: unknown = null;
    if (systemwerte.verfuegbar()) {
      try {
        const w = (await systemwerte.werte() as { webseite?: { gesamt?: unknown; geteiltZeit?: number } }).webseite;
        if (w?.gesamt) protokoll = { gesamt: w.gesamt, stand: w.geteiltZeit ?? Date.now() };
      } catch { /* bleibt null */ }
    }
    return { ...webbesuch.zahlen(), protokoll };
  });
}
