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
  onUpdate?(handler: (art: string, daten: unknown) => void): () => void;
}

declare global {
  interface Window {
    /** Von Electron bereitgestellt. Im reinen Browser undefined. */
    stellium?: StelliumBridge;
  }
}
