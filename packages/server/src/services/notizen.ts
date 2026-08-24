import {
  nutzlastLesen, type KontoPaket, type Notiz, type SchluesselPaket,
} from '@stellium/shared';
import { db, placeholders } from '../db/index.js';
import { Abweisung, abweisung } from '../util/abweisung.js';
import { aktuelleFassung as kontoFassungVon } from './kontoschluessel.js';

/**
 * Notizen — persönliche Schriftstücke, Ende-zu-Ende verschlüsselt wie ein
 * vertraulicher Kanal (siehe services/vertraulich.ts), aber kein Kanal.
 *
 * Wie dort gilt: was hier ankommt, ist entweder öffentlich gemeint oder schon
 * verschlossen. Der Server sieht `chiffrat` nie im Klartext — nicht einmal
 * den Titel — und rechnet auch nicht mit ihm, außer um seine reine Form zu
 * prüfen (nutzlastLesen). Geöffnet wird ausschließlich in der App.
 *
 * Warum eigene Tabellen und nicht kanal_schluessel[_pakete] mitbenutzt: eine
 * Notiz ist EIN Schriftstück, kein Nachrichtenstrom. Ein Kanalschlüssel muss
 * jede alte Fassung für immer behalten, weil alte Nachrichten unter ihr
 * verschlossen bleiben. Eine Notiz hat keine alte Nachricht — bei einem
 * Schlüsselwechsel wird ihr einziger Inhalt neu verschlossen, die alte
 * Fassung ist danach bedeutungslos. Siehe schema.sql für die ausführliche
 * Begründung.
 *
 * Hinzufügen und Entfernen macht ausschließlich die besitzende Person — nicht
 * aus Misstrauen, sondern damit beim Entfernen immer dieselbe Person handelt,
 * die den Notizschlüssel ohnehin in der Hand hat. Ein Kanal braucht für einen
 * Schlüsselwechsel eine Absprache unter den verbleibenden Mitgliedern
 * (vertraulich:wechsel-noetig), weil dort auch entfernen darf, wer selbst
 * keinen Schlüssel hat. Diese Absprache entfällt hier vollständig, und mit
 * ihr die ganze Komplexität, die sie im Kanal braucht.
 */

/** Chiffrat großzügig, aber nicht grenzenlos — ein Angriffspunkt weniger. */
const CHIFFRAT_MAX = 2_000_000;

function pruefeChiffrat(chiffrat: string, erwarteteFassung?: number): number {
  if (typeof chiffrat !== 'string' || chiffrat.length > CHIFFRAT_MAX) {
    throw abweisung('fehler.notizUngueltigeForm', 'Die Notiz ist zu groß oder hat die falsche Form.');
  }
  const nutzlast = nutzlastLesen(chiffrat);
  if (!nutzlast) throw abweisung('fehler.notizKeinChiffrat', 'Das ist kein verschlüsselter Notizinhalt.');
  if (erwarteteFassung !== undefined && nutzlast.fassung !== erwarteteFassung) {
    /* Kommt vor, wenn die App noch mit der alten Schlüsselfassung
       verschlüsselt hat — meist, weil ein Wechsel gerade erst passiert ist
       und die Pakete sie noch nicht erreicht haben. Kein Nutzerfehler,
       deshalb keine eigene Meldung: der Aufrufer (speichern()) behandelt das
       als denselben Konflikt wie einen veralteten Inhaltsstand, und die App
       verschlüsselt daraufhin still mit der aktuellen Fassung neu. */
    throw new FassungsKonflikt();
  }
  return nutzlast.fassung;
}

/** Eigene, erkennbare Klasse — speichern() unterscheidet daran den stillen
 *  Fassungs-Konflikt von einem echten Inhaltskonflikt zwischen Menschen. */
class FassungsKonflikt extends Abweisung {
  constructor() { super('fehler.notizSchluesselGewechselt', 'Der Notizschlüssel wurde inzwischen gewechselt.'); }
}

function toNotiz(
  r: any,
  mitgliederJeNotiz: Map<string, { userId: string; entferntAm: number | null }[]>,
): Notiz {
  const mitglieder = mitgliederJeNotiz.get(r.id) ?? [];
  return {
    id: r.id,
    ownerId: r.owner_id,
    chiffrat: r.chiffrat,
    version: r.version,
    schluesselFassung: r.schluessel_fassung,
    memberIds: mitglieder.filter((m) => m.entferntAm === null).map((m) => m.userId),
    ehemaligeMitglieder: mitglieder
      .filter((m): m is { userId: string; entferntAm: number } => m.entferntAm !== null)
      .map((m) => ({ userId: m.userId, entferntAm: m.entferntAm })),
    geaendertVon: r.geaendert_von,
    geaendertAm: r.geaendert_am,
    erstelltAm: r.erstellt_am,
  };
}

