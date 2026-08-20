/**
 * Merkt, wenn eine neue Fassung ausgeliefert wurde — und lädt sie nach.
 *
 * Warum das nötig ist: Die installierte App bekommt Aktualisierungen über den
 * Hauptprozess (siehe updates.ts). Im Browser und in der Startbildschirm-App
 * gab es dafür **gar nichts**. Beide halten ihre Seite im Speicher, oft über
 * Tage — auf dem iPhone lief die App noch mit dem Stand von vor drei
 * Auslieferungen, und ohne sie von Hand aus dem Umschalter zu werfen, änderte
 * sich daran nichts.
 *
 * Wie es erkannt wird: Beim Bauen bekommt jede Datei einen Namen mit
 * Inhaltsstempel (`index-BiSeWaNP.css`). Ändert sich irgendetwas am Bau,
 * ändert sich der Name. Wir merken uns den Namen, mit dem wir gestartet sind,
 * holen gelegentlich die nackte Startseite und vergleichen. Das braucht keine
 * eigene Schnittstelle und keinen Service Worker — nur ein paar Kilobyte.
 *
 * Nachgesehen wird nur, wenn die App gerade in den Vordergrund kommt. Ein
 * Wecker im Hintergrund würde auf dem Telefon nur Strom kosten, und wer die
 * App nicht ansieht, hat auch nichts von einer neuen Fassung.
 */

const ABSTAND_MS = 2 * 60 * 1000;   /* nicht öfter als alle zwei Minuten */

let unser: string | null = null;
let zuletzt = 0;
let laeuft = false;
let seitWann = 0;      /* wann die App zuletzt aus dem Blick geriet */

/**
 * Der Fingerabdruck dieses Baus: ALLE eingebundenen Dateien, sortiert.
 *
 * Der erste Entwurf verglich nur die Stilvorlage. Das fiel beim Ausprobieren
 * sofort auf: eine Auslieferung, die nur JavaScript ändert, lässt den Namen
 * der CSS-Datei unangetastet — und wäre unbemerkt geblieben. Genau solche
 * Auslieferungen sind die häufigsten.
 */
function eigenerStempel(): string | null {
  const teile: string[] = [];
  for (const el of document.querySelectorAll<HTMLLinkElement>('link[href]')) {
    const t = el.href.match(/\/assets\/[^/?#]+/);
    if (t) teile.push(t[0]);
  }
  for (const el of document.querySelectorAll<HTMLScriptElement>('script[src]')) {
    const t = el.src.match(/\/assets\/[^/?#]+/);
    if (t) teile.push(t[0]);
  }
  return teile.length ? [...new Set(teile)].sort().join('|') : null;
}

function stempelAus(html: string): string | null {
  const teile = [...html.matchAll(/\/assets\/[^"'?#]+/g)].map((m) => m[0]);
  return teile.length ? [...new Set(teile)].sort().join('|') : null;
}

/**
 * Schreibt die Person gerade? Dann NICHT neu laden.
 *
 * Ein Neuladen mitten im Satz wirft weg, was jemand getippt hat. Eine neue
 * Fassung ist nie so dringend, dass sie das wert wäre — sie kommt beim
 * nächsten Mal in den Vordergrund immer noch.
 */
function beschaeftigt(): boolean {
  const a = document.activeElement;
  if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) {
    if (a.value.trim().length > 0) return true;
  }
  /* Auch ein offener Dialog zählt: wer gerade etwas einstellt, will nicht
     mitten darin von vorn anfangen. */
  return Boolean(document.querySelector('[role="dialog"], dialog[open]'));
}

async function nachsehen(erzwungen = false): Promise<void> {
  if (laeuft || !unser) return;
  if (!erzwungen && Date.now() - zuletzt < ABSTAND_MS) return;
  laeuft = true;
  zuletzt = Date.now();
  try {
    /* `no-store`, sonst antwortet der Zwischenspeicher mit genau dem Stand,
       den wir gerade prüfen wollen. */
    const antwort = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } });
    if (!antwort.ok) return;
    const draussen = stempelAus(await antwort.text());
    if (!draussen || draussen === unser) return;
    if (beschaeftigt()) {
      /* Später nochmal — die Sperre unten sorgt dafür, dass es beim nächsten
         Vordergrund gleich wieder versucht wird. */
      zuletzt = 0;
      return;
    }
    console.info('[auffrischen] neue Fassung ausgeliefert — lade neu');
    location.reload();
  } catch {
    /* Kein Netz, Server weg — dann eben beim nächsten Mal. */
  } finally {
    laeuft = false;
  }
}

export function auffrischenVerbinden(): () => void {
  unser = eigenerStempel();
  if (!unser) return () => {};      /* im Entwicklungsbetrieb gibt es keine Stempel */

  /* Kommt die App aus dem Hintergrund zurück, wird immer nachgesehen — auch
     wenn die letzte Prüfung erst eben war. Die Sperre von fünf Minuten ist
     gegen ständiges Nachfragen im laufenden Betrieb gedacht, nicht gegen den
     einen Fall, in dem am ehesten etwas Neues da ist.
     Das war der erste Entwurf, und er ist beim Ausprobieren auf dem Gerät
     durchgefallen: App weggelegt, neu ausgeliefert, App geholt — nichts
     passierte, weil die Sperre noch lief. */
  const beiSicht = () => {
    if (document.visibilityState !== 'visible') { seitWann = Date.now(); return; }
    const weggewesen = seitWann > 0 && Date.now() - seitWann > 5_000;
    void nachsehen(weggewesen);
  };
  document.addEventListener('visibilitychange', beiSicht);
  window.addEventListener('focus', beiSicht);
  /* iOS stellt eine eingefrorene Startbildschirm-App gern aus dem
     Seiten-Zwischenspeicher wieder her — dann feuert pageshow, nicht focus. */
  window.addEventListener('pageshow', beiSicht);

  /* Das Sicherheitsnetz, und der eigentliche Grund, warum das hier
     verlässlich ist: In der Startbildschirm-App kamen nach dem Auftauen aus
     dem iOS-Einfrieren weder visibilitychange noch focus an — im
     Zugriffs-Log des Servers stand über Minuten KEINE einzige Anfrage vom
     Telefon, während dieselben Handler im Browser sauber liefen. Ein
     eingefrorener Timer dagegen feuert nach, sobald die Seite wieder Rechenzeit
     bekommt. Alle zweieinhalb Minuten, nur bei sichtbarer Seite, ein paar
     Kilobyte — das ist der Preis dafür, dass niemand mehr eine veraltete
     Fassung festhält. */
  const takt = setInterval(() => {
    if (document.visibilityState === 'visible') void nachsehen();
  }, 150_000);

  /* Einmal kurz nach dem Start: wer die App öffnet, während gerade
     ausgeliefert wurde, soll nicht bis zum nächsten Wechsel warten. */
  const ersteFrist = setTimeout(() => void nachsehen(true), 20_000);

  return () => {
    document.removeEventListener('visibilitychange', beiSicht);
    window.removeEventListener('focus', beiSicht);
    window.removeEventListener('pageshow', beiSicht);
    clearInterval(takt);
    clearTimeout(ersteFrist);
  };
}
