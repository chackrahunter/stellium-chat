/**
 * Beweis für die Dublettensperre bei Verkaufsmeldungen — läuft zweimal als
 * GETRENNTER Prozess (siehe scripts/verkauf-benachrichtigung-pruefen.mjs)
 * gegen dieselbe, liegen gebliebene Datenbank:
 *
 *   Phase 1 — der erste Sync-Lauf nach Einführung dieser Funktion: der
 *   Kaltstart (Altbestand bleibt still), der erste echte neue Verkauf, ein
 *   Schwall von zwanzig Verkäufen in einem Lauf (Bündelung statt Flut), und
 *   dasselbe für Patreon.
 *
 *   Phase 2 — SIMULIERTER SERVERNEUSTART, ein komplett neuer Prozess: ein
 *   ganz normaler erneuter Sync-Lauf sieht DIESELBEN Kennungen noch einmal
 *   (Gumroad fragt bei jedem Lauf den vollen Bestand ab, kein inkrementeller
 *   Abruf — siehe Dateikopf von services/gumroad.ts) und darf davon NICHTS
 *   ein zweites Mal melden. Eine echte Verlängerung und ein echtes neues
 *   Patreon-Mitglied (beides neue Kennungen) melden sich dagegen ganz normal.
 *
 * Warum zwei Prozesse und nicht derselbe Aufruf zweimal im selben Lauf: ein
 * In-Speicher-Merker (etwa eine Set()-Variable auf Modulebene) bestünde eine
 * Prüfung innerhalb eines einzigen Prozesses genauso wie eine echte,
 * datenbankgestützte Sperre — er verlöre seinen Inhalt aber bei jedem
 * echten Serverneustart, und genau das darf nicht passieren. Erst der
 * zweite, komplett neu gestartete Prozess deckt den Unterschied auf.
 * Dieselbe Bauart wie scripts/e2e-nachruesten.mjs, das aus demselben Grund
 * den Server als eigenen Prozess gegen eine liegen gebliebene Datenbank
 * startet statt eine Funktion zweimal aufzurufen.
 *
 * Nicht von Hand mit nur einer Phase aufrufen — das bewiese nichts. Aufruf:
 * node scripts/verkauf-benachrichtigung-pruefen.mjs (startet beide Phasen).
 */
import { db, initDb } from '../db/index.js';
import { ereignisseVerarbeiten, meldungenListe, melderSetzen } from '../services/verkaufBenachrichtigung.js';

initDb();

const phase = process.argv[2];
if (phase !== '1' && phase !== '2') {
  console.error('Erwarte "1" oder "2" als Argument (siehe scripts/verkauf-benachrichtigung-pruefen.mjs).');
  process.exit(1);
}

let fehler = 0;
function pruef(name: string, ist: unknown, soll: unknown): void {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n      erwartet: ${JSON.stringify(soll)}\n      bekommen: ${JSON.stringify(ist)}`}`);
}

/* Zählt, wie oft der Melder in DIESEM Prozess aufgerufen wurde — steht für
   "wie viele unterbrechende Meldungen (Toast, künftig Push) sind ausgelöst
   worden", nicht für die Zahl der Zeilen. Die Liste bleibt immer
   vollständig (jedes Ereignis seine eigene Zeile); geflutet werden könnte
   nur dieser unterbrechende Weg — siehe Dateikopf von
   verkaufBenachrichtigung.ts, "WARUM NICHT FLUTEN". */
let melderAufrufe = 0;
const empfangenePakete: { anbieter: string; anzahl: number }[] = [];
melderSetzen((_userId, anbieter, meldungen) => {
  melderAufrufe += 1;
  empfangenePakete.push({ anbieter, anzahl: meldungen.length });
});

/* Ein Konto mit verkauf.sehen muss existieren, sonst geht jede Meldung ins
   Leere (empfaengerkreis() ist leer) und benachrichtigen() ruft den Melder
   nie auf — die Dublettensperre selbst wäre davon nicht betroffen, aber der
   Melder-Zähler unten bliebe bei 0, ganz gleich ob die Sperre funktioniert.
   Nur in Phase 1 angelegt; Phase 2 findet dasselbe Konto in derselben
   (liegen gebliebenen) Datenbank wieder. */
