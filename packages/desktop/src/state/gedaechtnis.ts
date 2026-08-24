import { create } from 'zustand';

/**
 * Nur, OB der Reiter „Gedächtnis" offen ist — nicht sein Inhalt.
 *
 * Ein eigener, winziger Laden statt state/store.ts, aus demselben Grund wie
 * bei state/partnergruppen.ts und state/vorschlaege.ts: store.ts wird gerade
 * an anderer Stelle bearbeitet, und Rail.tsx (öffnet den Reiter) sowie
 * App.tsx (zeigt ihn) müssen sich irgendwo treffen, ohne beide denselben
 * Baustein anfassen zu müssen.
 *
 * Die Daten holt sich components/PostGedaechtnis.tsx beim Öffnen selbst über
 * die Wege unter /api/post/wissen. Kein WebSocket-Ereignis: ein
 * Gedächtnis-Vorschlag ist ausdrücklich nichts, das jemanden ungefragt stören
 * soll — er wartet in der Liste, bis jemand hinsieht. Das ist derselbe
 * Gedanke wie bei den Briefpartner-Gruppen und der Grund, warum es hier keine
 * Push-Meldung gibt.
 */
interface GedaechtnisUiState {
  offen: boolean;
  oeffnen: () => void;
  schliessen: () => void;
}

export const useGedaechtnisUi = create<GedaechtnisUiState>((set) => ({
  offen: false,
  oeffnen: () => set({ offen: true }),
  schliessen: () => set({ offen: false }),
}));
