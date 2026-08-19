/**
 * Die Brücke zwischen einer hochgeladenen Datei und dem Blockspeicher.
 *
 * Hier steht an einer Stelle, was beim Ablegen, Ausliefern und Löschen zu tun
 * ist — die Aufrufer in den Routen sollen davon nichts wissen müssen. Wichtig
 * ist die Reihenfolge: erst die Blöcke schreiben, dann die Verweise in die
 * Datenbank, dann die Gegenprobe, und erst danach die Ausgangsdatei entfernen.
 * Bricht etwas dazwischen ab, liegt die Datei noch da und nichts ist verloren.
 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { db } from '../db/index.js';
import {
  ablegen, zusammensetzen, freigeben, verweiseNachrechnen, pruefsummeAus,
} from './bloecke.js';

export type Art = 'file' | 'attachment';

/** Zu welcher Tabelle eine Art gehört. */
function tabelleVon(art: Art): 'files' | 'attachments' {
  return art === 'file' ? 'files' : 'attachments';
}

/**
 * Zeigt außer dieser Zeile noch jemand auf dieselbe Datei auf der Platte?
 *
 * Wird dieselbe Datei ein zweites Mal geschickt, legt der Server keinen zweiten
 * Inhalt an, sondern eine zweite Zeile auf denselben Pfad. Wer diese Datei
 * löscht, ohne nachzusehen, nimmt der anderen Zeile den Inhalt weg — sie
 * verweist dann ins Leere. Zeilen, die selbst schon im Blockspeicher liegen,
 * zählen nicht mit: die brauchen die Datei nicht mehr.
 */
function nochJemandBraucht(pfad: string, art: Art, id: string): boolean {
  const offen = (tabelle: 'files' | 'attachments', ausser: string | null) => db.get<{ n: number }>(
    `SELECT COUNT(*) n FROM ${tabelle}
      WHERE path = ? AND (encoding IS NULL OR encoding <> 'bloecke')
        AND (? IS NULL OR id <> ?)`,
    pfad, ausser, ausser,
  )?.n ?? 0;

  const eigene = tabelleVon(art);
  const fremde = eigene === 'files' ? 'attachments' : 'files';
  return offen(eigene, id) + offen(fremde, null) > 0;
}

/**
 * Eine fertig hochgeladene Datei in den Blockspeicher übernehmen.
 *
 * Gibt zurück, was sie dort belegt. Geht dabei etwas schief, bleibt die Datei
 * unverändert liegen und der Aufrufer erfährt es am `null`.
 */
export function uebernehmen(input: {
  id: string; art: Art; pfad: string; mime: string;
}): { belegt: number; bloecke: number } | null {
  /* Der Stand vor dem Eingriff — damit eine gescheiterte Übernahme genau ihn
     wiederherstellen kann. Die Blockliste gehört dazu: es gibt sie, wenn ein
     Lauf abgebrochen ist und wiederholt wird, und ohne sie blieben ihre Blöcke
     für immer liegen. Die Zeilen dazu werden gleich überschrieben, und danach
     weiß niemand mehr, worauf sie zeigten. */
  const vorher = blockListe(input.id, input.art);
  const alterStand = db.get<{ encoding: string | null; stored_size: number | null }>(
    `SELECT encoding, stored_size FROM ${tabelleVon(input.art)} WHERE id = ?`, input.id,
  ) ?? { encoding: null, stored_size: null };

  /* Bei der Gelegenheit nachsehen, ob anderswo etwas hängengeblieben ist —
     der Grund steht bei verwaisteAufraeumen(). Ein Fehler beim Aufräumen darf
     einen Upload niemals zu Fall bringen; deshalb eingepackt. */
  try { verwaisteAufraeumen(); } catch (fehler) {
    console.error('[ablage] Aufräumen übersprungen:', (fehler as Error).message);
  }

  try {
    const { bloecke, pruefsumme, groesse, neuBelegt, gespart } = ablegen(input.pfad, input.mime);
    if (!bloecke.length) return null;

    db.transaction(() => {
      db.run('DELETE FROM datei_bloecke WHERE art = ? AND datei_id = ?', input.art, input.id);
      bloecke.forEach((summe, nummer) => {
        db.run(
          'INSERT INTO datei_bloecke (datei_id, art, nummer, summe) VALUES (?,?,?,?)',
          input.id, input.art, nummer, summe,
        );
      });
      db.run(
        `UPDATE ${tabelleVon(input.art)} SET encoding = 'bloecke', stored_size = ? WHERE id = ?`,
        neuBelegt, input.id,
      );
    });

    // Jetzt zeigen die Zeilen auf die neuen Blöcke — die Zähler dürfen es auch.
    verweiseNachrechnen(bloecke);
    if (vorher.length) freigeben(vorher);

    /* Die Gegenprobe, und zwar über den Weg, den auch das Herunterladen nimmt:
       die Blockliste kommt aus der Datenbank, nicht aus der Zerlegung. Damit
       ist nicht nur bewiesen, dass die Blöcke heil sind, sondern auch, dass sie
       in der richtigen Reihenfolge und vollzählig eingetragen wurden. Sie
       kostet einmal Lesen — verglichen mit einer Datei, die niemand mehr
       herstellen kann, ist das nichts. */
    const zurueck = pruefsummeAus(blockListe(input.id, input.art));
    if (zurueck.pruefsumme !== pruefsumme || zurueck.groesse !== groesse) {
      throw new Error(
        `Aus den Blöcken entsteht nicht dieselbe Datei (${zurueck.groesse} statt ${groesse} Byte)`,
      );
    }

    /* Erst jetzt — die Blöcke stehen, die Verweise auch, und der Rückweg ist
       nachgewiesen. Teilt sich die Datei den Platz mit einer zweiten Zeile, die
       noch nicht umgezogen ist, bleibt sie liegen. */
    if (nochJemandBraucht(input.pfad, input.art, input.id)) {
      console.log(`[ablage] ${input.id}: Datei bleibt liegen, eine andere Zeile zeigt noch darauf.`);
    } else {
      fs.rmSync(input.pfad, { force: true });
    }

    if (gespart > 0) {
      console.log(`[ablage] ${input.id}: ${(gespart / 1048576).toFixed(1)} MB waren schon da.`);
    }
    return { belegt: neuBelegt, bloecke: bloecke.length };
  } catch (fehler) {
    console.error('[ablage] Übernahme in den Blockspeicher gescheitert:', (fehler as Error).message);
    zuruecknehmen(input, vorher, alterStand);
    return null;
  }
}

