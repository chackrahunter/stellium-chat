import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, shell, type BrowserWindow } from 'electron';

const ausfuehren = promisify(execFile);

/**
 * Selbstaktualisierung über den eigenen Firmenserver.
 *
 * Ablauf: der Renderer meldet Serveradresse und Anmeldetoken, sobald jemand
 * angemeldet ist. Von da an fragt der Hauptprozess regelmäßig nach einer
 * neueren Version, lädt sie im Hintergrund und prüft die Prüfsumme.
 *
 * Installiert wird auf Knopfdruck, und zwar wirklich: die App tauscht sich
 * selbst aus und startet neu. Wie das geht, unterscheidet sich je nach System —
 * macOS hängt ein Abbild ein und kopiert daraus, Windows ruft den Installer
 * still auf, Linux ersetzt die AppImage-Datei. Nur wenn dieser Weg scheitert,
 * bleibt der alte: die Datei öffnen und die Person entscheiden lassen.
 */

interface Fern {
  platform: string;
  version: string;
  notes: string | null;
  size: number;
  sha256: string;
  fileName: string;
  url: string;
}

/** Was zuletzt installiert wurde — für den Willkommensbildschirm danach. */
interface Vermerk {
  version: string;
  notes: string | null;
  installiertAm: number;
}

// Nachfragen: beim Start bald, danach viertelstündlich. Kurz genug, dass ein
// frisch hochgeladenes Update zügig ankommt, ohne den Server zu belästigen.
const INTERVALL = 15 * 60 * 1000;

let serverUrl: string | null = null;
let token: string | null = null;
let fenster: BrowserWindow | null = null;
let timer: NodeJS.Timeout | null = null;
let laeuft = false;
/** Schon heruntergeladene Version — nicht zweimal ziehen. */
let bereit: { version: string; datei: string } | null = null;
let letzteNotizen: string | null = null;

/**
 * Wartefrist bis zur Installation.
 *
 * Ein Update, das jemand wegklickt und nie wieder ansieht, ist kein Update.
 * Deshalb läuft nach dem Herunterladen eine Uhr; wer nichts tut, bekommt die
 * neue Fassung. Wer "später" sagt, verschiebt sie — und beim nächsten Beenden
 * der App wird ohnehin installiert, denn dann stört es niemanden.
 */
const FRIST_MS = 5 * 60 * 1000;
let frist: NodeJS.Timeout | null = null;
let installiertBeimBeenden = false;
/* Läuft gerade ein Austausch? Ohne diese Sperre startet app.quit() über
   'before-quit' einen zweiten Lauf, und zwei Skripte räumen gleichzeitig im
   selben App-Ordner auf. */
let installiertGerade = false;
/* Eine Version, deren Austausch stumm gescheitert ist. Die wird nicht wieder
   von selbst eingespielt — sonst dreht sich das Laden endlos im Kreis. */
let gescheitert: string | null = null;

function fristStarten(sekunden = FRIST_MS / 1000): void {
  if (frist) clearTimeout(frist);
  melden('update:deadline', { version: bereit?.version, sekunden });
  frist = setTimeout(() => { void installieren(); }, sekunden * 1000);
}

/** "Später": die Uhr anhalten und stattdessen beim Beenden installieren. */
export function fristVerschieben(): void {
  if (frist) { clearTimeout(frist); frist = null; }
  installiertBeimBeenden = true;
  melden('update:postponed', { version: bereit?.version });
}

/** Steht beim Beenden eine Installation an? */
export function beimBeendenInstallieren(): boolean {
  return installiertBeimBeenden && bereit !== null;
}

export function updaterInit(win: BrowserWindow): void {
  fenster = win;

  /* Nach einem Update läuft entweder die neue Fassung — oder der Austausch ist
     stumm gescheitert und es läuft weiter die alte. Letzteres würde sonst
     niemand merken: die App lädt dieselbe Datei erneut, startet neu, scheitert
     erneut. Einmal ist ein Missgeschick, in einer Schleife ist es ein Fehler. */
  try {
    const datei = path.join(app.getPath('userData'), 'letztes-update.json');
    const vermerk = JSON.parse(fs.readFileSync(datei, 'utf8')) as Vermerk;
    if (vermerk.version && vermerk.version !== app.getVersion()) {
      gescheitert = vermerk.version;
      // Den Vermerk wegräumen, sonst begrüßt der Willkommensgruß eine Fassung,
      // die gar nicht läuft.
      fs.rmSync(datei, { force: true });
    }
  } catch { /* kein Vermerk — dann gab es auch kein Update */ }
}

