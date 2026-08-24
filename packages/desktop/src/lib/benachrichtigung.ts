import type { PushSubscriptionJSON } from '@stellium/shared';
import { macAnzeigen } from './mac-benachrichtigung.js';

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
 *
 * ZWEI PAAR SCHUHE: `zeigen()` UND `pushAbonnieren()`
 *
 * `zeigen()` weiter unten zeigt sofort etwas an — es setzt voraus, dass genau
 * dieser Code gerade läuft. Auf dem Schreibtisch ist das die meiste Zeit
 * wahr; auf einem Telefon, das in der Tasche liegt, nie. Für den Fall gibt es
 * `pushAbonnieren()`: es meldet dieses Gerät beim Push-Dienst des Browsers an
 * (Apple/Google/Mozilla, je nach Herkunft) und reicht die Anmeldedaten an den
 * Aufrufer weiter, der sie an den Server schickt (siehe state/store.ts). Von
 * da an kann der SERVER dieses Gerät erreichen, ganz ohne dass diese Datei
 * noch beteiligt ist — die eigentliche Anzeige übernimmt dann `public/sw.js`,
 * Ereignis `push`, im Hintergrund.
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

  /* Der Tipp auf eine Benachrichtigung kommt als Nachricht zurück — genauso
     wie ein vom Browser selbst erneuertes Push-Abonnement (sw.js, Ereignis
     'pushsubscriptionchange'). Beides läuft über denselben Kanal, weil beides
     vom Worker ausgeht und diese Seite nicht von sich aus danach fragt. */
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data as { art?: string; kanalId?: string; subscription?: PushSubscriptionJSON } | undefined;
    if (d?.art === 'kanal-oeffnen' && d.kanalId) {
      window.dispatchEvent(new CustomEvent('stellium:kanal-oeffnen', { detail: d.kanalId }));
    }
    if (d?.art === 'push-erneuert' && d.subscription) {
      window.dispatchEvent(new CustomEvent('stellium:push-erneuert', { detail: d.subscription }));
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
 *
 * `null` und `'unbekannt'` sind ABSICHTLICH zwei verschiedene Werte, auch
 * wenn beide "noch kein Ja/Nein" heißen. `null` heißt "die Anfrage läuft
 * gerade, die Antwort kommt gleich" — eine kurze, garantiert endende Lücke
 * direkt nach dem Start. `'unbekannt'` heißt "es kommt NIE eine Antwort":
 * entweder bietet diese App-Fassung den Aufruf gar nicht an, oder der Aufruf
 * ist fehlgeschlagen. Ohne eigenen Wert dafür landete dieser zweite Fall
 * für immer im ersten — dauerhaft als "geht gleich los" behandelt, obwohl
 * nichts mehr kommt. Genau das war der Fehler, den dieser Code laut
 * Kommentar unten schon einmal beheben sollte.
 */
let appKannMelden: boolean | null | 'unbekannt' = null;

export function meldewegPruefen(): void {
  if (!inDerApp()) return;

  /* DIE FALLE, die hier vorher steckte: `a?.b?.()` ist EINE zusammenhängende
     "optional chain". Hängen `.then()`/`.catch()` OHNE eigenes `?.` direkt
     dahinter, zählen sie zu genau dieser Kette dazu. Fehlt `b` (hier:
     notifyMoeglich, weil ältere App-Fassung), bricht nicht nur `b()` ab,
     sondern die GESAMTE Kette bis zum Schluss: `.then()` UND `.catch()`
     laufen dann NIE, der ganze Ausdruck wird still zu `undefined` — kein
     Wert, keine Ausnahme. Ein `.catch()` hinter einem `?.()` fängt darum
     genau den Fall NICHT ab, für den es hingeschrieben wurde ("die Bridge
     kennt den Aufruf nicht") — es fängt nur eine echte Ablehnung jenes
     Promise ab, das es überhaupt erst gibt, wenn der Aufruf stattgefunden
     hat. So blieb `appKannMelden` bei einer alten App-Fassung für immer bei
     `null` stehen, und `erlaubnisStand()` meldete "erlaubt", ohne dass je
     eine Antwort eingetroffen war — derselbe Fehler wie im Kommentar unter
     erlaubnisStand(), nur durch eine andere Tür wieder hereingekommen.
     Deshalb hier ERST synchron prüfen, ob es den Aufruf überhaupt gibt: kein
     `.catch()` kann eine Kette retten, die nie losläuft. */
  const pruefen = window.stellium?.notifyMoeglich;
  if (typeof pruefen !== 'function') {
    appKannMelden = 'unbekannt';
    return;
  }

  void pruefen()
    .then((geht) => { appKannMelden = geht; })
    .catch((fehler) => {
      // Die Bridge gibt es, der Aufruf ist aber fehlgeschlagen — auch das
      // ist keine Antwort, auf deren Grundlage "erlaubt" behauptet werden
      // darf. Anders als eine schlicht fehlende Funktion ist das ein
      // echter Fehler und kein erwarteter Zustand, darum geloggt.
      console.warn('[benachrichtigung] notifyMoeglich fehlgeschlagen:', (fehler as Error).message);
      appKannMelden = 'unbekannt';
    });
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
 *
 * `appKannMelden === 'unbekannt'` zählt hier wie `false`, nicht wie `true`
 * oder wie das noch unentschiedene `null`: Eine App-Fassung ohne
 * `notifyMoeglich` ist zwangsläufig älter als der Tag, an dem dieser Aufruf
 * eingeführt wurde — und der wurde genau deshalb eingeführt, weil ältere,
 * ad-hoc signierte Fassungen bei der Mitteilungszentrale still abgewiesen
 * wurden (siehe Absatz oben). Wer den Aufruf noch nicht kennt, gehört damit
 * eher zu der Gruppe, die das Problem hatte, als zu der, die es nicht hat.
 * "Geht nicht" ist also nicht nur die vorsichtigere, sondern die besser
 * begründete Annahme — und so oder so ehrlicher, als "erlaubt" auf
 * Grundlage einer Antwort zu behaupten, die nie eingetroffen ist.
 */
export function erlaubnisStand(): Erlaubnis {
  if (inDerApp()) {
    return appKannMelden === false || appKannMelden === 'unbekannt' ? 'geht-nicht' : 'erlaubt';
  }
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
    macAnzeigen({ titel: input.titel, text: input.text, kanalId: input.kanalId, gruppe: input.gruppe });
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

/* ── Web Push ─────────────────────────────────────────────────── */

/**
 * Der öffentliche VAPID-Schlüssel des Servers — kommt mit dem 'ready'-
 * Ereignis (siehe state/store.ts) und liegt erst ab dann bereit. Kein
 * Zugriff darauf VOR der ersten Verbindung: ohne Server-Antwort ließe sich
 * ohnehin kein Abonnement anlegen, das der Server später wiedererkennt.
 */
let vapidSchluessel: string | null = null;

export function vapidSchluesselSetzen(schluessel: string | null): void {
  vapidSchluessel = schluessel;
}

/**
 * Aus dem base64url-Text, den der Server schickt, die Byte-Form, die
 * `pushManager.subscribe()` verlangt.
 *
 * Ein neuerer Browser nähme den Text auch direkt — diese Umwandlung ist der
 * Weg, der in jeder Safari-Fassung seit der Einführung von Web Push auf
 * iOS funktioniert, und genau darauf kommt es hier an.
 */
function alsUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const normal = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const roh = atob(normal);
  // new Uint8Array(länge) statt Uint8Array.from(): Letzteres liefert unter
  // neueren TS-Typen einen ArrayBufferLike-Puffer, den pushManager.subscribe()
  // nicht annimmt (es verlangt genau ArrayBuffer, kein SharedArrayBuffer).
  const bytes = new Uint8Array(roh.length);
  for (let i = 0; i < roh.length; i += 1) bytes[i] = roh.charCodeAt(i);
  return bytes;
}

/**
 * Dieses Gerät beim Push-Dienst des Browsers anmelden.
 *
 * Gibt `null` zurück, wenn nichts zu tun ist oder nichts getan werden kann —
 * in der App (Electron braucht das nicht), ohne erteilte Erlaubnis, ohne
 * Service Worker, ohne Schlüssel vom Server. Der Aufrufer (state/store.ts)
 * entscheidet dann selbst, ob er es später noch einmal versucht.
 *
 * Bereits bestehende Abonnements werden unverändert zurückgegeben — nicht
 * nur aus Sparsamkeit: ein zweites `subscribe()` mit demselben Schlüssel
 * liefert ohnehin dieselbe `endpoint`, ein neuer Aufruf wäre wirkungslose
 * Arbeit.
 */
export async function pushAbonnieren(): Promise<PushSubscriptionJSON | null> {
  if (inDerApp() || erlaubnisStand() !== 'erlaubt') return null;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (!vapidSchluessel) return null;

  try {
    const registrierung = arbeiter ?? await navigator.serviceWorker.ready;
    const bestehend = await registrierung.pushManager.getSubscription();
    const abo = bestehend ?? await registrierung.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: alsUint8Array(vapidSchluessel),
    });
    // Von Hand statt per Cast zusammengesetzt: `toJSON()` ist im DOM-Typ
    // vollständig optional (`endpoint?`, `keys?: Record<string,string>`),
    // unsere Form verlangt beides. Fehlt eins davon wirklich — käme
    // praktisch nie vor —, ist "kein Abonnement" die ehrlichere Antwort als
    // eins mit einer leeren Zeichenkette darin.
    const roh = abo.toJSON();
    if (!roh.endpoint || !roh.keys?.p256dh || !roh.keys?.auth) return null;
    return { endpoint: roh.endpoint, keys: { p256dh: roh.keys.p256dh, auth: roh.keys.auth } };
  } catch (fehler) {
    // Kommt vor allem vor, wenn iOS das Abonnement (noch) verweigert, obwohl
    // die Erlaubnis erteilt ist — etwa direkt nach dem ersten Hinzufügen zum
    // Startbildschirm. Kein Grund, der Person einen Fehler zu zeigen: der
    // nächste Versuch beim nächsten Verbindungsaufbau holt es nach.
    console.warn('[push] Abonnement fehlgeschlagen:', (fehler as Error).message);
    return null;
  }
}

/** Dieses Gerät wieder abmelden — liefert die `endpoint` zum Löschen beim Server. */
export async function pushAbbestellen(): Promise<string | null> {
  if (inDerApp() || !arbeiter) return null;
  try {
    const abo = await arbeiter.pushManager.getSubscription();
    if (!abo) return null;
    const endpoint = abo.endpoint;
    await abo.unsubscribe();
    return endpoint;
  } catch {
    return null;
  }
}
