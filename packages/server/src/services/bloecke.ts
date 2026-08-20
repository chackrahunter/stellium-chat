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
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

export function blockPfad(summe: string): string {
  // Zwei Ebenen Unterordner: ein einziger Ordner mit hunderttausend Einträgen
  // macht jedes Auflisten langsam.
  return path.join(config.storageDir, 'bloecke', summe.slice(0, 2), summe.slice(2, 4), summe);
}

export interface Zerlegt {
  /** Die Blöcke in der Reihenfolge, in der sie wieder zusammengesetzt werden. */
  bloecke: string[];
  /** Größe der Datei, wie sie hochgeladen wurde. */
  groesse: number;
  /** Fingerabdruck der ganzen Ausgangsdatei — die Vorlage für die Gegenprobe. */
  pruefsumme: string;
  /** Was diese Datei zusätzlich auf der Platte gekostet hat. */
  neuBelegt: number;
  /** Wie viel durch bereits vorhandene Blöcke gespart wurde. */
  gespart: number;
}

/**
 * Eine Datei in den Blockspeicher legen — in Schritten, einen Block je Schritt.
 *
 * Die Ausgangsdatei bleibt unberührt — der Aufrufer entscheidet, wann er sie
 * löscht. So bleibt bei einem Fehler mitten im Vorgang alles benutzbar.
 *
 * Warum das schrittweise geht: das Packen eines einzelnen Blocks kostet je
 * nach Inhalt Sekunden. Eine große, gut packbare Datei am Stück zu zerlegen
 * hielte den Server minutenlang an — keine Nachricht käme durch, keine Leitung
 * bekäme ein Lebenszeichen. Wer die Zerlegung im Hintergrund fährt, kann
 * zwischen zwei Blöcken Luft lassen; gemessen liegt die Zerlegung zwischen
 * 100 MB/s (schon gepackter Inhalt, die Stichprobe winkt ihn durch) und unter
 * 1 MB/s (packbarer Inhalt).
 *
 * Die Pause zwischen zwei Blöcken war aber nur die halbe Miete: EIN Block
 * hielt den Server trotzdem am Stück an, weil das Packen selbst synchron
 * rechnete. Gemessen mit einem zweiten Draht im 50-ms-Takt: 2,14 s ohne jede
 * Antwort bei einer 4-MB-Textdatei, und das auf einem M3-Mac. Deshalb ist
 * dieser Ablauf jetzt durchgehend asynchron — gepackt wird neben dem
 * Ereignisfaden, nicht in ihm (siehe packen.ts).
 *
 * Wer das nicht braucht, nimmt `ablegen()` — dieselbe Arbeit an einem Stück.
 *
 * `beruehrt` ist der Zettel für den Aufrufer: dort landet jeder Block, den
 * dieser Lauf angefasst hat — geschrieben wie wiederverwendet. Er wird
 * gebraucht, wenn der Lauf **mitten** in der Zerlegung scheitert. Bis dahin
 * steht in `datei_bloecke` nämlich nichts; wer hinterher aufräumen will, kann
 * nirgends nachsehen, was schon dasteht, und die fertigen Blöcke blieben mit
 * ihrer vorläufigen Anmeldung für immer liegen. Nachgemessen: eine 12-MB-Datei,
 * deren zweiter Block an ENOTDIR scheiterte, hinterließ einen Block mit
 * `verweise = 1` und ohne eine einzige Zeile in `datei_bloecke` — den holte
 * kein Aufräumlauf je wieder ab.
 */
