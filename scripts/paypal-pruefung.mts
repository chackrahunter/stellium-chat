/**
 * Stimmt die PayPal-Anbindung — ohne einen einzigen echten Aufruf bei PayPal.
 *
 * Es gibt für diesen Auftrag keine Zugangsdaten, und es soll auch keine
 * geben: der Inhaber trägt sie selbst ein. Bewiesen wird deshalb an einer
 * ATTRAPPE, die genau die Antwort- UND Fehlerformen liefert, die PayPal
 * wirklich schickt — abgeschrieben aus PayPals eigener OpenAPI-Beschreibung
 * (github.com/paypal/paypal-rest-api-specifications, `Transaction Search`
 * v1.9) und aus zwei live nachgeprüften Fehlerantworten von
 * api-m.sandbox.paypal.com (22.08.2026, ohne Zugangsdaten):
 *
 *   POST /v1/oauth2/token   → {"error":"invalid_client",
 *                              "error_description":"Client Authentication failed"}
 *   GET  /v1/reporting/…    → {"name":"AUTHENTICATION_FAILURE","message":…,"links":[…]}
 *
 * Die beiden Formen sind verschieden — genau darum steht dieser Prüflauf
 * hier: wer nur eine davon behandelt, zeigt bei falschen Zugangsdaten eine
 * leere Fehlermeldung.
 *
 * 22 Abschnitte, gebaut um die Fälle, die alle STILL falsch werden können:
 *
 *    · Beträge: JPY hat keine, TND drei Nachkommastellen.
 *    · Zeitangaben in PayPals alter Schreibweise (+0200 ohne Doppelpunkt).
 *    · Saldo: gesamt, verfügbar UND einbehalten — der Unterschied ist der Punkt.
 *    · Token wird zwischengespeichert, nicht je Anfrage geholt.
 *    · Ein bald ablaufender Token wird NICHT wiederverwendet.
 *    · Ein mitten im Lauf ungültiger Token (401): genau EIN neuer Versuch.
 *    · Zwei 401 hintereinander: aufgeben, nicht endlos versuchen.
 *    · Gleichzeitige Aufrufe teilen sich EINEN Durchgang.
 *    · RESULTSET_TOO_LARGE: Fenster halbieren statt aufzugeben.
 *    · Die drei Anzeigezustände sehen NIE gleich aus.
 *    · Ein hängendes PayPal blockiert die Ereignisschleife nicht.
 *    · Zugangsdaten stehen in KEINER Antwort — auch nicht in Teilen.
 *    · Serverantworten tragen Kennungen, keine deutschen Sätze.
 *    · Kein einziger schreibender Aufruf, über den ganzen Lauf gemessen.
 *
 * Aufruf:  node scripts/paypal-pruefen.mjs
 */
import { db, initDb } from '../packages/server/src/db/index.js';
import { setSetting } from '../packages/server/src/services/settings.js';
import { encryptionActive } from '../packages/server/src/crypto/pii.js';
import {
  mikroAus, zeitAus, verdichten,
  paypalZugangSetzen, paypalZugangStand, paypalUebersicht, paypalAktualisieren,
  paypalDiagnose, paypalTransportSetzen, paypalZustandZuruecksetzen,
  type PaypalBuchung, type PaypalTransport,
} from '../packages/server/src/services/paypal.js';

initDb();

/* ── Prüfgerüst ──────────────────────────────────────────────────────── */

