/**
 * Maßangaben zwischen metrisch und angloamerikanisch — deterministisch, ohne
 * Sprachmodell.
 *
 * Schreibt jemand "es ist 25 Grad warm", soll eine Kollegin in den USA
 * "77 °F (25 °C)" lesen, eine in London weiterhin nur "25 °C". Das
 * Sprachmodell rechnet dafür NICHT: Zahlen sind sein bekanntermaßen
 * schwächstes Feld, und ein falsches Ergebnis sähe genauso überzeugend aus
 * wie ein richtiges. Erkennung und Umrechnung hier sind reine Regex- und
 * Arithmetik-Funktionen, jede für sich prüfbar.
 *
 * WICHTIGSTE FALLE — Englisch heißt nicht imperial: Das Vereinigte Königreich
 * nutzt Celsius für Temperatur, Meilen für Straßenentfernungen, aber Gramm
 * für Lebensmittel und (meistens) Stone für das eigene Körpergewicht. Die
 * Region bestimmt die Einheit, nicht die Sprache — siehe regionFuerZeitzone().
 *
 * Zwei Regeln ziehen sich durch die ganze Datei:
 *   1. Im Zweifel nichts tun. Eine unterlassene Umrechnung fällt niemandem
 *      unangenehm auf, eine falsche schon — und sieht dabei genauso aus wie
 *      eine richtige. Jede Erkennung hier ist deshalb eher zu vorsichtig als
 *      zu mutig; siehe die Kommentare bei den einzelnen Kategorien für die
 *      Fälle, die absichtlich NICHT erkannt werden.
 *   2. Das Original bleibt sichtbar. renderMesswert() liefert nie nur die
 *      umgerechnete Zahl, sondern immer "<umgerechnet> (<Original wie
 *      geschrieben>)" — wer nachfragt, bezieht sich auf denselben Wortlaut,
 *      den die andere Person tatsächlich getippt hat.
 */

export type Massregion = 'us' | 'uk' | 'metrisch';

export type EinheitKategorie =
  | 'temperatur' | 'masse' | 'laenge' | 'volumen' | 'geschwindigkeit' | 'flaeche';

/** Eine erkannte Maßangabe im Originaltext. */
export interface Messwert {
  kategorie: EinheitKategorie;
  /** Kanonischer Einheitsschlüssel, z. B. "celsius", "kg" hier "kilogramm". */
  einheit: string;
  /** Zahlenwert wie geschrieben, Vorzeichen inklusive. */
  wert: number;
  /** Nachkommastellen im Original — bestimmt die Rundung der Ausgabe. */
  nachkommastellen: number;
  start: number;
  end: number;
  /** Exakte Fundstelle im Originaltext, unverändert — für die Anzeige "(…)". */
  rohtext: string;
  /** Textfenster um den Fund, für Kontext-Heuristiken (Körpergewicht, bare "Grad"). */
  kontext: string;
}

/* ── Region aus der Zeitzone ──────────────────────────────────────
 *
 * Es gibt keine dedizierte "Land"-Spalte — nur users.timezone (IANA, z. B.
 * "Europe/Berlin", Vorgabe bei Neuanlage). Stand bei der Untersuchung für
 * dieses Modul: ausschließlich von Hand in den Einstellungen gewählt
 * (packages/desktop/src/components/Settings.tsx), nirgends automatisch aus
 * dem Browser übernommen. WÄHREND der Arbeit daran ist im selben Baum
 * sichtbar geworden, dass genau das gerade woanders nachgerüstet wird: eine
 * neue Spalte users.timezone_auto (db/schema.sql) plus ein "einmaliger
 * Nachtrag vom Browser" (state/store.ts, zeitzoneNachtragen — siehe
 * Kommentar in ws/gateway.ts beim prefs:update-Fall), der die Zeitzone genau
 * einmal automatisch setzt und danach nie wieder anfasst. Das hier bleibt
 * davon unabhängig — regionFuerZeitzone() liest nur den fertigen
 * String-Wert, ganz gleich wie er zustande kam — wird die Spalte aber genau
 * dadurch spürbar zuverlässiger, ohne dass dieses Modul etwas davon wissen
 * müsste. Sie ist schon jetzt, unabhängig davon, BEREITS die Grundlage einer
 * bestehenden, echten Funktion (localTimeFor() / zeitAusSicht() in
 * packages/desktop/src/lib/format.ts: "Ortszeit eines Kollegen", ruhige
 * Stunden), auf die sich das Haus schon verlässt. Eine zweite, eigens für
 * Maßeinheiten gepflegte Region wäre sauberer, bräuchte aber eine neue
 * Spalte — und db/schema.sql sowie db/migrate.ts sind für diese Aufgabe
 * gesperrt. users.language kommt bewusst NICHT infrage: das ist exakt der
 * Fehler, vor dem die Aufgabenstellung warnt ("Englisch heißt nicht
 * imperial") — ein englischsprachiges Konto kann in London oder in Denver
 * sitzen.
 *
 * Ohne gesetzte Zeitzone bleibt es beim Vorgabewert "Europe/Berlin" -> hier
 * unten 'metrisch'. Das ist der sichere Fehlschlag: lieber ein unkonvertier-
 * tes Celsius für ein unkonfiguriertes US-Konto als ein falsches Fahrenheit
 * für ein deutsches.
 */

