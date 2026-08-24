/**
 * Schlägt die Uhrprüfung an — und schweigt sie, wenn nichts ist?
 *
 * Eine Warnung, die zu früh kommt, ist schlimmer als keine: nach dem dritten
 * Fehlalarm klickt sie jeder weg, auch den echten. Eine, die zu spät kommt,
 * ist nutzlos. Deshalb wird hier beides geprüft — der Punkt, an dem sie
 * anspringt, UND der Bereich, in dem sie still bleibt.
 *
 *     node scripts/einmalcode-uhr-pruefen.mjs
 *
 * Braucht keinen Server und kein Fenster: state/einmalcode-zeit.ts sind reine
 * Funktionen ohne React.
 *
 * DIE ZWEI UHREN
 *
 * Sie tun NICHT dasselbe, und das ist der Kern:
 *
 *   · Die Uhr des SERVERS entscheidet, ob ein Code richtig ist. Liegt sie
 *     daneben, wird kein Code gezeigt.
 *   · Die Uhr DIESES RECHNERS entscheidet nur, ob der Balken darunter stimmt.
 *     Sie wird herausgerechnet, nicht angeprangert — der Code bleibt richtig.
 */
import {
  KNAPP_SEKUNDEN, SCHWELLE_ANTEIL, aktuellesFenster, anzeigeUrteil, istKnapp,
  laptopUrteil, restSekunden, schwelleMs, serverJetzt, sichereAbweichung, versatzMessen,
} from '../packages/desktop/src/state/einmalcode-zeit.ts';

const F = {
  aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m',
  gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m',
};

let gelaufen = 0;
let gefallen = 0;

function pruefe(name, ist, soll) {
  gelaufen += 1;
  const gleich = JSON.stringify(ist) === JSON.stringify(soll);
  if (!gleich) gefallen += 1;
  const marke = gleich ? `${F.gruen}✓${F.aus}` : `${F.rot}✗${F.aus}`;
  const rechts = gleich
    ? `${F.grau}${JSON.stringify(soll)}${F.aus}`
    : `${F.rot}${JSON.stringify(ist)}${F.aus} ${F.grau}erwartet ${JSON.stringify(soll)}${F.aus}`;
  console.log(`  ${marke} ${name.padEnd(62)} ${rechts}`);
}

function abschnitt(titel) {
  console.log(`\n${F.fett}${titel}${F.aus}`);
}

const PERIODE = 30;
const SCHWELLE = schwelleMs(PERIODE);          // 15000 ms

/* ── Die Schwelle selbst ─────────────────────────────────────── */

abschnitt('Die Schwelle: eine halbe Periode');
pruefe('Anteil', SCHWELLE_ANTEIL, 0.5);
pruefe('30-Sekunden-Periode → 15 000 ms', schwelleMs(30), 15000);
pruefe('60-Sekunden-Periode → 30 000 ms', schwelleMs(60), 30000);

/* ── Versatz messen (NTP-Art) ────────────────────────────────── */

abschnitt('Versatz messen — die Umlaufzeit gehört herausgerechnet');
{
  /* Anfrage um 1000 raus, um 1200 zurück; der Server sagt "1100".
     Mitte = 1100 → Versatz 0, Unsicherheit 100. Eine 200 ms lahme Leitung
     darf NICHT als 100 ms schiefe Uhr durchgehen. */
  const a = versatzMessen(1000, 1200, 1100);
  pruefe('symmetrische Leitung → Versatz 0', a.versatzMs, 0);
  pruefe('symmetrische Leitung → Unsicherheit 100', a.ungenauigkeitMs, 100);
}
{
  /* Derselbe Verlauf, aber der Server ist wirklich 5 s voraus. */
  const a = versatzMessen(1000, 1200, 6100);
  pruefe('Server 5 s voraus → Versatz +5000', a.versatzMs, 5000);
}
{
  const a = versatzMessen(1000, 1200, -3900);
  pruefe('Server 5 s zurück → Versatz −5000', a.versatzMs, -5000);
}
pruefe('serverJetzt() rechnet den Versatz drauf',
  serverJetzt({ versatzMs: 7000, ungenauigkeitMs: 10, gemessenAm: 0 }, 1_000_000), 1_007_000);
pruefe('serverJetzt() ohne Messung = eigene Uhr', serverJetzt(null, 1_000_000), 1_000_000);

/* ── Unsicherheit geht zu Gunsten der Uhr ab ─────────────────── */

abschnitt('Im Zweifel für die Uhr — die Messungenauigkeit wird abgezogen');
pruefe('20 s Abweichung, 1 s Unsicherheit → 19 s sicher', sichereAbweichung(20000, 1000), 19000);
pruefe('20 s Abweichung, 25 s Unsicherheit → 0 s sicher', sichereAbweichung(20000, 25000), 0);
pruefe('Vorzeichen ist egal', sichereAbweichung(-20000, 1000), 19000);

/* ── Die eigene Uhr: wann wird gemeldet? ─────────────────────── */

abschnitt('Uhr dieses Rechners — schweigt innerhalb, meldet außerhalb');

