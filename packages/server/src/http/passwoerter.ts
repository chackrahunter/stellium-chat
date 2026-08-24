/**
 * Die Wege zum Passwort-Tresor — ansehen, anlegen, ändern, teilen, aufdecken.
 *
 * EIGENE DATEI, EINE ZEILE ZUM EINHÄNGEN
 *
 * Nach dem Vorbild von `http/einmalcode.ts` (siehe dort für die ausführliche
 * Begründung dieses Musters): `http/routes.ts` ist über 2400 Zeilen lang,
 * diese Wege stehen deshalb für sich und werden in `index.ts` mit einer
 * einzigen Zeile eingehängt.
 *
 * EIN EINZIGES RECHT, NICHT ZWEI
 *
 * Anders als bei Einmalcodes (`einmalcode.nutzen`/`einmalcode.verwalten`)
 * gibt es hier nur `passwort.nutzen`. Der Grund: bei Einmalcodes ist
 * "ansehen und Codes holen" etwas anderes als "Konten einrichten" — jede
 * Person im Team soll den zweiten Faktor benutzen können, ohne das Konto
 * selbst anzufassen. Beim Tresor gibt es diese Stufe nicht: wer überhaupt
 * einen Eintrag sehen darf, muss ihn auch anlegen und ändern können, sonst
 * wäre die Tafel für sie nutzlos. Wer NICHTS von alldem soll, bekommt das
 * Recht schlicht nicht — siehe packages/shared/src/permissions.ts.
 *
 * WAS HIER NIE HERAUSKOMMT
 *
 * Der Klartext. `chiffrat` geht als undurchsichtige Zeichenkette hinein und
 * wieder heraus — diese Datei entschlüsselt nichts, kann es nicht (der
 * Server hat keinen der beteiligten Schlüssel) und soll es nicht können.
 *
 * ZWEI HÜLLEN, ZWEI WEGE — UND NUR EINER DAVON SCHREIBT
 *
 * GET /api/passwoerter liefert das SCHAUFENSTER jedes Eintrags (Etikett,
 * Benutzername, Notiz, Adresse). Ein Passwort ist da nicht dabei, und beim
 * Altbestand kommt die alte Hülle gar nicht erst mit — sie enthielte eines.
 * Das PASSWORT gibt es ausschließlich über POST .../geheimnis, und dieser
 * Weg vermerkt die Aushändigung, bevor er antwortet (services/passwoerter.ts,
 * geheimnisAusliefern()).
 *
 * HIER STAND EINMAL POST .../offenlegen — "ich habe gerade hingesehen",
 * gemeldet vom Client, nachdem er den Klartext längst hatte. Der Weg ist
 * entfallen: eine Meldung, die man weglassen kann, ohne etwas zu verlieren,
 * ist kein Protokoll. Eine ältere App ruft ihn noch und bekommt jetzt 404;
 * sie fängt das ohnehin ab, und ihre Vermerke fehlten vorher genauso, wenn
 * jemand die Anfrage unterdrückte.
 *
 * DIE PRÜFUNG STEHT SERVERSEITIG, AUF JEDEM WEG — nicht nur auf den
 * schreibenden. Auch GET /api/passwoerter verlangt `passwort.nutzen`: die
 * Oberfläche blendet den Reiter zwar schon aus, wenn das Recht fehlt (siehe
 * Rail.tsx), aber das ist Höflichkeit, keine Schranke. Durchgesetzt wird
 * ausschließlich hier.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { KontoPaket, PermissionKey, SchluesselPaket } from '@stellium/shared';
import { verifyToken } from '../auth.js';
import { may } from '../services/users.js';
import { Abweisung } from '../util/abweisung.js';
import * as passwoerter from '../services/passwoerter.js';

const RECHT = 'passwort.nutzen' as PermissionKey;

function requireUser(req: FastifyRequest): string {
  const roh = req.headers.authorization;
  const id = roh?.startsWith('Bearer ') ? verifyToken(roh.slice(7)) : null;
  if (!id) {
    const err = new Error('Nicht angemeldet') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return id;
}

/** Dieselbe Machart wie requirePermission() in http/einmalcode.ts: `code`
 *  trägt die Wörterbuchkennung des Rechts, der deutsche Text daneben ist
 *  der Rückfall für eine ältere App, die die Kennung noch nicht kennt. */
