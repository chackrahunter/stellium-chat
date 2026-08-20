import { useEffect, useRef, type RefObject } from 'react';

/**
 * Fokusfalle für Fenster, die über der Oberfläche liegen.
 *
 * Gemessen am gebauten Stand: Schnellsuche geöffnet, fünfundzwanzigmal Tab —
 * neunzehn Sprünge landeten **hinter** dem Fenster, in der Symbolleiste, in
 * der Kanalliste, im Schreibfeld. Wer nicht mit der Maus arbeitet, tippt
 * damit blind in eine Oberfläche, die er gar nicht sieht: der abgedunkelte
 * Hintergrund verdeckt sie, der Fokus ist trotzdem dort. Ein Vorleseprogramm
 * liest denselben verdeckten Inhalt vor.
 *
 * Diese Falle hält den Fokus im Fenster, setzt ihn beim Öffnen hinein und
 * beim Schließen dorthin zurück, wo er herkam.
 *
 * **Ein Stapel, kein einzelner Zuhörer.** Fenster liegen übereinander — die
 * Einzelansicht einer Aufgabe über dem Brett, ein Bestätigen über der
 * Nutzerverwaltung. Fingen alle mit, hielte jedes den Fokus fest und keines
 * ließe ihn weiter. Deshalb greift immer nur das oberste.
 */

/** Alle offenen Fallen, das zuletzt geöffnete Fenster zuletzt. */
const stapel: HTMLElement[] = [];

const ZIELE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Was in diesem Fenster wirklich angesprungen werden kann. */
function fokussierbare(wurzel: HTMLElement): HTMLElement[] {
  return [...wurzel.querySelectorAll<HTMLElement>(ZIELE)]
    // Unsichtbares zählt nicht: ein verstecktes Dateifeld ist kein Tabstopp,
    // an dem jemand hängenbleiben will.
    .filter((el) => el.getClientRects().length > 0 && !el.hasAttribute('inert'));
}

/**
 * @param beiEscape Schließt das Fenster. Optional, aber empfohlen für alle
 *   Fenster, die keine eigene Escape-Behandlung mitbringen.
 *
 *   Warum das hier hingehört und nicht in die allgemeine Tastenbehandlung der
 *   App: die hängt am Fenster und läuft in der Blasenphase. Ein
 *   Auswahlfeld — `<select>` — verschluckt Escape aber vorher für sich selbst.
 *   Gemessen am gebauten Stand: Einstellungen geöffnet, zehnmal Tab bis zur
 *   Sprachwahl, Escape — und das Fenster blieb offen. Erst das zweite Escape
 *   schloss es. Hier in der Einfangphase kommt die Taste vor dem Auswahlfeld
 *   an, und nur das oberste Fenster nimmt sie.
 */
export function useFokusfalle(
  ref: RefObject<HTMLElement | null>,
  aktiv = true,
  beiEscape?: () => void,
): void {
  /* Der Rückruf liegt in einem Halter und nicht in der Abhängigkeitsliste.
     Fast jede Aufrufstelle gibt eine frisch erzeugte Funktion mit — `onClose`
     entsteht in App.tsx bei jedem Zeichnen neu. Stünde sie in der Liste, liefe
     dieser Effekt bei jedem Zeichnen erneut: Zuhörer ab und an, Stapel auf und
     zu, und beim Aufräumen jedes Mal ein Griff nach dem alten Fokus. Wer
     gerade tippt, verlöre dabei die Schreibstelle. */
  const escapeHalter = useRef(beiEscape);
  escapeHalter.current = beiEscape;

  useEffect(() => {
    const el = ref.current;
    if (!aktiv || !el) return;

    const vorher = document.activeElement as HTMLElement | null;
    stapel.push(el);
    // Das Fenster selbst muss anspringbar sein, sonst gibt es keinen Ort für
    // den Fokus, wenn darin (noch) kein Bedienelement steht.
    if (!el.hasAttribute('tabindex')) el.tabIndex = -1;

    /* Nur hineinsetzen, wenn nicht schon etwas darin den Fokus hat: mancher
       Dialog setzt ihn selbst (autoFocus im Suchfeld), und den würde ein
       zweiter Griff wieder wegnehmen. */
    if (!el.contains(document.activeElement)) {
      (fokussierbare(el)[0] ?? el).focus({ preventScroll: true });
    }

    const beiTaste = (e: KeyboardEvent) => {
      if (stapel[stapel.length - 1] !== el) return;   // nur das oberste Fenster
      if (e.key === 'Escape') {
        const schliessen = escapeHalter.current;
        if (!schliessen) return;
        e.preventDefault();
        e.stopPropagation();
        schliessen();
        return;
      }
      if (e.key !== 'Tab') return;
      const ziele = fokussierbare(el);
      if (!ziele.length) { e.preventDefault(); el.focus({ preventScroll: true }); return; }
      const erste = ziele[0];
      const letzte = ziele[ziele.length - 1];
      const jetzt = document.activeElement;
      const draussen = !el.contains(jetzt);
      if (e.shiftKey ? (draussen || jetzt === erste) : (draussen || jetzt === letzte)) {
        e.preventDefault();
        (e.shiftKey ? letzte : erste).focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', beiTaste, true);
    return () => {
      document.removeEventListener('keydown', beiTaste, true);
      const i = stapel.indexOf(el);
      if (i >= 0) stapel.splice(i, 1);
      /* Zurück, wo er herkam — aber nur, wenn dort noch etwas steht. Nach dem
         Schließen eines Fensters, das seinen Auslöser mitgenommen hat, wäre
         das ein Griff ins Leere. */
      if (vorher && vorher.isConnected) vorher.focus({ preventScroll: true });
    };
  }, [ref, aktiv]);
}