/** Mitgliederzeilen für mehrere Notizen auf einmal — ein Rutsch statt N Abfragen. */
function mitgliederFuer(notizIds: string[]): Map<string, { userId: string; entferntAm: number | null }[]> {
  const out = new Map<string, { userId: string; entferntAm: number | null }[]>();
  if (!notizIds.length) return out;
  for (const r of db.all<any>(
    `SELECT notiz_id, user_id, entfernt_am FROM notiz_mitglieder
     WHERE notiz_id IN (${placeholders(notizIds.length)}) ORDER BY hinzugefuegt_am ASC`,
    ...notizIds,
  )) {
    const liste = out.get(r.notiz_id) ?? [];
    liste.push({ userId: r.user_id, entferntAm: r.entfernt_am ?? null });
    out.set(r.notiz_id, liste);
  }
  return out;
}

/** Besitzt oder liest diese Person die Notiz gerade? */
export function sichtbar(notizId: string, userId: string): boolean {
  return Boolean(db.get(
    `SELECT 1 AS x FROM notizen WHERE id = ? AND (
       owner_id = ?
       OR EXISTS (SELECT 1 FROM notiz_mitglieder WHERE notiz_id = ? AND user_id = ? AND entfernt_am IS NULL)
     )`,
    notizId, userId, notizId, userId,
  ));
}

function istBesitzer(notizId: string, userId: string): boolean {
  return Boolean(db.get('SELECT 1 AS x FROM notizen WHERE id = ? AND owner_id = ?', notizId, userId));
}

/**
 * Die eigenen Notizen — eigene und die, zu denen man hinzugefügt wurde.
 *
 * Volle Chiffrate für jede, nicht nur Kennungen: eine Notizliste ohne Inhalt
 * bräuchte für jede Zeile einen zweiten Abruf, nur um den Titel zu zeigen —
 * und der Titel steckt im selben Chiffrat wie der Text (siehe DIE FALLEN,
 * Punkt 4). Bei Textdokumenten dieser Größenordnung ist das kein Gewicht.
 */
export function listNotizen(userId: string): Notiz[] {
  const rows = db.all<any>(
    `SELECT DISTINCT n.* FROM notizen n
     LEFT JOIN notiz_mitglieder m ON m.notiz_id = n.id AND m.user_id = ? AND m.entfernt_am IS NULL
     WHERE n.owner_id = ? OR m.user_id IS NOT NULL
     ORDER BY n.geaendert_am DESC`,
    userId, userId,
  );
  const mitglieder = mitgliederFuer(rows.map((r) => r.id));
  return rows.map((r) => toNotiz(r, mitglieder));
}

export function getNotiz(id: string, userId: string): Notiz | null {
  if (!sichtbar(id, userId)) return null;
  const row = db.get<any>('SELECT * FROM notizen WHERE id = ?', id);
  if (!row) return null;
  return toNotiz(row, mitgliederFuer([id]));
}

/** Alle Mitgliedskennungen inkl. der besitzenden Person — für die Absender-Seite. */
export function empfaengerIds(notizId: string): string[] {
  const row = db.get<{ owner_id: string }>('SELECT owner_id FROM notizen WHERE id = ?', notizId);
  if (!row) return [];
  const mitglieder = db.all<{ user_id: string }>(
    'SELECT user_id FROM notiz_mitglieder WHERE notiz_id = ? AND entfernt_am IS NULL', notizId,
  ).map((r) => r.user_id);
  return [row.owner_id, ...mitglieder];
}

/** "nz_" + 32 Hexzeichen (crypto.randomUUID ohne Bindestriche). */
const NOTIZ_ID_MUSTER = /^nz_[a-f0-9]{32}$/;

/**
 * Neu anlegen. Das Paket ist die Notiz für die anlegende Person selbst
 * verpackt — dieselbe „ECDH mit sich selbst"-Idee wie kontoHuelle() in
 * lib/vertraulich.ts, hier aber ausdrücklich als Paket abgelegt statt
 * deterministisch neu hergeleitet: der Notizschlüssel muss sich rotieren
 * lassen (siehe DIE FALLEN, Punkt 1), ein aus dem Kontoschlüssel
 * abgeleiteter könnte das nicht.
 *
 * Die Kennung kommt von der App, nicht aus newId() — siehe Begründung im
 * Protokoll (notiz:anlegen). Die Form wird trotzdem geprüft: nicht, weil
 * ein Zufallswert eine Kollisionsgefahr wäre, sondern damit hier nie eine
 * Kennung landet, die als etwas anderes gemeint war.
 */
