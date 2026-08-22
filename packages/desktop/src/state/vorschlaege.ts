import { create } from 'zustand';
import type {
  ClientEvent, ServerEvent, Vorschlag, VorschlagAenderung, VorschlagArt,
} from '@stellium/shared';
import { socket } from '../net/socket.js';
import { anfrage } from './store.js';
import { zeigen } from '../lib/benachrichtigung.js';

/**
 * Der Eingang für Vorschläge der KI — Zustand in der Oberfläche.
 *
 * WARUM EIN EIGENER LADEN UND NICHT state/store.ts
 *
 * Weil store.ts gerade in fremder Hand ist. Er hängt am selben Draht: `socket`
 * verteilt jedes Ereignis an alle Anmelder, und dieser hier meldet sich
 * zusätzlich an. Es gibt also weiterhin genau eine WebSocket-Verbindung und
 * genau eine Wahrheit — nur zwei Schubladen davor.
 *
 * Beim Zusammenlegen fällt diese Datei weg und die vier Felder wandern in
 * StoreState. Der Bruch ist bewusst klein gehalten: keine eigene Verbindung,
 * kein eigener Wiederverbindungsversuch, keine zweite Anmeldung.
 */

function hinaus(ev: ClientEvent): void {
  socket.send(ev);
}

/**
 * Entscheiden und den Knopf wieder freigeben — in jedem Ausgang.
 *
 * `anfrage()` aus store.ts ist derselbe Weg, den die KI-Aufträge nehmen: eine
 * Frist, ein Abbruch bei getrennter Leitung, ein Merkspeicher. Wichtig ist
 * nur, dass `laeuft` in allen drei Fällen aufgeht — Antwort, Absage,
 * Leitungsverlust. Beim Gelingen räumt `aufnehmen()` ohnehin auf; hier steht
 * es trotzdem, damit keine Reihenfolge darüber entscheidet.
 *
 * Die Meldung selbst zeigt store.ts an; hier wird sie nur nicht verschluckt.
 */
function warten(id: string, bauen: (requestId: string) => ClientEvent): void {
  void anfrage(bauen).catch(() => { /* store.ts meldet es */ }).finally(() => {
    useVorschlaege.setState((s) => (s.laeuft === id ? { laeuft: null } : {}));
  });
}

interface VorschlagServerEvent {
  t: 'vorschlag:list' | 'vorschlag:upsert' | 'vorschlag:removed' | 'vorschlag:neu';
  vorschlaege?: Vorschlag[];
  vorschlag?: Vorschlag;
  vorschlagId?: string;
}

interface VorschlagState {
  /**
   * Steht der Eingang offen — und womit vorgefiltert?
   *
   * Bewusst hier und nicht in `Overlay` von state/store.ts. Nicht nur, weil
   * store.ts gerade gesperrt ist: der Eingang geht mit einem Filter auf
   * ("zeig mir die Aufgaben"), und `Overlay` ist eine reine Kennung ohne Platz
   * dafür. Beim Zusammenlegen wandert das Feld mit, nicht die Kennung.
   */
  offen: null | 'alle' | VorschlagArt;
  oeffnen: (filter?: 'alle' | VorschlagArt) => void;
  schliessen: () => void;

  /** Alles Offene, neueste zuerst. */
  liste: Vorschlag[];
  /** Einmal geladen? Sonst zeigt der Eingang einen Kreisel statt "nichts da". */
  geladen: boolean;
  /** Welcher Vorschlag gerade auf Antwort wartet — sperrt seine Knöpfe. */
  laeuft: string | null;
  /**
   * Zuletzt angenommen, für das Rückgängig direkt daneben.
   *
   * Nur der letzte und nur bis zum nächsten Laden: ein Rückgängig, das drei
   * Tage später noch angeboten wird, ist eine Falle, kein Netz.
   */
  zuletzt: Vorschlag | null;

  laden: () => void;
  annehmen: (id: string, aenderung?: VorschlagAenderung) => void;
  ablehnen: (id: string) => void;
  zuruecknehmen: (id: string) => void;
  aufnehmen: (ev: VorschlagServerEvent) => void;
}

function sortiert(liste: Vorschlag[]): Vorschlag[] {
  return [...liste].sort((a, b) => b.erstelltAm - a.erstelltAm);
}

