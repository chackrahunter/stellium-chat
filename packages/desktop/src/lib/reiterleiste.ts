import { useEffect, type RefObject } from 'react';

/**
 * Eine waagerechte Reiterleiste wirklich benutzbar machen.
 *
 * `overflow-x: auto` allein reicht nicht. Die Leiste war damit zwar
 * scrollbar, sah aber nicht danach aus: rechts stand ein halb
 * abgeschnittener Reiter, und nichts deutete darauf hin, dass dahinter noch
 * etwas kommt. Wer das sieht, hält es für kaputt, nicht für rollbar.
 *
 * Drei Dinge fehlen, und alle drei brauchen JavaScript:
 *
 * 1. Ein Hinweis auf mehr. Reines CSS kann nicht wissen, ob gerollt werden
 *    kann — dafür müssten Inhalts- und Sichtbreite verglichen werden.
 * 2. Das Mausrad. Ein Trackpad rollt waagerecht, ein Mausrad nicht: dort
 *    bleibt die Leiste ohne Zutun stehen, obwohl sie sich bewegen ließe.
 * 3. Der aktive Reiter muss ins Bild. Sonst öffnet sich ein Fenster mit
 *    einer Auswahl, die man nicht sieht.
 */
export function useReiterleiste(ref: RefObject<HTMLElement | null>, aktiv: unknown): void {
  /* Hinweise und Mausrad hängen nicht an der Auswahl — nur einmal einrichten. */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const pruefen = () => {
      const rest = el.scrollWidth - el.clientWidth;
      /* Zwei Punkte Spiel: bei Bruchteilen von Bildpunkten wäre der Hinweis
         sonst dauerhaft an, obwohl nichts zu rollen ist. */
      el.classList.toggle('tabs--mehr-links', el.scrollLeft > 2);
      el.classList.toggle('tabs--mehr-rechts', rest > 2 && el.scrollLeft < rest - 2);
    };

    const rad = (e: WheelEvent) => {
      /* Nur senkrechte Räder umlenken. Ein Trackpad, das ohnehin waagerecht
         rollt, würde sich sonst doppelt bewegen. */
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const rest = el.scrollWidth - el.clientWidth;
      if (rest <= 2) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };

    pruefen();
    el.addEventListener('scroll', pruefen, { passive: true });
    el.addEventListener('wheel', rad, { passive: false });
    /* Auch bei geänderter Fensterbreite: aus „passt" wird dann „passt nicht". */
    const beobachter = new ResizeObserver(pruefen);
    beobachter.observe(el);

    return () => {
      el.removeEventListener('scroll', pruefen);
      el.removeEventListener('wheel', rad);
      beobachter.disconnect();
    };
  }, [ref]);

  /* Den aktiven Reiter ins Bild holen — bei jedem Wechsel. */
  useEffect(() => {
    const el = ref.current;
    const gewaehlt = el?.querySelector('[aria-selected="true"]');
    gewaehlt?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [ref, aktiv]);
}