export async function* ablegenSchritte(
  pfad: string,
  mime: string,
  beruehrt?: Set<string>,
): AsyncGenerator<void, Zerlegt> {
  const groesse = fs.statSync(pfad).size;
  const bloecke: string[] = [];
  let neuBelegt = 0;
  let gespart = 0;

  /* Der Fingerabdruck der ganzen Datei entsteht nebenbei: die Blöcke ziehen
     lückenlos und in Reihenfolge an dieser Stelle vorbei, also ist die Summe
     über alle Blöcke dieselbe wie die über die Datei. Sie kostet damit keinen
     zweiten Lesedurchgang und ist die Vorlage, gegen die der Rückweg geprüft
     wird, bevor die Ausgangsdatei verschwindet. */
  const gesamt = crypto.createHash('sha256');

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
        gesamt.update(block);

        /* Vor dem ersten Griff vermerken, nicht danach: scheitert schon das
           Anlegen des Ordners, ist der Block zwar nicht entstanden — der
           Aufrufer darf ihn aber trotzdem prüfen. Ein Name zu viel auf dem
           Zettel kostet eine Abfrage, ein Name zu wenig einen Block für immer. */
        beruehrt?.add(summe);

        const ziel = blockPfad(summe);
        if (fs.existsSync(ziel)) {
          gespart += laenge;              // diesen Inhalt gibt es schon
        } else {
          fs.mkdirSync(path.dirname(ziel), { recursive: true });
          const vorlaeufig = `${ziel}.teil`;
          try {
            /* Eine Kopie, keine Sicht: `block` zeigt in den Lesepuffer, und der
               wird gleich weitergeschoben. Solange geschrieben wurde, während
               niemand dazwischenkam, war das gleichgültig — jetzt liegt ein
               `await` dazwischen, und ohne Kopie schriebe der Server die Bytes
               des nächsten Blocks in die Datei des vorigen. */
            await fs.promises.writeFile(vorlaeufig, Buffer.from(block));
            /* Jeder Block wird einzeln gepackt — aber nur mit den umkehrbaren
               Verfahren. Ein Bildkodierer bekäme hier ein Bruchstück und keine
               Bilddatei; deshalb bewusst als reine Bytes behandelt. Damit bleibt
               die Zusage: aus den Blöcken entsteht die Datei Byte für Byte. */
            const { verfahren, groesse: belegt } = await verkleinern(vorlaeufig, 'application/octet-stream');
            await fs.promises.rename(vorlaeufig, ziel);
            db.run(
              `INSERT INTO bloecke (summe, groesse, belegt, verfahren, verweise, erstellt_am)
               VALUES (?,?,?,?,0,?)
               ON CONFLICT(summe) DO NOTHING`,
              summe, laenge, belegt, verfahren, Date.now(),
            );
            neuBelegt += belegt;
          } finally {
            /* Bricht es zwischen Schreiben und Umbenennen ab, bliebe ein
               `.teil` liegen — und zwar unsichtbar: der Aufräumlauf kennt nur
               Namen aus 64 Hexzeichen, `bloecke-pruefen.mjs` ebenso. Nach dem
               Umbenennen ist hier nichts mehr wegzuräumen, der Aufruf kostet
               dann einen Fehlschlag ohne Folgen. */
            if (fs.existsSync(vorlaeufig)) fs.rmSync(vorlaeufig, { force: true });
          }
        }
        /* Eine vorläufige Anmeldung: die Zeilen in `datei_bloecke` entstehen
           erst, wenn die ganze Datei zerlegt ist. Bis dahin schützt dieser
           Zähler den frischen Block davor, als verwaist zu gelten. Sobald die
           Zeilen stehen, wird er ohnehin aus der Wahrheit nachgerechnet. */
        db.run('UPDATE bloecke SET verweise = verweise + 1 WHERE summe = ?', summe);
        ab += laenge;

        /* Der Block steht, seine Zeile auch — hier darf ein Aufrufer, der es
           eilig hat, den Server dazwischenkommen lassen. An `datei_bloecke`
           ist bis zum Schluss nichts angefasst, und die vorläufige Anmeldung
           oben hält den frischen Block so lange am Leben. */
        yield;
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

  return { bloecke, groesse, pruefsumme: gesamt.digest('hex'), neuBelegt, gespart };
}

/**
 * Eine Datei in den Blockspeicher legen, an einem Stück.
 *
 * Für alle, die ohnehin warten, bis es fertig ist — kleine Dateien beim
 * Hochladen, der Nachziehlauf von Hand.
 */
export async function ablegen(pfad: string, mime: string, beruehrt?: Set<string>): Promise<Zerlegt> {
  const lauf = ablegenSchritte(pfad, mime, beruehrt);
  for (;;) {
    const schritt = await lauf.next();
    if (schritt.done) return schritt.value;
  }
}

/**
 * Halbe Blöcke aus einem Absturz wegräumen.
 *
 * Zwischen „Bytes geschrieben" und „umbenannt" liegt ein Augenblick, in dem
 * eine `.teil`-Datei dasteht. Wird der Server genau dort abgeschossen, bleibt
 * sie liegen — und zwar unsichtbar, denn jeder Aufräum- und Prüflauf sucht
 * nach Namen aus 64 Hexzeichen und übersieht die Endung. Im Betrieb räumt der
 * Ablauf selbst hinter sich her; das hier ist für den Fall, in dem er nicht
 * mehr dazu kam.
 *
 * Angefasst wird nur, was seit über einer Stunde niemand mehr berührt hat: der
 * Lauf hängt am Start, und da soll er einer Zerlegung, die möglicherweise
 * gerade in einem zweiten Prozess läuft, nichts unter den Händen wegziehen.
 */
