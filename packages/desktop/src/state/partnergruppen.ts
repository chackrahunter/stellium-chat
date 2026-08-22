import { create } from 'zustand';

/**
 * Nur, OB die Briefpartner-Tafel offen ist — nicht ihr Inhalt.
 *
 * Ein eigener, winziger Laden statt state/store.ts, aus demselben Grund wie
 * bei state/vorschlaege.ts: store.ts wird gerade an anderer Stelle
 * bearbeitet, und Rail.tsx (öffnet die Tafel) sowie App.tsx (zeigt sie)
 * müssen sich irgendwo treffen, ohne beide denselben, gerade gesperrten
 * Baustein anfassen zu müssen.
 *
 * Die eigentlichen Daten (Liste, Filter, Laden, Ändern) holt sich
 * components/PartnerGruppenPanel.tsx beim Öffnen selbst über die REST-Wege
 * unter /api/post/partner — anders als bei Vorschlägen gibt es hier kein
 * WebSocket-Ereignis, das eine ungefragte Zustellung bräuchte (die KI legt
 * nichts an, das sofort irgendwo aufploppen müsste; ihr Vorschlag wartet
 * einfach in der Liste, bis jemand die Tafel öffnet). Deshalb reicht dieser
 * Laden hier mit nur zwei Feldern.
 */
interface PartnerGruppenUiState {
  offen: boolean;
  oeffnen: () => void;
  schliessen: () => void;
}

export const usePartnerGruppenUi = create<PartnerGruppenUiState>((set) => ({
  offen: false,
  oeffnen: () => set({ offen: true }),
  schliessen: () => set({ offen: false }),
}));
