import { WS_PROTOCOL_VERSION, type ClientEvent, type ServerEvent } from '@stellium/shared';
import { token, wsUrl } from './api.js';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed';

type Listener = (ev: ServerEvent) => void;
type StateListener = (state: ConnectionState, detail?: string) => void;

/**
 * WebSocket mit automatischem Wiederverbinden. Nachrichten, die während einer
 * Unterbrechung entstehen, wandern in eine Warteschlange und gehen raus,
 * sobald die Verbindung wieder steht.
 */
/**
 * Kennungen, nach denen die Leitung nicht wieder aufgebaut wird.
 *
 * Der Server schickt Kennungen aus dem Wörterbuch der Oberfläche — dieselben,
 * die auch den übersetzten Text auswählen. Wer hier eine ändert, muss sie in
 * packages/server/src/ws/gateway.ts mitändern; scripts/e2e-fehlertexte.mjs
 * vergleicht beide Seiten und schlägt an, wenn eine Kennung ins Leere zeigt.
 */
const ABBRUCH_KENNUNGEN = new Set([
  'fehler.anmeldungAbgelaufen',   // Token abgelaufen oder gefälscht
  'fehler.protokollVeraltet',     // App zu alt für diesen Server
  'fehler.kontoInaktiv',          // Konto gesperrt oder gelöscht
  'fehler.kontoWeg',
]);

class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private outbox: ClientEvent[] = [];
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;
  /** Warum die Verbindung endgültig scheiterte — entscheidet über das Abmelden. */
  failCode: string | null = null;
  private authed = false;

  state: ConnectionState = 'idle';

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    for (const fn of this.stateListeners) fn(state, detail);
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const t = token();
    if (!t) return;

    this.closedByUs = false;
    this.authed = false;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'auth', token: t, protocol: WS_PROTOCOL_VERSION } satisfies ClientEvent));
    };

    ws.onmessage = (e) => {
      let ev: ServerEvent;
      try { ev = JSON.parse(e.data as string); } catch { return; }

      if (ev.t === 'ready' && !this.authed) {
        this.authed = true;
        this.attempt = 0;
        this.setState('open');
        this.flush();
        this.startPing();
      }
      if (ev.t === 'error' && ev.code !== undefined && ABBRUCH_KENNUNGEN.has(ev.code)) {
        this.closedByUs = true;   // kein Reconnect-Sturm bei kaputtem Token
        // Der Grund muss mit: bei 'protocol_mismatch' ist das Token in Ordnung,
        // nur die App zu alt. Wer dabei abmeldet, schickt in eine Schleife —
        // die neue Anmeldung scheitert am selben Protokoll.
        this.failCode = ev.code;
        this.setState('failed', ev.message);
      }
      for (const fn of this.listeners) fn(ev);
    };

    ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      if (this.closedByUs) { this.setState('idle'); return; }
      this.scheduleReconnect();
    };

    ws.onerror = () => { /* onclose folgt und übernimmt */ };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.attempt++;
    // 0.8s, 1.6s, 3.2s … maximal 20s, plus Jitter gegen Thundering Herd
    const wait = Math.min(20_000, 800 * 2 ** Math.min(this.attempt - 1, 5)) + Math.random() * 400;
    this.setState('reconnecting', `Neuer Versuch in ${Math.round(wait / 1000)}s`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, wait);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ t: 'ping', ts: Date.now() });
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private flush(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const ev of queued) this.send(ev);
  }

  /** true = sofort gesendet, false = zwischengespeichert. */
  send(ev: ClientEvent): boolean {
    if (this.ws?.readyState === WebSocket.OPEN && this.authed) {
      this.ws.send(JSON.stringify(ev));
      return true;
    }
    // Nur Dinge puffern, die später noch Sinn ergeben.
    const queueable = new Set(['message:send', 'message:edit', 'message:delete', 'message:react', 'read', 'prefs:update']);
    if (queueable.has(ev.t)) {
      this.outbox.push(ev);
      if (this.outbox.length > 200) this.outbox.shift();
    }
    return false;
  }

  get queuedCount(): number { return this.outbox.length; }

  /** Nach dem Aufwachen aus dem Ruhezustand sofort neu verbinden. */
  wake(): void {
    if (this.state === 'open' || this.closedByUs) return;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.attempt = 0;
    this.connect();
  }

  disconnect(): void {
    this.closedByUs = true;
    this.stopPing();
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.outbox = [];
    this.attempt = 0;
    this.ws?.close();
    this.ws = null;
    this.authed = false;
    this.setState('idle');
  }
}

export const socket = new Socket();

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => socket.wake());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') socket.wake();
  });
}