// Quelle: IANA tz database (zone1970.tab / backward), Länderkennung "US".
// Historische Aliase (US/Eastern usw.) sind dabei, weil ältere Systeme sie
// teils noch ausliefern.
const US_ZEITZONEN = new Set<string>([
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'America/Anchorage', 'America/Adak', 'America/Boise',
  'America/Detroit', 'America/Indiana/Indianapolis', 'America/Indiana/Knox',
  'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Tell_City',
  'America/Indiana/Vevay', 'America/Indiana/Vincennes', 'America/Indiana/Winamac',
  'America/Kentucky/Louisville', 'America/Kentucky/Monticello', 'America/Menominee',
  'America/North_Dakota/Beulah', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem',
  'America/Juneau', 'America/Metlakatla', 'America/Nome', 'America/Sitka', 'America/Yakutat',
  'Pacific/Honolulu',
  'US/Alaska', 'US/Aleutian', 'US/Arizona', 'US/Central', 'US/East-Indiana', 'US/Eastern',
  'US/Hawaii', 'US/Indiana-Starke', 'US/Michigan', 'US/Mountain', 'US/Pacific', 'US/Samoa',
]);

// Großbritannien hat praktisch nur eine Zeitzone. GB/GB-Eire sind veraltete,
// aber weiterhin gültige Aliase, die manche Systeme noch liefern.
const UK_ZEITZONEN = new Set<string>(['Europe/London', 'GB', 'GB-Eire']);

export function regionFuerZeitzone(tz: string | null | undefined): Massregion {
  if (!tz) return 'metrisch';
  if (US_ZEITZONEN.has(tz)) return 'us';
  if (UK_ZEITZONEN.has(tz)) return 'uk';
  return 'metrisch';
}

/**
 * Dezimaltrennzeichen der LESENDEN Person, nicht der Zielsprache der
 * Übersetzung — beide sind fast immer dasselbe Konto, aber begrifflich
 * getrennt. Vereinfachung: sprachbasiert (die üblichen Komma-Sprachen
 * Kontinentaleuropas gegen den Rest), keine Landesfeinheiten.
 */
const KOMMA_SPRACHEN = new Set([
  'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'cs', 'ro', 'tr', 'ru', 'uk', 'sv', 'da', 'fi', 'no',
]);

export function dezimaltrennzeichenFuerSprache(sprache: string | null | undefined): ',' | '.' {
  const kurz = (sprache ?? '').toLowerCase().split(/[-_]/)[0];
  return KOMMA_SPRACHEN.has(kurz) ? ',' : '.';
}

/* ── Sentinel-Platzhalter ─────────────────────────────────────────
 *
 * Eigenes, von {{n}} (packages/shared/src/markup.ts) klar unterscheidbares
 * Zeichenpaar. Während der Übersetzung selbst läuft eine Maßangabe unter
 * EINEM {{n}}-Platzhalter mit (genau dieselbe Maschinerie wie Code/Links/
 * Mentions — siehe translation/index.ts) und ist damit vor dem Modell
 * vollständig geschützt. Das hier ist die ZWEITE, spätere Stufe: der fertig
 * übersetzte Text trägt an der Stelle der Maßangabe diesen Sentinel, bis
 * messwerteInTextEinsetzen() ihn für eine bestimmte Empfängerin auflöst.
 * U+27E6/U+27E7 (mathematische, doppelte Klammern) kommen in normalem
 * Chat-Text praktisch nie vor und sind im Zweifel leicht wiederzuerkennen.
 */
const PLATZHALTER_AUF = '⟦';
const PLATZHALTER_ZU = '⟧';
export const MESSWERT_PLATZHALTER_RE = /⟦m(\d+)⟧/g;

export function messwertPlatzhalter(index: number): string {
  return `${PLATZHALTER_AUF}m${index}${PLATZHALTER_ZU}`;
}

/* ── Zahlen lesen ─────────────────────────────────────────────────
 *
 * Bewusst OHNE Tausendertrennzeichen: "1.234" ist in DE 1234, in EN 1,234 —
 * unauflösbar mehrdeutig ohne Sprachkontext, und eine falsche Umrechnung ist
 * schlimmer als keine. Die Lookbehinds unten sorgen dafür, dass ein
 * mehrgruppig geschriebener Wert wie "1.234,5 km" GAR NICHT erst matcht
 * (weder als 1234,5 falsch geraten noch als 234,5 falsch abgeschnitten) —
 * sie verhindern, dass der Treffer mitten in einer längeren Ziffernfolge
 * beginnt. Ebenso verhindert (?<!\d-) einen Treffer auf die zweite Zahl
 * einer Spanne ("10-20 kg" soll unangetastet bleiben, nicht heimlich zu
 * "20 kg" werden).
 */
const NUM_RE_SRC = String.raw`(?<![\d.,])(?<!\d-)(-?\d+(?:[.,]\d+)?)(?!\d)`;