function requirePermission(userId: string): void {
  if (may(userId, RECHT)) return;
  const err = new Error('Dafür fehlt dir das Recht "Passwort-Tresor nutzen".') as Error & { statusCode?: number; code?: string };
  err.statusCode = 403;
  err.code = `perm.${RECHT}.label`;
  throw err;
}

function fehler(reply: FastifyReply, status: number, code: string, text: string) {
  return reply.code(status).send({ error: text, code });
}

function abgewiesen(reply: FastifyReply, f: unknown) {
  if (f instanceof Abweisung) {
    const status = f.code === 'fehler.passwortNichtGefunden' ? 404 : 400;
    return fehler(reply, status, f.code, f.message);
  }
  throw f;
}

function text(wert: unknown): string {
  return typeof wert === 'string' ? wert : '';
}

function istPaket(wert: unknown): wert is SchluesselPaket {
  const p = wert as Partial<SchluesselPaket> | undefined;
  return Boolean(p && typeof p.alg === 'string' && typeof p.von === 'string' && typeof p.iv === 'string' && typeof p.daten === 'string');
}

function istKontoPaket(wert: unknown): wert is KontoPaket {
  const p = wert as Partial<KontoPaket> | undefined;
  return Boolean(p && typeof p.alg === 'string' && typeof p.kontoFassung === 'number' && typeof p.iv === 'string' && typeof p.daten === 'string');
}

