/**
 * Das Besuchersignal von Leitwert annehmen. Was gezählt wird und warum ohne
 * Einwilligung, steht in services/webbesuch.ts; ausgegeben werden die Zahlen
 * mit den Systemwerten (routes.ts, /api/systemwerte).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as webbesuch from '../services/webbesuch.js';

/* Nur die eigene Seite darf melden. Wer das Signal von anderswo nachbaut,
   verfälscht bestenfalls eine Statistik — trotzdem kein Grund, es ihm leicht
   zu machen. */
const HERKUNFT = new Set(['https://stellium.club', 'https://www.stellium.club']);

function kopf(req: FastifyRequest, name: string): string | null {
  const w = req.headers[name];
  return typeof w === 'string' ? w : null;
}

/* Der Tunnel liefert alles von 127.0.0.1 ab; die echte Adresse setzt
   Cloudflare in eine Kopfzeile. Nur dann glauben, wenn die Anfrage wirklich
   vom Tunnel kommt — sonst könnte jeder sie mitschicken. */
function adresse(req: FastifyRequest): string {
  const tunnel = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  return (tunnel && kopf(req, 'cf-connecting-ip')) || req.ip;
}

export function registerWebbesuch(app: FastifyInstance): void {
  /* sendBeacon schickt text/plain — das ist eine „einfache" Anfrage ohne
     Vorabfrage, und Fastify liest sie von Haus aus als Zeichenkette. Immer
     204 und kein Wort dazu: wer verworfen wurde, soll es nicht merken. */
  app.post('/api/besuch', { bodyLimit: 2048 }, async (req, reply) => {
    reply.code(204);
    if (!HERKUNFT.has(kopf(req, 'origin') ?? '')) return;
    let k: { p?: unknown; a?: unknown } = {};
    try {
      k = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body as typeof k) ?? {};
    } catch { return; }
    webbesuch.aufnehmen({
      adresse: adresse(req),
      browser: kopf(req, 'user-agent') ?? '',
      pfad: k.p,
      aufruf: k.a === 1,
    });
  });
}
