import { create } from 'zustand';
import type { Problembericht, ProblemberichtBereich, ProblemberichtStatus } from '@stellium/shared';
import { api } from '../net/api.js';
import { aktuellesPanel } from '../lib/aktuellesPanel.js';
import { currentUiLanguage } from '../i18n/index.js';

/**
 * Der Tab „Probleme melden" — eigener, kleiner Laden statt state/store.ts,
 * aus demselben Grund wie state/vorschlaege.ts und die anderen kleinen Läden
 * daneben: state/store.ts wird gerade an anderer Stelle bearbeitet, und
 * dieses Panel braucht ohnehin keine WebSocket-Anbindung — es ist reines
 * Anfragen/Antworten über HTTP (net/api.ts, api.problemberichte), genau wie
 * SystemPanel.tsx es für die Systemwerte vormacht.
 */

interface ProblemberichteState {
  offen: boolean;
  /** Wo die App die meldende Person beim Öffnen angetroffen hat — Startwert
   *  für das Feld „Bereich" im Formular, siehe lib/aktuellesPanel.ts. */
  erkannterBereich: ProblemberichtBereich;
  oeffnen: () => void;
  schliessen: () => void;

  /** Alles, was diese Person sehen darf — eigene Berichte, oder mit
   *  report.review auch die der anderen (das entscheidet der Server). */
  liste: Problembericht[];
  geladen: boolean;
  laedt: boolean;
  sendeFehler: string | null;

  laden: () => Promise<void>;
  einreichen: (eingabe: {
    bereich: string; schwere: string; erwartet: string; passiert: string; schritte?: string;
  }) => Promise<Problembericht>;
  uebernehmen: (id: string) => Promise<void>;
  abschliessen: (id: string, ergebnis: string, status?: 'erledigt' | 'neu') => Promise<void>;
}

export const useProblemberichteUi = create<ProblemberichteState>((set, get) => ({
  offen: false,
  erkannterBereich: 'sonstiges',
  oeffnen: () => set({ offen: true, erkannterBereich: aktuellesPanel() }),
  schliessen: () => set({ offen: false, sendeFehler: null }),

  liste: [],
  geladen: false,
  laedt: false,
  sendeFehler: null,

  laden: async () => {
    set({ laedt: true });
    try {
      const { berichte } = await api.problemberichte.liste();
      set({ liste: berichte, geladen: true, laedt: false });
    } catch {
      // Der Fangkorb/die Oberfläche zeigt ohnehin schon eine Fehlerkarte bei
      // gestörter Leitung — hier reicht es, das Drehrad wieder loszulassen.
      set({ laedt: false });
    }
  },

  einreichen: async (eingabe) => {
    set({ sendeFehler: null });
    try {
      const { bericht } = await api.problemberichte.anlegen({
        ...eingabe,
        panel: get().erkannterBereich,
        sprache: currentUiLanguage(),
      });
      set((s) => ({ liste: [bericht, ...s.liste] }));
      return bericht;
    } catch (err) {
      set({ sendeFehler: (err as Error).message });
      throw err;
    }
  },

  uebernehmen: async (id) => {
    const { bericht } = await api.problemberichte.uebernehmen(id);
    set((s) => ({ liste: s.liste.map((b) => (b.id === id ? bericht : b)) }));
  },

  abschliessen: async (id, ergebnis, status) => {
    const { bericht } = await api.problemberichte.abschliessen(id, ergebnis, status);
    set((s) => ({ liste: s.liste.map((b) => (b.id === id ? bericht : b)) }));
  },
}));

/**
 * Für Prüfläufe erreichbar — wie `__stelliumVorschlaege` in
 * state/vorschlaege.ts.
 */
if (typeof window !== 'undefined') {
  (window as unknown as { __stelliumProblemberichte?: typeof useProblemberichteUi })
    .__stelliumProblemberichte = useProblemberichteUi;
}
