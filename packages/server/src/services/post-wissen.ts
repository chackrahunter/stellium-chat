/**
 * Das Gedächtnis der Firmenpost — Ablage, Freigabe, Einsicht, Löschung.
 *
 * Zwei Tabellen, und der Unterschied zwischen ihnen ist der ganze Punkt:
 *
 *   · `mail_wissen`            — was gilt. Geht in die Anweisung ans Modell.
 *   · `mail_wissen_vorschlaege`— was die KI vorschlägt. Geht NIRGENDS hin,
 *                                bis ein Mensch zustimmt.
 *
 * DIE SPERREN — ALS BAUART, NICHT ALS EINSTELLUNG
 *
 *   · **Ohne Freigabe wirkt nichts.** `wissenFuerMail()` weiter unten liest
 *     ausschließlich aus `mail_wissen`. Ein Vorschlag steht in der anderen
 *     Tabelle; es gibt in dieser Datei keinen Weg von dort in eine Anweisung,
 *     der nicht über `vorschlagEntscheiden(..., 'angenommen')` führt — und
 *     das verlangt eine Benutzerkennung mit `mail.verwalten`.
 *
 *   · **Aus eingehender Post wird nie gelernt.** Diese Datei liest
 *     `mail_nachrichten` überhaupt nicht; woher der Stoff kommt, entscheidet
 *     `post-lernen.ts` (dort `NUR_AUSGEHEND`). Hier kommt ein Vorschlag als
 *     fertiger Wert herein — deshalb ist `vorschlagEintragen()` eigens
 *     exportiert und ohne Modell aufrufbar: so lässt sich die Kette in
 *     scripts/e2e-postgedaechtnis.mjs ohne Netz nachprüfen, genau wie
 *     `vorschlagEintragen()` in post-partnergruppen.ts.
 *
 *   · **Ein abgelehnter Vorschlag kommt nicht wieder.** Die Zeile bleibt
 *     stehen, ihr `abdruck` liegt unter einem eindeutigen Index. Dieselbe
 *     Beobachtung aus einer anderen Mail fällt beim Eintragen heraus,
 *     unabhängig davon, wie entschieden wurde — dasselbe Muster wie
 *     `gruppe_vorschlag_am` bei den Briefpartner-Gruppen: der Vermerk „schon
 *     vorgelegt" überlebt die Entscheidung.
 *
 *   · **Nichts wird stillschweigend überschrieben.** Widerspricht ein
 *     Vorschlag einem geltenden Eintrag, wird der alte beim Annehmen nicht
 *     gelöscht, sondern abgelöst (`ersetzt_am`/`ersetzt_durch`) — er
 *     verschwindet aus der Anweisung, bleibt aber im Verlauf lesbar. Wer
 *     wissen will, warum die KI seit gestern etwas anderes schreibt, findet
 *     dort die Antwort.
 *
 * VERSCHLÜSSELUNG
 *
 * `thema`, `inhalt`, `stichworte`, `quelle`, `begruendung` und `herkunft`
 * gehen durch `crypto/nachrichten.ts` — dieselbe Begründung wie bei
 * `mail_entwuerfe`: das Gelernte stammt aus Schriftwechsel mit Kunden und
 * nennt Preise und Zuständigkeiten des Hauses. Der `abdruck` ist ein HMAC und
 * bleibt lesbar, weil danach gesucht wird — dieselbe Bauart wie der
 * Blindindex bei `mail_partner`.
 *
 * RECHTE
 *
 *   · Ansehen — `mail.lesen`. Wer die Post bearbeitet, muss nachsehen können,
 *     woher ein Satz im Entwurf stammt. Ein Gedächtnis, in das nur die
 *     Verwaltung hineinsieht, ist genau das unbeherrschbare Gedächtnis, das
 *     der Auftrag ausschließt.
 *   · Ändern und entscheiden — `mail.verwalten` („Postfach einrichten",
 *     Inhaber und Administration). Was hier steht, geht als Tatsache im Namen
 *     der Firma hinaus: Preise, Erstattungen, Zuständigkeiten. Das ist
 *     Einrichtung, nicht Tagesarbeit. Soll die Teamleitung mitpflegen, gibt
 *     der Inhaber ihr das Recht einzeln (persönliche Ausnahme in der
 *     Rechteverwaltung) — dafür ist kein neues Recht nötig.
 */
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { abdruck, entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { fensterFuer } from '../translation/fenster.js';
import { assistant as kiAnbieter } from '../translation/index.js';
import {
  abdruckText, passendeEintraege, themenAehnlich, wissenBudget, wissensBlock,
  BEGRUENDUNG_MAX, INHALT_MAX, STICHWORTE_MAX, THEMA_MAX,
} from './post-wissen-ki.js';
/* Die Formen, die als JSON an die Oberfläche gehen, stehen in
   @stellium/shared — eine Beschreibung für beide Seiten. Siehe dort. */
import type {
  WissenArt, WissenEintrag, WissenHerkunft, WissenVorschlag,
} from '@stellium/shared';

export type { WissenArt, WissenEintrag, WissenHerkunft, WissenVorschlag };

/* ── Grenzen ──────────────────────────────────────────────────── */

/**
 * Wie viele geltende Einträge das Gedächtnis fasst.
 *
 * Die WIRKSAME Grenze ist eine andere und liegt woanders: in die Anweisung
 * passen ohnehin nur so viele Einträge, wie `wissenBudget()` erlaubt (zwei
 * bis drei). Diese Zahl hier begrenzt nicht die Wirkung, sondern die
 * Übersicht — ein Reiter mit 500 Karten wird nicht mehr gepflegt, und
 * ungepflegtes Wissen ist schlimmer als keines, weil es falsch werden kann,
 * ohne dass es jemand merkt.
 *
 * Ist es voll, wird nicht heimlich das Älteste geworfen: `eintragAnlegen()`
 * und `vorschlagEntscheiden()` geben `voll` zurück, und die Oberfläche sagt,
 * dass erst etwas weg muss. Ein Gedächtnis, das von selbst vergisst, ohne
 * dass jemand es merkt, wäre dasselbe Problem wie eines, in das man nicht
 * hineinsehen kann.
 */
export const EINTRAEGE_MAX = 120;

/**
 * Wie viele Vorschläge höchstens gleichzeitig offen sein dürfen.
 *
 * Acht Karten sind ein Durchgang von zwei Minuten. Ab der neunten wird es
 * eine Liste, die man vor sich herschiebt — und ein Reiter, den niemand mehr
 * durchklickt, ist Deko, kein Gedächtnis. Die Zahl ist außerdem die Bremse
 * für den Lernlauf: ist sie erreicht, fragt `post-lernen.ts` erst gar kein
 * Modell mehr und schiebt seinen Wasserstand nicht weiter, bis wieder Platz
 * ist. Nichts geht verloren, es wartet nur.
 */
export const OFFEN_MAX = 8;

/* ── Zeilen ───────────────────────────────────────────────────── */

interface EintragZeile {
  id: string; art: string; thema: string; inhalt: string; stichworte: string | null;
  immer: number; fach: string | null; quelle: string | null;
  angelegt_von: string | null; angelegt_am: number; geaendert_am: number | null;
  ersetzt_id: string | null; ersetzt_am: number | null; ersetzt_durch: string | null;
}

function eintragAuspacken(z: EintragZeile): WissenEintrag {
  return {
    id: z.id,
    art: (z.art === 'stil' ? 'stil' : 'wissen') as WissenArt,
    thema: entschluesseln(z.thema),
    inhalt: entschluesseln(z.inhalt),
    stichworte: z.stichworte ? entschluesseln(z.stichworte) : '',
    immer: z.immer === 1,
    fach: z.fach,
    quelle: z.quelle ? entschluesseln(z.quelle) : null,
    angelegtVon: z.angelegt_von,
    angelegtAm: z.angelegt_am,
    geaendertAm: z.geaendert_am,
    ersetztId: z.ersetzt_id,
    ersetztAm: z.ersetzt_am,
    ersetztDurch: z.ersetzt_durch,
  };
}

const EINTRAG_SPALTEN = `id, art, thema, inhalt, stichworte, immer, fach, quelle,
  angelegt_von, angelegt_am, geaendert_am, ersetzt_id, ersetzt_am, ersetzt_durch`;

/**
 * Alles, was gilt — abgelöste Einträge fallen heraus.
 *
 * Grundwissen zuerst, damit `passendeEintraege()` bei gleichem Rang das
 * Wichtigste zuerst sieht; danach das Neueste.
 */
export function aktiveEintraege(): WissenEintrag[] {
  return db.all<EintragZeile>(
    `SELECT ${EINTRAG_SPALTEN} FROM mail_wissen
      WHERE ersetzt_am IS NULL
      ORDER BY immer DESC, angelegt_am DESC LIMIT ?`, EINTRAEGE_MAX + 50,
  ).map(eintragAuspacken);
}

/** Auch das Abgelöste — für die Einsicht („warum schreibt sie das seit gestern anders?"). */
export function alleEintraege(): WissenEintrag[] {
  return db.all<EintragZeile>(
    `SELECT ${EINTRAG_SPALTEN} FROM mail_wissen ORDER BY ersetzt_am IS NOT NULL, angelegt_am DESC LIMIT 500`,
  ).map(eintragAuspacken);
}

export function eintragLesen(id: string): WissenEintrag | null {
  const z = db.get<EintragZeile>(`SELECT ${EINTRAG_SPALTEN} FROM mail_wissen WHERE id = ?`, id);
  return z ? eintragAuspacken(z) : null;
}

export function aktiveAnzahl(): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mail_wissen WHERE ersetzt_am IS NULL')?.n ?? 0;
}

