/**
 * Fernsteuerung in der Browser-Oberfläche — dieselbe Schnittstelle wie
 * `window.stellium.fern` aus electron/preload.ts, nur über den Chat-Server.
 *
 * Der Browser spricht nicht mit dem Pi, sondern mit `/api/fern/leitung`. Den
 * Handschlag (scrypt, ECDH) macht der Server, das Passwort kommt hier nie an
 * — Begründung in packages/server/src/http/fernleitung.ts. Hier kommen nur
 * noch H.264-Häppchen (binär) und kleine JSON-Nachrichten an.
 *
 * Eine Verbindung je Seite: die Ansicht darf ab- und wieder aufgebaut werden,
 * ohne dass die Leitung reißt — genau wie beim Hauptprozess der App.
 */
import { serverUrl, token } from './api.js';

type Lage = 'getrennt' | 'verbindet' | 'meldet an' | 'offen' | 'fehler';
type Zustand = { lage: Lage; fehler: string };

/* Schließ-Codes → Wörterbuch-Kennung. Die des Pi wie in
   electron/fernsteuerung.ts, dazu die des Servers (fernleitung.ts). */
const GRUENDE: Record<number, string> = {
  4003: 'fern.fehler.passwort',
  4008: 'fern.fehler.zeitUeberschritten',
  4009: 'fern.fehler.besetzt',
  4010: 'fern.fehler.zuVieleZuschauer',
  4011: 'fern.fehler.leitungWeg',
  4029: 'fern.fehler.zuVieleVersuche',
  4401: 'fern.fehler.allgemein',
  4403: 'fern.keinRecht',
  4404: 'fern.nichtEingerichtet',
  4406: 'fern.fehler.herkunft',
  4504: 'fern.fehler.keineAntwort',
};

/* Dieselbe Frist wie LEITUNG_STILL_MS im Hauptprozess: der Pi meldet sich
   alle zwei Sekunden, 25 Sekunden Stille sind eine abgerissene Leitung. */
const STILL_MS = 25_000;

let ws: WebSocket | null = null;
let zustand: Zustand = { lage: 'getrennt', fehler: '' };
const bildHoerer = new Set<(d: Uint8Array) => void>();
const zustandHoerer = new Set<(z: Zustand) => void>();
const infoHoerer = new Set<(i: unknown) => void>();
const ablageHoerer = new Set<(text: string) => void>();
let empfangen = 0;
let quittiertBis = 0;
let letzteNachricht = 0;
let wacht: ReturnType<typeof setInterval> | null = null;

function melden(lage: Lage, fehler = ''): void {
  zustand = { lage, fehler };
  for (const h of zustandHoerer) h(zustand);
}

function aufhoeren(): void {
  if (wacht) { clearInterval(wacht); wacht = null; }
  const alt = ws;
  ws = null;
  if (alt) { try { alt.close(); } catch { /* schon zu */ } }
}

function senden(nachricht: object): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(nachricht));
}

function verbinden(): Promise<boolean> {
  aufhoeren();
  melden('verbindet');
  const adresse = `${serverUrl().replace(/^http/, 'ws')}/api/fern/leitung`;
  const buchse = new WebSocket(adresse);
  buchse.binaryType = 'arraybuffer';
  ws = buchse;
  empfangen = 0; quittiertBis = 0; letzteNachricht = Date.now();

  buchse.addEventListener('open', () => {
    /* Das Token in der ersten Nachricht, nicht in der Adresse — Adressen
       stehen in den Protokollen von nginx. */
    buchse.send(JSON.stringify({ art: 'anmelden', token: token() }));
  });

  buchse.addEventListener('message', (e: MessageEvent) => {
    if (ws !== buchse) return;
    letzteNachricht = Date.now();
    if (typeof e.data !== 'string') {
      const daten = new Uint8Array(e.data as ArrayBuffer);
      empfangen += daten.length;
      for (const h of bildHoerer) h(daten);
      return;
    }
    let n: { art?: string; lage?: Lage; info?: unknown; text?: string };
    try { n = JSON.parse(e.data); } catch { return; }
    if (n.art === 'lage' && n.lage) {
      melden(n.lage);
      if (n.lage === 'offen') {
        /* Quittungen für die Regelung des Pi — siehe `leitungMelden` dort
           und `melder` in fernleitung.ts. Viermal je Sekunde, und nur, wenn
           seit der letzten etwas dazukam. */
        wacht = setInterval(() => {
          if (ws !== buchse) return;
          if (Date.now() - letzteNachricht > STILL_MS) { aufhoeren(); melden('fehler', 'fern.fehler.leitungWeg'); return; }
          if (empfangen !== quittiertBis) { quittiertBis = empfangen; senden({ art: 'q', n: empfangen }); }
        }, 250);
      }
    } else if (n.art === 'info') {
      for (const h of infoHoerer) h(n.info);
    } else if (n.art === 'ablage' && typeof n.text === 'string') {
      /* NICHT von selbst in die Ablage des Telefons: die Ansicht bietet sie
         zum Übernehmen an, und erst ein Druck darauf schreibt sie. */
      for (const h of ablageHoerer) h(n.text);
    }
  });

  buchse.addEventListener('close', (e: CloseEvent) => {
    if (ws !== buchse) return;
    const warOffen = zustand.lage === 'offen';
    aufhoeren();
    const grund = GRUENDE[e.code] ?? (warOffen ? '' : 'fern.fehler.allgemein');
    melden(grund ? 'fehler' : 'getrennt', grund);
  });
  return Promise.resolve(true);
}

/** Dieselbe Form wie `window.stellium.fern`, ohne eigenes Fenster. */
export const fernImBrowser = {
  /** Kennzeichen für die Ansicht: Zugangsdaten nicht selbst holen. */
  ueberServer: true as const,
  verbinden,
  trennen: () => { aufhoeren(); melden('getrennt'); return Promise.resolve(true); },
  lage: () => Promise.resolve(zustand),
  eingabe: (zeilen: string) => senden({ art: 'eingabe', zeilen }),
  steuer: (wunsch: unknown) => senden({ art: 'steuer', wunsch }),
  /** Text in die Ablage des Pi legen — der Browser kann die eigene Ablage
   *  nicht beobachten, deshalb geschieht das nur auf ausdrücklichen Wunsch
   *  (Einfügen über die Bildschirmtastatur). */
  ablage: (text: string) => senden({ art: 'ablage', text }),
  aufBild: (ruf: (d: Uint8Array) => void) => { bildHoerer.add(ruf); return () => { bildHoerer.delete(ruf); }; },
  aufZustand: (ruf: (z: Zustand) => void) => { zustandHoerer.add(ruf); return () => { zustandHoerer.delete(ruf); }; },
  aufInfo: (ruf: (i: unknown) => void) => { infoHoerer.add(ruf); return () => { infoHoerer.delete(ruf); }; },
  aufAblage: (ruf: (text: string) => void) => { ablageHoerer.add(ruf); return () => { ablageHoerer.delete(ruf); }; },
};
