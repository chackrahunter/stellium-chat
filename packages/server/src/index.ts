import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { initDb, db } from './db/index.js';
import { verifyToken } from './auth.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import statisch from '@fastify/static';
import { registerRoutes } from './http/routes.js';
import { registerKonsole } from './http/konsole.js';
import { registerPostGedaechtnis } from './http/postgedaechtnis.js';
import { registerEinmalcode } from './http/einmalcode.js';
import { registerPasswoerter } from './http/passwoerter.js';
import { registerRechtstexte } from './http/rechtstexte.js';
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

  einrichtungsRiegel(app);

  await registerRoutes(app);
  await registerKonsole(app);
  /* Das Gedaechtnis der Firmenpost — eigene Datei, damit http/routes.ts
     (2400 Zeilen, gerade an mehreren Stellen in Arbeit) unberuehrt bleibt.
     Dieselbe Machart wie registerKonsole daruber; die Wege haengen unter
     /api/post/wissen und kollidieren mit keiner bestehenden Route. */
  registerPostGedaechtnis(app);
  registerEinmalcode(app);
  registerPasswoerter(app);

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

    // Feste Adressen für Datenschutzerklärung und Nutzungsordnung — vor dem
    // Notfundhandler, damit die Datei beim Lesen "speziell vor allgemein"
    // zeigt (siehe rechtstexte.ts für die Begründung, warum die Reihenfolge
    // dem Router selbst egal ist, aber trotzdem hierhin gehört).
    await registerRechtstexte(app);

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

