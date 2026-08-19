/**
 * Blockspeicher: dieselben Bytes werden nur einmal abgelegt.
 *
 * Warum das nötig ist: fertige Installer, ISO-Abbilder und Programme lassen
 * sich nicht mehr packen — ihr Inhalt ist bereits gepackt und sieht für jeden
 * Packer aus wie Rauschen. An einer echten 50-MB-Datei nachgemessen: zstd,
 * xz und der Filter für Maschinencode kamen alle auf 0,0 %.
 *
 * Einzeln betrachtet stimmt das auch. Untereinander sind solche Dateien aber
 * das genaue Gegenteil von zufällig: zwei Fassungen desselben Programms teilen
 * fast ihren ganzen Inhalt, und dieselbe Datei landet in einem Team ohnehin
 * mehrfach im Speicher. Genau dort setzt dieser Speicher an.
 *
 * Jede Datei wird in Blöcke zerlegt, deren Grenzen **aus dem Inhalt** folgen
 * und nicht aus festen Abständen. Das ist der entscheidende Punkt: schiebt
 * eine neue Fassung ein einziges Byte ein, verrutschten bei festen Grenzen
 * alle folgenden Blöcke und nichts wäre mehr wiedererkennbar. Bei
 * inhaltsabhängigen Grenzen ändert sich nur der eine Block, in dem das Byte
 * steckt — alle anderen bleiben Wort für Wort dieselben und werden nicht noch
 * einmal gespeichert.
 *
 * Jeder Block wird zusätzlich einzeln gepackt (siehe packen.ts). Verlustfrei
 * bleibt alles: aus den Blöcken entsteht beim Herunterladen wieder Byte für
 * Byte dieselbe Datei.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { verkleinern, auspacken, type Verfahren } from './packen.js';

/* ── Blockgrenzen ─────────────────────────────────────────────── */

/** Kleinster Block. Darunter lohnt die Verwaltung nicht. */
const MIN = 256 * 1024;
/** Angestrebte mittlere Blockgröße. */
const ZIEL = 1024 * 1024;
/** Größter Block — begrenzt den Speicherbedarf beim Lesen. */
const MAX = 4 * 1024 * 1024;

/**
 * Die Maske bestimmt, wie oft eine Grenze fällt: im Mittel alle 2^20 Bytes,
 * also etwa jedes Megabyte. Sie greift auf einem gleitenden Fingerabdruck über
 * die letzten 64 Bytes — dieselben 64 Bytes ergeben immer dieselbe Antwort,
 * unabhängig davon, an welcher Stelle der Datei sie stehen. Das ist der Grund,
 * warum verschobene Inhalte wiedererkannt werden.
 */
const MASKE = (1 << 20) - 1;

/** Zufallstabelle für den gleitenden Fingerabdruck (Gear-Verfahren). */
const TABELLE = (() => {
  // Fest verdrahteter Startwert: die Tabelle muss auf jedem Server und über
  // jede Fassung hinweg dieselbe sein, sonst passen alte Blöcke nicht mehr.
  const zufall = crypto.createHash('sha512').update('stellium/bloecke/v1').digest();
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const h = crypto.createHash('sha256').update(zufall).update(Uint8Array.of(i)).digest();
    t[i] = h.readUInt32BE(0);
  }
  return t;
})();

/**
 * Die nächste Blockgrenze in einem Puffer finden.
 *
 * Gibt zurück, wie lang der Block wird. Vor `MIN` wird gar nicht gesucht —
 * das erspart Arbeit und verhindert Blöcke, die nur aus Verwaltung bestehen.
 */
export function naechsteGrenze(puffer: Buffer, ab: number): number {
  const ende = Math.min(ab + MAX, puffer.length);
  if (ende - ab <= MIN) return ende - ab;

  let fingerabdruck = 0;
  for (let i = ab + MIN; i < ende; i += 1) {
    fingerabdruck = ((fingerabdruck << 1) + TABELLE[puffer[i]]) >>> 0;
    if ((fingerabdruck & MASKE) === 0) return i - ab + 1;
  }
  return ende - ab;
}

/* ── Ablage ───────────────────────────────────────────────────── */

function blockPfad(summe: string): string {
  // Zwei Ebenen Unterordner: ein einziger Ordner mit hunderttausend Einträgen
  // macht jedes Auflisten langsam.
  return path.join(config.storageDir, 'bloecke', summe.slice(0, 2), summe.slice(2, 4), summe);
}

export interface Zerlegt {
  /** Die Blöcke in der Reihenfolge, in der sie wieder zusammengesetzt werden. */
  bloecke: string[];
  /** Größe der Datei, wie sie hochgeladen wurde. */
  groesse: number;
  /** Was diese Datei zusätzlich auf der Platte gekostet hat. */
  neuBelegt: number;
  /** Wie viel durch bereits vorhandene Blöcke gespart wurde. */
  gespart: number;
}

/**
 * Eine Datei in den Blockspeicher legen.
 *
 * Die Ausgangsdatei bleibt unberührt — der Aufrufer entscheidet, wann er sie
 * löscht. So bleibt bei einem Fehler mitten im Vorgang alles benutzbar.
 */
