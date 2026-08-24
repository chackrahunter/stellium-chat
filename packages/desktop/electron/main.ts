import { app, BrowserWindow, clipboard, Menu, Notification, session, shell, ipcMain, nativeTheme, Tray, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  updaterInit, updaterAnmelden, updaterAbmelden, pruefen, installieren, letztesUpdate,
  fristVerschieben, beimBeendenInstallieren,
} from './updater.js';
import { fernsteuerungEinrichten, fernsteuerungBeenden } from './fernsteuerung.js';
import { macNotifyEinrichten } from './mac-notify.js';
import { t, spracheSetzen, anfangsSpracheSetzen } from './i18n.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
const DEV_ORIGIN = new URL(DEV_URL).origin;
/* Die einzige Datei, die im gepackten Fenster laufen darf — ein Pfad, kein
   Ursprung. Siehe navigationsEntscheidung() weiter unten, wieso das den
   Unterschied macht. */
const EIGENER_EINTRAG = pathToFileURL(path.join(here, '../dist/index.html'));

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

/**
 * Ob eine Adresse überhaupt so aussieht, dass sie in den echten Browser darf.
 * Ein reiner Textvergleich (früher `/^https?:/` bzw. `/^https?:\/\//` an den
 * betroffenen Stellen, leicht uneinheitlich) tolerierte Kleinigkeiten, die ein
 * echtes Parsen nicht durchlässt. `new URL()` wirft bei Unsinn, und genau das
 * ist hier der gewünschte Fall — dann eben nicht öffnen.
 */
function istHttpUrl(url: string): boolean {
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
}

/**
 * Darf eine Adresse im Fenster selbst laufen (Navigation), muss sie in den
 * Systembrowser, oder gehört sie nirgendwohin?
 *
 * DIE FALLE, die hier schon einmal zuschlug: `new URL('file:///x').origin`
 * ist NICHT der String `"file://"`, sondern wörtlich `"null"` — file: hat
 * keinen Host und keinen Port, die URL-Spezifikation nennt das einen
 * "opaken" Ursprung und gibt dafür immer genau diesen String aus. Selbst
 * nachgerechnet: `new URL('file:///x').origin === 'null'` (der String, nicht
 * der Wert `null`). Ein Vergleich `target.origin === 'file://'` schlägt
 * darum IMMER fehl — für jede file://-Adresse, auch für harmlose.
 *
 * Die alte Fassung dieser Funktion fing genau das mit
 * `|| target.protocol !== 'file:'` ab — und öffnete damit im gepackten
 * Programm nicht nur die eigene dist/index.html im Fenster, sondern JEDE
 * file://-Adresse, ganz gleich woher sie kam (entgegen dem, was der
 * Kommentar darüber versprach). Gleichzeitig fiel die Bedingung für alles
 * andere auf `target.protocol !== 'file:'` zusammen — jede http(s)-Adresse
 * ging damit ungeprüft an `shell.openExternal`, anders als an den beiden
 * Nachbarstellen (`setWindowOpenHandler` oben, der `shell:open`-Handler
 * weiter unten), die beide schon vorher auf ein Schema prüften.
 *
 * Deshalb hier: für file: ein PFADVERGLEICH gegen die eine Datei, die im
 * gepackten Fenster laufen darf — kein Ursprungsvergleich. Für alles andere
 * ein echtes Parsen plus Protokollprüfung, bevor überhaupt an
 * `shell.openExternal` gedacht wird. Wer diese Funktion ändert: bitte diesen
 * Kommentar mitziehen, sonst schleicht sich dieselbe Falle beim nächsten Mal
 * genauso wieder ein.
 */