const laptop = (versatzMs, ungenauigkeitMs = 0) =>
  laptopUrteil({ versatzMs, ungenauigkeitMs, gemessenAm: 0 }, PERIODE);

pruefe('ohne Messung → unbekannt', laptopUrteil(null, PERIODE), 'unbekannt');
pruefe('  0 ms  → still', laptop(0), 'inOrdnung');
pruefe('+14 999 ms (knapp darunter) → still', laptop(SCHWELLE - 1), 'inOrdnung');
pruefe('+15 000 ms (genau auf der Schwelle) → still', laptop(SCHWELLE), 'inOrdnung');
pruefe('+15 001 ms (ein ms darüber) → meldet', laptop(SCHWELLE + 1), 'auffaellig');
pruefe('−15 000 ms → still', laptop(-SCHWELLE), 'inOrdnung');
pruefe('−15 001 ms → meldet', laptop(-(SCHWELLE + 1)), 'auffaellig');
pruefe('+30 s → meldet', laptop(30000), 'auffaellig');
pruefe('+2 Stunden (Zeitzone verstellt) → meldet', laptop(2 * 3600 * 1000), 'auffaellig');

/* Der Fehlalarm, den es NICHT geben darf: eine grottige Leitung. */
pruefe('20 s Abweichung bei 20 s Unsicherheit → still (lahme Leitung)', laptop(20000, 20000), 'inOrdnung');
pruefe('20 s Abweichung bei  1 s Unsicherheit → meldet (echte Uhr)', laptop(20000, 1000), 'auffaellig');

/* Bei längerer Periode verschiebt sich die Schwelle mit. */
pruefe('Periode 60 s: +20 s → still',
  laptopUrteil({ versatzMs: 20000, ungenauigkeitMs: 0, gemessenAm: 0 }, 60), 'inOrdnung');
pruefe('Periode 60 s: +31 s → meldet',
  laptopUrteil({ versatzMs: 31000, ungenauigkeitMs: 0, gemessenAm: 0 }, 60), 'auffaellig');

/* ── Vorrat und Restzeit ─────────────────────────────────────── */

abschnitt('Vorrat — welches Fenster gilt, wie lange noch');

/* Drei Fenster ab 1 000 000 ms, je 30 s. */
const VORRAT = [
  { fenster: '1', code: '111111', gueltigAbMs: 1_000_000, gueltigBisMs: 1_030_000 },
  { fenster: '2', code: '222222', gueltigAbMs: 1_030_000, gueltigBisMs: 1_060_000 },
  { fenster: '3', code: '333333', gueltigAbMs: 1_060_000, gueltigBisMs: 1_090_000 },
];

pruefe('genau am Anfang → erstes Fenster', aktuellesFenster(VORRAT, 1_000_000)?.code, '111111');
pruefe('mittendrin → erstes Fenster', aktuellesFenster(VORRAT, 1_029_999)?.code, '111111');
pruefe('auf der Grenze → schon das zweite', aktuellesFenster(VORRAT, 1_030_000)?.code, '222222');
pruefe('letztes Fenster', aktuellesFenster(VORRAT, 1_089_999)?.code, '333333');
pruefe('nach dem Vorrat → keins', aktuellesFenster(VORRAT, 1_090_000), null);
pruefe('vor dem Vorrat → keins', aktuellesFenster(VORRAT, 999_999), null);

pruefe('am Anfang → 30 s übrig', restSekunden(VORRAT[0], 1_000_000), 30);
pruefe('nach 1 s → 29 s übrig', restSekunden(VORRAT[0], 1_001_000), 29);
pruefe('nach 29,5 s → 1 s übrig (aufgerundet)', restSekunden(VORRAT[0], 1_029_500), 1);
pruefe('kein Fenster → 0', restSekunden(null, 1_000_000), 0);

pruefe('knapp bei 5 s', istKnapp(KNAPP_SEKUNDEN), true);
pruefe('nicht knapp bei 6 s', istKnapp(KNAPP_SEKUNDEN + 1), false);
pruefe('0 s ist nicht „knapp", sondern vorbei', istKnapp(0), false);

/* ── Das Gesamturteil ────────────────────────────────────────── */

abschnitt('Was die Tafel zeigt — die Reihenfolge zählt');

/* `geprueftAm` ist der Unterschied zwischen zwei völlig verschiedenen
   „unbekannt": `null` heißt „noch nie geprüft" (die paar Sekunden direkt nach
   einem Serverneustart, bevor die erste Prüfung überhaupt fertig ist), ein
   Zeitstempel heißt „geprüft, aber immer noch kein Ergebnis" (der Fall, der
   einen Alarm verdient — siehe anzeigeUrteil() in state/einmalcode-zeit.ts).
   Standardmäßig gesetzt, weil die meisten Zustände hier mit einer
   abgeschlossenen Prüfung gemeint sind. */
