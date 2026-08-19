/**
 * Oberflächensprache mit Anbindung an den Zustand.
 *
 * Die Wörterbücher und das Einsetzen der Platzhalter liegen in kern.ts — ohne
 * Zugriff auf den Zustand. Nur so kann auch der Zustand selbst übersetzen,
 * ohne dass sich die beiden Module gegenseitig laden.
 */
import { useStore } from '../state/store.js';
import { spracheDesSystems, translate, type TranslationKey } from './kern.js';

export {
  coverage, spracheDesSystems, translate, UI_LANGUAGES,
  type Dictionary, type TranslationKey,
} from './kern.js';

/**
 * Übersetzungsfunktion für Komponenten.
 * Nutzt die eingestellte Oberflächensprache. Ist keine gesetzt — der Normalfall
 * bei einem frisch angelegten Konto — folgt die Oberfläche der Sprache des
 * Rechners. Anmeldung und Einführung erscheinen dadurch von Anfang an richtig,
 * bevor überhaupt jemand etwas einstellen konnte.
 */
export function useT(): (key: TranslationKey, werte?: Record<string, string | number>) => string {
  const sprache = useStore((s) => s.self?.uiLanguage || spracheDesSystems());
  return (key, werte) => translate(sprache, key, werte);
}

/** Aktuelle Oberflächensprache, auch außerhalb von Komponenten. */
export function currentUiLanguage(): string {
  return useStore.getState().self?.uiLanguage || spracheDesSystems();
}

export function t(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(currentUiLanguage(), key, werte);
}
