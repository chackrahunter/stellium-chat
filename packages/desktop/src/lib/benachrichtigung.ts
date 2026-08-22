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

/*
 * Der Service Worker, sobald er bereit ist.
 *
 * Er ist nicht nur der schönere Weg, sondern auf dem Telefon der EINZIGE:
 * eine Web-App auf dem iPhone-Startbildschirm kennt `new Notification(...)`
 * nicht, iOS verlangt `ServiceWorkerRegistration.showNotification`. Chrome
 * verlangt dasselbe für installierte Web-Apps. Deshalb wird er registriert,
 * bevor irgendwer eine Benachrichtigung erwartet.
 */
let arbeiter: ServiceWorkerRegistration | null = null;

export function meldewegVorbereiten(): void {
  if (inDerApp()) return;                       /* dort macht es Electron */
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js')
    .then((r) => { arbeiter = r; return navigator.serviceWorker.ready; })
    .then((r) => { arbeiter = r; })
    .catch(() => { /* ohne ihn bleibt der alte Weg, das ist kein Grund zu klagen */ });

  /* Der Tipp auf eine Benachrichtigung kommt als Nachricht zurück. */
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data as { art?: string; kanalId?: string } | undefined;
    if (d?.art === 'kanal-oeffnen' && d.kanalId) {
      window.dispatchEvent(new CustomEvent('stellium:kanal-oeffnen', { detail: d.kanalId }));
    }
  });
}

/*
 * Ob die App überhaupt am System durchkommt. Wird einmal beim Start
 * abgefragt und behalten — `erlaubnisStand()` ist synchron, ein Aufruf über
 * die Prozessgrenze wäre es nicht.
 *
 * Bis die Antwort da ist, gilt `null` als "geht" — sonst blitzte in den
 * Einstellungen für einen Moment eine Warnung auf, die dann wieder
 * verschwindet.
 */
let appKannMelden: boolean | null = null;

export function meldewegPruefen(): void {
  if (!inDerApp()) return;
  void window.stellium?.notifyMoeglich?.()
    .then((geht: boolean) => { appKannMelden = geht; })
    .catch(() => { /* ältere App-Fassung kennt den Aufruf nicht */ });
}

/**
 * Was gerade möglich ist.
 *
 * Früher stand hier für die App bedingungslos "erlaubt". Das war falsch und
 * hat den eigentlichen Fehler verdeckt: auf macOS nimmt die
 * Mitteilungszentrale nur Programme mit echter Entwicklersignatur an. Ein
 * ad-hoc signiertes Programm darf senden, es kommt nur nichts an — ohne
 * Fehler und ohne Nachfrage. Die Einstellungen meldeten dann "erlaubt",
 * während in Wahrheit nie etwas erschien.
 */
export function erlaubnisStand(): Erlaubnis {
  if (inDerApp()) return appKannMelden === false ? 'geht-nicht' : 'erlaubt';
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

  /* Zuerst über den Service Worker. Auf dem Telefon ist das der einzige Weg,
     der überhaupt etwas anzeigt; auf dem Schreibtisch ist er gleichwertig. */
  if (arbeiter) {
    try {
      void arbeiter.showNotification(input.titel, {
        body: input.text,
        tag: input.gruppe ?? input.kanalId ?? 'stellium',
        silent: input.still,
        icon: '/stellium-192.png',
        badge: '/stellium-192.png',
        data: { kanalId: input.kanalId },
      });
      return true;
    } catch { /* dann eben der alte Weg darunter */ }
  }

  try {
    const n = new Notification(input.titel, {
      body: input.text,
      // Gleiche Gruppe ersetzt die vorherige — sonst stapeln sich bei einem
      // lebhaften Kanal zwanzig Kästchen übereinander.
      tag: input.gruppe ?? input.kanalId ?? 'stellium',
      silent: input.still,
      /* stellium-192.png, nicht icon.png — die gab es nie, und ein Browser
         zeigt dann ein namenloses graues Kästchen. */
      icon: '/stellium-192.png',
      badge: '/stellium-192.png',
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