export function ablegen(pfad: string, mime: string): Zerlegt {
  const groesse = fs.statSync(pfad).size;
  const bloecke: string[] = [];
  let neuBelegt = 0;
  let gespart = 0;

  const griff = fs.openSync(pfad, 'r');
  try {
    // Immer ein Stück lesen, das mindestens einen größten Block fasst, damit
    // eine Grenze nie am Puffernde abgeschnitten wird.
    const puffer = Buffer.alloc(Math.min(MAX * 2, Math.max(groesse, MIN)));
    let dateiPos = 0;
    let imPuffer = 0;

    for (;;) {
      const gelesen = fs.readSync(griff, puffer, imPuffer, puffer.length - imPuffer, dateiPos + imPuffer);
      imPuffer += gelesen;
      if (imPuffer === 0) break;

      let ab = 0;
      while (ab < imPuffer) {
        const rest = imPuffer - ab;
        // Ist der Rest kürzer als ein größter Block und kommt noch mehr, wird
        // erst nachgeladen — sonst entstünde eine willkürliche Grenze.
        if (rest < MAX && gelesen > 0 && dateiPos + imPuffer < groesse) break;
        const laenge = naechsteGrenze(puffer.subarray(0, imPuffer), ab);
        const block = puffer.subarray(ab, ab + laenge);
        const summe = crypto.createHash('sha256').update(block).digest('hex');
        bloecke.push(summe);

        const ziel = blockPfad(summe);
        if (fs.existsSync(ziel)) {
          gespart += laenge;              // diesen Inhalt gibt es schon
        } else {
          fs.mkdirSync(path.dirname(ziel), { recursive: true });
          const vorlaeufig = `${ziel}.teil`;
          fs.writeFileSync(vorlaeufig, block);
          /* Jeder Block wird einzeln gepackt — aber nur mit den umkehrbaren
             Verfahren. Ein Bildkodierer bekäme hier ein Bruchstück und keine
             Bilddatei; deshalb bewusst als reine Bytes behandelt. Damit bleibt
             die Zusage: aus den Blöcken entsteht die Datei Byte für Byte. */
          const { verfahren, groesse: belegt } = verkleinern(vorlaeufig, 'application/octet-stream');
          fs.renameSync(vorlaeufig, ziel);
          db.run(
            `INSERT INTO bloecke (summe, groesse, belegt, verfahren, verweise, erstellt_am)
             VALUES (?,?,?,?,0,?)
             ON CONFLICT(summe) DO NOTHING`,
            summe, laenge, belegt, verfahren, Date.now(),
          );
          neuBelegt += belegt;
        }
        db.run('UPDATE bloecke SET verweise = verweise + 1 WHERE summe = ?', summe);
        ab += laenge;
      }

      if (ab === 0 && gelesen === 0) break;
      puffer.copy(puffer, 0, ab, imPuffer);
      dateiPos += ab;
      imPuffer -= ab;
      if (dateiPos + imPuffer >= groesse && imPuffer === 0) break;
    }
  } finally {
    fs.closeSync(griff);
  }

  return { bloecke, groesse, neuBelegt, gespart };
}

/**
 * Eine Datei aus ihren Blöcken wieder zusammensetzen.
 *
 * Liefert die Bytes in der Reihenfolge, in der sie hochgeladen wurden — wer
 * die Datei herunterlädt, merkt von der Zerlegung nichts.
 */
export async function* zusammensetzen(bloecke: string[]): AsyncGenerator<Buffer> {
  for (const summe of bloecke) {
    const zeile = db.get<{ verfahren: Verfahren }>(
      'SELECT verfahren FROM bloecke WHERE summe = ?', summe,
    );
    const strom = auspacken(blockPfad(summe), zeile?.verfahren ?? null, 'application/octet-stream');

    /* Ein Strom liefert einen Block in mehreren Stücken. Geprüft werden kann
       erst der ganze Block — sein Name ist der Fingerabdruck seines gesamten
       Inhalts, nicht der eines einzelnen Häppchens. */
    const stuecke: Buffer[] = [];
    for await (const stueck of strom as AsyncIterable<Buffer>) stuecke.push(Buffer.from(stueck));
    const block = Buffer.concat(stuecke);

    const gerechnet = crypto.createHash('sha256').update(block).digest('hex');
    if (gerechnet !== summe) {
      // Lieber ein Abbruch als stille Falschdaten: bei geteilten Blöcken
      // beträfe ein unbemerkter Schaden gleich mehrere Dateien.
      throw new Error(`Block ${summe.slice(0, 12)}… ist beschädigt`);
    }
    yield block;
  }
}

/** Blöcke freigeben, die zu keiner Datei mehr gehören. */
export function freigeben(bloecke: string[]): void {
  for (const summe of bloecke) {
    db.run('UPDATE bloecke SET verweise = max(0, verweise - 1) WHERE summe = ?', summe);
  }
  const verwaist = db.all<{ summe: string }>(
    'SELECT summe FROM bloecke WHERE verweise <= 0',
  );
  for (const { summe } of verwaist) {
    try { fs.rmSync(blockPfad(summe), { force: true }); } catch { /* schon weg */ }
    db.run('DELETE FROM bloecke WHERE summe = ?', summe);
  }
}

/** Was der Blockspeicher insgesamt belegt — und was er eingespart hat. */
export function bilanz(): { bloecke: number; belegt: number; roh: number } {
  const r = db.get<{ n: number; belegt: number | null; roh: number | null }>(
    'SELECT COUNT(*) n, SUM(belegt) belegt, SUM(groesse * verweise) roh FROM bloecke',
  );
  return { bloecke: r?.n ?? 0, belegt: r?.belegt ?? 0, roh: r?.roh ?? 0 };
}