function parseZahl(roh: string): { wert: number; nachkommastellen: number } {
  const m = roh.match(/^(-?\d+)(?:([.,])(\d+))?$/);
  if (!m) return { wert: NaN, nachkommastellen: 0 };
  if (!m[3]) return { wert: parseInt(m[1], 10), nachkommastellen: 0 };
  return { wert: parseFloat(`${m[1]}.${m[3]}`), nachkommastellen: m[3].length };
}

function kontextFenster(text: string, start: number, end: number, radius = 40): string {
  return text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius));
}

/** Steht eines der Hinweiswörter (ganzes Wort, unicodefähig) im Fenster? */
function hatHinweis(fenster: string, hinweise: string[]): boolean {
  return hinweise.some((wort) => new RegExp(`(?<![\\p{L}])${wort}(?![\\p{L}])`, 'iu').test(fenster));
}

function neuerFund(
  kategorie: EinheitKategorie, einheit: string, wert: number, nachkommastellen: number,
  m: RegExpMatchArray, text: string,
): Messwert {
  const start = m.index!;
  const end = start + m[0].length;
  return {
    kategorie, einheit, wert, nachkommastellen, start, end,
    rohtext: text.slice(start, end), kontext: kontextFenster(text, start, end),
  };
}

/* ── Kategorie: Temperatur ────────────────────────────────────────
 *
 * "ein 25-Grad-Winkel" wird NICHT erkannt: Bindestriche gehören hier nie zum
 * Zahl-Einheit-Muster (siehe unten, MUSTER-Konstruktion), ein per Bindestrich
 * angeschlossenes Wort bricht das \s* deshalb immer ab — der Satz matcht gar
 * nicht erst, unabhängig vom Wortinhalt.
 *
 * Bloßes "Grad"/"degrees" OHNE Celsius/Fahrenheit-Angabe ist an sich
 * mehrdeutig (Winkel? Temperatur? akademischer Grad?). Deutsches "Grad"
 * gilt hier NUR mit einem Warm-/Kalt-Hinweis in der Nähe als Temperatur
 * (Celsius angenommen — für Deutsch praktisch immer richtig, da Deutschland
 * kein zweites System kennt). Englisches bloßes "degrees" wird ABSICHTLICH
 * NIE automatisch erkannt: US-Englisch meint damit Fahrenheit, britisches
 * und der Rest der Welt Celsius — ohne Herkunft der schreibenden Person ist
 * das nicht auflösbar, und eine falsche Annahme (z. B. "90 degrees" als 90 °C
 * gelesen) wäre eine der gefährlicheren Fehlumrechnungen überhaupt. Nur
 * "°F"/"°C"/"degrees Fahrenheit"/"degrees Celsius" (explizit) lösen bei
 * Englisch aus.
 */
const TEMPERATUR_KONTEXT_DE = [
  'warm', 'kalt', 'heiß', 'heiss', 'kühl', 'kuehl', 'eisig', 'mild', 'lau', 'schwül', 'schwuel',
  'temperatur', 'fieber', 'draußen', 'draussen', 'wetter', 'backen', 'backofen', 'ofen',
  'vorheizen', 'aufheizen', 'hitze', 'kälte', 'kaelte',
  'friert', 'friere', 'frieren', 'frierst', 'schwitzt', 'schwitze', 'schwitzen', 'schwitzst',
];

function findeTemperatur(text: string): Messwert[] {
  const funde: Messwert[] = [];

  /* Groß- UND kleingeschrieben ('giu', nicht nur 'gu'): „25°c" ist im Chat
     mindestens so verbreitet wie „25°C", und das Wortmuster darüber
     ("grad celsius") ist ohnehin schon unabhängig von Groß-/Kleinschreibung.
     Hier fehlte das i — kleingeschriebene Grad wurden still nicht erkannt,
     während dieselbe Angabe ausgeschrieben funktioniert hätte.
     Nachgemessen vor der Korrektur: "es sind 25°c heute" lieferte KEINEN
     Fund, "temp: -5 °C nachts" dagegen den erwarteten. */
  for (const m of text.matchAll(new RegExp(`${NUM_RE_SRC}\\s*°\\s*([CF])\\b`, 'giu'))) {
    const { wert, nachkommastellen } = parseZahl(m[1]);
    if (!Number.isFinite(wert)) continue;
    funde.push(neuerFund('temperatur', m[2].toUpperCase() === 'C' ? 'celsius' : 'fahrenheit', wert, nachkommastellen, m, text));
  }

  for (const m of text.matchAll(new RegExp(`${NUM_RE_SRC}\\s*(?:grad|degrees?)\\s+(celsius|fahrenheit)\\b`, 'giu'))) {
    const { wert, nachkommastellen } = parseZahl(m[1]);
    if (!Number.isFinite(wert)) continue;
    funde.push(neuerFund('temperatur', m[2].toLowerCase() === 'celsius' ? 'celsius' : 'fahrenheit', wert, nachkommastellen, m, text));
  }

  for (const m of text.matchAll(new RegExp(`${NUM_RE_SRC}\\s*grad\\b(?!\\s*(?:celsius|fahrenheit))`, 'giu'))) {
    const fenster = kontextFenster(text, m.index!, m.index! + m[0].length);
    if (!hatHinweis(fenster, TEMPERATUR_KONTEXT_DE)) continue;
    const { wert, nachkommastellen } = parseZahl(m[1]);
    if (!Number.isFinite(wert)) continue;
    funde.push(neuerFund('temperatur', 'celsius', wert, nachkommastellen, m, text));
  }

  return funde;
}

