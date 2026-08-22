/**
 * Stimmt die Verkaufsstatistik — gegen eine WEGWERFBARE Datenbank, mit
 * erfundenen Verkaufsdaten (es gibt heute wirklich null Verkäufe, siehe
 * Auftrag).
 *
 * Fünf Fälle, die alle STILL falsch werden können, ohne dass eine
 * Kennzahl allein das verrät:
 *
 *   1. Eine Erstattung, die NACH dem Verkauf eintrifft, muss die Zahl des
 *      ALTEN Monats ändern — nicht des Monats, in dem die Erstattung ankam.
 *   2. Ein zweiter Abruf derselben Verkäufe darf NICHT doppelt zählen.
 *   3. Eine Rückbuchung muss in BEIDEN Schreibweisen erkannt werden
 *      (`chargedback` bei /v2/sales, `chargebacked` bei /v2/licenses/*).
 *   4. Die Probezeit muss auch GENAU AM TAG des Ablaufs richtig gezählt
 *      werden — nicht nur "vorher" und "nachher" im Abstand von Tagen.
 *   5. Der Wechselkurs eines alten Verkaufs bleibt stabil, auch wenn sich
 *      der HEUTIGE Kurs ändert.
 *
 * Siehe scripts/umfrage-anonym-pruefen.mjs für dasselbe Muster (eigener
 * Ordner, wegwerfbare Datenbank, rohes SQL statt der Dienstfunktionen, wo es
 * um die Datenbank selbst geht — hier zusätzlich: DIE Dienstfunktionen
 * selbst, weil es hier um deren rechnerische Richtigkeit geht, nicht um
 * einen Datenschutz-Nachweis).
 *
 * Aufruf:  node scripts/verkaufsstatistik-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import {
  gumroadVerkaeufeSpeichern, gumroadAbonnentenSpeichern, gumroadBerechnen, istRueckgebucht,
  type RohVerkauf, type RohAbonnent,
} from '../services/gumroad.js';
import { kursFuerDatum } from '../services/wechselkurse.js';

initDb();

let fehler = 0;
function pruef(name: string, ist: unknown, soll: unknown): void {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n      erwartet: ${JSON.stringify(soll)}\n      bekommen: ${JSON.stringify(ist)}`}`);
}

/* ── 0. Leerer Zustand ────────────────────────────────────────────────
   Vor jeder Zeile Roh-Daten: sieht die Übersicht bei null Verkäufen —
   dem tatsächlichen heutigen Stand aller drei Produkte — ehrlich leer
   aus, statt Nullen zu zeigen, die nach kaputt aussehen? */
console.log(`\n  \x1b[1mLeerer Zustand — heutiger Stand aller drei Produkte\x1b[0m`);
{
  const u = gumroadBerechnen();
  pruef('hatDaten ist falsch, solange nichts abgelegt wurde', u.hatDaten, false);
  pruef('kein Token in dieser Wegwerf-Datenbank hinterlegt', u.tokenVorhanden, false);
  pruef('Verlauf ist eine leere Liste, kein Diagramm mit Nullen', u.verlauf, []);
  pruef('Umsatz/Monat ist 0, nicht "unbekannt" — 0 ist hier eine richtige Auskunft', u.umsatz.monatCent, 0);
}

/* ── 1. Erstattung NACH dem Verkauf ändert die Zahl des ALTEN Monats ─── */
console.log(`\n  \x1b[1m1. Eine späte Erstattung korrigiert den ursprünglichen Monat\x1b[0m`);
{
  const verkauf: RohVerkauf = {
    id: 'v-maerz-1', product_id: 'p1', price: 2500, gumroad_fee: 250,
    created_at: '2026-03-10T12:00:00Z',
  };
  await gumroadVerkaeufeSpeichern([verkauf], 'USD');
  const vorErstattung = gumroadBerechnen().verlauf.find((z) => z.monat === '2026-03');
  pruef('vor der Erstattung: 25 $ brutto, 22,50 $ netto im März',
    vorErstattung && { bruttoCent: vorErstattung.bruttoCent, nettoCent: vorErstattung.nettoCent, anzahl: vorErstattung.anzahl },
    { bruttoCent: 2500, nettoCent: 2250, anzahl: 1 });

  /* Dieselbe Kennung, jetzt mit `refunded: true` — genau das, was ein
     erneuter Sync-Lauf Wochen später von Gumroad zurückbekäme. */
  await gumroadVerkaeufeSpeichern([{ ...verkauf, refunded: true }], 'USD');
  const nachErstattung = gumroadBerechnen().verlauf.find((z) => z.monat === '2026-03');
  pruef('nach der Erstattung: der MÄRZ-Wert ändert sich, nicht ein neuer Monat',
    nachErstattung && { bruttoCent: nachErstattung.bruttoCent, nettoCent: nachErstattung.nettoCent, anzahl: nachErstattung.anzahl },
    { bruttoCent: 0, nettoCent: 0, anzahl: 0 });
}