const uhr = (zustand, geprueftAm = Date.now()) => ({
  zustand, abweichungMs: null, ungenauigkeitMs: null, geprueftAm, abgeglichen: null,
});
const gut = { versatzMs: 0, ungenauigkeitMs: 10, gemessenAm: 0 };
const schief = { versatzMs: 90_000, ungenauigkeitMs: 10, gemessenAm: 0 };
const urteil = (u, abgleich, fenster, rest) =>
  anzeigeUrteil({ uhr: u, abgleich, periodeSekunden: PERIODE, fenster, rest });

pruefe('alles in Ordnung → Code, kein Hinweis',
  urteil(uhr('inOrdnung'), gut, VORRAT[0], 20),
  { codeZeigen: true, hinweis: null, schwer: false });

pruefe('Serveruhr nachweislich falsch → KEIN Code',
  urteil(uhr('abweichung'), gut, VORRAT[0], 20),
  { codeZeigen: false, hinweis: 'einmalcode.uhrServerFalsch', schwer: true });

pruefe('Serveruhr falsch schlägt alles andere',
  urteil(uhr('abweichung'), schief, VORRAT[0], 2),
  { codeZeigen: false, hinweis: 'einmalcode.uhrServerFalsch', schwer: true });

pruefe('Vorrat leer (Verbindung weg) → KEIN Code',
  urteil(uhr('inOrdnung'), gut, null, 0),
  { codeZeigen: false, hinweis: 'einmalcode.vorratLeer', schwer: true });

pruefe('Serveruhr ungeprüft → Code MIT schwerem Hinweis',
  urteil(uhr('nichtAbgeglichen'), gut, VORRAT[0], 20),
  { codeZeigen: true, hinweis: 'einmalcode.uhrServerUngeprueft', schwer: true });

pruefe('eigene Uhr schief → Code, leichter Hinweis',
  urteil(uhr('inOrdnung'), schief, VORRAT[0], 20),
  { codeZeigen: true, hinweis: 'einmalcode.uhrGeraetSchief', schwer: false });

pruefe('eigene Uhr schief wiegt schwerer als „gleich neu"',
  urteil(uhr('inOrdnung'), schief, VORRAT[0], 2),
  { codeZeigen: true, hinweis: 'einmalcode.uhrGeraetSchief', schwer: false });

pruefe('knappes Fenster → Code, Hinweis zu warten',
  urteil(uhr('inOrdnung'), gut, VORRAT[0], 3),
  { codeZeigen: true, hinweis: 'einmalcode.gleichNeu', schwer: false });

pruefe('Uhrstand dauerhaft unbekannt (schon geprüft) → Code MIT Hinweis',
  urteil(uhr('unbekannt'), gut, VORRAT[0], 20),
  { codeZeigen: true, hinweis: 'einmalcode.uhrServerUnbekannt', schwer: true });

pruefe('Uhrstand noch nie geprüft (frisch nach Neustart) → Code, kein Alarm',
  urteil(uhr('unbekannt', null), gut, VORRAT[0], 20),
  { codeZeigen: true, hinweis: null, schwer: false });

pruefe('gar kein Uhrstand → Code, kein Alarm',
  urteil(null, gut, VORRAT[0], 20),
  { codeZeigen: true, hinweis: null, schwer: false });

/* ── Ein durchgespielter Fall ────────────────────────────────── */

abschnitt('Durchgespielt: Laptop geht zwei Minuten vor, Server geht richtig');
{
  /* Der Rechner glaubt, es sei 1 120 000; in Wahrheit ist es 1 000 000.
     Ohne Korrektur zeigte die Tafel „Vorrat leer" — das dritte Fenster endet
     bei 1 090 000. Mit Korrektur trifft sie das richtige. */
  const eigeneUhr = 1_120_000;
  const echteZeit = 1_000_000;
  const abgleich = versatzMessen(eigeneUhr - 50, eigeneUhr + 50, echteZeit);
  pruefe('gemessener Versatz', abgleich.versatzMs, -120_000);
  pruefe('eigene Uhr allein → falsches (kein) Fenster', aktuellesFenster(VORRAT, eigeneUhr), null);
  const korrigiert = serverJetzt(abgleich, eigeneUhr);
  pruefe('korrigierte Zeit', korrigiert, echteZeit);
  pruefe('korrigiert → richtiges Fenster', aktuellesFenster(VORRAT, korrigiert)?.code, '111111');
  pruefe('… und der Balken stimmt wieder', restSekunden(aktuellesFenster(VORRAT, korrigiert), korrigiert), 30);
  pruefe('… gemeldet wird die schiefe Uhr trotzdem', laptopUrteil(abgleich, PERIODE), 'auffaellig');
  pruefe('… und der Code wird gezeigt, nicht einbehalten',
    anzeigeUrteil({
      uhr: uhr('inOrdnung'), abgleich, periodeSekunden: PERIODE,
      fenster: aktuellesFenster(VORRAT, korrigiert), rest: 30,
    }).codeZeigen, true);
}

console.log('');
if (gefallen) {
  console.log(`${F.rot}${F.fett}${gefallen} von ${gelaufen} Prüfungen gefallen.${F.aus}`);
  process.exit(1);
}
console.log(`${F.gruen}${F.fett}Alle ${gelaufen} Prüfungen bestanden.${F.aus}`);
