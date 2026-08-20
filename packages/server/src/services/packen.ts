/**
 * Dateien klein machen, ohne dass etwas verloren geht.
 *
 * Zwei Wege, je nach Inhalt:
 *
 *   Bilder aus Bildschirmfotos und Grafiken (PNG, BMP, TIFF) werden zu
 *   WebP **verlustfrei** umgeschrieben. An echten Dateien gemessen: 977 KB
 *   wurden 219 KB — 78 % weniger, Pixel für Pixel identisch. Verlustfrei war
 *   dabei sogar kleiner als Qualität 92, weil Bildschirmfotos große einfarbige
 *   Flächen haben, mit denen ein verlustbehafteter Kodierer nichts anfangen
 *   kann.
 *
 *   Alles andere bekommt zstd auf höchster Stufe — Byte für Byte umkehrbar.
 *   Bereits gepacktes (ZIP, MP4, JPEG, Programme) bleibt unangetastet: dort
 *   gewinnt man nichts und verliert nur Rechenzeit. An den echten Dateien
 *   gemessen brachte Packen dort 0,0 %.
 *
 * Die Regel über allem: **nie schlechter als vorher**. Wird das Ergebnis nicht
 * deutlich kleiner, bleibt das Original liegen.
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

/**
 * Packen, ohne den Server anzuhalten.
 *
 * `zstdCompressSync` rechnet im selben Faden, in dem auch die WebSockets
 * bedient werden. Solange es rechnet, geht **nichts** durch: keine Nachricht,
 * kein Tippen-Hinweis, kein Lebenszeichen. Gemessen mit einem zweiten Draht,
 * der im 50-ms-Takt fragt „bist du noch da?": bei einer 4-MB-Textdatei blieb
 * er auf einem M3-Mac 2,14 Sekunden ohne Antwort, bei 12 MB 2,40 Sekunden.
 * Auf dem Raspberry Pi, auf dem der Server wirklich läuft, ist das ein
 * Vielfaches davon. Genau das ist das „es hängt manchmal" — das *manchmal*
 * war der Augenblick, in dem jemand im Team eine Datei hochlud.
 *
 * Die asynchrone Fassung von zlib rechnet dagegen im Threadpool von libuv,
 * also neben dem Ereignisfaden statt in ihm. Der Server bleibt ansprechbar,
 * während gepackt wird; die Datei ist am Ende dieselbe.
 */
const zstdPacken = promisify(zlib.zstdCompress);

/** Wie eine Datei auf der Platte liegt. `null` heißt: unverändert. */
export type Verfahren = 'zstd' | 'xz' | 'webp' | null;

/** Ab hier lohnt der Aufwand — darunter bleibt alles, wie es ist. */
const MINDESTGEWINN = 0.10;
/** Unter dieser Größe ist der Gewinn nicht der Rede wert. */
const AB_GROESSE = 4 * 1024;

/** Bilder, die sich verlustfrei besser packen lassen als in ihrem Format. */
const BILD = /^image\/(png|bmp|x-ms-bmp|tiff?)$/i;

/**
 * Was erfahrungsgemäß nichts bringt.
 *
 * Diese Liste ist nur eine Abkürzung, keine Entscheidung: was hier steht, wird
 * gar nicht erst angefasst. Alles andere entscheidet die Stichprobe weiter
 * unten — an der echten Datei gemessen statt an ihrer Endung geraten.
 */
const SCHON_GEPACKT = new Set([
  'application/zip', 'application/gzip', 'application/x-7z-compressed',
  'application/x-rar-compressed', 'application/x-bzip2', 'application/x-xz',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
]);
const SCHON_GEPACKT_ANFANG = /^(video|audio)\//i;
const SCHON_GEPACKT_BILD = /^image\/(jpe?g|webp|gif|avif|heic|heif)$/i;

/** Ausführbares — dort lohnt der Filter für Maschinencode. */
const MASCHINENCODE = /^(application\/(x-)?(msdownload|executable|x-dosexec|x-mach-binary|x-elf|x-sharedlib)|application\/octet-stream)$/i;

/** Die Stichprobe: so viel wird zur Probe gepackt, bevor die Arbeit beginnt. */
const PROBE_BYTES = 2 * 1024 * 1024;
/** Bringt die Probe weniger, wird die ganze Datei nicht angefasst. */
const PROBE_SCHWELLE = 0.05;

let xzGeprueft: boolean | null = null;

function xzMoeglich(): boolean {
  if (xzGeprueft !== null) return xzGeprueft;
  try { xzGeprueft = spawnSync('xz', ['--version'], { timeout: 4000 }).status === 0; }
  catch { xzGeprueft = false; }
  return xzGeprueft;
}