/**
 * Eine gescheiterte Übernahme rückgängig machen.
 *
 * Die Datei liegt in diesem Fall noch auf der Platte — gelöscht wird sie erst
 * ganz am Ende. Zurückzunehmen sind also nur die Einträge, und zwar so, dass
 * halb geschriebene Blöcke nicht als Bestand stehenbleiben.
 */
function zuruecknehmen(
  input: { id: string; art: Art },
  vorher: string[],
  alterStand: { encoding: string | null; stored_size: number | null },
): void {
  try {
    const angelegt = blockListe(input.id, input.art);
    db.transaction(() => {
      db.run('DELETE FROM datei_bloecke WHERE art = ? AND datei_id = ?', input.art, input.id);
      vorher.forEach((summe, nummer) => {
        db.run(
          'INSERT INTO datei_bloecke (datei_id, art, nummer, summe) VALUES (?,?,?,?)',
          input.id, input.art, nummer, summe,
        );
      });
      db.run(
        `UPDATE ${tabelleVon(input.art)} SET encoding = ?, stored_size = ? WHERE id = ?`,
        alterStand.encoding, alterStand.stored_size, input.id,
      );
    });
    /* Nur wegräumen, was dieser Versuch neu angelegt hat: was schon vorher zu
       dieser Datei gehörte, steht gerade wieder in den Zeilen und überlebt die
       Prüfung auf Verweise von selbst. */
    freigeben(angelegt);
    verweiseNachrechnen(vorher);
  } catch (fehler) {
    console.error('[ablage] Rücknahme gescheitert:', (fehler as Error).message);
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
  if (bloecke.length) {
    db.run('DELETE FROM datei_bloecke WHERE art = ? AND datei_id = ?', art, id);
    freigeben(bloecke);
  }
  /* Bei der Gelegenheit gleich nachsehen, ob anderswo etwas hängengeblieben
     ist. Der Grund steht bei verwaisteAufraeumen(). */
  verwaisteAufraeumen();
}

/**
 * Blöcke einsammeln, deren Datei ohne unser Zutun verschwunden ist.
 *
 * Nicht jede Datei geht den Weg über loeschen(). Wird ein Kanal gelöscht,
 * räumt die Datenbank selbst ab: die Nachrichten hängen am Kanal, die Anhänge
 * an den Nachrichten, die Dateien wieder am Kanal — alles über ON DELETE
 * CASCADE. Kein Aufruf landet dabei hier, und bis eben blieben die Blöcke
 * dieser Dateien für immer liegen, samt Verweisen, die auf nichts mehr zeigen.
 *
 * Statt jeden dieser Wege einzeln nachzurüsten — jeder künftige käme wieder
 * dazu — wird nachgesehen: gibt es Zeilen in `datei_bloecke`, deren Datei es
 * nicht mehr gibt? Das ist unabhängig davon, wie sie verschwunden ist, und
 * heilt auch, was schon liegengeblieben war. Der Lauf hängt an den beiden
 * Stellen, an denen sich am Bestand etwas ändert, und ist im Normalfall zwei
 * Abfragen ohne Treffer.
 */
export function verwaisteAufraeumen(): { dateien: number; bloecke: number; befreit: number } {
  const verwaist = db.all<{ art: Art; datei_id: string }>(
    `SELECT DISTINCT art, datei_id FROM datei_bloecke
      WHERE (art = 'file'       AND datei_id NOT IN (SELECT id FROM files))
         OR (art = 'attachment' AND datei_id NOT IN (SELECT id FROM attachments))`,
  );
  if (!verwaist.length) return { dateien: 0, bloecke: 0, befreit: 0 };

  let bloecke = 0;
  let befreit = 0;
  for (const { art, datei_id: id } of verwaist) {
    const liste = blockListe(id, art);
    db.run('DELETE FROM datei_bloecke WHERE art = ? AND datei_id = ?', art, id);
    const weg = freigeben(liste);
    bloecke += weg.geloescht;
    befreit += weg.befreit;
  }
  console.log(
    `[ablage] ${verwaist.length} verwaiste Datei(en) aufgeräumt, `
    + `${bloecke} Blöcke frei (${(befreit / 1048576).toFixed(1)} MB).`,
  );
  return { dateien: verwaist.length, bloecke, befreit };
}
