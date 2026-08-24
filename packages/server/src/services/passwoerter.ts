import {
  nutzlastLesen, type KontoPaket, type Passworteintrag, type PasswortOffenlegung, type SchluesselPaket,
} from '@stellium/shared';
import { db, placeholders } from '../db/index.js';
import { Abweisung, abweisung } from '../util/abweisung.js';
import { newId } from '../util/id.js';
import { aktuelleFassung as kontoFassungVon } from './kontoschluessel.js';

/**
 * Der Passwort-Tresor — Ende-zu-Ende verschlüsselt, wortgleiche Bauart zu
 * services/notizen.ts.
 *
 * DIESE DATEI IST KEINE NEUE ERFINDUNG. Sie übernimmt die Kryptografie-
 * Architektur von Notizen unverändert: ein zufälliger AES-Schlüssel je
 * Eintrag, für die besitzende Person und jedes Mitglied per ECDH verpackt
 * (Geräteweg, `passwort_schluessel_pakete`) UND zusätzlich mit dem
 * Kontoschlüssel jeder Person verpackt (Kontoweg, `passwort_konto_pakete`,
 * siehe services/kontoschluessel.ts) — damit ein zweites Gerät desselben
 * Kontos einen geteilten Zugang genauso öffnet wie das erste. Der Server
 * sieht `chiffrat` an keiner Stelle im Klartext, auch nicht das Etikett.
 *
 * WAS ANDERS IST ALS BEI EINER NOTIZ: der Inhalt liegt in ZWEI Hüllen, und
 * die Aushändigung der zweiten wird vermerkt.
 *
 * DIE TRENNUNG, UND WARUM SIE SEIN MUSSTE
 *
 * Vorher lag alles in einer Hülle. Die Liste in der Tafel zeigt Etiketten —
 * also musste sie beim bloßen Öffnen genau die Hülle aufmachen, in der auch
 * das Passwort steckte. Jedes sichtbare Passwort stand danach im verdeckten
 * Eingabefeld, lesbar mit den Entwicklerwerkzeugen, für ein Vorleseprogramm
 * oder für alles, was sonst in der Seite läuft — ohne dass irgendwo eine
 * Zeile entstanden wäre. Ein Vermerk, den erst ein Knopfdruck auslöst,
 * bezeugte in dieser Lage nichts.
 *
 * Jetzt trägt `passwort_eintraege.chiffrat` nur noch das SCHAUFENSTER
 * (Etikett, Benutzername, Notiz, Adresse, Einmalcode-Verknüpfung), und
 * `passwort_geheimnisse.chiffrat` das GEHEIMNIS (das Passwort). Die Liste
 * kommt mit dem Schaufenster aus. Wer das Geheimnis will, holt es einzeln —
 * `geheimnisAusliefern()` unten — und DIESE Funktion schreibt die Zeile, in
 * derselben Transaktion, aus der Auslieferung heraus. Es gibt keinen zweiten
 * Weg an ein Passwort: die Liste liefert keines, und der Client kann den
 * Vermerk nicht mehr unterdrücken, weil er ihn nicht mehr schreibt.
 *
 * WAS DIE ZEILE JETZT BELEGT — UND WAS WEITERHIN NICHT
 *
 * Sie belegt: der Server hat dieser Person zu diesem Zeitpunkt das Geheimnis
 * dieses Eintrags ausgehändigt. Wer die Anfrage unterdrückt, bekommt kein
 * Passwort; wer ein Passwort hat, hat eine Zeile hinterlassen.
 *
 * Sie belegt NICHT, was danach damit geschah. Wer einmal geholt hat, HAT den
 * Wert — abgeschrieben, weitergereicht oder nur angesehen steht hier nicht
 * und kann hier nicht stehen. Die Zeile bezeugt das Holen, nicht das Wissen,
 * und auch nicht die Weitergabe. Die harte Eingrenzung, wer ein Passwort
 * überhaupt HABEN kann, leistet nach wie vor nicht dieser Vermerk, sondern
 * die Mitgliederliste eines Eintrags: nur wer dort steht (oder besitzt),
 * bekommt überhaupt ein Schlüsselpaket. Dieser Satz ist keine Floskel — er
 * ist der Grund, warum der Vermerk eine Ergänzung bleibt und keine Schranke.
 *
 * WAS SIE AUSSERDEM NICHT ABDECKT: die Notiz und den Benutzernamen. Beide
 * stehen im Schaufenster, kommen also mit der Liste und lösen keine Zeile
 * aus. Das ist Absicht und deckt sich damit, was die Tafel behauptet —
 * verdeckt, mit Selbstlöschung der Zwischenablage und mit Vermerk ist dort
 * ausschließlich das Passwortfeld. Wer eine Wiederherstellungsangabe in die
 * Notiz schreibt, legt sie ins Schaufenster; das gehört gesagt und steht
 * deshalb hier.
 *
 * DER ALTBESTAND. Einträge von vor der Trennung haben keine Zeile in
 * passwort_geheimnisse und tragen ihr Passwort noch in der einen alten
 * Hülle. Der Server kann sie nicht umstellen — er hat keinen der Schlüssel.
 * Deshalb reicht er ihre Hülle auch NICHT über die Liste heraus
 * (`toEintrag()` unten leert `chiffrat` in diesem Fall), sondern nur über
 * denselben vermerkten Weg wie ein Geheimnis: wer sie bekommt, bekommt ein
 * Passwort, und das wird protokolliert wie jedes andere. Das erste Gerät,
 * das den Eintrag ohnehin öffnen kann, stellt ihn dabei um — derselbe
 * Gedanke wie beim Nachtragen eines fehlenden Kontopakets.
 *
 * Hinzufügen und Entfernen von Mitgliedern ist wie bei Notizen ausschließlich
 * der besitzenden Person vorbehalten — dieselbe Begründung wie dort (Kopf
 * von services/notizen.ts).
 */