function navigationsEntscheidung(url: string): 'erlauben' | 'extern' | 'verweigern' {
  let ziel: URL;
  try { ziel = new URL(url); } catch { return 'verweigern'; }

  const erlaubt = isDev
    ? ziel.origin === DEV_ORIGIN
    : ziel.protocol === 'file:' && ziel.pathname === EIGENER_EINTRAG.pathname;
  if (erlaubt) return 'erlauben';

  return istHttpUrl(url) ? 'extern' : 'verweigern';
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
      // sandbox: true wurde erwogen und bewusst zurückgestellt — bei einem
      // Zehn-Personen-internen Werkzeug ist der zusätzliche Nutzen gering,
      // und die Nebenwirkungen ließen sich gerade nicht sauber durchtesten.
      // Kein Grund, das bei der nächsten Durchsicht ungefragt neu
      // aufzurollen, ohne diesen Hintergrund zu kennen.
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
    if (istHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const entscheidung = navigationsEntscheidung(url);
    if (entscheidung === 'erlauben') return;
    event.preventDefault();
    if (entscheidung === 'extern') void shell.openExternal(url);
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

/**
 * Beschriftungen aus t() (electron/i18n.ts) — nie fest im Code. Läuft nicht
 * nur einmal: spracheUebernehmen() ruft dies bei jedem Sprachwechsel aus der
 * Ansicht erneut auf, und Menu.setApplicationMenu() ersetzt das bestehende
 * Menü dabei einfach durch das neue.
 *
 * 'Stellium' im Apple-Menü, in Fenstertitel & Meldungstitel bleibt überall
 * unübersetzt stehen — Produktname, siehe scripts/deutsch-finden.mjs
 * (SPRACHNEUTRAL) für dieselbe Regel in der Ansicht.
 */
function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const send = (channel: string) => () => mainWindow?.webContents.send(channel);
  /* Windows-Konvention ist "Exit", nicht "Quit" — anders als macOS/Linux.
     Zwei eigene Schlüssel statt eines mit Sonderfall je Plattform, siehe
     electron/i18n.ts (menu.exit vs. menu.quitShort). */
  const beendenLabel = process.platform === 'win32' ? t('menu.exit') : t('menu.quitShort');

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: 'Stellium',
      submenu: [
        { role: 'about' as const, label: t('menu.about') },
        { type: 'separator' as const },
        { label: t('menu.settings'), accelerator: 'Cmd+,', click: send('menu:settings') },
        { type: 'separator' as const },
        { role: 'hide' as const, label: t('menu.hide') },
        { role: 'hideOthers' as const, label: t('menu.hideOthers') },
        { role: 'unhide' as const, label: t('menu.unhide') },
        { type: 'separator' as const },
        { role: 'quit' as const, label: t('menu.quit') },
      ],
    }] : []),
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newChannel'), accelerator: 'CmdOrCtrl+Shift+N', click: send('menu:new-channel') },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' as const, label: t('menu.closeWindow') }]
                  : [{ label: t('menu.settings'), accelerator: 'Ctrl+,', click: send('menu:settings') },
                     { type: 'separator' as const },
                     { role: 'quit' as const, label: beendenLabel }]),
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.go'),
      submenu: [
        { label: t('menu.quickSwitch'), accelerator: 'CmdOrCtrl+K', click: send('menu:quick-switch') },
        { label: t('menu.search'), accelerator: 'CmdOrCtrl+F', click: send('menu:search') },
        { type: 'separator' },
        // Derselbe Schlüssel wie die Seitenleiste (nav.catchup) — ein Text,
        // zwei Stellen, kein eigener Menü-Schlüssel nötig.
        { label: t('nav.catchup'), accelerator: 'CmdOrCtrl+Shift+U', click: send('menu:catchup') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'reload', label: t('menu.reload') },
        { role: 'toggleDevTools', label: t('menu.toggleDevTools') },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.actualSize') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullScreen') },
      ],
    },
    {
      role: 'window',
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoomWindow') },
      ],
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

/**
 * Nur das Kontextmenü des Tray-Symbols — eigene Funktion, getrennt von
 * createTray(), weil ein Sprachwechsel (spracheUebernehmen()) dieses Menü
 * neu bauen muss, das Tray-SYMBOL selbst aber unangetastet bleiben soll.
 * new Tray(...) ein zweites Mal aufzurufen würde ein zweites Symbol in der
 * Leiste erzeugen statt das bestehende zu ersetzen.
 */