/* ── 2. Ein zweiter Abruf zählt nicht doppelt ──────────────────────── */
console.log(`\n  \x1b[1m2. Ein zweiter Abruf derselben Verkäufe zählt nicht doppelt\x1b[0m`);
{
  const drei: RohVerkauf[] = [
    { id: 'v-doppel-1', price: 1000, gumroad_fee: 100, created_at: '2026-04-01T00:00:00Z' },
    { id: 'v-doppel-2', price: 2000, gumroad_fee: 200, created_at: '2026-04-02T00:00:00Z' },
    { id: 'v-doppel-3', price: 3000, gumroad_fee: 300, created_at: '2026-04-03T00:00:00Z' },
  ];
  await gumroadVerkaeufeSpeichern(drei, 'USD');
  await gumroadVerkaeufeSpeichern(drei, 'USD'); // derselbe Abruf noch einmal
  const anzahlZeilen = db.get<{ n: number }>(
    "SELECT COUNT(*) as n FROM verkauf_gumroad_verkaeufe WHERE id LIKE 'v-doppel-%'",
  )?.n;
  pruef('drei Zeilen in der Datenbank, nicht sechs', anzahlZeilen, 3);
  const april = gumroadBerechnen().verlauf.find((z) => z.monat === '2026-04');
  pruef('Umsatz zählt jeden Verkauf genau einmal: 60 $ brutto', april?.bruttoCent, 6000);
}

/* ── 3. Rückbuchung — beide Schreibweisen ──────────────────────────── */
console.log(`\n  \x1b[1m3. Rückbuchung wird in beiden Schreibweisen erkannt\x1b[0m`);
{
  pruef('istRueckgebucht() erkennt `chargedback` (echtes Feld bei /v2/sales)', istRueckgebucht({ id: 'x', chargedback: true }), true);
  pruef('istRueckgebucht() erkennt `chargebacked` (echtes Feld bei /v2/licenses/*)', istRueckgebucht({ id: 'x', chargebacked: true }), true);
  pruef('istRueckgebucht() ist falsch ohne eines der beiden Felder', istRueckgebucht({ id: 'x' }), false);

  const verkaeufe: RohVerkauf[] = [
    { id: 'v-rb-sales', price: 2500, gumroad_fee: 250, created_at: '2026-05-01T00:00:00Z', chargedback: true },
    { id: 'v-rb-license', price: 2500, gumroad_fee: 250, created_at: '2026-05-02T00:00:00Z', chargebacked: true },
  ];
  await gumroadVerkaeufeSpeichern(verkaeufe, 'USD');
  const gespeichert = db.all<{ id: string; rueckgebucht: number }>(
    "SELECT id, rueckgebucht FROM verkauf_gumroad_verkaeufe WHERE id LIKE 'v-rb-%' ORDER BY id",
  );
  pruef('beide Zeilen tragen rueckgebucht=1 in der Datenbank',
    gespeichert, [{ id: 'v-rb-license', rueckgebucht: 1 }, { id: 'v-rb-sales', rueckgebucht: 1 }]);
  const u = gumroadBerechnen();
  pruef('beide zählen in der Übersicht als Rückbuchung, keine als Umsatz',
    { anzahl: u.rueckbuchungen.anzahl >= 2, imMai: u.verlauf.find((z) => z.monat === '2026-05')?.anzahl },
    { anzahl: true, imMai: 0 });
}

/* ── 4. Probezeit — auch am Tag des Ablaufs ────────────────────────── */
console.log(`\n  \x1b[1m4. Probezeit wird richtig gezählt, auch am Tag des Ablaufs\x1b[0m`);
{
  const jetzt = Date.parse('2026-06-15T12:00:00Z');
  const abonnenten: RohAbonnent[] = [
    // Läuft heute noch bis 18 Uhr — jetzt (12 Uhr) ist noch VOR dem Ablauf.
    { id: 'a-probe-laeuft', status: 'alive', recurrence: 'monthly', created_at: '2026-06-08T12:00:00Z', free_trial_ends_at: '2026-06-15T18:00:00Z' },
    // Ist heute Morgen schon abgelaufen — jetzt (12 Uhr) ist NACH dem Ablauf, am selben Kalendertag.
    { id: 'a-probe-heute-vorbei', status: 'alive', recurrence: 'monthly', created_at: '2026-06-08T06:00:00Z', free_trial_ends_at: '2026-06-15T06:00:00Z' },
    // Läuft exakt in diesem Moment ab — der Grenzfall selbst: NICHT mehr in Probe (">", nicht ">=").
    { id: 'a-probe-genau-jetzt', status: 'alive', recurrence: 'monthly', created_at: '2026-05-15T12:00:00Z', free_trial_ends_at: '2026-06-15T12:00:00Z' },
    // Schon länger zahlender Kunde, keine Probezeit.
    { id: 'a-zahlt-laengst', status: 'alive', recurrence: 'monthly', created_at: '2026-01-15T12:00:00Z' },
  ];
  await gumroadAbonnentenSpeichern(abonnenten);
  const u = gumroadBerechnen(jetzt);
  pruef('genau EIN Abonnent zählt als "in Probe" (der, dessen Frist heute noch läuft)', u.abonnenten.probe, 1);
  pruef('vier Abonnenten insgesamt aktiv, drei davon zahlend', { aktiv: u.abonnenten.aktiv, zahlend: u.abonnenten.zahlend }, { aktiv: 4, zahlend: 3 });

  /* Gegenprobe eine Sekunde später: derselbe Abonnent, dessen Frist gerade
     eben ablief, zählt jetzt nicht mehr — der Übergang passiert exakt an der
     Millisekunde, nicht erst am nächsten Kalendertag. */
  const einsSpaeter = gumroadBerechnen(jetzt + 1000);
  pruef('eine Sekunde nach 18 Uhr zählt "a-probe-laeuft" nicht mehr als Probe',
    gumroadBerechnen(Date.parse('2026-06-15T18:00:01Z')).abonnenten.probe, 0);
  void einsSpaeter;
}