/* ── Kategorie: Masse ─────────────────────────────────────────────
 *
 * "Pfund"/"pound(s)" werden ABSICHTLICH NIE erkannt — im Vereinigten
 * Königreich (und auf Deutsch im Kontext britischer Preise) ist das eher
 * Geld als Gewicht, und Währungen rechnet dieses Modul nicht um (Kurse
 * schwanken, siehe Auftrag). Nur die eindeutige Abkürzung "lb"/"lbs" wird
 * als Gewicht erkannt. "st" als Abkürzung für Stone wird ebenfalls NICHT
 * erkannt (Kollision mit Ordnungszahlen wie "21st", mit "St." als "Straße"
 * oder als Namenskürzel "St. Peter's") — nur das ausgeschriebene
 * "stone(s)" zählt.
 */
const KOERPERGEWICHT_KONTEXT = [
  'wiegt', 'wiege', 'wiegst', 'wiegen', 'gewogen', 'körpergewicht', 'koerpergewicht',
  'abgenommen', 'zugenommen', 'abnehmen', 'zunehmen', 'diät', 'diaet',
  'weighs', 'weigh', 'weighed', 'weighing', 'bodyweight', 'overweight',
];

function findeMasse(text: string): Messwert[] {
  const funde: Messwert[] = [];
  const MUSTER: [RegExp, string][] = [
    [new RegExp(`${NUM_RE_SRC}\\s*(?:mg|milligramm|milligrams?)\\b`, 'giu'), 'milligramm'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:kg|kilogramm|kilograms?|kilos?)\\b`, 'giu'), 'kilogramm'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:g|gramm|grams?)\\b`, 'giu'), 'gramm'],
    [new RegExp(`${NUM_RE_SRC}\\s*lbs?\\b`, 'giu'), 'lb'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:oz|ounces?)\\b`, 'giu'), 'unze'],
    [new RegExp(`${NUM_RE_SRC}\\s*stones?\\b`, 'giu'), 'stone'],
  ];
  for (const [re, einheit] of MUSTER) {
    for (const m of text.matchAll(re)) {
      const { wert, nachkommastellen } = parseZahl(m[1]);
      if (!Number.isFinite(wert)) continue;
      funde.push(neuerFund('masse', einheit, wert, nachkommastellen, m, text));
    }
  }
  return funde;
}

/* ── Kategorie: Länge ─────────────────────────────────────────────
 *
 * "der 100-Meter-Lauf" wird NICHT erkannt — Bindestrich-Komposita brechen
 * das Muster ab, wie bei "Grad" oben; "100 Meter Kabel" (Leerzeichen) wird
 * erkannt. Bloßes "m" nur mit Dezimalstelle ("3,5m") ODER einem
 * Längen-Hinweis in der Nähe — sonst zu leicht mit "in 3m Uhrzeit" (Minuten)
 * oder Modellbezeichnungen zu verwechseln. Bloßes "in" (Zoll) wird NIE
 * erkannt — als Präposition viel zu häufig; nur "inch(es)" oder ein
 * unmittelbar angehängtes "-Zeichen zählen.
 */
const LAENGE_KONTEXT = [
  'lang', 'länge', 'laenge', 'breit', 'breite', 'hoch', 'höhe', 'hoehe', 'tief', 'tiefe',
  'entfernt', 'entfernung', 'kabel', 'strecke', 'weg', 'abstand', 'groß', 'gross',
  'away', 'long', 'length', 'wide', 'width', 'tall', 'height', 'deep', 'depth', 'distance', 'cable', 'far',
];

function findeLaenge(text: string): Messwert[] {
  const funde: Messwert[] = [];
  const MUSTER: [RegExp, string][] = [
    [new RegExp(`${NUM_RE_SRC}\\s*(?:mm|millimeter|millimeters?|millimetres?)\\b`, 'giu'), 'millimeter'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:cm|zentimeter|centimeters?|centimetres?)\\b`, 'giu'), 'zentimeter'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:km|kilometer|kilometers?|kilometres?)\\b`, 'giu'), 'kilometer'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:meters?|metres?)\\b`, 'giu'), 'meter'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:miles?|meilen?)\\b`, 'giu'), 'meile'],
    [new RegExp(`${NUM_RE_SRC}\\s*yards?\\b`, 'giu'), 'yard'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:feet|foot|ft)\\b`, 'giu'), 'fuss'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:inches|inch)\\b`, 'giu'), 'zoll'],
    [new RegExp(`${NUM_RE_SRC}"`, 'gu'), 'zoll'],
  ];
  for (const [re, einheit] of MUSTER) {
    for (const m of text.matchAll(re)) {
      const { wert, nachkommastellen } = parseZahl(m[1]);
      if (!Number.isFinite(wert)) continue;
      funde.push(neuerFund('laenge', einheit, wert, nachkommastellen, m, text));
    }
  }
  // Bloßes "m": nur Kleinbuchstabe (Großes "M" ist im Chat viel häufiger
  // "Million" als "Meter"), und nur mit Dezimalstelle oder Kontext-Hinweis.
  for (const m of text.matchAll(new RegExp(`${NUM_RE_SRC}\\s*m\\b`, 'gu'))) {
    const { wert, nachkommastellen } = parseZahl(m[1]);
    if (!Number.isFinite(wert)) continue;
    const fenster = kontextFenster(text, m.index!, m.index! + m[0].length);
    if (nachkommastellen === 0 && !hatHinweis(fenster, LAENGE_KONTEXT)) continue;
    funde.push(neuerFund('laenge', 'meter', wert, nachkommastellen, m, text));
  }
  return funde;
}

