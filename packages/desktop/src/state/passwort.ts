import { create } from 'zustand';

/**
 * Nur, OB die Tresor-Tafel offen ist — nicht ihr Inhalt.
 *
 * Derselbe winzige Laden wie state/einmalcode.ts und state/paypal.ts, aus
 * demselben Grund: Rail.tsx (öffnet die Tafel) und App.tsx (zeigt sie)
 * müssen sich treffen, ohne den großen, gemeinsamen Zustand (state/store.ts)
 * anzufassen.
 *
 * HIER LIEGT KEIN EINZIGES PASSWORT
 *
 * Wie bei Einmalcodes: ein Zustand, der die ganze App überlebt, überlebte
 * auch das Schließen der Tafel — und damit läge ein entschlüsselter Tresor
 * im Arbeitsspeicher, lange nachdem ihn jemand gebraucht hat. Die
 * entschlüsselten Einträge hält PasswortPanel.tsx in seinem eigenen
 * `useState`; der stirbt spätestens beim Schließen der Tafel.
 */
interface PasswortUiState {
  offen: boolean;
  /** Für den Sprung aus dem Tresor zum passenden Einmalcode-Konto (und
   *  zurück): welcher Eintrag soll nach dem Öffnen ausgewählt sein. */
  hervorhebenEintragId: string | null;
  oeffnen: (hervorhebenEintragId?: string) => void;
  schliessen: () => void;
}

export const usePasswortUi = create<PasswortUiState>((set) => ({
  offen: false,
  hervorhebenEintragId: null,
  oeffnen: (hervorhebenEintragId) => set({ offen: true, hervorhebenEintragId: hervorhebenEintragId ?? null }),
  schliessen: () => set({ offen: false, hervorhebenEintragId: null }),
}));
