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
import path from 'node:path';
import { Readable } from 'node:stream';
import { db } from '../db/index.js';
import { config } from '../config.js';
import {
  ablegenSchritte, zusammensetzen, freigeben, verweiseNachrechnen, pruefsummeAus,
} from './bloecke.js';

export type Art = 'file' | 'attachment';

/**
 * Der Zwischenstand: die Zeile steht, die Datei liegt ganz da, die Zerlegung
 * läuft noch oder soll noch laufen.
 *
 * Für alles außerhalb dieser Datei ist das dasselbe wie „liegt als ganze
 * Datei da": ausgeliefert wird über den Pfad, das Kontingent rechnet mit der
 * vollen Größe, und wer die Datei aufräumen will, muss sie mitnehmen. Nur
 * der Aufräumlauf beim Start erkennt daran, was ein Absturz liegengelassen
 * hat.
 */
export const UEBERNAHME_OFFEN = 'uebernahme';

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
 * Zeigt überhaupt noch eine Zeile auf diese Datei auf der Platte?
 *
 * Dieselbe Frage wie oben, nur ohne eine Zeile auszunehmen — für den Fall,
 * dass die eigene Zeile bereits verschwunden ist und deshalb niemand mehr
 * sagen kann, wem die Datei gehörte. Zeilen im Blockspeicher zählen auch hier
 * nicht mit: die brauchen die ganze Datei nicht mehr.
 */
function nochGebraucht(pfad: string): boolean {
  for (const tabelle of ['files', 'attachments'] as const) {
    const n = db.get<{ n: number }>(
      `SELECT COUNT(*) n FROM ${tabelle}
        WHERE path = ? AND (encoding IS NULL OR encoding <> 'bloecke')`,
      pfad,
    )?.n ?? 0;
    if (n > 0) return true;
  }
  return false;
}

/** Was eine Übernahme im Blockspeicher belegt hat. */
export interface Uebernommen { belegt: number; bloecke: number }

/**
 * Eine fertig hochgeladene Datei in den Blockspeicher übernehmen — in
 * Schritten, damit ein Aufrufer im Hintergrund zwischendurch Luft lassen kann.
 *
 * Gibt zurück, was sie dort belegt. Geht dabei etwas schief, bleibt die Datei
 * unverändert liegen und der Aufrufer erfährt es am `null`.
 *
 * Unterbrochen wird ausschließlich beim Zerlegen. Alles danach — Verweise
 * eintragen, Gegenprobe, Ausgangsdatei entfernen — läuft an einem Stück:
 * dazwischen darf niemand eine zweite Zeile auf dieselbe Datei legen, sonst
 * verlöre die ihren Inhalt, während wir noch prüfen.
 */