/**
 * Lohnt sich die Mühe überhaupt?
 *
 * Ein 50-MB-Installer mit zstd auf höchster Stufe zu packen dauert auf einem
 * Pi eine halbe Minute — und bringt nachweislich 0,0 %, weil sein Inhalt schon
 * gepackt ist. Deshalb zuerst ein schneller Blick auf die ersten Megabyte mit
 * einer niedrigen Stufe: bringt der nichts, bringt der Rest auch nichts.
 * Das kostet Bruchteile einer Sekunde und spart Minuten.
 */
async function probeLohntSich(pfad: string, groesse: number): Promise<boolean> {
  let griff: fs.promises.FileHandle | null = null;
  try {
    griff = await fs.promises.open(pfad, 'r');
    const puffer = Buffer.alloc(Math.min(PROBE_BYTES, groesse));
    // Aus der Mitte lesen: Anfänge von Dateien tragen oft gut packbare Köpfe,
    // die über den Rest nichts aussagen.
    await griff.read(puffer, 0, puffer.length, Math.max(0, Math.floor(groesse / 2) - puffer.length / 2));
    const klein = await zstdPacken(puffer, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
    });
    return klein.length < puffer.length * (1 - PROBE_SCHWELLE);
  } catch {
    return true;                 // im Zweifel versuchen
  } finally {
    await griff?.close().catch(() => { /* schon zu */ });
  }
}

let webpGeprueft: boolean | null = null;

/**
 * Kann dieser Rechner WebP schreiben *und* wieder lesen?
 *
 * Beides muss da sein. Ein Bild wegzuschreiben, das man später nicht mehr
 * öffnen kann, wäre der schlimmste aller Fälle — deshalb wird auch der
 * Rückweg geprüft, nicht nur der Hinweg.
 */
export function webpMoeglich(): boolean {
  if (webpGeprueft !== null) return webpGeprueft;
  const da = (befehl: string) => {
    try { return spawnSync(befehl, ['-version'], { timeout: 4000 }).status === 0; }
    catch { return false; }
  };
  webpGeprueft = da('cwebp') && da('dwebp');
  if (!webpGeprueft) {
    console.log('[packen] cwebp/dwebp fehlen — Bilder bleiben unverändert liegen.');
  }
  return webpGeprueft;
}

function lohntSichNicht(mime: string, groesse: number): boolean {
  if (groesse < AB_GROESSE) return true;
  if (SCHON_GEPACKT.has(mime.toLowerCase())) return true;
  if (SCHON_GEPACKT_ANFANG.test(mime)) return true;
  if (SCHON_GEPACKT_BILD.test(mime)) return true;
  return false;
}

/**
 * Ein fremdes Programm laufen lassen, ohne den Ereignisfaden anzuhalten.
 *
 * `spawnSync` startet das Programm und wartet — im Hauptfaden. Bei `xz -9e`
 * auf vier Megabyte sind das Sekunden, in denen der Server für alle steht.
 * `spawn` startet dasselbe Programm und kehrt sofort zurück; gewartet wird
 * über ein Versprechen, und dazwischen bedient der Server weiter.
 */
