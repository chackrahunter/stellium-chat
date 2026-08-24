import { create } from 'zustand';

/**
 * Nur, OB die Notzugang-Tafel offen ist — nicht ihr Inhalt.
 *
 * Derselbe winzige Laden wie state/passwort.ts und state/einmalcode.ts, aus
 * demselben Grund: Rail.tsx öffnet die Tafel, App.tsx zeigt sie, und beide
 * sollen sich treffen, ohne den großen gemeinsamen Zustand anzufassen.
 *
 * HIER LIEGT KEIN ANTEIL UND KEIN CODE. Ein Zustand, der die ganze App
 * überlebt, überlebte auch das Schließen der Tafel — und dann läge ein
 * Wiederherstellungscode im Speicher, lange nachdem ihn jemand vorgelesen
 * hat. Alles Vertrauliche hält NotzugangPanel.tsx in seinem eigenen
 * `useState`, der mit der Tafel stirbt; der Notschlüssel und die Anteile
 * kommen überhaupt nie in einen Zustand, sondern leben nur innerhalb der
 * Aufrufe in lib/notzugang.ts.
 */
interface NotzugangUiState {
  offen: boolean;
  oeffnen: () => void;
  schliessen: () => void;
}

export const useNotzugangUi = create<NotzugangUiState>((set) => ({
  offen: false,
  oeffnen: () => set({ offen: true }),
  schliessen: () => set({ offen: false }),
}));
