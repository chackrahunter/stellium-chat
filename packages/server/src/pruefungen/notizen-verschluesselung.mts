/**
 * Prüft gegen eine frische Datenbank, ob das Versprechen bei Notizen wirklich
 * hält: "Ende-zu-Ende verschlüsselt" heißt, dass der Server — auch mit
 * Dateizugriff auf die rohe Datenbank — weder Titel noch Text lesen kann,
 * und dass eine Person, die nicht hinzugefügt wurde, nichts bekommt, wenn
 * sie danach fragt.
 *
 * Dieser Lauf spielt dafür beide Seiten der App nach: er rechnet mit
 * node:crypto/webcrypto GENAU dieselbe ECDH-P256-plus-AES-GCM-Verpackung, die
 * packages/desktop/src/lib/vertraulich.ts und lib/notizen.ts im Browser
 * rechnen (dieselben Algorithmen, dieselben Kontext-Zeichenketten, dasselbe
 * Chiffratformat aus shared/vertraulich.ts) — der Server selbst bekommt
 * dabei, wie im echten Betrieb, nur fertig verschlossene Pakete zu sehen und
 * rechnet an keiner Stelle mit einem Klartext.
 *
 * Aufruf:  node scripts/notizen-verschluesselung-pruefen.mjs
 */
import fs from 'node:fs';
import crypto, { webcrypto } from 'node:crypto';
import {
  nutzlastLesen, nutzlastSchreiben, PAKET_ALG, type SchluesselPaket,
} from '@stellium/shared';
import { config } from '../config.js';
import { db, initDb } from '../db/index.js';
import * as notizen from '../services/notizen.js';
import * as vertraulich from '../services/vertraulich.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};
const pruefWahr = (name: string, ist: boolean) => pruef(name, ist, true);

/* ── Dieselbe Rechnung wie im Browser, nur mit node:crypto/webcrypto ──── */

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
function unb64u(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}
async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', enc.encode(text)));
}

async function paarErzeugen() {
  return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as Promise<webcrypto.CryptoKeyPair>;
}
async function oeffentlichesJwk(paar: webcrypto.CryptoKeyPair): Promise<string> {
  return JSON.stringify(await subtle.exportKey('jwk', paar.publicKey));
}
async function oeffentlichEinlesen(jwkText: string): Promise<webcrypto.CryptoKey> {
  return subtle.importKey('jwk', JSON.parse(jwkText), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/** Exakt dieselbe Ableitung wie gemeinsamerSchluessel() in lib/vertraulich.ts. */
async function gemeinsamerSchluessel(eigenerPrivat: webcrypto.CryptoKey, fremdesJwk: string, kontext: string): Promise<webcrypto.CryptoKey> {
  const fremd = await oeffentlichEinlesen(fremdesJwk);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: fremd }, eigenerPrivat, 256);
  const roh = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode('stellium/vertraulich/paket/v1') },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function notizKontext(notizId: string, fassung: number, von: string, fuer: string): string {
  return `stellium/notiz/${notizId}/${fassung}/${von}>${fuer}`;
}

async function paketPacken(von: string, vonPrivat: webcrypto.CryptoKey, fuerJwk: string, kanalKey: webcrypto.CryptoKey, kontext: string): Promise<SchluesselPaket> {
  const roh = await subtle.exportKey('raw', kanalKey);
  const huelle = await gemeinsamerSchluessel(vonPrivat, fuerJwk, kontext);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return { alg: PAKET_ALG, von, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) };
}

async function paketAuspacken(eigenerPrivat: webcrypto.CryptoKey, absenderJwk: string, paket: SchluesselPaket, kontext: string): Promise<webcrypto.CryptoKey> {
  const huelle = await gemeinsamerSchluessel(eigenerPrivat, absenderJwk, kontext);
  const roh = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten));
  return subtle.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function inhaltVerschluesseln(fassung: number, key: webcrypto.CryptoKey, inhalt: { titel: string; text: string }): Promise<string> {
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(inhalt)));
  return nutzlastSchreiben({ fassung, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) });
}