/* ── Ein Einmal-Passwort reicht nur bis zur Einrichtung ───────────
 *
 * Legt die Leitung ein Konto an oder setzt sie ein Passwort zurück, entsteht
 * ein Einmal-Passwort und `must_change_password` steht auf 1. Die Anmeldung
 * damit gab bis hier ein ganz gewöhnliches Token aus — dieselbe Laufzeit,
 * dieselben Rechte. Dass die Person zuerst ihr eigenes Passwort festlegen
 * muss, stand einzig in der Oberfläche: packages/desktop/src/App.tsx schiebt
 * bei `self.mustChangePassword` den Einrichtungsschirm davor.
 *
 * Nachgemessen war das keine Kleinigkeit. Mit genau diesem Token gingen
 * `GET /api/files`, `GET /api/permissions` und `POST /api/uploads/start`
 * anstandslos durch — 200, jedes Mal. Eine Sperre, die nur der eigene Client
 * kennt, ist keine: curl, ein selbstgebauter Client oder ein Skript kümmern
 * sich nicht darum. Und das Passwort dahinter ist kein Geheimnis der Person,
 * sondern eines der Leitung — sie hat es erzeugt, weitergegeben, und unterwegs
 * stand es im Klartext im Rumpf einer Antwort. Ein Konto, das sein eigenes
 * Passwort noch nie gewählt hat, hatte damit vollen Zugang.
 *
 * WARUM HIER UND NICHT IN http/routes.ts
 * Die Regel gilt für ALLES. Sechsundfünfzig Handler einzeln zu ändern hieße,
 * genau den einen zu vergessen, der nächste Woche dazukommt — und dieser eine
 * wäre dann die ganze Lücke. Ein Haken vor allen Wegen kann nichts auslassen.
 * Neue Routen sind ohne Zutun mitgeschützt; wer eine Route wirklich vor der
 * Einrichtung braucht, muss sie hier bewusst eintragen.
 *
 * WAS OFFEN BLEIBEN MUSS — und warum genau das
 * Eine Sperre, die den Ausweg mitverriegelt, ist schlimmer als die Lücke: ein
 * frisches Konto käme dann nie an den Schirm, der es befreit. Beide Richtungen
 * geprüft — was der Einrichtungsschirm ruft und was die Anmeldung ruft, bevor
 * sie dort ankommt:
 *
 *   GET  /api/me            `boot()` in desktop/src/state/store.ts holt hier
 *                           `self`. Scheitert der Aufruf mit 401/403, wirft
 *                           der Client das Token weg und zeigt wieder die
 *                           Anmeldung — die wieder hierher führt. Endlosschleife
 *                           statt Einrichtung.
 *   POST /api/auth/setup    Der Ausweg selbst (Setup.tsx → api.setup()).
 *                           Gefährlich ist er nicht: das UPDATE in
 *                           users.completeSetup() trägt
 *                           `WHERE … (must_change_password = 1 OR
 *                           must_complete_profile = 1)` und greift damit
 *                           ausschließlich in genau diesem Zustand.
 *   POST /api/auth/password Der zweite Ausweg. Verlangt das bisherige Passwort
 *                           und setzt `must_change_password = 0`. Für einen
 *                           Client ohne Einrichtungsschirm der einzige Weg
 *                           hinaus — ohne ihn hinge er fest.
 *   POST /api/auth/login    Trägt normalerweise gar kein Token, wäre also
 *                           ohnehin nicht betroffen. Steht hier, damit ein
 *                           Client, der einen alten Kopf mitschleppt, sich
 *                           nicht beim Anmelden selbst aussperrt.
 *   POST /api/auth/register Antwortet nur mit „gibt es nicht". Aus demselben
 *                           Grund dabei wie die Anmeldung darüber.
 *   POST /api/auth/anmeldesalz
 *                           Die Wegbeschreibung, mit der eine neue App ihren
 *                           Anmeldenachweis bildet — Teil der Anmeldung
 *                           selbst und damit aus demselben Grund hier wie
 *                           die Anmeldung darüber. Ein Client schickt seine
 *                           Kopfzeile immer mit; schleppt er ein Token aus
 *                           einem Konto mit offener Einrichtung mit, käme
 *                           hier sonst ein 403, und er fiele ohne Not auf
 *                           den Weg mit dem Passwort im Klartext zurück.
 *                           Gefährlich ist er nicht: er gibt ein Salz
 *                           heraus, kein Geheimnis, und er antwortet auf
 *                           jeden Namen gleich — auch auf erfundene.
 *
 *   NICHT dabei: POST /api/auth/nachweis. Wer noch ein Einmal-Passwort hat,
 *   soll dafür keinen Nachweis hinterlegen — er wäre schon beim Anlegen
 *   veraltet, weil das Passwort gleich ersetzt wird. Der Riegel weist ihn
 *   hier von selbst ab, die App fängt das ab und holt es bei der nächsten
 *   Anmeldung nach. Ausgesperrt wird davon niemand.
 *
 *   AUCH NICHT DABEI, UND DAS IST EINE ENTSCHEIDUNG UND KEIN VERSEHEN:
 *   /api/konto/notzugang und alles darunter, ebenso /api/konto/schluessel.
 *
 *   Die Frage stellt sich, weil genau hier die Person steht, die ihr
 *   Passwort vergessen hat: die Verwaltung hat zurückgesetzt, ihre Notizen
 *   und ihr Tresor warten auf drei von fünf Anteilen, und dieser Riegel
 *   lässt sie an keine Tafel. Der Weg dorthin führt trotzdem NICHT durch
 *   eine weitere Ausnahme, sondern durch den Ausgang, der ohnehin da ist:
 *   `api.setup()` setzt das eigene Passwort, `must_change_password` fällt
 *   auf 0, der Riegel geht auf, App.tsx zeigt die gewöhnliche Oberfläche —
 *   und ab da sind Stern-Menü, Tafel und Wiederherstellung erreichbar. Der
 *   Kontoschlüssel überlebt das seit dem Fund an verwerfen()
 *   (services/kontoschluessel.ts): das zweite Verwerfen der Ersteinrichtung
 *   tut nichts mehr, solange ein Notzugang auf das Konto zeigt.
 *   pruefungen/notzugang.mts geht diese Folge Schritt für Schritt.
 *
 *   Die Ausnahme wäre auch nicht harmlos. Wer ein Einmal-Passwort in die
 *   Hände bekommt, könnte eine Wiederherstellung anstoßen und drei Menschen
 *   um ihre Anteile bitten, OHNE vorher das Passwort zu wechseln — also
 *   ohne den einen Schritt, der die rechtmäßige Person sofort aussperrt und
 *   damit auffällt. Der Riegel bleibt zu, und die Wiederherstellung beginnt
 *   erst hinter ihm.
 *
 * Mehr braucht der Einrichtungsschirm nicht: Setup.tsx ruft `api.setup()`,
 * sonst nichts. Was er danach tut (`updatePrefs`, `zeitzoneNachtragen`) läuft
 * über die Ereignisleitung und wartet dort in der Warteschlange von
 * net/socket.ts, bis sie wieder steht — `prefs:update` ist dort ausdrücklich
 * pufferbar. Es geht also nichts verloren.
 *
 * WARUM AUCH `?token=` GEPRÜFT WIRD
 * `/storage/:id` und `/files/:id` nehmen den Nachweis in der Adresse entgegen
 * (bearerOderAdresse() in http/routes.ts), weil ein <img src> keine Kopfzeilen
 * schickt. Nur die Kopfzeile zu prüfen ließe genau die Wege offen, die Bytes
 * herausgeben — der bequemere Weg wäre dann der ungeschützte.
 *
 * WAS HIER ABSICHTLICH FEHLT
 * Eine Wörterbuch-Kennung. Die Oberfläche zeigt zu `code` ihren eigenen Satz;
 * eine neue Kennung müsste in allen 22 Wörterbüchern stehen, sonst schlägt
 * scripts/e2e-fehlertexte.mjs zu Recht an. Die Wörterbücher liegen gerade in
 * anderer Hand, deshalb bleibt es beim deutschen Rückfalltext. Zu sehen
 * bekommt ihn ohnehin nur, wer nicht durch den Einrichtungsschirm geht — der
 * offizielle Client ruft in diesem Zustand nichts von alledem auf.
 * Nachzutragen wäre eine Kennung namens fehler.einrichtungOffen — hier
 * bewusst OHNE Anführungszeichen geschrieben: scripts/e2e-fehlertexte.mjs
 * sammelt Kennungen über die Namensform aus dem Quelltext ein und
 * unterscheidet dabei nicht zwischen Code und Kommentar. In Hochkommata
 * gesetzt gälte sie als verschickt und fehlte prompt in 22 Wörterbüchern.
 */
