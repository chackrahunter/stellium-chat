import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { initDb, db } from './db/index.js';
import { registerRoutes } from './http/routes.js';
import { handleConnection, startBackgroundJobs } from './ws/gateway.js';
import { aiCapabilities, warmUpModels } from './translation/index.js';
import { ensureSeed } from './seed.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 2 * 1024 * 1024,
});

async function main(): Promise<void> {
  initDb();
  await ensureSeed();

  // Modell-Liste beim Anbieter holen, damit der erste Chat schon das
  // passende Modell trifft. Schlägt es fehl, greifen die Standardwerte.
  await warmUpModels();

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  await registerRoutes(app);

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => handleConnection(socket as any));
  });

  const stopJobs = startBackgroundJobs();

  const shutdown = async (signal: string) => {
    console.log(`\n[server] ${signal} — fahre herunter…`);
    stopJobs();
    await app.close().catch(() => {});
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });

  const caps = aiCapabilities();
  console.log(`
  ✦ Stellium Server läuft
    HTTP      http://localhost:${config.port}
    WebSocket ws://localhost:${config.port}/ws
    Daten     ${config.dbFile}
    Volltext  ${db.fts ? 'FTS5' : 'LIKE (FTS5 nicht verfügbar)'}
    KI        ${caps.provider} — Übersetzung ${caps.translation ? 'an' : 'aus'}, Assistent ${caps.assistant ? 'an' : 'aus'}
${caps.model ? `    Modelle   ${caps.model} (Übersetzung/Zusammenfassung)\n              ${caps.fastModel} (Antwortvorschläge)\n              ${describeSource(caps.modelSource, caps.modelsAvailable)}\n` : ''}
${caps.note ? `    Hinweis   ${caps.note}\n` : ''}`);
}

function describeSource(source: string | null, available: number | null): string {
  if (source === 'auto') return `automatisch gewählt aus ${available ?? '?'} verfügbaren Modellen`;
  if (source === 'pinned') return 'per .env festgelegt';
  if (source === 'fallback') return 'Standardwerte — Modell-Liste war nicht abrufbar';
  return '';
}

main().catch((err) => {
  console.error('[server] Start fehlgeschlagen:', err);
  process.exit(1);
});
