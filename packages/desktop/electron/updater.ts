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

  const ordner = path.join(os.tmpdir(), 'stellium-updates');
  fs.mkdirSync(ordner, { recursive: true });
  const ziel = path.join(ordner, `${update.version}-${update.fileName}`);

  try {
    const antwort = await fetch(`${serverUrl}${update.url}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!antwort.ok || !antwort.body) throw new Error(`Download fehlgeschlagen (${antwort.status})`);

    const gesamt = update.size;
    let geladen = 0;
    const stuecke: Buffer[] = [];
    // Der Body ist in Node ein async-iterierbarer Web-Stream.
    for await (const stueck of antwort.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(stueck);
      stuecke.push(buf);
      geladen += buf.byteLength;
      melden('update:progress', { version: update.version, geladen, gesamt });
    }

    const daten = Buffer.concat(stuecke);
    const summe = createHash('sha256').update(daten).digest('hex');
    if (summe !== update.sha256) {
      throw new Error('Die geladene Datei stimmt nicht mit der Prüfsumme überein.');
    }

    fs.writeFileSync(ziel, daten);
    bereit = { version: update.version, datei: ziel };
    letzteNotizen = update.notes;
    melden('update:ready', { version: update.version, datei: ziel, notes: update.notes });
    // Ab jetzt läuft die Uhr — es sei denn, jemand verschiebt sie.
    if (!installiertBeimBeenden) fristStarten();
  } catch (err) {
    melden('update:error', { message: (err as Error).message });
  }
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
  const skript = path.join(os.tmpdir(), `stellium-update-${Date.now()}.sh`);
  fs.writeFileSync(skript, `#!/bin/bash
# Von Stellium erzeugt. Tauscht die App aus, während sie beendet ist.
for i in $(seq 1 40); do
  pgrep -x Stellium >/dev/null || break
  sleep 0.25
done
rm -rf ${JSON.stringify(ziel)}
cp -R ${JSON.stringify(neu)} ${JSON.stringify(ziel)}
xattr -dr com.apple.quarantine ${JSON.stringify(ziel)} 2>/dev/null
hdiutil detach ${JSON.stringify(einhaengepunkt)} -force >/dev/null 2>&1
open ${JSON.stringify(ziel)}
rm -f "$0"
`, { mode: 0o755 });

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
  if (!bereit || !fs.existsSync(bereit.datei)) return false;
  if (frist) { clearTimeout(frist); frist = null; }

  vermerken(bereit.version, letzteNotizen);

  try {
    if (process.platform === 'darwin') await installiereMac(bereit.datei);
    else if (process.platform === 'win32') await installiereWindows(bereit.datei);
    else await installiereLinux(bereit.datei);

    melden('update:installing', { version: bereit.version });
    // Kurz Luft lassen, damit die Meldung noch ankommt.
    setTimeout(() => app.quit(), 900);
    return true;
  } catch (err) {
    melden('update:error', {
      message: `Der Austausch ist fehlgeschlagen (${(err as Error).message}). Die Datei wird geöffnet.`,
    });
    await shell.openPath(bereit.datei);
    return true;
  }
}
