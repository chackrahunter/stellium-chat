/**
 * Stimmt die Abo-Rechnung?
 *
 * Auf der Konsole steht ein monatlich wiederkehrender Umsatz. Er entsteht aus
 * zwei Quellen, und beide können still danebenliegen:
 *
 *   · **ohne Gumroad-Token** aus der öffentlichen Mitgliederzahl mal dem
 *     Monatspreis. Das ist nur deshalb richtig, weil jede Laufzeit aufs Monat
 *     gerechnet dasselbe kostet — am 20.08.2026 auf der Seite nachgelesen und
 *     von Don bestätigt: $25 im Monat, $300 im Jahr, kein Rabatt. Führt
 *     jemand einen Jahresrabatt ein, ist die Annahme hin.
 *   · **mit Token** aus den wirklichen Abos, jede Laufzeit auf den Monat
 *     umgelegt. Dann hängt alles daran, welcher Zustand eines Abos noch Geld
 *     bringt und welcher nicht — gekündigt ist nicht gleich gekündigt, und
 *     wer in der Probewoche sitzt, zahlt noch gar nichts.
 *
 * Beides sind Zahlen, denen man nicht ansieht, dass sie falsch sind. Deshalb
 * dieser Lauf: erfundene Abo-Bestände mit von Hand nachrechenbaren
 * Ergebnissen. Jede Zeile hier lässt sich im Kopf prüfen.
 *
 *     node scripts/abo-rechnung-pruefen.mjs
 */
import {
  umsatzRechnen, abonnentenAuswerten, verkaeufeAuswerten, preiseEinheitlich, kaufquote,
} from '../server-setup/stellium-konsole.mjs';

