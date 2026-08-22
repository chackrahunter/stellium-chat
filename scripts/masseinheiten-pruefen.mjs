#!/usr/bin/env node
/**
 * Prüft die Maßeinheiten-Umrechnung (packages/shared/src/einheiten.ts) —
 * ohne Server, ohne Datenbank, ohne Sprachmodell: reine, deterministische
 * Funktionen, direkt aus der TypeScript-Quelle importiert (Node führt das
 * Typ-Stripping selbst aus, wie schon in scripts/echo-pruefen.mjs).
 *
 * Teil 1 — feste Zusicherungen: die Fälle, die laut Auftrag mindestens
 *   stimmen müssen (25 °C -> 77 °F für die USA, unverändert für UK, beide
 *   Richtungen bei Gewicht/Entfernung/Volumen, die Fälle, die NICHT
 *   umgerechnet werden dürfen, zwei Engländer mit verschiedener Zeitzone).
 *
 * Teil 2 — echte Sätze: mindestens zehn Beispielsätze laufen durch die
 *   gesamte Kette (Erkennung -> Sentinel -> regionsgenaues Einsetzen), mit
 *   der tatsächlichen Ausgabe — inklusive der Fälle, in denen die Erkennung
 *   bewusst nichts tut oder ein Ergebnis nur ungefähr stimmt. Das ist eine
 *   Bestandsaufnahme, kein Grenzwert-Test: der Sinn ist zu SEHEN, wie gut es
 *   wirklich ist, nicht ein grünes Ergebnis zu erzwingen.
 *
 * messwerteFuerEmpfaenger()/messwerteMaskieren() selbst (in
 * packages/server/src/translation/index.ts) hängen an einer echten
 * Datenbank und werden hier bewusst nicht importiert — genau wie
 * echo-pruefen.mjs sich auf die reinen Bausteine beschränkt. Dass beide
 * Server-Pakete mit den neuen Feldern sauber bauen, prüft
 * `npx tsc --noEmit -p packages/server/tsconfig.json` (und .../desktop).
 */
import {
  dezimaltrennzeichenFuerSprache, findMeasurements, messwertPlatzhalter,
  messwerteInTextEinsetzen, regionFuerZeitzone,
} from '../packages/shared/src/einheiten.ts';

let bestanden = 0;
let gefallen = 0;
const pruefe = (name, bedingung, hinweis = '') => {
  if (bedingung) { bestanden++; console.log(`  ✓ ${name}`); }
  else { gefallen++; console.log(`  ✗ ${name}${hinweis ? ` — ${hinweis}` : ''}`); }
};

/**
 * Simuliert, was der Server tatsächlich tut (translate() + messwerteFuer-
 * Empfaenger() in packages/server/src/translation/index.ts), aber rein
 * lokal: Maßangaben finden, an ihrer Stelle durch einen Sentinel ersetzen
 * (⟦m0⟧, ⟦m1⟧, …, so wie es das Modell nach der Übersetzung zurückgibt),
 * dann für EINE bestimmte Region auflösen. Der Umweg über {{n}} + das
 * Sprachmodell fehlt hier bewusst — er dient ausschließlich dazu, dass das
 * Modell die Zahl beim Übersetzen nicht anfasst, und ändert am Ergebnis
 * nichts, was diese Funktion hier nicht auch schon zeigt.
 */
function fuerRegion(text, region, sprache = 'en') {
  const funde = findMeasurements(text);
  if (!funde.length) return text;
  let mitSentinels = text;
  for (const m of [...funde].sort((a, b) => b.start - a.start)) {
    const i = funde.indexOf(m);
    mitSentinels = mitSentinels.slice(0, m.start) + messwertPlatzhalter(i) + mitSentinels.slice(m.end);
  }
  const record = Object.fromEntries(funde.map((m, i) => [i, m]));
  return messwerteInTextEinsetzen(mitSentinels, record, region, dezimaltrennzeichenFuerSprache(sprache));
}

console.log('\nTeil 1 — feste Zusicherungen\n');