export function anlegen(input: {
  id: string; ownerId: string; chiffrat: string; paket: SchluesselPaket; kontoPaket?: KontoPaket;
}): Notiz {
  if (!NOTIZ_ID_MUSTER.test(input.id)) throw abweisung('fehler.notizUngueltigeKennung', 'Ungültige Kennung für eine neue Notiz.');
  if (db.get('SELECT 1 AS x FROM notizen WHERE id = ?', input.id)) {
    throw abweisung('fehler.notizExistiertBereits', 'Diese Notiz gibt es schon.');
  }
  const fassung = pruefeChiffrat(input.chiffrat, 1);
  if (!input.paket?.iv || !input.paket?.daten) throw abweisung('fehler.notizSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');

  const id = input.id;
  const jetzt = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO notizen (id, owner_id, chiffrat, version, schluessel_fassung, geaendert_von, geaendert_am, erstellt_am)
       VALUES (?,?,?,1,?,?,?,?)`,
      id, input.ownerId, input.chiffrat, fassung, input.ownerId, jetzt, jetzt,
    );
    db.run(
      `INSERT INTO notiz_schluessel_pakete (notiz_id, user_id, fassung, von_user_id, alg, iv, daten, erstellt_am)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, input.ownerId, fassung, input.paket.von || input.ownerId,
      input.paket.alg, input.paket.iv, input.paket.daten, jetzt,
    );
    /* Der zweite Weg, gleich mit — sonst könnte ein zweites Gerät desselben
       Kontos eine frisch angelegte Notiz erst nach dem nächsten Rundgang
       öffnen (notiz:konto-fehlt). Genau dieser Augenblick war der gemeldete
       Fehler: auf dem Mac angelegt, auf dem Handy nicht zu öffnen. */
    if (input.kontoPaket) kontoPaketSchreiben(id, input.ownerId, fassung, input.kontoPaket, jetzt);
  });
  return getNotiz(id, input.ownerId)!;
}

/* ── Der Kontoweg ─────────────────────────────────────────────── */

/**
 * Eine Zeile in notiz_konto_pakete schreiben — die einzige Stelle, die das
 * tut, und die einzige, die die Fassungen prüft.
 *
 * Zwei Zahlen müssen stimmen, nicht eine: `fassung` ist die Fassung des
 * NOTIZSCHLÜSSELS (sie wechselt beim Entfernen eines Mitglieds),
 * `kontoFassung` die des KONTOSCHLÜSSELS (sie wechselt, wenn ein Konto einen
 * neuen bekommt). Passt eine von beiden nicht, entstünde eine Zeile, die
 * richtig aussieht und sich nie öffnen lässt — deshalb hier abweisen statt
 * schreiben.
 *
 * Ohne eigene db.transaction(): läuft immer innerhalb der Transaktion des
 * Aufrufers.
 */
function kontoPaketSchreiben(
  notizId: string, userId: string, fassung: number, paket: KontoPaket, jetzt: number,
): void {
  db.run(
    `INSERT INTO notiz_konto_pakete (notiz_id, user_id, fassung, konto_fassung, alg, iv, daten, erstellt_am)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(notiz_id, user_id) DO UPDATE SET
       fassung = excluded.fassung, konto_fassung = excluded.konto_fassung, alg = excluded.alg,
       iv = excluded.iv, daten = excluded.daten, erstellt_am = excluded.erstellt_am`,
    notizId, userId, fassung, paket.kontoFassung, paket.alg, paket.iv, paket.daten, jetzt,
  );
}

/**
 * Ein Kontopaket entgegennehmen — immer nur für sich selbst.
 *
 * Es gibt keinen Weg, ein Kontopaket für jemand anderen zu schreiben, und
 * das ist kein Versehen: den Kontoschlüssel einer anderen Person hat
 * niemand, ein Paket "für sie" wäre also zwangsläufig eines, das sie nie
 * öffnen kann.
 */
export function kontoPaketSetzen(input: {
  notizId: string; userId: string; fassung: number; paket: KontoPaket;
}): void {
  if (!sichtbar(input.notizId, input.userId)) throw abweisung('fehler.notizNichtGefunden', 'Notiz nicht gefunden.');
  const p = input.paket;
  if (!p?.iv || !p?.daten) throw abweisung('fehler.notizSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');

  const notiz = db.get<{ schluessel_fassung: number }>(
    'SELECT schluessel_fassung FROM notizen WHERE id = ?', input.notizId,
  );
  if (!notiz) throw abweisung('fehler.notizNichtGefunden', 'Notiz nicht gefunden.');
  if (input.fassung !== notiz.schluessel_fassung) throw abweisung('fehler.schluesselfassungUnbekannt', 'Diese Schlüsselfassung gibt es nicht.');

  const kontoFassung = kontoFassungVon(input.userId);
  if (!kontoFassung || p.kontoFassung !== kontoFassung) {
    throw abweisung('fehler.schluesselfassungUnbekannt', 'Diese Schlüsselfassung gibt es nicht.');
  }

  db.transaction(() => kontoPaketSchreiben(input.notizId, input.userId, input.fassung, p, Date.now()));
}

