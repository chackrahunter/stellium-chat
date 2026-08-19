import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { normalizeLang, LANGUAGES } from '@stellium/shared';
import { signToken, verifyPassword, verifyToken } from '../auth.js';
import * as users from '../services/users.js';
import { may } from '../services/users.js';
import { KONTO_KATEGORIEN } from '@stellium/shared';
import { PERMISSIONS, type MemberRole, type PermissionKey } from '@stellium/shared';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { kennungVon } from '../util/abweisung.js';
import { newId } from '../util/id.js';
import {
  addGlossaryEntry, aiCapabilities, anbieterWaehlen, chooseModels, listGlossary, lokalePruefung,
  modelRegistry, removeGlossaryEntry,
} from '../translation/index.js';
import { search } from '../services/search.js';
import * as store from '../services/store.js';
import * as files from '../services/files.js';
import * as releases from '../services/releases.js';
import { downloadSeite, systemErkennen } from './download/seite.js';

import { broadcastAll, sitzungenBeenden, verbindungen } from '../ws/gateway.js';
import * as ablage from '../services/ablage.js';
import { huelleSchreiben, umschlagVonDatei } from '../crypto/dateien.js';

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

/**
 * Angefangene Teil-Uploads. Bewusst nur im Speicher: bricht der Server ab,
 * fängt der Client neu an — das ist besser, als Reste in der Datenbank zu
 * führen, die niemand mehr abholt.
 */
const teilUploads = new Map<string, {
  userId: string; name: string; mime: string; size: number; parts: number;
  da: Set<number>; begonnen: number;
}>();

/** Prüfsumme einer Datei, ohne sie ganz in den Speicher zu holen. */
function dateiSumme(datei: string): Promise<string> {
  return new Promise((fertig, schief) => {
    const hash = crypto.createHash('sha256');
    const strom = fs.createReadStream(datei, { highWaterMark: 1024 * 1024 });
    strom.on('data', (d) => hash.update(d));
    strom.on('end', () => fertig(hash.digest('hex')));
    strom.on('error', schief);
  });
}

/**
 * Eine Datei zur Übernahme in den Blockspeicher anmelden — außer sie ist
 * verschlüsselt.
 *
 * Angemeldet, nicht übernommen: die Zerlegung läuft im Hintergrund, der
 * Aufrufer kehrt sofort zurück. Warum das auch für die kleinen Wege gilt und
 * nicht nur für den Weg in Teilen, steht bei `spaeterUebernehmen()` — kurz:
 * die Zerlegung ist durchweg synchron, und wie lange sie dauert, entscheidet
 * nicht die Größe, sondern der Inhalt. Auf dem Raspberry Pi gemessen: 4 MB
 * packbarer CSV-Abzug 18 Sekunden, in denen kein Ping und keine Nachricht
 * durchkam, weil die Ereignisschleife stand. Bei den 50 MB, die
 * `MAX_UPLOAD_MB` erlaubt, wären das über drei Minuten Stillstand für alle.
 *
 * Der Blockspeicher lebt davon, gleiche Bytes wiederzuerkennen. Bei einer
 * verschlüsselten Datei kann er das grundsätzlich nicht: ihr Schlüssel ist
 * gewürfelt, dieselbe Datei ergibt beim zweiten Hochladen ein völlig anderes
 * Chiffrat, und gepackt wird sie auch nicht — Chiffrat sieht für jeden Packer
 * aus wie Rauschen. Ein Durchlauf fände also garantiert nichts und kostete auf
 * dem Raspberry Pi trotzdem eine volle Zerlegung samt Packversuch je Block.
 *
 * Wichtiger als die Ersparnis ist aber, dass es so bleiben **muss**. Würde der
 * Dateischlüssel aus dem Inhalt abgeleitet — der naheliegende Weg, um auch
 * verschlüsselt noch zusammenlegen zu können —, dann verriete genau dieses
 * Zusammenlegen dem Server, ob er eine bestimmte Datei schon verwahrt: er
 * müsste sie nur selbst verschlüsseln und die Blöcke vergleichen. Bei privaten
 * Dateien geht Privatsphäre vor Speicherplatz, und diese Abzweigung ist die
 * Stelle, an der das steht.
 */
function uebernehmenWennOffen(
  input: { id: string; art: ablage.Art; pfad: string; mime: string },
  umschlag: unknown | null,
): void {
  if (umschlag) return;
  ablage.spaeterUebernehmen(input);
}

async function teileAufraeumen(id: string, anzahl: number): Promise<void> {
  for (let i = 0; i < anzahl; i += 1) {
    await fs.promises.rm(path.join(config.uploadDir, `${id}.teil${i}`), { force: true }).catch(() => {});
  }
}

/* Liegengebliebenes wegräumen: wer anfängt und nicht fertig wird, soll keine
   halben Dateien hinterlassen. */
