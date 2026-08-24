import {
  FREIGABE_TAGE_HOECHSTENS, FREIGABE_TAGE_VORGABE, FREIGABE_VERSUCHE, PAKET_ALG,
  type Freigabe, type FreigabeSchluessel, type OeffentlicherSchluessel, type SchluesselPaket,
} from '@stellium/shared';
import { db, placeholders } from '../db/index.js';
import { newId } from '../util/id.js';
import { abweisung } from '../util/abweisung.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { freigabeAbdruck, gleich } from '../crypto/vertraulich.js';
import { may } from './users.js';
import { memberIds } from './store.js';

/**
 * Vertrauliche Kanäle — die Buchhaltung dazu.
 *
 * Der Server führt hier Buch über Schlüssel, die er nicht besitzt. Er weiß,
 * wer welchen öffentlichen Teil hinterlegt hat, welche Fassung eines
 * Kanalschlüssels gerade gilt und für wen sie schon verpackt wurde. Öffnen
 * kann er nichts davon, und das ist keine Nachlässigkeit, sondern der ganze
 * Zweck: gegen wen die Verschlüsselung in `crypto/nachrichten.ts` schützt —
 * den gestohlenen Datenträger — schützt sie hier auch, aber zusätzlich gegen
 * den Server selbst.
 *
 * Zwei Regeln ziehen sich durch alles hier:
 *
 *   1. Was hereinkommt, ist entweder öffentlich gemeint oder schon
 *      verschlossen. Der Server nimmt nie einen Klartext entgegen, um ihn
 *      selbst zu verschließen.
 *   2. Jede Änderung am Zugang hinterlässt eine Spur. Eine Freigabe ohne
 *      sichtbare Systemnachricht im Kanal wäre eine stille Hintertür — genau
 *      das, was diese Verschlüsselung verhindern soll.
 */

/* ── Schlüsselpaare der Konten ────────────────────────────────── */

/**
 * Den öffentlichen Teil hinterlegen — und wahlweise die verschlossene
 * Sicherung des privaten Teils.
 *
 * Ein bereits hinterlegter Schlüssel wird nicht stillschweigend ersetzt.
 * Sonst genügte eine untergeschobene Meldung, um alle künftigen Pakete an
 * einen fremden Schlüssel zu leiten: die Mitglieder verpacken für das, was
 * hier steht. Ein Wechsel ist möglich, aber nur ausdrücklich — und er macht
 * alle bestehenden Pakete dieses Kontos wertlos, weshalb es danach überall
 * neu verpackt werden muss.
 */
