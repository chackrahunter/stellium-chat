import { create } from 'zustand';

/**
 * Nur, OB die Bank-Tafel offen ist — nicht ihr Inhalt.
 *
 * Ein eigener, winziger Laden statt state/store.ts, aus demselben Grund wie
 * bei state/partnergruppen.ts und state/vorschlaege.ts: store.ts wird gerade
 * an anderer Stelle bearbeitet, und Rail.tsx (öffnet die Tafel) sowie App.tsx
 * (zeigt sie) müssen sich irgendwo treffen, ohne beide denselben, gerade
 * gesperrten Baustein anfassen zu müssen.
 *
 * Die Zahlen selbst holt components/PaypalPanel.tsx beim Öffnen über
 * `GET /api/bank/paypal/uebersicht`. Kein WebSocket-Ereignis, keine
 * ungefragte Zustellung: ein Kontostand muss niemandem aufploppen, und der
 * Server hält ihn ohnehin schon zwischengespeichert bereit (siehe
 * services/paypal.ts) — die Tafel fragt beim Öffnen einmal und ist fertig.
 */
interface PaypalUiState {
  offen: boolean;
  oeffnen: () => void;
  schliessen: () => void;
}

export const usePaypalUi = create<PaypalUiState>((set) => ({
  offen: false,
  oeffnen: () => set({ offen: true }),
  schliessen: () => set({ offen: false }),
}));