/**
 * Die eigenen Kontopakete — nur die, die wirklich noch passen.
 *
 * Die beiden Fassungsvergleiche in der WHERE-Bedingung sind der Unterschied
 * zwischen "es steht eine Zeile da" und "diese Zeile lässt sich öffnen". Ein
 * Paket aus einer früheren Schlüsselfassung der Notiz oder aus einem
 * früheren Kontoschlüssel wird hier gar nicht erst herausgegeben — es
 * gehört zu notizenOhneKontoPaket() unten, damit es NEU geschrieben wird.
 */
export function kontoPaketeFuerAlle(userId: string): { notizId: string; fassung: number; paket: KontoPaket }[] {
  const kontoFassung = kontoFassungVon(userId);
  if (!kontoFassung) return [];
  return db.all<any>(
    `SELECT p.notiz_id, p.fassung, p.konto_fassung, p.alg, p.iv, p.daten
     FROM notiz_konto_pakete p
     JOIN notizen n ON n.id = p.notiz_id AND n.schluessel_fassung = p.fassung
     WHERE p.user_id = ? AND p.konto_fassung = ?`,
    userId, kontoFassung,
  ).map((r) => ({
    notizId: r.notiz_id, fassung: r.fassung,
    paket: { alg: r.alg, kontoFassung: r.konto_fassung, iv: r.iv, daten: r.daten },
  }));
}

/**
 * Notizen, die diese Person sehen darf und für die ein gültiges Kontopaket
 * fehlt — der Weg, auf dem der Altbestand nachwächst.
 *
 * Jede Notiz, die es vor dem Kontoschlüssel schon gab, steht hier drin. Das
 * Gerät, das sie über den GERÄTEWEG öffnen kann, schreibt das fehlende
 * Kontopaket nach — und zwar erst, nachdem es den Notizschlüssel am Chiffrat
 * der Notiz selbst erprobt hat (siehe lib/notizen.ts). Deshalb ist diese
 * Liste eine Aufforderung an ein Gerät, das den Schlüssel HAT, und nie eine
 * Einladung, irgendetwas zu erfinden.
 *
 * Ohne Kontoschlüssel gibt die Funktion nichts zurück: dann gäbe es nichts,
 * womit sich das fehlende Paket packen ließe, und eine Liste, der niemand
 * nachkommen kann, ist nur Lärm.
 */
export function notizenOhneKontoPaket(userId: string): string[] {
  const kontoFassung = kontoFassungVon(userId);
  if (!kontoFassung) return [];
  return db.all<{ id: string }>(
    `SELECT n.id AS id FROM notizen n
     LEFT JOIN notiz_mitglieder m ON m.notiz_id = n.id AND m.user_id = ? AND m.entfernt_am IS NULL
     LEFT JOIN notiz_konto_pakete k ON k.notiz_id = n.id AND k.user_id = ?
       AND k.fassung = n.schluessel_fassung AND k.konto_fassung = ?
     WHERE (n.owner_id = ? OR m.user_id IS NOT NULL) AND k.notiz_id IS NULL`,
    userId, userId, kontoFassung, userId,
  ).map((r) => r.id);
}

/**
 * Speichern — mit dem Stand, von dem aus die App losgeschrieben hat.
 *
 * Zwei Wächter, nicht einer: `version` erkennt, ob zwischenzeitlich ein
 * MENSCH etwas anderes gespeichert hat (DIE FALLEN, Punkt 2). Die in
 * `chiffrat` eingebettete Fassung erkennt, ob die App noch mit einem
 * SCHLÜSSEL verschlüsselt hat, der gerade durch ein Entfernen abgelöst wurde
 * — ein rein technischer Wettlauf, kein Widerspruch zwischen zwei Personen.
 * Beides führt zu `konflikt`, aber nur der erste Fall soll einer Person
 * gezeigt werden; den zweiten löst die App still, indem sie mit der
 * aktuellen Fassung neu verschlüsselt und noch einmal speichert.
 */