/** Chiffrat großzügig, aber nicht grenzenlos — ein Angriffspunkt weniger.
 *  Kleiner als bei Notizen (2.000.000): ein Tresoreintrag ist ein Formular,
 *  kein Schriftstück. */
const CHIFFRAT_MAX = 200_000;

function pruefeChiffrat(chiffrat: string, erwarteteFassung?: number): number {
  if (typeof chiffrat !== 'string' || chiffrat.length > CHIFFRAT_MAX) {
    throw abweisung('fehler.passwortUngueltigeForm', 'Der Eintrag ist zu groß oder hat die falsche Form.');
  }
  const nutzlast = nutzlastLesen(chiffrat);
  if (!nutzlast) throw abweisung('fehler.passwortKeinChiffrat', 'Das ist kein verschlüsselter Tresorinhalt.');
  if (erwarteteFassung !== undefined && nutzlast.fassung !== erwarteteFassung) {
    /* Derselbe stille Wettlauf wie bei Notizen — siehe dort. Kein
       Nutzerfehler, deshalb keine eigene Meldung: speichern() behandelt das
       als denselben Konflikt wie einen veralteten Inhaltsstand. */
    throw new FassungsKonflikt();
  }
  return nutzlast.fassung;
}

class FassungsKonflikt extends Abweisung {
  constructor() { super('fehler.passwortSchluesselGewechselt', 'Der Tresorschlüssel wurde inzwischen gewechselt.'); }
}

/**
 * Eine Zeile in das, was der Client zu sehen bekommt.
 *
 * DIE EINE ZEILE, AUF DIE ES ANKOMMT, IST `chiffrat`. Bei einem Eintrag aus
 * dem Altbestand (keine Zeile in passwort_geheimnisse) enthält die
 * gespeicherte Hülle das Passwort noch mit — und wird deshalb hier GELEERT.
 * Nicht als Höflichkeit, sondern damit es strukturell keinen Dienstweg gibt,
 * über den eine solche Hülle ohne Vermerk herauskommt: jede Funktion dieser
 * Datei, die einen Passworteintrag zurückgibt, geht durch hier. Wer die alte
 * Hülle braucht, muss `geheimnisAusliefern()` nehmen, und die schreibt.
 *
 * `r.hat_geheimnis` liefern die Abfragen unten als EXISTS mit; ein fehlendes
 * Feld gilt als "nein", weil ein leeres `chiffrat` höchstens eine sichtbare
 * Umstellung auslöst, ein irrtümlich herausgereichtes Passwort aber nicht
 * zurückzuholen ist.
 */
