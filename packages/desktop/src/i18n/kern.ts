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

/**
 * Mehrzahlform je Sprache — von Intl.PluralRules gebaut, nicht von Hand.
 * Deutsch und Englisch kommen mit "eins" und "alles andere" aus; Russisch,
 * Polnisch, Ukrainisch und Tschechisch brauchen drei bis vier Formen, Arabisch
 * sechs (zero/one/two/few/many/other) — Regeln von Hand nachzubauen wäre für
 * 22 Sprachen fehleranfällig und viel Code. Gecacht, weil translate() bei
 * jeder Zähl-Zeile im Rendern läuft und ein neues Intl.PluralRules je Aufruf
 * unnötige Arbeit wäre.
 */
const mehrzahlRegeln = new Map<string, Intl.PluralRules>();
function mehrzahlKategorie(sprache: string, n: number): Intl.LDMLPluralRule {
  let regel = mehrzahlRegeln.get(sprache);
  if (!regel) {
    try {
      regel = new Intl.PluralRules(sprache);
    } catch {
      // Unbekanntes Gebietsschema: die Zweiteilung "one"/"other" von Englisch
      // passt für die meisten Sprachen eher als ein Absturz.
      regel = new Intl.PluralRules('en');
    }
    mehrzahlRegeln.set(sprache, regel);
  }
  return regel.select(n);
}

export function translate(sprache: string, key: TranslationKey, werte?: Record<string, string | number>): string {
  const kurz = sprache.toLowerCase().split(/[-_]/)[0];
  const wb = WOERTERBUECHER[kurz];

  /*
   * Mehrzahl, ohne die ~1400 Schlüssel je Wörterbuch anzufassen: Ein
   * Schlüssel bekommt nur dann eine Mehrzahlform, wenn im Wörterbuch
   * tatsächlich "schluessel_one", "schluessel_other" (usw., nach den
   * Kategorien von Intl.PluralRules) danebensteht — jeder andere Schlüssel
   * läuft exakt denselben Pfad wie bisher.
   *
   * Die Zählgröße wird nicht an einem festen Platzhalternamen festgemacht
   * (im Haus heißt sie mal {n}, mal {count}, mal {dauer}), sondern daran, ob
   * GENAU EIN Wert im Aufruf eine Zahl ist. Bei zwei Zahlen (z. B. {ein, aus}
   * bei Marken-Angaben) ist nicht zu erraten, welche zählt — dann bleibt es
   * wie bisher. Eine mit toLocaleString() bereits ausgeschriebene Zahl ist an
   * dieser Stelle schon Text, kein number, und löst absichtlich nichts aus.
   */
  let nachschlag: TranslationKey = key;
  if (werte) {
    const zahlen = Object.values(werte).filter((w): w is number => typeof w === 'number' && Number.isFinite(w));
    if (zahlen.length === 1) {
      const kategorie = mehrzahlKategorie(sprache, zahlen[0]);
      const eigeneForm = `${key}_${kategorie}` as TranslationKey;
      const allgemeineForm = `${key}_other` as TranslationKey;
      if (wb?.[eigeneForm] !== undefined || de[eigeneForm] !== undefined) {
        nachschlag = eigeneForm;
      } else if (kategorie !== 'other' && (wb?.[allgemeineForm] !== undefined || de[allgemeineForm] !== undefined)) {
        // "few"/"many"/"zero"/"two" evtl. (noch) nicht angelegt — "other" ist
        // die Auffangform jeder Mehrzahlregel und näher an richtig als der
        // unveränderte Grundschlüssel.
        nachschlag = allgemeineForm;
      }
    }
  }

  /* Reihenfolge: erst die Mehrzahlform DERSELBEN Sprache, dann deren
     unveränderter Grundschlüssel (die bisherige Übersetzung bleibt exakt
     erhalten, solange niemand für sie eigene Formen angelegt hat — heute der
     Fall für 20 der 22 Wörterbücher), erst danach Deutsch als letzter
     Ausweg. Genau die Reihenfolge, die schon vor der Mehrzahl galt, nur um
     die Mehrzahlform vorgeschaltet. */
  const roh = (wb?.[nachschlag] as string | undefined) ?? (wb?.[key] as string | undefined)
    ?? de[nachschlag] ?? de[key] ?? key;
  if (!werte) return roh;
  /* Platzhalter der Form {name} einsetzen — verzeihend auch {{name}}.
     Ein einziger Schlüssel (msg.notTranslated, in allen 22 Wörterbüchern)
     trug die doppelten Klammern anderer i18n-Bibliotheken statt der hier
     sonst durchgängig einfachen. Die strikte Fassung ersetzte darin nur den
     inneren Kern und ließ je eine Klammer außen stehen; fehlte der Wert
     dazu, blieb ein nacktes "{}" mitten im Satz zurück. */
  return roh.replace(/\{\{?(\w+)\}?\}/g, (ganz, name) => String(werte[name] ?? ganz));
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
  /* Ohne erkannte Sprache (code === "") blieben alle drei Rückfälle leer,
     und wer diese Funktion aufrief, setzte die leere Zeichenkette ungeprüft
     in einen Satz wie "Original in {language}" ein — sichtbar als Lücke
     bzw., zusammen mit obigem Regex-Fehler, als nacktes "{}". */
  const fertig = name || info?.native || code || translate(ziel, 'common.unknown');
  namenSpeicher.set(schluessel, fertig);
  return fertig;
}