export function speichern(input: {
  notizId: string; userId: string; chiffrat: string; version: number; force?: boolean;
}): { ok: true; notiz: Notiz } | { ok: false; notiz: Notiz } {
  if (!sichtbar(input.notizId, input.userId)) throw abweisung('fehler.notizNichtGefunden', 'Notiz nicht gefunden.');
  const aktuell = db.get<{ version: number; schluessel_fassung: number }>(
    'SELECT version, schluessel_fassung FROM notizen WHERE id = ?', input.notizId,
  )!;

  /* Passt die Fassung nicht, lohnt sich der Blick auf `version` gar nicht
     erst — die App löst das ohnehin still auf, siehe Kommentar oben. Der
     Konflikt-Rückgabewert trägt absichtlich keine eigene Kennzeichnung dafür:
     die Oberfläche erkennt den stillen Fall daran, dass `aktuell.schluessel-
     Fassung` von dem abweicht, womit sie gerade verschlüsselt hatte — das
     weiß nur sie, der Server müsste es sich sonst separat merken. */
  let fassungPasst = true;
  try {
    pruefeChiffrat(input.chiffrat, aktuell.schluessel_fassung);
  } catch (err) {
    if (!(err instanceof FassungsKonflikt)) throw err;
    fassungPasst = false;
  }

  if (fassungPasst && (input.force || aktuell.version === input.version)) {
    const jetzt = Date.now();
    const { changes } = db.run(
      `UPDATE notizen SET chiffrat = ?, version = version + 1, geaendert_von = ?, geaendert_am = ?
       WHERE id = ? AND version = ?`,
      input.chiffrat, input.userId, jetzt, input.notizId, aktuell.version,
    );
    if (changes) return { ok: true, notiz: getNotiz(input.notizId, input.userId)! };
    /* changes === 0 trotz passender Prüfung oben: zwischen dem SELECT und dem
       UPDATE hat jemand anders gespeichert. Praktisch nur bei `force`
       möglich, wo die WHERE-Bedingung bewusst locker ist — dann fällt es
       unten in den ehrlichen Konfliktfall zurück statt in eine stille Lücke. */
  }
  return { ok: false, notiz: getNotiz(input.notizId, input.userId)! };
}

/**
 * Für ein Konto verpacken, das schon einen eigenen Schlüssel hinterlegt hat.
 *
 * Rotiert nichts — der bestehende Notizschlüssel wird nur zusätzlich
 * verpackt, für die aktuelle Fassung. Nur die besitzende Person darf das
 * (siehe Kopf dieser Datei).
 */