console.log(' Region aus der Zeitzone:');
pruefe('New York -> us', regionFuerZeitzone('America/New_York') === 'us');
pruefe('Denver -> us', regionFuerZeitzone('America/Denver') === 'us');
pruefe('Honolulu -> us (kein "America/"-Präfix)', regionFuerZeitzone('Pacific/Honolulu') === 'us');
pruefe('veralteter Alias US/Eastern -> us', regionFuerZeitzone('US/Eastern') === 'us');
pruefe('London -> uk', regionFuerZeitzone('Europe/London') === 'uk');
pruefe('Berlin -> metrisch', regionFuerZeitzone('Europe/Berlin') === 'metrisch');
pruefe('Tokio -> metrisch', regionFuerZeitzone('Asia/Tokyo') === 'metrisch');
pruefe('leer/unbekannt -> metrisch (sicherer Fehlschlag)', regionFuerZeitzone(null) === 'metrisch');

console.log('\n Dezimaltrennzeichen:');
pruefe('Deutsch -> Komma', dezimaltrennzeichenFuerSprache('de') === ',');
pruefe('Englisch -> Punkt', dezimaltrennzeichenFuerSprache('en') === '.');
pruefe('Französisch -> Komma', dezimaltrennzeichenFuerSprache('fr') === ',');
pruefe('Japanisch -> Punkt', dezimaltrennzeichenFuerSprache('ja') === '.');

console.log('\n Kernfall aus dem Auftrag — "es ist 25 Grad warm":');
{
  const satz = 'es ist 25 Grad warm';
  const usa = fuerRegion(satz, 'us');
  const uk = fuerRegion(satz, 'uk');
  const de = fuerRegion(satz, 'metrisch');
  console.log(`   Original: „${satz}"`);
  console.log(`   USA:      „${usa}"`);
  console.log(`   UK:       „${uk}"`);
  console.log(`   DE:       „${de}"`);
  pruefe('USA sieht 77 °F', usa === 'es ist 77 °F (25 Grad) warm', usa);
  pruefe('UK bleibt unverändert Celsius', uk === satz, uk);
  pruefe('metrische Region bleibt ebenfalls unverändert', de === satz, de);
}

console.log('\n Gewicht, beide Richtungen:');
{
  const metrischNachUS = fuerRegion('das Paket wiegt 10 kg', 'us');
  pruefe('10 kg -> 22 lb (US)', metrischNachUS === 'das Paket wiegt 22 lb (10 kg)', metrischNachUS);
  const usNachMetrisch = fuerRegion('the package weighs 22 lbs', 'metrisch');
  pruefe('22 lbs -> 10 kg (metrisch)', usNachMetrisch === 'the package weighs 10 kg (22 lbs)', usNachMetrisch);
  const koerpergewichtUK = fuerRegion('she weighs 65 kg', 'uk');
  pruefe('Körpergewicht 65 kg -> Stone (UK)', koerpergewichtUK === 'she weighs 10 st (65 kg)', koerpergewichtUK);
  const nichtKoerpergewichtUK = fuerRegion('the flour is 65 kg', 'uk');
  pruefe('65 kg OHNE Körpergewichts-Hinweis bleibt in UK unverändert (Gramm/Kilo sind dort Alltag)',
    nichtKoerpergewichtUK === 'the flour is 65 kg', nichtKoerpergewichtUK);

  // Bekannte Grenze der Heuristik, absichtlich gezeigt statt versteckt: sie
  // prüft nur, ob ein Stichwort wie "weighs" in der Nähe steht — WER oder
  // WAS wiegt, prüft sie nicht. Eine Zutat, die zufällig mit "weighs" statt
  // "is" beschrieben wird, sieht für sie identisch aus wie eine Person.
  const falscherTreffer = fuerRegion('the flour weighs 65 kg', 'uk');
  console.log(`   bekannte Grenze: „the flour weighs 65 kg" (UK) -> „${falscherTreffer}" `
    + '— "weighs" reicht der Heuristik, das Mehl bekommt fälschlich Stone statt Kilo.');
}

console.log('\n Entfernung, beide Richtungen:');
{
  const kmNachUS = fuerRegion('der Weg ist 5 km lang', 'us');
  pruefe('5 km -> 3 mi (US)', kmNachUS === 'der Weg ist 3 mi (5 km) lang', kmNachUS);
  const miNachMetrisch = fuerRegion('it is 3.1 miles away', 'metrisch');
  pruefe('3,1 mi -> 5,0 km, EINE Nachkommastelle wie im Original erhalten',
    miNachMetrisch === 'it is 5.0 km (3.1 miles) away', miNachMetrisch);
}