/* ── Kategorie: Volumen ───────────────────────────────────────────
 *
 * Bloßes kleines "l" wird NIE erkannt (Verwechslung mit der Ziffer 1 und dem
 * Großbuchstaben I — zu unsicher). Ein angehängtes GROSSES "L" ohne
 * Leerzeichen ("5L Wasser") ist dagegen eine verbreitete, kaum mehrdeutige
 * Schreibweise und wird erkannt. "Gallone"/"Pint" ohne weiteren Hinweis wird
 * als US-Einheit angenommen (die weitaus häufigere Alltagsnennung); nur ein
 * Hinweis wie "imperial"/"britisch"/"UK" in der Nähe schaltet auf die
 * britische (andere!) Gallone/Pint um. Britisches Fluid Ounce wird
 * vereinfachend wie US fl oz behandelt (Unterschied < 5 %, hier nicht
 * gesondert geführt — siehe Bericht).
 */
const IMPERIAL_HINWEIS = ['imperial', 'britisch', 'brittisch', 'uk'];

function findeVolumen(text: string): Messwert[] {
  const funde: Messwert[] = [];
  const MUSTER: [RegExp, string][] = [
    [new RegExp(`${NUM_RE_SRC}\\s*(?:ml|milliliter|millilit(?:er|re)s?)\\b`, 'giu'), 'milliliter'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:cl|zentiliter|centilit(?:er|re)s?)\\b`, 'giu'), 'zentiliter'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:liters?|litres?)\\b`, 'giu'), 'liter'],
    [new RegExp(`${NUM_RE_SRC}\\s*L\\b`, 'gu'), 'liter'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:fl\\.?\\s*oz|fluid\\s*ounces?)\\b`, 'giu'), 'fl_oz_us'],
  ];
  for (const [re, einheit] of MUSTER) {
    for (const m of text.matchAll(re)) {
      const { wert, nachkommastellen } = parseZahl(m[1]);
      if (!Number.isFinite(wert)) continue;
      funde.push(neuerFund('volumen', einheit, wert, nachkommastellen, m, text));
    }
  }
  // "2 imperial gallons"/"3 britische Pints": das Hinweiswort steht im
  // Englischen typischerweise ZWISCHEN Zahl und Einheit, nicht danach — muss
  // deshalb Teil des Musters sein, sonst bricht \s* davor ab und der ganze
  // Treffer geht verloren (gemessen: genau das passierte in einer früheren
  // Fassung dieser Datei, siehe scripts/masseinheiten-pruefen.mjs).
  const IMPERIAL_PRAEFIX = String.raw`(?:imperial\s+|british\s+|britisch(?:e|en)?\s+|uk\s+)?`;
  for (const m of text.matchAll(new RegExp(`${NUM_RE_SRC}\\s*${IMPERIAL_PRAEFIX}(?:gal|gallons?|gallonen?)\\b`, 'giu'))) {
    const { wert, nachkommastellen } = parseZahl(m[1]);
    if (!Number.isFinite(wert)) continue;
    const fenster = kontextFenster(text, m.index!, m.index! + m[0].length);
    funde.push(neuerFund('volumen', hatHinweis(fenster, IMPERIAL_HINWEIS) ? 'gallone_uk' : 'gallone_us', wert, nachkommastellen, m, text));
  }
  for (const m of text.matchAll(new RegExp(`${NUM_RE_SRC}\\s*${IMPERIAL_PRAEFIX}(?:pt|pints?|pinten?)\\b`, 'giu'))) {
    const { wert, nachkommastellen } = parseZahl(m[1]);
    if (!Number.isFinite(wert)) continue;
    const fenster = kontextFenster(text, m.index!, m.index! + m[0].length);
    funde.push(neuerFund('volumen', hatHinweis(fenster, IMPERIAL_HINWEIS) ? 'pint_uk' : 'pint_us', wert, nachkommastellen, m, text));
  }
  return funde;
}

/* ── Kategorie: Geschwindigkeit ───────────────────────────────────── */

function findeGeschwindigkeit(text: string): Messwert[] {
  const funde: Messwert[] = [];
  for (const m of text.matchAll(new RegExp(`${NUM_RE_SRC}\\s*(?:km\\s*/\\s*h|kmh|stundenkilometer)\\b`, 'giu'))) {
    const { wert, nachkommastellen } = parseZahl(m[1]);
    if (!Number.isFinite(wert)) continue;
    funde.push(neuerFund('geschwindigkeit', 'kmh', wert, nachkommastellen, m, text));
  }
  for (const m of text.matchAll(new RegExp(`${NUM_RE_SRC}\\s*(?:mph|miles?\\s*(?:per|\\/)\\s*hour|meilen\\s*(?:pro|\\/)\\s*stunde)\\b`, 'giu'))) {
    const { wert, nachkommastellen } = parseZahl(m[1]);
    if (!Number.isFinite(wert)) continue;
    funde.push(neuerFund('geschwindigkeit', 'mph', wert, nachkommastellen, m, text));
  }
  return funde;
}

/* ── Kategorie: Fläche ────────────────────────────────────────────── */

function findeFlaeche(text: string): Messwert[] {
  const funde: Messwert[] = [];
  const MUSTER: [RegExp, string][] = [
    [new RegExp(`${NUM_RE_SRC}\\s*(?:km²|km\\^2)`, 'gu'), 'quadratkilometer'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:quadratkilometer|square\\s*kilomet(?:er|re)s?)\\b`, 'giu'), 'quadratkilometer'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:m²|m\\^2)`, 'gu'), 'quadratmeter'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:qm|quadratmeter|square\\s*met(?:er|re)s?|sqm)\\b`, 'giu'), 'quadratmeter'],
    [new RegExp(`${NUM_RE_SRC}\\s*(?:sq\\.?\\s*ft|square\\s*feet|square\\s*foot)\\b`, 'giu'), 'sqft'],
    [new RegExp(`${NUM_RE_SRC}\\s*acres?\\b`, 'giu'), 'acre'],
  ];
  for (const [re, einheit] of MUSTER) {
    for (const m of text.matchAll(re)) {
      const { wert, nachkommastellen } = parseZahl(m[1]);
      if (!Number.isFinite(wert)) continue;
      funde.push(neuerFund('flaeche', einheit, wert, nachkommastellen, m, text));
    }
  }
  return funde;
}

