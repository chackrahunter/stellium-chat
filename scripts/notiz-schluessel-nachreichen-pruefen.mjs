#!/usr/bin/env node
/**
 * Prüft den Fehlerbericht "Notiz bleibt für immer bei 'Wird entschlüsselt…'
 * stehen, obwohl sie 'mit 1 geteilt' ist" — Ende zu Ende, auf beiden Seiten
 * des Hauses.
 *
 * VORGESCHICHTE
 * notiz:pakete-fehlen (packages/desktop/src/lib/notizen.ts) beantwortete ein
 * fehlendes Schlüsselpaket nur, wenn der eigene Notizschlüssel gerade im
 * Speicher lag — und der füllt sich ausschließlich, während die Notizen-
 * Tafel offen ist (notiz:list löst je Notiz ein notiz:schluessel aus). Ein
 * Gerät, das zwar verbunden war, dessen Tafel aber seit dem Start nie offen
 * war, gab darum still auf: kein Log, keine Antwort, kein Fehler — die
 * anfragende Person wartete für immer. War die besitzende Person zum
 * Zeitpunkt des Anstoßes ganz offline, ging der Anstoß selbst schon
 * verloren (sendToUser trifft nur, wer GERADE verbunden ist).
 *
 * ZWEI TEILE DES FIXES, ZWEI PRÜFLÄUFE HIER
 *
 *   SERVER (packages/server/src/pruefungen/notiz-schluessel-nachreichen.mts,
 *   über tsx): `eigeneUnverpackteMitglieder()` — die besitzende Person findet
 *   beim eigenen Wiederverbinden (ws/gateway.ts, `ready()`) selbst heraus, ob
 *   einer ihrer Notizen noch ein Paket fehlt, statt nur auf einen fremden
 *   Anstoß zu warten, der ins Leere gelaufen sein könnte.
 *
 *   CLIENT (die drei Szenarien unten): notiz:pakete-fehlen lädt den eigenen
 *   Notizschlüssel bei Bedarf vom Server nach (eigenenNotizSchluesselNach-
 *   laden()), statt sich auf den In-Speicher-Stand zu verlassen — und ein
 *   Gerät, dem das trotzdem nicht gelingt, zeigt nach einer Frist eine
 *   erklärende Meldung (notizenSchluesselFehlt) statt eines endlosen
 *   Kreisels.
 *
 * Der Client-Teil läuft über echten, ungemockten Code aus lib/notizen.ts,
 * lib/vertraulich.ts, net/socket.ts und state/store.ts — nur die vier
 * Geschwisterdateien mit echten Seiteneffekten (Push-Berechtigung,
 * Sprachwörterbuch, Verkaufsmeldungen) sind auf Leerlauf-Stubs umgeleitet.
 * lib/vertraulich.ts bleibt bewusst ECHT: genau ihre ECDH-Rechnung ist Teil
 * dessen, was hier geprüft wird. Dieselbe Bauart (Node-ESM-Loader-Hook,
 * eigener Prozess je Szenario) wie scripts/nachricht-fehler-zuordnung-
 * pruefen.mjs — dort ausführlich begründet.
 *
 * Aufruf:  node scripts/notiz-schluessel-nachreichen-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fehlerGesamt = 0;

/* ── Teil 1: Server — eigeneUnverpackteMitglieder() ───────────────────── */

console.log('\n\x1b[1mServer: eigeneUnverpackteMitglieder()\x1b[0m');
{
  const dbOrdner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-notiz-nachreichen-server-'));
  try {
    execFileSync('npx', ['tsx', 'src/pruefungen/notiz-schluessel-nachreichen.mts'], {
      cwd: path.join(wurzel, 'packages/server'),
      env: { ...process.env, DATA_DIR: dbOrdner },
      stdio: 'inherit',
    });
  } catch {
    fehlerGesamt += 1;
  } finally {
    fs.rmSync(dbOrdner, { recursive: true, force: true });
  }
}

