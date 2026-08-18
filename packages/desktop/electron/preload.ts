import { contextBridge, ipcRenderer } from 'electron';

/** Genau die Fähigkeiten, die das UI braucht — nichts darüber hinaus. */
const api = {
  /**
   * Synchron verfügbar, schon beim ersten Zeichnen. Über den IPC-Aufruf käme
   * die Angabe erst nach dem ersten Bild — auf macOS säßen die Fensterknöpfe
   * bis dahin auf dem Logo.
   */
  platform: process.platform as string,

  info: () => ipcRenderer.invoke('app:info') as Promise<{
    platform: NodeJS.Platform; arch: string; version: string; isDev: boolean;
  }>,
  notify: (payload: { title: string; body: string; silent?: boolean; channelId?: string }) =>
    ipcRenderer.invoke('notify', payload) as Promise<boolean>,
  setBadge: (count: number) => ipcRenderer.invoke('badge:set', count) as Promise<boolean>,
  flashWindow: () => ipcRenderer.invoke('window:flash') as Promise<boolean>,
  setTheme: (theme: 'system' | 'dark' | 'light') => ipcRenderer.invoke('theme:set', theme) as Promise<boolean>,
  openExternal: (url: string) => ipcRenderer.invoke('shell:open', url) as Promise<boolean>,

  onMenu: (handler: (action: string) => void) => {
    const actions = ['settings', 'new-channel', 'quick-switch', 'search', 'catchup'];
    const listeners = actions.map((a) => {
      const fn = () => handler(a);
      ipcRenderer.on(`menu:${a}`, fn);
      return { channel: `menu:${a}`, fn };
    });
    return () => listeners.forEach((l) => ipcRenderer.removeListener(l.channel, l.fn));
  },

  onNotificationClick: (handler: (channelId: string) => void) => {
    const fn = (_e: unknown, channelId: string) => handler(channelId);
    ipcRenderer.on('notification:click', fn);
    return () => ipcRenderer.removeListener('notification:click', fn);
  },
};

contextBridge.exposeInMainWorld('stellium', api);
export type StelliumBridge = typeof api;
