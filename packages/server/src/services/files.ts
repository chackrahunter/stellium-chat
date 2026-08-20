import fs from 'node:fs';
import { abweisung } from '../util/abweisung.js';
import path from 'node:path';
import type { StorageUsage, StoredFile } from '@stellium/shared';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { huelleLesen } from '../crypto/dateien.js';
import * as ablage from './ablage.js';

/**
 * Dateiablage, unabhängig von Nachrichten.
 *
 * Dateien liegen wie Anhänge unter DATA_DIR, aber mit eigenem Verzeichnis­eintrag:
 * Name, Ordner, Beschreibung und Kanalzuordnung lassen sich ändern, ohne dass
 * eine Nachricht daran hängt.
 */

/* Wie viel die Dateiablage insgesamt fassen darf. 50 GB ist reichlich für ein
   Team und lässt auf der 119-GB-Karte des Pi genug Luft für System, Datenbank
   und Sicherungen. Über STORAGE_QUOTA_GB jederzeit änderbar. */
const KONTINGENT = Number(process.env.STORAGE_QUOTA_GB ?? 50) * 1024 ** 3;

function toFile(r: any): StoredFile {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    privat: Boolean(r.privat),
    folder: r.folder ?? '',
    channelId: r.channel_id ?? null,
    description: r.description ?? null,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: `/storage/${r.id}`,
  };
}

/* ── Wer wo dazugehört ────────────────────────────────────────── */

/**
 * Steht dieses Konto in diesem Kanal?
 *
 * Als eigene Abfrage und nicht über services/store.ts: die Ablage soll für
 * eine Ja-Nein-Frage nicht am halben Kanalmodell hängen, und eine Zeile SQL
 * auf einem Primärschlüssel ist billiger als jede Zwischenschicht.
 */
function istMitglied(channelId: string, userId: string): boolean {
  return Boolean(db.get(
    'SELECT 1 AS x FROM channel_members WHERE channel_id = ? AND user_id = ?',
    channelId, userId,
  ));
}

function istVertraulich(channelId: string): boolean {
  return Boolean(db.get<{ vertraulich: number }>(
    'SELECT vertraulich FROM channels WHERE id = ?', channelId,
  )?.vertraulich);
}

/**
 * Die Ablage auflisten.
 *
 * `fuerUserId` entscheidet über zweierlei, und beides ist eine Zugangsfrage:
 *
 *   Private Dateien   kommen nur für ihren Besitzer mit. Eine private Datei
 *                     kann außer ihm niemand öffnen; sie trotzdem jedem im
 *                     Verzeichnis zu zeigen hieße, ihren Namen und ihre Größe
 *                     zu verteilen, ohne dass jemand etwas davon hätte.
 *
 *   Kanaldateien      nur aus Kanälen, in denen dieses Konto steht. Das fehlte
 *                     hier, und es war keine Kleinigkeit: `/api/files?channelId=…`
 *                     und `file:list` nahmen jede Kennung entgegen und
 *                     antworteten mit dem Verzeichnis — Name, Beschreibung,
 *                     Größe und Urheber jeder Datei eines fremden privaten oder
 *                     vertraulichen Kanals. Die Bytes gab `/storage/:id` zwar
 *                     nicht heraus, aber "Kündigung Meier.pdf — Entwurf für
 *                     Herrn Meier" braucht die Bytes nicht mehr.
 *
 * Ohne Konto bleibt beides zu: ein Aufrufer, der nicht sagt, für wen er fragt,
 * bekommt garantiert nichts, was jemandem gehört, statt versehentlich alles.
 */