setInterval(() => {
  const grenze = Date.now() - 60 * 60 * 1000;
  for (const [id, auftrag] of teilUploads) {
    if (auftrag.begonnen > grenze) continue;
    teilUploads.delete(id);
    void teileAufraeumen(id, auftrag.parts);
  }
}, 15 * 60 * 1000).unref();

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /* Was ein Absturz mitten in einer Übernahme liegengelassen hat, wird jetzt
     zu Ende gebracht. Steht hier und nicht in einem eigenen Zeitgeber, weil es
     genau einmal beim Hochfahren gehört — und die Zerlegung läuft ohnehin im
     Hintergrund weiter, hält den Start also nicht auf. */
  ablage.offeneUebernahmenFortsetzen();

  app.get('/api/health', async () => ({
    verbunden: verbindungen(),
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
      return fehler(reply, 403, 'fehler.nurLeitungModell', 'Das Übersetzungsmodell darf nur die Team-Leitung ändern.');
    }

    const body = req.body as { quality?: string | null; fast?: string | null; auto?: boolean };
    const registry = modelRegistry();
    if (!registry) return fehler(reply, 400, 'fehler.keineModellwahl', 'Der aktuelle Anbieter kennt keine Modellwahl.');

    if (body.auto) {
      chooseModels(null, null, userId);
      await registry.refresh();
      return { selection: registry.current, ai: aiCapabilities() };
    }

    const known = new Set(registry.discovered.filter((m) => !m.rejected).map((m) => m.id));
    for (const id of [body.quality, body.fast]) {
      if (id && known.size && !known.has(id)) {
        return fehler(reply, 400, 'fehler.modellUnbekannt',
          `Modell "${id}" gibt es nicht oder es beantwortet keine Chat-Anfragen.`, { modell: id });
      }
    }
    chooseModels(body.quality ?? null, body.fast ?? body.quality ?? null, userId);
    return { selection: registry.current, ai: aiCapabilities() };
  });

  /**
   * Anbieter umstellen — auf ein Modell im eigenen Netz oder zurück.
   * Wie die Modellwahl eine Sache für die Team-Leitung.
   */
  app.post('/api/ai/provider', async (req, reply) => {
    const userId = requireUser(req);
    const self = store.getSelf(userId);
    if (self?.role !== 'owner' && self?.role !== 'admin') {
      return fehler(reply, 403, 'fehler.nurLeitungAnbieter', 'Den KI-Anbieter darf nur die Team-Leitung ändern.');
    }

    const body = req.body as {
      anbieter?: string | null; baseUrl?: string; model?: string; fastModel?: string;
    };
    const erlaubt = ['groq', 'openai', 'ollama', 'llamacpp', 'local', 'deepl', 'libre', 'demo'];
    const anbieter = body.anbieter ? String(body.anbieter) : null;
    if (anbieter && !erlaubt.includes(anbieter)) {
      return fehler(reply, 400, 'fehler.anbieterUnbekannt',
        `Unbekannter Anbieter "${anbieter}".`, { anbieter: String(anbieter) });
    }

    // Bei einem lokalen Dienst zuerst nachsehen, ob dort überhaupt etwas
    // antwortet. Sonst stellt man auf einen Anbieter um, der nichts kann,
    // und merkt es erst an der nächsten Nachricht.
    if (anbieter === 'ollama' || anbieter === 'llamacpp' || anbieter === 'local') {
      const adresse = (body.baseUrl || '').trim()
        || (anbieter === 'llamacpp' ? config.ai.llamacpp.baseUrl
          : anbieter === 'local' ? (config.ai.lokal.baseUrl || config.ai.ollama.baseUrl)
            : config.ai.ollama.baseUrl);
      const probe = await lokalePruefung(adresse);
      if (!probe.erreichbar) {
        return fehler(reply, 400, 'fehler.dienstStumm',
          `Unter ${adresse} antwortet nichts (${probe.fehler}).`,
          { adresse: String(adresse), grund: String(probe.fehler) });
      }
      if (body.model && probe.modelle.length && !probe.modelle.includes(body.model)) {
        return reply.code(400).send({
          error: `Dort ist "${body.model}" nicht geladen. Vorhanden: ${probe.modelle.slice(0, 6).join(', ')}.`,
          code: 'fehler.modellNichtGeladen',
          werte: { modell: String(body.model), vorhanden: probe.modelle.slice(0, 6).join(', ') },
        });
      }
    }

    await anbieterWaehlen({
      anbieter: anbieter as never,
      baseUrl: body.baseUrl,
      model: body.model,
      fastModel: body.fastModel,
      userId,
    });
    return { ai: aiCapabilities(), selection: modelRegistry()?.current ?? null };
  });

  /** Nachsehen, was ein lokaler Dienst anbietet — ohne etwas umzustellen. */
  app.post('/api/ai/local-check', async (req, reply) => {
    const userId = requireUser(req);
    const self = store.getSelf(userId);
    if (self?.role !== 'owner' && self?.role !== 'admin') {
      return fehler(reply, 403, 'fehler.keinRecht', 'Dafür fehlt dir das Recht.');
    }
    const body = req.body as { baseUrl?: string };
    const adresse = (body.baseUrl || '').trim() || config.ai.ollama.baseUrl;
    return lokalePruefung(adresse);
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
    fehler(reply, 403, 'fehler.keineSelbstanmeldung',
      'Konten legt die Team-Leitung an. Frage nach einem Einmal-Passwort.'));

  app.post('/api/auth/login', async (req, reply) => {
    const { login, password } = req.body as { login?: string; password?: string };
    if (!login || !password) return fehler(reply, 400, 'fehler.zugangsdatenFehlen', 'Zugangsdaten fehlen');

    // Wer es zu oft falsch versucht, wartet. scrypt macht jeden Versuch
    // ohnehin teuer, aber eine Bremse gehört an die Tür, nicht ins Schloss.
    const herkunft = `${req.ip}|${login.toLowerCase()}`;
    if (zuVieleVersuche(herkunft)) {
      return fehler(reply, 429, 'fehler.zuVieleVersuche',
        'Zu viele Versuche. Bitte eine Minute warten.');
    }

    const row = users.findByLogin(login);
    // Auch bei unbekanntem Konto das Passwort prüfen, damit die Antwortzeit
    // nicht verrät, ob es den Benutzernamen gibt.
    const gueltig = row
      ? verifyPassword(password, row.password_hash)
      : verifyPassword(password, '$scrypt$16384$8$1$AAAA$AAAA');

    if (!row || !gueltig) {
      versuchGezaehlt(herkunft);
      return fehler(reply, 401, 'fehler.loginFalsch', 'Benutzername oder Passwort stimmt nicht');
    }
    versucheZuruecksetzen(herkunft);
    if (row.disabled) {
      return fehler(reply, 403, 'fehler.kontoGesperrt',
        'Dieses Konto ist gesperrt. Wende dich an die Team-Leitung.');
    }
    return { token: signToken(row.id), user: store.getSelf(row.id) };
  });

  /** Ersteinrichtung nach dem Einmal-Passwort. */
  app.post('/api/auth/setup', async (req, reply) => {
    const userId = requireUser(req);
    const body = req.body as { handle?: string; email?: string; displayName?: string; newPassword?: string };
    if (!body.newPassword) return fehler(reply, 400, 'fehler.neuesPasswortFehlt', 'Neues Passwort fehlt');
    try {
      users.completeSetup(userId, {
        handle: body.handle, email: body.email,
        displayName: body.displayName, newPassword: body.newPassword,
      });
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
    return { user: store.getSelf(userId) };
  });

  /** Passwort selbst ändern. */
  app.post('/api/auth/password', async (req, reply) => {
    const userId = requireUser(req);
    const { current, next } = req.body as { current?: string; next?: string };
    if (!current || !next) return fehler(reply, 400, 'fehler.beidePasswoerter', 'Beide Passwörter angeben');
    try {
      users.changeOwnPassword(userId, current, next, verifyPassword);
    } catch (err) {
      return weiterreichen(reply, 400, err);
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
    if (!body.displayName) return fehler(reply, 400, 'fehler.nameFehlt', 'Name fehlt');
    if (body.role === 'owner' && store.getSelf(userId)?.role !== 'owner') {
      return fehler(reply, 403, 'fehler.nurOwnerErnennt', 'Nur der Owner kann einen weiteren Owner ernennen.');
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
      return weiterreichen(reply, 400, err);
    }
  });

  app.post('/api/admin/users/:id/reset-password', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const ziel = store.getUser(id);
    if (!ziel) return fehler(reply, 404, 'fehler.kontoNichtGefunden', 'Konto nicht gefunden');
    if (ziel.role === 'owner' && id !== userId) {
      return fehler(reply, 403, 'fehler.ownerPasswortSelbst', 'Das Passwort des Owners kann nur er selbst zurücksetzen.');
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
      return weiterreichen(reply, 400, err);
    }
  });

  app.post('/api/admin/users/:id/role', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    const { id } = req.params as { id: string };
    const { role } = req.body as { role?: MemberRole };
    if (role === 'owner' && store.getSelf(userId)?.role !== 'owner') {
      return fehler(reply, 403, 'fehler.nurOwnerRolle', 'Nur der Owner kann diese Rolle vergeben.');
    }
    /* Die eigene Rolle bleibt tabu. Sonst könnte sich jeder mit 'user.manage'
       selbst hochstufen — die Rechteverwaltung wäre dann nur noch Zierde. */
    if (id === userId) {
      return fehler(reply, 403, 'fehler.eigeneRolle', 'Die eigene Rolle lässt sich nicht ändern.');
    }
    try {
      users.setRole(id, role as any, userId);
      return { users: store.listManagedUsers() };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.post('/api/admin/users/:id/permission', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'permission.manage');
    const { id } = req.params as { id: string };
    const { permission, allowed } = req.body as { permission?: PermissionKey; allowed?: boolean | null };
    if (!permission) return fehler(reply, 400, 'fehler.rechtFehlt', 'Recht fehlt');
    // Wer sich selbst Rechte zurückgeben kann, dem kann man keine nehmen.
    if (id === userId) {
      return fehler(reply, 403, 'fehler.eigeneRechte', 'Eigene Rechte lassen sich nicht ändern.');
    }
    try {
      users.setPermission(id, permission, allowed ?? null, userId);
      return { users: store.listManagedUsers() };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  /** Ein Konto in eine andere Schublade legen. */
  app.post('/api/admin/users/:id/kategorie', async (req, reply) => {
    const userId = requireUser(req);
    if (!may(userId, 'user.manage')) {
      return fehler(reply, 403, 'fehler.keinRecht', 'Dafür fehlt dir das Recht.');
    }
    const { id } = req.params as { id: string };
    const body = req.body as { kategorie?: string | null };
    const wert = body.kategorie ? String(body.kategorie) : null;
    if (wert && !KONTO_KATEGORIEN.includes(wert as never)) {
      return fehler(reply, 400, 'fehler.kategorieUnbekannt',
        `Unbekannte Kategorie "${wert}".`, { kategorie: String(wert) });
    }
    // Gelöschte bleiben gelöscht — dafür gibt es keine andere Schublade.
    const ziel = store.listManagedUsers().find((u) => u.id === id);
    if (!ziel) return fehler(reply, 404, 'fehler.kontoNichtGefunden', 'Konto nicht gefunden.');
    if (ziel.deletedAt) return fehler(reply, 400, 'fehler.geloeschtEinsortieren', 'Gelöschte Konten lassen sich nicht einsortieren.');

    db.run('UPDATE users SET kategorie = ? WHERE id = ?', wert, id);
    return { users: store.listManagedUsers() };
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
      return weiterreichen(reply, 400, err);
    }
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.delete');
    const { id } = req.params as { id: string };
    if (id === userId) return fehler(reply, 400, 'fehler.eigenesKontoLoeschen', 'Das eigene Konto lässt sich nicht löschen.');
    try {
      users.deleteAccount(id);
      // Wer gerade verbunden ist, fliegt sofort heraus — sonst liest das
      // gelöschte Konto weiter mit, bis sein Token abläuft.
      sitzungenBeenden(id);
      // Der Eintrag bleibt als "Ehemaliges Mitglied" bestehen; alle sollen das
      // sofort sehen, statt weiter einen aktiven Kontakt anzuzeigen.
      const person = store.getUser(id);
      if (person) broadcastAll({ t: 'user:upsert', user: person });
      return { users: store.listManagedUsers() };
    } catch (err) {
      return weiterreichen(reply, 400, err);
    }
  });

  app.get('/api/me', async (req, reply) => {
    const userId = bearer(req);
    if (!userId) return fehler(reply, 401, 'fehler.nichtAngemeldet', 'Nicht angemeldet');
    const self = store.getSelf(userId);
    if (!self) return fehler(reply, 401, 'fehler.kontoWeg', 'Konto existiert nicht mehr');
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
    /* Das Glossar steuert, wie Begriffe teamweit übersetzt werden — ein
       Eintrag wirkt auf jede Nachricht. Das Recht dafür gab es längst, geprüft
       hat es niemand. */
    requirePermission(userId, 'glossary.manage');
    const body = req.body as { term?: string; translations?: Record<string, string> | null; caseSensitive?: boolean; note?: string };
    if (!body.term?.trim()) return fehler(reply, 400, 'fehler.begriffFehlt', 'Begriff fehlt');
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
    const userId = requireUser(req);
    requirePermission(userId, 'glossary.manage');
    removeGlossaryEntry((req.params as { id: string }).id);
    return { entries: listGlossary() };
  });

  /**
   * Eine Fehlerantwort mit Kennung.
   *
   * Der Text bleibt deutsch — er ist der Rückfall für Clients, die die Kennung
   * noch nicht kennen. Die Oberfläche sucht zuerst nach der Kennung und zeigt
   * ihren eigenen Satz in der eingestellten Sprache. So muss der Server nicht
   * wissen, welche Sprache am anderen Ende läuft.
   */
  const fehler = (
    reply: FastifyReply, status: number, code: string, text: string,
    werte?: Record<string, string>,
  ) => reply.code(status).send({ error: text, code, werte });

  /**
   * Eine Abweisung aus einem Dienst weiterreichen.
   *
   * Trägt sie eine Kennung, geht die mit hinaus und die Oberfläche setzt ihren
   * eigenen Satz ein. Trägt sie keine — etwa weil es ein unerwarteter Fehler
   * ist —, bleibt es beim deutschen Text; lesbar ist er allemal.
   */
  const weiterreichen = (reply: FastifyReply, status: number, err: unknown) => {
    const { code, werte } = kennungVon(err);
    return reply.code(status).send({ error: (err as Error).message, code, werte });
  };

  /* ── Dateien ───────────────────────────────────────────────── */

  app.post('/api/uploads', async (req, reply) => {
    const userId = requireUser(req);
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) return fehler(reply, 400, 'fehler.keineDatei', 'Keine Datei im Request');

    const id = newId('at_');
    const safeName = path.basename(file.filename || 'datei').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
    const target = path.join(config.uploadDir, id);

    try {
      await pipeline(file.file, fs.createWriteStream(target));
    } catch (err) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 500, 'fehler.uploadFehlgeschlagen',
        `Upload fehlgeschlagen: ${(err as Error).message}`, { grund: (err as Error).message });
    }
    if (file.file.truncated) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 413, 'fehler.dateiZuGross',
        `Datei überschreitet ${config.maxUploadBytes / 1024 / 1024} MB`,
        { mb: String(config.maxUploadBytes / 1024 / 1024) });
    }

    const size = (await fs.promises.stat(target)).size;
    const umschlag = umschlagVonDatei(target);
    /* Bei einer verschlüsselten Datei gibt es nichts zu vermessen: der Anfang
       ist ein Umschlag und kein Bildkopf. Ohne diese Abzweigung stünden hier
       Maße, die aus Zufallsbytes geraten wären. */
    const dims = !umschlag && file.mimetype.startsWith('image/') ? await imageSize(target) : null;
    const summe = umschlag ? null : await dateiSumme(target);

    db.run(
      `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, width, height, sha256, huelle, created_at)
       VALUES (?, NULL, ?,?,?,?,?,?,?,?,?,?)`,
      id, userId, safeName, file.mimetype || 'application/octet-stream', size, target,
      dims?.width ?? null, dims?.height ?? null, summe, huelleSchreiben(umschlag), Date.now(),
    );

    /* Ab in den Blockspeicher — angemeldet, nicht abgewartet. Das läuft
       bewusst nach dem Eintragen: die Datei ist ab sofort benutzbar, sie wird
       bis zum Ende der Zerlegung ganz von der Platte ausgeliefert, und wenn
       die Übernahme scheitert, bleibt sie schlicht liegen. */
    uebernehmenWennOffen({ id, art: 'attachment', pfad: target, mime: file.mimetype || '' }, umschlag);

    return {
      attachment: {
        id, messageId: null, name: safeName, mime: file.mimetype, size,
        url: `/files/${id}`, width: dims?.width ?? null, height: dims?.height ?? null,
      },
    };
  });

  /**
   * Kennt der Server diese Datei schon?
   *
   * Dieselbe Datei zweimal zu übertragen ist die teuerste Art, nichts zu
   * erreichen — bei einer Hausleitung mit zweieinhalb Megabyte in der Sekunde
   * sind das Minuten für etwas, das längst dort liegt. Der Client rechnet die
   * Prüfsumme aus und fragt vorher nach; passt sie, entsteht nur ein neuer
   * Verweis auf dieselben Bytes.
   *
   * Was hier als Nachweis zählt, ist die Prüfsumme über den **ganzen** Inhalt
   * zusammen mit der Größe. Wer die hat, hat die Datei — sie lässt sich nicht
   * erraten und nicht aus Bruchstücken zusammenlegen. Das ist die Grenze, an
   * der diese Route steht und stehen bleiben muss: eine Auskunft auf weniger
   * hin — auf einen Blocknamen etwa, oder auf eine Prüfsumme ohne Größe —
   * würde aus der Ersparnis einen Weg machen, an fremde Dateien zu kommen.
   */
  app.post('/api/uploads/bekannt', async (req, reply) => {
    const userId = requireUser(req);
    const body = req.body as { sha256?: string; size?: number; name?: string; mime?: string };
    const summe = String(body.sha256 ?? '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(summe)) return fehler(reply, 400, 'fehler.pruefsummeFalsch', 'Ungültige Prüfsumme.');

    const groesse = Number(body.size ?? 0);
    // Ohne Größe kein Nachweis: die Prüfsumme allein soll hier nicht genügen.
    if (!Number.isSafeInteger(groesse) || groesse <= 0) return { bekannt: false };

    /* Denselben Inhalt können mehrere Zeilen tragen, und sie sind
       unterschiedlich brauchbar: eine liegt noch als ganze Datei da, die
       nächste ist längst in Blöcken, eine dritte ist der Rest eines
       abgebrochenen Vorgangs und hat gar nichts mehr. Deshalb nicht die
       neueste nehmen, sondern die neueste, aus der wirklich wieder eine Datei
       entsteht. */
    const kandidaten = db.all<any>(
      'SELECT * FROM attachments WHERE sha256 = ? AND size = ? ORDER BY created_at DESC LIMIT 25',
      summe, groesse,
    );
    const vorhanden = kandidaten.find((zeile) => (zeile.encoding === 'bloecke'
      ? ablage.blockListe(zeile.id, 'attachment').length > 0
      : Boolean(zeile.path) && fs.existsSync(zeile.path)));
    if (!vorhanden) return { bekannt: false };

    /* Ein neuer Eintrag auf dieselbe Datei: Name und Absender gehören zu
       diesem Vorgang, die Bytes werden geteilt. Gelöscht wird eine Datei erst,
       wenn kein Eintrag mehr auf sie zeigt. */
    const id = newId('at_');
    const name = path.basename(String(body.name ?? vorhanden.name)).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120);
    const inBloecken = vorhanden.encoding === 'bloecke';
    db.run(
      `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, width, height, sha256, encoding, stored_size, created_at)
       VALUES (?, NULL, ?,?,?,?,?,?,?,?,?,?,?)`,
      id, userId, name, String(body.mime ?? vorhanden.mime), vorhanden.size, vorhanden.path,
      vorhanden.width ?? null, vorhanden.height ?? null, summe,
      /* Alles außer „liegt in Blöcken" ist für diesen Eintrag schlicht eine
         ganze Datei. Insbesondere darf ein laufender `uebernahme`-Vermerk
         nicht mitkopiert werden: er gehört zu genau einem Vorgang, und die
         zweite Zeile würde sonst beim nächsten Start als unterbrochen gelten
         und eine Übernahme starten, die niemand angestoßen hat. */
      inBloecken ? 'bloecke' : null,
      /* Was dieser zweite Eintrag zusätzlich auf der Platte kostet: nichts.
         Die Blöcke liegen schon da, und genau so rechnet der Blockspeicher
         auch bei einem zweiten Upload derselben Datei. */
      inBloecken ? 0 : null,
      Date.now(),
    );

    /* Liegt die Vorlage in Blöcken, gibt es ihren Pfad nicht mehr — geteilt
       wird dann die Blockliste. Ohne diesen Zweig meldete die Route für jede
       Datei im Blockspeicher „kenne ich nicht", und der Client übertrug eine
       Datei, die längst da war. */
    if (inBloecken && !ablage.bloeckeTeilen({ id: vorhanden.id, art: 'attachment' }, { id, art: 'attachment' })) {
      // Zwischen Nachsehen und Übernehmen ist die Vorlage verschwunden. Dann
      // lieber ehrlich "unbekannt" als ein Eintrag, der ins Leere zeigt.
      db.run('DELETE FROM attachments WHERE id = ?', id);
      return { bekannt: false };
    }

    return {
      bekannt: true,
      attachment: {
        id, messageId: null, name, mime: String(body.mime ?? vorhanden.mime), size: vorhanden.size,
        url: `/files/${id}`, width: vorhanden.width ?? null, height: vorhanden.height ?? null,
      },
    };
  });

  /* ── Große Dateien in Teilen ────────────────────────────────
   *
   * Ein einzelner Datenstrom füllt eine Leitung mit Laufzeit nicht aus: das
   * Fenster wächst langsam, und jede Bestätigung kostet eine halbe Runde.
   * Mehrere Teile gleichzeitig holen deutlich mehr heraus — dieselbe Datei
   * kommt in Stücken, die der Server am Ende wieder zusammensetzt.
   */

  /** Anfangen: legt fest, was kommt, und gibt eine Kennung zurück. */
  app.post('/api/uploads/start', async (req, reply) => {
    const userId = requireUser(req);
    const body = req.body as { name?: string; mime?: string; size?: number; parts?: number };
    const groesse = Number(body.size ?? 0);
    if (!Number.isFinite(groesse) || groesse <= 0) {
      return fehler(reply, 400, 'fehler.groesseFehlt', 'Größe fehlt.');
    }
    if (groesse > config.maxUploadBytes) {
      return fehler(reply, 413, 'fehler.dateiZuGross',
        `Datei überschreitet ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB`,
        { mb: String(Math.round(config.maxUploadBytes / 1024 / 1024)) });
    }
    const teile = Number(body.parts ?? 0);
    // Obergrenze, damit niemand mit hunderttausend Teilen das Verzeichnis flutet.
    if (!Number.isInteger(teile) || teile < 1 || teile > 2000) {
      return fehler(reply, 400, 'fehler.teileAnzahl', 'Ungültige Anzahl Teile.');
    }

    const id = newId('up_');
    teilUploads.set(id, {
      userId,
      name: path.basename(body.name || 'datei').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120),
      mime: body.mime || 'application/octet-stream',
      size: groesse,
      parts: teile,
      da: new Set(),
      begonnen: Date.now(),
    });
    return { uploadId: id };
  });

  /** Ein Teil. Der Rumpf ist der rohe Inhalt, ohne Umschlag. */
  app.put('/api/uploads/:id/part/:index', async (req, reply) => {
    const userId = requireUser(req);
    const { id, index } = req.params as { id: string; index: string };
    const auftrag = teilUploads.get(id);
    if (!auftrag || auftrag.userId !== userId) return fehler(reply, 404, 'fehler.uploadUnbekannt', 'Unbekannter Upload.');

    const nummer = Number.parseInt(index, 10);
    if (!Number.isInteger(nummer) || nummer < 0 || nummer >= auftrag.parts) {
      return fehler(reply, 400, 'fehler.teilnummer', 'Ungültige Teilnummer.');
    }

    const ziel = path.join(config.uploadDir, `${id}.teil${nummer}`);
    try {
      await pipeline(req.raw, fs.createWriteStream(ziel, { highWaterMark: 1024 * 1024 }));
    } catch (err) {
      await fs.promises.rm(ziel, { force: true });
      return fehler(reply, 500, 'fehler.teilFehlgeschlagen',
        `Teil ${nummer} fehlgeschlagen: ${(err as Error).message}`,
        { nummer: String(nummer), grund: (err as Error).message });
    }
    auftrag.da.add(nummer);
    return { ok: true, teil: nummer };
  });

  /** Fertig: Teile in der richtigen Reihenfolge zusammenlegen. */
  app.post('/api/uploads/:id/finish', async (req, reply) => {
    const userId = requireUser(req);
    const { id } = req.params as { id: string };
    const auftrag = teilUploads.get(id);
    if (!auftrag || auftrag.userId !== userId) return fehler(reply, 404, 'fehler.uploadUnbekannt', 'Unbekannter Upload.');

    const fehlend = [];
    for (let i = 0; i < auftrag.parts; i += 1) if (!auftrag.da.has(i)) fehlend.push(i);
    if (fehlend.length) {
      return fehler(reply, 400, 'fehler.teileFehlen',
        `Es fehlen Teile: ${fehlend.slice(0, 10).join(', ')}`,
        { teile: fehlend.slice(0, 10).join(', ') });
    }

    const anhangId = newId('at_');
    const ziel = path.join(config.uploadDir, anhangId);
    const schreiber = fs.createWriteStream(ziel, { highWaterMark: 1024 * 1024 });
    try {
      for (let i = 0; i < auftrag.parts; i += 1) {
        const teil = path.join(config.uploadDir, `${id}.teil${i}`);
        await pipeline(fs.createReadStream(teil, { highWaterMark: 1024 * 1024 }), schreiber, { end: false });
      }
      await new Promise<void>((fertig, schief) => {
        schreiber.end((err?: Error | null) => (err ? schief(err) : fertig()));
      });
    } catch (err) {
      schreiber.destroy();
      await fs.promises.rm(ziel, { force: true });
      await teileAufraeumen(id, auftrag.parts);
      teilUploads.delete(id);
      return fehler(reply, 500, 'fehler.zusammensetzen',
        `Zusammensetzen fehlgeschlagen: ${(err as Error).message}`, { grund: (err as Error).message });
    }

    await teileAufraeumen(id, auftrag.parts);
    teilUploads.delete(id);

    const size = (await fs.promises.stat(ziel)).size;
    if (size !== auftrag.size) {
      await fs.promises.rm(ziel, { force: true });
      return fehler(reply, 400, 'fehler.unvollstaendig',
        `Unvollständig: ${size} statt ${auftrag.size} Bytes.`,
        { ist: String(size), soll: String(auftrag.size) });
    }

    const umschlag = umschlagVonDatei(ziel);
    const dims = !umschlag && auftrag.mime.startsWith('image/') ? await imageSize(ziel) : null;
    const summe = umschlag ? null : await dateiSumme(ziel);
    db.run(
      `INSERT INTO attachments (id, message_id, uploader_id, name, mime, size, path, width, height, sha256, huelle, created_at)
       VALUES (?, NULL, ?,?,?,?,?,?,?,?,?,?)`,
      anhangId, userId, auftrag.name, auftrag.mime, size, ziel,
      dims?.width ?? null, dims?.height ?? null, summe, huelleSchreiben(umschlag), Date.now(),
    );

    /* Ab in den Blockspeicher. Das lief hier bisher nicht, und damit ging
       ausgerechnet das an den Blöcken vorbei, wofür der Weg in Teilen
       überhaupt gebaut wurde: die großen Dateien.

       Anders als beim Upload am Stück aber erst **nach** der Antwort. Wie
       lange eine Zerlegung dauert, entscheidet der Inhalt, und die Spanne ist
       gewaltig: hier gemessen 30 MB Rauschen in 0,3 Sekunden, 8 MB packbarer
       Text in eineinhalb Minuten — jeder Block wird einzeln gepackt, und bei
       packbarem Inhalt kostet das Sekunden je Block. Diese Spanne in eine
       Antwort zu legen hieße, den Client bei ungünstigem Inhalt so lange
       warten zu lassen, dass er den Upload für gescheitert hält, obwohl
       längst alles da ist.

       Bis die Zerlegung durch ist, trägt die Zeile den Vermerk `uebernahme`:
       die Datei liegt ganz da und wird ganz ausgeliefert, niemand merkt, dass
       noch etwas läuft. Bricht der Server mittendrin ab, findet der nächste
       Start genau diesen Vermerk und fängt von vorn an.

       Verschlüsselte Dateien bleiben außen vor — der Grund steht bei
       uebernehmenWennOffen(). */
    if (!umschlag) {
      ablage.spaeterUebernehmen({
        id: anhangId, art: 'attachment', pfad: ziel, mime: auftrag.mime,
      });
    }

    return {
      attachment: {
        id: anhangId, messageId: null, name: auftrag.name, mime: auftrag.mime, size,
        url: `/files/${anhangId}`, width: dims?.width ?? null, height: dims?.height ?? null,
      },
    };
  });

  /* ── Team-Ablage ───────────────────────────────────────────── */

  app.post('/api/files', async (req, reply) => {
    const userId = requireUser(req);
    if (!may(userId, 'file.upload')) {
      return fehler(reply, 403, 'fehler.keinRechtAblage', 'Dir fehlt das Recht, Dateien abzulegen.');
    }
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) return fehler(reply, 400, 'fehler.keineDatei', 'Keine Datei im Request');

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
      return fehler(reply, 500, 'fehler.uploadFehlgeschlagen',
        `Upload fehlgeschlagen: ${(err as Error).message}`, { grund: (err as Error).message });
    }
    if (file.file.truncated) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 413, 'fehler.dateiZuGross',
        `Datei überschreitet ${config.maxUploadBytes / 1024 / 1024} MB`,
        { mb: String(config.maxUploadBytes / 1024 / 1024) });
    }

    const size = (await fs.promises.stat(target)).size;
    /* Ob eine Datei privat ist, entscheidet ihr Inhalt und nicht das Formular.
       Ein Feld "privat=1" wäre eine Behauptung, und die Zusage "nicht einmal
       der Host sieht das" darf nicht auf einer Behauptung ruhen: eine ältere
       App schickte den Klartext und bekäme trotzdem das Schloss danebengemalt.
       Umgekehrt gilt dasselbe — was verschlüsselt ankommt, ist privat, auch
       wenn das Feld fehlt. Siehe crypto/dateien.ts. */
    const umschlag = umschlagVonDatei(target);
    if (feld('privat') === '1' && !umschlag) {
      await fs.promises.rm(target, { force: true });
      return fehler(reply, 400, 'fehler.privatUnverschluesselt',
        'Diese Datei sollte privat sein, kam aber unverschlüsselt an. Bitte die App aktualisieren.');
    }
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
        privat: Boolean(umschlag),
        huelle: huelleSchreiben(umschlag),
      });
      const belegung = files.usage();
      /* Alle sollen die neue Datei sofort in der Ablage sehen — alle außer bei
         einer privaten. Die gehört einem einzigen Konto, und schon ihr Name im
         Verzeichnis aller anderen wäre mehr, als "privat" verspricht. Die
         hochladende App bekommt sie in der Antwort und lädt danach ohnehin neu. */
      if (!gespeichert.privat) broadcastAll({ t: 'file:upsert', file: gespeichert, usage: belegung });
      return { file: gespeichert, usage: belegung };
    } catch (err) {
      // Kontingent überschritten: die Datei darf nicht liegen bleiben.
      await fs.promises.rm(target, { force: true });
      return weiterreichen(reply, 409, err);
    }
  });

  /**
   * Die Ablage, wie sie für dieses Konto aussieht.
   *
   * Es gibt sie auch über die Ereignisleitung (`file:list`), aber dort fehlt
   * dem Aufruf das Konto — und ohne Konto lässt sich nicht entscheiden, wessen
   * private Dateien dazugehören. Deshalb dieser Weg: er weiß, wer fragt, und
   * gibt private Dateien nur ihrem Besitzer.
   */
  app.get('/api/files', async (req) => {
    const userId = requireUser(req);
    const q = req.query as { channelId?: string; folder?: string } | undefined;
    return {
      files: files.listFiles({ channelId: q?.channelId, folder: q?.folder, fuerUserId: userId }),
      usage: files.usage(),
    };
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
    if (!datei) return fehler(reply, 400, 'fehler.keineDatei', 'Keine Datei im Request');

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
      return weiterreichen(reply, 400, err);
    }
  });

  app.delete('/api/releases/:platform', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, 'user.manage');
    releases.removeRelease((req.params as { platform: string }).platform);
    return { releases: releases.listReleases() };
  });

  /**
   * Die Seite zum Herunterladen — nur für Angemeldete.
   *
   * Seit der Quelltext öffentlich ist, ist auch die Adresse dieses Servers
   * bekannt. Die Installationsdateien gehören trotzdem dem Team: wer keinen
   * Zugang hat, hat hier nichts zu holen. Der Nachweis darf in der Adresse
   * stehen (`?token=`), weil ein Browserfenster keinen Kopf mitschickt.
   */
  app.get('/download', async (req, reply) => {
    if (!bearerOderAdresse(req)) {
      // Zur Anmeldung schicken statt eine leere Seite zu zeigen.
      return reply.redirect('/');
    }
    const ua = String((req.headers['user-agent'] ?? ''));
    return reply.type('text/html; charset=utf-8').send(downloadSeite({
      releases: releases.listReleases(),
      erkannt: systemErkennen(ua),
      arbeitsbereich: config.workspaceName,
      token: (req.query as { token?: string } | undefined)?.token ?? '',
    }));
  });

  /** Die Datei selbst — ebenfalls nur mit Nachweis. */
  app.get('/download/:platform', async (req, reply) => {
    requireLeser(req);
    const { platform } = req.params as { platform: string };
    // Das Serverpaket gehört nicht auf die öffentliche Seite.
    if (platform === 'server') return fehler(reply, 404, 'fehler.nichtGefunden', 'Nicht gefunden');
    const vorhanden = releases.getRelease(platform);
    if (!vorhanden || !fs.existsSync(vorhanden.path)) {
      return fehler(reply, 404, 'fehler.keinBauSystem', 'Für dieses System liegt nichts bereit.');
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(vorhanden.size));
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(vorhanden.fileName)}`);
    reply.header('x-stellium-sha256', vorhanden.sha256);
    return reply.send(fs.createReadStream(vorhanden.path));
  });

  app.get('/releases/:platform/download', async (req, reply) => {
    const leser = requireLeser(req);
    const { platform } = req.params as { platform: string };
    /* Das Serverpaket ist kein Client — es enthält den kompletten Quelltext
       samt Einrichtung und gehört in die Hände derer, die den Server auch
       betreiben. Die App-Pakete darf dagegen jedes Teammitglied laden, sonst
       könnte sich niemand aktualisieren. */
    if (platform === 'server') requirePermission(leser, 'user.manage');
    const vorhanden = releases.getRelease(platform);
    if (!vorhanden || !fs.existsSync(vorhanden.path)) {
      return fehler(reply, 404, 'fehler.keinBauPlattform', 'Für diese Plattform liegt nichts bereit.');
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
    if (!datei) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');

    // Hängt die Datei an einem Kanal, gilt dessen Mitgliederkreis. Sonst
    // käme jeder mit der Kennung an Anhänge aus fremden Kanälen.
    if (datei.channelId && !store.memberIds(datei.channelId).includes(userId)) {
      return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    }

    /* Eine private Datei geht nur an ihren Besitzer. Öffnen könnte sie ohnehin
       niemand sonst — aber sie herauszugeben hieße, ihre bloße Existenz und
       ihre Größe zu bestätigen, und dafür gibt es keinen Grund. Dieselbe
       Antwort wie bei "gibt es nicht": sonst verriete schon der Unterschied,
       dass es sie gibt. */
    if (datei.privat && datei.uploadedBy !== userId) {
      return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    }

    /* Private Dateien gehen nie inline hinaus. Was hier liegt, ist Chiffrat:
       als Bild angezeigt ergäbe es ein kaputtes Bild, und der Browser bekäme
       eine Angabe über den Inhalt, die nicht stimmt. Die App holt sich die
       Datei, entschlüsselt sie und zeigt sie selbst an. */
    const inline = !datei.privat
      && (/^(image|video|audio)\//.test(datei.mime) || datei.mime === 'application/pdf');
    reply.header('content-type', datei.privat ? 'application/octet-stream' : datei.mime);
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(datei.name)}`);

    const strom = ablage.oeffnen({
      id: datei.id, art: 'file', pfad: datei.path, encoding: datei.encoding,
    });
    if (!strom) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    return reply.send(strom);
  });

  /**
   * Anhänge ausliefern — nur an Leute, die den Kanal auch sehen dürfen.
   *
   * Der Nachweis darf in der Adresse stehen (`?token=`), weil ein `<img src>`
   * keinen Kopf mitschicken kann. Ohne diese Prüfung genügte die Kennung einer
   * Datei, um sie zu holen — auch aus einem Kanal, in dem man nichts verloren
   * hat, und ganz ohne Anmeldung.
   */
  app.get('/files/:id', async (req, reply) => {
    const leser = bearerOderAdresse(req);
    if (!leser) return fehler(reply, 401, 'fehler.nichtAngemeldet', 'Nicht angemeldet');

    const { id } = req.params as { id: string };
    const row = db.get<{
      path: string; mime: string; name: string; message_id: string | null;
      uploader_id: string; encoding: string | null; huelle: string | null;
    }>(
      'SELECT path, mime, name, message_id, uploader_id, encoding, huelle FROM attachments WHERE id = ?', id,
    );
    if (!row) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');

    if (row.message_id) {
      const msg = db.get<{ channel_id: string }>(
        'SELECT channel_id FROM messages WHERE id = ?', row.message_id,
      );
      // Gleiche Antwort wie bei „gibt es nicht": sonst verrät schon der
      // Unterschied, dass diese Datei existiert.
      if (!msg || !store.memberIds(msg.channel_id).includes(leser)) {
        return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
      }
    } else if (row.uploader_id !== leser) {
      // Noch an keiner Nachricht: gehört bis dahin dem, der sie hochgeladen hat.
      return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    }

    /* Ein verschlüsselter Anhang geht nie inline hinaus — genau wie eine
       private Datei in /storage/:id, und aus demselben Grund: was hier liegt,
       ist Chiffrat. Als Bild ausgeliefert ergäbe es ein kaputtes Bild, und der
       Browser bekäme eine Angabe über den Inhalt, die nicht stimmt. Die App
       holt sich die Bytes, schließt sie auf und zeigt sie selbst an. */
    const verschlossen = Boolean(row.huelle);
    const inline = !verschlossen
      && (/^(image|video|audio)\//.test(row.mime) || row.mime === 'application/pdf');
    reply.header('content-type', verschlossen ? 'application/octet-stream' : row.mime);
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    reply.header('cache-control', 'private, max-age=31536000, immutable');

    const strom = ablage.oeffnen({ id, art: 'attachment', pfad: row.path, encoding: row.encoding });
    if (!strom) return fehler(reply, 404, 'fehler.dateiNichtGefunden', 'Datei nicht gefunden');
    return reply.send(strom);
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