export function schluesselMelden(input: {
  userId: string; jwk: string; abdruck: string; sicherung?: string | null;
}): { neu: boolean; gewechselt: boolean } {
  const vorhanden = db.get<{ jwk: string }>(
    'SELECT jwk FROM vertraulich_schluessel WHERE user_id = ?', input.userId,
  );

  if (vorhanden && vorhanden.jwk === input.jwk) {
    if (input.sicherung) sicherungHinterlegen(input.userId, input.sicherung);
    return { neu: false, gewechselt: false };
  }

  const jetzt = Date.now();
  db.transaction(() => {
    db.run(
      `INSERT INTO vertraulich_schluessel (user_id, jwk, abdruck, erstellt_am) VALUES (?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET jwk = excluded.jwk, abdruck = excluded.abdruck, erstellt_am = excluded.erstellt_am`,
      input.userId, input.jwk, input.abdruck, jetzt,
    );
    if (vorhanden) {
      /* Der alte private Teil ist weg — was mit ihm verpackt wurde, lässt sich
         nicht mehr öffnen. Die Pakete stehen zu lassen wäre schlimmer als sie
         zu löschen: die App hielte den Kanal für lesbar und zeigte dann bei
         jeder Nachricht einen Fehler, statt einmal nach dem Schlüssel zu
         fragen. */
      db.run('DELETE FROM kanal_schluessel_pakete WHERE user_id = ?', input.userId);
      db.run('DELETE FROM vertraulich_freigabe_pakete WHERE user_id = ?', input.userId);
      /* Dieselbe Überlegung gilt für Notizen (services/notizen.ts), aber nur
         zur Hälfte — und der Unterschied ist wichtig genug, um ihn
         auszuschreiben statt ihn stillschweigend zu übergehen:
         notiz_schluessel_pakete enthält zwei grundverschiedene Sorten Zeile
         unter derselben user_id. Die eine: ein MITGLIED, für das die
         besitzende Person (eine andere Person, mit einem eigenen,
         inzwischen veralteten Blick auf DIESEN Schlüssel hier) verpackt hat
         — genau wie bei kanal_schluessel_pakete oben, und genauso heilbar:
         fehlendeMitgliedschaften() sieht die Lücke, stößt die besitzende
         Person an, die verpackt mit dem jetzt gültigen öffentlichen Teil
         neu. Die andere: das eigene Paket der besitzenden Person selbst zu
         ihrer eigenen Notiz (angelegt bei notiz:anlegen, "ECDH mit sich
         selbst" — siehe dort). Das lässt sich NICHT heilen, und zwar aus
         einem tieferen Grund als bloß "niemand ist gerade online": dieses
         Paket ist mit dem PRIVATEN Teil verpackt, den genau dieses Konto vor
         dem Wechsel hatte. Meldet ein anderes Gerät DESSELBEN Kontos jetzt
         einen anderen öffentlichen Teil, besitzt es einen ANDEREN privaten
         Schlüssel — es kann das alte Paket so wenig neu verpacken wie ein
         Mitglied, dem der Schlüssel fehlt: es hat ihn ja gar nicht, selbst
         wenn die Kennung dieselbe ist. Es gibt keine dritte Partei, die für
         "sich selbst" einspringen könnte. Das Paket zu löschen brächte hier
         also keine Heilung, sondern nur einen Verlust: ein zweites, noch
         verbundenes Gerät DESSELBEN Kontos, das seinen alten Schlüssel noch
         besitzt (und dieselbe Notiz bislang klaglos liest), verlöre mit
         einem Schlag den Zugriff, nur weil irgendwo ein drittes Gerät sich
         neu gemeldet hat — für einen Nutzen, den niemand einlösen kann.
         Deshalb bleibt das eigene Paket der besitzenden Person hier
         ausdrücklich unangetastet (owner_id != Bedingung unten); nur
         Mitgliedspakete werden gelöscht. Was auf einem Gerät ohne den
         richtigen alten Schlüssel damit weiterhin liegen bleibt, meldet sich
         beim Öffnen ehrlich als "Schlüssel nicht verfügbar" statt endlos zu
         kreiseln (siehe lib/notizen.ts, notizenSchluesselFehlt) — das ist die
         Grenze der Ende-zu-Ende-Verschlüsselung selbst, keine Lücke, die
         sich hier noch schließen ließe. */
      db.run(
        `DELETE FROM notiz_schluessel_pakete
         WHERE user_id = ?
           AND EXISTS (
             SELECT 1 FROM notizen n
             WHERE n.id = notiz_schluessel_pakete.notiz_id AND n.owner_id != ?
           )`,
        input.userId, input.userId,
      );
    }
    if (input.sicherung) {
      db.run(
        `INSERT INTO vertraulich_sicherung (user_id, paket, erstellt_am) VALUES (?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET paket = excluded.paket, erstellt_am = excluded.erstellt_am`,
        input.userId, input.sicherung, jetzt,
      );
    }
  });
  return { neu: !vorhanden, gewechselt: Boolean(vorhanden) };
}

export function sicherungHinterlegen(userId: string, paket: string): void {
  db.run(
    `INSERT INTO vertraulich_sicherung (user_id, paket, erstellt_am) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET paket = excluded.paket, erstellt_am = excluded.erstellt_am`,
    userId, paket, Date.now(),
  );
}

/** Die eigene Sicherung. Ohne den Wiederherstellungscode ist sie wertlos. */
export function sicherungHolen(userId: string): string | null {
  return db.get<{ paket: string }>(
    'SELECT paket FROM vertraulich_sicherung WHERE user_id = ?', userId,
  )?.paket ?? null;
}

