/**
 * Volltextsuche über das Firmenpostfach.
 *
 * DIE ENTSCHEIDUNG: DERSELBE FINGERABDRUCK-INDEX WIE BEI CHATNACHRICHTEN
 *
 * Betreff und Text liegen verschlüsselt (crypto/nachrichten.ts) — der Server
 * kann nicht mit `LIKE` danach suchen, ohne sie reihenweise zu entschlüsseln.
 * Für Chatnachrichten löst db/index.ts (message_fts) genau das schon: ein
 * FTS5-Index, der nicht die Wörter selbst trägt, sondern ihre HMAC-
 * Fingerabdrücke (`suchWorte()`/`suchBegriffe()` in crypto/nachrichten.ts) —
 * wer den Index liest, sieht bedeutungslose Zeichenfolgen, wer sucht, bildet
 * dieselben Fingerabdrücke und findet damit dieselben Zeilen.
 *
 * Für das Postfach fällt dieselbe Wahl, aus drei Gründen:
 *
 *   1. WACHSTUM. Genau das nennt der Auftrag als Grund, warum Suche hier am
 *      meisten fehlt — ein wachsendes Postfach lässt sich nicht auf Dauer im
 *      Gerätespeicher durchsuchen. Eine Suche, die nur über die GELADENE
 *      Liste liefe (Vorschlag B), fände zuverlässig nur, was gerade im
 *      Speicher der Oberfläche liegt — bei einer Standardseite von 50 wäre
 *      jede ältere oder archivierte Mail für die Suche unsichtbar, obwohl sie
 *      im Postfach längst noch da ist.
 *   2. DASSELBE BEDROHUNGSMODELL. Post ist Schriftwechsel mit Kunden und
 *      Fremden, verschlüsselt aus genau demselben Grund wie Chatnachrichten
 *      (siehe Dateikopf services/post.ts). Ein zweites, eigenes Suchverfahren
 *      zu erfinden hieße, dieselbe Abwägung ein zweites Mal zu treffen, mit
 *      dem Risiko, sie beim zweiten Mal schlechter zu treffen — die Vorgabe
 *      der Aufgabe war ausdrücklich, KEINE Suche zu bauen, die heimlich
 *      unverschlüsselt mitschreibt.
 *   3. FERTIGES, GEPRÜFTES VERFAHREN. Fingerabdruck-Bildung, FTS5-Aufbau,
 *      der Rückfall auf eine LIKE-Suche ohne FTS5 und die Neuaufbau-Logik bei
 *      einem Schlüsselwechsel existieren bereits (db/index.ts,
 *      services/search.ts) und sind über den Chat im Alltag geprüft. Diese
 *      Datei übernimmt dieselbe Bauart für `mail_fts`, nicht eine eigene.
 *
 * Der Preis ist derselbe wie beim Chat: keine Präfixsuche mehr ("Rech" findet
 * nicht mehr "Rechnung") — ein Fingerabdruck hat keinen gemeinsamen Anfang
 * mit einem anderen. Ganze Wörter zu finden ist der Kompromiss, den
 * Vertraulichkeit hier kostet, und er gilt heute schon für den Chat.
 *
 * WARUM AUCH ABSENDER, FACH UND ANHANGNAMEN
 *
 * Der Auftrag nennt Betreff, Text, Absender UND Fach als das, wonach gesucht
 * werden soll. `fach` liegt ohnehin unverschlüsselt (die Ordner der
 * Oberfläche entstehen daraus, siehe services/post.ts), Absender (`von`) ist
 * verschlüsselt wie Betreff und Text — beide Wörter landen deshalb GENAUSO im
 * Fingerabdruck-Bündel wie der Nachrichtentext selbst (siehe reindexMail() in
 * db/index.ts). Eine Suche nach "billing" findet damit sowohl Post IM Fach
 * billing als auch Post, die zufällig das Wort "billing" im Text erwähnt —
 * dieselbe, aus dem Chat bekannte Eigenschaft eines einzigen Bündels statt
 * getrennter Felder.
 *
 * Anhangnamen liegen seit Kurzem ebenfalls verschlüsselt (siehe
 * anhaengeAuspacken() in post.ts) und gehören aus genau demselben Grund mit
 * hinein: eine Bewerbung heißt oft "Lebenslauf.pdf", eine Rechnung
 * "Rechnung-2026-04.pdf" — wer sich an den Dateinamen erinnert, aber nicht
 * mehr daran, was im Anschreiben stand, soll trotzdem fündig werden. Der
 * Anhang selbst (sein Inhalt) wird NICHT durchsucht — nur sein Name, genau wie
 * bei Betreff/Text/Absender auch nur der jeweilige Text, nie eine Datei.
 *
 * WAS DIESE DATEI NICHT TUT
 *
 * Sie prüft keine Rechte — `mail.lesen` gilt für das GANZE Postfach (keine
 * Kanal-Sichtbarkeit wie beim Chat, siehe services/search.ts,
 * `visibleChannels()`), die Schwelle sitzt deshalb wie bei jeder anderen
 * Postfach-Route allein in http/routes.ts.
 */