console.log('\n Volumen, beide Richtungen:');
{
  const literNachUS = fuerRegion('bring 2 Liter Wasser mit', 'us');
  pruefe('2 Liter -> 4 pt (US)', literNachUS === 'bring 4 pt (2 Liter) Wasser mit', literNachUS);
  const gallonenNachMetrisch = fuerRegion('get 2 gallons of milk', 'metrisch');
  pruefe('2 US-Gallonen -> 8 l (metrisch)', gallonenNachMetrisch === 'get 8 l (2 gallons) of milk', gallonenNachMetrisch);
  const ukGallone = fuerRegion('we need 2 imperial gallons of paint', 'us');
  const usGalloneDefault = fuerRegion('we need 2 gallons of paint', 'uk');
  console.log(`   "2 imperial gallons" für US:  „${ukGallone}"`);
  console.log(`   "2 gallons" (ohne Hinweis) für UK: „${usGalloneDefault}"`);
  pruefe('explizit "imperial gallon" nimmt die BRITISCHE Gallone (anderer Umrechnungsfaktor als US)',
    ukGallone.includes('pt (2 imperial gallons)') || ukGallone.includes('gal (2 imperial gallons)'));
}

console.log('\n Rundung — Nachkommastellen des Originals bleiben erhalten:');
{
  const exakt = fuerRegion('das Paket wiegt genau 100,0 kg', 'us', 'en');
  pruefe('"100,0 kg" (1 Nachkommastelle, Absicht) wird NICHT zu "220 lb" gerundet',
    exakt.includes('220.5 lb'), exakt);
  console.log(`   „das Paket wiegt genau 100,0 kg" (US, Anzeigesprache en) -> „${exakt}"`);
  const exaktDe = fuerRegion('das Paket wiegt genau 100,0 kg', 'us', 'de');
  console.log(`   dieselbe Nachricht, Anzeigesprache de -> „${exaktDe}"`);
  pruefe('Dezimaltrennzeichen folgt der ANZEIGESPRACHE der lesenden Person, nicht der Zielregion',
    exaktDe.includes('220,5 lb'), exaktDe);
}

console.log('\n Fälle, die NICHT umgerechnet werden dürfen:');
{
  const faelle = [
    ['Winkel, Bindestrich-Komposit', 'ein 90-Grad-Winkel ist ein rechter Winkel'],
    ['Winkel, ohne Warm/Kalt-Hinweis', 'der Winkel beträgt 90 Grad'],
    ['Fassungsnummer', 'Fassung 2.5 ist jetzt installiert'],
    ['Zimmernummer', 'wir sind in Zimmer 12'],
    ['Uhrzeit', 'Meeting um 14 Uhr im großen Raum'],
    ['Preis mit Symbol', 'das kostet 19,99 €'],
    ['Preis in Worten ("Pfund" bewusst nie als Maß erkannt)', 'das kostet 50 Pfund'],
    ['"Pfund" auch als deutsches Gewicht ausgeschlossen (bewusste Übervorsicht)', '5 Pfund Mehl bitte'],
    ['Streckenname, Bindestrich-Komposit', 'der 100-Meter-Lauf beginnt gleich'],
    ['Zahlenspanne', 'wir brauchen 10-20 kg Sand'],
    ['Minutenangabe ("Min" ist keine erkannte Einheit)', 'bin in 5 Min da'],
    ['bloßes "m" ohne Dezimalstelle/Kontext', 'der Aufzug hält in 5 m'],
  ];
  for (const [name, satz] of faelle) {
    const funde = findMeasurements(satz);
    pruefe(name, funde.length === 0, `„${satz}" ergab ${funde.length} Treffer: ${JSON.stringify(funde.map((f) => f.rohtext))}`);
  }
}