function laufen(
  befehl: string, argumente: string[], eingabe: Buffer | null, frist: number,
): Promise<{ status: number; stdout: Buffer }> {
  return new Promise((fertig) => {
    let kind: ReturnType<typeof spawn>;
    try {
      kind = spawn(befehl, argumente, { stdio: [eingabe ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
    } catch { fertig({ status: -1, stdout: Buffer.alloc(0) }); return; }

    const stuecke: Buffer[] = [];
    let erledigt = false;
    const schluss = (status: number) => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(wecker);
      fertig({ status, stdout: Buffer.concat(stuecke) });
    };
    const wecker = setTimeout(() => { try { kind.kill('SIGKILL'); } catch { /* schon weg */ } schluss(-1); }, frist);

    kind.stdout?.on('data', (d: Buffer) => stuecke.push(d));
    kind.on('error', () => schluss(-1));
    kind.on('close', (code) => schluss(code ?? -1));

    if (eingabe && kind.stdin) {
      /* Ein EPIPE ist hier kein Fehler: bricht das Programm ab, bevor es alles
         gelesen hat, kommt der Abbruchgrund über `close` — nicht von hier. */
      kind.stdin.on('error', () => { /* siehe close */ });
      kind.stdin.end(eingabe);
    }
  });
}

/**
 * Eine abgelegte Datei verkleinern.
 *
 * Gibt zurück, wie sie jetzt vorliegt. Die Datei am selben Pfad wird ersetzt;
 * geht dabei etwas schief, bleibt das Original unberührt liegen.
 *
 * Durchgehend asynchron, und das ist keine Stilfrage: siehe die Anmerkung bei
 * `zstdPacken` ganz oben. Die Rechenarbeit ist dieselbe wie vorher, sie
 * blockiert nur nicht mehr den Faden, an dem alle anderen hängen.
 */
export async function verkleinern(
  pfad: string, mime: string,
): Promise<{ verfahren: Verfahren; groesse: number }> {
  let vorher: number;
  try { vorher = (await fs.promises.stat(pfad)).size; } catch { return { verfahren: null, groesse: 0 }; }

  if (lohntSichNicht(mime, vorher)) return { verfahren: null, groesse: vorher };

  const versuch = `${pfad}.neu`;
  try {
    if (BILD.test(mime) && webpMoeglich()) {
      // -z 9 ist die langsamste und dichteste Stufe. Auf einem Pi dauert ein
      // Bildschirmfoto damit unter einer Sekunde — einmalig beim Hochladen.
      const lauf = await laufen('cwebp', ['-quiet', '-lossless', '-z', '9', pfad, '-o', versuch], null, 120_000);
      if (lauf.status !== 0) throw new Error('cwebp scheiterte');

      // Gegenprobe: Lässt sich das Ergebnis auch wieder öffnen? Ohne diese
      // Prüfung könnte ein halb geschriebenes Bild als "fertig" gelten.
      const zurueck = await laufen('dwebp', ['-quiet', versuch, '-o', '/dev/null'], null, 120_000);
      if (zurueck.status !== 0) throw new Error('dwebp konnte das Ergebnis nicht lesen');

      const nachher = (await fs.promises.stat(versuch)).size;
      if (nachher < vorher * (1 - MINDESTGEWINN)) {
        await fs.promises.rename(versuch, pfad);
        return { verfahren: 'webp', groesse: nachher };
      }
      await fs.promises.rm(versuch, { force: true });
      return { verfahren: null, groesse: vorher };
    }

    /* Erst die Stichprobe: bei bereits gepacktem Inhalt hört es hier auf.
       Nachgemessen an einem echten 50-MB-Installer — vier Verfahren, alle
       0,0 %, jedes über eine halbe Minute Rechenzeit. */
    if (!await probeLohntSich(pfad, vorher)) return { verfahren: null, groesse: vorher };

    /* Jetzt lohnt es sich, und es treten mehrere Verfahren gegeneinander an.
       Welches gewinnt, hängt vom Inhalt ab: bei Text liegen zstd und xz fast
       gleichauf, bei nacktem Maschinencode zieht xz mit dem Sprungadressen-
       Filter davon. Das kleinste Ergebnis bekommt den Zuschlag.

       Beide laufen jetzt nebeneinander statt nacheinander. Das ist nicht nur
       schneller — es ist auch der Grund, warum die Reihenfolge egal ist:
       verglichen wird am Ende, was herauskam. */
    const roh = await fs.promises.readFile(pfad);
    const kandidaten: Array<{ daten: Buffer; verfahren: Exclude<Verfahren, null> }> = [];

    const argumente = MASCHINENCODE.test(mime)
      ? ['-T0', '-c', '--x86', '--lzma2=preset=9e']
      : ['-9e', '-T0', '-c'];
    const [mitZstd, mitXz] = await Promise.all([
      zstdPacken(roh, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }),
      xzMoeglich() && vorher <= 256 * 1024 * 1024
        ? laufen('xz', argumente, roh, 600_000)
        : Promise.resolve(null),
    ]);

    kandidaten.push({ daten: mitZstd as Buffer, verfahren: 'zstd' });
    if (mitXz && mitXz.status === 0 && mitXz.stdout.length > 0) {
      kandidaten.push({ daten: mitXz.stdout, verfahren: 'xz' });
    }

    const sieger = kandidaten.reduce((a, b) => (b.daten.length < a.daten.length ? b : a));
    if (sieger.daten.length < vorher * (1 - MINDESTGEWINN)) {
      await fs.promises.writeFile(versuch, sieger.daten);
      await fs.promises.rename(versuch, pfad);
      return { verfahren: sieger.verfahren, groesse: sieger.daten.length };
    }
    return { verfahren: null, groesse: vorher };
  } catch (fehler) {
    await fs.promises.rm(versuch, { force: true }).catch(() => { /* war nie da */ });
    console.error('[packen] Verkleinern übersprungen:', (fehler as Error).message);
    return { verfahren: null, groesse: vorher };
  }
}

/**
 * Eine Datei zum Ausliefern wieder herstellen.
 *
 * Der Aufrufer bekommt einen Datenstrom in der Form, in der die Datei
 * hochgeladen wurde — wer sie herunterlädt, merkt vom Packen nichts.
 */
export function auspacken(pfad: string, verfahren: Verfahren, mime: string): NodeJS.ReadableStream {
  if (!verfahren) return fs.createReadStream(pfad);

  if (verfahren === 'zstd') {
    return fs.createReadStream(pfad).pipe(zlib.createZstdDecompress());
  }

  if (verfahren === 'xz') {
    const kind = spawn('xz', ['-dc'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const quelle = fs.createReadStream(pfad);
    quelle.pipe(kind.stdin!);
    /* Bricht `xz` ab, während noch Bytes hineinlaufen, meldet die Leitung
       EPIPE. Das ist kein eigener Fehler, sondern die Folge — der Grund kommt
       über `close` und steht schon im Strom. */
    kind.stdin!.on('error', () => { quelle.destroy(); });
    return begleiten(kind, 'xz');
  }

  // WebP zurück in das Format, in dem es kam. dwebp schreibt PNG; für BMP und
  // TIFF ebenfalls PNG auszuliefern wäre gelogen, deshalb bleibt es dort beim
  // WebP mit passender Angabe (siehe ausgabeMime).
  const kind = spawn('dwebp', ['-quiet', pfad, '-o', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return begleiten(kind, 'dwebp');
}

/**
 * Den Ausgang eines fremden Programms als Datenstrom weiterreichen — und sein
 * Scheitern gleich mit.
 *
 * Zwei Löcher waren hier offen, und beide sind teuer:
 *
 * Fehlt das Programm, meldet `spawn` das über ein `error`-Ereignis. Hört
 * niemand zu, ist ein unbehandeltes `error` in Node kein Rückgabewert, sondern
 * eine geworfene Ausnahme — der ganze Server ging daran zu Boden. Nachgestellt
 * mit fehlendem `dwebp`: `uncaughtException: spawn dwebp ENOENT`. Auf jedem
 * Rechner ohne cwebp/dwebp genügte dafür ein einziger Download eines Bildes,
 * das ein anderer Rechner einmal umgeschrieben hatte.
 *
 * Bricht das Programm dagegen mittendrin ab, endete `kind.stdout` bisher
 * einfach — der Aufrufer bekam eine kürzere Datei und keinen Hinweis. Beim
 * Blockspeicher fällt das noch am Fingerabdruck auf; wer eine ganze Datei
 * ausliefert, hat diese Gegenprobe nicht und schickte stillschweigend
 * Bruchstücke. Deshalb endet der Strom jetzt mit einem Fehler statt mit einem
 * höflichen Schluss.
 */
function begleiten(
  kind: ReturnType<typeof spawn>, name: string,
): NodeJS.ReadableStream {
  const raus = new PassThrough();
  let erledigt = false;

  kind.stdout!.pipe(raus);
  kind.on('error', (fehler) => {
    if (erledigt) return;
    erledigt = true;
    raus.destroy(new Error(`${name} lief nicht: ${fehler.message}`));
  });
  kind.on('close', (code) => {
    if (erledigt) return;
    erledigt = true;
    if (code !== 0) raus.destroy(new Error(`${name} brach mit Code ${code} ab`));
  });
  return raus;
}

/**
 * Welchen Typ die ausgelieferte Datei wirklich hat.
 *
 * Bei zstd ist es der ursprüngliche. Bei WebP kommt PNG heraus, wenn PNG
 * hineinging — bei BMP und TIFF wäre das eine Umdeutung, dort bleibt es WebP.
 */
export function ausgabeMime(verfahren: Verfahren, mime: string): string {
  if (verfahren !== 'webp') return mime;
  return /^image\/png$/i.test(mime) ? 'image/png' : 'image/webp';
}

/** Endet der Dateiname noch auf das, was wirklich herauskommt? */
export function ausgabeName(name: string, verfahren: Verfahren, mime: string): string {
  if (verfahren !== 'webp') return name;
  if (/^image\/png$/i.test(mime)) return name;
  return name.replace(/\.(bmp|tiff?)$/i, '.webp');
}

/** Ein Ort für Zwischenschritte, der auf demselben Datenträger liegt. */
export function arbeitsordner(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-packen-'));
}