import { db } from '../db/index.js';
import { entschluesseln, suchBegriffe } from '../crypto/nachrichten.js';
import { nachricht, type Nachricht } from './post.js';

export interface PostSuchAnfrage {
  q: string;
  /** Nur innerhalb eines Fachs suchen — wie im Postfach-Reiter selbst
      gerade ausgewählt. `null`/fehlend: über alle Fächer. */
  fach?: string | null;
  limit?: number;
}

const STANDARD_LIMIT = 40;
const HOECHSTENS = 100;

/** Eine Zahl vom Client: brauchbar, oder die Vorgabe. Nie unter 1, nie über
    `hoechstens` — dieselbe Bauart wie grenze() in services/search.ts (dort
    ausführlich begründet: `Math.min(-1, 100)` wäre sonst -1, und `LIMIT -1`
    heißt in SQLite „ohne Grenze"). */
function grenze(wert: unknown, vorgabe: number, hoechstens: number): number {
  const n = Math.trunc(Number(wert));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, hoechstens) : vorgabe;
}

/**
 * Sucht Post — über Betreff, Text, Absender, Fach und Anhangnamen (siehe
 * Dateikopf). Endgültig gelöschte Post (services/post.ts, endgueltigLoeschen()/
 * fristenAnwenden()) taucht nie auf: ihr Indexeintrag ist mit ihr zusammen
 * verschwunden (removeMailFromIndex() in db/index.ts).
 *
 * Archivierte und „aus dem Weg geräumte" Post bleibt dagegen AUFFINDBAR — sie
 * existiert weiterhin, nur eben nicht in der aktiven Liste. Wer sich an eine
 * längst archivierte Rechnung erinnert, soll sie über die Suche wiederfinden,
 * ohne sie zuerst im Archiv suchen zu müssen. Die Oberfläche zeigt an jedem
 * Treffer, in welchem Zustand er steht (archiviertAm/entferntAm, siehe
 * `Nachricht` in post.ts).
 */
export function suchen(anfrage: PostSuchAnfrage): Nachricht[] {
  const q = anfrage.q.trim();
  if (q.length < 2) return [];
  const limit = grenze(anfrage.limit, STANDARD_LIMIT, HOECHSTENS);
  const fach = anfrage.fach && anfrage.fach !== 'alle' ? anfrage.fach : null;

  const ids = db.fts ? ftsSuche(q, fach, limit) : likeSuche(q, fach, limit);

  // Reihenfolge der Fundstellen (bm25-Rang bzw. Zeit beim Rückfall) bleibt
  // erhalten -- .filter(Boolean) statt .map+erneutes Prüfen, für den seltenen
  // Fall, dass eine Mail zwischen Indexsuche und diesem Aufruf verschwunden
  // ist (endgueltigLoeschen() lief in genau diesem Moment).
  return ids.map((id) => nachricht(id)).filter((n): n is Nachricht => n !== null);
}