console.log('\n Zwei Engländer, verschiedene Zeitzone -> verschiedene Einheiten:');
{
  const satz = 'it is 25°C outside right now';
  const denver = fuerRegion(satz, regionFuerZeitzone('America/Denver'), 'en');
  const london = fuerRegion(satz, regionFuerZeitzone('Europe/London'), 'en');
  console.log(`   Original:          „${satz}"`);
  console.log(`   Empfänger Denver:  „${denver}"  (Region: ${regionFuerZeitzone('America/Denver')})`);
  console.log(`   Empfänger London:  „${london}"  (Region: ${regionFuerZeitzone('Europe/London')})`);
  pruefe('Denver bekommt Fahrenheit dazu', denver === 'it is 77 °F (25°C) outside right now', denver);
  pruefe('London sieht denselben Satz unverändert', london === satz, london);
  pruefe('beide Ausgaben unterscheiden sich, obwohl Nachricht und Zielsprache identisch sind', denver !== london);

  const gewichtssatz = 'Tom weighs 90 kg now';
  const denverGewicht = fuerRegion(gewichtssatz, regionFuerZeitzone('America/Denver'), 'en');
  const londonGewicht = fuerRegion(gewichtssatz, regionFuerZeitzone('Europe/London'), 'en');
  console.log(`   Original:          „${gewichtssatz}"`);
  console.log(`   Empfänger Denver:  „${denverGewicht}"`);
  console.log(`   Empfänger London:  „${londonGewicht}"`);
  pruefe('bei Körpergewicht weichen US (lb) und UK (Stone) AUCH untereinander ab',
    denverGewicht !== londonGewicht && denverGewicht.includes('lb') && londonGewicht.includes('st'));
}

console.log(`\nTeil 1: ${gefallen ? '✗' : '✓'} ${bestanden} bestanden, ${gefallen} gefallen\n`);

/* ── Teil 2: echte Sätze, so wie sie durchlaufen ──────────────────── */

console.log('Teil 2 — echte Sätze durch die gesamte Kette\n');

const SAETZE = [
  ['DE -> US, bare Grad mit Kontext', 'es ist 25 Grad warm', 'us'],
  ['DE -> UK, bleibt Celsius', 'es ist 25 Grad warm', 'uk'],
  ['EN -> DE, explizites Fahrenheit', 'preheat the oven to 350°F', 'metrisch'],
  ['DE -> US, Backofen', 'den Ofen auf 180 Grad vorheizen', 'us'],
  ['EN -> UK, "lost" ist bewusst KEIN Körpergewichts-Stichwort (zu generisch, "we lost 5 kg of stock" wäre kein Körpergewicht) — bleibt hier unverändert, obwohl gemeint', 'I lost 5 kg last month', 'uk'],
  ['EN -> US, Strecke', 'the store is 800 m away', 'us'],
  ['DE -> metrisch, keine Änderung nötig', 'das Regal ist 2 Meter breit', 'metrisch'],
  ['EN -> metrisch, Fläche', 'the apartment is 750 sq ft', 'metrisch'],
  ['DE -> US, Fläche', 'das Grundstück ist 500 m² groß', 'us'],
  ['EN -> metrisch, Geschwindigkeit', 'he was doing 70 mph on the highway', 'metrisch'],
  ['DE -> US, Geschwindigkeit', 'die Höchstgeschwindigkeit ist 50 km/h', 'us'],
  ['EN, bloßes "degrees" — bewusst NICHT erkannt (US/UK unauflösbar mehrdeutig)', "it's 90 degrees today, so hot!", 'metrisch'],
  ['DE, kleine Menge — Rundung auf 0 Nachkommastellen wirkt grob', '1 kg Äpfel bitte', 'us'],
  ['EN, ungewöhnlicher Bindestrich — wird (zu vorsichtig) übersprungen', 'the cable is 5-meter long', 'us'],
  ['DE, Zahlenspanne — wird komplett übersprungen', 'wir brauchen 10-20 kg Sand', 'us'],
  ['EN, gemischter Satz mit echtem UND falschem Treffer-Kandidat', 'Room 12 is 25 m² and costs 19.99 dollars a day', 'us'],
];

for (const [label, satz, region] of SAETZE) {
  const ergebnis = fuerRegion(satz, region, region === 'metrisch' ? 'de' : 'en');
  const veraendert = ergebnis !== satz ? '' : '  (unverändert)';
  console.log(` [${region.padEnd(9)}] ${label}`);
  console.log(`   „${satz}"`);
  console.log(`   -> „${ergebnis}"${veraendert}\n`);
}

console.log(`Insgesamt: ${gefallen ? '✗' : '✓'} ${bestanden} bestanden, ${gefallen} gefallen`);
process.exit(gefallen ? 1 : 0);
