import { useStore } from '../state/store.js';
import { de } from './de.js';
import { en } from './en.js';

/**
 * Übersetzung der Oberfläche.
 *
 * Bewusst getrennt von der Nachrichtenübersetzung: Bedienelemente gehören in
 * feste Wörterbücher, nicht durch ein Sprachmodell. Sie müssen bei jedem Start
 * identisch sein, sofort da und dürfen nichts kosten.
 *
 * Deutsch ist die Ausgangssprache. Fehlt ein Eintrag in einer anderen Sprache,
 * fällt die Anzeige darauf zurück — nie auf einen leeren Text oder den Schlüssel.
 */

/** Die Schlüssel kommen aus dem deutschen Wörterbuch, die Werte sind Text.
 *  Ohne diese Aufweitung würde "as const" jeden deutschen Satz zu einem
 *  eigenen Typ machen und keine Übersetzung wäre zuweisbar. */
export type TranslationKey = keyof typeof de;
export type Dictionary = Record<TranslationKey, string>;

const WOERTERBUECHER: Record<string, Partial<Dictionary>> = { de, en };

/** Sprachen, für die die Oberfläche vollständig vorliegt. */
export const UI_LANGUAGES = [
  { code: 'de', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'en', native: 'English', flag: '🇬🇧' },
];

export function translate(sprache: string, key: TranslationKey, werte?: Record<string, string | number>): string {
  const kurz = sprache.toLowerCase().split(/[-_]/)[0];
  const wb = WOERTERBUECHER[kurz];
  const roh = (wb?.[key] as string | undefined) ?? de[key] ?? key;
  if (!werte) return roh;
  // Platzhalter der Form {name} einsetzen.
  return roh.replace(/\{(\w+)\}/g, (ganz, name) => String(werte[name] ?? ganz));
}

/**
 * Übersetzungsfunktion für Komponenten.
 * Nutzt die eingestellte Oberflächensprache; ist keine gesetzt, gilt die
 * Sprache, in der die Person auch Nachrichten liest.
 */
export function useT(): (key: TranslationKey, werte?: Record<string, string | number>) => string {
  const sprache = useStore((s) => s.self?.uiLanguage || s.self?.language || spracheDesSystems());
  return (key, werte) => translate(sprache, key, werte);
}

/** Aktuelle Oberflächensprache, auch außerhalb von Komponenten. */
export function currentUiLanguage(): string {
  const self = useStore.getState().self;
  return self?.uiLanguage || self?.language || spracheDesSystems();
}

export function t(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(currentUiLanguage(), key, werte);
}

function spracheDesSystems(): string {
  if (typeof navigator === 'undefined') return 'de';
  const roh = navigator.language?.split('-')[0]?.toLowerCase() ?? 'de';
  return WOERTERBUECHER[roh] ? roh : 'de';
}

/** Wie vollständig ist eine Sprache übersetzt? Für die Einstellungen. */
export function coverage(sprache: string): number {
  const wb = WOERTERBUECHER[sprache.toLowerCase().split(/[-_]/)[0]];
  if (!wb) return 0;
  const gesamt = Object.keys(de).length;
  const da = Object.keys(wb).filter((k) => (wb as any)[k]).length;
  return Math.round((da / gesamt) * 100);
}