function trayMenuAktualisieren(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.open'), click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: process.platform === 'win32' ? t('menu.exit') : t('menu.quitShort'),
      click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Stellium');
    trayMenuAktualisieren();
    tray.on('click', () => {
      if (mainWindow?.isVisible()) mainWindow.hide();
      else { mainWindow?.show(); mainWindow?.focus(); }
    });
  } catch {
    // Auf manchen Linux-Desktops gibt es kein Tray — kein Grund zum Abbruch.
  }
}

/**
 * Von der Ansicht gemeldete Oberflächensprache übernehmen (state/store.ts,
 * applyTheme → window.stellium.setLanguage) und alles neu aufbauen, was der
 * Hauptprozess selbst beschriftet. Menü und Tray-Menü sind natives UI, das
 * die Ansicht nicht selbst umschreiben kann — sie ziehen hier nach, ohne
 * dass die App neu starten muss.
 */
function spracheUebernehmen(sprache: string): void {
  spracheSetzen(sprache);
  buildMenu();
  trayMenuAktualisieren();
}

/* ── Selbstaktualisierung ─────────────────────────────────────── */

/* updaterAnmelden() liefert jetzt ein Promise<boolean>: false heißt, die
   Person hat einen abweichenden Update-Ursprung im Bestätigungsdialog
   abgelehnt (siehe updater.ts, herkunftWechselBestaetigen). ipcMain.handle
   wartet auf zurückgegebene Promises von selbst — keine eigene Umschließung
   nötig. */
ipcMain.handle('update:signin', (_e, { url, token }: { url: string; token: string }) =>
  updaterAnmelden(url, token));
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
 * Die Ansicht meldet ihre tatsächliche Oberflächensprache, sobald sie sie
 * kennt, und erneut bei jeder Änderung (state/store.ts, applyTheme).
 *
 * Warum das nötig ist: das Menü entsteht bei app.whenReady(), lange bevor
 * die Ansicht überhaupt geladen hat — zu dem Zeitpunkt ist app.getLocale()
 * (die Systemsprache) das Einzige, was bekannt ist. Die eingestellte
 * Oberflächensprache eines Kontos kann davon abweichen (fremder Rechner,
 * bewusst andere Wahl) und sich zur Laufzeit ändern (Einstellungen). Ein
 * einfaches ipcMain.on statt .handle: die Ansicht wartet auf keine Antwort,
 * und "wurde x-mal aufgerufen, letzter Wert gewinnt" ist hier genau richtig.
 */
ipcMain.on('app:language', (_e, sprache: unknown) => {
  if (typeof sprache === 'string' && sprache) spracheUebernehmen(sprache);
});

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
    // Nur eine Beschreibung für Screenreader/Kurzinfo — kein sichtbarer Text
    // auf dem Abzeichen selbst. Derselbe Schlüssel wie im Postfach-Untertitel
    // (post.untertitelUngelesen), hier ohne eigene Mehrzahlform: bislang trug
    // schon die deutsche Fassung nur die eine Form für jede Zahl.
    mainWindow.setOverlayIcon(
      count > 0 ? abzeichenIcon() : null,
      count > 0 ? t('post.untertitelUngelesen', { n: count }) : '',
    );
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
  if (istHttpUrl(url)) void shell.openExternal(url);
  return true;
});

