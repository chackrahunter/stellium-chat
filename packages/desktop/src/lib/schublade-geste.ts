/**
 * Die Schublade auf dem Telefon folgt dem Finger.
 *
 * Bisher ging sie nur über den Knopf auf und nur über ein Tippen daneben zu.
 * Jede Nachrichten-App auf dem Telefon lässt sie vom linken Rand aufziehen und
 * zur Seite wegwischen — wer das gewohnt ist, wischt hier ins Leere.
 *
 * Was sich daran gut anfühlt, ist nicht das Wischen selbst, sondern vier
 * Kleinigkeiten (nach Apples „Designing Fluid Interfaces“):
 *   1. Während des Ziehens klebt die Schublade am Finger, 1:1, und der
 *      Schleier dunkelt im selben Maß ab.
 *   2. Über die offene Stellung hinaus gibt sie nach wie ein Gummiband, statt
 *      hart anzuschlagen.
 *   3. Beim Loslassen entscheidet nicht, wo der Finger ist, sondern wohin er
 *      unterwegs war: die Geschwindigkeit wird wie beim Scrollen
 *      weitergerechnet (`projektion`). Ein kurzer Schnipser reicht.
 *   4. Der Rest der Bewegung beginnt mit dem Tempo des Fingers — keine Naht
 *      zwischen Ziehen und Ausrollen. Und wer währenddessen wieder zufasst,
 *      hält sie dort fest, wo sie gerade ist.
 *
 * Touch- statt Pointer-Ereignisse: iOS meldet bei touch-action: auto nach der
 * ersten Bewegung `pointercancel`, auch wenn sie waagerecht war. Ein nicht
 * passiver touchmove-Zuhörer kann das Scrollen dagegen gezielt übernehmen —
 * und nur dann, wenn die Richtung waagerecht feststeht.
 */
import { flushSync } from 'react-dom';
import { useStore } from '../state/store.js';

/** So nah am linken Rand muss der Finger aufsetzen, um aufzuziehen. */
const RAND = 22;
/** Erst ab dieser Strecke steht fest, ob gewischt oder gescrollt wird. */
const SCHWELLE = 10;
/** Apples Verzögerung beim Ausrollen (UIScrollView, „normal“). */
const VERZOEGERUNG = 0.998;
/** Nur die letzten Bewegungen zählen fürs Tempo — sonst bremst ein Zögern am Anfang. */
const TEMPO_FENSTER_MS = 100;

/** Wo eine Bewegung mit diesem Tempo (px/s) zur Ruhe käme, relativ zu jetzt. */
function projektion(tempo: number): number {
  return ((tempo / 1000) * VERZOEGERUNG) / (1 - VERZOEGERUNG);
}

/** Je weiter über die Grenze, desto weniger folgt die Schublade. */
function gummiband(ueber: number, mass: number, k = 0.55): number {
  return (ueber * mass * k) / (mass + k * Math.abs(ueber));
}

/** Dieselbe Bedingung wie die Telefonschicht in mobil.css. */
const TELEFON = '(max-width: 880px), ((max-height: 500px) and (pointer: coarse))';