export interface EintragEingabe {
  art?: WissenArt;
  thema: string;
  inhalt: string;
  stichworte?: string;
  immer?: boolean;
  fach?: string | null;
  quelle?: string | null;
}

function saubereEingabe(e: EintragEingabe): {
  art: WissenArt; thema: string; inhalt: string; stichworte: string; immer: number; fach: string | null;
} | null {
  const thema = e.thema.trim().replace(/\s+/g, ' ').slice(0, THEMA_MAX);
  const inhalt = e.inhalt.trim().slice(0, INHALT_MAX);
  if (!thema || !inhalt) return null;
  return {
    art: e.art === 'stil' ? 'stil' : 'wissen',
    thema,
    inhalt,
    stichworte: (e.stichworte ?? '').trim().slice(0, STICHWORTE_MAX),
    immer: e.immer ? 1 : 0,
    /* Nur der lokale Teil, kleingeschrieben — dieselbe Normalisierung wie
       `anweisungFuerFach()` in post-ki.ts, damit „Support@stellium.club" und
       „support" denselben Eintrag treffen. */
    fach: e.fach ? e.fach.trim().toLowerCase().split('@')[0].split('+')[0].slice(0, 40) || null : null,
  };
}

export function eintragAnlegen(eingabe: EintragEingabe, userId: string | null):
{ ok: true; eintrag: WissenEintrag } | { ok: false; grund: 'ungueltig' | 'voll' } {
  const sauber = saubereEingabe(eingabe);
  if (!sauber) return { ok: false, grund: 'ungueltig' };
  if (aktiveAnzahl() >= EINTRAEGE_MAX) return { ok: false, grund: 'voll' };

  const id = newId('wi_');
  db.run(
    `INSERT INTO mail_wissen (id, art, thema, inhalt, stichworte, immer, fach, quelle, angelegt_von, angelegt_am)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, sauber.art, verschluesseln(sauber.thema), verschluesseln(sauber.inhalt),
    verschluesseln(sauber.stichworte), sauber.immer, sauber.fach,
    verschluesseln(eingabe.quelle ?? 'von Hand angelegt'), userId, Date.now(),
  );
  return { ok: true, eintrag: eintragLesen(id)! };
}

export function eintragAendern(id: string, eingabe: EintragEingabe): WissenEintrag | null {
  const sauber = saubereEingabe(eingabe);
  if (!sauber) return null;
  const geaendert = db.run(
    `UPDATE mail_wissen SET art = ?, thema = ?, inhalt = ?, stichworte = ?, immer = ?, fach = ?, geaendert_am = ?
      WHERE id = ? AND ersetzt_am IS NULL`,
    sauber.art, verschluesseln(sauber.thema), verschluesseln(sauber.inhalt),
    verschluesseln(sauber.stichworte), sauber.immer, sauber.fach, Date.now(), id,
  ).changes > 0;
  return geaendert ? eintragLesen(id) : null;
}

/**
 * Endgültig löschen, nicht ablösen.
 *
 * Das Ablösen (`ersetzt_am`) ist für den Fall gedacht, dass etwas NEUES an
 * die Stelle tritt — dann will man den Vorgänger noch lesen können. Wer
 * löscht, will es weghaben: ein Preis, der nie stimmte, ein Satz, den die KI
 * missverstanden hat. Der bleibt nicht als Fußnote stehen. `PRAGMA
 * secure_delete` ist für die ganze Verbindung an (siehe db/migrate.ts), die
 * Bytes werden also wirklich überschrieben.
 */
export function eintragLoeschen(id: string): boolean {
  return db.run('DELETE FROM mail_wissen WHERE id = ?', id).changes > 0;
}

/* ── Was in die Anweisung geht ────────────────────────────────── */

/**
 * Der Wissensblock für EINE eingegangene Mail.
 *
 * Liest ausschließlich `mail_wissen` — Vorschläge sind hier nicht erreichbar,
 * und das ist keine Nachlässigkeit, sondern die Sperre („bis zur Freigabe
 * wirkt nichts", siehe Dateikopf).
 *
 * `fenster` ist das, was das Modell tatsächlich annimmt; ohne Angabe wird es
 * beim Anbieter erfragt und, wenn auch das nicht geht, mit dem kleinsten
 * bekannten Fenster gerechnet. Lieber ein zu kleiner Block als eine Anweisung,
 * die das Modell wegen Länge ablehnt.
 *
 * `verwendet` sind die Kennungen der eingeflossenen Einträge, `themen` ihre
 * Überschriften — damit lässt sich hinterher beantworten, woher ein Satz im
 * Entwurf kam. Genau die Frage, für die es dieses Gedächtnis einsehbar geben
 * muss. Die Themen stehen zusätzlich in der Begründung des Entwurfs (siehe
 * `wissensHinweis()` in post-sichtung.ts): Wer freigibt, sieht damit ohne
 * Umweg, worauf die Antwort beruht — und woran sie NICHT beruht.
 */
export function wissenFuerMail(input: {
  fach: string; betreff: string; text: string; fenster?: number;
}): { block: string; verwendet: string[]; themen: string[] } {
  let fenster = input.fenster ?? 0;
  if (!fenster) {
    const ai = kiAnbieter();
    fenster = ai ? fensterFuer(ai.kennung, ai.kontextfenster()) : 8192;
  }
  const auswahl = passendeEintraege({
    eintraege: aktiveEintraege(),
    fach: input.fach,
    betreff: input.betreff,
    text: input.text,
    budget: wissenBudget(fenster),
  });
  const genutzt = [...auswahl.wissen, ...auswahl.stil];
  return {
    block: wissensBlock(auswahl),
    verwendet: genutzt.map((e) => e.id),
    themen: auswahl.wissen.map((e) => e.thema),
  };
}

/* ── Vorschläge ───────────────────────────────────────────────── */

interface VorschlagZeile {
  id: string; abdruck: string; art: string; thema: string; inhalt: string;
  begruendung: string | null; herkunft: string | null; widerspruch_zu: string | null;
  zustand: string; erstellt_am: number; entschieden_am: number | null;
  entschieden_von: string | null; eintrag_id: string | null;
}

function vorschlagAuspacken(z: VorschlagZeile): WissenVorschlag {
  let herkunft: WissenHerkunft | null = null;
  if (z.herkunft) {
    /* Eine Zeile, die sich nicht mehr lesen lässt (falsches Masterpasswort),
       darf die Liste nicht mitnehmen — dieselbe Haltung wie bei
       `sichtungFuer()` in post-sichtung.ts. */
    try { herkunft = JSON.parse(entschluesseln(z.herkunft)) as WissenHerkunft; } catch { herkunft = null; }
  }
  let widerspruchZu: WissenVorschlag['widerspruchZu'] = null;
  if (z.widerspruch_zu) {
    const alt = eintragLesen(z.widerspruch_zu);
    if (alt && alt.ersetztAm === null) widerspruchZu = { id: alt.id, thema: alt.thema, inhalt: alt.inhalt };
  }
  return {
    id: z.id,
    art: (z.art === 'stil' ? 'stil' : 'wissen') as WissenArt,
    thema: entschluesseln(z.thema),
    inhalt: entschluesseln(z.inhalt),
    begruendung: z.begruendung ? entschluesseln(z.begruendung) : null,
    herkunft,
    widerspruchZu,
    zustand: z.zustand as WissenVorschlag['zustand'],
    erstelltAm: z.erstellt_am,
    entschiedenAm: z.entschieden_am,
    entschiedenVon: z.entschieden_von,
    eintragId: z.eintrag_id,
  };
}

const VORSCHLAG_SPALTEN = `id, abdruck, art, thema, inhalt, begruendung, herkunft, widerspruch_zu,
  zustand, erstellt_am, entschieden_am, entschieden_von, eintrag_id`;

export function vorschlaegeListe(nurOffene = false, anzahl = 50): WissenVorschlag[] {
  const grenze = Math.min(Math.max(1, Math.trunc(anzahl) || 50), 200);
  return db.all<VorschlagZeile>(
    nurOffene
      ? `SELECT ${VORSCHLAG_SPALTEN} FROM mail_wissen_vorschlaege WHERE zustand = 'offen'
          ORDER BY erstellt_am ASC LIMIT ?`
      : `SELECT ${VORSCHLAG_SPALTEN} FROM mail_wissen_vorschlaege
          ORDER BY zustand = 'offen' DESC, erstellt_am DESC LIMIT ?`,
    grenze,
  ).map(vorschlagAuspacken);
}

export function offeneAnzahl(): number {
  return db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM mail_wissen_vorschlaege WHERE zustand = 'offen'",
  )?.n ?? 0;
}

/** Ist diese Beobachtung schon einmal vorgelegt worden — egal, wie entschieden wurde? */
export function schonVorgelegt(thema: string, inhalt: string): boolean {
  const wert = abdruck(abdruckText(thema, inhalt));
  return Boolean(db.get<{ id: string }>(
    'SELECT id FROM mail_wissen_vorschlaege WHERE abdruck = ?', wert,
  ));
}

export interface VorschlagEingabe {
  art: WissenArt;
  thema: string;
  inhalt: string;
  begruendung?: string | null;
  herkunft: WissenHerkunft;
}

/**
 * Einen Vorschlag eintragen — der einzige Weg, auf dem etwas in den Reiter
 * kommt.
 *
 * Gibt zurück, warum es NICHT geklappt hat, statt still nichts zu tun: der
 * Lernlauf schreibt das ins Protokoll, und der Prüflauf hängt genau daran.
 *
 *   `schonVorgelegt` — derselbe Fingerabdruck lag schon einmal vor. Die
 *     Entscheidung von damals ist dabei gleichgültig; das ist die Regel „ein
 *     abgelehnter Vorschlag kommt nicht wieder".
 *   `voll` — es warten schon `OFFEN_MAX` Karten.
 *   `ungueltig` — leeres Thema oder leerer Inhalt.
 */
export function vorschlagEintragen(eingabe: VorschlagEingabe):
{ ergebnis: 'eingetragen'; id: string } | { ergebnis: 'schonVorgelegt' | 'voll' | 'ungueltig' } {
  const thema = eingabe.thema.trim().replace(/\s+/g, ' ').slice(0, THEMA_MAX);
  const inhalt = eingabe.inhalt.trim().slice(0, INHALT_MAX);
  if (!thema || !inhalt) return { ergebnis: 'ungueltig' };
  if (schonVorgelegt(thema, inhalt)) return { ergebnis: 'schonVorgelegt' };
  if (offeneAnzahl() >= OFFEN_MAX) return { ergebnis: 'voll' };

  /* Widerspruch: redet der Vorschlag über dasselbe Thema wie etwas, das schon
     gilt? Dann wird das NICHT stillschweigend ersetzt — die Kennung des alten
     Eintrags kommt an die Zeile, und die Oberfläche stellt beide
     nebeneinander. Der Mensch entscheidet, ob abgelöst oder danebengestellt
     wird (siehe vorschlagEntscheiden). */
  const widerspruch = aktiveEintraege().find((e) => e.art === eingabe.art && themenAehnlich(e.thema, thema));

  const id = newId('wv_');
  db.run(
    `INSERT INTO mail_wissen_vorschlaege
       (id, abdruck, art, thema, inhalt, begruendung, herkunft, widerspruch_zu, zustand, erstellt_am)
     VALUES (?,?,?,?,?,?,?,?,'offen',?)`,
    id, abdruck(abdruckText(thema, inhalt)), eingabe.art,
    verschluesseln(thema), verschluesseln(inhalt),
    verschluesseln((eingabe.begruendung ?? '').slice(0, BEGRUENDUNG_MAX)),
    verschluesseln(JSON.stringify(eingabe.herkunft)),
    widerspruch?.id ?? null, Date.now(),
  );
  return { ergebnis: 'eingetragen', id };
}

export type EntscheidungErgebnis =
  | { ergebnis: 'angenommen'; eintragId: string }
  | { ergebnis: 'abgelehnt' }
  | { ergebnis: 'unbekannt' | 'nichtOffen' | 'ungueltig' | 'voll' };

/**
 * Über einen Vorschlag entscheiden — die einzige Tür ins Gedächtnis.
 *
 * `thema`/`inhalt` dürfen mitkommen: „Ändern" ist der wichtigste der drei
 * Knöpfe. Oft ist die Beobachtung richtig und nur die Formulierung schief,
 * und wer dann nur Ja oder Nein hat, wirft eine richtige Beobachtung weg.
 * Der geänderte Wortlaut ist es, der gespeichert wird — nicht der der KI.
 *
 * `ersetzen` gilt nur, wenn die Zeile einen Widerspruch trägt:
 *   true  — der alte Eintrag wird abgelöst (bleibt lesbar, gilt nicht mehr).
 *   false — beide gelten nebeneinander. Das ist der richtige Weg, wenn sich
 *           die Themen nur ähneln, ohne sich zu widersprechen.
 *
 * Der `abdruck` der Zeile bleibt unverändert stehen, auch beim Ablehnen: er
 * IST der Vermerk „schon vorgelegt".
 */
export function vorschlagEntscheiden(input: {
  id: string;
  userId: string;
  ergebnis: 'angenommen' | 'abgelehnt';
  thema?: string;
  inhalt?: string;
  ersetzen?: boolean;
}): EntscheidungErgebnis {
  const z = db.get<VorschlagZeile>(
    `SELECT ${VORSCHLAG_SPALTEN} FROM mail_wissen_vorschlaege WHERE id = ?`, input.id,
  );
  if (!z) return { ergebnis: 'unbekannt' };
  if (z.zustand !== 'offen') return { ergebnis: 'nichtOffen' };

  if (input.ergebnis === 'abgelehnt') {
    db.run(
      `UPDATE mail_wissen_vorschlaege SET zustand = 'abgelehnt', entschieden_am = ?, entschieden_von = ?
        WHERE id = ? AND zustand = 'offen'`,
      Date.now(), input.userId, input.id,
    );
    return { ergebnis: 'abgelehnt' };
  }

  const vorschlag = vorschlagAuspacken(z);
  const thema = (input.thema ?? vorschlag.thema).trim().replace(/\s+/g, ' ').slice(0, THEMA_MAX);
  const inhalt = (input.inhalt ?? vorschlag.inhalt).trim().slice(0, INHALT_MAX);
  if (!thema || !inhalt) return { ergebnis: 'ungueltig' };
  if (aktiveAnzahl() >= EINTRAEGE_MAX) return { ergebnis: 'voll' };

  const altId = input.ersetzen && vorschlag.widerspruchZu ? vorschlag.widerspruchZu.id : null;
  const herkunft = vorschlag.herkunft;
  const quelle = herkunft
    ? `Gelernt aus der gesendeten Antwort auf „${herkunft.betreff}" an ${herkunft.an}`
    : 'Gelernt aus gesendeter Post';

  const eintragId = db.transaction(() => {
    const id = newId('wi_');
    db.run(
      `INSERT INTO mail_wissen (id, art, thema, inhalt, stichworte, immer, fach, quelle, angelegt_von, angelegt_am, ersetzt_id)
       VALUES (?,?,?,?,?,0,NULL,?,?,?,?)`,
      id, vorschlag.art, verschluesseln(thema), verschluesseln(inhalt),
      verschluesseln(''), verschluesseln(quelle), input.userId, Date.now(), altId,
    );
    if (altId) {
      db.run(
        'UPDATE mail_wissen SET ersetzt_am = ?, ersetzt_durch = ? WHERE id = ? AND ersetzt_am IS NULL',
        Date.now(), id, altId,
      );
    }
    /* `thema`/`inhalt` der VORSCHLAGSZEILE bleiben unangetastet, auch wenn ein
       Mensch beim Annehmen umformuliert hat: dort steht, was die KI
       vorgeschlagen hat, im Eintrag steht, was daraus wurde. Beides
       nebeneinander ist der einzige Weg, später zu sehen, wie oft die KI
       daneben lag — überschriebe man den Vorschlag mit der Korrektur, sähe
       jede Karte im Nachhinein aus, als hätte die KI es gleich richtig
       getroffen. */
    db.run(
      `UPDATE mail_wissen_vorschlaege
          SET zustand = 'angenommen', entschieden_am = ?, entschieden_von = ?, eintrag_id = ?
        WHERE id = ? AND zustand = 'offen'`,
      Date.now(), input.userId, id, input.id,
    );
    return id;
  });

  return { ergebnis: 'angenommen', eintragId };
}
