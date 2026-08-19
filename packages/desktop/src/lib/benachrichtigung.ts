/**
 * Benachrichtigungen — in der App und im Browser.
 *
 * In der App übernimmt Electron: dort gibt es Systembenachrichtigungen, ein
 * blinkendes Symbol im Dock und eine Zahl am Programmsymbol. Im Browser gab es
 * bisher nichts — wer Stellium im Tab offen hatte, bemerkte eine Nachricht nur,
 * wenn er hinsah. Hier kommt beides zusammen: dieselbe Entscheidung, ob
 * benachrichtigt wird, und je nach Umgebung der passende Weg.
 *
 * Die Erlaubnis wird bewusst nicht beim Laden erfragt. Browser lehnen das
 * inzwischen ab, und niemand sagt Ja zu einer Frage, die er nicht erwartet hat.
 * Sie kommt auf Knopfdruck in den Einstellungen.
 */

export type Erlaubnis = 'geht-nicht' | 'gefragt-werden' | 'erlaubt' | 'abgelehnt';

const inDerApp = (): boolean => typeof window !== 'undefined' && Boolean(window.stellium);

/** Was der Browser gerade erlaubt. In der App immer "erlaubt". */
export function erlaubnisStand(): Erlaubnis {
  if (inDerApp()) return 'erlaubt';
  if (typeof Notification === 'undefined') return 'geht-nicht';
  if (Notification.permission === 'granted') return 'erlaubt';
  if (Notification.permission === 'denied') return 'abgelehnt';
  return 'gefragt-werden';
}

/** Nachfragen — nur aus einer Bedienhandlung heraus aufrufen. */
export async function erlaubnisHolen(): Promise<Erlaubnis> {
  if (inDerApp() || typeof Notification === 'undefined') return erlaubnisStand();
  try {
    await Notification.requestPermission();
  } catch { /* ältere Browser geben nichts zurück */ }
  return erlaubnisStand();
}

/**
 * Eine Benachrichtigung zeigen.
 *
 * Rückgabe sagt, ob sie herausging — so kann die Oberfläche stattdessen etwas
 * anderes tun, wenn nichts möglich war.
 */
export function zeigen(input: {
  titel: string;
  text: string;
  kanalId?: string;
  still?: boolean;
  /** Damit zwei Nachrichten aus demselben Kanal einander ersetzen. */
  gruppe?: string;
}): boolean {
  if (inDerApp()) {
    void window.stellium?.notify({
      title: input.titel, body: input.text, silent: input.still, channelId: input.kanalId,
    });
    void window.stellium?.flashWindow();
    return true;
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;

  try {
    const n = new Notification(input.titel, {
      body: input.text,
      // Gleiche Gruppe ersetzt die vorherige — sonst stapeln sich bei einem
      // lebhaften Kanal zwanzig Kästchen übereinander.
      tag: input.gruppe ?? input.kanalId ?? 'stellium',
      silent: input.still,
      icon: '/icon.png',
      badge: '/icon.png',
    });
    n.onclick = () => {
      window.focus();
      if (input.kanalId) {
        window.dispatchEvent(new CustomEvent('stellium:kanal-oeffnen', { detail: input.kanalId }));
      }
      n.close();
    };
    // Nach einer halben Minute von selbst weg — manche Browser lassen sie sonst stehen.
    window.setTimeout(() => n.close(), 30_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ungelesenes im Reitertitel.
 *
 * Im Browser gibt es kein Programmsymbol, an dem eine Zahl kleben könnte —
 * der Titel des Reiters ist der einzige Ort, den man aus dem Augenwinkel sieht.
 */
export function titelZaehler(anzahl: number, name = 'Stellium'): void {
  if (typeof document === 'undefined' || inDerApp()) return;
  document.title = anzahl > 0 ? `(${anzahl > 99 ? '99+' : anzahl}) ${name}` : name;
}