export function listFiles(
  filter: { channelId?: string | null; folder?: string; fuerUserId?: string } = {},
): StoredFile[] {
  const bedingungen: string[] = [];
  const werte: any[] = [];

  if (filter.channelId === null) bedingungen.push('channel_id IS NULL');
  else if (filter.channelId) {
    // Nach einem fremden Kanal gefragt: dieselbe Antwort wie für einen leeren.
    if (!filter.fuerUserId || !istMitglied(filter.channelId, filter.fuerUserId)) return [];
    bedingungen.push('channel_id = ?'); werte.push(filter.channelId);
  } else if (filter.fuerUserId) {
    /* Ohne Filter geht es um die ganze Ablage. Dann müssen die Kanaldateien
       einzeln durch dieselbe Tür — sonst wäre der ungefilterte Aufruf der
       bequemere Weg an der Prüfung vorbei. */
    bedingungen.push(
      '(channel_id IS NULL OR channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))',
    );
    werte.push(filter.fuerUserId);
  } else {
    bedingungen.push('channel_id IS NULL');
  }

  if (filter.folder !== undefined) { bedingungen.push('folder = ?'); werte.push(filter.folder); }
  if (filter.fuerUserId) {
    bedingungen.push('(privat = 0 OR uploaded_by = ?)');
    werte.push(filter.fuerUserId);
  } else {
    bedingungen.push('privat = 0');
  }

  const where = bedingungen.length ? `WHERE ${bedingungen.join(' AND ')}` : '';
  return db.all<any>(
    `SELECT * FROM files ${where} ORDER BY folder, name COLLATE NOCASE LIMIT 1000`, ...werte,
  ).map(toFile);
}

export function getFile(id: string): (StoredFile & { path: string; encoding: string | null }) | null {
  const r = db.get<any>('SELECT * FROM files WHERE id = ?', id);
  return r ? { ...toFile(r), path: r.path, encoding: r.encoding ?? null } : null;
}

/* Was auf der Platte frei bleiben muss, egal was das Kontingent sagt. Läuft
   der Datenträger voll, kann SQLite nicht mehr schreiben, das Update nicht mehr
   entpacken und die nächtliche Sicherung nicht mehr anlegen — dann steht alles,
   nicht nur die Dateiablage. */
const RESERVE_HOECHSTENS = 15 * 1024 ** 3;

/**
 * Wie viel auf der Platte freibleiben muss.
 *
 * Ein fester Wert war falsch: auf einem Rechner mit fünf Gigabyte frei wäre die
 * ganze Ablage gesperrt, auch für eine Datei von zwölf Byte — der Prüflauf hat
 * genau das aufgedeckt. Deshalb ein Zehntel dessen, was noch frei ist, nach
 * oben auf fünfzehn Gigabyte gedeckelt. Auf dem Pi mit 101 GB frei bleiben so
 * gut zehn Gigabyte Luft, auf einem knappen Entwicklungsrechner ein halbes —
 * und die Ablage bleibt in beiden Fällen benutzbar.
 */
function reserve(frei: number): number {
  return Math.min(RESERVE_HOECHSTENS, Math.floor(frei * 0.1));
}

/**
 * Wie viel die Ablage wirklich fassen darf.
 *
 * Das eingestellte Kontingent ist eine Obergrenze, keine Zusage: liegt die
 * Ablage auf einem Datenträger, der weniger hergibt, gilt der kleinere Wert.
 * Auf dem Raspberry Pi steht das Kontingent auf 100 GB, die Karte hat aber nur
 * gut 100 GB frei — ohne diese Rechnung könnte die Ablage das System ersticken.
 */
function platzGrenze(belegt: number): number {
  try {
    const fs_ = fs.statfsSync(config.storageDir);
    const frei = fs_.bavail * fs_.bsize;

    // Was heute schon belegt ist, zählt zum Verfügbaren dazu — sonst schrumpfte
    // die Grenze mit jedem Upload doppelt.
    const moeglich = Math.max(0, frei + belegt - reserve(frei));
    return Math.min(KONTINGENT, moeglich);
  } catch {
    return KONTINGENT;         // ohne Auskunft bleibt es beim Kontingent
  }
}