function toEintrag(
  r: any,
  mitgliederJeEintrag: Map<string, { userId: string; entferntAm: number | null }[]>,
): Passworteintrag {
  const mitglieder = mitgliederJeEintrag.get(r.id) ?? [];
  const altbestand = !r.hat_geheimnis;
  return {
    id: r.id,
    ownerId: r.owner_id,
    chiffrat: altbestand ? '' : r.chiffrat,
    altbestand,
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

function mitgliederFuer(eintragIds: string[]): Map<string, { userId: string; entferntAm: number | null }[]> {
  const out = new Map<string, { userId: string; entferntAm: number | null }[]>();
  if (!eintragIds.length) return out;
  for (const r of db.all<any>(
    `SELECT eintrag_id, user_id, entfernt_am FROM passwort_mitglieder
     WHERE eintrag_id IN (${placeholders(eintragIds.length)}) ORDER BY hinzugefuegt_am ASC`,
    ...eintragIds,
  )) {
    const liste = out.get(r.eintrag_id) ?? [];
    liste.push({ userId: r.user_id, entferntAm: r.entfernt_am ?? null });
    out.set(r.eintrag_id, liste);
  }
  return out;
}

/** Besitzt oder liest diese Person diesen Eintrag gerade? */
export function sichtbar(eintragId: string, userId: string): boolean {
  return Boolean(db.get(
    `SELECT 1 AS x FROM passwort_eintraege WHERE id = ? AND (
       owner_id = ?
       OR EXISTS (SELECT 1 FROM passwort_mitglieder WHERE eintrag_id = ? AND user_id = ? AND entfernt_am IS NULL)
     )`,
    eintragId, userId, eintragId, userId,
  ));
}

function istBesitzer(eintragId: string, userId: string): boolean {
  return Boolean(db.get('SELECT 1 AS x FROM passwort_eintraege WHERE id = ? AND owner_id = ?', eintragId, userId));
}

/** Die eigenen Einträge — eigene und die, zu denen man hinzugefügt wurde. */
export function listEintraege(userId: string): Passworteintrag[] {
  const rows = db.all<any>(
    `SELECT DISTINCT n.*,
            EXISTS (SELECT 1 FROM passwort_geheimnisse g WHERE g.eintrag_id = n.id) AS hat_geheimnis
     FROM passwort_eintraege n
     LEFT JOIN passwort_mitglieder m ON m.eintrag_id = n.id AND m.user_id = ? AND m.entfernt_am IS NULL
     WHERE n.owner_id = ? OR m.user_id IS NOT NULL
     ORDER BY n.geaendert_am DESC`,
    userId, userId,
  );
  const mitglieder = mitgliederFuer(rows.map((r) => r.id));
  return rows.map((r) => toEintrag(r, mitglieder));
}

export function getEintrag(id: string, userId: string): Passworteintrag | null {
  if (!sichtbar(id, userId)) return null;
  const row = db.get<any>(
    `SELECT n.*, EXISTS (SELECT 1 FROM passwort_geheimnisse g WHERE g.eintrag_id = n.id) AS hat_geheimnis
     FROM passwort_eintraege n WHERE n.id = ?`, id,
  );
  if (!row) return null;
  return toEintrag(row, mitgliederFuer([id]));
}

export function empfaengerIds(eintragId: string): string[] {
  const row = db.get<{ owner_id: string }>('SELECT owner_id FROM passwort_eintraege WHERE id = ?', eintragId);
  if (!row) return [];
  const mitglieder = db.all<{ user_id: string }>(
    'SELECT user_id FROM passwort_mitglieder WHERE eintrag_id = ? AND entfernt_am IS NULL', eintragId,
  ).map((r) => r.user_id);
  return [row.owner_id, ...mitglieder];
}

/** "pw_" + 32 Hexzeichen (crypto.randomUUID ohne Bindestriche) — dieselbe
 *  Bauart wie bei Notizen, eigener Vorsatz. */
const EINTRAG_ID_MUSTER = /^pw_[a-f0-9]{32}$/;

/**
 * `geheimChiffrat` ist optional, obwohl jede aktuelle App es mitschickt: eine
 * App-Fassung von vor der Trennung kann es nicht kennen, und ein Eintrag, den
 * sie anlegt, soll trotzdem entstehen statt an einer Abweisung zu scheitern.
 * Er entsteht dann als Altbestand und wird beim ersten Öffnen durch eine
 * aktuelle App umgestellt — derselbe Weg, den die 32 Fassungen alter
 * Einträge nehmen.
 */
export function anlegen(input: {
  id: string; ownerId: string; chiffrat: string; paket: SchluesselPaket; kontoPaket?: KontoPaket;
  geheimChiffrat?: string;
}): Passworteintrag {
  if (!EINTRAG_ID_MUSTER.test(input.id)) throw abweisung('fehler.passwortUngueltigeKennung', 'Ungültige Kennung für einen neuen Tresoreintrag.');
  if (db.get('SELECT 1 AS x FROM passwort_eintraege WHERE id = ?', input.id)) {
    throw abweisung('fehler.passwortExistiertBereits', 'Diesen Eintrag gibt es schon.');
  }
  const fassung = pruefeChiffrat(input.chiffrat, 1);
  if (input.geheimChiffrat !== undefined) pruefeChiffrat(input.geheimChiffrat, 1);
  if (!input.paket?.iv || !input.paket?.daten) throw abweisung('fehler.passwortSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');

  const id = input.id;
  const jetzt = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO passwort_eintraege (id, owner_id, chiffrat, version, schluessel_fassung, geaendert_von, geaendert_am, erstellt_am)
       VALUES (?,?,?,1,?,?,?,?)`,
      id, input.ownerId, input.chiffrat, fassung, input.ownerId, jetzt, jetzt,
    );
    db.run(
      `INSERT INTO passwort_schluessel_pakete (eintrag_id, user_id, fassung, von_user_id, alg, iv, daten, erstellt_am)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, input.ownerId, fassung, input.paket.von || input.ownerId,
      input.paket.alg, input.paket.iv, input.paket.daten, jetzt,
    );
    if (input.geheimChiffrat !== undefined) geheimnisSchreiben(id, input.geheimChiffrat, fassung, jetzt);
    if (input.kontoPaket) kontoPaketSchreiben(id, input.ownerId, fassung, input.kontoPaket, jetzt);
  });
  return getEintrag(id, input.ownerId)!;
}

/* ── Das Geheimnis ────────────────────────────────────────────── */

/** Ist dieser Eintrag schon getrennt, oder liegt er noch als eine Hülle da? */
function geheimnisVorhanden(eintragId: string): boolean {
  return Boolean(db.get('SELECT 1 AS x FROM passwort_geheimnisse WHERE eintrag_id = ?', eintragId));
}

