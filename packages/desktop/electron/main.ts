import { app, BrowserWindow, Menu, Notification, shell, ipcMain, nativeTheme, Tray, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  updaterInit, updaterAnmelden, updaterAbmelden, pruefen, installieren, letztesUpdate,
  fristVerschieben, beimBeendenInstallieren,
} from './updater.js';
import { fernsteuerungEinrichten, fernsteuerungBeenden } from './fernsteuerung.js';
import { macNotifyEinrichten } from './mac-notify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

/** Nur eine Instanz — ein zweiter Start fokussiert das vorhandene Fenster. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#080b16',
    title: 'Stellium',
    // Auf macOS eine nahtlose Titelleiste, sonst der normale Systemrahmen.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Die Knöpfe liegen in der Rail. Waagerecht mittig (Rail ist 68px breit,
    // die drei Knöpfe zusammen etwa 52px), senkrecht mit etwas Luft nach oben.
    // In den freien Streifen über der Rail. Die Rail ist 68px breit, die drei
    // Knöpfe zusammen etwa 52px — damit sitzen sie mittig darüber.
    trafficLightPosition: process.platform === 'darwin' ? { x: 9, y: 20 } : undefined,
    webPreferences: {
      preload: path.join(here, 'preload.mjs'),
      // Die Systemsprache kennt nur der Hauptprozess. Über ein Startargument
      // liegt sie im Preload sofort bereit — ein IPC-Aufruf käme erst nach
      // dem ersten Bild, die Oberfläche würde kurz auf Deutsch aufblitzen.
      additionalArguments: [`--stellium-locale=${app.getLocale()}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  updaterInit(mainWindow);

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadFile(path.join(here, '../dist/index.html'));
  }

  // Externe Links im Systembrowser öffnen, nie im App-Fenster.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const allowed = isDev ? new URL(DEV_URL).origin : 'file://';
    if (target.origin !== allowed && target.protocol !== 'file:') {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    // Auf macOS bleibt die App im Dock, sonst wird wirklich beendet.
    if (!quitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const send = (channel: string) => () => mainWindow?.webContents.send(channel);

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'Stellium',
      submenu: [
        { role: 'about' as const, label: 'Über Stellium' },
        { type: 'separator' as const },
        { label: 'Einstellungen…', accelerator: 'Cmd+,', click: send('menu:settings') },
        { type: 'separator' as const },
        { role: 'hide' as const, label: 'Stellium ausblenden' },
        { role: 'hideOthers' as const, label: 'Andere ausblenden' },
        { role: 'unhide' as const, label: 'Alle einblenden' },
        { type: 'separator' as const },
        { role: 'quit' as const, label: 'Stellium beenden' },
      ],
    }] : []),
    {
      label: 'Datei',
      submenu: [
        { label: 'Neuer Kanal…', accelerator: 'CmdOrCtrl+Shift+N', click: send('menu:new-channel') },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' as const, label: 'Fenster schließen' }]
                  : [{ label: 'Einstellungen…', accelerator: 'Ctrl+,', click: send('menu:settings') },
                     { type: 'separator' as const },
                     { role: 'quit' as const, label: 'Beenden' }]),
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Widerrufen' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einsetzen' },
        { role: 'selectAll', label: 'Alles auswählen' },
      ],
    },
    {
      label: 'Gehe zu',
      submenu: [
        { label: 'Schnellsuche…', accelerator: 'CmdOrCtrl+K', click: send('menu:quick-switch') },
        { label: 'Suchen…', accelerator: 'CmdOrCtrl+F', click: send('menu:search') },
        { type: 'separator' },
        { label: 'Was habe ich verpasst?', accelerator: 'CmdOrCtrl+Shift+U', click: send('menu:catchup') },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Originalgröße' },
        { role: 'zoomIn', label: 'Größer' },
        { role: 'zoomOut', label: 'Kleiner' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
      ],
    },
    {
      role: 'window',
      label: 'Fenster',
      submenu: [{ role: 'minimize', label: 'Minimieren' }, { role: 'zoom', label: 'Zoomen' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Kleines Sternsymbol für die Menüleiste.
 *
 * Hier stand einmal ein SVG als Data-URI — „damit keine Datei nötig ist".
 * Das war still kaputt: **`nativeImage` kann kein SVG lesen.** Gemessen unter
 * Electron 43.4.1 kam ein leeres Bild heraus (`isEmpty()`, Größe 0×0, auch
 * nach `resize`), und weil `new Tray()` mit einem leeren Bild nicht wirft,
 * fiel es nie auf: in der Menüleiste war einfach nichts zu sehen.
 *
 * Jetzt wird eine echte PNG-Datei geladen, gerastert von
 * scripts/symbole-erzeugen.mjs. `tray@2x.png` findet Electron von selbst.
 */