export function usage(): StorageUsage {
  /* Gezählt wird, was auf der Platte liegt — nicht, was hochgeladen wurde.
     Eine Datei, die gepackt ein Fünftel belegt, soll das Kontingent auch nur
     zu einem Fünftel beanspruchen; genau dafür wurde gepackt. */
  const r = db.get<{ n: number; s: number | null }>(
    'SELECT COUNT(*) n, SUM(COALESCE(stored_size, size)) s FROM files');
  const anhaenge = db.get<{ s: number | null }>(
    'SELECT SUM(COALESCE(stored_size, size)) s FROM attachments');
  const used = (r?.s ?? 0) + (anhaenge?.s ?? 0);
  return {
    used,
    quota: platzGrenze(used),
    fileCount: r?.n ?? 0,
  };
}

export function addFile(input: {
  id: string; name: string; mime: string; size: number; storedPath: string;
  folder?: string; channelId?: string | null; description?: string | null; uploadedBy: string;
  /**
   * Privat heißt: was hier ankommt, ist bereits Chiffrat. Die App hat die
   * Datei verschlüsselt, bevor sie den Rechner verlassen hat — der Server
   * verwahrt sie und kann sie nicht öffnen, auch nicht mit dem Masterpasswort.
   *
   * Der Aufrufer entscheidet das nicht selbst, sondern liest es am Inhalt ab
   * (siehe crypto/dateien.ts). Sonst wäre "privat" ein Etikett statt einer
   * Tatsache.
   */
  privat?: boolean;
  /** Für welchen Kreis der Dateischlüssel verpackt ist. Null = offen. */
  huelle?: string | null;
}): StoredFile {
  const huelle = huelleLesen(input.huelle);
  const channelId = input.channelId ?? null;

  /* Der Kanal, den das Formular nennt, war bisher eine reine Zuordnung — nicht
     geprüft, für niemanden. Damit konnte jedes Konto mit Hochladerecht eine
     Datei in einen Kanal legen, in dem es nichts verloren hat: sie stand dann
     im Verzeichnis der Mitglieder, mit Namen und Beschreibung, und der
     Rundruf über file:upsert trug sie zusätzlich durch das ganze Haus. */
  if (channelId && !istMitglied(channelId, input.uploadedBy)) {
    throw abweisung('fehler.dateiKanalFremd',
      'In diesen Kanal kannst du nichts ablegen — du bist nicht darin.');
  }

  /* Dieselbe Regel wie für Anhänge (services/messages.ts): die Hülle muss zu
     dem Kanal passen, in dem die Datei landet.

     Hier fehlte sie ganz, und das war die offene Tür. Ein vertraulicher Kanal
     wies zwar jeden offenen Anhang und jeden offenen Nachrichtentext ab — die
     Team-Ablage nahm daneben eine Datei im Klartext entgegen, legte sie in den
     Blockspeicher und trug Namen, Typ und Beschreibung offen in die Tabelle.
     Der Klartext lag danach byteweise im Datenverzeichnis. Eine Zusage, die an
     einer Stelle gilt und an der Stelle daneben nicht, ist keine.

     Eine Datei für das eigene Konto (`konto`) bleibt erlaubt, auch in einem
     vertraulichen Kanal: sie ist strenger als der Kanal, nicht lockerer — der
     Server sieht nichts, und außer ihrem Besitzer bekommt sie niemand zu
     Gesicht. */
  if (channelId && istVertraulich(channelId)) {
    if (!huelle) {
      throw abweisung('fehler.dateiVertraulichNoetig',
        'Dieser Kanal ist vertraulich — eine Datei muss verschlüsselt ankommen. '
        + 'Diese App kann das noch nicht; bitte aktualisieren.');
    }
    if (huelle.art === 'kanal' && huelle.channelId !== channelId) {
      throw abweisung('fehler.dateiAndererKreis',
        'Diese Datei wurde für einen anderen Kreis verschlüsselt.');
    }
  } else if (huelle?.art === 'kanal') {
    // Umgekehrt genauso: ein Kanalschlüssel gehört nicht in einen anderen Kanal.
    if (huelle.channelId !== channelId) {
      throw abweisung('fehler.dateiAndererKreis',
        'Diese Datei wurde für einen anderen Kreis verschlüsselt.');
    }
  }

  /* Wem die Datei gehört, entscheidet der Umschlag und nicht der Aufrufer.
     `privat` heißt "nur für dieses eine Konto" — das ist die Hülle `konto`.
     Eine Datei für den Kreis eines vertraulichen Kanals ist ebenso verschlossen,
     aber nicht privat: sie soll im Verzeichnis der Mitglieder stehen und von
     ihnen geöffnet werden können. Beides in ein Flag zu legen hieße, eine von
     beiden Gruppen falsch zu behandeln. */
  const privat = huelle?.art === 'konto';
  if (input.privat && !huelle) {
    throw abweisung('fehler.privatUnverschluesselt',
      'Diese Datei sollte privat sein, kam aber unverschlüsselt an. Bitte die App aktualisieren.');
  }

  const belegt = usage();
  if (belegt.used + input.size > belegt.quota) {
    throw abweisung('fehler.speicherVoll', 'Der Speicher ist voll. Bitte erst etwas löschen.');
  }
  const jetzt = Date.now();
  db.run(
    `INSERT INTO files (id, name, mime, size, path, folder, channel_id, description, uploaded_by, privat, huelle, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    /* Über den Typ einer verschlossenen Datei kann der Server nichts wissen —
       er hat Bytes ohne Bedeutung. Behielte er die Angabe des Formulars, gäbe
       er Chiffrat als "image/png" heraus, und der Browser zeigte es inline an:
       ein kaputtes Bild und eine Auskunft, die nicht stimmt. Der echte Typ
       steht verschlossen im Umschlag, wo er hingehört. */
    input.id, saubererName(input.name),
    huelle ? 'application/octet-stream' : input.mime,
    input.size, input.storedPath,
    normalisierterOrdner(input.folder ?? ''), channelId,
    input.description?.trim() || null, input.uploadedBy, privat ? 1 : 0,
    input.huelle ?? null, jetzt, jetzt,
  );

  /* Zur Übernahme in den Blockspeicher anmelden. Angemeldet, nicht
     abgewartet: die Zerlegung ist durchweg synchron und dauert je nach Inhalt
     Sekunden bis Minuten — auf dem Raspberry Pi gemessen 4 MB packbarer
     CSV-Abzug in 18 Sekunden, in denen die Ereignisschleife stand und weder
     eine Nachricht noch eine zweite Anfrage durchkam. Das gehört nicht in
     einen Anfrage-Ablauf, und schon gar nicht in einen, der auch noch das
     Kontingent im Blick behalten muss.

     Läuft nach dem Eintragen: die Datei ist sofort benutzbar, sie wird bis
     zum Ende der Zerlegung ganz von der Platte ausgeliefert, und scheitert
     die Übernahme, bleibt sie schlicht als ganze Datei liegen — niemand merkt
     etwas außer der Belegung.

     Solange die Übernahme aussteht, bleibt `stored_size` leer, und die
     Kontingentrechnung oben zählt die Zeile über `COALESCE(stored_size, size)`
     mit ihrer vollen Größe. Das ist richtig so: bis die Blöcke stehen, liegt
     die ganze Datei auf der Platte und kostet auch genau so viel.

     Verschlüsselte Dateien gehen daran vorbei, und das ist eine Entscheidung
     und kein Versehen: Privatsphäre vor Speicherplatz. Der Blockspeicher legt
     gleiche Bytes nur einmal ab — dieselbe Datei zweimal hochgeladen kostet
     nichts. Damit das bei verschlüsselten Dateien überhaupt greifen könnte,
     müsste ihr Schlüssel aus ihrem Inhalt entstehen. Dann aber verriete genau
     diese Ersparnis dem Server, was er verwahrt: er verschlüsselt eine
     verdächtige Datei selbst und sieht nach, ob ihre Blöcke schon da sind.
     Deshalb ist der Dateischlüssel Zufall (siehe lib/vertraulich.ts in der
     App), deshalb sieht dasselbe Dokument beim zweiten Mal völlig anders aus,
     und deshalb hätte ein Durchlauf hier nichts zu finden — außer Rechenzeit
     auf einem Pi.

     Am Umschlag entschieden und nicht an `privat`: eine Datei für den Kreis
     eines vertraulichen Kanals ist genauso Chiffrat wie eine private, und
     dasselbe Argument gilt für sie Wort für Wort. Es ist dieselbe Bedingung
     wie bei den Anhängen in routes.ts — dort steht `if (!umschlag)`. */
  if (!huelle) {
    ablage.spaeterUebernehmen({ id: input.id, art: 'file', pfad: input.storedPath, mime: input.mime });
  }

  return getFile(input.id)!;
}

export function updateFile(id: string, patch: { name?: string; description?: string | null; folder?: string }): StoredFile {
  const datei = getFile(id);
  if (!datei) throw abweisung('fehler.dateiNichtGefunden', 'Datei nicht gefunden.');

  const sets: string[] = [];
  const werte: any[] = [];
  if (patch.name !== undefined) {
    const name = saubererName(patch.name);
    if (!name) throw abweisung('fehler.nameLeer', 'Der Name darf nicht leer sein.');
    sets.push('name = ?'); werte.push(name);
  }
  if (patch.description !== undefined) { sets.push('description = ?'); werte.push(patch.description?.trim() || null); }
  if (patch.folder !== undefined) { sets.push('folder = ?'); werte.push(normalisierterOrdner(patch.folder)); }
  if (!sets.length) return datei;

  db.run(`UPDATE files SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...werte, Date.now(), id);
  return getFile(id)!;
}