const OHNE_EINRICHTUNG_ERLAUBT = new Set([
  '/api/me',
  '/api/auth/setup',
  '/api/auth/password',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/anmeldesalz',
]);

/**
 * Der Nachweis, egal auf welchem Weg er mitkommt.
 *
 * Bewusst dieselben zwei Quellen wie bearerOderAdresse() in http/routes.ts.
 * Stünde hier nur die Kopfzeile, wäre die Adresse mit `?token=` der Umweg an
 * dieser Prüfung vorbei — und über sie gehen die Dateibytes hinaus.
 */
function nachweisAus(req: FastifyRequest): string | null {
  const kopf = req.headers.authorization;
  if (kopf?.startsWith('Bearer ')) return kopf.slice(7);
  const ausAdresse = (req.query as { token?: string } | undefined)?.token;
  return typeof ausAdresse === 'string' && ausAdresse ? ausAdresse : null;
}

function einrichtungsRiegel(instanz: typeof app): void {
  instanz.addHook('preHandler', async (req, reply) => {
    // Ohne Fragezeichenteil vergleichen, sonst käme `/api/me?x=1` nicht durch.
    const pfad = req.url.split('?')[0];
    if (OHNE_EINRICHTUNG_ERLAUBT.has(pfad)) return;

    /* Ohne Nachweis nichts tun: ob dieser Weg eine Anmeldung braucht,
       entscheidet die Route selbst — sie antwortet dann mit 401. Hier ginge
       sonst ein zweites, abweichendes Urteil über dieselbe Frage um. */
    const roh = nachweisAus(req);
    if (!roh) return;
    const userId = verifyToken(roh);
    if (!userId) return;

    /* Eine Spalte auf dem Primärschlüssel statt store.getSelf(): das hier
       läuft vor jedem Aufruf, und getSelf() zieht Rechteraster und
       Kanalstände mit. */
    const stand = db.get<{ must_change_password: number }>(
      'SELECT must_change_password FROM users WHERE id = ?', userId,
    );
    if (!stand?.must_change_password) return;

    return reply.code(403).send({
      error: 'Erst die Ersteinrichtung abschließen — mit einem Einmal-Passwort '
        + 'öffnet dieser Zugang sonst nichts.',
    });
  });
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
