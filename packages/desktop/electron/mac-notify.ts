import { BrowserWindow, app, ipcMain, nativeTheme, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Selbstgezeichnete macOS-Benachrichtigung — ein eigenes, zweites Fenster.
 *
 * WARUM DAS ÜBERHAUPT EXISTIERT
 * Echte Systembenachrichtigungen (siehe main.ts, `meldungenMoeglich()`)
 * kommen ohne Entwicklersignatur nicht durch die Mitteilungszentrale — sie
 * gehen lautlos ins Leere. Dieses Fenster ist der Ersatz: kein Nachbau zur
 * Täuschung, sondern die übliche Anpassung an die Plattform. Eine Meldung aus
 * Stellium soll sich auf einem Mac anfühlen wie alles andere auf diesem Mac.
 *
 * NUR macOS. `macNotifyEinrichten()` prüft das selbst — der Aufrufer in
 * main.ts muss die Plattform nicht kennen, siehe Funktionskopf unten.
 *
 * EIN FENSTER FÜR DEN GANZEN STAPEL, NICHT EINS JE MELDUNG
 * Mehrere eigene Fenster hätten pro Meldung ihre eigene Ebene, ihre eigene
 * Position, ihren eigenen Eintrag in setVisibleOnAllWorkspaces — und beim
 * Verschieben eines Bildschirms oder beim Wechsel des Vollbild-Schreibtischs
 * müssten alle synchron bleiben. Ein Fenster mit einer kleinen Liste darin
 * ist der Zustand an EINER Stelle: der Hauptprozess führt die Liste, das
 * Fenster zeichnet sie. Siehe src/mac-notify/main.ts für die Gegenseite.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

/**
 * Geometrie der Karten.
 *
 * MUSS zu den Maßen in src/styles/mac-notify.css passen (dort als Kommentar
 * wiederholt). Zwei Quellen für dieselbe Zahl sind hier nicht zu vermeiden:
 * der Hauptprozess kennt kein CSS, und die Karte kennt keine Bildschirmränder.
 * Wer eine der beiden Zahlen ändert, ändert sie an beiden Stellen — sonst
 * schneidet das Fenster die Karte ab oder lässt Luft übrig.
 */
const KARTE_BREITE = 360;
const KARTE_HOEHE = 76;
const KARTE_ABSTAND = 8;
/** Höchstens so viele gleichzeitig — ältere weichen. Siehe zeigeKarte(). */
const MAX_KARTEN = 4;
/** Platz um den sichtbaren Stapel herum, nur für den CSS-Schatten der Karten
 *  — ohne diesen Puffer schneidet die Fensterkante ihn hart ab. */
const PUFFER = { oben: 16, unten: 40, seite: 28 };
/** Abstand der obersten/rechtesten Karte zum Bildschirmrand — derselbe, den
 *  macOS für die eigene Mitteilungszentrale unter der Menüleiste benutzt. */
const RAND_OBEN = 12;
const RAND_RECHTS = 12;

export interface MacNotifyEingabe {
  titel: string;
  text: string;
  /** Sprache der Oberfläche zum Zeitpunkt des Auftretens, z. B. "de" — der
   *  Hauptprozess kennt keine Benutzereinstellung, nur der App-Renderer. */
  sprache: string;
  /** Wohin ein Klick führt. Ob Kanal, Direktnachricht oder ein Vorschlag
   *  dahintersteckt, spielt hier keine Rolle — alle drei sind schon heute
   *  ein und derselbe Kanal (siehe state/vorschlaege.ts, das einen Vorschlag
   *  über kanalId meldet). Fehlt sie, öffnet ein Klick nur die App. */
  kanalId?: string;
  /** Gleiche Gruppe ersetzt eine schon sichtbare Karte, statt zu stapeln —
   *  genau die Regel, die auch die echte Notification (siehe
   *  lib/benachrichtigung.ts) über `tag` schon anwendet. */
  gruppe?: string;
}

export interface MacNotifyKarte extends MacNotifyEingabe {
  id: string;
  erstelltAm: number;
}

let fenster: BrowserWindow | null = null;
let fensterBereit = false;
let stapel: MacNotifyKarte[] = [];
let naechsteId = 1;

function kuerze(text: string, max: number): string {
  const einzeilig = text.replace(/\s+/g, ' ').trim();
  return einzeilig.length > max ? `${einzeilig.slice(0, max - 1).trimEnd()}…` : einzeilig;
}

function fensterHoehe(anzahl: number): number {
  if (anzahl === 0) return 1;
  return PUFFER.oben + anzahl * KARTE_HOEHE + (anzahl - 1) * KARTE_ABSTAND + PUFFER.unten;
}

/**
 * Auf welchem Bildschirm gerade gearbeitet wird.
 *
 * Stellium hängt in genau dem Moment im Hintergrund, in dem diese Frage
 * interessant wird — das eigene Fenster ist also kein brauchbarer Hinweis.
 * Der Mauszeiger ist die einfachste Näherung an "wo die Person gerade ist",
 * ohne dass der Hauptprozess wissen müsste, welche fremde App gerade vorne
 * liegt.
 */
function zielAnzeige(): Electron.Display {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function fensterBounds(anzahl: number): { x: number; y: number; width: number; height: number } {
  const { workArea } = zielAnzeige();
  const height = fensterHoehe(anzahl);
  const width = KARTE_BREITE + PUFFER.seite * 2;
  // Die rechte/obere Kante der KARTE soll den festen Rand einhalten — nicht
  // die Kante des Fensters, das ringsum den unsichtbaren Schattenpuffer trägt.
  const x = workArea.x + workArea.width - RAND_RECHTS - KARTE_BREITE - PUFFER.seite;
  const y = workArea.y + RAND_OBEN - PUFFER.oben;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function sendeTheme(): void {
  if (!fenster || fenster.isDestroyed() || !fensterBereit) return;
  fenster.webContents.send('mac-notify:theme', { dunkel: nativeTheme.shouldUseDarkColors });
}

function sendeStapel(): void {
  if (!fenster || fenster.isDestroyed() || !fensterBereit) return;
  fenster.webContents.send('mac-notify:stack', stapel);
}

/**
 * Alles zurücksetzen und das Fenster verschwinden lassen — der Notausgang.
 *
 * Zwei ganz verschiedene Anlässe rufen dieselbe Funktion:
 *  1. Der Renderer hängt oder ist abgestürzt (siehe die drei webContents-
 *     Ereignisse weiter unten). Eine Benachrichtigung, die dann stehen
 *     bleibt und sich nicht wegklicken lässt, ist schlimmer als gar keine.
 *  2. Ganz gewöhnlich: der Stapel ist leer.
 * `destroy()` statt `hide()` bei einem hängenden Fenster — ein zerschossener
 * Renderer reagiert auf IPC ohnehin nicht mehr, `hide()` allein bliebe
 * folgenlos.
 */
function notbremse(): void {
  stapel = [];
  if (fenster && !fenster.isDestroyed()) fenster.destroy();
  fenster = null;
  fensterBereit = false;
  zeigenAusstehend = false;
}

/** Gesetzt, sobald das Fenster erscheinen SOLL, aber der Inhalt noch nicht
 *  bestätigt gemalt ist — siehe versucheZuZeigen(). */
let zeigenAusstehend = false;

/**
 * Erst zeigen, wenn die Seite den Empfang wirklich bestätigt hat.
 *
 * showInactive() direkt nach dem Erzeugen bzw. direkt nach dem IPC-Versand
 * gerufen, zeigte auf diesem Rechner ein dauerhaft leeres Fenster: die
 * Karten kamen im DOM an (geprüft), das Fenster blieb trotzdem unbemalt.
 * Der Fehler verschwand, sobald das Zeigen bis nach dem ersten bestätigten
 * Bild wartete. Die Bestätigung kommt über 'mac-notify:gemalt' vom
 * Renderer (zwei requestAnimationFrame, siehe src/mac-notify/main.ts); ein
 * Netz mit fester Frist fängt den Fall ab, dass die Bestätigung ausbleibt.
 */
function versucheZuZeigen(): void {
  if (!zeigenAusstehend || !fenster || fenster.isDestroyed()) return;
  if (stapel.length === 0) { zeigenAusstehend = false; return; }
  zeigenAusstehend = false;
  fenster.showInactive();
}

function stelleFensterSicher(): BrowserWindow {
  if (fenster && !fenster.isDestroyed()) return fenster;

  fensterBereit = false;
  const b = fensterBounds(0);
  fenster = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    // Der Schatten kommt aus CSS (siehe mac-notify.css) — der native wäre ein
    // hartes Rechteck um die runden Ecken, weil er die Fensterform nicht kennt.
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    // Darf NIE Tastaturfokus ziehen — auch nicht durch einen versehentlichen
    // Klick, während jemand tippt. showInactive() allein reicht als Schutz
    // nicht: das hier ist die zweite Sperre auf Fensterebene.
    focusable: false,
    skipTaskbar: true,
    show: false,
    roundedCorners: true,
    /* BEWUSST OHNE vibrancy. Der erste Anlauf hatte 'menu'-Vibrancy — auf
       diesem Rechner erschien dahinter ein zusätzlicher, sichtbar größerer
       grauer Kasten mit eigener Rundung, der über die Karte hinausragte
       (in allen getesteten Kombinationen aus roundedCorners/focusable,
       also nicht an denen gelegen). Ohne vibrancy verschwand der Kasten
       vollständig. Den durchscheinenden Eindruck liefert seither die Karte
       selbst: eine Hintergrundfarbe mit Alpha plus backdrop-filter in
       mac-notify.css. */
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(here, 'mac-notify-preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  fenster.setAlwaysOnTop(true, 'screen-saver');
  fenster.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  fenster.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  fenster.webContents.once('did-finish-load', () => {
    fensterBereit = true;
    sendeTheme();
    sendeStapel();
    // Netz für den Fall, dass die Bestätigung ausbleibt (siehe
    // versucheZuZeigen) — lieber spät sichtbar als nie.
    setTimeout(versucheZuZeigen, 200);
  });
  fenster.on('closed', () => { fenster = null; fensterBereit = false; });

  /* Der Notausgang für den Fall, dass etwas schiefgeht. Eine Benachrichtigung,
     die stehen bleibt und sich nicht wegklicken lässt, ist schlimmer als gar
     keine — darum hier lieber zu misstrauisch als zu nachsichtig. */
  fenster.webContents.on('unresponsive', notbremse);
  fenster.webContents.on('render-process-gone', notbremse);
  fenster.webContents.on('did-fail-load', (_e, code) => {
    if (code !== -3) notbremse(); // -3 = ERR_ABORTED, z. B. durch eine eigene Neuladung
  });

  if (isDev) void fenster.loadURL(`${DEV_URL}/mac-notify.html`);
  else void fenster.loadFile(path.join(here, '../dist/mac-notify.html'));

  return fenster;
}

/** Fenstergröße und -sichtbarkeit dem aktuellen Stapel nachziehen. */
function aktualisieren(): void {
  const win = stelleFensterSicher();
  win.setBounds(fensterBounds(stapel.length));
  sendeStapel(); // Inhalt zuerst -- erst danach darf gezeigt werden.
  if (stapel.length === 0) {
    zeigenAusstehend = false;
    if (win.isVisible()) win.hide();
    return;
  }
  if (!win.isVisible()) {
    zeigenAusstehend = true;
    setTimeout(versucheZuZeigen, 200);
  }
}

/**
 * Eine neue Meldung aufnehmen.
 *
 * Dieselbe Gruppe wie eine schon sichtbare Karte ersetzt sie, statt zu
 * stapeln — sonst füllt ein einziger lebhafter Kanal die ganze Ablage.
 * Ohne Gruppe gilt die Kanal-Kennung als Ersatz dafür (wie schon bei der
 * echten Notification, siehe lib/benachrichtigung.ts).
 */
function zeigeKarte(eingabe: MacNotifyEingabe): void {
  const schluessel = eingabe.gruppe ?? eingabe.kanalId;
  const bestehendIndex = schluessel == null ? -1
    : stapel.findIndex((k) => (k.gruppe ?? k.kanalId) === schluessel);

  const id = bestehendIndex >= 0 ? stapel[bestehendIndex].id : `mn-${naechsteId++}`;
  if (bestehendIndex >= 0) stapel.splice(bestehendIndex, 1);

  const karte: MacNotifyKarte = { ...eingabe, id, erstelltAm: Date.now() };
  // Neueste zuerst; die Obergrenze wirft die älteste automatisch hinten raus.
  stapel = [karte, ...stapel].slice(0, MAX_KARTEN);
  aktualisieren();
}

function verwerfeKarte(id: string): void {
  if (!stapel.some((k) => k.id === id)) return; // war schon weg (Ersatz oder Obergrenze)
  stapel = stapel.filter((k) => k.id !== id);
  aktualisieren();
}

function klickKarte(id: string, holeHauptfenster: () => BrowserWindow | null): void {
  const karte = stapel.find((k) => k.id === id);
  verwerfeKarte(id);
  const haupt = holeHauptfenster();
  if (!haupt || haupt.isDestroyed()) return;
  haupt.show();
  haupt.focus();
  // Derselbe Kanal, auf demselben Weg wie eine echte Systembenachrichtigung
  // ihn öffnet — siehe electron/preload.ts (onNotificationClick) und
  // App.tsx. Absichtlich kein eigener Kanal dafür.
  if (karte?.kanalId) haupt.webContents.send('notification:click', karte.kanalId);
}

/**
 * Einmal beim Start aufrufen — mirror von fernsteuerungEinrichten() in
 * main.ts. Prüft die Plattform selbst; der Aufruf in main.ts bleibt dadurch
 * eine einzige, bedingungslose Zeile.
 */
export function macNotifyEinrichten(holeHauptfenster: () => BrowserWindow | null): void {
  if (process.platform !== 'darwin') return;

  nativeTheme.on('updated', sendeTheme);

  ipcMain.handle('mac-notify:show', (_e, eingabe: MacNotifyEingabe) => {
    if (!eingabe?.titel || !eingabe?.text) return false;
    zeigeKarte({
      titel: kuerze(eingabe.titel, 120),
      // Die zwei Zeilen im CSS begrenzen die sichtbare Länge ohnehin hart —
      // das hier ist nur ein Schutz davor, riesige Zeichenketten überhaupt
      // erst durch IPC und in den Speicher des Anzeigefensters zu schicken.
      text: kuerze(eingabe.text, 400),
      sprache: eingabe.sprache || 'de',
      kanalId: eingabe.kanalId,
      gruppe: eingabe.gruppe,
    });
    return true;
  });

  ipcMain.on('mac-notify:dismiss', (_e, id: string) => verwerfeKarte(id));
  ipcMain.on('mac-notify:click', (_e, id: string) => klickKarte(id, holeHauptfenster));
  // Bestätigung "wirklich gemalt" -- siehe versucheZuZeigen().
  ipcMain.on('mac-notify:gemalt', () => versucheZuZeigen());
}
