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
  /** Selbstgezeichnete macOS-Benachrichtigung, siehe src/lib/mac-benachrichtigung.ts.
   *  Optional wie notifyMoeglich — aeltere App-Fassungen kennen sie noch nicht. */
  macNotify?(payload: { titel: string; text: string; sprache: string; kanalId?: string; gruppe?: string }): Promise<boolean>;
  setBadge(count: number): Promise<boolean>;
  /** Native Beschriftungen (Menü, Tray, Bestätigungsdialoge) im Hauptprozess
   *  auf diese Sprache umstellen — siehe electron/i18n.ts und state/store.ts
   *  (applyTheme). Optional wie die übrigen: ältere App-Fassungen kennen den
   *  Aufruf noch nicht, ein Fehlen bedeutet nur "Menü bleibt auf Systemsprache". */
  setLanguage?(sprache: string): void;
  flashWindow(): Promise<boolean>;
  setTheme(theme: 'system' | 'dark' | 'light'): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  onMenu(handler: (action: string) => void): () => void;

  /** Der gesprochene Code einer laufenden Wiederherstellung, im
   *  Arbeitsspeicher des Hauptprozesses statt im localStorage — dort läge er
   *  neben dem privaten Teil dieses Geräts, und er ist das zweite von zwei
   *  Schlössern. Optional und im Browser gar nicht vorhanden: dort verhält
   *  sich die Tafel wie bisher und verliert den Code beim Neuladen. Ältere
   *  App-Fassungen kennen den Aufruf ebenfalls noch nicht — dieselbe
   *  Behandlung. Begründung: electron/main.ts, `notzugangCode`. */
  notzugangCode?: {
    merken(anfrageId: string, code: string): Promise<boolean>;
    holen(anfrageId: string): Promise<string | null>;
    vergessen(): Promise<boolean>;
  };

  /** Zwischenablage über den Hauptprozess — nur der Passwort-Tresor benutzt
   *  das. Optional und im Browser gar nicht vorhanden: DARAN erkennt die
   *  Ansicht, dass sie die Ablage nicht selbst wieder leeren kann, und sagt
   *  es der Person, statt es zu verschweigen (lib/passwoerter.ts,
   *  kopierenUndLoeschen()). Ältere App-Fassungen kennen es ebenfalls noch
   *  nicht — dieselbe Behandlung, dieselbe ehrliche Meldung. */
  ablage?: {
    schreiben(wert: string): Promise<boolean>;
    /** Leert die Ablage, wenn dort noch genau `wert` steht. `true` heißt:
     *  der Wert liegt danach nicht mehr darin. */
    leerenWennUnveraendert(wert: string): Promise<boolean>;
  };
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

  /**
   * Zur Bauzeit von Vite ersetzt (siehe vite.config.ts, `define`) — nach dem
   * Bau steht hier eine feste Zeichenkette, kein Zugriff mehr auf irgendein
   * Objekt. In der App nur als Rückfall verwendet (net/socket.ts): dort
   * gilt sonst app.getVersion() über window.stellium.info() als die
   * eigentliche Quelle, weil das die Fassung ist, die tatsächlich läuft.
   */
  const __APP_VERSION__: string;
}
