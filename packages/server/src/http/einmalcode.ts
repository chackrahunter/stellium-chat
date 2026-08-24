/**
 * Die Wege zu den Einmalcodes — ansehen, Code holen, Konten einrichten.
 *
 * EIGENE DATEI, EINE ZEILE ZUM EINHÄNGEN
 *
 * `http/routes.ts` ist über 2400 Zeilen lang und wird gerade an mehreren
 * Stellen bearbeitet. Diese Wege stehen deshalb für sich, nach dem Vorbild von
 * `http/postgedaechtnis.ts` und `http/konsole.ts`, und werden in `index.ts`
 * mit einer einzigen Zeile eingehängt. `requireUser` und `fehler` sind in
 * routes.ts nicht exportiert (sie leben innerhalb von `registerRoutes`),
 * stehen hier also noch einmal — kleiner und mit demselben Verhalten: 401 ohne
 * Anmeldung, 403 ohne Recht, und im Fehlerfall eine Wörterbuchkennung neben
 * dem deutschen Text, damit die Oberfläche in ihrer eigenen Sprache
 * antworten kann statt den Serversatz anzuzeigen.
 *
 * DIE ZWEI SCHWELLEN
 *
 *   · `einmalcode.nutzen` — die Tafel sehen und Codes holen. Das ist der
 *     ganze Zweck: niemand soll mehr auf den Kollegen mit dem Telefon warten.
 *   · `einmalcode.verwalten` — Konten anlegen, ändern, löschen, und die Liste
 *     der Abrufe lesen. `ownerOnly`, wie `fern.verwalten` und
 *     `mail.verwalten`.
 *
 * Beide Rechte stehen noch nicht in packages/shared/src/permissions.ts — die
 * Datei liegt gerade bei jemand anderem, die Schlüssel stehen in der
 * Einbauliste. Bis sie dort ankommen, VERSAGT DIESE TAFEL VOLLSTÄNDIG UND IN
 * DIE RICHTIGE RICHTUNG: `permissionsFor()` baut seine Karte aus
 * `PERMISSION_KEYS`, ein unbekannter Schlüssel ist darin schlicht nicht
 * enthalten, `may()` vergleicht `undefined === true` und gibt false. Jeder
 * Weg hier antwortet dann mit 403 — auch dem Inhaber gegenüber. Ein
 * halbfertiger Einbau öffnet also nichts, er schließt.
 *
 * WAS HIER NIE HERAUSKOMMT
 *
 * Das Geheimnis. Es geht in `POST /api/einmalcode/konten` hinein und kommt
 * durch keinen Weg wieder heraus — nicht in einer Antwort, nicht verkürzt,
 * nicht in einem Fehlertext. `services/einmalcode.ts` entschlüsselt es an
 * genau einer Stelle, und die gibt Ziffern zurück, kein Geheimnis.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PermissionKey } from '@stellium/shared';
import { verifyToken } from '../auth.js';
import { may } from '../services/users.js';
import { Abweisung } from '../util/abweisung.js';
import * as einmalcode from '../services/einmalcode.js';

/* Siehe Dateikopf: die Schlüssel gibt es im Katalog noch nicht, deshalb der
   Umweg über den Typ. Sobald sie dort stehen, kann der Cast weg — der Wert
   ist schon heute derselbe. */
const RECHT_NUTZEN = 'einmalcode.nutzen' as PermissionKey;
const RECHT_VERWALTEN = 'einmalcode.verwalten' as PermissionKey;

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

/**
 * Recht prüfen.
 *
 * `code` trägt die Wörterbuchkennung des RECHTS, genau wie `requirePermission`
 * in routes.ts es tut (`perm.<key>.label`) — die Oberfläche setzt daraus
 * ihren eigenen Satz zusammen und zeigt nie den deutschen hier. Der deutsche
 * Text daneben ist der Rückfall für eine ältere App, die die Kennung noch
 * nicht kennt; so hält es das ganze Haus (siehe net/api.ts,
 * `uebersetzterFehler`).
 */