export function oeffentlicheSchluessel(userIds?: string[]): OeffentlicherSchluessel[] {
  const rows = userIds?.length
    ? db.all<any>(
        `SELECT * FROM vertraulich_schluessel WHERE user_id IN (${placeholders(userIds.length)})`,
        ...userIds,
      )
    : db.all<any>('SELECT * FROM vertraulich_schluessel');
  return rows.map((r) => ({
    userId: r.user_id, jwk: r.jwk, abdruck: r.abdruck, erstelltAm: r.erstellt_am,
  }));
}

export function hatSchluessel(userId: string): boolean {
  return Boolean(db.get('SELECT 1 AS x FROM vertraulich_schluessel WHERE user_id = ?', userId));
}

/* ── Kanäle ───────────────────────────────────────────────────── */

export function istVertraulich(channelId: string): boolean {
  return Boolean(db.get<{ vertraulich: number }>(
    'SELECT vertraulich FROM channels WHERE id = ?', channelId,
  )?.vertraulich);
}

export function aktuelleFassung(channelId: string): number {
  return db.get<{ schluessel_fassung: number }>(
    'SELECT schluessel_fassung FROM channels WHERE id = ?', channelId,
  )?.schluessel_fassung ?? 0;
}

/**
 * Einen Kanal auf vertraulich stellen.
 *
 * Öffentliche Kanäle bleiben außen vor. Nicht aus technischen Gründen — es
 * ginge — sondern weil beides zusammen nicht zusammenpasst: ein offener Kanal
 * lädt jede Person zum Mitlesen ein, ein vertraulicher schließt jede Person
 * ohne Schlüssel aus. Wer beides will, will in Wahrheit einen privaten Kanal.
 *
 * Der Kanalschlüssel kommt fertig verpackt aus der App des Aufrufers, einmal
 * für jedes Mitglied. Fehlt für jemanden ein Paket, wird der Kanal trotzdem
 * vertraulich — die App der betroffenen Person merkt beim Öffnen, dass ihr
 * die Fassung fehlt, und fragt danach. Das Gegenteil wäre schlimmer: ein Kanal
 * bliebe offen, weil ein einziges Konto die neue App noch nicht gestartet hat.
 *
 * WAS MIT DEM BISHERIGEN INHALT PASSIERT: nichts. Nachrichten aus der Zeit
 * davor bleiben im Klartext, und Anhänge und Dateien aus dieser Zeit bleiben
 * unverschlüsselt — dieselbe Entscheidung, aus demselben Grund und mit
 * derselben Systemnachricht im Verlauf, die die Umstellung sichtbar macht.
 *
 * Der Grund ist nicht Bequemlichkeit. Der Server kann nichts nachträglich
 * verschließen: er hat den Kanalschlüssel nicht, und das ist der ganze Zweck
 * der Sache. Es bliebe also nur, jedes Mitglied jede alte Datei noch einmal
 * herunterladen, verschlüsseln und hochladen zu lassen — und selbst danach
 * wäre nichts gewonnen, was zählt: diese Bytes lagen bereits offen auf dem
 * Server, in jeder Sicherung und in jedem Zwischenspeicher, der sie je gesehen
 * hat. Sie hinterher zuzusperren sähe nach Schutz aus, wo keiner war. Ehrlich
 * ist der sichtbare Schnitt: ab hier ist zu, davor war offen, und beides steht
 * im Verlauf. Die Oberfläche kennzeichnet die alten Anhänge entsprechend.
 */