export function deleteFile(id: string): void {
  const datei = getFile(id);
  if (!datei) return;
  // Zuerst die Blöcke freigeben, solange die Verweise noch stehen.
  ablage.loeschen(id, 'file');
  db.run('DELETE FROM files WHERE id = ?', id);
  // Erst der Eintrag, dann die Datei: bricht das Löschen ab, ist höchstens
  // eine verwaiste Datei übrig — nie ein Eintrag ohne Inhalt.
  fs.promises.rm(datei.path, { force: true }).catch(() => {});
}

/**
 * Alle Ordner, die es gibt — für die Navigation.
 *
 * Mit demselben Zugang wie `listFiles`: ein Ordnername ist ein kleiner
 * Auszug aus dem Verzeichnis, aber "Kündigungen 2026" ist einer, der genügt.
 * Wer nicht sagt, für wen er fragt, sieht nur die Ordner ohne Kanal.
 */
export function folders(channelId?: string | null, fuerUserId?: string): string[] {
  if (channelId) {
    if (!fuerUserId || !istMitglied(channelId, fuerUserId)) return [];
    return db.all<{ folder: string }>(
      'SELECT DISTINCT folder FROM files WHERE channel_id = ? ORDER BY folder', channelId,
    ).map((r) => r.folder).filter((f) => f !== '');
  }
  const rows = channelId === null || !fuerUserId
    ? db.all<{ folder: string }>('SELECT DISTINCT folder FROM files WHERE channel_id IS NULL ORDER BY folder')
    : db.all<{ folder: string }>(
        `SELECT DISTINCT folder FROM files
          WHERE channel_id IS NULL
             OR channel_id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
          ORDER BY folder`, fuerUserId,
      );
  return rows.map((r) => r.folder).filter((f) => f !== '');
}

function saubererName(name: string): string {
  return path.basename(name).replace(/[^\p{L}\p{N}._ ()-]/gu, '_').slice(0, 160).trim();
}

/** "  Berichte / 2026 " -> "Berichte/2026" */
function normalisierterOrdner(ordner: string): string {
  return ordner
    .split('/')
    .map((teil) => teil.trim().replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 60))
    .filter(Boolean)
    .slice(0, 4)
    .join('/');
}

export const uploadDir = config.uploadDir;