function requirePermission(userId: string, recht: PermissionKey): void {
  if (may(userId, recht)) return;
  const err = new Error(
    recht === RECHT_VERWALTEN
      ? 'Dafür fehlt dir das Recht "Einmalcodes einrichten".'
      : 'Dafür fehlt dir das Recht "Einmalcodes nutzen".',
  ) as Error & { statusCode?: number; code?: string };
  err.statusCode = 403;
  err.code = `perm.${recht}.label`;
  throw err;
}

function fehler(reply: FastifyReply, status: number, code: string, text: string) {
  return reply.code(status).send({ error: text, code });
}

/** Eine Abweisung aus dem Dienst in eine Antwort verwandeln. */
function abgewiesen(reply: FastifyReply, f: unknown) {
  if (f instanceof Abweisung) {
    const status = f.code === 'fehler.einmalcodeKonto' ? 404 : 400;
    return fehler(reply, status, f.code, f.message);
  }
  throw f;
}

/** Ein Text aus der Anfrage — nie undefined, nie ein Objekt. */
function text(wert: unknown): string {
  return typeof wert === 'string' ? wert : '';
}

export function registerEinmalcode(app: FastifyInstance): void {
  /* ── Ansehen ─────────────────────────────────────────────────── */

  /**
   * Die Tafel beim Öffnen: welche Konten es gibt, wie spät es auf dem Server
   * ist, und ob dessen Uhr etwas taugt.
   *
   * **Hier entsteht kein einziger Code.** Das ist Absicht und nicht bloß
   * Sparsamkeit: solange niemand ausdrücklich auf „anzeigen" drückt, wird
   * nichts gerechnet, nichts übertragen und nichts im Nachweis vermerkt. Eine
   * Tafel, die beim bloßen Öffnen sechs Ziffern auf den Schirm legt, legt sie
   * auch in jede Bildschirmaufnahme und in jede geteilte Ansicht — und dieser
   * Chat kann beides.
   *
   * `darfVerwalten` steht ausdrücklich in der Antwort, statt dass die
   * Oberfläche in ihrer Rechtekarte nachsieht: sie soll sich beim Ausblenden
   * des Einrichtungsteils auf dieselbe Quelle stützen, die auch die
   * Schreibwege prüfen.
   */
  app.get('/api/einmalcode', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, RECHT_NUTZEN);
    const konten = einmalcode.kontenListe();
    /* Die Uhr wird gegen die KÜRZESTE Periode geprüft: die Schwelle ist eine
       halbe Periode, und die kürzeste ergibt die strengste Schwelle. Ohne
       Konto die Vorgabe aus der RFC. */
    const zeit = einmalcode.zeitstand(
      konten.length ? Math.min(...konten.map((k) => k.periode)) : undefined,
    );
    return {
      konten,
      zeit,
      /* Auch ganz oben, und zwar in JEDER Antwort dieser Wege: die App misst
         daran den Versatz ihrer eigenen Uhr (halbe Umlaufzeit herausgerechnet,
         siehe desktop/state/einmalcode-zeit.ts, `versatzMessen`). Ein
         einheitliches Feld an derselben Stelle erspart einen eigenen Weg nur
         für die Uhrzeit — und damit eine zweite Anfrage, deren Umlaufzeit
         wieder anders wäre. */
      serverMs: zeit.serverMs,
      darfVerwalten: may(userId, RECHT_VERWALTEN),
      vorratFenster: einmalcode.VORRAT_FENSTER,
    };
  });

  /**
   * Codes holen — der einzige Weg, auf dem aus dem Geheimnis Ziffern werden.
   *
   * POST und nicht GET, obwohl nichts geändert wird: der Aufruf HAT eine
   * Wirkung — er landet im Nachweis (`einmalcode_abrufe`) —, und POST hält
   * jeden Zwischenspeicher, jeden Vorablader und jede Wiederholung durch den
   * Browser von allein davon ab. Ein GET auf einen gültigen zweiten Faktor
   * ist eine Adresse, die irgendwann in einem Verlauf steht.
   *
   * Zurück kommt nicht ein Code, sondern der laufende und die nächsten paar
   * Fenster — siehe services/einmalcode.ts, Stichwort VORRAT.
   */
  app.post('/api/einmalcode/konten/:id/codes', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, RECHT_NUTZEN);
    const { id } = req.params as { id: string };
    /* Kein Zwischenspeicher, nirgends — weder im Browser noch in einem
       Vermittler davor. Was hier steht, ist dreißig Sekunden lang ein
       Schlüssel zum Firmenkonto. */
    reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
    reply.header('pragma', 'no-cache');
    try {
      return einmalcode.codesHolen(id, userId);
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  /* ── Einrichten ──────────────────────────────────────────────── */

  /**
   * Ein Konto anlegen.
   *
   * `geheimnis` nimmt beides: die ganze `otpauth://`-Adresse hinter Googles
   * QR-Code oder das nackte Geheimnis aus der Zeile darunter. Welches von
   * beiden es war, entscheidet der Kern (services/einmalcode-kern.ts,
   * `eingabeLesen`).
   *
   * Bewusst OHNE `schema:` an der Route: eine Prüfung durch Fastify würde bei
   * einem Fehlschlag den beanstandeten Pfad in die Antwort schreiben, und der
   * Pfad heißt hier `geheimnis`. Die Prüfung darunter tut dasselbe, ohne je
   * den Wert anzufassen.
   */
  app.post('/api/einmalcode/konten', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, RECHT_VERWALTEN);
    const k = req.body as { bezeichnung?: unknown; geheimnis?: unknown };
    if (!text(k?.geheimnis).trim()) {
      return fehler(reply, 400, 'fehler.einmalcodeOhneGeheimnis', 'Ohne Geheimnis geht es nicht.');
    }
    try {
      const konto = einmalcode.kontoAnlegen(
        { bezeichnung: text(k.bezeichnung), geheimnis: text(k.geheimnis) }, userId,
      );
      return { konto, konten: einmalcode.kontenListe() };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  /**
   * Umbenennen oder das Geheimnis austauschen.
   *
   * Ein weggelassenes `geheimnis` lässt das bisherige stehen — sonst ließe
   * sich ein Konto nicht umbenennen, ohne ein Geheimnis noch einmal
   * einzugeben, das man nirgends mehr ablesen kann.
   */
  app.patch('/api/einmalcode/konten/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, RECHT_VERWALTEN);
    const { id } = req.params as { id: string };
    const k = req.body as { bezeichnung?: unknown; geheimnis?: unknown };
    try {
      const konto = einmalcode.kontoAendern(id, {
        bezeichnung: k?.bezeichnung === undefined ? undefined : text(k.bezeichnung),
        geheimnis: text(k?.geheimnis),
      }, userId);
      return { konto, konten: einmalcode.kontenListe() };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  app.delete('/api/einmalcode/konten/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, RECHT_VERWALTEN);
    const { id } = req.params as { id: string };
    try {
      einmalcode.kontoLoeschen(id);
      return { konten: einmalcode.kontenListe() };
    } catch (f) {
      return abgewiesen(reply, f);
    }
  });

  /**
   * Wer wann einen Code geholt hat.
   *
   * Hinter `einmalcode.verwalten` und nicht hinter `einmalcode.nutzen`: das
   * ist eine Aufsichtsfrage, keine Tagesarbeit. Welcher Code es war, steht
   * nirgends — siehe services/einmalcode.ts.
   */
  app.get('/api/einmalcode/abrufe', async (req) => {
    const userId = requireUser(req);
    requirePermission(userId, RECHT_VERWALTEN);
    const q = req.query as { grenze?: string };
    const grenze = Number(q?.grenze);
    return { abrufe: einmalcode.abrufeListe(Number.isFinite(grenze) ? grenze : 200) };
  });
}