/** Immer in derselben Transaktion wie das Schaufenster — ein Eintrag, dessen
 *  beide Hüllen unter verschiedenen Schlüsselfassungen stehen, wäre halb
 *  unlesbar, und zwar still. */
function geheimnisSchreiben(eintragId: string, chiffrat: string, fassung: number, jetzt: number): void {
  db.run(
    `INSERT INTO passwort_geheimnisse (eintrag_id, chiffrat, fassung, geaendert_am)
     VALUES (?,?,?,?)
     ON CONFLICT(eintrag_id) DO UPDATE SET
       chiffrat = excluded.chiffrat, fassung = excluded.fassung, geaendert_am = excluded.geaendert_am`,
    eintragId, chiffrat, fassung, jetzt,
  );
}

/**
 * DER EINZIGE WEG AN EIN PASSWORT — und deshalb die einzige Stelle, an der
 * eine Offenlegungszeile entsteht.
 *
 * Lesen und Vermerken stehen in EINER Transaktion, und der Vermerk steht
 * VOR der Rückgabe: schlägt das Schreiben fehl, wird nichts ausgeliefert.
 * Das ist der ganze Unterschied zur vorherigen Bauart, in der der Client
 * hinterher meldete, dass er hingesehen habe (und es einfach lassen konnte).
 *
 * `altbestand: true` heißt: dieser Eintrag ist noch nicht getrennt, die
 * gelieferte Hülle enthält AUCH Etikett, Benutzername, Notiz und Adresse.
 * Sie wird trotzdem — gerade dann — vermerkt: sie enthält das Passwort.
 * Der Aufrufer stellt den Eintrag anschließend um (lib/passwoerter.ts).
 */
export function geheimnisAusliefern(
  eintragId: string, userId: string,
): { chiffrat: string; fassung: number; altbestand: boolean } {
  if (!sichtbar(eintragId, userId)) throw abweisung('fehler.passwortNichtGefunden', 'Eintrag nicht gefunden.');
  return db.transaction(() => {
    const eintrag = db.get<{ chiffrat: string; schluessel_fassung: number }>(
      'SELECT chiffrat, schluessel_fassung FROM passwort_eintraege WHERE id = ?', eintragId,
    );
    if (!eintrag) throw abweisung('fehler.passwortNichtGefunden', 'Eintrag nicht gefunden.');
    const geheim = db.get<{ chiffrat: string; fassung: number }>(
      'SELECT chiffrat, fassung FROM passwort_geheimnisse WHERE eintrag_id = ?', eintragId,
    );
    db.run(
      'INSERT INTO passwort_offenlegungen (id, eintrag_id, user_id, am) VALUES (?,?,?,?)',
      newId('po_'), eintragId, userId, Date.now(),
    );
    return geheim
      ? { chiffrat: geheim.chiffrat, fassung: geheim.fassung, altbestand: false }
      : { chiffrat: eintrag.chiffrat, fassung: eintrag.schluessel_fassung, altbestand: true };
  });
}

/* ── Der Kontoweg ─────────────────────────────────────────────── */

function kontoPaketSchreiben(
  eintragId: string, userId: string, fassung: number, paket: KontoPaket, jetzt: number,
): void {
  db.run(
    `INSERT INTO passwort_konto_pakete (eintrag_id, user_id, fassung, konto_fassung, alg, iv, daten, erstellt_am)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(eintrag_id, user_id) DO UPDATE SET
       fassung = excluded.fassung, konto_fassung = excluded.konto_fassung, alg = excluded.alg,
       iv = excluded.iv, daten = excluded.daten, erstellt_am = excluded.erstellt_am`,
    eintragId, userId, fassung, paket.kontoFassung, paket.alg, paket.iv, paket.daten, jetzt,
  );
}

export function kontoPaketSetzen(input: {
  eintragId: string; userId: string; fassung: number; paket: KontoPaket;
}): void {
  if (!sichtbar(input.eintragId, input.userId)) throw abweisung('fehler.passwortNichtGefunden', 'Eintrag nicht gefunden.');
  const p = input.paket;
  if (!p?.iv || !p?.daten) throw abweisung('fehler.passwortSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');

  const eintrag = db.get<{ schluessel_fassung: number }>(
    'SELECT schluessel_fassung FROM passwort_eintraege WHERE id = ?', input.eintragId,
  );
  if (!eintrag) throw abweisung('fehler.passwortNichtGefunden', 'Eintrag nicht gefunden.');
  if (input.fassung !== eintrag.schluessel_fassung) throw abweisung('fehler.schluesselfassungUnbekannt', 'Diese Schlüsselfassung gibt es nicht.');

  const kontoFassung = kontoFassungVon(input.userId);
  if (!kontoFassung || p.kontoFassung !== kontoFassung) {
    throw abweisung('fehler.schluesselfassungUnbekannt', 'Diese Schlüsselfassung gibt es nicht.');
  }

  db.transaction(() => kontoPaketSchreiben(input.eintragId, input.userId, input.fassung, p, Date.now()));
}