export function mitgliedHinzufuegen(input: {
  notizId: string; ownerId: string; zielUserId: string; paket: SchluesselPaket;
}): Notiz {
  if (!istBesitzer(input.notizId, input.ownerId)) {
    throw abweisung('fehler.notizNurBesitzerHinzufuegen', 'Nur die besitzende Person fügt jemanden zu einer Notiz hinzu.');
  }
  if (input.zielUserId === input.ownerId) throw abweisung('fehler.notizBesitzerBereitsMitglied', 'Die besitzende Person steht schon dabei.');
  if (!input.paket?.iv || !input.paket?.daten) throw abweisung('fehler.notizSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');

  const notiz = db.get<{ schluessel_fassung: number }>(
    'SELECT schluessel_fassung FROM notizen WHERE id = ?', input.notizId,
  );
  if (!notiz) throw abweisung('fehler.notizNichtGefunden', 'Notiz nicht gefunden.');

  const jetzt = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO notiz_mitglieder (notiz_id, user_id, hinzugefuegt_von, hinzugefuegt_am, entfernt_am, entfernt_grund)
       VALUES (?,?,?,?,NULL,NULL)
       ON CONFLICT(notiz_id, user_id) DO UPDATE SET
         hinzugefuegt_von = excluded.hinzugefuegt_von, hinzugefuegt_am = excluded.hinzugefuegt_am,
         entfernt_am = NULL, entfernt_grund = NULL`,
      input.notizId, input.zielUserId, input.ownerId, jetzt,
    );
    db.run(
      `INSERT INTO notiz_schluessel_pakete (notiz_id, user_id, fassung, von_user_id, alg, iv, daten, erstellt_am)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(notiz_id, user_id) DO UPDATE SET
         fassung = excluded.fassung, von_user_id = excluded.von_user_id, alg = excluded.alg,
         iv = excluded.iv, daten = excluded.daten, erstellt_am = excluded.erstellt_am`,
      input.notizId, input.zielUserId, notiz.schluessel_fassung, input.paket.von || input.ownerId,
      input.paket.alg, input.paket.iv, input.paket.daten, jetzt,
    );
  });
  return getNotiz(input.notizId, input.ownerId)!;
}

/**
 * Entfernen UND den Notizschlüssel wechseln — in einem Schritt.
 *
 * Geht nur von der besitzenden Person aus, und die hat den aktuellen
 * Schlüssel immer schon in der Hand: sie verschlüsselt den (unveränderten)
 * Inhalt neu und verpackt ihn für alle, die bleiben, bevor sie den Server
 * überhaupt erst fragt. Der Server prüft nur noch, ob das, was ankommt, auf
 * den Stand passt, von dem die App ausgegangen ist — sonst hat sich der
 * Inhalt zwischenzeitlich geändert (jemand anders hat gespeichert), und ein
 * Wechsel auf dieser Grundlage würfe genau die Arbeit weg, die diese Datei
 * an anderer Stelle zu schützen versucht.
 */
export function mitgliedEntfernen(input: {
  notizId: string; ownerId: string; zielUserId: string;
  neueFassung: number; chiffrat: string; version: number;
  pakete: { userId: string; paket: SchluesselPaket }[];
}): Notiz {
  if (!istBesitzer(input.notizId, input.ownerId)) {
    throw abweisung('fehler.notizNurBesitzerEntfernen', 'Nur die besitzende Person entfernt jemanden aus einer Notiz.');
  }
  const notiz = db.get<{ version: number; schluessel_fassung: number }>(
    'SELECT version, schluessel_fassung FROM notizen WHERE id = ?', input.notizId,
  );
  if (!notiz) throw abweisung('fehler.notizNichtGefunden', 'Notiz nicht gefunden.');
  if (input.neueFassung !== notiz.schluessel_fassung + 1) {
    throw new FassungsKonflikt();
  }
  pruefeChiffrat(input.chiffrat, input.neueFassung);

  /* Wer nach dem Entfernen noch dabei sein soll — die besitzende Person
     eingeschlossen, denn auch sie liest die Notiz nur über ein Paket (siehe
     Kopf dieser Datei: kein deterministisch aus dem Kontoschlüssel
     hergeleiteter Zugriff, gerade weil rotiert werden können muss). Fehlt für
     jemanden aus diesem Kreis ein Paket, bräche der Wechsel genau der Person
     den Zugriff weg, die ihn behalten sollte — das ist kein Sonderfall, den
     man stillschweigend hinnimmt, sondern ein Fehler in der anfragenden App. */
  const bleibenSollen = new Set([
    input.ownerId,
    ...db.all<{ user_id: string }>(
      `SELECT user_id FROM notiz_mitglieder WHERE notiz_id = ? AND entfernt_am IS NULL AND user_id != ?`,
      input.notizId, input.zielUserId,
    ).map((r) => r.user_id),
  ]);
  const verpacktFuer = new Set(input.pakete.map((p) => p.userId));
  if (verpacktFuer.has(input.zielUserId)) {
    throw new Error('Für die entfernte Person darf kein neues Paket dabei sein.');
  }
  for (const uid of bleibenSollen) {
    if (!verpacktFuer.has(uid)) throw new Error('Für ein verbleibendes Mitglied fehlt ein neues Schlüsselpaket.');
  }

  const jetzt = Date.now();
  /* geaendert_von/geaendert_am bleiben unangetastet: der Inhalt selbst ändert
     sich hier nicht, nur seine Hülle (siehe Kopf dieser Datei) — „zuletzt
     geändert von" soll weiterhin sagen, wer den TEXT zuletzt geschrieben hat,
     nicht, wer zuletzt jemanden entfernt hat. */
  const { changes } = db.run(
    `UPDATE notizen SET chiffrat = ?, schluessel_fassung = ?
     WHERE id = ? AND version = ? AND schluessel_fassung = ?`,
    input.chiffrat, input.neueFassung,
    input.notizId, input.version, notiz.schluessel_fassung,
  );
  if (!changes) {
    /* Entweder hat jemand anders zwischenzeitlich gespeichert (version passt
       nicht mehr), oder ein zweiter Wechsel kam dazwischen (schluessel_fassung
       nicht mehr). Die App liest den aktuellen Stand neu, verschlüsselt neu
       und versucht es noch einmal — ganz automatisch, siehe lib/notizen.ts. */
    throw new FassungsKonflikt();
  }

  db.transaction(() => {
    db.run(
      `UPDATE notiz_mitglieder SET entfernt_am = ?, entfernt_grund = NULL
       WHERE notiz_id = ? AND user_id = ? AND entfernt_am IS NULL`,
      jetzt, input.notizId, input.zielUserId,
    );
    // Die alte Fassung ist ab hier bedeutungslos — niemand braucht sie noch,
    // siehe Kopf dieser Datei. Aufräumen statt liegen lassen.
    db.run('DELETE FROM notiz_schluessel_pakete WHERE notiz_id = ?', input.notizId);
    /* Und dasselbe für den Kontoweg: jedes Kontopaket dieser Notiz trägt die
       ALTE Schlüsselfassung und ließe sich mit dem neuen Notizschlüssel nicht
       mehr gebrauchen. Es kommt hier bewusst kein neues an: die verpackende
       Person hat nur ihren EIGENEN Kontoschlüssel, für die anderen könnte sie
       nichts packen. Ihr eigenes schickt ihre App gleich hinterher, die der
       übrigen wachsen über notizenOhneKontoPaket() nach. */
    db.run('DELETE FROM notiz_konto_pakete WHERE notiz_id = ?', input.notizId);
    for (const eintrag of input.pakete) {
      const p = eintrag.paket;
      if (!bleibenSollen.has(eintrag.userId) || !p?.iv || !p?.daten) continue;
      db.run(
        `INSERT INTO notiz_schluessel_pakete (notiz_id, user_id, fassung, von_user_id, alg, iv, daten, erstellt_am)
         VALUES (?,?,?,?,?,?,?,?)`,
        input.notizId, eintrag.userId, input.neueFassung, p.von || input.ownerId,
        p.alg, p.iv, p.daten, jetzt,
      );
    }
  });
  return getNotiz(input.notizId, input.ownerId)!;
}

export function loeschen(notizId: string, userId: string): void {
  if (!istBesitzer(notizId, userId)) throw abweisung('fehler.notizNurBesitzerLoescht', 'Nur die besitzende Person löscht eine Notiz.');
  db.run('DELETE FROM notizen WHERE id = ?', notizId);
}

/** Das eigene Paket einer Notiz — oder null, wenn (noch) keins verpackt wurde. */
export function paketFuer(notizId: string, userId: string): { fassung: number; paket: SchluesselPaket } | null {
  const r = db.get<any>(
    'SELECT fassung, von_user_id, alg, iv, daten FROM notiz_schluessel_pakete WHERE notiz_id = ? AND user_id = ?',
    notizId, userId,
  );
  if (!r || !r.iv) return null;
  return { fassung: r.fassung, paket: { alg: r.alg, von: r.von_user_id, iv: r.iv, daten: r.daten } };
}

/**
 * Alle eigenen Pakete auf einmal — für den Moment, in dem die Notizen-Tafel
 * aufgeht. Ein Rutsch statt einer Anfrage je Notiz: siehe listNotizen() für
 * denselben Gedanken bei den Notizen selbst.
 */
export function paketeFuerAlle(userId: string): { notizId: string; fassung: number; paket: SchluesselPaket }[] {
  return db.all<any>(
    'SELECT notiz_id, fassung, von_user_id, alg, iv, daten FROM notiz_schluessel_pakete WHERE user_id = ?',
    userId,
  ).map((r) => ({
    notizId: r.notiz_id, fassung: r.fassung,
    paket: { alg: r.alg, von: r.von_user_id, iv: r.iv, daten: r.daten },
  }));
}

/**
 * Fehlende Pakete nachreichen — nach dem eigenen Schlüsselwechsel eines
 * Mitglieds (siehe ws/gateway.ts, vertraulich:schluessel-melden).
 *
 * Antwort auf einen Notiz-eigenen Sonderfall: jemand wurde zu einer Notiz
 * hinzugefügt, bevor die eigene App je einen Schlüssel hinterlegt hatte —
 * dann kann noch nichts für sie verpackt werden. Erst wenn ihr Konto einen
 * Schlüssel meldet, lässt sich das nachholen.
 */
export function fehlendeMitgliedschaften(userId: string): { notizId: string; ownerId: string }[] {
  return db.all<any>(
    `SELECT m.notiz_id AS notizId, n.owner_id AS ownerId
     FROM notiz_mitglieder m
     JOIN notizen n ON n.id = m.notiz_id
     LEFT JOIN notiz_schluessel_pakete p ON p.notiz_id = m.notiz_id AND p.user_id = m.user_id
     WHERE m.user_id = ? AND m.entfernt_am IS NULL AND p.user_id IS NULL`,
    userId,
  );
}

/**
 * Die eigenen Notizen, in denen ein noch aktives Mitglied kein Paket hat —
 * für den Neuanmelde-Rutsch (ws/gateway.ts, `ready()`).
 *
 * fehlendeMitgliedschaften() oben deckt nur den Augenblick ab, in dem das
 * MITGLIED gerade seinen Schlüssel meldet: der Anstoß geht an die
 * besitzende Person, aber nur an die Sitzungen, die genau in dem Moment
 * verbunden sind (sendToUser trifft niemanden sonst). Ist die besitzende
 * Person zu dem Zeitpunkt offline — oder war ihre App zwar online, aber die
 * Notizen-Tafel nie geöffnet und der Notizschlüssel deshalb nicht im
 * Speicher —, verpufft der Anstoß, und niemand fragt je wieder nach: genau
 * der stumme Kreisel aus dem Fehlerbericht.
 *
 * Diese Funktion holt denselben Zustand aus Sicht der BESITZENDEN Person
 * ein, nicht des Mitglieds — sie läuft bei jedem Neuanmelden dieser Person
 * selbst (siehe ready()), fragt also nicht mehr "wartet jemand gerade
 * zufällig mit auf der Leitung", sondern "bin ICH gerade wieder da, und
 * fehlt für eine meiner Notizen noch ein Paket". Damit heilt sich der Fall
 * von selbst, sobald die besitzende Person das nächste Mal online ist —
 * unabhängig davon, ob ihr eigener Notizschlüssel beim letzten Versuch im
 * Speicher lag oder nicht (siehe lib/notizen.ts,
 * eigenenNotizSchluesselNachladen für die Gegenseite dazu).
 */
export function eigeneUnverpackteMitglieder(ownerId: string): { notizId: string; userId: string }[] {
  return db.all<any>(
    `SELECT m.notiz_id AS notizId, m.user_id AS userId
     FROM notiz_mitglieder m
     JOIN notizen n ON n.id = m.notiz_id
     LEFT JOIN notiz_schluessel_pakete p ON p.notiz_id = m.notiz_id AND p.user_id = m.user_id
     WHERE n.owner_id = ? AND m.entfernt_am IS NULL AND p.user_id IS NULL`,
    ownerId,
  );
}

export function paketeNachreichen(input: {
  notizId: string; ownerId: string; zielUserId: string; paket: SchluesselPaket;
}): void {
  // Dieselbe Prüfung wie beim erstmaligen Hinzufügen — sie ist dieselbe Aktion,
  // nur zeitlich verzögert, weil der Schlüssel des Ziels noch fehlte.
  mitgliedHinzufuegen(input);
}

/* ── Beim Löschen eines Kontos ────────────────────────────────── */

/**
 * Was mit den Notizen einer Person passiert, wenn ihr Konto gelöscht wird.
 *
 * Zwei Fälle, wie im Auftrag verlangt:
 *
 *   Eine Notiz, die nur ihr gehörte (keine anderen Mitglieder), ist reine
 *   persönliche Ablage — wie ein Entwurf oder eine Erinnerung, die
 *   deleteAccount() in users.ts ebenfalls löscht. Niemand sonst konnte sie
 *   je lesen, niemand verliert etwas, das er hatte.
 *
 *   Eine Notiz mit anderen Mitgliedern bleibt stehen — sie gehört jetzt der
 *   am längsten dabei stehenden Person. Sie hier zu löschen nähme unbeteiligten
 *   Personen etwas weg, nur weil eine dritte Person das Konto verlassen hat;
 *   dieselbe Überlegung wie bei Nachrichten, die nach einer Kontolöschung
 *   stehen bleiben.
 *
 * Was bewusst NICHT passiert: eine Schlüsselrotation. Bei einem Entfernen
 * durch die besitzende Person kann die diese synchron ausführen (siehe
 * mitgliedEntfernen) — sie hat den Schlüssel ja in der Hand. Beim Löschen
 * eines Kontos gibt es keine Garantie, dass irgendein Gerät der neuen
 * besitzenden Person gerade online ist und mitrechnen kann. Das ist
 * dieselbe Grenze, an der auch deleteAccount() für vertrauliche Kanäle schon
 * heute steht: channel_members wird bereinigt, kanal_schluessel_pakete nicht
 * angerührt. Diese Funktion hält sich an dieselbe Grenze, statt für Notizen
 * strenger zu tun, als es der Rest des Hauses ist.
 */
/**
 * Ohne eigene db.transaction(): diese Funktion läuft ausschließlich innerhalb
 * der Transaktion, die deleteAccount() in users.ts schon offen hält — die
 * Datenbankhülle hier im Haus kennt keine verschachtelten Transaktionen
 * (kein SAVEPOINT, siehe db/index.ts), ein zweites BEGIN mitten in einem
 * laufenden würde die ganze Kontolöschung zum Absturz bringen. Die einzelnen
 * db.run()-Aufrufe bleiben trotzdem in sich richtig: geht zwischen ihnen
 * etwas schief, rollt die äußere Transaktion alles zurück, auch das hier.
 */
export function kontoBereinigen(userId: string): void {
  const eigeneNotizen = db.all<{ id: string }>('SELECT id FROM notizen WHERE owner_id = ?', userId);
  for (const { id } of eigeneNotizen) {
    const naechste = db.get<{ user_id: string }>(
      `SELECT user_id FROM notiz_mitglieder
       WHERE notiz_id = ? AND entfernt_am IS NULL AND user_id != ?
       ORDER BY hinzugefuegt_am ASC LIMIT 1`,
      id, userId,
    );
    if (!naechste) {
      db.run('DELETE FROM notizen WHERE id = ?', id);
      continue;
    }
    db.run('UPDATE notizen SET owner_id = ? WHERE id = ?', naechste.user_id, id);
    db.run('DELETE FROM notiz_mitglieder WHERE notiz_id = ? AND user_id = ?', id, naechste.user_id);
  }

  db.run(
    `UPDATE notiz_mitglieder SET entfernt_am = ?, entfernt_grund = 'konto_geloescht'
     WHERE user_id = ? AND entfernt_am IS NULL`,
    Date.now(), userId,
  );

  /* Der Kontoweg dieser Person fällt ganz weg. Anders als die Gerätepakete
     (die stehen bleiben, siehe oben — sie gehören zu Notizen, die andere
     weiterlesen) hilft ein Kontopaket nach dem Löschen niemandem mehr: den
     Kontoschlüssel gibt es nicht mehr, und `verwerfen()` in
     services/kontoschluessel.ts hat ihn ohnehin schon für ungültig
     erklärt. */
  db.run('DELETE FROM notiz_konto_pakete WHERE user_id = ?', userId);
}