export function einschalten(input: {
  channelId: string; userId: string;
  pakete: { userId: string; paket: SchluesselPaket }[];
}): number {
  const kanal = db.get<{ kind: string; vertraulich: number }>(
    'SELECT kind, vertraulich FROM channels WHERE id = ?', input.channelId,
  );
  if (!kanal) throw abweisung('fehler.kanalNichtGefunden', 'Kanal nicht gefunden');
  if (kanal.vertraulich) throw abweisung('fehler.kanalBereitsVertraulich', 'Dieser Kanal ist bereits vertraulich.');
  if (kanal.kind === 'public') {
    throw abweisung('fehler.kanalOeffentlichNichtVertraulich', 'Offene Kanäle lassen sich nicht vertraulich stellen. Lege dafür einen privaten Kanal an.');
  }

  const fassung = 1;
  const jetzt = Date.now();
  /* Nur an Mitglieder — dieselbe Regel wie in paketeNachreichen() und
     wechseln(), die hier als einzige fehlte. Ein Paket für ein Konto außerhalb
     des Kanals ließe sich zwar nirgends abholen (vertraulich:paket-holen prüft
     die Mitgliedschaft), aber es stünde in der Buchhaltung als versorgt und
     machte damit die Auskunft falsch, wer diesen Kanal aufschließen kann. Eine
     Schlüsselbuchhaltung, die mehr Namen führt als der Kanal Mitglieder hat,
     ist genau die Art Unstimmigkeit, in der später jemand eine Tür findet. */
  const mitglieder = new Set(memberIds(input.channelId));
  db.transaction(() => {
    db.run('UPDATE channels SET vertraulich = 1, schluessel_fassung = ?, ai_mode = \'off\' WHERE id = ?',
      fassung, input.channelId);
    db.run(
      'INSERT INTO kanal_schluessel (channel_id, fassung, erzeugt_von, grund, erstellt_am) VALUES (?,?,?,?,?)',
      input.channelId, fassung, input.userId, 'eingeschaltet', jetzt,
    );
    paketeSchreiben(
      input.channelId, fassung, input.userId,
      input.pakete.filter((p) => mitglieder.has(p.userId)),
    );
  });
  return fassung;
}

/**
 * Vertraulichkeit wieder abschalten.
 *
 * Was verschlüsselt geschrieben wurde, bleibt verschlüsselt — der Server
 * könnte es gar nicht zurückverwandeln. Ab hier geht wieder alles im Klartext
 * hinaus, und der alte Verlauf bleibt für Mitglieder mit Schlüssel lesbar und
 * für alle anderen ein Block Zeichen. Deshalb bleiben die Pakete stehen.
 */
export function ausschalten(channelId: string): void {
  db.run('UPDATE channels SET vertraulich = 0 WHERE id = ?', channelId);
}

function paketeSchreiben(
  channelId: string, fassung: number, vonUserId: string,
  pakete: { userId: string; paket: SchluesselPaket }[],
): number {
  let geschrieben = 0;
  for (const eintrag of pakete) {
    const p = eintrag.paket;
    if (!p?.iv || !p?.daten) continue;
    /* INSERT OR IGNORE, nicht REPLACE: wer schon ein Paket hat, soll keines
       untergeschoben bekommen. Zwei Mitglieder können gleichzeitig auf eine
       Anfrage antworten, und das zweite Paket ist dann nicht falsch, nur
       überflüssig. */
    const res = db.run(
      `INSERT OR IGNORE INTO kanal_schluessel_pakete
         (channel_id, fassung, user_id, von_user_id, alg, iv, daten, erstellt_am)
       VALUES (?,?,?,?,?,?,?,?)`,
      channelId, fassung, eintrag.userId, vonUserId,
      p.alg || PAKET_ALG, p.iv, p.daten, Date.now(),
    );
    geschrieben += res.changes;
  }
  return geschrieben;
}

/**
 * Fehlende Pakete nachreichen.
 *
 * Der übliche Fall: jemand wurde in den Kanal aufgenommen. Verpacken kann das
 * nur, wer den Schlüssel schon hat — also ein Mitglied, nicht der Server.
 * Deshalb prüft diese Stelle die Mitgliedschaft und nicht ein Recht.
 */
export function paketeNachreichen(input: {
  channelId: string; fassung: number; vonUserId: string;
  pakete: { userId: string; paket: SchluesselPaket }[];
}): number {
  if (!memberIds(input.channelId).includes(input.vonUserId)) {
    throw abweisung('fehler.vertraulichNurMitgliederWeitergeben', 'Nur Mitglieder können den Kanalschlüssel weitergeben.');
  }
  const bekannt = db.get(
    'SELECT 1 AS x FROM kanal_schluessel WHERE channel_id = ? AND fassung = ?',
    input.channelId, input.fassung,
  );
  if (!bekannt) throw abweisung('fehler.schluesselfassungUnbekannt', 'Diese Schlüsselfassung gibt es nicht.');

  // Nur an Mitglieder. Sonst ließe sich der Kanalschlüssel an Außenstehende
  // verteilen, ohne dass es jemandem auffiele.
  const mitglieder = new Set(memberIds(input.channelId));
  const erlaubt = input.pakete.filter((p) => mitglieder.has(p.userId));
  return paketeSchreiben(input.channelId, input.fassung, input.vonUserId, erlaubt);
}