export function kontoPaketeFuerAlle(userId: string): { eintragId: string; fassung: number; paket: KontoPaket }[] {
  const kontoFassung = kontoFassungVon(userId);
  if (!kontoFassung) return [];
  return db.all<any>(
    `SELECT p.eintrag_id, p.fassung, p.konto_fassung, p.alg, p.iv, p.daten
     FROM passwort_konto_pakete p
     JOIN passwort_eintraege n ON n.id = p.eintrag_id AND n.schluessel_fassung = p.fassung
     WHERE p.user_id = ? AND p.konto_fassung = ?`,
    userId, kontoFassung,
  ).map((r) => ({
    eintragId: r.eintrag_id, fassung: r.fassung,
    paket: { alg: r.alg, kontoFassung: r.konto_fassung, iv: r.iv, daten: r.daten },
  }));
}

/**
 * Einträge, die diese Person sehen darf und für die ein gültiges Kontopaket
 * fehlt — derselbe Nachwuchsmechanismus wie notizenOhneKontoPaket() in
 * services/notizen.ts. Wird beim Laden der Tafel abgefragt (HTTP statt
 * WebSocket, siehe http/passwoerter.ts, GET /api/passwoerter): kein Push
 * nötig, ein Tresor ändert sich selten genug, dass "beim Öffnen nachfragen"
 * reicht.
 */
export function eintraegeOhneKontoPaket(userId: string): string[] {
  const kontoFassung = kontoFassungVon(userId);
  if (!kontoFassung) return [];
  return db.all<{ id: string }>(
    `SELECT n.id AS id FROM passwort_eintraege n
     LEFT JOIN passwort_mitglieder m ON m.eintrag_id = n.id AND m.user_id = ? AND m.entfernt_am IS NULL
     LEFT JOIN passwort_konto_pakete k ON k.eintrag_id = n.id AND k.user_id = ?
       AND k.fassung = n.schluessel_fassung AND k.konto_fassung = ?
     WHERE (n.owner_id = ? OR m.user_id IS NOT NULL) AND k.eintrag_id IS NULL`,
    userId, userId, kontoFassung, userId,
  ).map((r) => r.id);
}

/** Dasselbe für den Geräteweg — welche Mitgliedschaften noch kein ECDH-Paket
 *  haben. Beim HTTP-Pull-Modell (kein WebSocket-Push) fragt die besitzende
 *  Person das beim Öffnen der Tafel selbst ab, statt auf einen Anstoß vom
 *  Server zu warten — siehe lib/passwoerter.ts, `nachreichenPruefen()`. */
export function eigeneUnverpackteMitglieder(ownerId: string): { eintragId: string; userId: string }[] {
  return db.all<any>(
    `SELECT m.eintrag_id AS eintragId, m.user_id AS userId
     FROM passwort_mitglieder m
     JOIN passwort_eintraege n ON n.id = m.eintrag_id
     LEFT JOIN passwort_schluessel_pakete p ON p.eintrag_id = m.eintrag_id AND p.user_id = m.user_id
     WHERE n.owner_id = ? AND m.entfernt_am IS NULL AND p.user_id IS NULL`,
    ownerId,
  );
}

export function paketFuer(eintragId: string, userId: string): { fassung: number; paket: SchluesselPaket } | null {
  const r = db.get<any>(
    'SELECT fassung, von_user_id, alg, iv, daten FROM passwort_schluessel_pakete WHERE eintrag_id = ? AND user_id = ?',
    eintragId, userId,
  );
  if (!r || !r.iv) return null;
  return { fassung: r.fassung, paket: { alg: r.alg, von: r.von_user_id, iv: r.iv, daten: r.daten } };
}

export function paketeFuerAlle(userId: string): { eintragId: string; fassung: number; paket: SchluesselPaket }[] {
  return db.all<any>(
    'SELECT eintrag_id, fassung, von_user_id, alg, iv, daten FROM passwort_schluessel_pakete WHERE user_id = ?',
    userId,
  ).map((r) => ({
    eintragId: r.eintrag_id, fassung: r.fassung,
    paket: { alg: r.alg, von: r.von_user_id, iv: r.iv, daten: r.daten },
  }));
}

/* ── Speichern ─────────────────────────────────────────────────── */