/* ── Teil 2: Client — notiz:pakete-fehlen / notizenSchluesselFehlt ────── */

console.log('\n\x1b[1mClient: notiz:pakete-fehlen und die sichtbare Fehlmeldung\x1b[0m');

const desktopPaket = path.join(wurzel, 'packages/desktop');
const storePfad = path.join(desktopPaket, 'src/state/store.ts');
if (!fs.existsSync(storePfad)) {
  console.error(`Nicht gefunden: ${storePfad}`);
  process.exit(1);
}

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-notiz-nachreichen-client-'));
try {
  // Leerlauf-Ersatz für drei Geschwisterdateien mit echten Seiteneffekten.
  // lib/vertraulich.ts bleibt ABSICHTLICH ungemockt — siehe Dateikopf.
  fs.writeFileSync(
    path.join(ordner, 'benachrichtigung-stub.mjs'),
    `export const erlaubnisStand = () => 'default';
export function pushAbonnieren() {}
export function titelZaehler() {}
export function vapidSchluesselSetzen() {}
export function zeigen() {}
`,
  );
  fs.writeFileSync(
    path.join(ordner, 'kern-stub.mjs'),
    `export function translate(_l, key) { return key; }
export function spracheDesSystems() { return 'de'; }
export function dokumentSpracheSetzen() {}
`,
  );
  fs.writeFileSync(
    path.join(ordner, 'verkauf-stub.mjs'),
    `export const useVerkaufMeldungenUi = { getState: () => ({ zuruecksetzen() {} }), setState() {} };
`,
  );

  fs.writeFileSync(
    path.join(ordner, 'loader-hook.mjs'),
    `const KARTE = {
  '/packages/desktop/src/lib/benachrichtigung.ts': new URL('./benachrichtigung-stub.mjs', import.meta.url).href,
  '/packages/desktop/src/i18n/kern.ts': new URL('./kern-stub.mjs', import.meta.url).href,
  '/packages/desktop/src/state/verkaufMeldungen.ts': new URL('./verkauf-stub.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  for (const [leiden, ziel] of Object.entries(KARTE)) {
    if (specifier.endsWith(leiden)) return { url: ziel, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.endsWith('/packages/desktop/src/state/store.ts')) {
    const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    return { ...result, source: src.replace('import.meta.env', 'globalThis') };
  }
  return result;
}
`,
  );
  fs.writeFileSync(
    path.join(ordner, 'register-hook.mjs'),
    `import { register } from 'node:module';
register('./loader-hook.mjs', import.meta.url);
`,
  );

  fs.writeFileSync(
    path.join(ordner, 'probe.mts'),
    `const szenario = process.env.SZENARIO;

globalThis.localStorage = {
  getItem: (k) => (k === 'stellium.token' ? 'faketoken' : null), setItem() {}, removeItem() {},
};
globalThis.window = globalThis;
globalThis.stellium = { setTheme() {}, setLanguage() {} };
globalThis.DEV = false;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.document = { addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {} } };

class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = FakeWS.CONNECTING;
  sent = [];
  constructor() { FakeWS.last = this; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
}
globalThis.WebSocket = FakeWS;

const { useStore } = await import(${JSON.stringify(pathToFileUrlLiteral(storePfad))});
const { socket } = await import(${JSON.stringify(pathToFileUrlLiteral(path.join(desktopPaket, 'src/net/socket.ts')))});
const vertraulich = await import(${JSON.stringify(pathToFileUrlLiteral(path.join(desktopPaket, 'src/lib/vertraulich.ts')))});
// lib/notizen.ts registriert seinen Ereignishörer beim Laden selbst — der
// Import allein genügt, es gibt nichts, das die Probe direkt aufruft außer
// über gesendete/empfangene Ereignisse.
await import(${JSON.stringify(pathToFileUrlLiteral(path.join(desktopPaket, 'src/lib/notizen.ts')))});

function verbinden(selfId) {
  socket.connect();
  const ws = FakeWS.last;
  ws.readyState = FakeWS.OPEN;
  ws.onopen?.();
  ws.onmessage({
    data: JSON.stringify({
      t: 'ready',
      self: { id: selfId, displayName: selfId, theme: 'dark', density: 'normal', uiLanguage: 'de' },
      ai: {},
      serverVersion: '0', serverUpdate: null,
      users: [], channels: [], states: [], scheduled: [], reminders: [], drafts: [],
    }),
  });
  return ws;
}

/**
 * schluesselBereitstellen() melden UND die Serverantwort darauf simulieren
 * — ws/gateway.ts (case 'vertraulich:schluessel-melden') schickt den EIGENEN
 * öffentlichen Teil als ganz normales vertraulich:schluessel zurück. Das ist
 * kein Nebenschauplatz: paketAuspacken() (lib/vertraulich.ts) schlägt für
 * JEDES Paket nach, wer es gepackt hat (\`fremdeSchluessel.get(paket.von)\`)
 * — auch für ein Paket, das man sich selbst gepackt hat. Ohne diese
 * Antwort bliebe fremdeSchluessel für die eigene Kennung leer, und JEDES
 * notiz:schluessel für eine selbst gepackte Notiz schlüge fehl — nicht,
 * weil der Fix hier lückenhaft wäre, sondern weil die Probe sonst eine
 * Startbedingung ausließe, die im echten Betrieb längst erledigt ist, bevor
 * die Notizen-Tafel je aufgeht.
 */
async function bereitstellenUndSelbstAntworten(ws, selfId) {
  await vertraulich.schluesselBereitstellen();
  const meinJwk = vertraulich.eigenerOeffentlicherSchluessel();
  ws.onmessage({ data: JSON.stringify({
    t: 'vertraulich:schluessel',
    schluessel: [{ userId: selfId, jwk: meinJwk, abdruck: 'x', erstelltAm: 0 }],
  }) });
  return meinJwk;
}

let fehler = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(\`  \${ok ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\${ok ? '' : \`  ist=\${JSON.stringify(ist)} soll=\${JSON.stringify(soll)}\`}\`);
};

const warten = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function wartenBis(pred, { tries = 300, delay = 20 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true;
    await warten(delay);
  }
  return pred();
}
function gesendet(ws, typ) {
  return ws.sent.map((s) => JSON.parse(s)).filter((ev) => ev.t === typ);
}

/* ── Dieselbe ECDH-Rechnung wie lib/vertraulich.ts, aber UNABHÄNGIG davon
   nachgebaut — für die Gegenseite ("mitglied1"), deren privater Schlüssel
   NIE durch den Code unter Prüfung läuft, und für den Rundweg-Beweis am
   Ende: dass das nachgereichte Paket wirklich den echten Notizschlüssel
   trägt, nicht nur, dass irgendein Ereignis verschickt wurde. ── */
const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
function b64u(bytes) { return Buffer.from(bytes).toString('base64url'); }
function unb64u(text) { return new Uint8Array(Buffer.from(text, 'base64url')); }
async function sha256(text) { return new Uint8Array(await subtle.digest('SHA-256', enc.encode(text))); }
async function oeffentlichEinlesen(jwkText) {
  return subtle.importKey('jwk', JSON.parse(jwkText), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}
async function gemeinsamerSchluesselExtern(eigenerPrivat, fremdesJwk, kontext) {
  const fremd = await oeffentlichEinlesen(fremdesJwk);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: fremd }, eigenerPrivat, 256);
  const roh = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode('stellium/vertraulich/paket/v1') },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
function notizKontext(notizId, fassung, von, fuer) { return \`stellium/notiz/\${notizId}/\${fassung}/\${von}>\${fuer}\`; }
async function paketAuspackenExtern(eigenerPrivat, absenderJwk, paket, kontext) {
  const huelle = await gemeinsamerSchluesselExtern(eigenerPrivat, absenderJwk, kontext);
  const roh = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten));
  return subtle.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
// Dieselbe Form wie nutzlastLesen() in packages/shared/src/vertraulich.ts
// ("e1:<fassung>:<iv>:<daten>") — hier unabhängig nachgebaut, weil ein
// direkter Import von '@stellium/shared' aus dieser generierten Probedatei
// (sie liegt außerhalb des Arbeitsbaums, in einem Temp-Ordner) nicht
// auflösbar wäre; store.ts/socket.ts/notizen.ts selbst importieren es ganz
// normal, weil SIE innerhalb von packages/desktop liegen.
function nutzlastLesenExtern(roh) {
  const teile = roh.split(':');
  if (teile.length !== 4 || teile[0] !== 'e1') return null;
  const fassung = Number(teile[1]);
  if (!Number.isInteger(fassung) || fassung < 1 || !teile[2] || !teile[3]) return null;
  return { fassung, iv: teile[2], daten: teile[3] };
}
async function inhaltEntschluesselnExtern(key, roh) {
  const nutzlast = nutzlastLesenExtern(roh);
  const klar = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(nutzlast.iv) }, key, unb64u(nutzlast.daten));
  return JSON.parse(dec.decode(klar));
}

if (szenario === 'nachverpackt-ohne-geoeffnet') {
  // DER FEHLERBERICHT: ein Gerät (owner1) hält den Notizschlüssel längst
  // beim Server (aus einer früheren Sitzung oder einem anderen Gerät
  // desselben Kontos), hat diese eine Notiz in DIESEM Prozess aber nie
  // geöffnet — notizSchluessel (lib/notizen.ts, modulprivat) ist für sie
  // also leer. Ein anderes Konto (mitglied1) fehlt ein Paket. Der Server
  // stößt owner1 an (notiz:pakete-fehlen) — vorher gab die Funktion hier
  // still auf.
  const ws = verbinden('owner1');
  const meinJwk = await bereitstellenUndSelbstAntworten(ws, 'owner1');

  const mitgliedPaar = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const mitgliedJwk = JSON.stringify(await subtle.exportKey('jwk', mitgliedPaar.publicKey));

  const notizId = 'nz_' + crypto.randomUUID().replace(/-/g, '');
  const notizKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const TITEL = 'Rückruf Meyer';
  const TEXT = 'Nur für owner1 und mitglied1 bestimmt — auch der Server soll es nie lesen.';
  const iv0 = crypto.getRandomValues(new Uint8Array(12));
  const daten0 = await subtle.encrypt({ name: 'AES-GCM', iv: iv0 }, notizKey, enc.encode(JSON.stringify({ titel: TITEL, text: TEXT })));
  const chiffrat = \`e1:1:\${b64u(iv0)}:\${b64u(new Uint8Array(daten0))}\`;

  // Das eigene Paket, wie es beim ursprünglichen Anlegen entstanden wäre —
  // mit den ECHTEN Funktionen aus lib/vertraulich.ts DIESES Prozesses
  // gepackt, damit der Code unter Prüfung es mit demselben privaten
  // Schlüssel wieder öffnen kann, den er schon hat.
  const eigenesPaket = await vertraulich.paketPacken(notizKey, meinJwk, notizKontext(notizId, 1, 'owner1', 'owner1'));

  ws.onmessage({ data: JSON.stringify({ t: 'notiz:pakete-fehlen', notizId, userId: 'mitglied1' }) });

  const listAngefragt = await wartenBis(() => gesendet(ws, 'notiz:list').length > 0);
  pruef('fragt beim Server die eigenen Notiz-Pakete an, statt still aufzugeben', listAngefragt, true);

  // Antwort spielen, wie notiz:list + paketeFuerAlle() es auf dem Server
  // täten (ws/gateway.ts, case 'notiz:list').
  ws.onmessage({ data: JSON.stringify({
    t: 'notiz:list',
    notizen: [{
      id: notizId, ownerId: 'owner1', chiffrat, version: 1, schluesselFassung: 1,
      memberIds: ['mitglied1'], ehemaligeMitglieder: [], geaendertVon: 'owner1', geaendertAm: 0, erstelltAm: 0,
    }],
  }) });
  ws.onmessage({ data: JSON.stringify({ t: 'notiz:schluessel', notizId, fassung: 1, paket: eigenesPaket }) });

  const schluesselHolen = await wartenBis(() => gesendet(ws, 'vertraulich:schluessel-holen').some((ev) => ev.userIds?.includes('mitglied1')));
  pruef('fragt den öffentlichen Teil von mitglied1 an', schluesselHolen, true);
  ws.onmessage({ data: JSON.stringify({
    t: 'vertraulich:schluessel',
    schluessel: [{ userId: 'mitglied1', jwk: mitgliedJwk, abdruck: 'x', erstelltAm: 0 }],
  }) });

  const nachreichenKam = await wartenBis(() => gesendet(ws, 'notiz:pakete-nachreichen').some((ev) => ev.notizId === notizId && ev.userId === 'mitglied1'));
  pruef('schickt notiz:pakete-nachreichen für mitglied1', nachreichenKam, true);

  const nachricht = gesendet(ws, 'notiz:pakete-nachreichen').find((ev) => ev.notizId === notizId && ev.userId === 'mitglied1');
  if (nachricht) {
    const zurueckgewonnen = await paketAuspackenExtern(mitgliedPaar.privateKey, meinJwk, nachricht.paket, notizKontext(notizId, 1, 'owner1', 'mitglied1'));
    const gelesen = await inhaltEntschluesselnExtern(zurueckgewonnen, chiffrat);
    pruef('mitglied1 gewinnt damit den ECHTEN Titel zurück (kryptografischer Rundweg, nicht nur ein Ereignis)', gelesen.titel, TITEL);
    pruef('… und den echten Text', gelesen.text, TEXT);
  } else {
    pruef('kryptografischer Rundweg (übersprungen — kein Paket kam an)', 'übersprungen', 'geprüft');
  }
} else if (szenario === 'kein-geraet-antwortet') {
  // Niemand antwortet je (kein notiz:schluessel, kein notiz:pakete-fehlen)
  // — die Oberfläche muss das nach einer Frist SICHTBAR machen, statt für
  // immer zu kreiseln. Stark verkürzte Frist, sonst müsste diese Probe 15
  // echte Sekunden lang stillstehen.
  globalThis.__NOTIZ_SCHLUESSEL_WARTEZEIT_MS__ = 80;
  const ws = verbinden('req1');
  const notizId = 'nz_' + crypto.randomUUID().replace(/-/g, '');
  ws.onmessage({ data: JSON.stringify({
    t: 'notiz:list',
    notizen: [{
      id: notizId, ownerId: 'jemand-anders', chiffrat: 'e1:9:AA:BB', version: 1, schluesselFassung: 9,
      memberIds: ['req1'], ehemaligeMitglieder: [], geaendertVon: 'jemand-anders', geaendertAm: 0, erstelltAm: 0,
    }],
  }) });

  await warten(15);
  pruef(
    'kurz nach dem Laden: Klartext fehlt, aber NOCH KEINE sichtbare Fehlermeldung (das ist der Normalfall kurz nach dem Öffnen)',
    { klartext: useStore.getState().notizenKlartext[notizId] ?? null, fehlt: useStore.getState().notizenSchluesselFehlt[notizId] ?? false },
    { klartext: null, fehlt: false },
  );

  const wurdeSichtbar = await wartenBis(() => useStore.getState().notizenSchluesselFehlt[notizId] === true, { tries: 60, delay: 20 });
  pruef('nach der Wartefrist steht sichtbar: kein Gerät hat geantwortet (notizenSchluesselFehlt)', wurdeSichtbar, true);
  pruef('der Klartext bleibt null — kein Rätselraten, kein erfundener Inhalt', useStore.getState().notizenKlartext[notizId] ?? null, null);
} else if (szenario === 'normalfall-schnell') {
  // Der Regelfall darf durch die neue Frist nicht anders aussehen als
  // vorher: kommt der Schlüssel rechtzeitig, entschlüsselt die Notiz sich
  // normal, und notizenSchluesselFehlt bleibt aus — auch wenn die (hier
  // verkürzte) Frist danach noch verstreicht.
  globalThis.__NOTIZ_SCHLUESSEL_WARTEZEIT_MS__ = 150;
  const ws = verbinden('owner2');
  const meinJwk = await bereitstellenUndSelbstAntworten(ws, 'owner2');

  const notizId = 'nz_' + crypto.randomUUID().replace(/-/g, '');
  const notizKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const TITEL = 'Alltag';
  const TEXT = 'Nichts Besonderes.';
  const iv0 = crypto.getRandomValues(new Uint8Array(12));
  const daten0 = await subtle.encrypt({ name: 'AES-GCM', iv: iv0 }, notizKey, enc.encode(JSON.stringify({ titel: TITEL, text: TEXT })));
  const chiffrat = \`e1:1:\${b64u(iv0)}:\${b64u(new Uint8Array(daten0))}\`;
  const eigenesPaket = await vertraulich.paketPacken(notizKey, meinJwk, notizKontext(notizId, 1, 'owner2', 'owner2'));

  ws.onmessage({ data: JSON.stringify({
    t: 'notiz:list',
    notizen: [{
      id: notizId, ownerId: 'owner2', chiffrat, version: 1, schluesselFassung: 1,
      memberIds: [], ehemaligeMitglieder: [], geaendertVon: 'owner2', geaendertAm: 0, erstelltAm: 0,
    }],
  }) });
  ws.onmessage({ data: JSON.stringify({ t: 'notiz:schluessel', notizId, fassung: 1, paket: eigenesPaket }) });

  const gelesen = await wartenBis(() => useStore.getState().notizenKlartext[notizId]?.titel === TITEL, { tries: 60, delay: 20 });
  pruef('die eigene Notiz entschlüsselt sich normal, ohne jeden Umweg', gelesen, true);
  pruef('… mit dem echten Text', useStore.getState().notizenKlartext[notizId]?.text, TEXT);

  await warten(300); // deutlich über der (verkürzten) Wartefrist
  pruef(
    'kein Fehlzustand, obwohl die Frist längst um ist — der Schlüssel kam ja rechtzeitig',
    useStore.getState().notizenSchluesselFehlt[notizId] ?? false,
    false,
  );
} else {
  throw new Error(\`unbekanntes Szenario: \${szenario}\`);
}

console.log(fehler ? \`\\x1b[31m\${fehler} fehlgeschlagen\\x1b[0m\` : '\\x1b[32mok\\x1b[0m');
process.exit(fehler ? 1 : 0);
`,
  );

  const SZENARIEN = ['nachverpackt-ohne-geoeffnet', 'kein-geraet-antwortet', 'normalfall-schnell'];

  for (const szenario of SZENARIEN) {
    console.log(`\nSzenario "${szenario}":`);
    try {
      execFileSync(
        'node',
        ['--import', path.join(ordner, 'register-hook.mjs'), '--import', 'tsx', path.join(ordner, 'probe.mts')],
        { cwd: desktopPaket, env: { ...process.env, SZENARIO: szenario }, stdio: 'inherit' },
      );
    } catch {
      fehlerGesamt += 1;
    }
  }
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}

console.log(fehlerGesamt
  ? `\n\x1b[31m${fehlerGesamt} Teil(e) fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDie besitzende Person antwortet auf notiz:pakete-fehlen, auch ohne die Notiz je geöffnet zu haben — und wo wirklich niemand antworten kann, sagt die Oberfläche das nach kurzer Frist deutlich, statt für immer zu kreiseln.\x1b[0m\n');
process.exit(fehlerGesamt ? 1 : 0);

/** file://-URL als Literal für die generierte Probedatei. */
function pathToFileUrlLiteral(p) {
  return `file://${p.replace(/\\/g, '/')}`;
}