/* ── Zusammenführen ───────────────────────────────────────────────
 *
 * Mehrere Kategorien können an derselben Stelle konkurrieren (z. B. "25 km"
 * als Länge UND als Anfang von "25 km/h" als Geschwindigkeit). Gleicher
 * Start, längerer Treffer gewinnt — "25 km/h" schlägt "25 km". Bei
 * unterschiedlichem Start gewinnt der frühere; das ist eine bewusste
 * Vereinfachung (Intervall-Scheduling), echte Konflikte mit verschiedenem
 * Start sind bei den hier verwendeten Mustern nicht zu erwarten.
 */
function ueberlappungenAufloesen(kandidaten: Messwert[]): Messwert[] {
  const sortiert = [...kandidaten].sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const ausgewaehlt: Messwert[] = [];
  let letztesEnde = -1;
  for (const k of sortiert) {
    if (k.start >= letztesEnde) { ausgewaehlt.push(k); letztesEnde = k.end; }
  }
  return ausgewaehlt;
}

/**
 * Alle Maßangaben in `text`, sortiert nach Position.
 *
 * Läuft auf dem Text, der dem Sprachmodell tatsächlich vorgelegt wird (siehe
 * translation/index.ts) — Codeblöcke, Links, Mentions und Glossarbegriffe
 * stehen dort bereits als {{n}}-Platzhalter und können deshalb nie
 * versehentlich eine "Maßangabe" enthalten, die in Wirklichkeit Teil eines
 * Codeschnipsels war.
 */
export function findMeasurements(text: string): Messwert[] {
  return ueberlappungenAufloesen([
    ...findeTemperatur(text),
    ...findeGeschwindigkeit(text),
    ...findeLaenge(text),
    ...findeMasse(text),
    ...findeVolumen(text),
    ...findeFlaeche(text),
  ]);
}

/* ── Umrechnung + Formatierung ────────────────────────────────────
 *
 * Rundungsregel: die Ausgabe bekommt GENAU so viele Nachkommastellen wie die
 * Eingabe. "25 Grad" (0 Nachkommastellen) -> "77 °F", nicht "77,0 °F" — ein
 * Mensch, der eine ganze Zahl schreibt, beansprucht keine Nachkommagenauig-
 * keit, und die sollte die Umrechnung auch nicht erfinden. "23,5 Grad" (1
 * Nachkommastelle) -> "74,3 °F", nicht auf eine ganze Zahl gerundet — sonst
 * ginge eine Nachkommastelle verloren, die die schreibende Person bewusst
 * hingeschrieben hat ("100,0 kg" darf nicht so tun, als wäre es "100 kg"
 * gewesen).
 */
function formatiereZahl(wert: number, nachkommastellen: number, trenner: ',' | '.'): string {
  let gerundet = Number(wert.toFixed(Math.min(nachkommastellen, 10)));
  if (Object.is(gerundet, -0)) gerundet = 0;
  const text = gerundet.toFixed(nachkommastellen);
  return trenner === ',' ? text.replace('.', ',') : text;
}

function formatKonvertiert(zielWert: number, m: Messwert, trenner: ',' | '.', suffix: string): string {
  return `${formatiereZahl(zielWert, m.nachkommastellen, trenner)} ${suffix} (${m.rohtext})`;
}

