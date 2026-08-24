/**
 * Die Wege zum Gedächtnis der Firmenpost — ansehen, pflegen, entscheiden,
 * löschen.
 *
 * EIGENE DATEI, EINE ZEILE ZUM EINHÄNGEN
 *
 * `http/routes.ts` ist 2400 Zeilen lang und wird gerade an mehreren Stellen
 * bearbeitet. Diese Wege stehen deshalb für sich, nach dem Vorbild von
 * `http/posteingang.ts` und `http/konsole.ts`, und werden in `index.ts` mit
 * einer einzigen Zeile eingehängt. `requireUser`, `requirePermission` und
 * `fehler` sind in routes.ts nicht exportiert (sie leben innerhalb von
 * `registerRoutes`), stehen hier also noch einmal — kleiner und mit demselben
 * Verhalten: 401 ohne Anmeldung, 403 ohne Recht, und im Fehlerfall eine
 * Wörterbuchkennung neben dem deutschen Text, damit die Oberfläche übersetzen
 * kann statt den Serversatz anzuzeigen.
 *
 * DIE ZWEI SCHWELLEN
 *
 *   · `mail.lesen` — ansehen. Wer die Post bearbeitet, muss nachschlagen
 *     können, woher ein Satz im Entwurf stammt. Ein Gedächtnis, in das nur
 *     die Verwaltung hineinsieht, ist genau das unbeherrschbare Gedächtnis,
 *     das der Auftrag ausschließt.
 *   · `mail.verwalten` — ändern und entscheiden. Was hier steht, geht als
 *     Tatsache im Namen der Firma hinaus: Preise, Erstattungen,
 *     Zuständigkeiten. Das ist Einrichtung des Postfachs, nicht Tagesarbeit —
 *     dasselbe Recht, hinter dem auch die Aufbewahrungsfristen und der
 *     Postfachzugang liegen. Ein neues Recht wäre dafür nicht nötig, und
 *     Rechte, die niemand vergibt, schützen niemanden.
 *
 * KEIN WEG NACH DRAUSSEN
 *
 * Hier wird nichts gesendet und nichts entworfen. Der einzige Schreibzugriff
 * geht in `mail_wissen`/`mail_wissen_vorschlaege`; `services/post.ts` ist
 * nicht eingebunden. Was nicht eingebunden ist, kann nicht aufgerufen werden —
 * dieselbe Nachprüfbarkeit, die post-sichtung.ts für sich in Anspruch nimmt.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyToken } from '../auth.js';
import { may } from '../services/users.js';
import * as wissen from '../services/post-wissen.js';
import type { WissenArt } from '../services/post-wissen-ki.js';

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

function requirePermission(userId: string, recht: 'mail.lesen' | 'mail.verwalten'): void {
  if (may(userId, recht)) return;
  const err = new Error(
    recht === 'mail.verwalten'
      ? 'Dafür fehlt dir das Recht "Postfach einrichten".'
      : 'Dafür fehlt dir das Recht "Postfach lesen".',
  ) as Error & { statusCode?: number };
  err.statusCode = 403;
  throw err;
}

function fehler(reply: FastifyReply, status: number, code: string, text: string) {
  return reply.code(status).send({ error: text, code });
}

/** Ein Text aus der Anfrage — nie undefined, nie ein Objekt. */
function text(wert: unknown): string {
  return typeof wert === 'string' ? wert : '';
}

