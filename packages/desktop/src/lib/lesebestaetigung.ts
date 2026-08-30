import { useEffect, useRef, type RefObject } from 'react';
import { socket } from '../net/socket.js';

/**
 * Wie eine Person als „hat gelesen" gilt — und wie das gemeldet wird.
 *
 * Der einzige Absender ist dieser Haken: er ersetzt die frühere Zeile in
 * MessageList.tsx, die nach jeder Änderung der Nachrichtenliste einfach die
 * jüngste geladene Nachricht als gelesen meldete — auch wenn sie nie im Bild
 * stand, weil das geladene Fenster größer ist als der sichtbare Ausschnitt.
 * Das behauptete ein Lesen, das nicht stattgefunden hatte.
 *
 * „Wirklich gelesen" heißt hier: das Fenster ist vorn (visibilityState
 * "visible", Fokus vorhanden) UND die Nachricht schneidet sich mit dem
 * sichtbaren Ausschnitt des Verlaufs (IntersectionObserver). Nur beides
 * zusammen zählt — eine Nachricht, die in einem Hintergrundfenster
 * durchgelaufen ist, ist nicht gelesen.
 *
 * Gemeldet wird gebündelt: höchstens alle anderthalb Sekunden ein `read` mit
 * der am weitesten fortgeschrittenen gesehenen Kennung, dazu beim Verlassen
 * des Kanals (Bauteil wechselt die Kennung oder wird abgebaut). Ein langer,
 * schnell durchscrollter Verlauf soll eine Handvoll Meldungen erzeugen, nicht
 * eine pro Bildlaufschritt.
 *
 * Die eigentliche Ablage der Lesemarke — samt Zeitpunkt, samt „nur
 * vorwärts" — liegt auf dem Server in messages.markRead(); dieser Haken
 * schickt nur, wann immer sich der wirklich gesehene Stand ändert.
 */
const BUENDEL_MS = 1500;

function istVorne(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useLesemarke(
  scrollRef: RefObject<HTMLElement | null>,
  channelId: string,
  /**
   * Reiner Anstoß, den sichtbaren Bereich neu zu vermessen — der Inhalt wird
   * nicht gelesen, nur die Änderung der Referenz. In MessageList.tsx ist das
   * die gerade gerenderte Nachrichtenliste: neue Seite, neue Nachricht, neues
   * Fenster.
   */
  stand: unknown,
): void {
  const hoechsteGesehen = useRef<string | null>(null);
  const zuletztGemeldet = useRef<string | null>(null);
  const sichtbar = useRef<Set<string>>(new Set());
  const timer = useRef<number | null>(null);

  const melden = () => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; }
    const ziel = hoechsteGesehen.current;
    if (!ziel || ziel === zuletztGemeldet.current) return;
    zuletztGemeldet.current = ziel;
    socket.send({ t: 'read', channelId, lastMessageId: ziel });
  };

  const planen = () => {
    if (timer.current != null) return;
    timer.current = window.setTimeout(melden, BUENDEL_MS);
  };

  const beruecksichtigen = () => {
    if (!istVorne()) return;
    for (const id of sichtbar.current) {
      if (!hoechsteGesehen.current || id > hoechsteGesehen.current) hoechsteGesehen.current = id;
    }
    if (hoechsteGesehen.current && hoechsteGesehen.current !== zuletztGemeldet.current) planen();
  };

  // Kanalwechsel: der alte Stand gehört nicht zum neuen Kanal. Vorher noch
  // melden, was dort offen war — das ist das „beim Verlassen des Kanals".
  // `melden` absichtlich nicht in der Abhängigkeitsliste: die Funktion ist
  // bei jedem Render eine neue Kennung, liest aber nur Refs (plus dasselbe
  // `channelId`, das hier schon steht). Stünde sie in der Liste, liefe
  // dieser Effekt bei JEDEM Render neu an — und würde damit
  // `hoechsteGesehen`/`zuletztGemeldet`/`sichtbar` bei jeder fremden
  // Neuzeichnung zurücksetzen, nicht nur beim echten Kanalwechsel.
  useEffect(() => {
    hoechsteGesehen.current = null;
    zuletztGemeldet.current = null;
    sichtbar.current = new Set();
    return () => melden();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- melden absichtlich draußen, siehe Kommentar oben
  }, [channelId]);

  // Das Fenster bekommt Aufmerksamkeit zurück (Tab gewechselt, App wieder
  // vorn): nachholen, was währenddessen schon geometrisch im Bild stand, aber
  // wegen fehlender Aufmerksamkeit noch nicht zählte. `beruecksichtigen`
  // ebenfalls absichtlich draußen (derselbe Grund wie oben) — sonst würde
  // dieser Effekt bei jedem Render die beiden globalen Listener ab- und
  // wieder anmelden, statt nur beim Kanalwechsel.
  useEffect(() => {
    document.addEventListener('visibilitychange', beruecksichtigen);
    window.addEventListener('focus', beruecksichtigen);
    return () => {
      document.removeEventListener('visibilitychange', beruecksichtigen);
      window.removeEventListener('focus', beruecksichtigen);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- beruecksichtigen absichtlich draußen, siehe Kommentar oben
  }, [channelId]);

  // Der Beobachter selbst — neu aufgesetzt, wenn sich die dargestellte Liste
  // ändert (neue Seite nachgeladen, neue Nachricht angekommen).
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId;
        /* Nur echte, vom Server vergebene Kennungen zählen (Präfix "m_",
           siehe util/id.ts auf dem Server). Eine gerade erst optimistisch
           angezeigte eigene Nachricht trägt "tmp_<clientId>" — diese Kennung
           an den Server zu melden würde die Lesemarke dauerhaft verklemmen:
           sie sortiert lexikalisch hinter jeder echten ("t" > "m"), und die
           Vorwärts-Prüfung in markRead() (last_read_message_id < ?) ließe die
           Marke dann nie wieder weiterrücken. */
        if (!id || !id.startsWith('m_')) continue;
        if (entry.isIntersecting) sichtbar.current.add(id);
        else sichtbar.current.delete(id);
      }
      beruecksichtigen();
    }, { root, threshold: 0.5 });

    for (const el of root.querySelectorAll<HTMLElement>('[data-message-id]')) observer.observe(el);
    return () => observer.disconnect();
    // `beruecksichtigen` absichtlich draußen (derselbe Grund wie in den
    // Effekten oben) — sonst baute dieser Effekt den IntersectionObserver bei
    // JEDEM Render neu auf, statt nur wenn sich Kanal/Liste wirklich ändern.
    // `scrollRef` ist dagegen eine stabile Ref-Objektkennung (von der
    // aufrufenden Stelle einmalig per useRef angelegt) und steht deshalb
    // gefahrlos in der Liste.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- beruecksichtigen absichtlich draußen, siehe Kommentar oben
  }, [channelId, stand, scrollRef]);
}