interface RohTreffer { mail_id: string }

function ftsSuche(q: string, fach: string | null, limit: number): string[] {
  const ausdruck = zuFtsAusdruck(q);
  if (!ausdruck) return [];
  try {
    const zeilen = fach
      ? db.all<RohTreffer>(
        `SELECT mail_id, -bm25(mail_fts) AS score FROM mail_fts
          WHERE mail_fts MATCH ? AND fach = ?
          ORDER BY score DESC LIMIT ?`,
        ausdruck, fach, limit,
      )
      : db.all<RohTreffer>(
        `SELECT mail_id, -bm25(mail_fts) AS score FROM mail_fts
          WHERE mail_fts MATCH ?
          ORDER BY score DESC LIMIT ?`,
        ausdruck, limit,
      );
    return zeilen.map((z) => z.mail_id);
  } catch {
    // Eine kaputte MATCH-Anfrage (etwa ein FTS5-Sonderzeichen, das
    // suchBegriffe() nicht entschärft) soll die Suche nicht scheitern
    // lassen, nur langsamer machen -- dieselbe Rückfallregel wie in
    // services/search.ts.
    return likeSuche(q, fach, limit);
  }
}

/** Die Suchanfrage in dieselben Fingerabdrücke übersetzen, die im Index
    stehen (siehe crypto/nachrichten.ts, suchBegriffe()). Alle Wörter müssen
    treffen (AND) -- wer nach zwei Wörtern sucht, meint beide, nicht "eins
    von beiden". */
function zuFtsAusdruck(q: string): string {
  return suchBegriffe(q).map((t) => `"${t}"`).join(' AND ');
}

/**
 * Rückfallweg ohne FTS5 — kann nicht mehr per SQL filtern (die Spalten
 * stehen als Chiffrat da), holt deshalb einen begrenzten Ausschnitt und
 * siebt ihn im Speicher. Dieselbe Bauart wie likeSearch() in
 * services/search.ts.
 */
function likeSuche(q: string, fach: string | null, limit: number): string[] {
  const nadel = q.toLowerCase();
  const FENSTER = 4000;

  const zeilen = fach
    ? db.all<{ id: string; von: string; betreff: string; text: string; fach: string; anhaenge: string | null }>(
      `SELECT id, von, betreff, text, fach, anhaenge FROM mail_nachrichten WHERE fach = ? ORDER BY am DESC LIMIT ?`,
      fach, FENSTER,
    )
    : db.all<{ id: string; von: string; betreff: string; text: string; fach: string; anhaenge: string | null }>(
      `SELECT id, von, betreff, text, fach, anhaenge FROM mail_nachrichten ORDER BY am DESC LIMIT ?`,
      FENSTER,
    );

  const treffer: string[] = [];
  for (const z of zeilen) {
    const buendel = [
      entschluesseln(z.betreff), entschluesseln(z.text), entschluesseln(z.von),
      z.fach, ...anhangNamen(z.anhaenge),
    ].join(' ').toLowerCase();
    if (buendel.includes(nadel)) treffer.push(z.id);
    if (treffer.length >= limit) break;
  }
  return treffer;
}

/** Dieselbe kleine Auspackung wie anhangNamenFuerIndex() in db/index.ts —
    eigenständig hier aus demselben Grund: post.ts exportiert die Namen
    allein nicht, nur die ganze Nachricht. */
function anhangNamen(gespeichert: string | null): string[] {
  if (!gespeichert) return [];
  try {
    const wert = JSON.parse(entschluesseln(gespeichert)) as unknown;
    if (!Array.isArray(wert)) return [];
    return wert
      .map((a) => (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string'
        ? (a as { name: string }).name
        : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}