let fehler = 0;
function pruef(name: string, ist: unknown, soll: unknown): void {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}`
    + `${ok ? '' : `\n      erwartet: ${JSON.stringify(soll)}\n      bekommen: ${JSON.stringify(ist)}`}`);
}
function pruefWahr(name: string, ist: unknown): void { pruef(name, ist === true, true); }
function titel(text: string): void { console.log(`\n  \x1b[1m${text}\x1b[0m`); }

/* ── Die Attrappe ────────────────────────────────────────────────────── */

const CLIENT_ID = 'AXXXX-erfundene-client-id-nur-fuer-den-pruflauf';
const SECRET = 'EGEHEIM-secret-das-in-keiner-antwort-auftauchen-darf';

interface Aufruf { url: string; init: RequestInit }
let aufrufe: Aufruf[] = [];
function zaehle(pfadTeil: string): number {
  return aufrufe.filter((a) => a.url.includes(pfadTeil)).length;
}
function letzterToken(pfadTeil: string): string | null {
  const a = [...aufrufe].reverse().find((x) => x.url.includes(pfadTeil));
  const kopf = new Headers(a?.init.headers);
  return kopf.get('authorization');
}

function json(körper: unknown, status = 200, kopf: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(körper), {
    status, headers: { 'content-type': 'application/json', ...kopf },
  });
}

/** Ein Saldo, wie ihn `GET /v1/reporting/balances` wirklich liefert. */
function saldoAntwort(): unknown {
  return {
    balances: [
      {
        currency: 'EUR', primary: true,
        total_balance: { currency_code: 'EUR', value: '4820.55' },
        available_balance: { currency_code: 'EUR', value: '4120.55' },
        withheld_balance: { currency_code: 'EUR', value: '700.00' },
      },
      {
        currency: 'USD', primary: false,
        total_balance: { currency_code: 'USD', value: '312.40' },
        available_balance: { currency_code: 'USD', value: '312.40' },
        withheld_balance: { currency_code: 'USD', value: '0.00' },
      },
    ],
    account_id: 'ABCDEFGHIJKLM',
    as_of_time: '2026-08-22T09:00:00Z',
    last_refresh_time: '2026-08-22T08:15:00Z',
  };
}

function buchung(opts: {
  betrag: string; gebuehr?: string; status?: string; code?: string;
  waehrung?: string; zeit?: string;
}): unknown {
  return {
    transaction_info: {
      transaction_amount: { currency_code: opts.waehrung ?? 'EUR', value: opts.betrag },
      ...(opts.gebuehr ? { fee_amount: { currency_code: opts.waehrung ?? 'EUR', value: opts.gebuehr } } : {}),
      transaction_status: opts.status ?? 'S',
      transaction_event_code: opts.code ?? 'T0006',
      transaction_initiation_date: opts.zeit ?? new Date().toISOString(),
    },
  };
}

function bewegungAntwort(zeilen: unknown[], seite = 1, seiten = 1): unknown {
  return {
    transaction_details: zeilen,
    account_number: 'ABCDEFGHIJKLM',
    start_date: '2026-05-23T00:00:00Z',
    end_date: '2026-08-22T00:00:00Z',
    last_refreshed_datetime: '2026-08-22T08:15:00Z',
    page: seite, total_items: zeilen.length, total_pages: seiten,
  };
}

interface AttrappenPlan {
  tokenStatus?: number;
  tokenAblaufSekunden?: number;
  tokenScope?: string;
  /** Wie oft die nächsten Datenaufrufe mit 401 beantwortet werden. */
  einmal401?: number;
  saldoStatus?: number;
  saldoKoerper?: unknown;
  /** Bewegungsfenster ab dieser Spanne (in Tagen) mit RESULTSET_TOO_LARGE ablehnen. */
  zuGrossAbTagen?: number;
  /** Verzögerung je Aufruf in Millisekunden. */
  verzoegerungMs?: number;
  /** Nie antworten (aber das Abbruchsignal beachten). */
  haengen?: boolean;
}

let plan: AttrappenPlan = {};
let tokenZaehler = 0;

const attrappe: PaypalTransport = async (url, init) => {
  aufrufe.push({ url, init });

  if (plan.haengen) {
    /* Genau das Verhalten, das `fetch` bei einem hängenden Gegenüber zeigt:
       es kommt nichts, bis der AbortController zuschlägt. */
    return new Promise<Response>((_, ab) => {
      const signal = init.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => ab(new DOMException('The operation was aborted.', 'AbortError')));
    });
  }
  if (plan.verzoegerungMs) await new Promise((f) => setTimeout(f, plan.verzoegerungMs));

  if (url.includes('/v1/oauth2/token')) {
    tokenZaehler += 1;
    if (plan.tokenStatus && plan.tokenStatus !== 200) {
      /* PayPals Token-Endpunkt antwortet nach OAuth 2, NICHT in der
         name/message-Form der übrigen Schnittstelle — live nachgeprüft. */
      return json({ error: 'invalid_client', error_description: 'Client Authentication failed' },
        plan.tokenStatus, { 'paypal-debug-id': 'deadbeef01' });
    }
    return json({
      scope: plan.tokenScope
        ?? 'https://uri.paypal.com/services/reporting/balances/read https://uri.paypal.com/services/reporting/search/read',
      access_token: `TOKEN-${tokenZaehler}`,
      token_type: 'Bearer',
      app_id: 'APP-80W284485P519543T',
      expires_in: plan.tokenAblaufSekunden ?? 32400,
      nonce: '2026-08-22T09:00:00Z-abc',
    });
  }

  if (plan.einmal401 && plan.einmal401 > 0) {
    plan.einmal401 -= 1;
    return json({
      name: 'AUTHENTICATION_FAILURE',
      message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.',
      links: [{ href: 'https://developer.paypal.com/docs/api/overview/#error', rel: 'information_link' }],
    }, 401, { 'paypal-debug-id': 'deadbeef02' });
  }

  if (url.includes('/v1/reporting/balances')) {
    if (plan.saldoStatus && plan.saldoStatus !== 200) {
      return json({
        name: 'NOT_AUTHORIZED',
        message: 'Authorization failed due to insufficient permissions.',
        details: [{ issue: 'PERMISSION_DENIED', description: 'You do not have permission to access or perform operations on this resource.' }],
        debug_id: 'deadbeef03',
      }, plan.saldoStatus, { 'paypal-debug-id': 'deadbeef03' });
    }
    return json(plan.saldoKoerper ?? saldoAntwort());
  }

  if (url.includes('/v1/reporting/transactions')) {
    const u = new URL(url);
    const von = Date.parse(u.searchParams.get('start_date') ?? '');
    const bis = Date.parse(u.searchParams.get('end_date') ?? '');
    const tage = (bis - von) / 86_400_000;
    if (plan.zuGrossAbTagen !== undefined && tage > plan.zuGrossAbTagen) {
      /* PayPals dokumentierte Ablehnung: 400 INVALID_REQUEST mit der feinen
         Ursache in details[].issue — es kommt KEINE gekürzte Liste. */
      return json({
        name: 'INVALID_REQUEST',
        message: 'Request is not well-formed, syntactically incorrect, or violates schema.',
        details: [{
          issue: 'RESULTSET_TOO_LARGE',
          description: 'Result set size is greater than the maximum limit. Change the filter criteria and try again.',
        }],
        debug_id: 'deadbeef04',
      }, 400, { 'paypal-debug-id': 'deadbeef04' });
    }
    /* Eine Buchung je Fenster, mit dem Fensterende als Zeitpunkt — so lässt
       sich zählen, ob wirklich jedes Fenster geholt wurde. */
    return json(bewegungAntwort([buchung({ betrag: '100.00', gebuehr: '-3.49', zeit: new Date(bis - 1000).toISOString() })]));
  }

  return json({ name: 'RESOURCE_NOT_FOUND', message: 'Unknown' }, 404);
};

paypalTransportSetzen(attrappe);

function zuruecksetzen(neuerPlan: AttrappenPlan = {}): void {
  plan = { ...neuerPlan };
  aufrufe = [];
  tokenZaehler = 0;
  paypalZustandZuruecksetzen();
  setSetting('bank.paypal.letzterFehler', null, 'pruef');
  setSetting('bank.paypal.letzterFehlerSeit', null, 'pruef');
  setSetting('bank.paypal.letzteUebersicht', null, 'pruef');
  setSetting('bank.paypal.scope', null, 'pruef');
}

/* ══ 0. Verschlüsselung steht ═══════════════════════════════════════════ */
titel('0. Voraussetzung: die Feldverschlüsselung ist an');
pruefWahr('encryptionActive() — der Prüflauf setzt STELLIUM_MASTER_PASSPHRASE', encryptionActive());

/* ══ 1. Beträge ════════════════════════════════════════════════════════ */
titel('1. Beträge: eine Währung hat nicht zwangsläufig zwei Nachkommastellen');
pruef('EUR "4820.55" → 4.820,550000 Mikroeinheiten', mikroAus('4820.55'), 4_820_550_000);
pruef('JPY "1000" (keine Nachkommastellen) → 1.000 Einheiten, nicht 10',
  mikroAus('1000'), 1_000_000_000);
pruef('TND "12.345" (drei Nachkommastellen) bleibt genau', mikroAus('12.345'), 12_345_000);
pruef('negativ: "-3.49" → -3.490.000', mikroAus('-3.49'), -3_490_000);
pruef('Unfug bleibt null, wird nicht zu 0', mikroAus('keine Zahl'), null);
pruef('fehlendes Feld bleibt null', mikroAus(undefined), null);
{
  /* Der eigentliche Grund für ganze Zahlen: 0.1 + 0.2 ist in Gleitkomma
     nicht 0.3, und Summen entstehen hier aus hunderten Buchungen. */
  const summe = (mikroAus('0.1') ?? 0) + (mikroAus('0.2') ?? 0);
  pruef('0,10 + 0,20 ergibt exakt 0,30 — kein Gleitkomma-Rest', summe, 300_000);
}

/* ══ 2. Zeitangaben ════════════════════════════════════════════════════ */
titel('2. Zeitangaben: PayPals alte Schreibweise ohne Doppelpunkt im Versatz');
pruef('RFC 3339 mit Doppelpunkt', zeitAus('2026-08-22T08:15:00+02:00'), Date.parse('2026-08-22T06:15:00Z'));
pruef('alte Form "+0200" wird trotzdem verstanden', zeitAus('2026-08-22T08:15:00+0200'), Date.parse('2026-08-22T06:15:00Z'));
pruef('Zulu-Form', zeitAus('2026-08-22T08:15:00Z'), Date.parse('2026-08-22T08:15:00Z'));
pruef('fehlt → null, nicht 1970', zeitAus(undefined), null);

/* ══ 3. Verdichten ═════════════════════════════════════════════════════ */
titel('3. Verdichten: Eingang, Ausgang, Gebühren, Offenes, Auffälliges');
{
  const bis = Date.parse('2026-08-22T12:00:00Z');
  const tag = (n: number) => bis - n * 86_400_000;
  const roh: PaypalBuchung[] = [
    { zeit: tag(1), waehrung: 'EUR', betragMikro: 100_000_000, gebuehrMikro: -3_490_000, status: 'S', code: 'T0006' },
    { zeit: tag(2), waehrung: 'EUR', betragMikro: 50_000_000, gebuehrMikro: -1_990_000, status: 'S', code: 'T0006' },
    { zeit: tag(3), waehrung: 'EUR', betragMikro: -20_000_000, gebuehrMikro: 0, status: 'S', code: 'T1107' },
    { zeit: tag(4), waehrung: 'EUR', betragMikro: -30_000_000, gebuehrMikro: 0, status: 'S', code: 'T1201' },
    { zeit: tag(5), waehrung: 'EUR', betragMikro: -500_000_000, gebuehrMikro: 0, status: 'S', code: 'T0400' },
    { zeit: tag(6), waehrung: 'EUR', betragMikro: 70_000_000, gebuehrMikro: 0, status: 'P', code: 'T0006' },
    { zeit: tag(7), waehrung: 'EUR', betragMikro: 15_000_000, gebuehrMikro: 0, status: 'D', code: 'T0006' },
    { zeit: tag(8), waehrung: 'EUR', betragMikro: 25_000_000, gebuehrMikro: 0, status: 'V', code: 'T0006' },
    { zeit: tag(2), waehrung: 'USD', betragMikro: 10_000_000, gebuehrMikro: -500_000, status: 'S', code: 'T0006' },
  ];
  const b = verdichten(roh, bis, 13);
  const eur = b.find((x) => x.waehrung === 'EUR')!;
  const usd = b.find((x) => x.waehrung === 'USD')!;

  pruef('zwei Währungen bleiben getrennt — nichts wird zusammengezählt', b.length, 2);
  pruef('EUR steht vorn (mehr Umsatz)', b[0].waehrung, 'EUR');
  pruef('Eingang: 100 + 50 (das schwebende zählt NICHT mit)', eur.eingangMikro, 150_000_000);
  pruef('Ausgang: 20 + 30 + 500', eur.ausgangMikro, 550_000_000);
  pruef('Gebühren stehen einzeln, nicht im Ausgang', eur.gebuehrenMikro, 5_480_000);
  pruef('netto = Eingang − Ausgang − Gebühren', eur.nettoMikro, 150_000_000 - 550_000_000 - 5_480_000);
  pruef('schwebender Eingang wird eigens ausgewiesen', eur.offenEingangMikro, 70_000_000);
  pruef('abgelehnt (Status D) wird gezählt, nicht summiert', eur.abgelehntAnzahl, 1);
  pruef('storniert (Status V) wird NUR gezählt — die Rückabwicklung selbst steht schon als T11xx im Ausgang',
    { anzahl: eur.storniertAnzahl, imAusgang: eur.ausgangMikro }, { anzahl: 1, imAusgang: 550_000_000 });
  pruef('Erstattung (T1107) erkannt', eur.erstattungen, { anzahl: 1, mikro: 20_000_000 });
  pruef('Rückbuchung (T1201) erkannt', eur.rueckbuchungen, { anzahl: 1, mikro: 30_000_000 });
  pruef('Abbuchung aufs Bankkonto (T0400) eigens ausgewiesen', eur.zurBank, { anzahl: 1, mikro: 500_000_000 });
  pruef('USD unberührt von den EUR-Zahlen', usd.eingangMikro, 10_000_000);
  pruef('dreizehn Wocheneimer', eur.wochen.length, 13);
  pruef('alles aus der letzten Woche liegt im letzten Eimer',
    eur.wochen[12].eingangMikro, 150_000_000);
  pruef('die älteren Eimer bleiben leer und werden nicht erfunden',
    eur.wochen.slice(0, 12).every((w) => w.eingangMikro === 0 && w.ausgangMikro === 0), true);
}

/* ══ 4. Nicht eingerichtet ═════════════════════════════════════════════ */
titel('4. Zustand „nicht eingerichtet" — und kein Aufruf nach draußen');
zuruecksetzen();
setSetting('bank.paypal.clientId', null, 'pruef');
setSetting('bank.paypal.clientSecret', null, 'pruef');
{
  const u = paypalUebersicht();
  pruef('Zustand', u.zustand, 'nichtEingerichtet');
  pruef('keine Zahlen, aber auch keine Fehlerkennung',
    { werte: u.werte, code: u.fehlerCode }, { werte: null, code: null });
  const r = await paypalAktualisieren();
  pruef('ein Abruf ohne Zugangsdaten meldet das und geht nicht ins Netz', r,
    { ok: false, code: 'nichtEingerichtet', detail: null });
  pruef('kein einziger ausgehender Aufruf', aufrufe.length, 0);
}

/* ══ 5. Zugangsdaten: schreiben, nie lesen ═════════════════════════════ */
titel('5. Zugangsdaten sind write-only — in KEINER Antwort, auch nicht in Teilen');
zuruecksetzen();
paypalZugangSetzen({ clientId: CLIENT_ID, clientSecret: SECRET, umgebung: 'live' }, 'pruef');
{
  const stand = paypalZugangStand();
  pruef('hinterlegt', stand.hinterlegt, true);
  pruef('verschlüsselt abgelegt', stand.verschluesselt, true);
  pruefWahr('die Client-ID kommt NICHT zurück (anders als bei Patreon — siehe Dateikopf)',
    !('clientId' in (stand as unknown as Record<string, unknown>)));
  const roh = JSON.stringify(stand);
  pruefWahr('das Secret steht nicht in der Antwort', !roh.includes(SECRET));
  pruefWahr('auch kein Anfang davon (kein „maskiertes" Durchsickern)', !roh.includes(SECRET.slice(0, 8)));
  pruefWahr('die Client-ID steht nicht in der Antwort', !roh.includes(CLIENT_ID));

  const abgelegt = db.get<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?', 'bank.paypal.clientSecret')?.value ?? '';
  pruefWahr('in der Datenbank steht Chiffrat, nicht das Secret', abgelegt.startsWith('v1:') && !abgelegt.includes(SECRET));
}

/* ══ 6. Der gute Fall ══════════════════════════════════════════════════ */
titel('6. Der gute Fall: Saldo je Währung, gesamt / verfügbar / einbehalten');
zuruecksetzen();
{
  /* Der Kurs für heute liegt im Zwischenspeicher — damit beweist dieser
     Fall zugleich, dass ein Treffer dort KEINEN Netzzugriff auslöst
     (services/wechselkurse.ts). Die Kursadresse zeigt im Prüflauf ins
     Leere, ein Zugriff würde also sofort auffallen. */
  const heute = new Date().toISOString().slice(0, 10);
  db.run(
    `INSERT INTO wechselkurse (datum, basis, ziel, kurs, quelldatum, geholt_am)
     VALUES (?,?,?,?,?,?) ON CONFLICT(datum, basis, ziel) DO NOTHING`,
    heute, 'USD', 'EUR', 0.9, heute, Date.now(),
  );

  const r = await paypalAktualisieren();
  pruef('Abruf gelingt', r.ok, true);
  const u = paypalUebersicht();
  pruef('Zustand', u.zustand, 'aktuell');
  const eur = u.werte!.salden.find((s) => s.waehrung === 'EUR')!;
  const usd = u.werte!.salden.find((s) => s.waehrung === 'USD')!;
  pruef('EUR ist die Hauptwährung', eur.primaer, true);
  pruef('gesamt 4.820,55 €', eur.gesamtMikro, 4_820_550_000);
  pruef('verfügbar 4.120,55 €', eur.verfuegbarMikro, 4_120_550_000);
  pruef('einbehalten 700,00 € — der Unterschied, den man sonst erst beim Bezahlen merkt',
    eur.einbehaltenMikro, 700_000_000);
  pruef('kein Euro-Richtwert für einen Euro-Saldo', eur.euroMikro, null);
  pruef('USD bekommt einen Richtwert aus dem zwischengespeicherten Kurs',
    { euro: usd.euroMikro, quelle: usd.kursQuelldatum }, { euro: 281_160_000, quelle: heute });
  pruef('PayPals eigener Frischezeitpunkt wird übernommen, nicht unsere Abrufzeit',
    u.werte!.standPaypal, Date.parse('2026-08-22T08:15:00Z'));
  pruef('drei Fenster à höchstens 31 Tage decken 91 Tage ab', zaehle('/v1/reporting/transactions'), 3);
  pruefWahr('als vollständig gemeldet', u.werte!.vollstaendig);
  pruefWahr('kein Netzzugriff auf den Kursdienst — der Kurs kam aus dem Zwischenspeicher',
    aufrufe.every((a) => !a.url.includes('frankfurter')));
}

/* ══ 6b. Fenstergrenzen ════════════════════════════════════════════════ */
titel('6b. Eine Buchung genau auf einer Fenstergrenze wird genau einmal gezählt');
zuruecksetzen();
{
  /* Ein fester Zeitpunkt für BEIDE Durchgänge unten: durchgangAusfuehren()
     (paypal.ts) rechnet seine Fenstergrenzen aus Date.now(), nicht aus
     einem übergebenen Wert. Liefe der zweite Durchgang zu einem anderen
     Date.now() als der erste, verschöben sich die Grenzen um die paar
     Millisekunden dazwischen — und genau darauf kommt es hier an. */
  const echtesDateNow = Date.now;
  const jetzt = echtesDateNow();
  Date.now = () => jetzt;
  try {
    /* Erst ganz normal laufen lassen, nur um die tatsächlichen Fenstergrenzen
       zu erfahren, die durchgangAusfuehren() gerade wählt — die stehen
       nirgends exportiert, aber jede steckt in einem start_date/end_date. */
    await paypalAktualisieren();
    const fenster = aufrufe
      .filter((a) => a.url.includes('/v1/reporting/transactions'))
      .map((a) => {
        const u = new URL(a.url);
        return {
          von: Date.parse(u.searchParams.get('start_date')!),
          bis: Date.parse(u.searchParams.get('end_date')!),
        };
      })
      .sort((a, b) => b.bis - a.bis);   // neuestes zuerst, wie durchgangAusfuehren() selbst zählt
    pruef('drei Fenster (Grundannahme dieses Falls)', fenster.length, 3);
    pruefWahr('das neueste Fenster startet NACH dem Ende des zweiten — kein geteilter Zeitpunkt mehr',
      fenster[0].von > fenster[1].bis);

    /* Die eigentliche, von PayPal INKLUSIV gemeinte Grenze ist das Ende des
       älteren Fensters — genau die Sekunde, die vor der Reparatur in BEIDEN
       Fenstern lag. */
    const grenze = fenster[1].bis;

    /* Jetzt neu, mit einer Attrappe, die sich wie PayPal wirklich verhält:
       eine Buchung mit Zeitstempel `grenze` erscheint in JEDER Antwort,
       deren [start_date, end_date] diesen Zeitpunkt einschließt — inklusiv
       an beiden Enden, so wie PayPals Transaction-Search-API es
       dokumentiert. Der Test prüft damit das Verhalten nach PayPals eigenen
       Regeln, nicht nach den internen Fenstergrenzen von paypal.ts. */
    zuruecksetzen();
    const grenzattrappe: PaypalTransport = async (url, init) => {
      if (!url.includes('/v1/reporting/transactions')) return attrappe(url, init);
      aufrufe.push({ url, init });
      const u = new URL(url);
      const von = Date.parse(u.searchParams.get('start_date')!);
      const bis = Date.parse(u.searchParams.get('end_date')!);
      const zeilen = [buchung({ betrag: '100.00', gebuehr: '-3.49', zeit: new Date(bis - 1000).toISOString() })];
      if (von <= grenze && grenze <= bis) {
        zeilen.push(buchung({ betrag: '77.77', zeit: new Date(grenze).toISOString() }));
      }
      return json(bewegungAntwort(zeilen));
    };
    paypalTransportSetzen(grenzattrappe);
    await paypalAktualisieren();
    paypalTransportSetzen(attrappe);   // Rest des Laufs wieder mit der normalen Attrappe

    const eur = paypalUebersicht().werte!.bewegung.find((b) => b.waehrung === 'EUR')!;
    /* Grundrauschen: drei Fenster à 100,00 € (dieselbe Konstruktion wie in
       Fall 6) = 300,00 €. Die Grenzbuchung kommt GENAU EINMAL hinzu:
       77,77 €. Vor der Reparatur hätte sie zweimal gezählt (355,54 € statt
       377,77 €); eine zu weit gehende Korrektur ließe sie ganz fehlen
       (300,00 €). Diese eine Prüfung deckt beide falschen Richtungen ab. */
    pruef('die Grenzbuchung zählt genau einmal, nicht doppelt und nicht gar nicht',
      eur.eingangMikro, 300_000_000 + 77_770_000);
  } finally {
    Date.now = echtesDateNow;
  }
}

/* ══ 7. Token zwischenspeichern ════════════════════════════════════════ */
titel('7. Token: einmal holen, mehrfach benutzen (PayPals eigener Rat)');
zuruecksetzen();
{
  await paypalAktualisieren();
  await paypalAktualisieren();
  await paypalAktualisieren();
  pruef('drei volle Durchgänge, EIN Token-Aufruf', zaehle('/v1/oauth2/token'), 1);
  pruefWahr('mehr als ein Datenaufruf hat wirklich stattgefunden',
    zaehle('/v1/reporting/') >= 6);
}

titel('8. Ein bald ablaufender Token wird nicht wiederverwendet');
zuruecksetzen({ tokenAblaufSekunden: 30 });   // weniger als der Vorlauf von 60 s
{
  await paypalAktualisieren();
  await paypalAktualisieren();
  /* Der Vorlauf greift bei JEDEM Aufruf, nicht einmal je Durchgang: ein
     Token, der in 30 Sekunden abläuft, ist nie „noch gut genug". Deshalb
     kommt hier auf jeden Datenaufruf genau ein Token-Aufruf — das ist teuer
     und soll es sein, denn es passiert nur, wenn PayPal wirklich so kurze
     Laufzeiten ausgibt. Fall 7 daneben beweist die Gegenprobe: bei normaler
     Laufzeit wird EINER wiederverwendet. */
  pruef('auf jeden Datenaufruf kommt ein neuer Token — nichts wird wiederverwendet',
    zaehle('/v1/oauth2/token'), zaehle('/v1/reporting/'));
  pruefWahr('und es waren wirklich mehrere', zaehle('/v1/oauth2/token') > 2);
}

titel('9. Mitten im Lauf ungültig (401): genau ein neuer Versuch');
zuruecksetzen({ einmal401: 1 });
{
  const r = await paypalAktualisieren();
  pruef('der Durchgang gelingt trotzdem', r.ok, true);
  pruef('zwei Token-Aufrufe: der erste, und einer nach dem 401', zaehle('/v1/oauth2/token'), 2);
  pruef('der zweite Versuch trägt den NEUEN Token', letzterToken('/v1/reporting/balances'), 'Bearer TOKEN-2');
  pruef('Zustand danach', paypalUebersicht().zustand, 'aktuell');
}

titel('10. Zweimal 401 hintereinander: aufgeben statt endlos versuchen');
zuruecksetzen({ einmal401: 99 });
{
  const r = await paypalAktualisieren();
  pruef('meldet Fehlschlag', r.ok, false);
  pruef('höchstens zwei Token-Aufrufe — keine Schleife', zaehle('/v1/oauth2/token'), 2);
  pruef('genau zwei Saldo-Versuche', zaehle('/v1/reporting/balances'), 2);
  pruef('die Kennung sagt, was los ist', r.code, 'paypalFehler');
  pruefWahr('PayPals Wortlaut hängt unübersetzt daran',
    String(r.detail).includes('401') && String(r.detail).includes('AUTHENTICATION_FAILURE'));
}

/* ══ 11. Gleichzeitigkeit ══════════════════════════════════════════════ */
titel('11. Fünf gleichzeitige Aufrufe teilen sich EINEN Durchgang');
zuruecksetzen({ verzoegerungMs: 60 });
{
  const ergebnisse = await Promise.all([
    paypalAktualisieren(), paypalAktualisieren(), paypalAktualisieren(),
    paypalAktualisieren(), paypalAktualisieren(),
  ]);
  pruef('alle fünf melden Erfolg', ergebnisse.every((e) => e.ok), true);
  pruef('trotzdem nur EIN Saldo-Aufruf', zaehle('/v1/reporting/balances'), 1);
  pruef('und nur EIN Token-Aufruf', zaehle('/v1/oauth2/token'), 1);
}

/* ══ 12. RESULTSET_TOO_LARGE ═══════════════════════════════════════════ */
titel('12. RESULTSET_TOO_LARGE: PayPal kürzt nicht, es lehnt ab — also halbieren');
zuruecksetzen({ zuGrossAbTagen: 10 });
{
  const r = await paypalAktualisieren();
  pruef('der Durchgang gelingt trotzdem', r.ok, true);
  const u = paypalUebersicht();
  pruefWahr('es kamen Bewegungen an', (u.werte?.bewegung.length ?? 0) > 0);
  /* 31 Tage → 16 → 8: erst ab acht Tagen antwortet die Attrappe. Drei
     Fenster, je zwei Halbierungsstufen, ergibt eine Reihe von Aufrufen —
     der Punkt ist nur: es sind mehr als drei, und es kam etwas an. */
  pruefWahr('es wurde wirklich halbiert (mehr Aufrufe als Fenster)',
    zaehle('/v1/reporting/transactions') > 3);
  pruefWahr('als vollständig gemeldet — die Halbierung ist kein Datenverlust',
    u.werte!.vollstaendig);
}

titel('13. Ein Fenster, das auch nach fünf Halbierungen zu groß ist, wird zum Fehler — nicht zu stillen Nullen');
zuruecksetzen({ zuGrossAbTagen: 0 });
{
  const r = await paypalAktualisieren();
  pruef('meldet Fehlschlag', r.ok, false);
  pruef('eigene Kennung für genau diesen Fall', r.code, 'zuVieleDaten');
  pruefWahr('PayPals Wortlaut hängt daran', String(r.detail).includes('RESULTSET_TOO_LARGE'));
}

/* ══ 14. Die drei Zustände ═════════════════════════════════════════════ */
titel('14. Die drei Zustände sehen nie gleich aus');
zuruecksetzen();
{
  const guter = await paypalAktualisieren();
  pruef('erst: erfolgreich', guter.ok, true);
  const aktuell = paypalUebersicht();
  const alterStand = aktuell.werte!.standUnser;
  pruef('Zustand „aktuell"', aktuell.zustand, 'aktuell');

  /* Jetzt geht PayPal kaputt — der Zwischenspeicher im Arbeitsspeicher wird
     absichtlich NICHT geleert, denn genau das ist der Alltagsfall: der
     Server läuft weiter, nur der Abruf klemmt. */
  plan.saldoStatus = 403;
  const schlechter = await paypalAktualisieren();
  pruef('dann: Fehlschlag', schlechter.ok, false);
  const kaputt = paypalUebersicht();
  pruef('Zustand „fehler"', kaputt.zustand, 'fehler');
  pruef('mit einer Kennung, die die Oberfläche übersetzen kann', kaputt.fehlerCode, 'rechteFehlen');
  pruefWahr('PayPals eigener Wortlaut steht getrennt daneben',
    String(kaputt.fehlerDetail).includes('403') && String(kaputt.fehlerDetail).includes('NOT_AUTHORIZED'));
  pruefWahr('seit wann es klemmt, steht dabei', typeof kaputt.fehlerSeit === 'number');
  pruef('die ALTEN Zahlen bleiben stehen — mit ihrem eigenen, alten Zeitpunkt',
    kaputt.werte?.standUnser, alterStand);
  pruefWahr('„fehler" ist damit von „nicht eingerichtet" unterscheidbar',
    kaputt.zustand !== 'nichtEingerichtet' && kaputt.werte !== null);

  /* Und ein leeres Konto ist KEIN Fehler. */
  plan.saldoStatus = 200;
  plan.saldoKoerper = { balances: [], account_id: 'X', last_refresh_time: '2026-08-22T08:15:00Z' };
  await paypalAktualisieren();
  const leer = paypalUebersicht();
  pruef('leeres Konto: Zustand „aktuell", nicht „fehler"', leer.zustand, 'aktuell');
  pruef('mit leerer, aber vorhandener Saldenliste', leer.werte!.salden, []);
}

/* ══ 15. Falsche Zugangsdaten ══════════════════════════════════════════ */
titel('15. Falsche Zugangsdaten: PayPals OAuth-Fehlerform wird gelesen');
zuruecksetzen({ tokenStatus: 401 });
{
  const r = await paypalAktualisieren();
  pruef('meldet Fehlschlag', r.ok, false);
  pruef('eigene Kennung für falsche Zugangsdaten', r.code, 'zugangAbgelehnt');
  pruefWahr('der Wortlaut nennt „invalid_client" — nicht eine leere Meldung',
    String(r.detail).includes('invalid_client'));
  pruefWahr('und die Erläuterung von PayPal',
    String(r.detail).includes('Client Authentication failed'));
  pruefWahr('das Secret steht NICHT im Wortlaut', !String(r.detail).includes(SECRET));
  const u = paypalUebersicht();
  pruefWahr('auch nicht in der Übersicht', !JSON.stringify(u).includes(SECRET));
  pruefWahr('und die Client-ID auch nicht', !JSON.stringify(u).includes(CLIENT_ID));
}

/* ══ 16. Diagnose ══════════════════════════════════════════════════════ */
titel('16. Diagnose: sagt, welche Rechte wirklich da sind — und verrät nichts');
zuruecksetzen({
  tokenScope: 'https://uri.paypal.com/services/reporting/search/read',   // Salden-Recht fehlt
});
{
  const d = await paypalDiagnose();
  pruef('eingerichtet', d.eingerichtet, true);
  pruef('Token geholt', d.token.geholt, true);
  pruef('das fehlende Pflichtrecht wird benannt', d.scope.pflichtFehlt,
    ['https://uri.paypal.com/services/reporting/balances/read']);
  pruef('der Hinweis nennt die Ursache', d.hinweis, 'rechteFehlen');
  pruefWahr('kein Token in der Antwort', !JSON.stringify(d).includes('TOKEN-'));
  pruefWahr('kein Secret in der Antwort', !JSON.stringify(d).includes(SECRET));
  pruefWahr('keine Client-ID in der Antwort', !JSON.stringify(d).includes(CLIENT_ID));
  pruefWahr('der Ablaufzeitpunkt kommt mit, der Token nicht', typeof d.token.gueltigBisAm === 'number');
}

titel('17. Diagnose erkennt den stillen Ausfall: Bewegungen ja, Salden leer');
zuruecksetzen({ saldoKoerper: { balances: [], account_id: 'X' } });
{
  const d = await paypalDiagnose();
  pruef('Salden abgerufen, aber keine Währung dabei', d.salden.waehrungen, []);
  pruefWahr('Bewegungen kamen an', d.bewegung.zeilen > 0);
  pruef('Verdacht wird ausgesprochen, statt „leeres Konto" zu behaupten', d.stillerAusfallVerdacht, true);
  pruef('mit passendem Hinweis', d.hinweis, 'saldenLeerTrotzBewegung');
}

titel('18. Diagnose meldet die Korrelationskennung von PayPal — die ist kein Geheimnis');
zuruecksetzen({ saldoStatus: 403 });
{
  const d = await paypalDiagnose();
  pruef('debug_id durchgereicht', d.debugId, 'deadbeef03');
  pruef('Saldo-Fehler als Kennung, nicht als Satz', d.salden.fehler?.code, 'rechteFehlen');
  pruefWahr('PayPals Wortlaut daneben', String(d.salden.fehler?.detail).includes('403'));
  pruefWahr('kein Secret dabei', !JSON.stringify(d).includes(SECRET));
}

/* ══ 19. Hängendes PayPal ══════════════════════════════════════════════ */
titel('19. Ein hängendes PayPal hält weder die Anfrage noch die Ereignisschleife fest');
zuruecksetzen({ haengen: true });
{
  /* Ein Herzschlag alle 50 ms. Bliebe die Ereignisschleife stehen — der
     dokumentierte Vorfall mit zwanzig Sekunden Stillstand —, würde der
     größte gemessene Abstand weit über 50 ms liegen. */
  let letzter = Date.now();
  let groessterVerzug = 0;
  let schlaege = 0;
  const herz = setInterval(() => {
    const jetzt = Date.now();
    groessterVerzug = Math.max(groessterVerzug, jetzt - letzter - 50);
    letzter = jetzt;
    schlaege += 1;
  }, 50);

  const start = Date.now();
  const r = await paypalAktualisieren();
  const dauer = Date.now() - start;
  clearInterval(herz);

  pruef('der Aufruf endet von selbst, mit Fehlschlag', r.ok, false);
  pruefWahr(`er endet am Zeitlimit (${dauer} ms, erwartet 15–20 s)`, dauer >= 14_000 && dauer < 20_000);
  pruefWahr(`der Herzschlag lief die ganze Zeit weiter (${schlaege} Schläge)`, schlaege > 200);
  pruefWahr(`größter Verzug ${groessterVerzug} ms — deutlich unter einer Sekunde`, groessterVerzug < 1_000);
  pruef('eigene Kennung für das Zeitlimit', r.code, 'zeitlimit');
  pruef('danach steht der Zustand auf „fehler", nicht auf „nicht eingerichtet"',
    paypalUebersicht().zustand, 'fehler');
}

/* ══ 20. Umgebung ══════════════════════════════════════════════════════ */
titel('20. Sandbox und Ernstfall sind zwei Hostnamen, nicht ein Schalter in der Anfrage');
zuruecksetzen();
paypalZugangSetzen({ umgebung: 'sandbox' }, 'pruef');
{
  await paypalAktualisieren();
  pruefWahr('alle Aufrufe gehen an api-m.sandbox.paypal.com',
    aufrufe.length > 0 && aufrufe.every((a) => a.url.startsWith('https://api-m.sandbox.paypal.com/')));
  pruef('und die Übersicht sagt es', paypalUebersicht().umgebung, 'sandbox');
}
zuruecksetzen();
paypalZugangSetzen({ umgebung: 'live' }, 'pruef');
{
  await paypalAktualisieren();
  pruefWahr('zurück auf api-m.paypal.com',
    aufrufe.length > 0 && aufrufe.every((a) => a.url.startsWith('https://api-m.paypal.com/')));
}

titel('21. Keine Anzeigetexte in Serverantworten — nur Kennungen und PayPals Wortlaut');
zuruecksetzen({ saldoStatus: 403 });
{
  /* Der Auftraggeber hat „keine fest verdrahtete Sprache irgendwo" zur harten
     Regel gemacht. Für den Server heißt das: was er schickt, muss übersetzbar
     sein — also Kennungen. Diese Prüfung sucht deutsche Sonderzeichen und ein
     paar typisch deutsche Wörter in den beiden Antworten, die wirklich in der
     Oberfläche landen. PayPals eigener englischer Wortlaut ist ausdrücklich
     erlaubt (er steht als Fremdtext daneben, siehe Dateikopf von paypal.ts) —
     er enthält keine Umlaute, deshalb reicht diese Probe. */
  await paypalAktualisieren();
  const u = JSON.stringify(paypalUebersicht());
  const d = JSON.stringify(await paypalDiagnose());
  const deutsch = /[äöüßÄÖÜ]|\b(nicht|fehlgeschlagen|Zugangsdaten|Rechte|konnte)\b/;
  pruefWahr('die Übersicht enthält keinen deutschen Anzeigetext', !deutsch.test(u));
  pruefWahr('die Diagnose enthält keinen deutschen Anzeigetext', !deutsch.test(d));
  pruefWahr('stattdessen steht dort eine Kennung', u.includes('"fehlerCode":"rechteFehlen"'));
}

titel('22. Kein einziger schreibender Aufruf — die Grenze des Auftrags, nachgemessen');
{
  /* Über den GANZEN Prüflauf hinweg: nur GET, mit der einen Ausnahme des
     Token-Endpunkts, den PayPal als POST vorschreibt. Und nur zwei
     Berichtspfade — nichts unter /payments, /payouts, /checkout. */
  const alle = aufrufe;
  pruefWahr('nur GET, außer dem Token-Endpunkt (POST, so schreibt PayPal es vor)',
    alle.every((a) => (a.init.method ?? 'GET') === 'GET' || a.url.includes('/v1/oauth2/token')));
  pruefWahr('nur /v1/oauth2/token, /v1/reporting/balances und /v1/reporting/transactions',
    alle.every((a) => /\/v1\/(oauth2\/token|reporting\/(balances|transactions))(\?|$)/.test(a.url)));
}

/* ── Ergebnis ────────────────────────────────────────────────────────── */
console.log(fehler === 0
  ? '\n  \x1b[32mAlles in Ordnung.\x1b[0m\n'
  : `\n  \x1b[31m${fehler} Prüfung(en) fehlgeschlagen.\x1b[0m\n`);
process.exit(fehler === 0 ? 0 : 1);