/* ── 5. Der Wechselkurs eines alten Verkaufs bleibt stabil ─────────── */
console.log(`\n  \x1b[1m5. Der Wechselkurs eines alten Verkaufs bleibt stabil\x1b[0m`);
{
  const altesDatum = '2025-01-15';
  const heutigesDatum = '2026-08-22';
  db.run(
    `INSERT INTO wechselkurse (datum, basis, ziel, kurs, quelldatum, geholt_am) VALUES (?,?,?,?,?,?)`,
    altesDatum, 'USD', 'EUR', 0.9012, altesDatum, Date.now(),
  );
  db.run(
    `INSERT INTO wechselkurse (datum, basis, ziel, kurs, quelldatum, geholt_am) VALUES (?,?,?,?,?,?)`,
    heutigesDatum, 'USD', 'EUR', 0.8571, heutigesDatum, Date.now(),
  );

  /* `holen` wirft, wenn es aufgerufen wird — ein Treffer im Zwischenspeicher
     darf NIE einen Netzzugriff auslösen. Wirft die Funktion hier, ist der
     Test selbst kaputt (Cache-Treffer verfehlt), nicht das Netz. */
  const wirftBeiAufruf = async (): Promise<never> => { throw new Error('holen() wurde aufgerufen — kein Cache-Treffer!'); };

  const alterKurs = await kursFuerDatum(altesDatum, 'USD', 'EUR', wirftBeiAufruf);
  const heutigerKurs = await kursFuerDatum(heutigesDatum, 'USD', 'EUR', wirftBeiAufruf);
  pruef('der alte Kurs kommt unverändert aus dem Zwischenspeicher', alterKurs?.kurs, 0.9012);
  pruef('der heutige Kurs ist ein ANDERER — beide sind unabhängig', heutigerKurs?.kurs, 0.8571);

  /* Ende zu Ende: ein Verkauf vom alten Datum bekommt beim Ablegen genau
     diesen Kurs zugewiesen … */
  await gumroadVerkaeufeSpeichern(
    [{ id: 'v-alt-kurs', price: 2500, gumroad_fee: 250, created_at: `${altesDatum}T12:00:00Z` }], 'USD',
  );
  const zeileVorher = db.get<{ kurs_eur_je_usd: number }>(
    'SELECT kurs_eur_je_usd FROM verkauf_gumroad_verkaeufe WHERE id = ?', 'v-alt-kurs',
  );
  pruef('der Verkauf trägt den Kurs SEINES Tages', zeileVorher?.kurs_eur_je_usd, 0.9012);

  /* … und ändert sich nicht rückwirkend, wenn sich "heute" ein weiteres Mal
     ändert (simuliert: der EZB-Tageskurs von heute bewegt sich) und derselbe
     Verkauf ein zweites Mal gespeichert wird (ein ganz normaler Sync-Lauf). */
  db.run(
    `UPDATE wechselkurse SET kurs = 0.75 WHERE datum = ? AND basis = 'USD' AND ziel = 'EUR'`, heutigesDatum,
  );
  await gumroadVerkaeufeSpeichern(
    [{ id: 'v-alt-kurs', price: 2500, gumroad_fee: 250, created_at: `${altesDatum}T12:00:00Z` }], 'USD',
  );
  const zeileNachher = db.get<{ kurs_eur_je_usd: number }>(
    'SELECT kurs_eur_je_usd FROM verkauf_gumroad_verkaeufe WHERE id = ?', 'v-alt-kurs',
  );
  pruef('der gespeicherte Kurs des alten Verkaufs bleibt stehen, obwohl sich "heute" geändert hat',
    zeileNachher?.kurs_eur_je_usd, 0.9012);
}

/* ── Ergebnis ─────────────────────────────────────────────────────── */
console.log('');
if (!fehler) {
  console.log('  \x1b[32m✓ alle Fälle stimmen.\x1b[0m\n');
  process.exit(0);
}
console.log(`  \x1b[31m✗ ${fehler} Fall/Fälle stimmen nicht.\x1b[0m\n`);
process.exit(1);