export function registerPostGedaechtnis(app: FastifyInstance): void {
  /* ── Ansehen ─────────────────────────────────────────────────── */

  /**
   * Was gilt — und was einmal galt.
   *
   * `alle=1` nimmt die abgelösten Einträge mit. Sie stehen nicht in der
   * Anweisung ans Modell, aber sie beantworten die Frage „warum schreibt sie
   * das seit gestern anders?" — und genau die muss beantwortbar sein.
   */
  app.get('/api/post/wissen', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const q = req.query as { alle?: string };
    const alle = q.alle === '1';
    return {
      eintraege: alle ? wissen.alleEintraege() : wissen.aktiveEintraege(),
      anzahl: wissen.aktiveAnzahl(),
      max: wissen.EINTRAEGE_MAX,
      offeneVorschlaege: wissen.offeneAnzahl(),
    };
  });

  app.get('/api/post/wissen/vorschlaege', async (req) => {
    requirePermission(requireUser(req), 'mail.lesen');
    const q = req.query as { offen?: string };
    return {
      vorschlaege: wissen.vorschlaegeListe(q.offen === '1'),
      offen: wissen.offeneAnzahl(),
      max: wissen.OFFEN_MAX,
    };
  });

  /* ── Pflegen ─────────────────────────────────────────────────── */

  app.post('/api/post/wissen', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    const k = req.body as {
      art?: string; thema?: string; inhalt?: string; stichworte?: string;
      immer?: boolean; fach?: string | null;
    };
    const ergebnis = wissen.eintragAnlegen({
      art: (k?.art === 'stil' ? 'stil' : 'wissen') as WissenArt,
      thema: text(k?.thema),
      inhalt: text(k?.inhalt),
      stichworte: text(k?.stichworte),
      immer: k?.immer === true,
      fach: k?.fach ? text(k.fach) : null,
    }, userId);

    if (!ergebnis.ok && ergebnis.grund === 'ungueltig') {
      return fehler(reply, 400, 'post.wissenUnvollstaendig', 'Thema und Inhalt dürfen nicht leer sein.');
    }
    if (!ergebnis.ok) {
      return fehler(reply, 409, 'post.wissenVoll',
        `Das Gedächtnis fasst ${wissen.EINTRAEGE_MAX} Einträge. Bitte zuerst einen löschen.`);
    }
    return { eintrag: ergebnis.eintrag };
  });

  app.patch('/api/post/wissen/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    const { id } = req.params as { id: string };
    const k = req.body as {
      art?: string; thema?: string; inhalt?: string; stichworte?: string;
      immer?: boolean; fach?: string | null;
    };
    const eintrag = wissen.eintragAendern(id, {
      art: (k?.art === 'stil' ? 'stil' : 'wissen') as WissenArt,
      thema: text(k?.thema),
      inhalt: text(k?.inhalt),
      stichworte: text(k?.stichworte),
      immer: k?.immer === true,
      fach: k?.fach ? text(k.fach) : null,
    });
    if (!eintrag) {
      return fehler(reply, 400, 'post.wissenUnvollstaendig',
        'Diesen Eintrag gibt es nicht mehr, oder Thema und Inhalt sind leer.');
    }
    return { eintrag };
  });

  /**
   * Löschen — endgültig, nicht ablösen.
   *
   * Das ist die Hälfte der Zusage „einsehbar UND löschbar". Wer merkt, dass
   * die KI Unsinn schreibt, muss nachsehen können, woher er kommt, und ihn
   * entfernen können — ohne einen Administrator, der eine Datenbank aufmacht.
   */
  app.delete('/api/post/wissen/:id', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    const { id } = req.params as { id: string };
    if (!wissen.eintragLoeschen(id)) {
      return fehler(reply, 404, 'fehler.nichtGefunden', 'Diesen Eintrag gibt es nicht.');
    }
    return { ok: true };
  });

  /* ── Entscheiden ─────────────────────────────────────────────── */

  /**
   * Ja, Nein oder Ändern.
   *
   * `thema`/`inhalt` im Rumpf sind das „Ändern": oft ist die Beobachtung
   * richtig und nur die Formulierung schief. Wer dann nur Ja und Nein hat,
   * wirft eine richtige Beobachtung weg — deshalb ist der dritte Knopf keine
   * Bequemlichkeit, sondern der wichtigste der drei.
   *
   * `ersetzen` gilt nur bei einem Widerspruch: true löst den bisherigen
   * Eintrag ab (er bleibt lesbar), false stellt beide nebeneinander. Ohne
   * Widerspruch ist der Wert bedeutungslos.
   */
  app.post('/api/post/wissen/vorschlaege/:id/entscheiden', async (req, reply) => {
    const userId = requireUser(req);
    requirePermission(userId, 'mail.verwalten');
    const { id } = req.params as { id: string };
    const k = req.body as {
      ergebnis?: string; thema?: string; inhalt?: string; ersetzen?: boolean;
    };
    if (k?.ergebnis !== 'angenommen' && k?.ergebnis !== 'abgelehnt') {
      return fehler(reply, 400, 'post.wissenEntscheidungFehlt', 'Bitte annehmen oder ablehnen.');
    }

    const ergebnis = wissen.vorschlagEntscheiden({
      id, userId,
      ergebnis: k.ergebnis,
      thema: typeof k.thema === 'string' ? k.thema : undefined,
      inhalt: typeof k.inhalt === 'string' ? k.inhalt : undefined,
      ersetzen: k.ersetzen === true,
    });

    switch (ergebnis.ergebnis) {
      case 'unbekannt':
        return fehler(reply, 404, 'fehler.nichtGefunden', 'Diesen Vorschlag gibt es nicht.');
      case 'nichtOffen':
        return fehler(reply, 409, 'post.wissenSchonEntschieden', 'Über diesen Vorschlag ist schon entschieden.');
      case 'ungueltig':
        return fehler(reply, 400, 'post.wissenUnvollstaendig', 'Thema und Inhalt dürfen nicht leer sein.');
      case 'voll':
        return fehler(reply, 409, 'post.wissenVoll',
          `Das Gedächtnis fasst ${wissen.EINTRAEGE_MAX} Einträge. Bitte zuerst einen löschen.`);
      default:
        return { ok: true, ergebnis: ergebnis.ergebnis, offen: wissen.offeneAnzahl() };
    }
  });
}