/** Der Renderer meldet sich, sobald jemand angemeldet ist. */
export function updaterAnmelden(url: string, tok: string): void {
  serverUrl = url.replace(/\/+$/, '');
  token = tok;
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void pruefen(); }, INTERVALL);
  // Kurz warten: beim Start ist die Verbindung oft noch nicht stabil.
  setTimeout(() => { void pruefen(); }, 8_000);
}

export function updaterAbmelden(): void {
  serverUrl = null;
  token = null;
  if (timer) { clearInterval(timer); timer = null; }
}

function melden(kanal: string, nutzlast: unknown): void {
  if (fenster && !fenster.isDestroyed()) fenster.webContents.send(kanal, nutzlast);
}

export async function pruefen(manuell = false): Promise<Fern | null> {
  if (!serverUrl || !token || laeuft) return null;
  laeuft = true;
  try {
    const antwort = await fetch(
      `${serverUrl}/api/releases/check?platform=${process.platform}&version=${app.getVersion()}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!antwort.ok) return null;
    const { update } = (await antwort.json()) as { update: Fern | null };
    if (!update) {
      // Auch ohne Knopfdruck melden: sonst zeigt die Ansicht weiter den Stand
      // von vorhin an, obwohl längst nachgesehen wurde.
      melden('update:none', { version: app.getVersion() });
      return null;
    }
    melden('update:found', update);
    await laden(update);
    return update;
  } catch (err) {
    if (manuell) melden('update:error', { message: (err as Error).message });
    return null;
  } finally {
    laeuft = false;
  }
}

async function laden(update: Fern): Promise<void> {
  if (bereit?.version === update.version && fs.existsSync(bereit.datei)) {
    melden('update:ready', { version: update.version, datei: bereit.datei });
    return;
  }

  /* Nicht in den gemeinsamen Zwischenspeicher: unter Linux ist /tmp für alle
     Konten beschreibbar. Zwischen dem Prüfen der Prüfsumme und dem Ausführen
     könnte dort jemand die Datei austauschen. Das eigene Verzeichnis der App
     gehört dem angemeldeten Konto allein. */
  const ordner = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(ordner, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ordner, 0o700); } catch { /* auf Windows ohne Belang */ }
  altesAufraeumen(ordner, update.version);

  const ziel = path.join(ordner, `${update.version}-${update.fileName}`);
  const halb = `${ziel}.teil`;

  // Platz prüfen, bevor 170 MB gezogen werden: doppelt, weil beim Installieren
  // noch einmal entpackt wird. Ohne diese Prüfung bricht der Download erst
  // nach Minuten ab — mit einer Meldung, die niemand versteht.
  const noetig = update.size * 2;
  const frei = freierPlatz(ordner);
  if (frei !== null && frei < noetig) {
    melden('update:error', {
      message: `Zu wenig Platz: ${(noetig / 1e9).toFixed(1)} GB nötig, ${(frei / 1e9).toFixed(1)} GB frei.`,
    });
    return;
  }

  /* Bis zu drei Anläufe, und zwar dort weiter, wo es abgerissen ist. Über eine
     Hausleitung dauert ein Update Minuten — in dieser Zeit reicht ein
     Funkloch, und ohne Wiederaufnahme fängt alles von vorn an. */
  for (let versuch = 1; versuch <= 3; versuch += 1) {
    try {
      await ladenVersuch(update, halb, ziel);
      bereit = { version: update.version, datei: ziel };
      letzteNotizen = update.notes;
      melden('update:ready', { version: update.version, datei: ziel, notes: update.notes });
      if (!installiertBeimBeenden) fristStarten();
      return;
    } catch (err) {
      const grund = (err as Error).message;
      if (versuch === 3) {
        fs.rmSync(halb, { force: true });
        melden('update:error', { message: grund });
        return;
      }
      melden('update:retry', { versuch, message: grund });
      await new Promise((f) => setTimeout(f, versuch * 4000));
    }
  }
}

/** Freier Platz am Ablageort, oder null wenn nicht feststellbar. */
function freierPlatz(ordner: string): number | null {
  try {
    return fs.statfsSync(ordner).bavail * fs.statfsSync(ordner).bsize;
  } catch { return null; }
}

/** Reste früherer Läufe wegräumen — sonst füllt sich der Ablageort still. */
function altesAufraeumen(ordner: string, behalten: string): void {
  try {
    for (const name of fs.readdirSync(ordner)) {
      if (name.startsWith(behalten)) continue;
      fs.rmSync(path.join(ordner, name), { force: true, recursive: true });
    }
  } catch { /* nicht schlimm */ }
}

/**
 * Eine Fassung herunterladen — als Datenstrom auf die Platte, nicht in den
 * Speicher.
 *
 * Vorher sammelte sich die ganze Datei im Arbeitsspeicher und wurde erst am
 * Ende geschrieben: bei 170 MB gut ein Drittel Gigabyte, und auf einem Rechner
 * mit wenig Speicher scheiterte genau daran das Update. Die Prüfsumme entsteht
 * jetzt beim Schreiben mit.
 */
async function ladenVersuch(update: Fern, halb: string, ziel: string): Promise<void> {
  const schon = fs.existsSync(halb) ? fs.statSync(halb).size : 0;
  const kopf: Record<string, string> = { authorization: `Bearer ${token}` };
  if (schon > 0 && schon < update.size) kopf.range = `bytes=${schon}-`;

  // Eine Leitung, die nichts mehr liefert, darf nicht ewig blockieren.
  const abbruch = new AbortController();
  let letzteRegung = Date.now();
  const wache = setInterval(() => {
    if (Date.now() - letzteRegung > 90_000) abbruch.abort();
  }, 10_000);

  try {
    const antwort = await fetch(`${serverUrl}${update.url}`, { headers: kopf, signal: abbruch.signal });
    if (!antwort.ok || !antwort.body) throw new Error(`Download fehlgeschlagen (${antwort.status})`);

    // Beantwortet der Server den Bereich nicht, fangen wir eben von vorn an.
    const setztFort = antwort.status === 206 && schon > 0;
    if (!setztFort && schon > 0) fs.rmSync(halb, { force: true });

    const schreiber = fs.createWriteStream(halb, { flags: setztFort ? 'a' : 'w', highWaterMark: 1024 * 1024 });
    let geladen = setztFort ? schon : 0;
    let zuletztGemeldet = 0;

    for await (const stueck of antwort.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(stueck);
      letzteRegung = Date.now();
      if (!schreiber.write(buf)) {
        await new Promise<void>((f) => { schreiber.once('drain', () => f()); });
      }
      geladen += buf.byteLength;
      // Höchstens viermal je Sekunde melden — sonst überschwemmt der
      // Fortschritt die Oberfläche mit Nachrichten.
      const jetzt = Date.now();
      if (jetzt - zuletztGemeldet > 250) {
        zuletztGemeldet = jetzt;
        melden('update:progress', { version: update.version, geladen, gesamt: update.size });
      }
    }
    await new Promise<void>((fertig, schief) => {
      schreiber.end((err?: Error | null) => (err ? schief(err) : fertig()));
    });

    const gross = fs.statSync(halb).size;
    if (gross !== update.size) throw new Error(`Unvollständig: ${gross} von ${update.size} Bytes.`);

    // Erst prüfen, dann an den endgültigen Platz — eine halbe Datei darf nie
    // wie eine fertige aussehen.
    const summe = await summeVonDatei(halb);
    if (summe !== update.sha256) {
      fs.rmSync(halb, { force: true });
      throw new Error('Die geladene Datei stimmt nicht mit der Prüfsumme überein.');
    }

    fs.rmSync(ziel, { force: true });
    fs.renameSync(halb, ziel);
    melden('update:progress', { version: update.version, geladen: update.size, gesamt: update.size });
  } finally {
    clearInterval(wache);
  }
}

/** Prüfsumme einer Datei, ohne sie ganz in den Speicher zu holen. */
function summeVonDatei(datei: string): Promise<string> {
  return new Promise((fertig, schief) => {
    const hash = createHash('sha256');
    const strom = fs.createReadStream(datei, { highWaterMark: 1024 * 1024 });
    strom.on('data', (d) => hash.update(d));
    strom.on('end', () => fertig(hash.digest('hex')));
    strom.on('error', schief);
  });
}

/* ── Installieren ─────────────────────────────────────────────── */

/** Merkt, was gerade installiert wurde — der nächste Start zeigt es an. */
function vermerken(version: string, notes: string | null): void {
  try {
    const datei = path.join(app.getPath('userData'), 'letztes-update.json');
    const inhalt: Vermerk = { version, notes, installiertAm: Date.now() };
    fs.writeFileSync(datei, JSON.stringify(inhalt), 'utf8');
  } catch { /* nicht schlimm — dann fehlt nur der Hinweis danach */ }
}

/** Was beim letzten Mal installiert wurde, einmalig abzuholen. */
export function letztesUpdate(): Vermerk | null {
  const datei = path.join(app.getPath('userData'), 'letztes-update.json');
  try {
    const inhalt = JSON.parse(fs.readFileSync(datei, 'utf8')) as Vermerk;
    // Nur einmal zeigen.
    fs.rmSync(datei, { force: true });
    return inhalt;
  } catch { return null; }
}

/**
 * macOS: Abbild einhängen, die App daraus an ihren Platz kopieren, wieder
 * aushängen. Das Ersetzen läuft in einem eigenen Skript, denn die laufende
 * App kann sich nicht selbst überschreiben, während sie noch läuft.
 */
async function installiereMac(datei: string): Promise<void> {
  const einhaengepunkt = `/Volumes/stellium-update-${Date.now()}`;
  await ausfuehren('hdiutil', ['attach', datei, '-nobrowse', '-quiet', '-mountpoint', einhaengepunkt]);

  const eintraege = fs.readdirSync(einhaengepunkt).filter((n) => n.endsWith('.app'));
  if (!eintraege.length) {
    await ausfuehren('hdiutil', ['detach', einhaengepunkt, '-force']).catch(() => {});
    throw new Error('Im Abbild ist keine App enthalten.');
  }

  const neu = path.join(einhaengepunkt, eintraege[0]);
  const ziel = path.resolve(app.getPath('exe'), '../../..');

  // Nach dem Beenden: austauschen, aushängen, neu starten. Das Skript läuft
  // ohne Elternprozess weiter, deshalb überlebt es unser Ende.
  const skript = path.join(app.getPath('userData'), `update-${Date.now()}.sh`);

  /* Erst kopieren, dann tauschen — nicht andersherum.
     Vorher wurde die alte App gelöscht und danach die neue kopiert. Ging beim
     Kopieren etwas schief (Platte voll, Abbild ausgehängt, Rechte), war
     überhaupt keine App mehr da: aus einem fehlgeschlagenen Update wurde eine
     verschwundene Anwendung. Jetzt liegt die neue vollständig daneben, bevor
     die alte weicht — und wenn etwas klemmt, kommt die alte zurück. */
  fs.writeFileSync(skript, `#!/bin/bash
# Von Stellium erzeugt. Tauscht die App aus, während sie beendet ist.
set -u
ZIEL=${JSON.stringify(ziel)}
NEU=${JSON.stringify(neu)}
ABBILD=${JSON.stringify(einhaengepunkt)}
FRISCH="$ZIEL.neu"
ALT="$ZIEL.alt"

aufraeumen() {
  rm -rf "$FRISCH"
  hdiutil detach "$ABBILD" -force >/dev/null 2>&1
  rm -f "$0"
}

for i in $(seq 1 40); do
  pgrep -x Stellium >/dev/null || break
  sleep 0.25
done

rm -rf "$FRISCH" "$ALT"
if ! cp -R "$NEU" "$FRISCH"; then
  # Nichts angefasst — die alte App läuft weiter.
  aufraeumen
  open "$ZIEL"
  exit 1
fi

xattr -dr com.apple.quarantine "$FRISCH" 2>/dev/null

if ! mv "$ZIEL" "$ALT"; then
  aufraeumen
  open "$ZIEL"
  exit 1
fi

if ! mv "$FRISCH" "$ZIEL"; then
  # Umbenennen ging schief: den alten Stand zurückholen.
  mv "$ALT" "$ZIEL" 2>/dev/null
  aufraeumen
  open "$ZIEL"
  exit 1
fi

rm -rf "$ALT"
hdiutil detach "$ABBILD" -force >/dev/null 2>&1
open "$ZIEL"
rm -f "$0"
`, { mode: 0o700 });

  spawn('/bin/bash', [skript], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Windows: der NSIS-Installer kann still laufen und die App danach starten.
 */
async function installiereWindows(datei: string): Promise<void> {
  spawn(datei, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Linux: läuft die App als AppImage, wird die Datei ersetzt. Sonst bleibt nur
 * der alte Weg über das Paketwerkzeug.
 */
async function installiereLinux(datei: string): Promise<void> {
  const appimage = process.env.APPIMAGE;
  if (!appimage) throw new Error('Kein AppImage — bitte das Paket von Hand installieren.');

  /* Für Linux gibt es serverseitig nur einen Platz, und dort kann auch ein .deb
     liegen. Über ein laufendes AppImage kopiert, wäre die App unwiderruflich
     hin — ein Debian-Paket startet nicht. Lieber von Hand installieren. */
  if (!/\.appimage$/i.test(datei)) {
    throw new Error('Die geladene Datei ist kein AppImage — bitte von Hand installieren.');
  }

  const skript = path.join(os.tmpdir(), `stellium-update-${Date.now()}.sh`);
  fs.writeFileSync(skript, `#!/bin/bash
# Von Stellium erzeugt. Ersetzt das AppImage, sobald es beendet ist.
sleep 2
cp -f ${JSON.stringify(datei)} ${JSON.stringify(appimage)}
chmod +x ${JSON.stringify(appimage)}
${JSON.stringify(appimage)} &
rm -f "$0"
`, { mode: 0o755 });

  spawn('/bin/bash', [skript], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Installiert die geladene Version und startet Stellium neu.
 *
 * Schlägt der eigene Weg fehl, wird die Datei geöffnet — dann übernimmt die
 * Person. Lieber ein Handgriff mehr als eine App, die nach einem misslungenen
 * Austausch gar nicht mehr startet.
 */
export async function installieren(): Promise<boolean> {
  if (installiertGerade) return true;
  if (!bereit || !fs.existsSync(bereit.datei)) return false;
  installiertGerade = true;
  // Sonst startet das app.quit() weiter unten über 'before-quit' einen zweiten Lauf.
  installiertBeimBeenden = false;
  if (frist) { clearTimeout(frist); frist = null; }

  try {
    /* Zwischen Laden und Einspielen liegt oft eine Stunde, in der die Datei
       offen im Benutzerordner liegt. Vor dem Ausführen also noch einmal
       nachrechnen, ob es wirklich dieselbe Datei ist. */
    if (erwarteteSumme) {
      const jetzt = await summeVonDatei(bereit.datei);
      if (jetzt !== erwarteteSumme) {
        fs.rmSync(bereit.datei, { force: true });
        bereit = null;
        installiertGerade = false;
        melden('update:error', {
          message: 'Die geladene Datei hat sich verändert und wurde verworfen. Stellium lädt sie neu.',
        });
        return false;
      }
    }
    vermerken(bereit.version, letzteNotizen);
    if (process.platform === 'darwin') await installiereMac(bereit.datei);
    else if (process.platform === 'win32') await installiereWindows(bereit.datei);
    else await installiereLinux(bereit.datei);

    melden('update:installing', { version: bereit.version });
    // Kurz Luft lassen, damit die Meldung noch ankommt.
    setTimeout(() => app.quit(), 900);
    return true;
  } catch (err) {
    installiertGerade = false;
    melden('update:error', {
      message: `Der Austausch ist fehlgeschlagen (${(err as Error).message}). Die Datei wird geöffnet.`,
    });
    await shell.openPath(bereit.datei);
    return true;
  }
}
