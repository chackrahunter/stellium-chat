/**
 * Selbstgezeichnete macOS-Benachrichtigung — die EINE Eintrittsstelle.
 *
 * WARUM DIESE DATEI VON lib/benachrichtigung.ts GETRENNT IST
 * benachrichtigung.ts entscheidet, OB benachrichtigt wird (Ruhezeiten,
 * Stummschaltung, "nicht stören", schon offener Kanal — all das ist dort
 * schon geprüft, bevor `zeigen()` überhaupt aufgerufen wird). Diese Datei
 * kümmert sich nur noch um das WIE auf macOS: ein eigenes Fenster statt der
 * echten Systembenachrichtigung, die dort ohne Entwicklersignatur ohnehin
 * nur ins Leere liefe (siehe electron/main.ts, meldungenMoeglich()).
 *
 * Getrennte Dateien, damit beide unabhängig voneinander bearbeitet werden
 * können. Mehr dazu: docs/… (falls angelegt) oder einfach hier weiterlesen.
 *
 * ANBINDUNG — GENAU DIESE ZEILEN GEHÖREN IN lib/benachrichtigung.ts
 *
 * In `zeigen()`, im Zweig `if (inDerApp()) { … }`, direkt neben dem
 * bestehenden `window.stellium?.notify(...)`-Aufruf:
 *
 *   import { macAnzeigen } from './mac-benachrichtigung.js';   // Kopf der Datei
 *   ...
 *   if (inDerApp()) {
 *     void window.stellium?.notify({ ... });               // unverändert
 *     void window.stellium?.flashWindow();                  // unverändert
 *     macAnzeigen({ titel: input.titel, text: input.text, kanalId: input.kanalId, gruppe: input.gruppe }); // NEU
 *     return true;
 *   }
 *
 * Das ist alles. macAnzeigen() prüft die Plattform selbst (nur macOS tut
 * etwas) und holt sich die Sprache selbst — der Aufrufer muss nichts davon
 * wissen. Auf Windows/Linux und im Browser ist der Aufruf ein Leerlauf.
 */
import { currentUiLanguage } from '../i18n/index.js';

export interface MacAnzeigenInput {
  titel: string;
  text: string;
  kanalId?: string;
  gruppe?: string;
}

/**
 * Zeigt die selbstgezeichnete macOS-Anzeige. Auf jeder anderen Plattform ein
 * Leerlauf — die Weiche sitzt bewusst hier und nicht beim Aufrufer.
 *
 * Fehlt window.stellium.macNotify (ältere, noch nicht neu gebaute
 * App-Fassung während einer laufenden Aktualisierung), passiert schlicht
 * nichts — die echte, wenn auch auf macOS meist wirkungslose,
 * Systembenachrichtigung aus benachrichtigung.ts bleibt der Rückfall.
 */
export function macAnzeigen(input: MacAnzeigenInput): boolean {
  if (typeof window === 'undefined' || window.stellium?.platform !== 'darwin') return false;
  if (!window.stellium.macNotify) return false;
  void window.stellium.macNotify({
    titel: input.titel,
    text: input.text,
    sprache: currentUiLanguage(),
    kanalId: input.kanalId,
    gruppe: input.gruppe,
  });
  return true;
}