/**
 * DREI FÄLLE, EINE TRANSAKTION.
 *
 *   · Gewöhnliches Speichern eines getrennten Eintrags: `getrennt` ist gesetzt,
 *     `geheimChiffrat` darf fehlen. Genau das ist der Alltag — wer nur das
 *     Etikett ändert, hat das Passwort nie geholt und kann es folglich auch
 *     nicht mitschicken. Das gespeicherte Geheimnis bleibt dann stehen.
 *   · Umstellen eines Altbestands: `getrennt` ist gesetzt und `geheimChiffrat`
 *     LIEGT BEI. Beide Hüllen werden in einem Zug geschrieben; es gibt keinen
 *     Zwischenzustand, in dem das Schaufenster schon ohne Passwort dasteht,
 *     das Geheimnis aber noch fehlt (das Passwort wäre weg) oder umgekehrt
 *     (es stünde doppelt).
 *   · Eine App-Fassung von vor der Trennung: `getrennt` fehlt. Auf einem
 *     Altbestand ist das der unveränderte alte Weg und bleibt erlaubt. Auf
 *     einem bereits getrennten Eintrag wird es ABGEWIESEN — ihre eine Hülle
 *     enthält das Passwort, und sie ins Schaufenster zu schreiben hieße, es
 *     jedem zurückzugeben, der die Tafel bloß öffnet, während das getrennte
 *     Geheimnis daneben still veraltet. Laut scheitern ist hier die
 *     freundlichere Antwort.
 *
 * `getrennt` ist eine Auskunft des Clients und ausdrücklich KEINE Schranke:
 * wer den Eintrag speichern darf, hat den Schlüssel und könnte ohnehin
 * hineinschreiben, was er will. Die Angabe unterscheidet App-Fassungen, nicht
 * Berechtigte von Unberechtigten — das tut `sichtbar()` eine Zeile darüber.
 */
export function speichern(input: {
  eintragId: string; userId: string; chiffrat: string; version: number; force?: boolean;
  geheimChiffrat?: string; getrennt?: boolean;
}): { ok: true; eintrag: Passworteintrag } | { ok: false; eintrag: Passworteintrag } {
  if (!sichtbar(input.eintragId, input.userId)) throw abweisung('fehler.passwortNichtGefunden', 'Eintrag nicht gefunden.');
  const aktuell = db.get<{ version: number; schluessel_fassung: number }>(
    'SELECT version, schluessel_fassung FROM passwort_eintraege WHERE id = ?', input.eintragId,
  )!;
  const hatGeheimnis = geheimnisVorhanden(input.eintragId);

  if (hatGeheimnis && !input.getrennt) {
    throw abweisung('fehler.passwortGeheimnisFehlt', 'Diese Fassung der App kann diesen Eintrag nicht speichern — bitte aktualisieren.');
  }
  if (!hatGeheimnis && input.getrennt && input.geheimChiffrat === undefined) {
    throw abweisung('fehler.passwortGeheimnisFehlt', 'Zum Umstellen dieses Eintrags fehlt das getrennte Passwort.');
  }

  let fassungPasst = true;
  try {
    pruefeChiffrat(input.chiffrat, aktuell.schluessel_fassung);
    if (input.geheimChiffrat !== undefined) pruefeChiffrat(input.geheimChiffrat, aktuell.schluessel_fassung);
  } catch (err) {
    if (!(err instanceof FassungsKonflikt)) throw err;
    fassungPasst = false;
  }

  if (fassungPasst && (input.force || aktuell.version === input.version)) {
    const jetzt = Date.now();
    const geschrieben = db.transaction(() => {
      const { changes } = db.run(
        `UPDATE passwort_eintraege SET chiffrat = ?, version = version + 1, geaendert_von = ?, geaendert_am = ?
         WHERE id = ? AND version = ?`,
        input.chiffrat, input.userId, jetzt, input.eintragId, aktuell.version,
      );
      if (!changes) return false;
      if (input.geheimChiffrat !== undefined) {
        geheimnisSchreiben(input.eintragId, input.geheimChiffrat, aktuell.schluessel_fassung, jetzt);
      }
      return true;
    });
    if (geschrieben) return { ok: true, eintrag: getEintrag(input.eintragId, input.userId)! };
  }
  return { ok: false, eintrag: getEintrag(input.eintragId, input.userId)! };
}

/* ── Mitglieder ────────────────────────────────────────────────── */