function trayIcon(): Electron.NativeImage {
  const pfad = bildPfad('tray.png');
  if (!pfad) return nativeImage.createEmpty();
  const img = nativeImage.createFromPath(pfad);
  // macOS wertet bei Vorlagenbildern nur den Alphakanal aus und färbt selbst
  // ein — hell auf dunkler Leiste, dunkel auf heller. Anderswo unerwünscht.
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

/**
 * Das Abzeichen für die Windows-Taskleiste.
 *
 * Nicht dasselbe Bild wie oben: Windows färbt nichts ein, ein schwarzer Stern
 * verschwände auf dunklem Grund. Deshalb ein eigenes, sichtbares Abzeichen.
 */
function abzeichenIcon(): Electron.NativeImage | null {
  const pfad = bildPfad('abzeichen.png');
  return pfad ? nativeImage.createFromPath(pfad) : null;
}

/**
 * Das Programmsymbol für Meldungen.
 *
 * Windows und die meisten Linux-Desktops zeigen sonst einen namenlosen grauen
 * Kasten. Im Paket liegt das Symbol neben den Programmdateien, in der
 * Entwicklung im Quellordner — beide Wege werden probiert.
 */
function bildPfad(name: string): string | undefined {
  const kandidaten = [
    path.join(process.resourcesPath ?? '', name),
    path.join(here, '../build/', name),
    path.join(here, '../../build/', name),
  ];
  return kandidaten.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

function symbolPfad(): string | undefined {
  return bildPfad('icon.png');
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Stellium');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Stellium öffnen', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: 'Beenden', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => {
      if (mainWindow?.isVisible()) mainWindow.hide();
      else { mainWindow?.show(); mainWindow?.focus(); }
    });
  } catch {
    // Auf manchen Linux-Desktops gibt es kein Tray — kein Grund zum Abbruch.
  }
}

/* ── Selbstaktualisierung ─────────────────────────────────────── */

ipcMain.handle('update:signin', (_e, { url, token }: { url: string; token: string }) => {
  updaterAnmelden(url, token);
  return true;
});
ipcMain.handle('update:signout', () => { updaterAbmelden(); return true; });
ipcMain.handle('update:check', () => pruefen(true));
ipcMain.handle('update:install', () => installieren());
ipcMain.handle('update:last', () => letztesUpdate());
ipcMain.handle('update:postpone', () => { fristVerschieben(); return true; });

/* ── IPC ──────────────────────────────────────────────────────── */

/* Fernsteuerung des Pi. Läuft im Hauptprozess, weil der Handschlag scrypt
   braucht — das gibt es in der Browser-Krypto nicht. Nebenwirkung, die uns
   entgegenkommt: der Sitzungsschlüssel bleibt hier und die Ansicht sieht ihn nie. */
fernsteuerungEinrichten(() => mainWindow);

/* Selbstgezeichnete macOS-Benachrichtigung — nur auf dieser Plattform tut sie
   etwas, siehe electron/mac-notify.ts. Dort sitzt auch die ganze Geometrie
   und der Stapel; hier nur der eine Aufruf, der sie an den Draht hängt. */
macNotifyEinrichten(() => mainWindow);

ipcMain.handle('app:info', () => ({
  locale: app.getLocale(),
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
  isDev,
}));

/**
 * Kommen Systembenachrichtigungen hier überhaupt durch?
 *
 * `Notification.isSupported()` sagt nur, ob Electron sie kennt — nicht, ob
 * das System sie annimmt. Auf macOS ist das ein Unterschied mit Folgen: die
 * Mitteilungszentrale nimmt nur Programme mit echter Entwicklersignatur an.
 * Ein ad-hoc signiertes Programm darf `show()` aufrufen, es passiert
 * schlicht nichts — ohne Fehler, ohne Nachfrage, ohne Spur im Protokoll.
 * Auf diesem Rechner nachgesehen: Signature=adhoc, TeamIdentifier not set,
 * und in den Einstellungen der Mitteilungszentrale taucht Stellium nicht auf.
 *
 * Deshalb wird es EINMAL beim Start festgestellt und nach außen gemeldet,
 * damit die Oberfläche nicht behauptet, Benachrichtigungen seien erlaubt,
 * während in Wahrheit keine ankommt.
 */