/**
 * Den Kanalschlüssel wechseln.
 *
 * Nötig, sobald jemand den Kanal verlässt: sein Gerät hat die alte Fassung und
 * behält sie. Ohne Wechsel läse er alles Neue weiter mit, obwohl er nicht mehr
 * dabei ist. Der alte Schlüssel bleibt gültig für alles, was vorher geschrieben
 * wurde — den Verlauf rückwirkend unlesbar zu machen ginge nur, indem man ihn
 * neu verschlüsselt, und dafür müsste jemand alles einmal durch seine App
 * schicken. Der Gewinn wäre gering: gelesen hat er es ohnehin schon.
 */
export function wechseln(input: {
  channelId: string; userId: string; grund?: string;
  pakete: { userId: string; paket: SchluesselPaket }[];
}): number {
  if (!memberIds(input.channelId).includes(input.userId)) {
    throw abweisung('fehler.vertraulichNurMitgliederWechseln', 'Nur Mitglieder können den Kanalschlüssel wechseln.');
  }
  const neueFassung = aktuelleFassung(input.channelId) + 1;
  const mitglieder = new Set(memberIds(input.channelId));
  const jetzt = Date.now();

  db.transaction(() => {
    db.run(
      'INSERT INTO kanal_schluessel (channel_id, fassung, erzeugt_von, grund, erstellt_am) VALUES (?,?,?,?,?)',
      input.channelId, neueFassung, input.userId, input.grund ?? 'gewechselt', jetzt,
    );
    db.run('UPDATE channels SET schluessel_fassung = ? WHERE id = ?', neueFassung, input.channelId);
    paketeSchreiben(
      input.channelId, neueFassung, input.userId,
      input.pakete.filter((p) => mitglieder.has(p.userId)),
    );
  });
  return neueFassung;
}

/** Alle Fassungen, die für dieses Konto in diesem Kanal verpackt sind. */
export function paketeFuer(channelId: string, userId: string): { fassung: number; paket: SchluesselPaket }[] {
  return db.all<any>(
    `SELECT fassung, von_user_id, alg, iv, daten FROM kanal_schluessel_pakete
     WHERE channel_id = ? AND user_id = ? ORDER BY fassung ASC`,
    channelId, userId,
  ).map((r) => ({
    fassung: r.fassung,
    paket: { alg: r.alg, von: r.von_user_id, iv: r.iv, daten: r.daten },
  }));
}

/**
 * Wem in diesem Kanal noch ein Paket der aktuellen Fassung fehlt.
 *
 * Konten ohne hinterlegten öffentlichen Teil bleiben draußen — für sie ließe
 * sich gar nichts verpacken. Das betrifft, wer die App seit der Umstellung
 * noch nicht gestartet hat; beim ersten Start meldet sie einen Schlüssel, und
 * beim nächsten Blick steht die Person hier.
 */
export function fehlendePakete(channelId: string, fassung = aktuelleFassung(channelId)): string[] {
  if (!fassung) return [];
  const mitglieder = memberIds(channelId);
  if (!mitglieder.length) return [];
  const versorgt = new Set(db.all<{ user_id: string }>(
    'SELECT user_id FROM kanal_schluessel_pakete WHERE channel_id = ? AND fassung = ?',
    channelId, fassung,
  ).map((r) => r.user_id));
  const mitSchluessel = new Set(db.all<{ user_id: string }>(
    `SELECT user_id FROM vertraulich_schluessel WHERE user_id IN (${placeholders(mitglieder.length)})`,
    ...mitglieder,
  ).map((r) => r.user_id));
  return mitglieder.filter((id) => !versorgt.has(id) && mitSchluessel.has(id));
}

