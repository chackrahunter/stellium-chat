import { contextBridge, ipcRenderer } from 'electron';

/**
 * Eigene, enge Brücke für das Benachrichtigungsfenster.
 *
 * Bewusst NICHT dieselbe wie electron/preload.ts: diese Seite zeigt fremden
 * Text aus einem Chat (Absendername, Nachrichtentext) an. Sie bekommt darum
 * nur, was sie zum Anzeigen und zum Melden von Klicks braucht — nichts von
 * dem, was die Hauptoberfläche sonst noch kann (Fernsteuerung, Updates,
 * Einstellungen). contextIsolation bleibt an, nodeIntegration aus.
 */
const api = {
  /** Der vollständige, aktuelle Stapel — neueste Karte zuerst. */
  aufStapel: (ruf: (karten: unknown[]) => void) => {
    const fn = (_e: unknown, karten: unknown[]) => ruf(karten);
    ipcRenderer.on('mac-notify:stack', fn);
    return () => ipcRenderer.off('mac-notify:stack', fn);
  },
  aufTheme: (ruf: (stand: { dunkel: boolean }) => void) => {
    const fn = (_e: unknown, stand: { dunkel: boolean }) => ruf(stand);
    ipcRenderer.on('mac-notify:theme', fn);
    return () => ipcRenderer.off('mac-notify:theme', fn);
  },
  /** Zeit abgelaufen, weggewischt oder auf das Schließzeichen geklickt. */
  verwerfen: (id: string) => ipcRenderer.send('mac-notify:dismiss', id),
  /** Karte selbst angeklickt — der Hauptprozess entfernt sie und springt hin. */
  klicken: (id: string) => ipcRenderer.send('mac-notify:click', id),
  /** "Ich habe den Stapel wirklich gemalt." Erst danach zeigt sich das
   *  Fenster — siehe versucheZuZeigen() in electron/mac-notify.ts. */
  gemalt: () => ipcRenderer.send('mac-notify:gemalt'),
};

contextBridge.exposeInMainWorld('stelliumMacNotify', api);
export type MacNotifyBridge = typeof api;
