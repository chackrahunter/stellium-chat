import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { initDb, db } from './db/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import statisch from '@fastify/static';
import { registerRoutes } from './http/routes.js';
import { registerKonsole } from './http/konsole.js';
import { handleConnection, startBackgroundJobs, anwesenheitZuruecksetzen, verbindungen } from './ws/gateway.js';
import {
  aiCapabilities, anbieterAusEinstellungen, dropForeignTranslations, warmUpModels,
} from './translation/index.js';
import { ensureSeed } from './seed.js';
import { ensureAssistant, repairAssistantChats } from './services/assistant.js';
import * as stimme from './services/stimme.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 2 * 1024 * 1024,
});

async function main(): Promise<void> {
  initDb();
  await ensureSeed();

  // Was in den Einstellungen gewählt wurde, gilt vor der Umgebung — sonst
  // wäre ein Wechsel auf ein lokales Modell nach jedem Neustart weg.
  await anbieterAusEinstellungen();

  // Übersetzungen eines früheren Anbieters wegräumen, bevor jemand sie sieht.
  dropForeignTranslations();

  // Assistent bereitstellen und stumme Chats mit ihm aktivieren.
  ensureAssistant();
  repairAssistantChats();

  // Modell-Liste beim Anbieter holen, damit der erste Chat schon das
  // passende Modell trifft. Schlägt es fehl, greifen die Standardwerte.
  await warmUpModels();

  /* Sprachdienst im Blick behalten. Einmal jetzt, damit die Startmeldung die
     Wahrheit sagt, und danach im Takt — der Dienst darf später kommen und
     zwischendurch weg sein, ohne dass jemand den Chat neu startet. */
  await stimme.erreichbar(true);
  stimme.beobachten();

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

  /* Rohe Datenströme durchlassen, ohne sie vorher in den Speicher zu ziehen.
     Ohne diesen Parser lehnt Fastify die Teile eines großen Uploads mit
     "Unsupported Media Type" ab — er kennt den Typ sonst nicht. */
  app.addContentTypeParser(
    'application/octet-stream',
    (_req, nutzlast, fertig) => { fertig(null, nutzlast); },
  );

  await registerRoutes(app);
  await registerKonsole(app);

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => handleConnection(socket as any));
  });

  /* ── Oberfläche im Browser ─────────────────────────────────────
   *
   * Die Desktop-App bringt ihre Oberfläche mit; wer die Serveradresse
   * dagegen einfach im Browser öffnete, bekam bisher ein nacktes
   * "Route GET:/ not found" — auf dem iPhone der einzige Weg hinein.
   *
   * Liegt der gebaute Client daneben, wird er von hier ausgeliefert. Damit
   * läuft Stellium auf jedem Gerät mit Browser, ohne Installation.
   */
  const oberflaeche = findeOberflaeche();
  if (oberflaeche) {
    await app.register(statisch, { root: oberflaeche, wildcard: false, index: ['index.html'] });

    // Alles, was keine Datei und kein Schnittstellenaufruf ist, bekommt die
    // Startseite — die Oberfläche verwaltet ihre Adressen selbst.
    app.setNotFoundHandler((req, reply) => {
      const pfad = req.url.split('?')[0];
      if (pfad.startsWith('/api/') || pfad.startsWith('/ws')
        || pfad.startsWith('/files/') || pfad.startsWith('/storage/')
        || pfad.startsWith('/releases/')) {
        return reply.code(404).send({ error: 'Nicht gefunden', code: 'fehler.nichtGefunden' });
      }

      /* Auf eine fehlende Datei niemals die Startseite ausliefern.
         Genau das hat einmal echten Schaden angerichtet: nach einem Austausch
         fehlten die alten Bausteine, der Browser bekam auf jede Anfrage nach
         einem Stylesheet die Startseite — und legte diese Antwort ein Jahr
         lang als unveränderlich ab. Danach half kein Neuladen mehr, weil der
         Browser gar nicht erst nachfragte. Ein ehrliches 404 kostet einen
         Fehlversuch, ein falsches HTML kostet die ganze Seite. */
      if (/\.[a-z0-9]{2,5}$/i.test(pfad)) {
        return reply.code(404).send({ error: 'Nicht gefunden', code: 'fehler.nichtGefunden' });
      }

      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    // Ohne gebaute Oberfläche wenigstens eine verständliche Auskunft statt
    // einer Fehlermeldung, mit der niemand etwas anfangen kann.
    app.setNotFoundHandler((req, reply) => {
      const pfad = req.url.split('?')[0];
      if (pfad !== '/') return reply.code(404).send({ error: 'Nicht gefunden', code: 'fehler.nichtGefunden' });
      return reply.type('text/html').send(hinweisSeite());
    });
  }

  // Erst aufräumen, dann horchen: der Stand von vorhin gilt nicht mehr.
  anwesenheitZuruecksetzen();
  const stopJobs = startBackgroundJobs();

  /**
   * Herunterfahren — mit Frist.
   *
   * Hier stand einmal nur `await app.close()`. Das wartet aber darauf, dass
   * alle offenen Verbindungen zu Ende gehen, und ein WebSocket geht nicht von
   * selbst zu Ende: er ist genau dafür gebaut, offen zu bleiben. Also kam der
   * Ablauf nie bei `process.exit(0)` an, und der Prozess überlebte sein
   * SIGTERM. Auf diesem Rechner haben sich so verwaiste Probeserver gesammelt,
   * die dann Ports besetzten und fremde Prüfläufe falsch scheitern ließen —
   * und auf dem Pi bedeutet dasselbe, dass ein `systemctl restart` in seinen
   * eigenen Zeitablauf läuft, statt sauber neu zu starten.
   *
   * Deshalb: ordentlich versuchen, aber nicht ewig. Wer nach der Frist noch
   * hängt, wird beendet. Ein Chat-Server hat nichts, das ein längeres Warten
   * rechtfertigen würde — die Datenbank ist nach jedem Schreibvorgang
   * beständig, offene Sitzungen verbinden sich von selbst neu.
   */
  const FRIST_MS = 4000;
  let faehrtHerunter = false;
  const shutdown = async (signal: string) => {
    if (faehrtHerunter) return; // zweites Signal nicht doppelt abarbeiten
    faehrtHerunter = true;
    console.log(`\n[server] ${signal} — fahre herunter…`);
    stopJobs();

    // Der Notausgang. `unref()`, damit die Frist den Prozess nicht ihrerseits
    // am Leben hält, falls alles andere längst fertig ist.
    const notausgang = setTimeout(() => {
      console.error(`[server] Nach ${FRIST_MS} ms hängt noch etwas — beende hart.`);
      process.exit(0);
    }, FRIST_MS);
    notausgang.unref();

    await app.close().catch(() => {});
    clearTimeout(notausgang);
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  /* Ein Fehler an einer Stelle darf nicht alle anderen mitreißen. Node beendet
     sich bei einer unbehandelten Zurückweisung von sich aus — für einen
     Chat-Server, an dem ein ganzes Team hängt, ist das die falsche Antwort.
     Aufschreiben und weiterlaufen ist hier richtiger. */
  process.on('unhandledRejection', (grund) => {
    console.error('[server] Unbehandelte Zurückweisung:', grund instanceof Error ? grund.stack : grund);
  });
  process.on('uncaughtException', (fehler) => {
    console.error('[server] Unbehandelter Fehler:', fehler.stack ?? fehler.message);
  });

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
    Stimme    ${caps.transcription
    ? `${caps.transcriptionModel} (${caps.transcriptionLokal ? 'auf diesem Rechner' : 'bei Groq'})`
    : 'aus — Sprachnachrichten bleiben ohne Abschrift'}
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

/**
 * Wo liegt die gebaute Oberfläche? Je nachdem, ob aus dem Quelltext oder aus
 * einer Installation gestartet, an unterschiedlichen Stellen.
 */
function findeOberflaeche(): string | null {
  const hier = path.dirname(fileURLToPath(import.meta.url));
  const kandidaten = [
    process.env.STELLIUM_WEB_DIR,
    path.resolve(hier, '../../desktop/dist'),
    path.resolve(hier, '../../../desktop/dist'),
    path.resolve(process.cwd(), 'packages/desktop/dist'),
  ].filter(Boolean) as string[];

  for (const ordner of kandidaten) {
    if (fs.existsSync(path.join(ordner, 'index.html'))) return ordner;
  }
  return null;
}

/** Auskunftsseite, wenn keine Oberfläche mitgeliefert wurde. */
function hinweisSeite(): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stellium</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
         background:#070912; color:#e8eaf2; padding:24px; }
  .k { max-width:34rem; text-align:center; }
  h1 { font-size:22px; margin:0 0 8px; letter-spacing:-.02em; }
  p { color:#9aa0b5; margin:0 0 14px; }
  code { background:#141726; padding:2px 7px; border-radius:6px; font-size:13px; }
</style></head>
<body><div class="k">
  <h1>✦ Stellium</h1>
  <p>Der Server läuft. Eine Oberfläche für den Browser wurde nicht mitgeliefert.</p>
  <p>Öffne Stellium in der App und trage dort unter <b>Einstellungen&nbsp;→&nbsp;Server</b>
     diese Adresse ein.</p>
  <p>Soll es auch im Browser laufen, baue die Oberfläche mit
     <code>npm run build</code> und starte den Server neu.</p>
</div></body></html>`;
}