export function registerPasswoerter(app: FastifyInstance): void {
  /* ── Liste ───────────────────────────────────────────────────── */

  /**
   * Die eigenen und geteilten Einträge, dazu die zwei Nachwuchslisten des
   * Kontowegs/Geräteswegs (siehe services/passwoerter.ts,
   * eintraegeOhneKontoPaket()/eigeneUnverpackteMitglieder()) — beim
   * HTTP-Pull-Modell fragt die App das bei jedem Öffnen der Tafel einmal ab,
   * statt auf einen WebSocket-Anstoß zu warten (dieselbe Bauart wie
   * PaypalPanel/EinmalcodePanel, nicht die der Notizen-Tafel).
   */
  app.get('/api/passwoerter', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId);
    return {
      eintraege: passwoerter.listEintraege(userId),
      eigenePakete: passwoerter.paketeFuerAlle(userId),
      kontoPakete: passwoerter.kontoPaketeFuerAlle(userId),
      kontoLuecken: passwoerter.eintraegeOhneKontoPaket(userId),
      unverpackteMitglieder: passwoerter.eigeneUnverpackteMitglieder(userId),
    };
  });

  /* ── Anlegen, Speichern, Löschen ─────────────────────────────── */

  app.post('/api/passwoerter', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const b = req.body as {
      id?: unknown; chiffrat?: unknown; paket?: unknown; kontoPaket?: unknown; geheimChiffrat?: unknown;
    };
    if (!istPaket(b?.paket)) return fehler(reply, 400, 'fehler.passwortSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');
    try {
      const eintrag = passwoerter.anlegen({
        id: text(b.id), ownerId: userId, chiffrat: text(b.chiffrat), paket: b.paket,
        kontoPaket: istKontoPaket(b.kontoPaket) ? b.kontoPaket : undefined,
        geheimChiffrat: typeof b.geheimChiffrat === 'string' ? b.geheimChiffrat : undefined,
      });
      return { eintrag };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  app.patch('/api/passwoerter/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const { id } = req.params as { id: string };
    const b = req.body as {
      chiffrat?: unknown; version?: unknown; force?: unknown; geheimChiffrat?: unknown; getrennt?: unknown;
    };
    try {
      const ergebnis = passwoerter.speichern({
        eintragId: id, userId, chiffrat: text(b?.chiffrat),
        version: Number(b?.version) || 0, force: Boolean(b?.force),
        geheimChiffrat: typeof b?.geheimChiffrat === 'string' ? b.geheimChiffrat : undefined,
        getrennt: b?.getrennt === true,
      });
      return ergebnis;
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  app.delete('/api/passwoerter/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const { id } = req.params as { id: string };
    try {
      passwoerter.loeschen(id, userId);
      return { ok: true };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  /* ── Mitglieder / Teilen ─────────────────────────────────────── */

  app.post('/api/passwoerter/:id/mitglieder', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const { id } = req.params as { id: string };
    const b = req.body as { userId?: unknown; paket?: unknown };
    if (!istPaket(b?.paket)) return fehler(reply, 400, 'fehler.passwortSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');
    try {
      const eintrag = passwoerter.mitgliedHinzufuegen({
        eintragId: id, ownerId: userId, zielUserId: text(b.userId), paket: b.paket,
      });
      return { eintrag };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  /** Nachreichen — dieselbe Aktion wie oben, nur verzögert, weil beim
   *  ursprünglichen Hinzufügen noch kein öffentlicher Teil des Ziels vorlag.
   *  Siehe services/notizen.ts, paketeNachreichen() für das Vorbild. */
  app.post('/api/passwoerter/:id/mitglieder/nachreichen', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const { id } = req.params as { id: string };
    const b = req.body as { userId?: unknown; paket?: unknown };
    if (!istPaket(b?.paket)) return fehler(reply, 400, 'fehler.passwortSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');
    try {
      passwoerter.paketeNachreichen({ eintragId: id, ownerId: userId, zielUserId: text(b.userId), paket: b.paket });
      return { ok: true };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  app.post('/api/passwoerter/:id/mitglieder/entfernen', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const { id } = req.params as { id: string };
    const b = req.body as {
      userId?: unknown; neueFassung?: unknown; chiffrat?: unknown; version?: unknown;
      pakete?: { userId?: unknown; paket?: unknown }[]; geheimChiffrat?: unknown;
    };
    const pakete = Array.isArray(b?.pakete)
      ? b.pakete.filter((p): p is { userId: string; paket: SchluesselPaket } => istPaket(p?.paket) && typeof p.userId === 'string')
      : [];
    try {
      const eintrag = passwoerter.mitgliedEntfernen({
        eintragId: id, ownerId: userId, zielUserId: text(b?.userId),
        neueFassung: Number(b?.neueFassung) || 0, chiffrat: text(b?.chiffrat),
        version: Number(b?.version) || 0, pakete,
        geheimChiffrat: typeof b?.geheimChiffrat === 'string' ? b.geheimChiffrat : undefined,
      });
      return { eintrag };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  /* ── Kontoweg ────────────────────────────────────────────────── */

  app.post('/api/passwoerter/:id/konto-paket', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const { id } = req.params as { id: string };
    const b = req.body as { fassung?: unknown; paket?: unknown };
    if (!istKontoPaket(b?.paket)) return fehler(reply, 400, 'fehler.passwortSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');
    try {
      passwoerter.kontoPaketSetzen({ eintragId: id, userId, fassung: Number(b.fassung) || 0, paket: b.paket });
      return { ok: true };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  /* ── Das Geheimnis ───────────────────────────────────────────── */

  /**
   * Das Passwort holen — der einzige Weg dorthin.
   *
   * POST, nicht GET, und das ist hier keine Geschmacksfrage: der Aufruf hat
   * eine Wirkung, er schreibt eine Zeile in `passwort_offenlegungen`. Ein
   * GET dürfte ein Zwischenspeicher wiederholen oder auslassen, und beides
   * wäre in einem Protokoll falsch — einmal eine Zeile zu viel, einmal ein
   * Passwort ohne Zeile.
   *
   * Heraus kommt eine verschlüsselte Hülle, kein Klartext. Der Server weiß
   * weiterhin nicht, was darin steht; er weiß nur, dass er sie herausgegeben
   * hat, und genau das schreibt er auf.
   */
  app.post('/api/passwoerter/:id/geheimnis', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const { id } = req.params as { id: string };
    try {
      return passwoerter.geheimnisAusliefern(id, userId);
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  /** Wer diesen Eintrag wann aufgedeckt hat — nur für die besitzende Person
   *  (services/passwoerter.ts prüft das selbst noch einmal, unabhängig von
   *  dieser Route). */
  app.get('/api/passwoerter/:id/offenlegungen', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId);
    const { id } = req.params as { id: string };
    try {
      return { offenlegungen: passwoerter.offenlegungenFuer(id, userId) };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });
}
