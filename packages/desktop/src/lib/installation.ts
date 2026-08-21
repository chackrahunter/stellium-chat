/**
 * Erkennen, ob die Seite als Startbildschirm-App läuft — und wenn nicht, in
 * welchem Browser sie geöffnet wurde.
 *
 * Der Grund für den Aufwand: die Anleitung zum Einrichten ist in jedem
 * Browser eine andere, und eine falsche Anleitung ist schlimmer als keine.
 * Wer nach einem Teilen-Symbol sucht, das es in seinem Browser nicht gibt,
 * gibt auf.
 *
 * Erkannt wird über die Kennung des Browsers. Das ist unschön und
 * grundsätzlich unzuverlässig — es gibt hier aber keine Alternative: welcher
 * Browser gerade läuft, verrät keine saubere Schnittstelle. Deshalb ist die
 * Erkennung so gebaut, dass ein Fehlschlag harmlos bleibt: unbekannte
 * Browser bekommen eine allgemeine Anleitung statt einer falschen.
 */

export type Browserfamilie =
  | 'safari-ios'
  | 'andere-ios'
  | 'chrome-android'
  | 'samsung'
  | 'firefox-android'
  | 'in-app'
  | 'unbekannt';

export interface Lage {
  eigenstaendig: boolean;
  mobil: boolean;
  familie: Browserfamilie;
  browsername: string;
  ios: boolean;
}

/* Läuft die Seite bereits als eigene App? Zwei Wege, weil iOS den einen und
   alle anderen den anderen kennen. */
export function eigenstaendig(): boolean {
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches;
}

/* Ein Telefon oder Tablet — nicht ein schmal gezogenes Fenster am
   Schreibtisch.

   Nicht ueber die Breite: ein iPad Pro misst 1024 Punkte auf der kurzen
   Kante, faellt also durch jede Schwelle, die ein schmales Fenster am
   Schreibtisch aussortieren soll. Und auf dem Tablet soll die Anleitung
   ebenso erscheinen.

   `hover: none` ist das bessere Merkmal: es fragt, ob es ueberhaupt einen
   Zeiger gibt, der ueber etwas fahren kann, ohne zu druecken. Ein Finger
   kann das nicht, eine Maus und ein Trackpad schon. Zusammen mit `pointer:
   coarse` trennt das Finger von Maus statt klein von gross — und ein
   Notebook mit Beruehrungsschirm bleibt aussen vor, weil es beides hat. */
function istMobil(): boolean {
  return window.matchMedia('(pointer: coarse) and (hover: none)').matches;
}

function familieBestimmen(k: string): { familie: Browserfamilie; name: string } {
  /* Zuerst die eingebauten Browser aus anderen Apps. Sie melden sich oft
     zusätzlich als Safari oder Chrome — würde man später prüfen, bekämen
     ihre Nutzer eine Anleitung für ein Menü, das es bei ihnen nicht gibt.
     Und einrichten lässt sich aus ihnen heraus ohnehin nichts. */
  if (/Instagram|FBAN|FBAV|FB_IAB|Line\/|Snapchat|Twitter|TikTok|LinkedInApp|Pinterest/i.test(k)) {
    return { familie: 'in-app', name: 'einer anderen App' };
  }

  const ios = /iPhone|iPad|iPod/.test(k)
    /* iPadOS gibt sich seit Fassung 13 als Mac aus. Ein Mac mit Fingereingabe
       ist aber immer ein iPad. */
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (ios) {
    if (/CriOS/.test(k)) return { familie: 'andere-ios', name: 'Chrome' };
    if (/FxiOS/.test(k)) return { familie: 'andere-ios', name: 'Firefox' };
    if (/EdgiOS/.test(k)) return { familie: 'andere-ios', name: 'Edge' };
    if (/OPiOS|OPT\//.test(k)) return { familie: 'andere-ios', name: 'Opera' };
    if (/DuckDuckGo/.test(k)) return { familie: 'andere-ios', name: 'DuckDuckGo' };
    return { familie: 'safari-ios', name: 'Safari' };
  }

  if (/SamsungBrowser/.test(k)) return { familie: 'samsung', name: 'Samsung Internet' };
  if (/Firefox|FxiOS/.test(k)) return { familie: 'firefox-android', name: 'Firefox' };
  if (/EdgA/.test(k)) return { familie: 'chrome-android', name: 'Edge' };
  if (/OPR|Opera/.test(k)) return { familie: 'chrome-android', name: 'Opera' };
  if (/Chrome|CriOS/.test(k)) return { familie: 'chrome-android', name: 'Chrome' };
  return { familie: 'unbekannt', name: 'deinem Browser' };
}

export function lageBestimmen(): Lage {
  const k = navigator.userAgent;
  const { familie, name } = familieBestimmen(k);
  return {
    eigenstaendig: eigenstaendig(),
    mobil: istMobil(),
    familie,
    browsername: name,
    ios: familie === 'safari-ios' || familie === 'andere-ios',
  };
}

/**
 * Soll die Einrichtungsseite gezeigt werden?
 *
 * In der Schreibtisch-App niemals: dort gibt es keinen Startbildschirm, und
 * `window.stellium` gibt es nur dort.
 */
export function einrichtungNoetig(): boolean {
  if (window.stellium) return false;
  const lage = lageBestimmen();
  return lage.mobil && !lage.eigenstaendig;
}

/**
 * Android bietet das Einrichten selbst an. Das Ereignis kommt einmal und
 * früh — oft bevor React steht —, deshalb wird es hier am Modulanfang
 * eingefangen und aufgehoben, statt erst in einer Komponente darauf zu
 * warten.
 */
type Aufforderung = Event & { prompt: () => Promise<void> };
let aufgehoben: Aufforderung | null = null;
const horcher = new Set<(da: boolean) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    /* Ohne das zeigt Chrome seinen eigenen Balken zusätzlich zu unserer
       Seite — zwei Aufforderungen nebeneinander. */
    e.preventDefault();
    aufgehoben = e as Aufforderung;
    horcher.forEach((h) => h(true));
  });
}

export function aufforderungDa(): boolean {
  return aufgehoben !== null;
}

export function aufforderungBeobachten(h: (da: boolean) => void): () => void {
  horcher.add(h);
  return () => { horcher.delete(h); };
}

export async function einrichtenAnbieten(): Promise<void> {
  if (!aufgehoben) return;
  const a = aufgehoben;
  /* Jede Aufforderung lässt sich nur einmal zeigen. */
  aufgehoben = null;
  horcher.forEach((h) => h(false));
  await a.prompt();
}
