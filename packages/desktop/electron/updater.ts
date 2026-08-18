import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app, shell, type BrowserWindow } from 'electron';

/**
 * Selbstaktualisierung über den eigenen Firmenserver.
 *
 * Ablauf: der Renderer meldet Serveradresse und Anmeldetoken, sobald jemand
 * angemeldet ist. Von da an fragt der Hauptprozess stündlich nach einer
 * neueren Version, lädt sie im Hintergrund und prüft die Prüfsumme.
 *
 * Installiert wird bewusst nicht ohne Zutun: die Datei wird geöffnet
 * (DMG, Installer, AppImage) und die Person entscheidet. Ein stilles
 * Ersetzen der laufenden App wäre auf drei Betriebssystemen ohne
 * Signaturkette nicht verlässlich hinzubekommen — und niemand möchte, dass
 * ein Chatfenster sich unangekündigt selbst austauscht.
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

const STUNDE = 60 * 60 * 1000;

let serverUrl: string | null = null;
let token: string | null = null;
let fenster: BrowserWindow | null = null;
let timer: NodeJS.Timeout | null = null;
let laeuft = false;
/** Schon heruntergeladene Version — nicht zweimal ziehen. */
let bereit: { version: string; datei: string } | null = null;

export function updaterInit(win: BrowserWindow): void {
  fenster = win;
}

/** Der Renderer meldet sich, sobald jemand angemeldet ist. */
export function updaterAnmelden(url: string, tok: string): void {
  serverUrl = url.replace(/\/+$/, '');
  token = tok;
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void pruefen(); }, STUNDE);
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
      if (manuell) melden('update:none', { version: app.getVersion() });
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
    melden('update:ready', { version: update.version, datei: ziel, notes: update.notes });
  } catch (err) {
    melden('update:error', { message: (err as Error).message });
  }
}

/** Öffnet die geladene Datei — den Rest erledigt das Betriebssystem. */
export async function installieren(): Promise<boolean> {
  if (!bereit || !fs.existsSync(bereit.datei)) return false;
  await shell.openPath(bereit.datei);
  return true;
}
