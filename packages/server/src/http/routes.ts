import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { normalizeLang, LANGUAGES } from '@stellium/shared';
import { avatarColorFor, hashPassword, signToken, verifyPassword, verifyToken } from '../auth.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { addGlossaryEntry, aiCapabilities, chooseModels, listGlossary, modelRegistry, removeGlossaryEntry } from '../translation/index.js';
import { search } from '../services/search.js';
import * as store from '../services/store.js';

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyToken(header.slice(7));
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

  app.post('/api/auth/register', async (req, reply) => {
    const body = req.body as {
      handle?: string; email?: string; password?: string;
      displayName?: string; language?: string; timezone?: string;
    };

    const handle = (body.handle ?? '').trim().toLowerCase();
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const displayName = (body.displayName ?? '').trim() || handle;

    if (!HANDLE_RE.test(handle)) {
      return reply.code(400).send({ error: 'Benutzername: 2–32 Zeichen, Kleinbuchstaben, Ziffern, . _ -' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'E-Mail ist ungültig' });
    if (password.length < 8) return reply.code(400).send({ error: 'Passwort braucht mindestens 8 Zeichen' });

    const taken = db.get('SELECT 1 AS x FROM users WHERE lower(handle) = ? OR lower(email) = ?', handle, email);
    if (taken) return reply.code(409).send({ error: 'Benutzername oder E-Mail ist bereits vergeben' });

    const id = newId('u_');
    const isFirst = !db.get('SELECT 1 AS x FROM users LIMIT 1');
    db.run(
      `INSERT INTO users (id, handle, email, display_name, password_hash, avatar_color, timezone, language, role, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, handle, email, displayName, hashPassword(password), avatarColorFor(handle),
      body.timezone || 'Europe/Berlin', normalizeLang(body.language || 'de'),
      isFirst ? 'owner' : 'member', Date.now(),
    );

    // Neue Leute landen automatisch in den offenen Standardkanälen.
    for (const ch of db.all<{ id: string }>("SELECT id FROM channels WHERE kind = 'public' AND archived = 0")) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', ch.id, id, Date.now());
    }

    return { token: signToken(id), user: store.getSelf(id) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { login, password } = req.body as { login?: string; password?: string };
    if (!login || !password) return reply.code(400).send({ error: 'Zugangsdaten fehlen' });

    const row = db.get<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE lower(handle) = lower(?) OR lower(email) = lower(?)',
      login.trim(), login.trim(),
    );
    if (!row || !verifyPassword(password, row.password_hash)) {
      return reply.code(401).send({ error: 'Benutzername oder Passwort stimmt nicht' });
    }
    return { token: signToken(row.id), user: store.getSelf(row.id) };
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