/* ── Zwischenablage für den Passwort-Tresor ───────────────────────
 *
 * WARUM DAS ÜBERHAUPT HIER OBEN LIEGT UND NICHT IN DER ANSICHT
 *
 * Der Tresor legt ein Passwort in die Zwischenablage und holt es zwanzig
 * Sekunden später wieder heraus — aber nur, wenn inzwischen nichts anderes
 * hineingelegt wurde (sonst risse er jemandem eine fremde Kopie weg). Für
 * diesen Vergleich muss man die Ablage LESEN, und genau das kann der
 * Renderer nicht:
 *
 *   · `navigator.clipboard.readText()` läuft über den Berechtigungs-Handler
 *     weiter unten in whenReady(), und der sagt zu allem außer Ton nein;
 *   · Chromium verweigert das Lesen ohnehin, solange das Dokument nicht den
 *     Fokus hat — und der ganze Sinn des Kopierens ist, dass die Person
 *     gerade in einem ANDEREN Fenster einfügt;
 *   · der Aufruf steckt in einem Timer, hat also keine frische
 *     Nutzerhandlung im Rücken.
 *
 * Jede dieser drei Hürden allein genügt, damit das Aufräumen nie läuft. Der
 * Hauptprozess kennt keine davon und benutzt Electrons `clipboard` schon in
 * fernsteuerung.ts.
 *
 * DER VERGLEICH BLEIBT HIER OBEN. Es wäre einfacher gewesen, ein blankes
 * `readText()` über die Brücke zu reichen — dann könnte die Ansicht (und
 * jedes Skript, das je in sie hineingerät) die Zwischenablage des ganzen
 * Rechners auslesen. Der Renderer schickt darum den Wert HINEIN und bekommt
 * nur ein Ja/Nein zurück; der Inhalt der Ablage verlässt diesen Prozess
 * nicht.
 */
ipcMain.handle('ablage:schreiben', (_e, wert: unknown) => {
  if (typeof wert !== 'string') return false;
  clipboard.writeText(wert);
  return true;
});

/* Leert die Ablage, WENN dort noch genau `wert` steht. Antwort: ob der Wert
   danach weg ist — auch dann true, wenn längst etwas anderes drinsteht, denn
   auch dann liegt das Passwort nicht mehr in der Ablage. `false` heißt
   ehrlich "steht noch drin", und die Ansicht sagt es der Person. */
ipcMain.handle('ablage:leerenWennUnveraendert', (_e, wert: unknown) => {
  if (typeof wert !== 'string') return false;
  if (clipboard.readText() !== wert) return true;
  /* clipboard.clear() statt writeText(''): ein leerer String bleibt auf
     macOS ein Eintrag in der Ablage — inhaltlich leer, aber vorhanden, und
     Verlaufsprogramme führen ihn als eigene Kopie. */
  clipboard.clear();
  return clipboard.readText() !== wert;
});

/* ── Der Wiederherstellungs-Code des Notzugangs ───────────────── */

/**
 * Der gesprochene Code einer laufenden Wiederherstellung — im ARBEITSSPEICHER
 * dieses Prozesses, sonst nirgends.
 *
 * WAS DAS BEHEBT. Der Code entstand in einem `useState` der Tafel
 * (src/components/NotzugangPanel.tsx) und starb mit ihr. Die ANFRAGE lebt
 * beim Server weiter und läuft erst nach Stunden ab; der Code nicht. Wer die
 * Tafel schloss, während er auf drei Kolleginnen wartete, oder wessen Fenster
 * sich neu lud, hatte anschließend eine offene Anfrage, zu der es keinen Code
 * mehr gab — einlösen ging nicht mehr, abbrechen und alle noch einmal anrufen
 * war der einzige Ausweg.
 *
 * WARUM HIER UND NICHT IM localStorage. Der Code ist das ZWEITE von zwei
 * Schlössern: jeder Beitrag ist innen für den privaten Teil dieses Geräts
 * verschlossen und außen mit dem Code. Der private Teil liegt im localStorage
 * (siehe src/lib/vertraulich.ts). Den Code daneben zu legen, hieße, beide
 * Schlösser in dieselbe Schublade zu tun — wer die Platte hat, hätte dann
 * beide. Hier oben liegt er in einem anderen Prozess, wird NIE geschrieben,
 * NIE protokolliert und ist beim nächsten Start des Programms weg.
 *
 * WAS ES EHRLICHERWEISE NICHT LEISTET. Die Ansicht kann ihn zurückholen —
 * sie muss ja, sie zeigt ihn an und rechnet damit. Ein Skript, das in den
 * Renderer gerät, kann denselben Aufruf machen. Es könnte allerdings
 * genauso gut den angezeigten Code aus dem Fenster lesen, solange die Tafel
 * offen ist; der Zugewinn eines Angreifers ist also klein, der Zugewinn an
 * Bedienbarkeit groß. Und: das Programm zu beenden kostet den Code weiterhin.
 * Das ist der Preis dafür, dass er nirgends auf einer Platte landet.
 *
 * Genau EINE Anfrage, nicht eine Liste: es gibt je Konto höchstens eine
 * offene (services/notzugang.ts, anfragen()), und ein Fenster zeigt ein
 * Konto. Der Abruf verlangt dieselbe Anfragekennung, unter der gemerkt
 * wurde — nach einem Abbruch und einer neuen Anfrage kommt der alte Code
 * damit nicht versehentlich zurück.
 */