function* uebernehmenSchritte(input: {
  id: string; art: Art; pfad: string; mime: string;
}): Generator<void, Uebernommen | null> {
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
    const {
      bloecke, pruefsumme, groesse, neuBelegt, gespart,
    } = yield* ablegenSchritte(input.pfad, input.mime);
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
 * Eine fertig hochgeladene Datei in den Blockspeicher übernehmen, an einem
 * Stück. Der Aufrufer wartet, bis es fertig ist.
 */
export function uebernehmen(input: {
  id: string; art: Art; pfad: string; mime: string;
}): Uebernommen | null {
  const lauf = uebernehmenSchritte(input);
  for (;;) {
    const schritt = lauf.next();
    if (schritt.done) return schritt.value;
  }
}

/** Dem Server zwischen zwei Blöcken die Gelegenheit geben, seine Arbeit zu tun. */
const atempause = (): Promise<void> => new Promise((weiter) => { setImmediate(weiter); });

/**
 * Dasselbe, aber mit Luft dazwischen — für den Hintergrund.
 *
 * Die Pause steht **vor** dem Schritt und nicht danach. Das sieht nach einer
 * Kleinigkeit aus, ist aber der Unterschied zwischen „kehrt sofort zurück"
 * und „kehrt nach dem ersten Block zurück": eine `async`-Funktion läuft bis
 * zum ersten `await` im Stapel ihres Aufrufers, und der erste `next()` packt
 * bereits einen ganzen Block. Stand die Pause dahinter, hing damit jede
 * Anmeldung am ersten Block — auf dem Raspberry Pi bei einem vollen Block von
 * vier Megabyte gemessene 20 Sekunden mitten in der Antwort.
 */
async function uebernehmenMitLuft(input: {
  id: string; art: Art; pfad: string; mime: string;
}): Promise<Uebernommen | null> {
  const lauf = uebernehmenSchritte(input);
  for (;;) {
    await atempause();
    const schritt = lauf.next();
    if (schritt.done) return schritt.value;
  }
}

/* ── Übernahme im Hintergrund ─────────────────────────────────── */

/**
 * Warum große Dateien nicht im Ablauf übernommen werden.
 *
 * Eine kleine Datei ist zerlegt, bevor die Antwort geschrieben ist — dort
 * lohnt kein Zwischenstand. Beim Weg in Teilen kommen aber gerade die großen
 * an, und wie lange ihre Zerlegung dauert, hängt am Inhalt: gemessen 30 MB
 * Rauschen in 0,3 Sekunden, 8 MB packbarer Text in eineinhalb Minuten. Diese
 * Spanne in eine Antwort zu legen hieße, den Client auf gut Glück warten zu
 * lassen — bei ungünstigem Inhalt so lange, dass er den Upload für
 * gescheitert hält, obwohl längst alles da ist.
 *
 * Deshalb: Zeile eintragen, `uebernahme` vermerken, antworten, und den Rest
 * danach. Bis die Zerlegung durch ist, wird die Datei ganz normal von der
 * Platte ausgeliefert — niemand merkt, dass noch etwas läuft.
 */
const warteschlange: Array<{ id: string; art: Art; pfad: string; mime: string }> = [];
let laeuft = false;

/**
 * Eine Datei zur Übernahme anmelden und sofort zurückkehren.
 *
 * Der Vermerk in der Zeile ist der wichtige Teil: an ihm erkennt der Start
 * nach einem Absturz, was noch offen ist. Er muss deshalb stehen, **bevor**
 * irgendetwas passiert.
 */
export function spaeterUebernehmen(input: {
  id: string; art: Art; pfad: string; mime: string;
}): void {
  db.run(
    `UPDATE ${tabelleVon(input.art)} SET encoding = ? WHERE id = ? AND encoding IS NULL`,
    UEBERNAHME_OFFEN, input.id,
  );
  warteschlange.push(input);
  void abarbeiten();
}

/**
 * Die Warteschlange abarbeiten — eine Datei nach der anderen.
 *
 * Nacheinander und nicht nebeneinander: zwei Zerlegungen gleichzeitig wären
 * auf einem Raspberry Pi nicht schneller, sondern nur beide langsam, und sie
 * kämen sich beim Schreiben derselben Blöcke ins Gehege.
 */
async function abarbeiten(): Promise<void> {
  if (laeuft) return;
  laeuft = true;
  try {
    for (let auftrag = warteschlange.shift(); auftrag; auftrag = warteschlange.shift()) {
      try {
        await einenUebernehmen(auftrag);
      } catch (fehler) {
        console.error('[ablage] Übernahme im Hintergrund gescheitert:', (fehler as Error).message);
        vermerkLoeschen(auftrag.id, auftrag.art);
      }
    }
  } finally {
    laeuft = false;
  }
}

async function einenUebernehmen(auftrag: {
  id: string; art: Art; pfad: string; mime: string;
}): Promise<void> {
  /* Zwischen Anmelden und Drankommen kann viel passieren: die Nachricht wurde
     zurückgezogen, der Kanal gelöscht, die Datei weggeräumt. Dann ist hier
     nichts mehr zu tun — und die Zerlegung würde Blöcke für eine Zeile
     schreiben, die es nicht mehr gibt. */
  const zeile = db.get<{ encoding: string | null }>(
    `SELECT encoding FROM ${tabelleVon(auftrag.art)} WHERE id = ?`, auftrag.id,
  );
  if (!zeile || zeile.encoding !== UEBERNAHME_OFFEN) return;
  if (!fs.existsSync(auftrag.pfad)) {
    vermerkLoeschen(auftrag.id, auftrag.art);
    return;
  }

  const begonnen = Date.now();
  const ergebnis = await uebernehmenMitLuft(auftrag);
  if (!ergebnis) {
    /* Gescheitert heißt: die Datei liegt unverändert da und wird ganz
       ausgeliefert wie eh und je. Nur der Vermerk muss weg, sonst hielte der
       nächste Start sie für unterbrochen und versuchte es endlos weiter. */
    vermerkLoeschen(auftrag.id, auftrag.art);
    return;
  }
  console.log(
    `[ablage] ${auftrag.id}: in ${ergebnis.bloecke} Blöcke zerlegt `
    + `(${(ergebnis.belegt / 1048576).toFixed(1)} MB neu, ${((Date.now() - begonnen) / 1000).toFixed(1)} s).`,
  );
}

function vermerkLoeschen(id: string, art: Art): void {
  db.run(
    `UPDATE ${tabelleVon(art)} SET encoding = NULL WHERE id = ? AND encoding = ?`,
    id, UEBERNAHME_OFFEN,
  );
}

/**
 * Nach dem Start nachsehen, was eine unterbrochene Übernahme hinterlassen hat.
 *
 * Ein Absturz mitten in der Zerlegung ist der Fall, für den der Zwischenstand
 * überhaupt existiert. Was dann dasteht, ist unvollständig, aber nicht kaputt:
 * die Zeile trägt `uebernahme`, die ganze Datei liegt noch da — sie wird also
 * weiter ausgeliefert —, und in `datei_bloecke` steht nichts, weil diese
 * Zeilen erst ganz am Ende und in einem Zug entstehen. Liegengeblieben sind
 * höchstens ein paar fertige Blöcke ohne Zeile.
 *
 * Deshalb wird nicht aufgeräumt, sondern noch einmal angefangen: derselbe
 * Inhalt ergibt dieselben Blöcke, die schon vorhandenen werden wiedererkannt
 * statt neu geschrieben, und am Ende stimmen die Verweise wieder mit den
 * Zeilen überein. Der zweite Anlauf heilt damit genau das, was der erste
 * liegengelassen hat.
 */
export function offeneUebernahmenFortsetzen(): number {
  let angemeldet = 0;
  for (const art of ['file', 'attachment'] as const) {
    const offen = db.all<{ id: string; path: string; mime: string }>(
      `SELECT id, path, mime FROM ${tabelleVon(art)} WHERE encoding = ?`, UEBERNAHME_OFFEN,
    );
    for (const zeile of offen) {
      spaeterUebernehmen({ id: zeile.id, art, pfad: zeile.path, mime: zeile.mime });
      angemeldet += 1;
    }
  }
  if (angemeldet) {
    console.log(`[ablage] ${angemeldet} unterbrochene Übernahme(n) werden fortgesetzt.`);
  }
  return angemeldet;
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
 * Eine zweite Zeile auf dieselben Blöcke zeigen lassen.
 *
 * Wird dieselbe Datei ein zweites Mal gebraucht, entsteht kein zweiter Inhalt,
 * sondern eine zweite Blockliste auf dieselben Blöcke. Für eine Datei, die noch
 * als Ganzes auf der Platte liegt, tat das bisher schon der geteilte Pfad — für
 * eine Datei im Blockspeicher gibt es diesen Pfad aber nicht mehr, und ohne
 * diesen Weg bliebe nur, sie noch einmal zu übertragen.
 *
 * Die Blöcke selbst werden dabei nicht angefasst: es kommen nur Zeilen in
 * `datei_bloecke` dazu, und die Zähler werden anschließend aus genau diesen
 * Zeilen neu bestimmt. Damit hält der Verweiszähler die zweite Zeile am Leben,
 * auch wenn die erste später gelöscht wird.
 *
 * Der Aufrufer muss die Zeile in `files`/`attachments` **vorher** angelegt
 * haben. Andernfalls sähe der Aufräumlauf Blockverweise ohne Datei und würde
 * sie im selben Atemzug wieder einsammeln.
 *
 * Gibt zurück, wie viele Blöcke übernommen wurden — 0 heißt: die Vorlage liegt
 * gar nicht im Blockspeicher, der Aufrufer muss sich anders behelfen.
 */
export function bloeckeTeilen(
  vorlage: { id: string; art: Art },
  neu: { id: string; art: Art },
): number {
  const liste = blockListe(vorlage.id, vorlage.art);
  if (!liste.length) return 0;

  db.transaction(() => {
    db.run('DELETE FROM datei_bloecke WHERE art = ? AND datei_id = ?', neu.art, neu.id);
    liste.forEach((summe, nummer) => {
      db.run(
        'INSERT INTO datei_bloecke (datei_id, art, nummer, summe) VALUES (?,?,?,?)',
        neu.id, neu.art, nummer, summe,
      );
    });
  });

  verweiseNachrechnen(liste);
  return liste.length;
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

/**
 * Liegt dieser Pfad in einem Ordner, aus dem wir löschen dürfen?
 *
 * Die Pfade kommen aus der Datenbank und sollten immer in `uploads` oder
 * `storage` zeigen. "Sollten" ist beim Löschen zu wenig: eine Zeile mit einem
 * abwegigen Pfad — aus einer alten Fassung, aus einer Wiederherstellung von
 * Hand — würde sonst irgendwo im System eine Datei mitnehmen. Deshalb muss der
 * Pfad unmittelbar in einem der beiden Ordner liegen; Unterordner sind
 * ausgeschlossen, weil dort der Blockspeicher wohnt.
 */
function darfWeg(pfad: string): boolean {
  const voll = path.resolve(pfad);
  return [config.uploadDir, config.storageDir]
    .some((ordner) => path.dirname(voll) === path.resolve(ordner));
}

/**
 * Ganze Dateien wegräumen, auf die keine Zeile mehr zeigt.
 *
 * Gedacht für Löschwege, bei denen die Datenbank die Zeilen selbst abräumt und
 * deshalb niemand `loeschen()` aufruft — beim Löschen eines Kanals fallen
 * Nachrichten, Anhänge und Dateien über ON DELETE CASCADE weg. Die Blöcke
 * sammelt `verwaisteAufraeumen()` danach ein; eine Datei, die es nicht in den
 * Blockspeicher geschafft hat, blieb dagegen für immer liegen. Genau so sind
 * auf dem Server hundert Megabyte ohne jede Zeile in der Datenbank entstanden.
 *
 * Der Aufrufer merkt sich die Pfade **vor** dem Löschen und übergibt sie
 * danach hierher: hinterher weiß niemand mehr, welche Dateien dazugehörten.
 * Jeder Pfad wird noch einmal gegen beide Tabellen geprüft, denn dieselbe
 * Datei kann eine zweite Zeile tragen (siehe `/api/uploads/bekannt`) — und die
 * darf ihren Inhalt nicht verlieren.
 */
export function dateienAufraeumen(pfade: Iterable<string>): { dateien: number; befreit: number } {
  let dateien = 0;
  let befreit = 0;

  for (const pfad of new Set(pfade)) {
    if (!pfad || !darfWeg(pfad)) continue;
    if (nochGebraucht(pfad)) continue;
    try {
      const stand = fs.statSync(pfad);
      if (!stand.isFile()) continue;
      fs.rmSync(pfad, { force: true });
      dateien += 1;
      befreit += stand.size;
    } catch { /* schon weg — dann ist ja gut */ }
  }

  if (dateien) {
    console.log(
      `[ablage] ${dateien} ganze Datei(en) abgeräumt (${(befreit / 1048576).toFixed(1)} MB).`,
    );
  }
  return { dateien, befreit };
}