let systemMeldungenGehen: boolean | null = null;

function meldungenMoeglich(): boolean {
  if (systemMeldungenGehen !== null) return systemMeldungenGehen;
  systemMeldungenGehen = Notification.isSupported();
  if (systemMeldungenGehen && process.platform === 'darwin') {
    try {
      /* Das eigene Programmbündel prüfen. `codesign` gehört zum System und
         ist überall da, wo Stellium läuft. */
      const bündel = app.getAppPath().replace(/\/Contents\/Resources\/app(\.asar)?$/, '');
      const aus = execFileSync('codesign', ['-dv', '--verbose=2', bündel],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) + '';
      systemMeldungenGehen = /TeamIdentifier=(?!not set)/.test(aus);
    } catch (fehler) {
      /* codesign schreibt seine Ausgabe auf stderr — bei Erfolg wie bei
         Fehlschlag. Also auch dort nachsehen, statt blind auf false zu
         gehen. */
      const text = String((fehler as { stderr?: string }).stderr ?? '');
      systemMeldungenGehen = /TeamIdentifier=(?!not set)/.test(text);
    }
  }
  return systemMeldungenGehen;
}

ipcMain.handle('notify:moeglich', () => meldungenMoeglich());

ipcMain.handle('notify', (_e, payload: { title: string; body: string; silent?: boolean; channelId?: string }) => {
  if (!Notification.isSupported()) return false;
  /* Das Symbol macht unter Windows und Linux den Unterschied zwischen einer
     erkennbaren Meldung und einem namenlosen grauen Kasten. Unter macOS nimmt
     das System ohnehin das Programmsymbol. */
  const n = new Notification({
    title: payload.title,
    body: payload.body,
    silent: payload.silent,
    icon: process.platform === 'darwin' ? undefined : symbolPfad(),
  });
  n.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
    if (payload.channelId) mainWindow?.webContents.send('notification:click', payload.channelId);
  });
  n.show();
  return true;
});

ipcMain.handle('badge:set', (_e, count: number) => {
  if (process.platform === 'darwin') {
    app.dock?.setBadge(count > 0 ? String(count) : '');
  } else if (process.platform === 'linux') {
    try { app.setBadgeCount(count); } catch { /* nicht überall unterstützt */ }
  }
  if (process.platform === 'win32' && mainWindow) {
    mainWindow.setOverlayIcon(count > 0 ? abzeichenIcon() : null, count > 0 ? `${count} ungelesen` : '');
  }
  return true;
});

ipcMain.handle('window:flash', () => {
  if (!mainWindow?.isFocused()) mainWindow?.flashFrame(true);
  return true;
});

ipcMain.handle('theme:set', (_e, theme: 'system' | 'dark' | 'light') => {
  nativeTheme.themeSource = theme;
  return nativeTheme.shouldUseDarkColors;
});

ipcMain.handle('shell:open', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  return true;
});

/* ── Lifecycle ────────────────────────────────────────────────── */

/* Ohne diese Kennung zeigt Windows überhaupt keine Meldungen an — es ordnet
   sie keinem Programm zu und verwirft sie stillschweigend. Muss vor der ersten
   Benachrichtigung stehen und dieselbe sein wie im Installationspaket. */
if (process.platform === 'win32') app.setAppUserModelId('com.stellium.chat');

void app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  createWindow();
  buildMenu();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else { mainWindow?.show(); mainWindow?.focus(); }
  });
});

app.on('before-quit', (e) => {
  quitting = true;
  // Eine offene Fernsitzung sauber schließen. Ohne das bliebe auf dem Pi der
  // Abgreifer stehen, bis die Leitung von selbst zusammenbricht — und der
  // nächste Anlauf fände den Platz besetzt ("schon jemand verbunden").
  fernsteuerungBeenden();
  // Wer "später" gewählt hat, bekommt die neue Fassung jetzt — beim Beenden
  // stört sie niemanden mehr. Der Austausch läuft in einem eigenen Prozess
  // weiter, deshalb genügt es, ihn kurz vor dem Ende anzustoßen.
  if (beimBeendenInstallieren()) {
    e.preventDefault();
    void installieren().finally(() => setTimeout(() => app.exit(0), 1200));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
