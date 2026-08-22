/**
 * Formen für das Benachrichtigungsfenster.
 *
 * Bewusst hier verdoppelt statt aus electron/mac-notify.ts importiert — genau
 * wie bei src/types/global.d.ts (siehe Kommentar dort). Dieses Fenster ist
 * ein eigenes, kleines Bündel; es soll nie versehentlich etwas aus dem
 * Hauptprozess-Ordner mitziehen, nur weil ein Typ von dort bequem wäre.
 */
export interface MacNotifyKarte {
  id: string;
  titel: string;
  text: string;
  /** Sprache der Oberfläche, als der Hauptprozess die Karte erzeugt hat. */
  sprache: string;
  kanalId?: string;
  gruppe?: string;
  erstelltAm: number;
}

export interface MacNotifyBridge {
  aufStapel(ruf: (karten: MacNotifyKarte[]) => void): () => void;
  aufTheme(ruf: (stand: { dunkel: boolean }) => void): () => void;
  verwerfen(id: string): void;
  klicken(id: string): void;
  gemalt(): void;
}

declare global {
  interface Window {
    /** Von electron/mac-notify-preload.ts bereitgestellt. */
    stelliumMacNotify?: MacNotifyBridge;
  }
}
