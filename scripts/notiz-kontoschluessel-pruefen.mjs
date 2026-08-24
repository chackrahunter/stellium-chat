#!/usr/bin/env node
/**
 * Prüft den Kontoschlüssel — den Weg, auf dem sich eine Notiz auf JEDEM
 * Gerät desselben Kontos öffnen lässt, allein über das Passwort.
 *
 * ZWEI TEILE, UND DER ZWEITE IST DER, DER DEN ERSTEN EHRLICH MACHT
 *
 *   TEIL 1 (packages/server/src/pruefungen/notiz-kontoschluessel.mts, über
 *   tsx): der ganze Weg vom Anlegen bis zum Passwortwechsel, gegen eine
 *   wegwerfbare Datenbank. Er rechnet die Kryptografie der App NACH — eigene
 *   Fassung, damit eine Prüfung nicht den geprüften Code als Maßstab
 *   benutzt. Der eigene Ordner ist dabei kein Schmuck: der Lauf liest die
 *   rohe Datenbankdatei byteweise aus und setzt ein Passwort zurück, und
 *   nichts davon darf je die echte Datenbank berühren (dieselbe Bauart wie
 *   scripts/notizen-verschluesselung-pruefen.mjs).
 *
 *   TEIL 2: genau deshalb reicht Teil 1 allein nicht. Er belegt, dass der
 *   ENTWURF trägt — nicht, dass der ausgelieferte Code ihn auch so rechnet.
 *   Deshalb lädt Teil 2 die ECHTE packages/desktop/src/lib/kontoschluessel.ts
 *   in Node (ungemockt, nur ihre Nachbarn mit Seiteneffekten sind auf
 *   Leerlauf umgeleitet) und prüft in beide Richtungen: was die App
 *   verschließt, macht die Nachrechnung auf — und umgekehrt. Weicht eine
 *   Ziffer ab, fällt es hier auf und nicht auf einem Telefon.
 *
 * Aufruf:  node scripts/notiz-kontoschluessel-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fehlerGesamt = 0;

/* ── Teil 1: Server, Datenbank und der ganze Weg ──────────────────────── */