/** Hat dieses Konto den Kanal überhaupt aufgeschlossen bekommen? */
export function kannLesen(channelId: string, userId: string): boolean {
  return Boolean(db.get(
    'SELECT 1 AS x FROM kanal_schluessel_pakete WHERE channel_id = ? AND user_id = ?',
    channelId, userId,
  ));
}

/* ── Freigabe bei Vorfällen ───────────────────────────────────── */

/**
 * Wer im Sinne einer Freigabe "die Verwaltung" ist.
 *
 * Bewusst über ein Recht und nicht über die Rolle: so lässt sich der Kreis
 * verkleinern, ohne jemandem die Administration zu nehmen — und vergrößern,
 * ohne jemanden zum Administrator zu machen. Konten ohne hinterlegten
 * Schlüssel fallen heraus, weil sich für sie nichts verpacken ließe.
 */
export function verwaltungIds(): string[] {
  return db.all<{ id: string }>(
    `SELECT u.id FROM users u
     JOIN vertraulich_schluessel s ON s.user_id = u.id
     WHERE u.deleted_at IS NULL AND u.disabled = 0`,
  ).map((r) => r.id).filter((id) => may(id, 'vertraulich.freigabe_lesen'));
}

/**
 * Eine Freigabe anlegen.
 *
 * Die Pakete kommen fertig aus der App der meldenden Person: der Kanalschlüssel,
 * verpackt für jedes Mitglied der Verwaltung und zusätzlich mit dem Freigabecode
 * verschlossen. Zwei Schlösser mit zwei verschiedenen Besitzern — ohne Code gibt
 * der Server nichts heraus, und ohne den privaten Schlüssel der Verwaltung
 * nützt der Code nichts. Der Server hat weder das eine noch das andere.
 */
export function freigabeAnlegen(input: {
  channelId: string; melderId: string; grund: string; codeAbdruck: string;
  tage?: number; pakete: { userId: string; paket: SchluesselPaket }[];
}): Freigabe {
  if (!memberIds(input.channelId).includes(input.melderId)) {
    throw abweisung('fehler.vertraulichNurMitgliederMelden', 'Nur Mitglieder können einen Vorfall in diesem Kanal melden.');
  }
  const grund = input.grund.trim();
  if (!grund) throw abweisung('fehler.freigabeGrundFehlt', 'Bitte gib einen Grund an.');
  if (grund.length > 500) throw abweisung('fehler.freigabeGrundZuLang', 'Der Grund ist zu lang (höchstens 500 Zeichen).');
  if (!input.codeAbdruck) throw abweisung('fehler.freigabeCodeAbdruckFehlt', 'Zur Freigabe fehlt der Abdruck des Codes.');

  const empfaenger = new Set(verwaltungIds());
  const brauchbar = input.pakete.filter((p) => empfaenger.has(p.userId));
  if (!brauchbar.length) {
    throw abweisung('fehler.freigabeKeineVerwaltung', 'Es gibt niemanden in der Verwaltung, für den sich der Schlüssel verpacken ließe.');
  }

  const tage = Math.min(
    Math.max(Math.trunc(input.tage ?? FREIGABE_TAGE_VORGABE) || FREIGABE_TAGE_VORGABE, 1),
    FREIGABE_TAGE_HOECHSTENS,
  );
  const id = newId('fg_');
  const jetzt = Date.now();
  const fassung = aktuelleFassung(input.channelId);

  db.transaction(() => {
    db.run(
      `INSERT INTO vertraulich_freigaben
         (id, channel_id, fassung, melder_id, grund, code_abdruck, fehlversuche, erstellt_am, laeuft_ab, zurueckgenommen_am)
       VALUES (?,?,?,?,?,?,0,?,?,NULL)`,
      id, input.channelId, fassung, input.melderId,
      // Der Grund ist lesbarer Text und gehört damit durch dieselbe
      // Verschlüsselung wie jeder Nachrichtentext — siehe crypto/nachrichten.ts.
      verschluesseln(grund), freigabeAbdruck(input.codeAbdruck),
      jetzt, jetzt + tage * 86_400_000,
    );
    for (const eintrag of brauchbar) {
      const p = eintrag.paket;
      db.run(
        `INSERT OR REPLACE INTO vertraulich_freigabe_pakete
           (freigabe_id, user_id, von_user_id, alg, iv, daten) VALUES (?,?,?,?,?,?)`,
        id, eintrag.userId, input.melderId, p.alg || PAKET_ALG, p.iv, p.daten,
      );
    }
  });
  return getFreigabe(id)!;
}

