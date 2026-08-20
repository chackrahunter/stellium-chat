import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReleaseInfo, ReleasePlatform } from '@stellium/shared';
import { db } from '../db/index.js';
import { config } from '../config.js';

/**
 * Verteilung neuer App-Versionen.
 *
 * Die Verwaltung lädt je Plattform eine Datei hoch; die Clients fragen beim
 * Start und danach stündlich nach. Bewusst über den eigenen Server statt über
 * einen öffentlichen Update-Dienst: die Firma soll selbst bestimmen, wann
 * welche Version läuft, und nichts nach außen melden müssen.
 *
 * Die Prüfsumme wird beim Hochladen berechnet und mitgeliefert. Wer eine Datei
 * lädt, kann damit feststellen, ob sie unterwegs verändert wurde.
 */

export const PLATTFORMEN: ReleasePlatform[] = ['darwin', 'win32', 'linux', 'server'];

function toRelease(r: any): ReleaseInfo {
  return {
    platform: r.platform,
    version: r.version,
    notes: r.notes ?? null,
    size: r.size,
    sha256: r.sha256,
    fileName: r.file_name,
    url: `/releases/${r.platform}/download`,
    publishedBy: r.published_by,
    publishedAt: r.published_at,
  };
}

export function listReleases(): ReleaseInfo[] {
  return db.all<any>('SELECT * FROM releases ORDER BY platform').map(toRelease);
}

export function getRelease(platform: string): (ReleaseInfo & { path: string }) | null {
  const r = db.get<any>('SELECT * FROM releases WHERE platform = ?', platform);
  return r ? { ...toRelease(r), path: r.path } : null;
}

/**
 * Vergleicht zwei Versionen nach dem Muster 1.2.3. Unbekanntes zählt als 0,
 * damit ein Tippfehler in der Version kein Update auslöst, das zurückgeht.
 */
export function istNeuer(neu: string, alt: string): boolean {
  const zerlegen = (v: string) => v.split(/[.\-+]/).map((t) => Number.parseInt(t, 10) || 0);
  const a = zerlegen(neu);
  const b = zerlegen(alt);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Wie lang die Änderungsliste einer Fassung höchstens wird. */
const ANMERKUNGEN_MAX = 20_000;

/**
 * Prüfsumme und Größe einer Datei, ohne sie in den Speicher zu holen.
 *
 * Hier stand `fs.readFileSync(tempPath)`. Für ein App-Paket sind das die
 * hundertfünfzig bis sechshundert Megabyte, die die Route durchlässt — auf
 * einem Raspberry Pi mit einem Gigabyte ist das kein Ausschlag im Diagramm,
 * sondern der Tod des Prozesses, und zwar genau in dem Augenblick, in dem
 * jemand ein Update verteilen will. Gemessen am Probeserver: der belegte
 * Speicher wuchs bei einer Datei von 160 MB um 178 MB.
 *
 * Bewusst mit readSync und nicht mit einem Strom: publish() ist synchron, und
 * das soll es bleiben — die Route ruft es zwischen zwei Dateioperationen auf,
 * deren Reihenfolge über die Wiederherstellbarkeit entscheidet.
 */
function summeUndGroesse(datei: string): { sha256: string; groesse: number } {
  const hash = createHash('sha256');
  const puffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(datei, 'r');
  let groesse = 0;
  try {
    for (;;) {
      const gelesen = fs.readSync(fd, puffer, 0, puffer.length, null);
      if (!gelesen) break;
      hash.update(puffer.subarray(0, gelesen));
      groesse += gelesen;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), groesse };
}

export function publish(input: {
  platform: ReleasePlatform; version: string; notes?: string | null;
  fileName: string; tempPath: string; publishedBy: string;
}): ReleaseInfo {
  if (!PLATTFORMEN.includes(input.platform)) throw new Error('Unbekannte Plattform.');
  if (!/^\d+\.\d+\.\d+/.test(input.version)) {
    throw new Error('Die Version muss dem Muster 1.2.3 folgen.');
  }

  const ziel = path.join(config.releaseDir, `${input.platform}-${path.basename(input.fileName)}`);
  const { sha256, groesse } = summeUndGroesse(input.tempPath);

  // Erst die neue Datei ablegen, dann die Datenbank umschreiben und ganz zum
  // Schluss die alte Datei entfernen — bricht etwas dazwischen ab, zeigt die
  // Datenbank immer noch auf eine Datei, die es wirklich gibt. (Trägt die neue
  // Datei denselben Namen wie die alte, wie beim Serverpaket, ersetzt das
  // Umbenennen den Inhalt schon hier; dagegen hilft erst ein Zwischenname.)
  fs.renameSync(input.tempPath, ziel);
  // Der bisherige Eintrag muss vor dem Schreiben gelesen werden, danach stünde
  // hier schon die neue Zeile und der alte Pfad wäre verloren.
  const vorher = getRelease(input.platform);

  db.run(
    `INSERT INTO releases (platform, version, notes, file_name, path, size, sha256, published_by, published_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(platform) DO UPDATE SET
       version = excluded.version, notes = excluded.notes, file_name = excluded.file_name,
       path = excluded.path, size = excluded.size, sha256 = excluded.sha256,
       published_by = excluded.published_by, published_at = excluded.published_at`,
    input.platform, input.version, input.notes?.trim().slice(0, ANMERKUNGEN_MAX) || null,
    path.basename(input.fileName), ziel, groesse, sha256,
    input.publishedBy, Date.now(),
  );

  if (vorher && vorher.path !== ziel && fs.existsSync(vorher.path)) {
    // Nach dem Schreiben darf nichts mehr scheitern: die Veröffentlichung ist
    // gültig. Bleibt die alte Datei liegen, kostet das nur Platz.
    try { fs.rmSync(vorher.path, { force: true }); } catch { /* egal */ }
  }
  return getRelease(input.platform)!;
}

export function removeRelease(platform: string): void {
  const vorhanden = getRelease(platform);
  if (vorhanden && fs.existsSync(vorhanden.path)) fs.rmSync(vorhanden.path, { force: true });
  db.run('DELETE FROM releases WHERE platform = ?', platform);
}
