/**
 * Die Brücke zwischen einer hochgeladenen Datei und dem Blockspeicher.
 *
 * Hier steht an einer Stelle, was beim Ablegen, Ausliefern und Löschen zu tun
 * ist — die Aufrufer in den Routen sollen davon nichts wissen müssen. Wichtig
 * ist die Reihenfolge: erst die Blöcke schreiben, dann die Verweise in die
 * Datenbank, und erst danach die Ausgangsdatei entfernen. Bricht etwas
 * dazwischen ab, liegt die Datei noch da und nichts ist verloren.
 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { db } from '../db/index.js';
import { ablegen, zusammensetzen, freigeben } from './bloecke.js';

export type Art = 'file' | 'attachment';

/**
 * Eine fertig hochgeladene Datei in den Blockspeicher übernehmen.
 *
 * Gibt zurück, was sie dort belegt. Geht dabei etwas schief, bleibt die Datei
 * unverändert liegen und der Aufrufer erfährt es am `null`.
 */
export function uebernehmen(input: {
  id: string; art: Art; pfad: string; mime: string;
}): { belegt: number; bloecke: number } | null {
  try {
    const { bloecke, neuBelegt, gespart } = ablegen(input.pfad, input.mime);
    if (!bloecke.length) return null;

    db.transaction(() => {
      db.run('DELETE FROM datei_bloecke WHERE art = ? AND datei_id = ?', input.art, input.id);
      bloecke.forEach((summe, nummer) => {
        db.run(
          'INSERT INTO datei_bloecke (datei_id, art, nummer, summe) VALUES (?,?,?,?)',
          input.id, input.art, nummer, summe,
        );
      });
      const tabelle = input.art === 'file' ? 'files' : 'attachments';
      db.run(
        `UPDATE ${tabelle} SET encoding = 'bloecke', stored_size = ? WHERE id = ?`,
        neuBelegt, input.id,
      );
    });

    // Erst jetzt — die Blöcke stehen, die Verweise auch.
    fs.rmSync(input.pfad, { force: true });
    if (gespart > 0) {
      console.log(`[ablage] ${input.id}: ${(gespart / 1048576).toFixed(1)} MB waren schon da.`);
    }
    return { belegt: neuBelegt, bloecke: bloecke.length };
  } catch (fehler) {
    console.error('[ablage] Übernahme in den Blockspeicher gescheitert:', (fehler as Error).message);
    return null;
  }
}

/** Die Blockliste einer Datei, in der richtigen Reihenfolge. */
export function blockListe(id: string, art: Art): string[] {
  return db.all<{ summe: string }>(
    'SELECT summe FROM datei_bloecke WHERE art = ? AND datei_id = ? ORDER BY nummer',
    art, id,
  ).map((r) => r.summe);
}

/**
 * Eine Datei zum Ausliefern öffnen — gleich, wie sie abgelegt ist.
 *
 * Liegt sie im Blockspeicher, wird sie beim Lesen wieder zusammengesetzt und
 * dabei geprüft: passt ein Block nicht mehr zu seinem Fingerabdruck, bricht
 * die Auslieferung ab. Stille Falschdaten wären das Schlimmste, was ein
 * Dateispeicher tun kann.
 */
export function oeffnen(input: {
  id: string; art: Art; pfad: string | null; encoding: string | null;
}): NodeJS.ReadableStream | null {
  if (input.encoding !== 'bloecke') {
    if (!input.pfad || !fs.existsSync(input.pfad)) return null;
    return fs.createReadStream(input.pfad);
  }

  const bloecke = blockListe(input.id, input.art);
  if (!bloecke.length) return null;

  // Geprüft wird im Blockspeicher selbst — dort liegt der ganze Block vor.
  return Readable.from(zusammensetzen(bloecke));
}

/** Beim Löschen einer Datei die Blöcke freigeben. */
export function loeschen(id: string, art: Art): void {
  const bloecke = blockListe(id, art);
  if (!bloecke.length) return;
  db.run('DELETE FROM datei_bloecke WHERE art = ? AND datei_id = ?', art, id);
  freigeben(bloecke);
}