function toFreigabe(r: any): Freigabe {
  return {
    id: r.id,
    channelId: r.channel_id,
    fassung: r.fassung,
    melderId: r.melder_id,
    grund: entschluesseln(r.grund),
    erstelltAm: r.erstellt_am,
    laeuftAb: r.laeuft_ab,
    zurueckgenommenAm: r.zurueckgenommen_am ?? null,
    fehlversuche: r.fehlversuche ?? 0,
  };
}

export function getFreigabe(id: string): Freigabe | null {
  const r = db.get<any>('SELECT * FROM vertraulich_freigaben WHERE id = ?', id);
  return r ? toFreigabe(r) : null;
}

/**
 * Freigaben, die dieses Konto sehen darf.
 *
 * Mitglieder des Kanals sehen sie, weil sie es sollen — eine Freigabe, von der
 * die Betroffenen nichts wissen, wäre die Hintertür, die es hier nicht geben
 * darf. Die Verwaltung sieht sie, weil sie damit arbeitet.
 */
export function freigabenFuer(userId: string, channelId?: string | null): Freigabe[] {
  const darfAlles = may(userId, 'vertraulich.freigabe_lesen');
  const rows = channelId
    ? db.all<any>('SELECT * FROM vertraulich_freigaben WHERE channel_id = ? ORDER BY erstellt_am DESC LIMIT 200', channelId)
    : db.all<any>('SELECT * FROM vertraulich_freigaben ORDER BY erstellt_am DESC LIMIT 200');
  return rows
    .filter((r) => darfAlles || memberIds(r.channel_id).includes(userId))
    .map(toFreigabe);
}

/**
 * Mit dem Code an den freigegebenen Schlüssel kommen.
 *
 * Der Code wird nie übertragen, nur sein Abdruck. Stimmt er nicht, zählt der
 * Fehlversuch mit: nach acht Versuchen ist die Freigabe verbrannt. Sechs
 * Zeichen sind für einen Menschen unerreichbar viele Möglichkeiten, für ein
 * Skript nicht — und dieses Skript soll nach acht Versuchen anhalten müssen,
 * statt neunhundert Millionen Mal fragen zu dürfen.
 */
export function freigabeOeffnen(input: {
  freigabeId: string; userId: string; codeAbdruck: string;
}): FreigabeSchluessel {
  /* Das Recht zuerst, erst danach die Frage, ob es diese Freigabe gibt.
     Andersherum beantwortete der Server auch jemandem ohne Recht, ob eine
     Kennung existiert — die Auskunft „diese Freigabe gibt es nicht" kam vor
     der Prüfung, und wer Kennungen durchprobiert, hätte daran ablesen können,
     in welchen Kanälen es einen Vorfall gab. */
  if (!may(input.userId, 'vertraulich.freigabe_lesen')) {
    throw abweisung('fehler.freigabeNurVerwaltung', 'Freigaben öffnet nur die Verwaltung.');
  }
  const r = db.get<any>('SELECT * FROM vertraulich_freigaben WHERE id = ?', input.freigabeId);
  if (!r) throw abweisung('fehler.freigabeNichtGefunden', 'Diese Freigabe gibt es nicht.');
  if (r.zurueckgenommen_am) throw abweisung('fehler.freigabeZurueckgenommen', 'Diese Freigabe wurde zurückgenommen.');
  if (r.laeuft_ab <= Date.now()) throw abweisung('fehler.freigabeAbgelaufen', 'Diese Freigabe ist abgelaufen.');
  if (r.fehlversuche >= FREIGABE_VERSUCHE) {
    throw abweisung('fehler.freigabeZuVieleVersuche', 'Zu viele Fehlversuche. Diese Freigabe muss neu erteilt werden.');
  }

  if (!gleich(r.code_abdruck, freigabeAbdruck(input.codeAbdruck))) {
    db.run('UPDATE vertraulich_freigaben SET fehlversuche = fehlversuche + 1 WHERE id = ?', input.freigabeId);
    const uebrig = FREIGABE_VERSUCHE - (r.fehlversuche + 1);
    if (uebrig > 0) {
      throw abweisung(
        'fehler.freigabeCodeFalschVersucheUebrig',
        `Der Code stimmt nicht. Noch ${uebrig} Versuche.`,
        { uebrig: String(uebrig) },
      );
    }
    throw abweisung('fehler.freigabeCodeFalschVerbraucht', 'Der Code stimmt nicht. Diese Freigabe ist damit verbraucht.');
  }

  const paket = db.get<any>(
    'SELECT * FROM vertraulich_freigabe_pakete WHERE freigabe_id = ? AND user_id = ?',
    input.freigabeId, input.userId,
  );
  if (!paket) {
    throw abweisung('fehler.freigabeKeinPaketFuerKonto', 'Für dein Konto wurde bei dieser Freigabe nichts verpackt — vermutlich kam dein Schlüssel später dazu.');
  }

  // Ein richtiger Code setzt die Zählung zurück: sonst summierten sich
  // Vertipper über Wochen zu einer Sperre für die nächste ehrliche Eingabe.
  db.run('UPDATE vertraulich_freigaben SET fehlversuche = 0 WHERE id = ?', input.freigabeId);

  return {
    freigabeId: r.id,
    channelId: r.channel_id,
    fassung: r.fassung,
    paket: { alg: paket.alg, von: paket.von_user_id, iv: paket.iv, daten: paket.daten },
  };
}