export function schubladeGesteVerbinden(): void {
  if (!window.matchMedia('(pointer: coarse)').matches) return;
  const telefon = window.matchMedia(TELEFON);
  const wurzel = document.documentElement;

  let teile: HTMLElement[] = [];
  let schleier: HTMLElement | null = null;
  let breite = 0;
  /** Stellung beim Aufsetzen: -breite = zu, 0 = offen, dazwischen = im Lauf. */
  let basis = 0;
  let start: { x: number; y: number } | null = null;
  let zieht = false;
  let jetzt = 0;
  let verlauf: { x: number; t: number }[] = [];

  const stellen = (x: number) => {
    jetzt = x;
    for (const el of teile) el.style.transform = `translateX(${x}px)`;
    if (schleier) schleier.style.opacity = String(Math.max(0, Math.min(1, 1 + x / breite)));
  };

  document.addEventListener('touchstart', (e) => {
    start = null;
    if (!telefon.matches || e.touches.length !== 1) return;
    const store = useStore.getState();
    // Über einem offenen Fenster gehört der Finger dem Fenster.
    if (store.overlay) return;
    const rail = document.querySelector<HTMLElement>('.app > .rail');
    const sidebar = document.querySelector<HTMLElement>('.app > .sidebar');
    if (!rail || !sidebar) return;

    /* Die Stellung, die gerade zu SEHEN ist — nicht die, die der Zustand
       meint. Läuft die Schublade noch aus, greift der Finger sie dort. */
    breite = rail.offsetWidth + sidebar.offsetWidth;
    const sichtbar = new DOMMatrixReadOnly(getComputedStyle(sidebar).transform).m41;
    basis = Math.max(-breite, Math.min(0, sichtbar));
    const zu = basis <= -breite + 1;

    /* Zu: nur vom Rand aus. Sonst überall — offen deckt der Schleier den
       Rest ab, und läuft sie gerade aus, trägt sie schon pointer-events: none;
       eine Prüfung auf das Ziel ließe den Finger dann durch sie hindurch
       greifen. Erst ein waagerechter Zug macht daraus ein Ziehen. */
    const finger = e.touches[0];
    if (zu && (store.schubladeOffen || finger.clientX > RAND)) return;

    teile = [rail, sidebar];
    schleier = document.querySelector<HTMLElement>('.schublade-schleier');
    start = { x: finger.clientX, y: finger.clientY };
    zieht = false;
    verlauf = [{ x: finger.clientX, t: e.timeStamp }];
  }, { passive: true });

  const beiBewegung = (e: TouchEvent) => {
    if (!start) return;
    const finger = e.touches[0];
    const dx = finger.clientX - start.x;
    const dy = finger.clientY - start.y;

    if (!zieht) {
      if (Math.abs(dx) < SCHWELLE && Math.abs(dy) < SCHWELLE) return;
      // Senkrecht gewinnt das Scrollen. Nach rechts über „offen“ hinaus
      // bleibt erlaubt — dort antwortet das Gummiband.
      const zu = basis <= -breite + 1;
      if (Math.abs(dy) > Math.abs(dx) || (zu && dx < 0)) { start = null; return; }
      zieht = true;
      wurzel.classList.add('schublade-zieht');
    }

    // Passiv angemeldet (Schublade zu) ist das Ereignis nicht abbrechbar.
    if (e.cancelable) e.preventDefault();
    let x = basis + dx;
    if (x > 0) x = gummiband(x, breite);
    stellen(Math.max(-breite, x));
    verlauf.push({ x: finger.clientX, t: e.timeStamp });
    while (verlauf.length > 2 && e.timeStamp - verlauf[0].t > TEMPO_FENSTER_MS) verlauf.shift();
  };

  /* Ein nicht passiver touchmove-Zuhörer lässt den Browser bei JEDEM
     Scrollen auf den Hauptfaden warten — auch im Verlauf, während dort neue
     Nachrichten gezeichnet werden. Gebraucht wird das Abbrechen nur bei
     offener Schublade: dort scrollte sonst die Kanalliste unter dem Finger
     mit, während er sie zuzieht. Zu genügt passiv; vom Rand aus konkurriert
     nichts Waagerechtes, schlimmstenfalls rückt der Verlauf ein paar Punkte.

     Umgeschaltet wird mit dem Zustand und nicht erst beim Aufsetzen: ob
     touchmove abbrechbar ist, entscheidet der Browser zu Beginn der
     Berührung — ein im touchstart angemeldeter Zuhörer käme dafür zu spät.
     Und nur in der Telefonansicht; am Tablet quer gibt es keine Schublade. */
  let angemeldet: boolean | null = null;
  const anmelden = () => {
    const blockierend = telefon.matches ? useStore.getState().schubladeOffen : null;
    if (blockierend === angemeldet) return;
    if (angemeldet !== null) document.removeEventListener('touchmove', beiBewegung);
    if (blockierend !== null) document.addEventListener('touchmove', beiBewegung, { passive: !blockierend });
    angemeldet = blockierend;
  };
  anmelden();
  telefon.addEventListener('change', anmelden);
  useStore.subscribe((neu, alt) => { if (neu.schubladeOffen !== alt.schubladeOffen) anmelden(); });

  const loslassen = (abgebrochen: boolean) => {
    if (!start) return;
    start = null;
    if (!zieht) return;
    zieht = false;

    const erst = verlauf[0];
    const letzt = verlauf[verlauf.length - 1];
    const dauer = Math.max(1, letzt.t - erst.t);
    const tempo = ((letzt.x - erst.x) / dauer) * 1000;
    const auf = abgebrochen ? basis > -breite / 2 : jetzt + projektion(tempo) > -breite / 2;

    /* Übergabe an den Übergang aus mobil.css, mit dem Tempo des Fingers.
       Die Kurve dort (0.16, 1, 0.3, 1) startet mit dem 6,25-Fachen ihres
       Durchschnittstempos — so lang muss sie also dauern, damit ihr erster
       Schritt so schnell ist wie der Finger zuletzt. Ohne Schwung bleibt
       es bei der gewohnten Dauer. */
    const restweg = Math.abs((auf ? 0 : -breite) - jetzt);
    const mitSchwung = Math.sign(tempo) === (auf ? 1 : -1) && Math.abs(tempo) > 50;
    const sekunden = mitSchwung ? Math.min(0.42, Math.max(0.16, (6.25 * restweg) / Math.abs(tempo))) : 0.26;
    const bewegt = schleier ? [...teile, schleier] : teile;
    for (const el of bewegt) el.style.transitionDuration = `${sekunden}s`;

    /* Synchron, damit Klasse und Stellung im selben Bild wechseln. Sonst
       zeichnet der Browser einen Zwischenstand ohne Fingerstellung und mit
       der alten Klasse — die Schublade zuckte kurz in die falsche Richtung. */
    flushSync(() => useStore.getState().setSchublade(auf));
    wurzel.classList.remove('schublade-zieht');
    for (const el of teile) el.style.transform = '';
    if (schleier) schleier.style.opacity = '';

    window.setTimeout(() => {
      if (zieht) return;
      for (const el of bewegt) el.style.transitionDuration = '';
    }, sekunden * 1000 + 50);
  };

  document.addEventListener('touchend', () => loslassen(false), { passive: true });
  document.addEventListener('touchcancel', () => loslassen(true), { passive: true });
}