async function inhaltEntschluesseln(key: webcrypto.CryptoKey, roh: string): Promise<{ titel: string; text: string }> {
  const nutzlast = nutzlastLesen(roh)!;
  const klar = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(nutzlast.iv) }, key, unb64u(nutzlast.daten));
  return JSON.parse(dec.decode(klar));
}

/* ── Bühne: drei Konten, zwei davon mit Schlüsselpaar ─────────────────── */

function person(id: string): void {
  db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
          VALUES (?,?,?,'x',0)`, id, id, id);
}
person('probe1'); // besitzt die Notiz
person('probe2'); // wird hinzugefügt
person('probe3'); // bleibt außen vor

const paar1 = await paarErzeugen();
const paar2 = await paarErzeugen();
const jwk1 = await oeffentlichesJwk(paar1);
const jwk2 = await oeffentlichesJwk(paar2);
vertraulich.schluesselMelden({ userId: 'probe1', jwk: jwk1, abdruck: 'probe1-abdruck' });
vertraulich.schluesselMelden({ userId: 'probe2', jwk: jwk2, abdruck: 'probe2-abdruck' });
// probe3 hinterlegt bewusst NIE einen Schlüssel — dieselbe Lage wie eine
// Person, die die App noch nicht gestartet hat.

/* ── probe1 legt eine Notiz an, ganz wie die App es täte ──────────────── */

const notizId = `nz_${crypto.randomBytes(16).toString('hex')}`;
const TITEL = 'Kündigung Müller';
const TEXT = 'Vertraulicher Vermerk, der nur für die hinzugefügten Personen bestimmt ist — auch der Server soll ihn nie lesen können.';

const notizKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const chiffrat = await inhaltVerschluesseln(1, notizKey, { titel: TITEL, text: TEXT });
const eigenesPaket = await paketPacken('probe1', paar1.privateKey, jwk1, notizKey, notizKontext(notizId, 1, 'probe1', 'probe1'));

console.log('\nAnlegen und Teilen:');
const angelegt = notizen.anlegen({ id: notizId, ownerId: 'probe1', chiffrat, paket: eigenesPaket });
pruef('Notiz wurde angelegt', angelegt.id, notizId);

const paketFuer2 = await paketPacken('probe1', paar1.privateKey, jwk2, notizKey, notizKontext(notizId, 1, 'probe1', 'probe2'));
notizen.mitgliedHinzufuegen({ notizId, ownerId: 'probe1', zielUserId: 'probe2', paket: paketFuer2 });
const nachHinzufuegen = notizen.getNotiz(notizId, 'probe1')!;
pruef('probe2 steht als Mitglied', nachHinzufuegen.memberIds, ['probe2']);

/* ── Nachweis 1: die ROHE Datenbank trägt weder Titel noch Text ───────── */

console.log('\nRohe Datenbank — kein Klartext:');

const roheZeile = db.get<{ chiffrat: string }>('SELECT chiffrat FROM notizen WHERE id = ?', notizId)!;
pruefWahr('notizen.chiffrat beginnt mit dem E2E-Kennzeichen "e1:"', roheZeile.chiffrat.startsWith('e1:'));
pruefWahr('notizen.chiffrat enthält NICHT den Titel im Klartext', !roheZeile.chiffrat.includes(TITEL));
pruefWahr('notizen.chiffrat enthält NICHT den Text im Klartext', !roheZeile.chiffrat.includes(TEXT));

const alleTabellenzeilen = [
  ...db.all<any>('SELECT * FROM notizen'),
  ...db.all<any>('SELECT * FROM notiz_mitglieder'),
  ...db.all<any>('SELECT * FROM notiz_schluessel_pakete'),
].map((r) => JSON.stringify(r));
pruefWahr(
  'Auch sonst steht der Titel in keiner der drei Tabellen',
  alleTabellenzeilen.every((zeile) => !zeile.includes(TITEL)),
);
pruefWahr(
  'Auch sonst steht der Text in keiner der drei Tabellen',
  alleTabellenzeilen.every((zeile) => !zeile.includes(TEXT)),
);

// Nicht nur über SQL nachgesehen — auch die Datei selbst, byteweise, so wie
// sie auf der Platte liegt. WAL-Checkpoint zuerst: sonst läge das eben erst
// Geschriebene noch in der -wal-Datei statt in der Hauptdatei.
db.exec('PRAGMA wal_checkpoint(FULL)');
const rohDatei = fs.readFileSync(config.dbFile);
const alsBytesTitel = Buffer.from(TITEL, 'utf8');
const alsBytesText = Buffer.from(TEXT, 'utf8');
pruefWahr('Die Datenbankdatei auf der Platte enthält den Titel an KEINER Stelle', rohDatei.indexOf(alsBytesTitel) === -1);
pruefWahr('Die Datenbankdatei auf der Platte enthält den Text an KEINER Stelle', rohDatei.indexOf(alsBytesText) === -1);
for (const nebendatei of [`${config.dbFile}-wal`, `${config.dbFile}-journal`]) {
  if (!fs.existsSync(nebendatei)) continue;
  const inhalt = fs.readFileSync(nebendatei);
  pruefWahr(`${nebendatei.split('/').pop()} enthält den Titel an KEINER Stelle`, inhalt.indexOf(alsBytesTitel) === -1);
}

/* ── Nachweis 2: probe1 und probe2 können lesen, mit ihrem eigenen Schlüssel ── */

console.log('\nEntschlüsseln mit dem jeweils eigenen Gerät:');

const paket1 = notizen.paketFuer(notizId, 'probe1')!;
const schluessel1 = await paketAuspacken(paar1.privateKey, jwk1, paket1.paket, notizKontext(notizId, paket1.fassung, 'probe1', 'probe1'));
const gelesenVon1 = await inhaltEntschluesseln(schluessel1, roheZeile.chiffrat);
pruef('probe1 liest den echten Titel zurück', gelesenVon1.titel, TITEL);
pruef('probe1 liest den echten Text zurück', gelesenVon1.text, TEXT);

const paket2 = notizen.paketFuer(notizId, 'probe2')!;
const schluessel2 = await paketAuspacken(paar2.privateKey, jwk1, paket2.paket, notizKontext(notizId, paket2.fassung, 'probe1', 'probe2'));
const gelesenVon2 = await inhaltEntschluesseln(schluessel2, roheZeile.chiffrat);
pruef('probe2 (hinzugefügt) liest denselben Titel', gelesenVon2.titel, TITEL);
pruef('probe2 (hinzugefügt) liest denselben Text', gelesenVon2.text, TEXT);

/* ── Nachweis 3: probe3 (nie hinzugefügt) bekommt NICHTS ──────────────── */

console.log('\nprobe3 wurde nie hinzugefügt:');

pruef('Kein Schlüsselpaket für probe3', notizen.paketFuer(notizId, 'probe3'), null);
pruef('getNotiz() liefert für probe3 nichts — nicht einmal die Metadaten', notizen.getNotiz(notizId, 'probe3'), null);
pruefWahr('Die Notiz taucht in probe3s Liste nicht auf', !notizen.listNotizen('probe3').some((n) => n.id === notizId));

let vonProbe3AbgewiesenHinzufuegen = false;
try {
  notizen.mitgliedHinzufuegen({ notizId, ownerId: 'probe3', zielUserId: 'probe3', paket: eigenesPaket });
} catch {
  vonProbe3AbgewiesenHinzufuegen = true;
}
pruefWahr('probe3 kann sich nicht selbst als Mitglied hinzufügen (ist nicht die besitzende Person)', vonProbe3AbgewiesenHinzufuegen);

let vonProbe3AbgewiesenEntfernen = false;
try {
  notizen.mitgliedEntfernen({
    notizId, ownerId: 'probe3', zielUserId: 'probe2',
    neueFassung: 2, chiffrat, version: nachHinzufuegen.version, pakete: [],
  });
} catch {
  vonProbe3AbgewiesenEntfernen = true;
}
pruefWahr('probe3 kann niemanden aus der Notiz entfernen (ist nicht die besitzende Person)', vonProbe3AbgewiesenEntfernen);

/* ── Ergebnis ──────────────────────────────────────────────────────────── */

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mWeder Titel noch Text stehen im Klartext in der Datenbank — und wer nicht hinzugefügt wurde, bekommt nichts.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