console.log('\n\x1b[1mTeil 1 — Kontoschlüssel, Notizpakete, Passwortwechsel (gegen eine wegwerfbare Datenbank)\x1b[0m');
{
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-notiz-kontoschluessel-'));
  try {
    execFileSync('npx', ['tsx', 'src/pruefungen/notiz-kontoschluessel.mts'], {
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

/* ── Teil 2: rechnet die ECHTE App dasselbe? ──────────────────────────── */

console.log('\n\x1b[1mTeil 2 — Die ausgelieferte lib/kontoschluessel.ts gegen dieselbe Rechnung\x1b[0m');

const desktopPaket = path.join(wurzel, 'packages/desktop');
const ordner2 = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-kontoschluessel-client-'));
try {
  // Vier Nachbarn mit echten Seiteneffekten auf Leerlauf. lib/kontoschluessel.ts
  // selbst und lib/vertraulich.ts (liefert b64u/unb64u) bleiben ABSICHTLICH
  // echt — genau ihre Rechnung ist das, was hier geprüft wird.
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
  // Der Server dieses Teils: er merkt sich, was die App hinterlegen WILL,
  // und gibt es beim nächsten Abruf zurück. Mehr braucht der Kontoweg nicht.
  fs.writeFileSync(path.join(ordner2, 'api-stub.mjs'),
    `globalThis.__ABLAGE__ = null;
/* Die übrigen Ausfuhren stehen hier nur, weil store.ts, socket.ts,
   vertraulich.ts und verkaufMeldungen.ts sie beim Laden namentlich
   erwarten — gerufen wird in dieser Probe keine davon. */
export class ApiError extends Error {}
export const serverUrl = () => 'http://127.0.0.1:0';
export const wsUrl = () => 'ws://127.0.0.1:0';
export const token = () => null;
export const setToken = () => {};
export const dateiUrl = () => '';
// Modelliert dieselbe Abdruck-Entscheidung wie hinterlegenInTransaktion() in
// services/kontoschluessel.ts (dort ~Zeile 126-127): DERSELBE Abdruck bleibt
// bei der bisherigen Fassung stehen (Umschliessen, PASSWORT wechselt, der
// Kontoschlüssel nicht), ein ANDERER zählt hoch (Ersatz, jedes bestehende
// Notiz-Kontopaket fiele weg). Vorher zählte dieser Stub bei JEDEM Aufruf
// blind hoch, egal ob sich der Schlüssel überhaupt geändert hatte -- eine
// Probe, die auf dieser Zahl aufbaut, hätte damit nie gemerkt, wenn die App
// an einer Stelle einen frischen Schlüssel mintet, wo sie den bestehenden
// nur neu hätte einpacken sollen (services/kontoschluessel.ts, Dateikopf:
// "schlimmer als eine ehrliche Lücke").
function hinterlegen(blob) {
  const vorherige = globalThis.__ABLAGE__;
  const derselbe = Boolean(vorherige && vorherige.abdruck === blob.abdruck);
  const fassung = derselbe ? vorherige.fassung : (vorherige?.fassung ?? 0) + 1;
  globalThis.__ABLAGE__ = { ...blob, fassung };
  return { fassung };
}
export const api = {
  kontoSchluessel: async () => ({ schluessel: globalThis.__ABLAGE__ }),
  kontoSchluesselHinterlegen: async (blob) => hinterlegen(blob),
  // Der echte Server ruft beim Passwortwechsel intern dieselbe
  // Hinterlegen-Rechnung auf, wenn ein Kontoschlüssel mitkommt (services/
  // users.ts, changeOwnPassword()) -- dieser Stub tat das bisher nicht,
  // sondern ignorierte den mitgeschickten Schlüssel vollständig.
  changePassword: async (_altes, _neues, blob) => {
    if (blob) hinterlegen(blob);
    return { ok: true };
  },
};
`);
  fs.writeFileSync(path.join(ordner2, 'loader-hook.mjs'),
    `/* Ohne Dateiendung verglichen und auf dem kurzen Ende: je nach Reihenfolge
   der angemeldeten Haken sieht dieser Haken mal den rohen Ausdruck aus der
   import-Zeile ('../net/api.js'), mal die schon aufgelöste Datei-URL
   ('…/src/net/api.ts'). Beide enden auf 'net/api'. */
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

/* Dieselben drei Angaben wie in packages/shared/src/vertraulich.ts — hier
   ABSICHTLICH abgeschrieben statt importiert, aus zwei Gründen. Erstens
   liegt diese Probendatei außerhalb des Arbeitsbaums (Temp-Ordner), ein
   blanker Paketname wäre von dort gar nicht auflösbar; die geprüfte Datei
   selbst importiert ihn ganz normal, weil SIE in packages/desktop liegt.
   Zweitens — und wichtiger — ist eine Nachrechnung, die ihren Maßstab aus
   der geprüften Quelle bezieht, keine. Wer einen dieser Kontexte ändert,
   soll HIER stolpern: eine geänderte Zeichenkette macht jede bestehende
   Hülle und jedes bestehende Kontopaket unlesbar, das darf nicht still
   durchgehen. */
const KONTO_ABDRUCK_VORSPANN = 'stellium/konto/abdruck/v1';
const kontoKekKontext = (userId) => \`stellium/konto/kek/v1/\${userId}\`;
const notizKontoKontext = (notizId, fassung) => \`stellium/notiz/konto/\${notizId}/\${fassung}\`;

/* store.ts und socket.ts zuerst, und zwar in DIESER Reihenfolge: die beiden
   verweisen aufeinander (store ruft socket, socket meldet an store), und wer
   sie über einen Umweg lädt, bekommt "Cannot access 'socket' before
   initialization". lib/kontoschluessel.ts holt sich b64u/unb64u aus
   lib/vertraulich.ts und zieht diesen Kreis damit unfreiwillig mit herein.
   Dieselbe Reihenfolge wie in scripts/notiz-schluessel-nachreichen-pruefen.mjs. */
await import(${JSON.stringify(`file://${path.join(desktopPaket, 'src/state/store.ts').replace(/\\/g, '/')}`)});
await import(${JSON.stringify(`file://${path.join(desktopPaket, 'src/net/socket.ts').replace(/\\/g, '/')}`)});

const echt = await import(${JSON.stringify(`file://${path.join(desktopPaket, 'src/lib/kontoschluessel.ts').replace(/\\/g, '/')}`)});

let fehler = 0;
const pruefWahr = (name, ist) => {
  if (!ist) fehler++;
  console.log(\`  \${ist ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\`);
};

/* ── Dieselbe Nachrechnung wie in Teil 1, noch einmal unabhängig ── */
const subtle = crypto.subtle;
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (t) => new Uint8Array(Buffer.from(t, 'base64url'));
const sha256 = async (t) => new Uint8Array(await subtle.digest('SHA-256', enc.encode(t)));

async function passwortSchluessel(passwort, salz, runden, userId) {
  const roh = await subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256);
  const zwischen = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontoKekKontext(userId)), info: enc.encode('stellium/konto/kek/v1') },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
async function notizHuelle(kontoRoh, notizId, fassung) {
  const zwischen = await subtle.importKey('raw', kontoRoh, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(notizKontoKontext(notizId, fassung)), info: enc.encode('stellium/notiz/konto/v1') },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
async function kontoAbdruck(roh) {
  const vorspann = enc.encode(KONTO_ABDRUCK_VORSPANN);
  const zusammen = new Uint8Array(vorspann.length + roh.length);
  zusammen.set(vorspann, 0); zusammen.set(roh, vorspann.length);
  return b64u(new Uint8Array(await subtle.digest('SHA-256', zusammen)));
}

const USER = 'konto1';
const PASSWORT = 'ein-langes-passwort-1';
const NOTIZ = 'nz_' + crypto.randomUUID().replace(/-/g, '');

/* 1. Die App richtet einen Kontoschlüssel ein und legt die Hülle ab. */
pruefWahr('Die App richtet einen Kontoschlüssel ein', await echt.kontoSchluesselEinrichten(USER, PASSWORT));
pruefWahr('… und hat danach einen', echt.hatKontoSchluessel());
pruefWahr('… in Fassung 1', echt.kontoFassung() === 1);

const blob = globalThis.__ABLAGE__;
pruefWahr('Die abgelegte Hülle nennt Verfahren, Salz und Rundenzahl offen', Boolean(blob.kdf && blob.salz && blob.runden));
pruefWahr('Sie enthält das Passwort NICHT', !JSON.stringify(blob).includes(PASSWORT));

/* 2. Die Nachrechnung öffnet, was die App verschlossen hat. */
const huelle = await passwortSchluessel(PASSWORT, unb64u(blob.salz), blob.runden, USER);
let kontoRoh = null;
try {
  kontoRoh = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(blob.iv) }, huelle, unb64u(blob.daten)));
} catch { /* bleibt null */ }
pruefWahr('DIE NACHRECHNUNG ÖFFNET DIE HÜLLE DER APP — beide leiten denselben Schlüssel aus dem Passwort ab', kontoRoh !== null);
pruefWahr('… und der Abdruck stimmt mit dem überein, den die App abgelegt hat', kontoRoh !== null && (await kontoAbdruck(kontoRoh)) === blob.abdruck);

/* 3. Ein Notizschlüssel, von der App verpackt, von der Nachrechnung geöffnet. */
const notizKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const notizRoh = b64u(new Uint8Array(await subtle.exportKey('raw', notizKey)));
const paketVonApp = await echt.notizKontoPacken(notizKey, NOTIZ, 3);
pruefWahr('Das Kontopaket der App trägt die Fassung ihres Kontoschlüssels', paketVonApp.kontoFassung === echt.kontoFassung());
let zurueck = null;
try {
  const h = await notizHuelle(kontoRoh, NOTIZ, 3);
  zurueck = b64u(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(paketVonApp.iv) }, h, unb64u(paketVonApp.daten))));
} catch { /* bleibt null */ }
pruefWahr('Was die App verpackt, macht die Nachrechnung auf — und es ist derselbe Notizschlüssel', zurueck === notizRoh);

/* 4. Und andersherum: was die Nachrechnung verpackt, macht die App auf. */
const h2 = await notizHuelle(kontoRoh, NOTIZ, 7);
const iv2 = crypto.getRandomValues(new Uint8Array(12));
const daten2 = await subtle.encrypt({ name: 'AES-GCM', iv: iv2 }, h2, unb64u(notizRoh));
let vonAppGeoeffnet = null;
try {
  const key = await echt.notizKontoAuspacken(
    { alg: 'aes-gcm', kontoFassung: echt.kontoFassung(), iv: b64u(iv2), daten: b64u(new Uint8Array(daten2)) },
    NOTIZ, 7,
  );
  vonAppGeoeffnet = b64u(new Uint8Array(await subtle.exportKey('raw', key)));
} catch { /* bleibt null */ }
pruefWahr('Und was die Nachrechnung verpackt, macht die App auf', vonAppGeoeffnet === notizRoh);

/* 4b. passwortWechseln() -- der vorgesehene Weg für einen Passwortwechsel
       (siehe lib/kontoschluessel.ts, Dateikopf dort): DERSELBE Kontoschlüssel
       überlebt, nur seine Hülle wechselt. Das ist die Probe, die vorher
       fehlte: Schritt 5 unten prüft absichtlich den ANDEREN Weg
       (kontoSchluesselEinrichten mit einem fremden Passwort, das legitim
       einen neuen Schlüssel erzeugt) und hätte nie gemerkt, wenn irgendwo
       fälschlich EINRICHTEN statt UMSCHLIESSEN aufgerufen würde -- genau der
       Fehler, der beim Passwortwechsel jedes Notiz-Kontopaket wegräumen
       würde, ohne dass am Bildschirm irgendetwas falsch aussähe. */
// Verglichen wird gegen __ABLAGE__ -- den simulierten SERVER-Zustand --
// und NICHT gegen echt.kontoFassung(): passwortWechseln() aktualisiert den
// In-Speicher-Stand der App bewusst nicht (siehe deren Kommentar "Im
// Speicher bleibt deshalb alles, wie es war"), also bliebe echt.kontoFassung()
// vor und nach dem Aufruf so oder so gleich -- eine Probe dagegen wäre
// unabhängig vom Verhalten des Servers immer grün.
const fassungVorWechsel = globalThis.__ABLAGE__.fassung;
const abdruckVorWechsel = globalThis.__ABLAGE__.abdruck;
const datenVorWechsel = globalThis.__ABLAGE__.daten;
await echt.passwortWechseln(USER, PASSWORT, 'ein-neues-passwort-nach-wechsel');
pruefWahr('passwortWechseln() behält DENSELBEN Kontoschlüssel — gleicher Abdruck wie vor dem Wechsel',
  globalThis.__ABLAGE__.abdruck === abdruckVorWechsel);
pruefWahr('… und lässt die Fassung beim Server stehen, statt hochzuzählen — kein Notiz-Kontopaket fällt weg',
  globalThis.__ABLAGE__.fassung === fassungVorWechsel);
pruefWahr('… und die Hülle selbst wurde beim Server neu geschrieben (neues Salz/IV), nicht still verworfen '
  + '(sonst wäre die Probe oben nur deshalb grün, weil api.changePassword() den Schlüssel gar nicht weiterreicht)',
  globalThis.__ABLAGE__.daten !== datenVorWechsel);

// Die Gegenprobe zur Fassung: ein NACH dem Wechsel gepacktes Notizpaket muss
// sich mit kontoRoh öffnen lassen -- dem Rohschlüssel, den die Nachrechnung
// ganz am Anfang (Schritt 2) aus dem URSPRÜNGLICHEN Passwort abgeleitet hat.
// Hätte passwortWechseln() insgeheim einen frischen Schlüssel gemintet, wäre
// das hier die Stelle, an der es auffliegt: kontoRoh passte dann nicht
// mehr zum Schlüssel, mit dem die App gerade gepackt hat.
const notizKey2 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const notizRoh2 = b64u(new Uint8Array(await subtle.exportKey('raw', notizKey2)));
const paketNachWechsel = await echt.notizKontoPacken(notizKey2, NOTIZ, echt.kontoFassung());
let geoeffnetNachWechsel = null;
try {
  const h = await notizHuelle(kontoRoh, NOTIZ, echt.kontoFassung());
  geoeffnetNachWechsel = b64u(new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(paketNachWechsel.iv) }, h, unb64u(paketNachWechsel.daten),
  )));
} catch { /* bleibt null */ }
pruefWahr('… ein NACH dem Wechsel gepacktes Notizpaket öffnet sich weiterhin mit dem Rohschlüssel '
  + 'aus dem URSPRÜNGLICHEN Passwort — der Kontoschlüssel selbst hat sich nicht geändert',
  geoeffnetNachWechsel === notizRoh2);

/* 5. Ein anderes Passwort führt die App zu einem NEUEN Kontoschlüssel —
      still weiterrechnen mit einem falschen wäre das Schlimmste. */
const abdruckVorher = globalThis.__ABLAGE__.abdruck;
await echt.kontoSchluesselEinrichten(USER, 'ein-ganz-anderes-passwort');
pruefWahr('Mit einem anderen Passwort entsteht ein NEUER Kontoschlüssel, keiner wird geraten', globalThis.__ABLAGE__.abdruck !== abdruckVorher);
pruefWahr('… und der Server zählt die Fassung hoch', echt.kontoFassung() === 2);

/* 6. Beim Abmelden bleibt nichts liegen. */
echt.kontoSchluesselVergessen();
pruefWahr('Nach dem Abmelden hat dieses Gerät keinen Kontoschlüssel mehr', !echt.hatKontoSchluessel());
pruefWahr('… und im Gerätespeicher steht auch nichts mehr', localStorage.getItem('stellium.konto.schluessel') === null);
pruefWahr('Ein verwahrter Schlüssel eines FREMDEN Kontos wird nicht angenommen', !echt.kontoSchluesselAufnehmen('jemand-anders'));

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
  : '\n\x1b[32mJedes Gerät desselben Kontos öffnet dieselbe Notiz — allein über das Passwort. Der Server verwahrt nur Hüllen, und die ausgelieferte App rechnet dasselbe wie die Nachrechnung.\x1b[0m\n');
process.exit(fehlerGesamt ? 1 : 0);
