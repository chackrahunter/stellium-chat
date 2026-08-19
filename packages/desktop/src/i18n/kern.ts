import { LANGUAGES } from '@stellium/shared';
import { de } from './de.js';
import { en } from './en.js';
import { ar } from './ar.js';
import { cs } from './cs.js';
import { da } from './da.js';
import { es } from './es.js';
import { fi } from './fi.js';
import { fr } from './fr.js';
import { hi } from './hi.js';
import { it } from './it.js';
import { ja } from './ja.js';
import { ko } from './ko.js';
import { nl } from './nl.js';
import { no } from './no.js';
import { pl } from './pl.js';
import { pt } from './pt.js';
import { ro } from './ro.js';
import { ru } from './ru.js';
import { sv } from './sv.js';
import { tr } from './tr.js';
import { uk } from './uk.js';
import { zh } from './zh.js';

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

const WOERTERBUECHER: Record<string, Partial<Dictionary>> = { de, en, ar, cs, da, es, fi, fr, hi, it, ja, ko, nl, no, pl, pt, ro, ru, sv, tr, uk, zh };

/**
 * Sprachen, in denen die Oberfläche vorliegt — dieselben, in die auch
 * Nachrichten übersetzt werden. Reihenfolge und Namen kommen aus derselben
 * Liste, damit beide Einstellungen nicht auseinanderlaufen.
 */
export const UI_LANGUAGES = LANGUAGES.filter((l) => l.code in WOERTERBUECHER);

export function translate(sprache: string, key: TranslationKey, werte?: Record<string, string | number>): string {
  const kurz = sprache.toLowerCase().split(/[-_]/)[0];
  const wb = WOERTERBUECHER[kurz];
  const roh = (wb?.[key] as string | undefined) ?? de[key] ?? key;
  if (!werte) return roh;
  // Platzhalter der Form {name} einsetzen.
  return roh.replace(/\{(\w+)\}/g, (ganz, name) => String(werte[name] ?? ganz));
}

/**
 * Sprache des Rechners. In der App liefert Electron sie exakt; im Browser
 * bleibt die Spracheinstellung des Browsers.
 */
export function spracheDesSystems(): string {
  const roh = (typeof window !== 'undefined' && window.stellium?.locale)
    || (typeof navigator !== 'undefined' ? navigator.language : '')
    || 'en';
  const kurz = roh.split(/[-_]/)[0].toLowerCase();
  return WOERTERBUECHER[kurz] ? kurz : 'en';
}

/** Wie vollständig ist eine Sprache übersetzt? Für die Einstellungen. */
export function coverage(sprache: string): number {
  const wb = WOERTERBUECHER[sprache.toLowerCase().split(/[-_]/)[0]];
  if (!wb) return 0;
  const gesamt = Object.keys(de).length;
  const da = Object.keys(wb).filter((k) => (wb as any)[k]).length;
  return Math.round((da / gesamt) * 100);
}

/**
 * Sprachen, die von rechts nach links gelesen werden.
 *
 * Unter den zweiundzwanzig ist das bisher nur Arabisch. Ohne diese Angabe
 * steht arabischer Text in einem Layout, das für die andere Richtung gebaut
 * ist: Satzzeichen rutschen ans falsche Ende, Namen und Uhrzeiten stehen
 * verkehrt herum, und die Kanalliste liegt auf der unerwarteten Seite.
 */
const VON_RECHTS = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'yi']);

export function istVonRechts(sprache: string): boolean {
  return VON_RECHTS.has(sprache.toLowerCase().split(/[-_]/)[0]);
}

/** Sprache und Leserichtung am Dokument hinterlegen. */
export function dokumentSpracheSetzen(sprache: string): void {
  if (typeof document === 'undefined') return;
  const kurz = (sprache || spracheDesSystems()).toLowerCase().split(/[-_]/)[0];
  document.documentElement.lang = kurz;
  document.documentElement.dir = istVonRechts(kurz) ? 'rtl' : 'ltr';
}

/**
 * Der Name einer Sprache — in der Sprache der Oberfläche.
 *
 * Bisher stand überall der Eigenname: in englischer Oberfläche las man
 * „Translated from Deutsch" statt „from German". Eine Tabelle mit 22 × 22
 * Einträgen wäre der falsche Weg — die Namen kennt das System längst. Nur wenn
 * es sie nicht kennt, bleibt der Eigenname als Rückfall.
 */
const namenSpeicher = new Map<string, string>();

export function sprachName(code: string, inSprache?: string): string {
  const ziel = inSprache || spracheDesSystems();
  const schluessel = `${ziel}|${code}`;
  const gemerkt = namenSpeicher.get(schluessel);
  if (gemerkt) return gemerkt;

  let name = '';
  try {
    name = new Intl.DisplayNames([ziel], { type: 'language' }).of(code) ?? '';
  } catch { /* die Umgebung kennt Intl.DisplayNames nicht */ }

  const info = LANGUAGES.find((l) => l.code === code);
  // Großschreibung: manche Sprachen liefern Kleinbuchstaben, im Fließtext
  // sieht das nach einem Fehler aus.
  if (name) name = name.charAt(0).toLocaleUpperCase(ziel) + name.slice(1);
  const fertig = name || info?.native || code;
  namenSpeicher.set(schluessel, fertig);
  return fertig;
}
