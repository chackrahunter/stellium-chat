import { contextBridge, ipcRenderer } from 'electron';

/** Genau die Fähigkeiten, die das UI braucht — nichts darüber hinaus. */
const api = {
  /**
   * Synchron verfügbar, schon beim ersten Zeichnen. Über den IPC-Aufruf käme
   * die Angabe erst nach dem ersten Bild — auf macOS säßen die Fensterknöpfe
   * bis dahin auf dem Logo.
   */
  platform: process.platform as string,

  /**
   * Sprache des Betriebssystems, ebenfalls sofort verfügbar. Damit startet die
   * Oberfläche — samt Anmeldung und Einführung — in der Sprache des Rechners.
   */
  locale: (process.argv.find((a) => a.startsWith('--stellium-locale=')) ?? '').slice(18) || undefined,

  info: () => ipcRenderer.invoke('app:info') as Promise<{
    locale: string; platform: NodeJS.Platform; arch: string; version: string; isDev: boolean;
  }>,
  notify: (payload: { title: string; body: string; silent?: boolean; channelId?: string }) =>
    ipcRenderer.invoke('notify', payload) as Promise<boolean>,
  setBadge: (count: number) => ipcRenderer.invoke('badge:set', count) as Promise<boolean>,
  flashWindow: () => ipcRenderer.invoke('window:flash') as Promise<boolean>,
  setTheme: (theme: 'system' | 'dark' | 'light') => ipcRenderer.invoke('theme:set', theme) as Promise<boolean>,
  openExternal: (url: string) => ipcRenderer.invoke('shell:open', url) as Promise<boolean>,

  /* Selbstaktualisierung */
  updateSignIn: (url: string, token: string) =>
    ipcRenderer.invoke('update:signin', { url, token }) as Promise<boolean>,
  updateSignOut: () => ipcRenderer.invoke('update:signout') as Promise<boolean>,
  checkForUpdate: () => ipcRenderer.invoke('update:check') as Promise<unknown>,
  installUpdate: () => ipcRenderer.invoke('update:install') as Promise<boolean>,
  postponeUpdate: () => ipcRenderer.invoke('update:postpone') as Promise<boolean>,
  lastUpdate: () => ipcRenderer.invoke('update:last') as Promise<
    { version: string; notes: string | null; installiertAm: number } | null>,
  onUpdate: (handler: (art: string, daten: unknown) => void) => {
    /* 'update:retry' gehört dazu — der Updater schickt es, wenn ein Download
       abgerissen ist und neu ansetzt. Es fehlte hier, und damit sah man beim
       Wiederaufsetzen einen Fortschrittsbalken, der minutenlang stillstand,
       ohne dass irgendetwas den Grund nannte. Wer hier eine Meldung ergänzt,
       muss sie auch in src/lib/updates.ts behandeln. */
    const arten = ['update:found', 'update:progress', 'update:ready', 'update:none', 'update:error', 'update:installing',
      'update:deadline', 'update:postponed', 'update:retry'];
    const hoerer = arten.map((art) => {
      const fn = (_e: unknown, daten: unknown) => handler(art.slice(7), daten);
      ipcRenderer.on(art, fn);
      return () => ipcRenderer.off(art, fn);
    });
    return () => hoerer.forEach((ab) => ab());
  },

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
