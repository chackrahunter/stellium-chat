import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { normalizeLang, LANGUAGES } from '@stellium/shared';
import { signToken, verifyPassword, verifyToken } from '../auth.js';
import * as users from '../services/users.js';
import { may } from '../services/users.js';
import { PERMISSIONS, type MemberRole, type PermissionKey } from '@stellium/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { addGlossaryEntry, aiCapabilities, chooseModels, listGlossary, modelRegistry, removeGlossaryEntry } from '../translation/index.js';
import { search } from '../services/search.js';
import * as store from '../services/store.js';
import * as files from '../services/files.js';
import * as releases from '../services/releases.js';

import { broadcastAll } from '../ws/gateway.js';

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyToken(header.slice(7));
}

/**
 * Anmeldung für Abrufe, die ein Browser selbst auslöst.
 *
 * Ein <a href> und ein <img src> schicken keine Kopfzeilen mit. Für
 * Downloads und Vorschaubilder muss der Nachweis deshalb in die Adresse —
 * sonst bliebe der Knopf "Herunterladen" wirkungslos, was er bis eben war.
 *
 * Nur für lesende Abrufe, nie für etwas, das etwas verändert: Adressen
 * landen in Verläufen und Protokollen.
 */
function bearerOderAdresse(req: FastifyRequest): string | null {
  const ausKopf = bearer(req);
  if (ausKopf) return ausKopf;
  const roh = (req.query as { token?: string } | undefined)?.token;
  return roh ? verifyToken(roh) : null;
}

