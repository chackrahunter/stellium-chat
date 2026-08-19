import fs from 'node:fs';
import path from 'node:path';
import type { StorageUsage, StoredFile } from '@stellium/shared';
import { db } from '../db/index.js';
import { config } from '../config.js';
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
    folder: r.folder ?? '',
    channelId: r.channel_id ?? null,
    description: r.description ?? null,
    uploadedBy: r.uploaded_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: `/storage/${r.id}`,
  };
}

export function listFiles(filter: { channelId?: string | null; folder?: string } = {}): StoredFile[] {
  const bedingungen: string[] = [];
  const werte: any[] = [];
  if (filter.channelId === null) bedingungen.push('channel_id IS NULL');
  else if (filter.channelId) { bedingungen.push('channel_id = ?'); werte.push(filter.channelId); }
  if (filter.folder !== undefined) { bedingungen.push('folder = ?'); werte.push(filter.folder); }

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
}): StoredFile {
  const belegt = usage();
  if (belegt.used + input.size > belegt.quota) {
    throw new Error('Der Speicher ist voll. Bitte erst etwas löschen.');
  }
  const jetzt = Date.now();
  db.run(
    `INSERT INTO files (id, name, mime, size, path, folder, channel_id, description, uploaded_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    input.id, saubererName(input.name), input.mime, input.size, input.storedPath,
    normalisierterOrdner(input.folder ?? ''), input.channelId ?? null,
    input.description?.trim() || null, input.uploadedBy, jetzt, jetzt,
  );

  /* In den Blockspeicher übernehmen. Läuft nach dem Eintragen: die Datei ist
     sofort benutzbar, und scheitert die Übernahme, bleibt sie schlicht als
     ganze Datei liegen — niemand merkt etwas außer der Belegung. */
  ablage.uebernehmen({ id: input.id, art: 'file', pfad: input.storedPath, mime: input.mime });

  return getFile(input.id)!;
}

export function updateFile(id: string, patch: { name?: string; description?: string | null; folder?: string }): StoredFile {
  const datei = getFile(id);
  if (!datei) throw new Error('Datei nicht gefunden.');

  const sets: string[] = [];
  const werte: any[] = [];
  if (patch.name !== undefined) {
    const name = saubererName(patch.name);
    if (!name) throw new Error('Der Name darf nicht leer sein.');
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

/** Alle Ordner, die es gibt — für die Navigation. */
export function folders(channelId?: string | null): string[] {
  const rows = channelId === undefined
    ? db.all<{ folder: string }>('SELECT DISTINCT folder FROM files ORDER BY folder')
    : channelId === null
      ? db.all<{ folder: string }>('SELECT DISTINCT folder FROM files WHERE channel_id IS NULL ORDER BY folder')
      : db.all<{ folder: string }>('SELECT DISTINCT folder FROM files WHERE channel_id = ? ORDER BY folder', channelId);
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