function renderTemperatur(m: Messwert, region: Massregion, trenner: ',' | '.'): string | null {
  const nativeIn: Massregion[] = m.einheit === 'celsius' ? ['metrisch', 'uk'] : ['us'];
  if (nativeIn.includes(region)) return null;
  const basisCelsius = m.einheit === 'celsius' ? m.wert : (m.wert - 32) * (5 / 9);
  if (region === 'us') return formatKonvertiert(basisCelsius * (9 / 5) + 32, m, trenner, '°F');
  return formatKonvertiert(basisCelsius, m, trenner, '°C');
}

const MASSE_ZU_GRAMM: Record<string, (w: number) => number> = {
  milligramm: (w) => w / 1000, gramm: (w) => w, kilogramm: (w) => w * 1000,
  lb: (w) => w * 453.592, unze: (w) => w * 28.3495, stone: (w) => w * 6350.29,
};
const MASSE_NATIVE: Record<string, Massregion[]> = {
  milligramm: ['metrisch', 'uk'], gramm: ['metrisch', 'uk'], kilogramm: ['metrisch', 'uk'],
  lb: ['us'], unze: ['us'], stone: ['uk'],
};

function renderMasse(m: Messwert, region: Massregion, trenner: ',' | '.'): string | null {
  const basisGramm = MASSE_ZU_GRAMM[m.einheit](m.wert);

  // Körpergewicht + UK: Ausnahme von "Gramm bleibt in UK unverändert" — hier
  // gilt Stone, unabhängig von der Quelleinheit. Siehe Bericht: bewusst nur
  // per Stichwort erkannt, keine echte Subjekt-Analyse.
  if (region === 'uk' && m.einheit !== 'stone' && hatHinweis(m.kontext, KOERPERGEWICHT_KONTEXT)) {
    return formatKonvertiert(basisGramm / 6350.29, m, trenner, 'st');
  }

  const nativeIn = MASSE_NATIVE[m.einheit] ?? [];
  if (nativeIn.includes(region)) return null;

  if (region === 'us') {
    return basisGramm < 453.592
      ? formatKonvertiert(basisGramm / 28.3495, m, trenner, 'oz')
      : formatKonvertiert(basisGramm / 453.592, m, trenner, 'lb');
  }
  // uk (ohne Körpergewichts-Hinweis) und metrisch verhalten sich hier gleich.
  return basisGramm < 1000
    ? formatKonvertiert(basisGramm, m, trenner, 'g')
    : formatKonvertiert(basisGramm / 1000, m, trenner, 'kg');
}

const LAENGE_ZU_METER: Record<string, (w: number) => number> = {
  millimeter: (w) => w / 1000, zentimeter: (w) => w / 100, meter: (w) => w, kilometer: (w) => w * 1000,
  zoll: (w) => w * 0.0254, fuss: (w) => w * 0.3048, yard: (w) => w * 0.9144, meile: (w) => w * 1609.344,
};
const LAENGE_NATIVE: Record<string, Massregion[]> = {
  millimeter: ['metrisch'], zentimeter: ['metrisch'], meter: ['metrisch'], kilometer: ['metrisch'],
  zoll: ['us', 'uk'], fuss: ['us', 'uk'], yard: ['us', 'uk'], meile: ['us', 'uk'],
};

function renderLaenge(m: Messwert, region: Massregion, trenner: ',' | '.'): string | null {
  const nativeIn = LAENGE_NATIVE[m.einheit] ?? [];
  if (nativeIn.includes(region)) return null;
  const basisMeter = LAENGE_ZU_METER[m.einheit](m.wert);
  if (region === 'metrisch') {
    if (basisMeter < 1) return formatKonvertiert(basisMeter * 100, m, trenner, 'cm');
    if (basisMeter >= 1000) return formatKonvertiert(basisMeter / 1000, m, trenner, 'km');
    return formatKonvertiert(basisMeter, m, trenner, 'm');
  }
  if (basisMeter < 1) return formatKonvertiert(basisMeter / 0.0254, m, trenner, 'in');
  if (basisMeter >= 1000) return formatKonvertiert(basisMeter / 1609.344, m, trenner, 'mi');
  return formatKonvertiert(basisMeter / 0.3048, m, trenner, 'ft');
}

const VOLUMEN_ZU_ML: Record<string, (w: number) => number> = {
  milliliter: (w) => w, zentiliter: (w) => w * 10, liter: (w) => w * 1000,
  fl_oz_us: (w) => w * 29.5735, pint_us: (w) => w * 473.176, gallone_us: (w) => w * 3785.41,
  pint_uk: (w) => w * 568.261, gallone_uk: (w) => w * 4546.09,
};
const VOLUMEN_NATIVE: Record<string, Massregion[]> = {
  milliliter: ['metrisch'], zentiliter: ['metrisch'], liter: ['metrisch'],
  fl_oz_us: ['us'], pint_us: ['us'], gallone_us: ['us'], pint_uk: ['uk'], gallone_uk: ['uk'],
};