export function mitgliedHinzufuegen(input: {
  eintragId: string; ownerId: string; zielUserId: string; paket: SchluesselPaket;
}): Passworteintrag {
  if (!istBesitzer(input.eintragId, input.ownerId)) {
    throw abweisung('fehler.passwortNurBesitzerHinzufuegen', 'Nur die besitzende Person teilt einen Tresoreintrag.');
  }
  if (input.zielUserId === input.ownerId) throw abweisung('fehler.passwortBesitzerBereitsMitglied', 'Die besitzende Person steht schon dabei.');
  if (!input.paket?.iv || !input.paket?.daten) throw abweisung('fehler.passwortSchluesselpaketUnvollstaendig', 'Das Schlüsselpaket ist unvollständig.');

  const eintrag = db.get<{ schluessel_fassung: number }>(
    'SELECT schluessel_fassung FROM passwort_eintraege WHERE id = ?', input.eintragId,
  );
  if (!eintrag) throw abweisung('fehler.passwortNichtGefunden', 'Eintrag nicht gefunden.');

  const jetzt = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO passwort_mitglieder (eintrag_id, user_id, hinzugefuegt_von, hinzugefuegt_am, entfernt_am, entfernt_grund)
       VALUES (?,?,?,?,NULL,NULL)
       ON CONFLICT(eintrag_id, user_id) DO UPDATE SET
         hinzugefuegt_von = excluded.hinzugefuegt_von, hinzugefuegt_am = excluded.hinzugefuegt_am,
         entfernt_am = NULL, entfernt_grund = NULL`,
      input.eintragId, input.zielUserId, input.ownerId, jetzt,
    );
    db.run(
      `INSERT INTO passwort_schluessel_pakete (eintrag_id, user_id, fassung, von_user_id, alg, iv, daten, erstellt_am)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(eintrag_id, user_id) DO UPDATE SET
         fassung = excluded.fassung, von_user_id = excluded.von_user_id, alg = excluded.alg,
         iv = excluded.iv, daten = excluded.daten, erstellt_am = excluded.erstellt_am`,
      input.eintragId, input.zielUserId, eintrag.schluessel_fassung, input.paket.von || input.ownerId,
      input.paket.alg, input.paket.iv, input.paket.daten, jetzt,
    );
  });
  return getEintrag(input.eintragId, input.ownerId)!;
}

export function paketeNachreichen(input: {
  eintragId: string; ownerId: string; zielUserId: string; paket: SchluesselPaket;
}): void {
  mitgliedHinzufuegen(input);
}

/**
 * Entfernen UND den Eintragsschlüssel wechseln — in einem Schritt, exakt wie
 * notiz:mitglied-entfernen (services/notizen.ts, mitgliedEntfernen()). Siehe
 * dort für die ausführliche Begründung; sie gilt hier unverändert.
 */
export function mitgliedEntfernen(input: {
  eintragId: string; ownerId: string; zielUserId: string;
  neueFassung: number; chiffrat: string; version: number;
  pakete: { userId: string; paket: SchluesselPaket }[];
  geheimChiffrat?: string;
}): Passworteintrag {
  if (!istBesitzer(input.eintragId, input.ownerId)) {
    throw abweisung('fehler.passwortNurBesitzerEntfernen', 'Nur die besitzende Person entfernt jemanden aus einem Tresoreintrag.');
  }
  const eintrag = db.get<{ version: number; schluessel_fassung: number }>(
    'SELECT version, schluessel_fassung FROM passwort_eintraege WHERE id = ?', input.eintragId,
  );
  if (!eintrag) throw abweisung('fehler.passwortNichtGefunden', 'Eintrag nicht gefunden.');
  if (input.neueFassung !== eintrag.schluessel_fassung + 1) {
    throw new FassungsKonflikt();
  }
  pruefeChiffrat(input.chiffrat, input.neueFassung);

  /* Ein Schlüsselwechsel muss BEIDE Hüllen mitnehmen. Bliebe das Geheimnis
     unter der alten Fassung stehen, wäre der Eintrag hinterher halb lesbar:
     Etikett und Benutzername kämen, das Passwort ließe sich nie wieder
     öffnen — und niemand bemerkte es, bis es gebraucht wird. Die besitzende
     Person hat das Passwort an dieser Stelle ohnehin geholt (der Vorgang ist
     vermerkt), sie kann es also neu verpacken. */
  const hatGeheimnis = geheimnisVorhanden(input.eintragId);
  if (hatGeheimnis && input.geheimChiffrat === undefined) {
    throw abweisung('fehler.passwortGeheimnisFehlt', 'Zum Wechseln des Schlüssels fehlt das neu verpackte Passwort.');
  }
  if (input.geheimChiffrat !== undefined) pruefeChiffrat(input.geheimChiffrat, input.neueFassung);

  const bleibenSollen = new Set([
    input.ownerId,
    ...db.all<{ user_id: string }>(
      `SELECT user_id FROM passwort_mitglieder WHERE eintrag_id = ? AND entfernt_am IS NULL AND user_id != ?`,
      input.eintragId, input.zielUserId,
    ).map((r) => r.user_id),
  ]);
  const verpacktFuer = new Set(input.pakete.map((p) => p.userId));
  if (verpacktFuer.has(input.zielUserId)) {
    throw abweisung('fehler.passwortPaketFuerEntfernte', 'Für die entfernte Person darf kein neues Paket dabei sein.');
  }
  for (const uid of bleibenSollen) {
    if (!verpacktFuer.has(uid)) throw abweisung('fehler.passwortPaketFehltFuerBleibende', 'Für ein verbleibendes Mitglied fehlt ein neues Schlüsselpaket.');
  }

  const jetzt = Date.now();
  db.transaction(() => {
    const { changes } = db.run(
      `UPDATE passwort_eintraege SET chiffrat = ?, schluessel_fassung = ?
       WHERE id = ? AND version = ? AND schluessel_fassung = ?`,
      input.chiffrat, input.neueFassung,
      input.eintragId, input.version, eintrag.schluessel_fassung,
    );
    if (!changes) throw new FassungsKonflikt();
    if (input.geheimChiffrat !== undefined) {
      geheimnisSchreiben(input.eintragId, input.geheimChiffrat, input.neueFassung, jetzt);
    }
    db.run(
      `UPDATE passwort_mitglieder SET entfernt_am = ?, entfernt_grund = NULL
       WHERE eintrag_id = ? AND user_id = ? AND entfernt_am IS NULL`,
      jetzt, input.eintragId, input.zielUserId,
    );
    db.run('DELETE FROM passwort_schluessel_pakete WHERE eintrag_id = ?', input.eintragId);
    db.run('DELETE FROM passwort_konto_pakete WHERE eintrag_id = ?', input.eintragId);
    for (const eintragPaket of input.pakete) {
      const p = eintragPaket.paket;
      if (!bleibenSollen.has(eintragPaket.userId) || !p?.iv || !p?.daten) continue;
      db.run(
        `INSERT INTO passwort_schluessel_pakete (eintrag_id, user_id, fassung, von_user_id, alg, iv, daten, erstellt_am)
         VALUES (?,?,?,?,?,?,?,?)`,
        input.eintragId, eintragPaket.userId, input.neueFassung, p.von || input.ownerId,
        p.alg, p.iv, p.daten, jetzt,
      );
    }
  });
  return getEintrag(input.eintragId, input.ownerId)!;
}

export function loeschen(eintragId: string, userId: string): void {
  if (!istBesitzer(eintragId, userId)) throw abweisung('fehler.passwortNurBesitzerLoescht', 'Nur die besitzende Person löscht einen Tresoreintrag.');
  db.run('DELETE FROM passwort_eintraege WHERE id = ?', eintragId);
}

/* ── Offenlegung: WER, WANN — nie WAS ─────────────────────────────
 *
 * HIER STAND EINMAL `offenlegungVermerken()`, eine öffentliche Funktion mit
 * einer eigenen Route dahinter, die der Client nach dem Aufdecken rief. Sie
 * ist ersatzlos entfallen, und das ist der Kern dieser Änderung: solange es
 * sie gab, konnte eine Zeile entstehen, ohne dass jemand etwas bekommen hat,
 * und jemand etwas bekommen, ohne dass eine Zeile entstand. Beides ist jetzt
 * unmöglich, weil `geheimnisAusliefern()` weiter oben das Schreiben und das
 * Herausgeben in derselben Transaktion tut — es gibt keine zweite Stelle im
 * Haus, die in passwort_offenlegungen schreibt, und keine, die ein Passwort
 * herausgibt.
 *
 * Dieselbe Machart wie einmalcode_abrufe (services/einmalcode.ts,
 * abrufMerken()) — nur ohne `bezeichnung`: dort steht das Etikett
 * verschlüsselt als KOPIE dabei, weil ein gelöschtes Konto den Nachweis nicht
 * unlesbar machen soll. Hier gäbe es nichts Sinnvolles, das zu kopieren wäre,
 * ohne den Server zum Mitwisser des Inhalts zu machen — er bekommt
 * `eintragId` (eine Kennung, kein Geheimnis) und sonst nichts.
 */

/** Wer diesen Eintrag wann aufgedeckt hat — nur für die besitzende Person,
 *  aus demselben Grund, aus dem nur sie Mitglieder verwaltet: sie ist die
 *  einzige, die für dieses eine Geheimnis Verantwortung trägt. */
export function offenlegungenFuer(eintragId: string, userId: string): PasswortOffenlegung[] {
  if (!istBesitzer(eintragId, userId)) throw abweisung('fehler.passwortNurBesitzerOffenlegungen', 'Nur die besitzende Person sieht, wer diesen Eintrag aufgedeckt hat.');
  return db.all<any>(
    'SELECT id, eintrag_id, user_id, am FROM passwort_offenlegungen WHERE eintrag_id = ? ORDER BY am DESC LIMIT 200',
    eintragId,
  ).map((r) => ({ id: r.id, eintragId: r.eintrag_id, userId: r.user_id, am: r.am }));
}

/* ── Beim Löschen eines Kontos ────────────────────────────────── */

/**
 * Wortgleiches Verhalten zu services/notizen.ts, kontoBereinigen() — siehe
 * dort für die ausführliche Begründung beider Fälle (rein persönlich fällt
 * weg, geteilt bleibt stehen und wechselt die besitzende Person).
 */
export function kontoBereinigen(userId: string): void {
  const eigeneEintraege = db.all<{ id: string }>('SELECT id FROM passwort_eintraege WHERE owner_id = ?', userId);
  for (const { id } of eigeneEintraege) {
    const naechste = db.get<{ user_id: string }>(
      `SELECT user_id FROM passwort_mitglieder
       WHERE eintrag_id = ? AND entfernt_am IS NULL AND user_id != ?
       ORDER BY hinzugefuegt_am ASC LIMIT 1`,
      id, userId,
    );
    if (!naechste) {
      db.run('DELETE FROM passwort_eintraege WHERE id = ?', id);
      continue;
    }
    db.run('UPDATE passwort_eintraege SET owner_id = ? WHERE id = ?', naechste.user_id, id);
    db.run('DELETE FROM passwort_mitglieder WHERE eintrag_id = ? AND user_id = ?', id, naechste.user_id);
  }

  db.run(
    `UPDATE passwort_mitglieder SET entfernt_am = ?, entfernt_grund = 'konto_geloescht'
     WHERE user_id = ? AND entfernt_am IS NULL`,
    Date.now(), userId,
  );

  db.run('DELETE FROM passwort_konto_pakete WHERE user_id = ?', userId);
}