export const useVorschlaege = create<VorschlagState>((set, get) => ({
  offen: null,
  oeffnen: (filter = 'alle') => set({ offen: filter }),
  // Das Rückgängig gehört zum Besuch, nicht zum Vorschlag: wer den Eingang
  // schließt, hat entschieden.
  schliessen: () => set({ offen: null, zuletzt: null }),

  liste: [],
  geladen: false,
  laeuft: null,
  zuletzt: null,

  laden: () => hinaus({ t: 'vorschlag:list' }),

  /* Die Karte verschwindet erst, wenn der Server bestätigt hat. Sie sofort
     wegzunehmen sähe schneller aus, wäre aber gelogen: scheitert das Anlegen
     — fehlendes Recht, Kanal inzwischen vertraulich —, stünde die Aufgabe
     nirgends und der Vorschlag wäre trotzdem weg. */
  annehmen: (id, aenderung) => {
    set({ laeuft: id });
    warten(id, (requestId) => ({ t: 'vorschlag:accept', requestId, vorschlagId: id, aenderung }));
  },

  ablehnen: (id) => {
    set({ laeuft: id });
    warten(id, (requestId) => ({ t: 'vorschlag:reject', requestId, vorschlagId: id }));
  },

  zuruecknehmen: (id) => {
    set({ laeuft: id, zuletzt: null });
    warten(id, (requestId) => ({ t: 'vorschlag:undo', requestId, vorschlagId: id }));
  },

  aufnehmen: (ev) => {
    if (ev.t === 'vorschlag:list' && ev.vorschlaege) {
      set({ liste: sortiert(ev.vorschlaege), geladen: true, laeuft: null });
      return;
    }
    if ((ev.t === 'vorschlag:upsert' || ev.t === 'vorschlag:neu') && ev.vorschlag) {
      const v = ev.vorschlag;
      if (ev.t === 'vorschlag:neu') {
        /* Nur bei echt Neuem — 'vorschlag:upsert' feuert auch für jede
           spätere Änderung an einem längst bekannten Vorschlag, und dafür
           soll es kein zweites Mal klingeln.
           TODO(i18n): fester deutscher Text — i18n/ durfte in dieser
           Änderung nicht angefasst werden. Vorschlag für Schlüssel:
           toast.vorschlagNeuAufgabe / toast.vorschlagNeuTermin / toast.vorschlagNeuIdee. */
        const artText = v.art === 'aufgabe' ? 'Neue Aufgabe vorgeschlagen'
          : v.art === 'termin' ? 'Neuer Termin vorgeschlagen' : 'Neue Idee vorgeschlagen';
        zeigen({ titel: artText, text: v.titel, kanalId: v.channelId, gruppe: `vorschlag:${v.id}` });
      }
      const ohne = get().liste.filter((x) => x.id !== v.id);
      set({
        // Nur Offenes steht im Eingang. Angenommenes und Abgelehntes bleibt in
        // der Datenbank, aber nicht vor Augen.
        liste: v.zustand === 'offen' ? sortiert([...ohne, v]) : ohne,
        geladen: true,
        laeuft: get().laeuft === v.id ? null : get().laeuft,
        zuletzt: v.zustand === 'angenommen' ? v : get().zuletzt,
      });
      return;
    }
    if (ev.t === 'vorschlag:removed' && ev.vorschlagId) {
      const weg = ev.vorschlagId;
      set((s) => ({
        liste: s.liste.filter((x) => x.id !== weg),
        laeuft: s.laeuft === weg ? null : s.laeuft,
      }));
    }
  },
}));

/**
 * Am Draht anmelden.
 *
 * Fehlermeldungen des Servers kommen als gewöhnliches `error`-Ereignis an und
 * werden von store.ts als Meldung angezeigt. Die Sperre auf der Karte geht
 * über `warten()` wieder auf — an der Kennung der Anfrage, nicht an jedem
 * beliebigen Fehler: sonst gäbe ein fremder Fehler eine fremde Karte frei.
 */
socket.onEvent((ev: ServerEvent) => {
  const art = (ev as { t: string }).t;
  if (art.startsWith('vorschlag:')) {
    useVorschlaege.getState().aufnehmen(ev as unknown as VorschlagServerEvent);
    return;
  }
  // Nach einem Wiederverbinden ist der Stand von vorhin womöglich veraltet.
  if (art === 'ready') useVorschlaege.getState().laden();
});

/**
 * Für Prüfläufe erreichbar — wie `__stelliumStore` in state/store.ts.
 *
 * Die Schirmbilder müssen den Eingang mit Inhalt zeigen können, ohne dass erst
 * ein Sprachmodell etwas findet. Ein Bild von einem leeren Kasten beweist
 * nicht, dass eine Karte auf ein Telefon passt.
 */
if (typeof window !== 'undefined') {
  (window as unknown as { __stelliumVorschlaege?: typeof useVorschlaege })
    .__stelliumVorschlaege = useVorschlaege;
}