let notzugangCode: { anfrageId: string; code: string } | null = null;

ipcMain.handle('notzugang:code-merken', (_e, anfrageId: unknown, code: unknown) => {
  if (typeof anfrageId !== 'string' || typeof code !== 'string' || !anfrageId || !code) return false;
  notzugangCode = { anfrageId, code };
  return true;
});

ipcMain.handle('notzugang:code-holen', (_e, anfrageId: unknown) => {
  if (typeof anfrageId !== 'string') return null;
  return notzugangCode && notzugangCode.anfrageId === anfrageId ? notzugangCode.code : null;
});

/* Nach dem Einlösen und nach dem Abbrechen. Ein Code, der noch dasteht,
   nachdem die Anfrage geschlossen ist, ist ein Geheimnis ohne Zweck. */
ipcMain.handle('notzugang:code-vergessen', () => {
  notzugangCode = null;
  return true;
});

/* ── Lifecycle ────────────────────────────────────────────────── */

/* Ohne diese Kennung zeigt Windows überhaupt keine Meldungen an — es ordnet
   sie keinem Programm zu und verwirft sie stillschweigend. Muss vor der ersten
   Benachrichtigung stehen und dieselbe sein wie im Installationspaket. */
if (process.platform === 'win32') app.setAppUserModelId('com.stellium.chat');

void app.whenReady().then(() => {
  /* Ohne eigenen Handler nickt Electron jede Berechtigungsanfrage einfach
     durch. Das gilt fensterübergreifend: Hauptfenster, Fernsteuerungs-
     Betrachter (fernsteuerung.ts) und die macOS-Benachrichtigung
     (mac-notify.ts) setzen alle drei keine eigene `partition` in ihren
     webPreferences, laufen also alle in derselben defaultSession — ein
     einziger Handler hier deckt alle drei ab. Gebraucht wird einzig das
     Mikrofon für VoiceRecorder; alles andere (Kamera, Standort, Bluetooth,
     Sensoren, …) bekommt hier niemand, auch nicht auf Nachfrage.

     `clipboard-read` läuft ausdrücklich MIT hier hindurch und wird also
     abgelehnt. Das ist so gewollt und bleibt so: der Passwort-Tresor
     braucht das Lesen der Ablage nur, um seine eigene Kopie wieder
     wegzuräumen, und dafür gibt es 'ablage:leerenWennUnveraendert' weiter
     oben — der Vergleich passiert dort im Hauptprozess, und der Inhalt der
     Ablage kommt nie in der Ansicht an. Wer hier `clipboard-read`
     durchlässt, macht diesen Umweg überflüssig und gibt gleichzeitig jedem
     Skript in der Ansicht die Zwischenablage des ganzen Rechners. */
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const nurTon = permission === 'media'
      && 'mediaTypes' in details
      && Array.isArray(details.mediaTypes)
      && details.mediaTypes.every((art) => art === 'audio');
    callback(nurTon);
  });

  nativeTheme.themeSource = 'dark';
  // Vor dem ersten Menüaufbau: die Systemsprache ist die einzige Angabe, die
  // an dieser Stelle schon existiert (siehe Kommentar bei 'app:language').
  anfangsSpracheSetzen();
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