function requireLeser(req: FastifyRequest): string {
  const id = bearerOderAdresse(req);
  if (!id) {
    const err = new Error('Nicht angemeldet') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return id;
}

function requireUser(req: FastifyRequest): string {
  const id = bearer(req);
  if (!id) {
    const err = new Error('Nicht angemeldet') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return id;
}

const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/* ── Bremse gegen das Durchprobieren von Passwörtern ───────────── */

/**
 * Gezählt wird je Herkunft *und* Benutzername. Nur nach Herkunft zu zählen
 * wäre falsch: in einer Firma teilen sich alle eine Adresse, und die
 * Tippfehler einer Person sperrten das ganze Büro aus.
 */
const versuche = new Map<string, { anzahl: number; bis: number }>();
const GRENZE = 8;
const FENSTER = 60_000;

function zuVieleVersuche(herkunft: string): boolean {
  const eintrag = versuche.get(herkunft);
  if (!eintrag) return false;
  if (Date.now() > eintrag.bis) { versuche.delete(herkunft); return false; }
  return eintrag.anzahl >= GRENZE;
}

function versuchGezaehlt(herkunft: string): void {
  const jetzt = Date.now();
  const eintrag = versuche.get(herkunft);
  if (!eintrag || jetzt > eintrag.bis) versuche.set(herkunft, { anzahl: 1, bis: jetzt + FENSTER });
  else eintrag.anzahl += 1;

  // Die Liste darf nicht unbegrenzt wachsen; abgelaufene Einträge fliegen raus.
  if (versuche.size > 5000) {
    for (const [schluessel, wert] of versuche) if (jetzt > wert.bis) versuche.delete(schluessel);
  }
}

function versucheZuruecksetzen(herkunft: string): void {
  versuche.delete(herkunft);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    workspace: config.workspaceName,
    ai: aiCapabilities(),
    languages: LANGUAGES.length,
    time: Date.now(),
  }));

  app.get('/api/languages', async () => LANGUAGES);

  /**
   * Modell für Übersetzung und KI festlegen. Gilt für den ganzen
   * Arbeitsbereich, deshalb nur für Owner und Admins.
   */
  app.post('/api/ai/models', async (req, reply) => {
    const userId = requireUser(req);
    const self = store.getSelf(userId);
    if (self?.role !== 'owner' && self?.role !== 'admin') {
      return reply.code(403).send({ error: 'Das Übersetzungsmodell darf nur die Team-Leitung ändern.' });
    }

    const body = req.body as { quality?: string | null; fast?: string | null; auto?: boolean };
    const registry = modelRegistry();
    if (!registry) return reply.code(400).send({ error: 'Der aktuelle Anbieter kennt keine Modellwahl.' });

    if (body.auto) {
      chooseModels(null, null, userId);
      await registry.refresh();
      return { selection: registry.current, ai: aiCapabilities() };
    }

    const known = new Set(registry.discovered.filter((m) => !m.rejected).map((m) => m.id));
    for (const id of [body.quality, body.fast]) {
      if (id && known.size && !known.has(id)) {
        return reply.code(400).send({ error: `Modell "${id}" gibt es nicht oder es beantwortet keine Chat-Anfragen.` });
      }
    }
    chooseModels(body.quality ?? null, body.fast ?? body.quality ?? null, userId);
    return { selection: registry.current, ai: aiCapabilities() };
  });

  /** Was der Anbieter anbietet und was davon gerade benutzt wird. */
  app.get('/api/ai/models', async (req) => {
    requireUser(req);
    const registry = modelRegistry();
    if (!registry) return { selection: null, models: [] };
    return {
      selection: registry.current,
      models: registry.discovered.map((m) => ({
        id: m.id,
        contextWindow: m.contextWindow,
        params: m.params,
        ownedBy: m.ownedBy,
        usable: m.rejected === null,
        rejected: m.rejected,
      })),
    };
  });

  /* ── Registrierung & Login ─────────────────────────────────── */

  /**
   * Selbstregistrierung gibt es nicht: Konten legt die Team-Leitung an und
   * gibt ein Einmal-Passwort weiter. Der Endpunkt bleibt nur bestehen, um
   * eine verständliche Antwort zu geben.
   */
  app.post('/api/auth/register', async (_req, reply) =>
    reply.code(403).send({
      error: 'Konten legt die Team-Leitung an. Frage nach einem Einmal-Passwort.',
    }));

  app.post('/api/auth/login', async (req, reply) => {
    const { login, password } = req.body as { login?: string; password?: string };
    if (!login || !password) return reply.code(400).send({ error: 'Zugangsdaten fehlen' });

    // Wer es zu oft falsch versucht, wartet. scrypt macht jeden Versuch
    // ohnehin teuer, aber eine Bremse gehört an die Tür, nicht ins Schloss.
    const herkunft = `${req.ip}|${login.toLowerCase()}`;
    if (zuVieleVersuche(herkunft)) {
      return reply.code(429).send({
        error: 'Zu viele Versuche. Bitte eine Minute warten.',
      });
    }

    const row = users.findByLogin(login);
    // Auch bei unbekanntem Konto das Passwort prüfen, damit die Antwortzeit
    // nicht verrät, ob es den Benutzernamen gibt.
    const gueltig = row
      ? verifyPassword(password, row.password_hash)
      : verifyPassword(password, '$scrypt$16384$8$1$AAAA$AAAA');

    if (!row || !gueltig) {
      versuchGezaehlt(herkunft);
      return reply.code(401).send({ error: 'Benutzername oder Passwort stimmt nicht' });
    }
    versucheZuruecksetzen(herkunft);
    if (row.disabled) {
      return reply.code(403).send({ error: 'Dieses Konto ist gesperrt. Wende dich an die Team-Leitung.' });
    }
    return { token: signToken(row.id), user: store.getSelf(row.id) };
  });

  /** Ersteinrichtung nach dem Einmal-Passwort. */
  app.post('/api/auth/setup', async (req, reply) => {
    const userId = requireUser(req);
    const body = req.body as { handle?: string; email?: string; displayName?: string; newPassword?: string };
    if (!body.newPassword) return reply.code(400).send({ error: 'Neues Passwort fehlt' });
    try {
      users.completeSetup(userId, {
        handle: body.handle, email: body.email,
        displayName: body.displayName, newPassword: body.newPassword,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { user: store.getSelf(userId) };
  });

  /** Passwort selbst ändern. */
  app.post('/api/auth/password', async (req, reply) => {
    const userId = requireUser(req);
    const { current, next } = req.body as { current?: string; next?: string };
    if (!current || !next) return reply.code(400).send({ error: 'Beide Passwörter angeben' });
    try {
      users.changeOwnPassword(userId, current, next, verifyPassword);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  /* ── Kontenverwaltung ───────────────────────────────────────── */

  /** Prüft ein Recht und wirft eine sprechende Antwort, wenn es fehlt. */
  function requirePermission(userId: string, permission: PermissionKey): void {
    if (users.may(userId, permission)) return;
    const info = PERMISSIONS.find((p) => p.key === permission);
    const err = new Error(`Dafür fehlt dir das Recht "${info?.labelDe ?? permission}".`) as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  }

  app.get('/api/permissions', async (req) => {
    requireUser(req);
    return { permissions: PERMISSIONS };
  });

  app.get('/api/admin/users', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    return { users: store.listManagedUsers() };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.invite');
    const body = req.body as {
      displayName?: string; handle?: string; email?: string;
      role?: MemberRole; language?: string; timezone?: string;
    };
    if (!body.displayName) return reply.code(400).send({ error: 'Name fehlt' });
    if (body.role === 'owner' && store.getSelf(userId)?.role !== 'owner') {
      return reply.code(403).send({ error: 'Nur der Owner kann einen weiteren Owner ernennen.' });
    }
    try {
      const konto = users.createAccount({ ...body, displayName: body.displayName, createdBy: userId });
      const person = store.getUser(konto.userId);
      // Ohne diese Meldung lernten die anderen Clients das neue Konto erst
      // beim nächsten Neuladen kennen — bis dahin ließe es sich nicht erwähnen.
      if (person) broadcastAll({ t: 'user:upsert', user: person });
      return {
        credential: {
          userId: konto.userId,
          handle: konto.handle,
          displayName: person?.displayName ?? body.displayName,
          oneTimePassword: konto.oneTimePassword,
          expiresAt: Date.now() + 14 * 86_400_000,
        },
        users: store.listManagedUsers(),
      };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const ziel = store.getUser(id);
    if (!ziel) return reply.code(404).send({ error: 'Konto nicht gefunden' });
    if (ziel.role === 'owner' && id !== userId) {
      return reply.code(403).send({ error: 'Das Passwort des Owners kann nur er selbst zurücksetzen.' });
    }
    try {
      const passwort = users.resetPassword(id, userId);
      return {
        credential: {
          userId: id, handle: ziel.handle, displayName: ziel.displayName,
          oneTimePassword: passwort, expiresAt: Date.now() + 14 * 86_400_000,
        },
        users: store.listManagedUsers(),
      };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/admin/users/:id/role', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const { role } = req.body as { role?: MemberRole };
    if (role === 'owner' && store.getSelf(userId)?.role !== 'owner') {
      return reply.code(403).send({ error: 'Nur der Owner kann diese Rolle vergeben.' });
    }
    try {
      users.setRole(id, role as any, userId);
      return { users: store.listManagedUsers() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/admin/users/:id/permission', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'permission.manage');
    const { id } = req.params as { id: string };
    const { permission, allowed } = req.body as { permission?: PermissionKey; allowed?: boolean | null };
    if (!permission) return reply.code(400).send({ error: 'Recht fehlt' });
    try {
      users.setPermission(id, permission, allowed ?? null, userId);
      return { users: store.listManagedUsers() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/admin/users/:id/disabled', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const { disabled } = req.body as { disabled?: boolean };
    try {
      users.setDisabled(id, Boolean(disabled));
      const person = store.getUser(id);
      if (person) broadcastAll({ t: 'user:upsert', user: person });
      return { users: store.listManagedUsers() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.delete');
    const { id } = req.params as { id: string };
    if (id === userId) return reply.code(400).send({ error: 'Das eigene Konto lässt sich nicht löschen.' });
    try {
      users.deleteAccount(id);
      // Der Eintrag bleibt als "Ehemaliges Mitglied" bestehen; alle sollen das
      // sofort sehen, statt weiter einen aktiven Kontakt anzuzeigen.
      const person = store.getUser(id);
      if (person) broadcastAll({ t: 'user:upsert', user: person });
      return { users: store.listManagedUsers() };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/me', async (req, reply) => {
    const userId = bearer(req);
    if (!userId) return reply.code(401).send({ error: 'Nicht angemeldet' });
    const self = store.getSelf(userId);
    if (!self) return reply.code(401).send({ error: 'Konto existiert nicht mehr' });
    return { user: self, ai: aiCapabilities() };
  });

  /* ── Suche ─────────────────────────────────────────────────── */

  app.get('/api/search', async (req) => {
    const userId = requireUser(req);
    const q = req.query as { q?: string; channelId?: string; from?: string; files?: string; limit?: string };
    return {
      hits: search({
        userId,
        q: q.q ?? '',
        channelId: q.channelId ?? null,
        fromUserId: q.from ?? null,
        hasFiles: q.files === '1',
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  app.get('/api/saved', async (req) => ({ messages: store.savedMessages(requireUser(req)) }));

  app.get('/api/channels/:id/pins', async (req) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    if (!store.getChannel(id, userId)) return { messages: [] };
    return { messages: store.pinnedMessages(id) };
  });

  /* ── Glossar ───────────────────────────────────────────────── */

  app.get('/api/glossary', async (req) => {
    requireUser(req);
    return { entries: listGlossary() };
  });

  app.post('/api/glossary', async (req, reply) => {
    const userId = requireUser(req);
    const body = req.body as { term?: string; translations?: Record<string, string> | null; caseSensitive?: boolean; note?: string };
    if (!body.term?.trim()) return reply.code(400).send({ error: 'Begriff fehlt' });
    const id = addGlossaryEntry({
      term: body.term.trim(),
      translations: body.translations ?? null,
      caseSensitive: body.caseSensitive,
      note: body.note ?? null,
      userId,
    });
    return { id, entries: listGlossary() };
  });

  app.delete('/api/glossary/:id', async (req) => {
    requireUser(req);
    removeGlossaryEntry((req.params as { id: string }).id);
    return { entries: listGlossary() };
  });

  /* ── Dateien ───────────────────────────────────────────────── */

  app.post('/api/uploads', async (req, reply) => {
    const userId = requireUser(req);
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) return reply.code(400).send({ error: 'Keine Datei im Request' });

    const id = newId('at_');
    const safeName = path.basename(file.filename || 'datei').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
    const target = path.join(config.uploadDir, id);

    try {
      await pipeline(file.file, fs.createWriteStream(target));
    } catch (err) {
      await fs.promises.rm(target, { force: true });
      return reply.code(500).send({ error: `Upload fehlgeschlagen: ${(err as Error).message}` });
    }
    if (file.file.truncated) {
      await fs.promises.rm(target, { force: true });
      return reply.code(413).send({ error: `Datei überschreitet ${config.maxUploadBytes / 1024 / 1024} MB` });
    }

    const size = (await fs.promises.stat(target)).size;
    const dims = file.mimetype.startsWith('image/') ? await imageSize(target) : null;

    db.run(
      `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, width, height, created_at)
       VALUES (?, NULL, ?,?,?,?,?,?,?,?)`,
      id, userId, safeName, file.mimetype || 'application/octet-stream', size, target,
      dims?.width ?? null, dims?.height ?? null, Date.now(),
    );

    return {
      attachment: {
        id, messageId: null, name: safeName, mime: file.mimetype, size,
        url: `/files/${id}`, width: dims?.width ?? null, height: dims?.height ?? null,
      },
    };
  });

  /* ── Team-Ablage ───────────────────────────────────────────── */

  app.post('/api/files', async (req, reply) => {
    const userId = requireUser(req);
    if (!may(userId, 'file.upload')) {
      return reply.code(403).send({ error: 'Dir fehlt das Recht, Dateien abzulegen.' });
    }
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) return reply.code(400).send({ error: 'Keine Datei im Request' });

    // Die Zusatzfelder kommen als Textteile im selben Formular.
    const felder = file.fields as Record<string, { value?: string } | undefined>;
    const feld = (name: string) => {
      const w = felder?.[name];
      return typeof w?.value === 'string' ? w.value : undefined;
    };

    const id = newId('fi_');
    const target = path.join(config.storageDir, id);

    try {
      await pipeline(file.file, fs.createWriteStream(target));
    } catch (err) {
      await fs.promises.rm(target, { force: true });
      return reply.code(500).send({ error: `Upload fehlgeschlagen: ${(err as Error).message}` });
    }
    if (file.file.truncated) {
      await fs.promises.rm(target, { force: true });
      return reply.code(413).send({ error: `Datei überschreitet ${config.maxUploadBytes / 1024 / 1024} MB` });
    }

    const size = (await fs.promises.stat(target)).size;
    try {
      const gespeichert = files.addFile({
        id,
        name: path.basename(file.filename || 'datei'),
        mime: file.mimetype || 'application/octet-stream',
        size,
        storedPath: target,
        folder: feld('folder'),
        channelId: feld('channelId') ?? null,
        description: feld('description') ?? null,
        uploadedBy: userId,
      });
      const belegung = files.usage();
      // Alle sollen die neue Datei sofort in der Ablage sehen.
      broadcastAll({ t: 'file:upsert', file: gespeichert, usage: belegung });
      return { file: gespeichert, usage: belegung };
    } catch (err) {
      // Kontingent überschritten: die Datei darf nicht liegen bleiben.
      await fs.promises.rm(target, { force: true });
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  /* ── App-Versionen ─────────────────────────────────────────── */

  /** Was liegt bereit? Braucht keine Rechte — jeder Client fragt das. */
  app.get('/api/releases', async (req) => {
    requireUser(req);
    return { releases: releases.listReleases() };
  });

  /**
   * Gibt es etwas Neueres als die laufende Version? Die Antwort ist bewusst
   * knapp: der Client soll nicht selbst Versionen vergleichen müssen.
   */
  app.get('/api/releases/check', async (req) => {
    requireUser(req);
    const { platform, version } = req.query as { platform?: string; version?: string };
    if (!platform || !version) return { update: null };
    const vorhanden = releases.getRelease(platform);
    if (!vorhanden || !releases.istNeuer(vorhanden.version, version)) return { update: null };
    const { path: _pfad, ...oeffentlich } = vorhanden;
    return { update: oeffentlich };
  });

  app.post('/api/releases/:platform', async (req, reply) => {
    const userId = requireUser(req);
    // Neue Versionen zu verteilen heißt, auf jedem Rechner Code auszuführen.
    // Das bleibt der Kontoverwaltung vorbehalten.
    requirePermission(userId, 'user.manage');

    const { platform } = req.params as { platform: string };
    const datei = await req.file({ limits: { fileSize: 600 * 1024 * 1024 } });
    if (!datei) return reply.code(400).send({ error: 'Keine Datei im Request' });

    const felder = datei.fields as Record<string, { value?: string } | undefined>;
    const version = typeof felder?.version?.value === 'string' ? felder.version.value.trim() : '';
    const notes = typeof felder?.notes?.value === 'string' ? felder.notes.value : null;

    const temp = path.join(config.releaseDir, `.upload-${newId('rl_')}`);
    try {
      await pipeline(datei.file, fs.createWriteStream(temp));
      if (datei.file.truncated) throw new Error('Die Datei ist zu groß (mehr als 600 MB).');
      const info = releases.publish({
        platform: platform as never,
        version,
        notes,
        fileName: datei.filename || 'stellium',
        tempPath: temp,
        publishedBy: userId,
      });
      // Alle laufenden Clients sollen die neue Version sofort bemerken.
      broadcastAll({ t: 'release:available', release: info });
      return { release: info, releases: releases.listReleases() };
    } catch (err) {
      await fs.promises.rm(temp, { force: true });
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/releases/:platform', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    releases.removeRelease((req.params as { platform: string }).platform);
    return { releases: releases.listReleases() };
  });

  app.get('/releases/:platform/download', async (req, reply) => {
    requireLeser(req);
    const vorhanden = releases.getRelease((req.params as { platform: string }).platform);
    if (!vorhanden || !fs.existsSync(vorhanden.path)) {
      return reply.code(404).send({ error: 'Für diese Plattform liegt nichts bereit.' });
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(vorhanden.size));
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(vorhanden.fileName)}`);
    reply.header('x-stellium-sha256', vorhanden.sha256);
    return reply.send(fs.createReadStream(vorhanden.path));
  });

  app.get('/storage/:id', async (req, reply) => {
    const userId = requireLeser(req);
    const { id } = req.params as { id: string };
    const datei = files.getFile(id);
    if (!datei || !fs.existsSync(datei.path)) return reply.code(404).send({ error: 'Datei nicht gefunden' });

    // Hängt die Datei an einem Kanal, gilt dessen Mitgliederkreis. Sonst
    // käme jeder mit der Kennung an Anhänge aus fremden Kanälen.
    if (datei.channelId && !store.memberIds(datei.channelId).includes(userId)) {
      return reply.code(404).send({ error: 'Datei nicht gefunden' });
    }

    const inline = /^(image|video|audio)\//.test(datei.mime) || datei.mime === 'application/pdf';
    reply.header('content-type', datei.mime);
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(datei.name)}`);
    return reply.send(fs.createReadStream(datei.path));
  });

  app.get('/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.get<{ path: string; mime: string; name: string }>(
      'SELECT path, mime, name FROM attachments WHERE id = ?', id,
    );
    if (!row || !fs.existsSync(row.path)) return reply.code(404).send({ error: 'Datei nicht gefunden' });

    const inline = /^(image|video|audio)\//.test(row.mime) || row.mime === 'application/pdf';
    reply.header('content-type', row.mime);
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(fs.createReadStream(row.path));
  });
}

/** Bildmaße aus dem Header lesen — reicht für PNG, JPEG, GIF und WebP. */
async function imageSize(file: string): Promise<{ width: number; height: number } | null> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);

    if (b.length > 24 && b.toString('ascii', 1, 4) === 'PNG') {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = b.toString('ascii', 12, 16);
      if (fmt === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fmt === 'VP8X') return { width: (b.readUIntLE(24, 3) & 0xffffff) + 1, height: (b.readUIntLE(27, 3) & 0xffffff) + 1 };
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < b.length) {
        if (b[offset] !== 0xff) { offset++; continue; }
        const marker = b[offset + 1];
        const len = b.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await fd?.close();
  }
}
