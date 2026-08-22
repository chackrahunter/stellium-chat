/**
 * Form der Preload-Bridge. Bewusst hier dupliziert statt aus electron/preload.ts
 * importiert — sonst zöge der Renderer die kompletten Electron-Typen mit,
 * obwohl er nur diese wenigen Funktionen sieht.
 * Gegenstück: packages/desktop/electron/preload.ts
 */
export interface StelliumBridge {
  /** Sofort verfügbar, ohne Umweg über IPC. */
  platform: string;
  /** Sprache des Betriebssystems, z. B. "en-US". Im Browser undefined. */
  locale?: string;
  info(): Promise<{ locale: string; platform: string; arch: string; version: string; isDev: boolean }>;
  /** Ob das System Benachrichtigungen ueberhaupt annimmt. Auf macOS haengt
   *  das an der Signatur und nicht am Koennen von Electron. Optional, weil
   *  aeltere App-Fassungen den Aufruf noch nicht kennen. */
  notifyMoeglich?: () => Promise<boolean>;
  notify(payload: { title: string; body: string; silent?: boolean; channelId?: string }): Promise<boolean>;
  setBadge(count: number): Promise<boolean>;
  flashWindow(): Promise<boolean>;
  setTheme(theme: 'system' | 'dark' | 'light'): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  onMenu(handler: (action: string) => void): () => void;
  onNotificationClick(handler: (channelId: string) => void): () => void;

  /** Selbstaktualisierung — nur in der App vorhanden, im Browser undefined. */
  updateSignIn?(url: string, token: string): Promise<boolean>;
  updateSignOut?(): Promise<boolean>;
  checkForUpdate?(): Promise<unknown>;
  installUpdate?(): Promise<boolean>;
  postponeUpdate?(): Promise<boolean>;
  lastUpdate?(): Promise<{ version: string; notes: string | null; installiertAm: number } | null>;
  onUpdate?(handler: (art: string, daten: unknown) => void): () => void;
}

declare global {
  interface Window {
    /** Von Electron bereitgestellt. Im reinen Browser undefined. */
    stellium?: StelliumBridge;
  }
}
