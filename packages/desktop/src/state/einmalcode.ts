import { create } from 'zustand';

/**
 * Nur, OB die Einmalcode-Tafel offen ist — nicht ihr Inhalt.
 *
 * Ein eigener, winziger Laden statt state/store.ts, aus demselben Grund wie
 * bei state/partnergruppen.ts und state/vorschlaege.ts: store.ts wird gerade
 * an anderer Stelle bearbeitet, und Rail.tsx (öffnet die Tafel) sowie App.tsx
 * (zeigt sie) müssen sich irgendwo treffen, ohne beide denselben, gerade
 * gesperrten Baustein anfassen zu müssen.
 *
 * HIER LIEGEN KEINE CODES UND SCHON GAR KEIN GEHEIMNIS
 *
 * Das ist nicht nur Sparsamkeit, sondern die Absicht: ein Zustand, der über
 * die ganze App hinweg lebt, überlebt auch das Schließen der Tafel — und
 * damit läge ein gültiger zweiter Faktor im Arbeitsspeicher herum, lange
 * nachdem ihn jemand gebraucht hat. Die Codes holt sich
 * components/EinmalcodePanel.tsx selbst und hält sie in seinem eigenen
 * `useState`. Der stirbt mit der Komponente, also spätestens beim Schließen
 * der Tafel.
 */
interface EinmalcodeUiState {
  offen: boolean;
  /** Für den Sprung aus dem Passwort-Tresor (PasswortPanel.tsx, verknüpftes
   *  TOTP-Konto): welches Konto soll nach dem Öffnen hervorgehoben werden.
   *  Deckt NUR das Hervorheben — der Code selbst bleibt so verdeckt, wie er
   *  es beim gewöhnlichen Öffnen auch wäre (siehe Dateikopf von
   *  EinmalcodePanel.tsx, „NICHTS IST SICHTBAR, BIS JEMAND DARAUF DRÜCKT"). */
  hervorhebenKontoId: string | null;
  oeffnen: (hervorhebenKontoId?: string) => void;
  schliessen: () => void;
}

export const useEinmalcodeUi = create<EinmalcodeUiState>((set) => ({
  offen: false,
  hervorhebenKontoId: null,
  oeffnen: (hervorhebenKontoId) => set({ offen: true, hervorhebenKontoId: hervorhebenKontoId ?? null }),
  schliessen: () => set({ offen: false, hervorhebenKontoId: null }),
}));
