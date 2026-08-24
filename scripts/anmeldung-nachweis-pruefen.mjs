#!/usr/bin/env node
/**
 * Prüft die Anmeldung OHNE Passwort — und vor allem, dass die Anmeldung MIT
 * Passwort daneben unangetastet weiterläuft.
 *
 * DIE FRAGE DAHINTER
 *
 * Der Kontoschlüssel (lib/kontoschluessel.ts) leitet seine Hülle aus dem
 * PASSWORT ab. Solange `POST /api/auth/login` das Passwort im Klartext
 * bekam, war diese Hülle gegen den Server selbst wertlos — er hätte in
 * genau dem Augenblick mitschreiben und dieselbe Ableitung rechnen können.
 * Seither geht ein daraus abgeleiteter Nachweis über die Leitung statt des
 * Passworts.
 *
 * ZWEI TEILE, UND DER ZWEITE IST DER, DER DEN ERSTEN EHRLICH MACHT
 *
 *   TEIL 1 (packages/server/src/pruefungen/anmeldung-nachweis.mts, über
 *   tsx): die echten Routen auf einer wegwerfbaren Datenbank, über Fastifys
 *   inject() ohne je einen Port zu öffnen. Beide Anmeldewege, die Auskunft
 *   vor der Anmeldung, die Ratenbremse, der Kontoschlüssel über die
 *   Umstellung hinweg. Die Kryptografie rechnet er selbst nach, statt sie
 *   aus der App zu importieren — eine Prüfung, die ihren Maßstab aus dem
 *   geprüften Code bezieht, ist keine.
 *
 *   TEIL 2: genau deshalb reicht Teil 1 allein nicht. Er belegt, dass der
 *   SERVER die richtigen Antworten gibt — nicht, dass die ausgelieferte App
 *   das Passwort auch wirklich zu Hause lässt. Teil 2 lädt die ECHTE
 *   packages/desktop/src/lib/anmeldenachweis.ts zusammen mit der ECHTEN
 *   lib/kontoschluessel.ts in Node, hängt einen Server davor, der JEDEN
 *   Rumpf mitschreibt, und sieht nach, was tatsächlich hinausgegangen wäre.
 *
 * KEINE GEHEIMNISSE IN DER AUSGABE
 *
 * Jede Prüfung vergleicht Wahrheitswerte oder Zahlen. Kein Salz, kein
 * Nachweis, kein Abdruck und kein Passwort steht je in einer Zeile, die
 * dieser Lauf ausgibt — auch nicht gekürzt und auch nicht im Fehlerfall.
 *
 * Aufruf:  node scripts/anmeldung-nachweis-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fehlerGesamt = 0;

/* ── Teil 1: die echten Routen gegen eine wegwerfbare Datenbank ───────── */

console.log('\n\x1b[1mTeil 1 — Beide Anmeldewege, die Auskunft davor und der Kontoschlüssel darüber hinweg\x1b[0m');
{
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-anmeldung-nachweis-'));
  try {
    execFileSync('npx', ['tsx', 'src/pruefungen/anmeldung-nachweis.mts'], {
      cwd: path.join(wurzel, 'packages/server'),
      env: { ...process.env, DATA_DIR: ordner },
      stdio: 'inherit',
    });
  } catch {
    fehlerGesamt += 1;
  } finally {
    fs.rmSync(ordner, { recursive: true, force: true });
  }
}

/* ── Teil 2: lässt die AUSGELIEFERTE App das Passwort wirklich zu Hause? ── */

console.log('\n\x1b[1mTeil 2 — Was die ausgelieferte lib/anmeldenachweis.ts tatsächlich hinausschickt\x1b[0m');

