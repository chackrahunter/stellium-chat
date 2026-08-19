import { app, BrowserWindow, Menu, Notification, shell, ipcMain, nativeTheme, Tray, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  updaterInit, updaterAnmelden, updaterAbmelden, pruefen, installieren, letztesUpdate,
  fristVerschieben, beimBeendenInstallieren,
} from './updater.js';

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

/** Kleines Sternsymbol für das Tray — als Data-URI, damit keine Datei nötig ist. */
function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <path d="M16 3l3.2 8.6L28 14l-8.8 2.4L16 25l-3.2-8.6L4 14l8.8-2.4z" fill="black"/></svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  const resized = img.resize({ width: 16, height: 16 });
  resized.setTemplateImage(true);
  return resized;
}

/**
 * Das Programmsymbol für Meldungen.
 *
 * Windows und die meisten Linux-Desktops zeigen sonst einen namenlosen grauen
 * Kasten. Im Paket liegt das Symbol neben den Programmdateien, in der
 * Entwicklung im Quellordner — beide Wege werden probiert.
 */
function symbolPfad(): string | undefined {
  const kandidaten = [
    path.join(process.resourcesPath ?? '', 'icon.png'),
    path.join(here, '../build/icon.png'),
    path.join(here, '../../build/icon.png'),
  ];
  return kandidaten.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
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

ipcMain.handle('app:info', () => ({
  locale: app.getLocale(),
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
  isDev,
}));

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
    mainWindow.setOverlayIcon(count > 0 ? trayIcon() : null, count > 0 ? `${count} ungelesen` : '');
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