if (phase === '1') {
  db.run(
    `INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
    'u_test', 'don', 'Don', 'x', 'owner', Date.now(),
  );
}

if (phase === '1') {
  console.log('\n  \x1b[1m1. Kaltstart: der allererste Lauf bleibt still\x1b[0m');
  const kaltstartErgebnis = ereignisseVerarbeiten('gumroad', [
    { fingerabdruck: 'gumroad:verkauf:v-alt-1', art: 'einmalig', produktName: 'Altes Produkt', betragCent: 900, waehrung: 'USD', inProbe: null },
    { fingerabdruck: 'gumroad:verkauf:v-alt-2', art: 'neu', produktName: 'Altes Produkt', betragCent: 1900, waehrung: 'USD', inProbe: false },
  ]);
  pruef('Kaltstart meldet nichts zurück', kaltstartErgebnis.length, 0);
  pruef('Kaltstart löst keinen Melder-Aufruf aus', melderAufrufe, 0);
  pruef('Kaltstart-Zeilen erscheinen nicht in der Liste', meldungenListe(50).length, 0);

  console.log('\n  \x1b[1m2. Der erste ECHTE neue Verkauf nach dem Kaltstart meldet sich\x1b[0m');
  const ersterVerkauf = ereignisseVerarbeiten('gumroad', [
    { fingerabdruck: 'gumroad:verkauf:v-neu-1', art: 'neu', produktName: 'Sternenkarte', betragCent: 2500, waehrung: 'USD', inProbe: true },
  ]);
  pruef('genau eine neue Meldung', ersterVerkauf.length, 1);
  pruef('genau ein Melder-Aufruf', melderAufrufe, 1);
  pruef('die Meldung steht jetzt in der Liste', meldungenListe(50).some((m) => m.id === ersterVerkauf[0]?.id), true);
  pruef('Betrag, Produkt und Probe-Status kommen unverändert an',
    empfangenePakete.at(-1) && { anzahl: empfangenePakete.at(-1)!.anzahl }, { anzahl: 1 });

  console.log('\n  \x1b[1m3. Zwanzig Verkäufe in EINEM Sync-Lauf lösen GENAU EINEN Melder-Aufruf aus\x1b[0m');
  const zwanzig = Array.from({ length: 20 }, (_, i) => ({
    fingerabdruck: `gumroad:verkauf:v-schwall-${i}`, art: 'einmalig' as const,
    produktName: 'Sternenkarte', betragCent: 1500, waehrung: 'USD', inProbe: null,
  }));
  const vorMelderAufrufe = melderAufrufe;
  const schwallErgebnis = ereignisseVerarbeiten('gumroad', zwanzig);
  pruef('zwanzig neue Zeilen', schwallErgebnis.length, 20);
  pruef('genau EIN zusätzlicher Melder-Aufruf für die zwanzig zusammen — keine Flut', melderAufrufe - vorMelderAufrufe, 1);
  pruef('dieser eine Aufruf trägt alle zwanzig Meldungen gebündelt', empfangenePakete.at(-1), { anbieter: 'gumroad', anzahl: 20 });

  console.log('\n  \x1b[1m4. Patreon: derselbe Mechanismus, eigener Kaltstart je Anbieter\x1b[0m');
  const patreonKaltstart = ereignisseVerarbeiten('patreon', [
    { fingerabdruck: 'patreon:mitglied:m-alt', art: 'neu', produktName: null, betragCent: 500, waehrung: 'EUR', inProbe: null },
  ]);
  pruef('Patreons Kaltstart meldet nichts, obwohl Gumroad längst darüber hinaus ist', patreonKaltstart.length, 0);
  const patreonErsterEcht = ereignisseVerarbeiten('patreon', [
    { fingerabdruck: 'patreon:mitglied:m-2', art: 'neu', produktName: null, betragCent: 700, waehrung: 'EUR', inProbe: null },
  ]);
  pruef('der erste echte Patreon-Zugang danach meldet sich', patreonErsterEcht.length, 1);
  const patreonNochmal = ereignisseVerarbeiten('patreon', [
    { fingerabdruck: 'patreon:mitglied:m-2', art: 'neu', produktName: null, betragCent: 700, waehrung: 'EUR', inProbe: null },
  ]);
  pruef('dasselbe Mitglied im selben Prozess ein zweites Mal: keine neue Meldung', patreonNochmal.length, 0);

  console.log(`\n  Phase 1 legt ${db.get<{ n: number }>('SELECT COUNT(*) as n FROM verkauf_ereignisse')?.n} Zeile(n) für Phase 2 an.`);
} else {
  console.log('\n  \x1b[1m5. SIMULIERTER SERVERNEUSTART — dieselben Kennungen, noch einmal gesehen\x1b[0m');
  const vorherAnzahlZeilen = db.get<{ n: number }>('SELECT COUNT(*) as n FROM verkauf_ereignisse')?.n ?? 0;
  pruef('die Datenbank aus Phase 1 ist wirklich noch da (neuer Prozess, gleiche Datei)', vorherAnzahlZeilen > 0, true);

  // Exakt dieselben 21 Kennungen wie in Phase 1, Schritt 2 und 3 — genau
  // das, was ein ganz normaler erneuter Sync-Lauf nach einem Neustart
  // liefern würde (Gumroad fragt jedes Mal den vollen Bestand ab).
  const wiederholung = ereignisseVerarbeiten('gumroad', [
    { fingerabdruck: 'gumroad:verkauf:v-neu-1', art: 'neu', produktName: 'Sternenkarte', betragCent: 2500, waehrung: 'USD', inProbe: true },
    ...Array.from({ length: 20 }, (_, i) => ({
      fingerabdruck: `gumroad:verkauf:v-schwall-${i}`, art: 'einmalig' as const,
      produktName: 'Sternenkarte', betragCent: 1500, waehrung: 'USD', inProbe: null,
    })),
  ]);
  pruef('keine einzige der 21 wiederholten Kennungen gilt als neu', wiederholung.length, 0);
  pruef('kein einziger Melder-Aufruf für den wiederholten Lauf — DAS ist die Dublettensperre über den Neustart hinweg', melderAufrufe, 0);
  pruef('die Zeilenzahl in der Datenbank ändert sich nicht', db.get<{ n: number }>('SELECT COUNT(*) as n FROM verkauf_ereignisse')?.n, vorherAnzahlZeilen);

  console.log('\n  \x1b[1m6. Eine echte Verlängerung (neue Verkaufs-ID) meldet sich normal\x1b[0m');
  const verlaengerung = ereignisseVerarbeiten('gumroad', [
    { fingerabdruck: 'gumroad:verkauf:v-neu-1-verlaengerung', art: 'verlaengerung', produktName: 'Sternenkarte', betragCent: 2500, waehrung: 'USD', inProbe: false },
  ]);
  pruef('die Verlängerung ist eine eigene, neue Meldung (andere Kennung als der Erstkauf)', verlaengerung.length, 1);
  pruef('jetzt genau ein Melder-Aufruf in Phase 2', melderAufrufe, 1);

  console.log('\n  \x1b[1m7. Ein echtes neues Patreon-Mitglied (Anbieter längst über dem Kaltstart) meldet sich normal\x1b[0m');
  const patreonNeuInPhase2 = ereignisseVerarbeiten('patreon', [
    { fingerabdruck: 'patreon:mitglied:m-3', art: 'neu', produktName: null, betragCent: 300, waehrung: 'EUR', inProbe: null },
  ]);
  pruef('ein bislang unbekanntes Mitglied meldet sich', patreonNeuInPhase2.length, 1);
  const patreonWiederholtAusPhase1 = ereignisseVerarbeiten('patreon', [
    { fingerabdruck: 'patreon:mitglied:m-2', art: 'neu', produktName: null, betragCent: 700, waehrung: 'EUR', inProbe: null },
  ]);
  pruef('dasselbe Mitglied aus Phase 1 meldet sich über den Neustart hinweg nicht noch einmal', patreonWiederholtAusPhase1.length, 0);

  console.log('\n  \x1b[1m8. Die Liste zeigt am Ende jedes einzelne echte Ereignis, nicht nur die Melder-Aufrufe\x1b[0m');
  // 1 (Schritt 2) + 20 (Schritt 3) + 1 (Schritt 4, m-2) + 1 (Schritt 6) + 1 (Schritt 7, m-3) = 24
  // — der Kaltstand (v-alt-1, v-alt-2, m-alt) bleibt draußen, "stumm".
  pruef('24 sichtbare Zeilen insgesamt — jedes echte Ereignis einzeln, keine Sammelzeile', meldungenListe(200).length, 24);
}

console.log('');
if (!fehler) {
  console.log(`  \x1b[32m✓ Phase ${phase}: alle Fälle stimmen.\x1b[0m\n`);
  process.exit(0);
}
console.log(`  \x1b[31m✗ Phase ${phase}: ${fehler} Fall/Fälle stimmen nicht.\x1b[0m\n`);
process.exit(1);