const F = {
  aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m',
  gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', gelb: '\x1b[38;5;221m',
};

/* Die Preisliste, wie Gumroad sie am 20.08.2026 ausgeliefert hat. */
const PREISE = [
  { laufzeit: 'monthly', monate: 1, cent: 2500, jeMonatCent: 2500 },
  { laufzeit: 'quarterly', monate: 3, cent: 7500, jeMonatCent: 2500 },
  { laufzeit: 'biannually', monate: 6, cent: 15000, jeMonatCent: 2500 },
  { laufzeit: 'yearly', monate: 12, cent: 30000, jeMonatCent: 2500 },
  { laufzeit: 'every_two_years', monate: 24, cent: 60000, jeMonatCent: 2500 },
];

/* Dieselbe Liste, aber mit Jahresrabatt — so sähe sie aus, wenn die Annahme
   „alle Laufzeiten kosten monatlich gleich viel" eines Tages nicht mehr
   gilt. */
const PREISE_MIT_RABATT = PREISE.map((p) => (p.laufzeit === 'yearly'
  ? { ...p, cent: 24000, jeMonatCent: 2000 } : p));

const JETZT = Date.parse('2026-08-20T12:00:00Z');
const IN_DREI_TAGEN = new Date(JETZT + 3 * 86400000).toISOString();
const VOR_DREI_TAGEN = new Date(JETZT - 3 * 86400000).toISOString();

const abonnent = (id, recurrence, status = 'alive', mehr = {}) =>
  ({ id, recurrence, status, ...mehr });

/** Der Weg, den die Konsole mit Token geht: Abonnentenliste → Umsatz. */
function mitToken(abonnenten, verkaeufe = [], preise = PREISE) {
  const { preisJeAbo } = verkaeufeAuswerten(verkaeufe);
  const { zaehler, abos } = abonnentenAuswerten(abonnenten, preisJeAbo, JETZT);
  return { zaehler, umsatz: umsatzRechnen({ preise, waehrung: 'USD', abos, probe: true }) };
}

/** Der Weg ohne Token: nur die öffentliche Gesamtzahl. */
const ohneToken = (mitglieder, preise = PREISE) =>
  umsatzRechnen({ preise, waehrung: 'USD', mitglieder, probe: true, abos: null });

const euro = (cent) => (cent === null || cent === undefined ? '—' : `$${(cent / 100).toFixed(2)}`);

let fehler = 0;
let geprueft = 0;

function pruefe(name, ist, soll) {
  geprueft += 1;
  const gleich = JSON.stringify(ist) === JSON.stringify(soll);
  if (gleich) {
    console.log(`  ${F.gruen}✓${F.aus} ${name}`);
    console.log(`      ${F.grau}${JSON.stringify(soll)}${F.aus}`);
  } else {
    fehler += 1;
    console.log(`  ${F.rot}✗ ${name}${F.aus}`);
    console.log(`      ${F.grau}erwartet:${F.aus} ${JSON.stringify(soll)}`);
    console.log(`      ${F.rot}bekommen:${F.aus} ${JSON.stringify(ist)}`);
  }
}

console.log(`\n  ${F.fett}Abo-Rechnung${F.aus}  ${F.grau}— erfundene Bestände, nachrechenbare Ergebnisse${F.aus}\n`);

/* ── Ohne Token: Mitgliederzahl × Monatspreis ──────────────────── */
console.log(`  ${F.fett}Ohne Token — nur die öffentliche Mitgliederzahl${F.aus}`);

pruefe('0 Mitglieder sind 0 $, nicht „unbekannt"',
  (() => { const u = ohneToken(0); return { monatCent: u.monatCent, genau: u.genau }; })(),
  { monatCent: 0, genau: true });

pruefe('3 Mitglieder × 25 $ = 75 $',
  (() => { const u = ohneToken(3); return { monatCent: u.monatCent, genau: u.genau }; })(),
  { monatCent: 7500, genau: true });

pruefe('Mitgliederzahl unbekannt → gar keine Zahl statt einer Null',
  ohneToken(null), null);

pruefe('Jahresrabatt eingeführt → Zahl wird wieder als Schätzung gekennzeichnet',
  (() => {
    const u = ohneToken(4, PREISE_MIT_RABATT);
    return { genau: u.genau, vorbehalt: u.vorbehalt, spanneCent: u.spanneCent };
  })(),
  { genau: false, vorbehalt: 'laufzeiten-uneinheitlich', spanneCent: [8000, 10000] });

pruefe('Preisliste heute ist einheitlich', preiseEinheitlich(PREISE), true);
pruefe('Preisliste mit Rabatt ist es nicht', preiseEinheitlich(PREISE_MIT_RABATT), false);

/* ── Mit Token: die wirklichen Abos ────────────────────────────── */
console.log(`\n  ${F.fett}Mit Token — die wirklichen Abos${F.aus}`);

pruefe('Dons Beispiel: Monatsabo 25 $ + Jahresabo 120 $ = 35 $/Monat',
  (() => {
    const v = [{ subscription_id: 'a1', price: 2500, recurrence: 'monthly', gumroad_fee: 0 },
      { subscription_id: 'a2', price: 12000, recurrence: 'yearly', gumroad_fee: 0 }];
    const { umsatz } = mitToken([abonnent('a1', 'monthly'), abonnent('a2', 'yearly')], v);
    return umsatz.monatCent;
  })(), 3500);

pruefe('… der Monatszahler kündigt → 10 $/Monat bleiben',
  (() => {
    const v = [{ subscription_id: 'a2', price: 12000, recurrence: 'yearly', gumroad_fee: 0 }];
    const { umsatz } = mitToken([abonnent('a2', 'yearly')], v);
    return umsatz.monatCent;
  })(), 1000);

pruefe('Alle fünf Laufzeiten nebeneinander = 5 × 25 $ = 125 $',
  (() => {
    const { umsatz } = mitToken([
      abonnent('m', 'monthly'), abonnent('q', 'quarterly'), abonnent('h', 'biannually'),
      abonnent('j', 'yearly'), abonnent('z', 'every_two_years')]);
    return { monatCent: umsatz.monatCent, laufzeiten: umsatz.aufteilung.length };
  })(), { monatCent: 12500, laufzeiten: 5 });

pruefe('Gekündigt, läuft bis Periodenende → zählt weiter mit',
  (() => {
    const { zaehler, umsatz } = mitToken([abonnent('a', 'monthly', 'pending_cancellation')]);
    return { monatCent: umsatz.monatCent, aktiv: zaehler.aktiv, gekuendigt: zaehler.gekuendigt };
  })(), { monatCent: 2500, aktiv: 1, gekuendigt: 1 });

pruefe('Endgültig gekündigt → zählt nicht mehr',
  (() => {
    const { zaehler, umsatz } = mitToken([abonnent('a', 'monthly', 'cancelled')]);
    return { monatCent: umsatz.monatCent, aktiv: zaehler.aktiv, gekuendigt: zaehler.gekuendigt };
  })(), { monatCent: 0, aktiv: 0, gekuendigt: 1 });

pruefe('Kündigung mitten im Monat: einer läuft aus, einer bleibt → 25 $',
  (() => {
    const { umsatz } = mitToken([
      abonnent('bleibt', 'monthly'),
      abonnent('weg', 'monthly', 'cancelled', { cancelled_at: VOR_DREI_TAGEN })]);
    return umsatz.monatCent;
  })(), 2500);

pruefe('Probewoche läuft noch → zahlt nichts, wird getrennt gezählt',
  (() => {
    const { zaehler, umsatz } = mitToken([
      abonnent('zahlt', 'monthly'),
      abonnent('probe', 'monthly', 'alive', { free_trial_ends_at: IN_DREI_TAGEN })]);
    return { monatCent: umsatz.monatCent, inProbe: umsatz.inProbe, aktiv: zaehler.aktiv };
  })(), { monatCent: 2500, inProbe: 1, aktiv: 2 });

pruefe('Probewoche vorbei → zählt ab jetzt mit',
  (() => {
    const { umsatz } = mitToken([
      abonnent('a', 'monthly', 'alive', { free_trial_ends_at: VOR_DREI_TAGEN })]);
    return { monatCent: umsatz.monatCent, inProbe: umsatz.inProbe };
  })(), { monatCent: 2500, inProbe: 0 });

pruefe('Zahlung gescheitert → bringt kein Geld',
  (() => {
    const { zaehler, umsatz } = mitToken([abonnent('a', 'monthly', 'failed_payment')]);
    return { monatCent: umsatz.monatCent, gescheitert: zaehler.gescheitert };
  })(), { monatCent: 0, gescheitert: 1 });

pruefe('Altvertrag zu 19 $ zahlt weiter 19 $, nicht den heutigen Preis',
  (() => {
    const v = [{ subscription_id: 'alt', price: 1900, recurrence: 'monthly', gumroad_fee: 0 }];
    const { umsatz } = mitToken([abonnent('alt', 'monthly')], v);
    return umsatz.monatCent;
  })(), 1900);

pruefe('Abo ohne bekannten Zahlbetrag fällt auf die Preisliste zurück',
  (() => {
    const { umsatz } = mitToken([abonnent('unbekannt', 'quarterly')]);
    return umsatz.monatCent;
  })(), 2500);

pruefe('Gar keine Abos → 0 $, und zwar als Zahl',
  (() => { const { umsatz } = mitToken([]); return { monatCent: umsatz.monatCent, genau: umsatz.genau }; })(),
  { monatCent: 0, genau: true });

pruefe('Wirklich Käufer: Probeabos zählen nicht als zahlend',
  (() => {
    const { zaehler } = mitToken([
      abonnent('zahlt1', 'monthly'), abonnent('zahlt2', 'yearly'),
      abonnent('probe', 'monthly', 'alive', { free_trial_ends_at: IN_DREI_TAGEN })]);
    return { aktiv: zaehler.aktiv, zahlend: zaehler.zahlend, probe: zaehler.probe };
  })(), { aktiv: 3, zahlend: 2, probe: 1 });

/* ── Kaufquote ─────────────────────────────────────────────────── */
console.log(`\n  ${F.fett}Kaufquote — Käufer gegen Besucher${F.aus}`);

pruefe('Ohne Token: keine Quote, weil die Zeiträume nicht zusammenpassen',
  (() => {
    const k = kaufquote({ woche: { besucher: 2096, tage: 5 }, seit: '2026-08-16' },
      { mitglieder: 7, abonnenten: null, neuJeTag: null });
    return { quote: k.quote, vergleichbar: k.vergleichbar, grund: k.grund, probeEnthalten: k.probeEnthalten };
  })(), { quote: null, vergleichbar: false, grund: 'zeitraeume-verschieden', probeEnthalten: true });

pruefe('Mit Token: nur die Abos aus demselben Zeitraum, 4 von 200 = 2 %',
  (() => {
    const k = kaufquote({ woche: { besucher: 200, tage: 5 }, seit: '2026-08-16' }, {
      mitglieder: 40,
      abonnenten: { aktiv: 40, probe: 1, zahlend: 39, gekuendigt: 0, gescheitert: 0 },
      neuJeTag: { '2026-08-14': 36, '2026-08-17': 3, '2026-08-19': 1 },
    });
    return { imZeitraum: k.imZeitraum, quote: k.quote, vergleichbar: k.vergleichbar, zahlend: k.zahlend };
  })(), { imZeitraum: 4, quote: 0.02, vergleichbar: true, zahlend: 39 });

pruefe('Null Käufer bei Besuchern ist 0 %, kein Fehler',
  (() => {
    const k = kaufquote({ woche: { besucher: 2096, tage: 5 }, seit: '2026-08-16' },
      { mitglieder: 0, abonnenten: { aktiv: 0, probe: 0, zahlend: 0, gekuendigt: 0, gescheitert: 0 }, neuJeTag: {} });
    return { quote: k.quote, imZeitraum: k.imZeitraum, vergleichbar: k.vergleichbar };
  })(), { quote: 0, imZeitraum: 0, vergleichbar: true });

/* ── Einnahmen aus den Verkäufen ───────────────────────────────── */
console.log(`\n  ${F.fett}Einnahmen — was Gumroad wirklich abgerechnet hat${F.aus}`);

pruefe('Rückerstattung zählt nicht zu den Einnahmen',
  (() => {
    const v = verkaeufeAuswerten([
      { price: 2500, gumroad_fee: 250 },
      { price: 2500, gumroad_fee: 250, refunded: true }]);
    return { brutto: v.brutto, gebuehr: v.gebuehr, anzahl: v.anzahl };
  })(), { brutto: 2500, gebuehr: 250, anzahl: 1 });

pruefe('Rückbuchung und Anfechtung zählen ebenfalls nicht',
  (() => {
    const v = verkaeufeAuswerten([
      { price: 2500, gumroad_fee: 250 },
      { price: 2500, gumroad_fee: 250, chargebacked: true },
      { price: 2500, gumroad_fee: 250, disputed: true }]);
    return { brutto: v.brutto, anzahl: v.anzahl };
  })(), { brutto: 2500, anzahl: 1 });

/* Gumroad selbst ist hier uneinheitlich: `/v2/sales` (und damit alles, was
   verkaeufeAuswerten je zu sehen bekommt) nennt das Feld `chargedback`,
   nicht `chargebacked` — nachgelesen in der offiziellen Doku (archive.org,
   Snapshot 4.12.2025). `chargebacked` gehört zu `/v2/licenses/*`, einer
   Ressource, die hier nie ankommt. Dieser Fall bildet nach, was Gumroad
   wirklich schickt — der vorige Fall oben testet nur die (falsche)
   Schreibweise, die früher im Code stand, und wäre grün geblieben, selbst
   wenn die Prüfung auf `chargedback` gefehlt hätte. */
pruefe('Rückbuchung mit der Schreibweise, die /v2/sales wirklich benutzt',
  (() => {
    const v = verkaeufeAuswerten([
      { price: 2500, gumroad_fee: 250 },
      { price: 2500, gumroad_fee: 250, chargedback: true }]);
    return { brutto: v.brutto, anzahl: v.anzahl };
  })(), { brutto: 2500, anzahl: 1 });

pruefe('Gumroads Gebühr wird ausgewiesen, nicht verschluckt',
  (() => {
    const v = verkaeufeAuswerten([{ price: 30000, gumroad_fee: 3000 }]);
    return { brutto: v.brutto, gebuehr: v.gebuehr, netto: v.brutto - v.gebuehr };
  })(), { brutto: 30000, gebuehr: 3000, netto: 27000 });

pruefe('Ein zurückerstattetes Abo verrät trotzdem seinen Preis',
  (() => {
    const v = verkaeufeAuswerten([
      { subscription_id: 'a', price: 2500, recurrence: 'monthly', refunded: true }]);
    return v.preisJeAbo.get('a');
  })(), { cent: 2500, laufzeit: 'monthly' });

/* ── Ergebnis ──────────────────────────────────────────────────── */
console.log('');
if (!fehler) {
  console.log(`  ${F.gruen}✓${F.aus} ${geprueft} Fälle, alle stimmen.`);
  console.log(`  ${F.grau}Beleg für die Annahme „jede Laufzeit kostet monatlich 25 $":`);
  console.log(`  Gumroad, 20.08.2026 — ${PREISE.map((p) => `${p.laufzeit} ${euro(p.cent)}`).join(', ')}.${F.aus}\n`);
  process.exit(0);
}
console.log(`  ${F.rot}✗ ${fehler} von ${geprueft} Fällen stimmen nicht.${F.aus}`);
console.log(`  ${F.grau}Die Umsatzzahl auf der Konsole ist damit nicht zu trauen.${F.aus}\n`);
process.exit(1);