function renderVolumen(m: Messwert, region: Massregion, trenner: ',' | '.'): string | null {
  const nativeIn = VOLUMEN_NATIVE[m.einheit] ?? [];
  if (nativeIn.includes(region)) return null;
  const basisMl = VOLUMEN_ZU_ML[m.einheit](m.wert);
  if (region === 'metrisch') {
    return basisMl >= 1000 ? formatKonvertiert(basisMl / 1000, m, trenner, 'l') : formatKonvertiert(basisMl, m, trenner, 'ml');
  }
  if (region === 'us') {
    if (basisMl < 500) return formatKonvertiert(basisMl / 29.5735, m, trenner, 'fl oz');
    if (basisMl < 3785.41) return formatKonvertiert(basisMl / 473.176, m, trenner, 'pt');
    return formatKonvertiert(basisMl / 3785.41, m, trenner, 'gal');
  }
  if (basisMl < 500) return formatKonvertiert(basisMl / 29.5735, m, trenner, 'fl oz');
  if (basisMl < 4546.09) return formatKonvertiert(basisMl / 568.261, m, trenner, 'pt');
  return formatKonvertiert(basisMl / 4546.09, m, trenner, 'gal');
}

function renderGeschwindigkeit(m: Messwert, region: Massregion, trenner: ',' | '.'): string | null {
  const nativeIn: Massregion[] = m.einheit === 'kmh' ? ['metrisch'] : ['us', 'uk'];
  if (nativeIn.includes(region)) return null;
  const basisKmh = m.einheit === 'kmh' ? m.wert : m.wert * 1.609344;
  return region === 'metrisch'
    ? formatKonvertiert(basisKmh, m, trenner, 'km/h')
    : formatKonvertiert(basisKmh / 1.609344, m, trenner, 'mph');
}

const FLAECHE_ZU_QM: Record<string, (w: number) => number> = {
  quadratmeter: (w) => w, hektar: (w) => w * 10000, quadratkilometer: (w) => w * 1_000_000,
  sqft: (w) => w * 0.092903, acre: (w) => w * 4046.86,
};
const FLAECHE_NATIVE: Record<string, Massregion[]> = {
  quadratmeter: ['metrisch'], hektar: ['metrisch'], quadratkilometer: ['metrisch'],
  sqft: ['us', 'uk'], acre: ['us', 'uk'],
};

function renderFlaeche(m: Messwert, region: Massregion, trenner: ',' | '.'): string | null {
  const nativeIn = FLAECHE_NATIVE[m.einheit] ?? [];
  if (nativeIn.includes(region)) return null;
  const basisQm = FLAECHE_ZU_QM[m.einheit](m.wert);
  if (region === 'metrisch') {
    if (basisQm >= 1_000_000) return formatKonvertiert(basisQm / 1_000_000, m, trenner, 'km²');
    if (basisQm >= 10000) return formatKonvertiert(basisQm / 10000, m, trenner, 'ha');
    return formatKonvertiert(basisQm, m, trenner, 'm²');
  }
  return basisQm >= 4046.86
    ? formatKonvertiert(basisQm / 4046.86, m, trenner, 'ac')
    : formatKonvertiert(basisQm / 0.092903, m, trenner, 'sq ft');
}

/**
 * Umgerechneter Anzeigetext für EINE Maßangabe in EINER Zielregion, oder
 * `null`, wenn die Angabe für diese Region schon im richtigen System steht
 * (dann bleibt der Originaltext unverändert stehen — keine überflüssige
 * "77 °F (77 °F)"-Wiederholung).
 */
export function renderMesswert(m: Messwert, region: Massregion, dezimaltrennzeichen: ',' | '.' = '.'): string | null {
  switch (m.kategorie) {
    case 'temperatur': return renderTemperatur(m, region, dezimaltrennzeichen);
    case 'masse': return renderMasse(m, region, dezimaltrennzeichen);
    case 'laenge': return renderLaenge(m, region, dezimaltrennzeichen);
    case 'volumen': return renderVolumen(m, region, dezimaltrennzeichen);
    case 'geschwindigkeit': return renderGeschwindigkeit(m, region, dezimaltrennzeichen);
    case 'flaeche': return renderFlaeche(m, region, dezimaltrennzeichen);
    default: return null;
  }
}

/**
 * Sentinels (⟦m0⟧, ⟦m1⟧, …) in einem bereits übersetzten Text durch die für
 * `region` passende Umrechnung ersetzen — oder, wenn keine Umrechnung nötig
 * ist bzw. der Index unbekannt ist, durch den unveränderten Originalwortlaut.
 * Reine Funktion, kein Netz- oder Datenbankzugriff: darf für jede Empfängerin
 * einzeln laufen, ohne den geteilten Übersetzungsspeicher zu berühren.
 */
export function messwerteInTextEinsetzen(
  text: string,
  messwerte: Record<number, Messwert> | undefined,
  region: Massregion,
  dezimaltrennzeichen: ',' | '.' = '.',
): string {
  if (!messwerte) return text;
  return text.replace(MESSWERT_PLATZHALTER_RE, (ganzerTreffer, indexRoh: string) => {
    const m = messwerte[Number(indexRoh)];
    if (!m) return ganzerTreffer;
    return renderMesswert(m, region, dezimaltrennzeichen) ?? m.rohtext;
  });
}