export function teileWegraeumen(): number {
  const grenze = Date.now() - 60 * 60 * 1000;
  let weg = 0;
  const gehe = (ort: string): void => {
    let eintraege: fs.Dirent[];
    try { eintraege = fs.readdirSync(ort, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const voll = path.join(ort, e.name);
      if (e.isDirectory()) { gehe(voll); continue; }
      /* `.teil` ist der halbe Block, `.teil.neu` der Zwischenschritt, den
         packen.ts beim Verkleinern anlegt. Beide tragen keinen Namen aus 64
         Hexzeichen und sind deshalb für jeden anderen Lauf unsichtbar. */
      if (!/\.teil(\.neu)?$/.test(e.name)) continue;
      try {
        if (fs.statSync(voll).mtimeMs > grenze) continue;
        fs.rmSync(voll, { force: true });
        weg += 1;
      } catch { /* schon weg */ }
    }
  };
  gehe(path.join(config.storageDir, 'bloecke'));
  if (weg) console.log(`[bloecke] ${weg} halbe Blockdatei(en) aus einem Absturz weggeräumt.`);
  return weg;
}

/* ── Rückweg ──────────────────────────────────────────────────── */

/**
 * Einen gepackten Block im Speicher wieder auspacken.
 *
 * Warum das hier noch einmal steht, obwohl packen.ts dasselbe kann: dort
 * liefert es einen Datenstrom, und ein Strom taugt nicht für Aufrufer, die
 * mitten in einer Datenbanktransaktion stehen und eine Antwort brauchen,
 * bevor sie weitermachen dürfen. Ein Block ist außerdem höchstens vier
 * Megabyte groß — er passt bequem in den Speicher, eine ganze Datei nicht.
 *
 * Blöcke kennen nur zwei Verfahren: sie werden bewusst als nackte Bytes
 * gepackt, damit aus ihnen Byte für Byte dieselbe Datei entsteht. Der
 * Bildkodierer kann hier deshalb gar nicht vorkommen — käme er doch vor, wäre
 * etwas grundlegend falsch, und ein Abbruch ist die richtige Antwort.
 */
function auspackenImSpeicher(roh: Buffer, verfahren: Verfahren): Buffer {
  if (!verfahren) return roh;
  if (verfahren === 'zstd') return zlib.zstdDecompressSync(roh);
  if (verfahren === 'xz') {
    const lauf = spawnSync('xz', ['-dc'], {
      input: roh, maxBuffer: MAX * 2 + 1024 * 1024, timeout: 120_000,
    });
    if (lauf.status !== 0 || !lauf.stdout) throw new Error('xz konnte den Block nicht auspacken');
    return lauf.stdout;
  }
  throw new Error(`Verfahren "${verfahren}" gehört nicht zu einem Block`);
}

/**
 * Einen einzelnen Block lesen und gegen seinen Namen prüfen.
 *
 * Der Name eines Blocks *ist* der Fingerabdruck seines Inhalts. Passt beides
 * nicht mehr zusammen, ist der Block auf der Platte verändert worden — dann
 * hilft nur der Abbruch, denn ein geteilter Block steckt in mehreren Dateien
 * und ein unbemerkter Schaden verbreitete sich still.
 */
export function blockLesen(summe: string): Buffer {
  const zeile = db.get<{ verfahren: Verfahren }>(
    'SELECT verfahren FROM bloecke WHERE summe = ?', summe,
  );
  const block = auspackenImSpeicher(fs.readFileSync(blockPfad(summe)), zeile?.verfahren ?? null);
  if (crypto.createHash('sha256').update(block).digest('hex') !== summe) {
    throw new Error(`Block ${summe.slice(0, 12)}… ist beschädigt`);
  }
  return block;
}

/** Was von einem Block zu halten ist — für die Tiefenprüfung. */
export type Blockzustand = 'ok' | 'fehlt' | 'beschaedigt';

export interface Blockbefund {
  summe: string;
  zustand: Blockzustand;
  /** Warum es nicht "ok" ist, in einem Satz. */
  grund?: string;
}

/**
 * Einen Block nachrechnen, ohne etwas zu ändern.
 *
 * Bewusst ohne Ausnahme nach außen: die Tiefenprüfung will alle Befunde sehen
 * und nicht beim ersten Schaden stehenbleiben.
 */
export function pruefeBlock(summe: string): Blockbefund {
  const pfad = blockPfad(summe);
  if (!fs.existsSync(pfad)) return { summe, zustand: 'fehlt', grund: 'Die Blockdatei liegt nicht auf der Platte.' };
  try {
    blockLesen(summe);
    return { summe, zustand: 'ok' };
  } catch (fehler) {
    return { summe, zustand: 'beschaedigt', grund: (fehler as Error).message };
  }
}

/**
 * Eine Datei aus ihren Blöcken zusammensetzen und den Fingerabdruck
 * nachrechnen — ohne die Bytes irgendwo hinzuschreiben.
 *
 * Das ist die Gegenprobe vor dem Löschen der Ausgangsdatei: erst wenn aus den
 * Blöcken nachweislich wieder dieselbe Datei entsteht, darf das Original weg.
 */
export function pruefsummeAus(bloecke: string[]): { pruefsumme: string; groesse: number } {
  const gesamt = crypto.createHash('sha256');
  let groesse = 0;
  for (const summe of bloecke) {
    const block = blockLesen(summe);
    gesamt.update(block);
    groesse += block.length;
  }
  return { pruefsumme: gesamt.digest('hex'), groesse };
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

/**
 * Den Verweiszähler dieser Blöcke aus der Wahrheit neu bestimmen.
 *
 * Gezählt wird nicht mehr hoch und runter, sondern nachgesehen: maßgeblich ist
 * allein, wie viele Zeilen in `datei_bloecke` auf den Block zeigen. Ein Zähler,
 * den man einzeln fortschreibt, läuft irgendwann auseinander — es genügt ein
 * Weg, auf dem eine Datei verschwindet, ohne dass jemand mitzählt. Genau das
 * ist passiert: beim Löschen eines Kanals räumt die Datenbank Nachrichten,
 * Anhänge und Dateien selbst ab, und der Zähler blieb stehen. Wer stattdessen
 * nachsieht, kann sich nicht verzählen und heilt alte Abweichungen nebenbei.
 */
export function verweiseNachrechnen(bloecke: Iterable<string>): void {
  for (const summe of new Set(bloecke)) {
    db.run(
      `UPDATE bloecke SET verweise =
         (SELECT COUNT(*) FROM datei_bloecke WHERE summe = bloecke.summe)
       WHERE summe = ?`,
      summe,
    );
  }
}

/**
 * Blöcke freigeben, die zu keiner Datei mehr gehören.
 *
 * Aufgeräumt wird ausdrücklich nur unter den übergebenen Blöcken. Früher sah
 * dieser Weg am Ende die ganze Tabelle durch und löschte alles ohne Verweise —
 * das traf auch Blöcke, die ein zweiter Vorgang gerade erst geschrieben und
 * noch nicht eingetragen hatte. Sich auf das zu beschränken, worum es geht,
 * ist zugleich billiger: keine Suche über hunderttausend Zeilen bei jedem
 * Löschen.
 *
 * Voraussetzung ist, dass der Aufrufer die Zeilen in `datei_bloecke` **vorher**
 * entfernt hat — daran, und an nichts anderem, wird entschieden.
 */
export function freigeben(bloecke: string[]): { geloescht: number; befreit: number } {
  verweiseNachrechnen(bloecke);

  let geloescht = 0;
  let befreit = 0;
  for (const summe of new Set(bloecke)) {
    const zeile = db.get<{ belegt: number }>(
      'SELECT belegt FROM bloecke WHERE summe = ? AND verweise <= 0', summe,
    );
    if (!zeile) continue;
    try { fs.rmSync(blockPfad(summe), { force: true }); } catch { /* schon weg */ }
    db.run('DELETE FROM bloecke WHERE summe = ?', summe);
    geloescht += 1;
    befreit += zeile.belegt;
  }
  return { geloescht, befreit };
}

/** Was der Blockspeicher insgesamt belegt — und was er eingespart hat. */
export function bilanz(): { bloecke: number; belegt: number; roh: number } {
  const r = db.get<{ n: number; belegt: number | null; roh: number | null }>(
    'SELECT COUNT(*) n, SUM(belegt) belegt, SUM(groesse * verweise) roh FROM bloecke',
  );
  return { bloecke: r?.n ?? 0, belegt: r?.belegt ?? 0, roh: r?.roh ?? 0 };
}