/**
 * Eine Freigabe vorzeitig beenden.
 *
 * Die meldende Person darf das, weil sie sie erteilt hat. Der Owner darf es,
 * weil er sonst nichts gegen eine unbedachte Freigabe in der Hand hätte. Die
 * Pakete verschwinden dabei — was die Verwaltung schon geöffnet hat, holt
 * niemand zurück, aber weiterreichen lässt es sich ab hier nicht mehr.
 */
export function freigabeZuruecknehmen(freigabeId: string, userId: string): Freigabe {
  const r = db.get<any>('SELECT * FROM vertraulich_freigaben WHERE id = ?', freigabeId);
  if (!r) throw abweisung('fehler.freigabeNichtGefunden', 'Diese Freigabe gibt es nicht.');
  const istOwner = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId)?.role === 'owner';
  if (r.melder_id !== userId && !istOwner) {
    throw abweisung('fehler.freigabeNurEigeneZuruecknehmen', 'Zurücknehmen kann die Freigabe nur, wer sie erteilt hat.');
  }
  if (r.zurueckgenommen_am) return toFreigabe(r);

  db.transaction(() => {
    db.run('UPDATE vertraulich_freigaben SET zurueckgenommen_am = ? WHERE id = ?', Date.now(), freigabeId);
    db.run('DELETE FROM vertraulich_freigabe_pakete WHERE freigabe_id = ?', freigabeId);
  });
  return getFreigabe(freigabeId)!;
}

/**
 * Abgelaufene Freigaben entschärfen.
 *
 * Der Ablauf allein genügt nicht: solange die Pakete daliegen, hängt alles an
 * einer einzigen Datumsprüfung im Code. Ein Fehler dort, und eine Freigabe von
 * vor zwei Jahren wäre wieder offen. Deshalb werden die Pakete gelöscht — dann
 * ist der Ablauf keine Regel mehr, sondern ein Zustand.
 */
export function abgelaufeneAufraeumen(jetzt = Date.now()): number {
  const faellig = db.all<{ id: string }>(
    `SELECT f.id FROM vertraulich_freigaben f
     WHERE f.laeuft_ab <= ? AND f.zurueckgenommen_am IS NULL
       AND EXISTS (SELECT 1 FROM vertraulich_freigabe_pakete p WHERE p.freigabe_id = f.id)`,
    jetzt,
  );
  for (const f of faellig) {
    db.run('DELETE FROM vertraulich_freigabe_pakete WHERE freigabe_id = ?', f.id);
  }
  return faellig.length;
}
