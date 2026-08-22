import { useEffect, useState } from 'react';
import type { ClientEvent, ServerEvent } from '@stellium/shared';
import { socket } from '../net/socket.js';
import { anfrage } from './store.js';

/**
 * KI-Rückfall für Emoji-Vorschläge — die seltene Ausnahme.
 *
 * Der eigentliche Weg ist örtlich und kostenlos: packages/desktop/src/emoji/
 * katalog.ts (emojiVorschlaege()) gleicht den Nachrichtentext gegen den
 * Namensbestand ab, ganz ohne Netz. Diese Datei hier wird nur dann gebraucht,
 * wenn dieser Abgleich nichts Brauchbares findet UND jemand — an genau dieser
 * einen Nachricht — tatsächlich danach fragt. Kein Aufruf pro eingehender
 * Nachricht, keiner beim bloßen Überfahren; erst ein bewusster Klick auf den
 * Knopf in EmojiPicker.tsx löst kiVorschlaegeAnfordern() aus.
 *
 * EIGENES MODUL STATT state/store.ts
 *
 * Aus demselben Grund wie bei state/vorschlaege.ts (dort ausführlich
 * begründet): store.ts ist gerade in fremder Hand. anfrage() wird nur für
 * Zeitüberschreitung und Leitungsverlust gebraucht — das eigentliche Ergebnis
 * kommt über eine eigene Anmeldung am Draht (socket.onEvent unten), nicht über
 * den zentralen requestId-Verteiler in store.ts (der bräuchte dafür einen
 * eigenen `case`-Zweig, den diese Datei bewusst nicht anlegt).
 *
 * MERKSPEICHER — NIE DIESELBE NACHRICHT ZWEIMAL HINAUSSCHICKEN
 *
 * `ergebnis` hält jede je erhaltene Antwort fest, auch eine leere (die KI hat
 * nichts Passendes gefunden — dann soll ein zweiter Klick nicht noch einmal
 * fragen). `laufend` verhindert, dass ein doppelter Klick zwei Anfragen für
 * dieselbe Nachricht lostreten. Der Server führt denselben Merkspeicher noch
 * einmal (services/emoji-vorschlaege.ts, über app_settings) — er überlebt
 * damit auch einen Neustart der App oder eine zweite Person, die dieselbe
 * Nachricht fragt.
 */

const ergebnis = new Map<string, string[]>();
const anfragenUnterwegs = new Set<string>();
const beobachter = new Set<() => void>();

function melden(): void {
  for (const fn of beobachter) fn();
}

/** Antwort schon da (auch eine leere)? */
export function kiErgebnis(messageId: string): string[] | null {
  return ergebnis.get(messageId) ?? null;
}

export function kiLaeuft(messageId: string): boolean {
  return anfragenUnterwegs.has(messageId);
}

/**
 * Bei der KI nachfragen — höchstens einmal je Nachricht und Sitzung.
 *
 * Ohne Rückgabewert: das Ergebnis kommt nicht aus dieser Funktion, sondern
 * über kiErgebnis()/useKiVorschlag() — siehe Modulkommentar oben, derselbe
 * Aufbau wie state/vorschlaege.ts.
 */
export function kiVorschlaegeAnfordern(messageId: string): void {
  if (ergebnis.has(messageId) || anfragenUnterwegs.has(messageId)) return;
  anfragenUnterwegs.add(messageId);
  melden();

  void anfrage((requestId) => ({ t: 'ai:reaction-suggest', requestId, messageId } as ClientEvent))
    .catch(() => { /* store.ts zeigt den Fehler als Meldung; hier reicht das Aufräumen unten. */ })
    .finally(() => {
      /* Kam die Antwort schon über onEvent() unten an, ist der Eintrag in
         anfragenUnterwegs längst weg — das hier tut dann nichts mehr. Kam nie
         etwas an (Leitung weg, Zeitüberschreitung nach 45s), räumt es auf,
         damit ein erneuter Versuch möglich bleibt statt für immer "läuft". */
      if (anfragenUnterwegs.delete(messageId)) melden();
    });
}

/**
 * Reaktiver Zugriff für Komponenten — lädt nichts von selbst an, zeigt nur,
 * was da ist. Auslösen bleibt kiVorschlaegeAnfordern() vorbehalten, damit an
 * genau einer Stelle steht, wann eine Anfrage entsteht.
 */
export function useKiVorschlag(messageId: string): { emojis: string[] | null; laeuft: boolean } {
  const [, neuZeichnen] = useState(0);
  useEffect(() => {
    const fn = () => neuZeichnen((n) => n + 1);
    beobachter.add(fn);
    return () => { beobachter.delete(fn); };
  }, []);
  return { emojis: ergebnis.get(messageId) ?? null, laeuft: anfragenUnterwegs.has(messageId) };
}

socket.onEvent((ev: ServerEvent) => {
  if (ev.t !== 'ai:reaction-suggest') return;
  anfragenUnterwegs.delete(ev.messageId);
  ergebnis.set(ev.messageId, ev.emojis);
  melden();
});