const desktopPaket = path.join(wurzel, 'packages/desktop');
const ordner2 = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-anmeldung-client-'));
try {
  /* Dieselben vier Nachbarn mit Seiteneffekten auf Leerlauf wie in
     scripts/notiz-kontoschluessel-pruefen.mjs. lib/anmeldenachweis.ts,
     lib/kontoschluessel.ts und lib/vertraulich.ts bleiben ABSICHTLICH echt —
     genau ihre Rechnung ist der Gegenstand. */
  fs.writeFileSync(path.join(ordner2, 'benachrichtigung-stub.mjs'),
    `export const erlaubnisStand = () => 'default';
export function pushAbonnieren() {}
export function titelZaehler() {}
export function vapidSchluesselSetzen() {}
export function zeigen() {}
`);
  fs.writeFileSync(path.join(ordner2, 'kern-stub.mjs'),
    `export function translate(_l, key) { return key; }
export function spracheDesSystems() { return 'de'; }
export function dokumentSpracheSetzen() {}
`);
  fs.writeFileSync(path.join(ordner2, 'verkauf-stub.mjs'),
    `export const useVerkaufMeldungenUi = { getState: () => ({ zuruecksetzen() {} }), setState() {} };
`);
  /* Der Server dieses Teils. Er schreibt JEDEN Rumpf mit, den die App ihm
     gäbe — das ist der Kern der Prüfung: nicht was die App behauptet,
     sondern was über die Leitung ginge. `__LAGE__` stellt ein, wie er sich
     verhält (kennt er den neuen Weg? ist das Konto gesperrt? ist er ein
     alter Server, der die Adresse gar nicht hat?). */
  fs.writeFileSync(path.join(ordner2, 'api-stub.mjs'),
    `globalThis.__ABLAGE__ = null;          // der verwahrte Kontoschlüssel
globalThis.__NACHWEIS__ = null;         // der hinterlegte Anmeldenachweis
globalThis.__SALZ__ = null;             // was die Wegbeschreibung herausgibt
globalThis.__MITSCHRIFT__ = [];         // jeder Rumpf, der hinausginge
globalThis.__LAGE__ = { salzStatus: 0, nachweisStatus: 0 };

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
export const serverUrl = () => 'http://127.0.0.1:0';
export const wsUrl = () => 'ws://127.0.0.1:0';
export const token = () => null;
export const setToken = () => {};
export const dateiUrl = () => '';

const BENUTZER = { id: 'konto1', theme: 'dark', density: 'normal', uiLanguage: 'de' };

export const api = {
  /* ── Anmeldung ── */
  anmeldeSalz: async (login) => {
    globalThis.__MITSCHRIFT__.push({ weg: '/api/auth/anmeldesalz', rumpf: { login } });
    if (globalThis.__LAGE__.salzStatus) throw new ApiError('nein', globalThis.__LAGE__.salzStatus);
    return globalThis.__SALZ__;
  },
  loginMitNachweis: async (login, nachweis) => {
    globalThis.__MITSCHRIFT__.push({ weg: '/api/auth/login', rumpf: { login, nachweis } });
    if (globalThis.__LAGE__.nachweisStatus) throw new ApiError('nein', globalThis.__LAGE__.nachweisStatus);
    return { token: 'tok-neu', user: BENUTZER };
  },
  login: async (login, password) => {
    globalThis.__MITSCHRIFT__.push({ weg: '/api/auth/login', rumpf: { login, password } });
    return { token: 'tok-alt', user: BENUTZER };
  },
  anmeldeNachweisHinterlegen: async (blob) => {
    globalThis.__MITSCHRIFT__.push({ weg: '/api/auth/nachweis', rumpf: blob });
    globalThis.__NACHWEIS__ = blob;
    globalThis.__SALZ__ = { kdf: blob.kdf, salz: blob.salz, runden: blob.runden };
    return { ok: true };
  },
  /* ── Kontoschlüssel ── */
  kontoSchluessel: async () => ({ schluessel: globalThis.__ABLAGE__ }),
  kontoSchluesselHinterlegen: async (blob) => {
    globalThis.__MITSCHRIFT__.push({ weg: '/api/konto/schluessel', rumpf: blob });
    const alt = globalThis.__ABLAGE__;
    const derselbe = Boolean(alt && alt.abdruck === blob.abdruck);
    const fassung = derselbe ? alt.fassung : (alt?.fassung ?? 0) + 1;
    globalThis.__ABLAGE__ = { ...blob, fassung };
    return { fassung };
  },
  changePassword: async () => ({ ok: true }),
};
`);
  fs.writeFileSync(path.join(ordner2, 'loader-hook.mjs'),
    `/* Ohne Dateiendung verglichen und auf dem kurzen Ende — dieselbe
   Begründung wie in scripts/notiz-kontoschluessel-pruefen.mjs. */
const KARTE = {
  '/lib/benachrichtigung': new URL('./benachrichtigung-stub.mjs', import.meta.url).href,
  '/i18n/kern': new URL('./kern-stub.mjs', import.meta.url).href,
  '/verkaufMeldungen': new URL('./verkauf-stub.mjs', import.meta.url).href,
  '/net/api': new URL('./api-stub.mjs', import.meta.url).href,
};
export async function resolve(specifier, context, nextResolve) {
  const ohneEndung = specifier.replace(/\\.(ts|js|mts|mjs)$/, '');
  for (const [leiden, ziel] of Object.entries(KARTE)) {
    if (ohneEndung.endsWith(leiden)) return { url: ziel, shortCircuit: true };
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
`);
  fs.writeFileSync(path.join(ordner2, 'register-hook.mjs'),
    `import { register } from 'node:module';
register('./loader-hook.mjs', import.meta.url);
`);

  const alsPfad = (p) => JSON.stringify(`file://${path.join(desktopPaket, p).replace(/\\/g, '/')}`);

  const probe = `
const ablage = new Map();
globalThis.localStorage = {
  getItem: (k) => (ablage.has(k) ? ablage.get(k) : null),
  setItem: (k, v) => ablage.set(k, String(v)),
  removeItem: (k) => ablage.delete(k),
};
globalThis.window = globalThis;
globalThis.DEV = false;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.document = { addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {} } };
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = FakeWS.CONNECTING;
  send() {} close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
}
globalThis.WebSocket = FakeWS;

/* Dieselben Angaben wie in packages/shared/src/vertraulich.ts — hier
   ABSICHTLICH abgeschrieben statt importiert, aus denselben zwei Gründen
   wie in scripts/notiz-kontoschluessel-pruefen.mjs: diese Datei liegt
   außerhalb des Arbeitsbaums, und eine Nachrechnung, die ihren Maßstab aus
   der geprüften Quelle bezieht, ist keine. Wer eine dieser Zeichenketten
   ändert, macht jeden bestehenden Nachweis und jede bestehende Hülle
   unbrauchbar — das soll HIER stolpern. */
const ANMELDE_KDF = 'pbkdf2-sha256';
const ANMELDE_RUNDEN = 210_000;
const ANMELDE_NACHWEIS_KONTEXT = 'stellium/anmeldung/nachweis/v1';

/* store.ts und socket.ts zuerst und in DIESER Reihenfolge — dieselbe
   Kreisauflösung wie in scripts/notiz-kontoschluessel-pruefen.mjs. */
await import(${alsPfad('src/state/store.ts')});
await import(${alsPfad('src/net/socket.ts')});

const echt = await import(${alsPfad('src/lib/anmeldenachweis.ts')});
const konto = await import(${alsPfad('src/lib/kontoschluessel.ts')});

let fehler = 0;
const pruefWahr = (name, ist) => {
  if (!ist) fehler++;
  console.log(\`  \${ist ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\`);
};

const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (t) => new Uint8Array(Buffer.from(t, 'base64url'));
const sha256 = async (t) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t)));

/** Die unabhängige Nachrechnung des Nachweises. */
async function nachweisNachrechnen(passwort, salz, runden) {
  const roh = await crypto.subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256);
  const zwischen = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
  const fertig = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(ANMELDE_NACHWEIS_KONTEXT), info: enc.encode(ANMELDE_NACHWEIS_KONTEXT) },
    zwischen, 256,
  );
  return b64u(new Uint8Array(fertig));
}

const LOGIN = 'anna';
const PASSWORT = 'ein-langes-passwort-1';

/** Ging in irgendeinem mitgeschriebenen Rumpf das Passwort hinaus? */
const passwortGingRaus = () =>
  globalThis.__MITSCHRIFT__.some((e) => JSON.stringify(e.rumpf).includes(PASSWORT));
const frisch = () => { globalThis.__MITSCHRIFT__ = []; };

/* ── 1) Die erste Anmeldung auf einem frischen Gerät ─────────────── */
console.log('\\n1) Erste Anmeldung — es gibt noch keinen Nachweis');

pruefWahr('Ein frisches Gerät kennt den neuen Weg für diesen Namen noch nicht', !echt.nachweisBekannt(LOGIN));
frisch();
const ersteAnmeldung = await echt.anmelden(LOGIN, PASSWORT);
pruefWahr('Sie geht trotzdem durch — über den alten Weg', ersteAnmeldung.ueberNachweis === false && ersteAnmeldung.token === 'tok-alt');
pruefWahr('… und die Wegbeschreibung wurde dafür gar nicht erst abgefragt',
  !globalThis.__MITSCHRIFT__.some((e) => e.weg === '/api/auth/anmeldesalz'));
pruefWahr('EINMAL geht das Passwort dabei hinaus — ehrlich benannt, das ist der Preis der Umstellung', passwortGingRaus());

/* ── 2) Die Umstellung ───────────────────────────────────────────── */
console.log('\\n2) Die Umstellung, die danach von selbst geschieht');

frisch();
await echt.nachweisNachtragen(LOGIN, PASSWORT);
const hinterlegt = globalThis.__NACHWEIS__;
pruefWahr('Das Gerät hinterlegt einen Nachweis', Boolean(hinterlegt));
pruefWahr('… mit dem verabredeten Verfahren und der verabredeten Rundenzahl',
  hinterlegt.kdf === ANMELDE_KDF && hinterlegt.runden === ANMELDE_RUNDEN);
pruefWahr('… mit einem selbst gewürfelten Salz von 16 Byte', unb64u(hinterlegt.salz).length === 16);
pruefWahr('DABEI GEHT DAS PASSWORT NICHT MIT', !passwortGingRaus());
pruefWahr('… und der Nachweis ist nicht etwa das Passwort', hinterlegt.nachweis !== PASSWORT);
pruefWahr('DIE APP RECHNET DENSELBEN NACHWEIS WIE DIE NACHRECHNUNG',
  hinterlegt.nachweis === await nachweisNachrechnen(PASSWORT, unb64u(hinterlegt.salz), hinterlegt.runden));
pruefWahr('Ein anderes Passwort ergibt einen anderen Nachweis',
  hinterlegt.nachweis !== await nachweisNachrechnen('ein-ganz-anderes-passwort', unb64u(hinterlegt.salz), hinterlegt.runden));
pruefWahr('Das Gerät merkt sich, dass dieser Name den neuen Weg kann', echt.nachweisBekannt(LOGIN));

/* ── 3) Jede weitere Anmeldung ───────────────────────────────────── */
console.log('\\n3) Jede weitere Anmeldung');

frisch();
const zweiteAnmeldung = await echt.anmelden(LOGIN, PASSWORT).catch(() => null);
pruefWahr('Sie geht über den neuen Weg',
  zweiteAnmeldung !== null && zweiteAnmeldung.ueberNachweis === true && zweiteAnmeldung.token === 'tok-neu');
pruefWahr('DAS PASSWORT VERLÄSST DAS GERÄT NICHT MEHR — in KEINEM abgeschickten Rumpf', !passwortGingRaus());
pruefWahr('… und der alte Weg wurde gar nicht erst versucht',
  !globalThis.__MITSCHRIFT__.some((e) => e.rumpf.password !== undefined));
pruefWahr('Was hinausgeht, ist genau der hinterlegte Nachweis',
  globalThis.__MITSCHRIFT__.some((e) => e.weg === '/api/auth/login' && e.rumpf.nachweis === hinterlegt.nachweis));

/* ── 4) Das Auffangnetz — niemand darf ausgesperrt sein ──────────── */
console.log('\\n4) Was geschieht, wenn der neue Weg nicht trägt');

/* Über einen Fänger und nicht blank: bliebe das Auffangnetz aus, RISSE der
   durchgereichte Fehler den ganzen Lauf mit — und genau die Prüfung, um die
   es hier geht, käme nie zu ihrer Antwort. So sagt sie sauber Nein. */
const versuchen = async () => {
  try { return await echt.anmelden(LOGIN, PASSWORT); } catch { return null; }
};

frisch();
globalThis.__LAGE__ = { salzStatus: 0, nachweisStatus: 401 };
const trotzdem = await versuchen();
pruefWahr('Weist der Server den Nachweis ab, fällt die App auf den alten Weg zurück und kommt herein',
  trotzdem !== null && trotzdem.ueberNachweis === false && trotzdem.token === 'tok-alt');

frisch();
globalThis.__LAGE__ = { salzStatus: 404, nachweisStatus: 0 };
const gegenAltenServer = await versuchen();
pruefWahr('Auch gegen einen ALTEN Server, der die Wegbeschreibung gar nicht kennt, meldet sie sich an',
  gegenAltenServer !== null && gegenAltenServer.ueberNachweis === false && gegenAltenServer.token === 'tok-alt');

frisch();
globalThis.__LAGE__ = { salzStatus: 0, nachweisStatus: 403 };
let gesperrtDurchgereicht = false;
try { await echt.anmelden(LOGIN, PASSWORT); } catch { gesperrtDurchgereicht = true; }
pruefWahr('Bei einem GESPERRTEN Konto fällt sie NICHT zurück — ein zweiter Versuch gäbe dieselbe Antwort',
  gesperrtDurchgereicht);
pruefWahr('… und schickt deshalb auch kein Passwort hinterher', !passwortGingRaus());

frisch();
globalThis.__LAGE__ = { salzStatus: 0, nachweisStatus: 429 };
let gebremstDurchgereicht = false;
try { await echt.anmelden(LOGIN, PASSWORT); } catch { gebremstDurchgereicht = true; }
pruefWahr('Bei der Ratenbremse ebenso — ein zweiter Versuch fütterte sie nur weiter', gebremstDurchgereicht);
pruefWahr('… und auch hier geht kein Passwort hinaus', !passwortGingRaus());

globalThis.__LAGE__ = { salzStatus: 0, nachweisStatus: 0 };

/* ── 5) Der Kontoschlüssel bleibt derselbe ───────────────────────── */
console.log('\\n5) Der Kontoschlüssel über die Umstellung hinweg — echte Kryptografie');

const USER = 'konto1';
pruefWahr('Die App richtet einen Kontoschlüssel ein', await konto.kontoSchluesselEinrichten(USER, PASSWORT));
const fassungVorher = konto.kontoFassung();
const abdruckVorher = globalThis.__ABLAGE__.abdruck;
pruefWahr('… in Fassung 1', fassungVorher === 1);

/* Ein echter Notizschlüssel, VOR der Umstellung mit dem Kontoschlüssel
   verpackt. Was danach zählt, ist nicht ob zwei Zeichenketten gleich sind,
   sondern ob das hier wieder aufgeht. */
const notizKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const notizRoh = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', notizKey)));
const paketVorher = await konto.notizKontoPacken(notizKey, 'nz_probe', 1);

/* Die Umstellung — genau so, wie store.ts sie nach einer Anmeldung über den
   alten Weg auslöst. */
await echt.nachweisNachtragen(LOGIN, PASSWORT);

/* Und danach: eine Anmeldung über den NEUEN Weg, gefolgt von genau dem
   Aufruf, den store.ts danach macht — mit dem Klartextpasswort aus dem
   Anmeldefeld, das die App nach wie vor hat. */
const nachUmstellung = await versuchen();
pruefWahr('Die Anmeldung läuft jetzt über den Nachweis',
  nachUmstellung !== null && nachUmstellung.ueberNachweis === true);
pruefWahr('Der Kontoschlüssel lässt sich danach mit demselben Passwort wieder aufnehmen',
  await konto.kontoSchluesselEinrichten(USER, PASSWORT));
pruefWahr('DIE FASSUNG HAT SICH NICHT GEÄNDERT — kein Notiz-Kontopaket wurde weggeräumt',
  konto.kontoFassung() === fassungVorher);
pruefWahr('… und es ist derselbe Kontoschlüssel, nicht ein neu erzeugter',
  globalThis.__ABLAGE__.abdruck === abdruckVorher);

let notizZurueck = null;
try {
  const key = await konto.notizKontoAuspacken(paketVorher, 'nz_probe', 1);
  notizZurueck = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
} catch { /* bleibt null */ }
pruefWahr('EINE VOR DER UMSTELLUNG EINGEPACKTE NOTIZ GEHT DANACH AUF — derselbe Notizschlüssel',
  notizZurueck !== null && notizZurueck === notizRoh);

/* Die Gegenprobe, die den einen Fehler fängt, der alles kostete: gäbe
   jemand den NACHWEIS dorthin, wo das Passwort hingehört, entstünde ein
   NEUER Kontoschlüssel — und der Server räumte jedes Notizpaket weg. */
await konto.kontoSchluesselEinrichten(USER, globalThis.__NACHWEIS__.nachweis);
pruefWahr('Mit dem NACHWEIS statt des Passworts entstünde ein NEUER Kontoschlüssel — die beiden sind nicht dasselbe',
  globalThis.__ABLAGE__.abdruck !== abdruckVorher && konto.kontoFassung() === fassungVorher + 1);

console.log(fehler ? \`\\x1b[31m\${fehler} fehlgeschlagen\\x1b[0m\` : '\\x1b[32mok\\x1b[0m');
process.exit(fehler ? 1 : 0);
`;
  fs.writeFileSync(path.join(ordner2, 'probe.mts'), probe);

  try {
    execFileSync(
      'node',
      ['--import', path.join(ordner2, 'register-hook.mjs'), '--import', 'tsx', path.join(ordner2, 'probe.mts')],
      { cwd: desktopPaket, stdio: 'inherit' },
    );
  } catch {
    fehlerGesamt += 1;
  }
} finally {
  fs.rmSync(ordner2, { recursive: true, force: true });
}

console.log(fehlerGesamt
  ? `\n\x1b[31m${fehlerGesamt} Teil(e) fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDas Passwort bleibt beim Anmelden auf dem Gerät, der Kontoschlüssel überlebt die Umstellung unverändert — '
    + 'und der alte Weg mit blankem Passwort trägt daneben weiter jede Anmeldung.\x1b[0m\n');
process.exit(fehlerGesamt ? 1 : 0);
