/**
 * Prüft den Kontoschlüssel — den Weg, auf dem eine Notiz sich auf JEDEM
 * Gerät desselben Kontos öffnen lässt.
 *
 * DER FEHLERBERICHT: "eine auf dem Mac angelegte Notiz entschlüsselt sich
 * auf dem Handy nie, unter demselben Konto."
 *
 * DIE URSACHE, an der dieser Lauf entlanggeht: `von` in einem
 * SchluesselPaket ist eine KONTO-Kennung, gerechnet wurde das Paket aber mit
 * dem privaten ECDH-Teil EINES BESTIMMTEN GERÄTS. Die Ablage
 * (notiz_schluessel_pakete, Primärschlüssel (notiz_id, user_id)) kennt nur
 * Konten. Ein zweites Gerät schlägt beim Auspacken den öffentlichen Teil
 * "des Kontos" nach und bekommt SEINEN EIGENEN — die Rechnung des ersten
 * Geräts lässt sich damit nie nachbilden. Teil 1 unten führt genau das vor,
 * mit echter Kryptografie und ohne jede Nachhilfe.
 *
 * Dieser Lauf spielt beide Geräte nach und rechnet mit node:crypto/webcrypto
 * dieselben Ableitungen, die packages/desktop/src/lib/kontoschluessel.ts im
 * Browser rechnet — dieselben Verfahren, dieselben Kontexte aus
 * shared/vertraulich.ts, dieselbe Rundenzahl. Nachgebaut und nicht importiert
 * (dieselbe Machart wie in notizen-verschluesselung.mts, siehe dort): eine
 * Prüfung, die den geprüften Code als Maßstab benutzt, prüft nichts.
 *
 * Der Server selbst bekommt dabei, wie im Betrieb, nur Verschlossenes zu
 * sehen und rechnet an keiner Stelle mit einem Klartext.
 *
 * Aufruf:  node scripts/notiz-kontoschluessel-pruefen.mjs
 */
import fs from 'node:fs';
import crypto, { webcrypto } from 'node:crypto';
import {
  KONTO_ABDRUCK_VORSPANN, KONTO_KDF, KONTO_PAKET_ALG, KONTO_RUNDEN,
  kontoKekKontext, notizKontoKontext, nutzlastLesen, nutzlastSchreiben,
  PAKET_ALG, type KontoPaket, type KontoSchluesselBlob, type SchluesselPaket,
} from '@stellium/shared';
import { config } from '../config.js';
import { db, initDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../auth.js';
import * as notizen from '../services/notizen.js';
import * as kontoschluessel from '../services/kontoschluessel.js';
import * as users from '../services/users.js';
import * as vertraulich from '../services/vertraulich.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};
const pruefWahr = (name: string, ist: boolean) => pruef(name, ist, true);

/* WICHTIG für jede künftige Zeile hier: `pruef()` DRUCKT den Istwert, wenn
   eine Zusage bricht. Deshalb geht durch pruef() nur, was auch auf einem
   Bildschirm stehen darf — Titel und Text der Probennotizen (die sind
   erfunden), Zahlen, Wahrheitswerte. Schlüssel, Hüllen, Salze und
   Passwörter werden VORHER zu einem Wahrheitswert verrechnet und gehen
   durch pruefWahr(). Ein fehlgeschlagener Prüflauf, der ein Salz ins
   Protokoll schreibt, wäre ein Leck an genau der Stelle, die Lecks
   ausschließen soll. */

/** Zeilen in notiz_konto_pakete — ROH, ohne die Fassungsfilter der Dienste.
 *  Der Unterschied ist der Punkt: kontoPaketeFuerAlle() blendet veraltete
 *  Zeilen ohnehin aus, hier soll aber geprüft werden, ob sie WEG sind. */
const roheKontopakete = (userId: string) =>
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notiz_konto_pakete WHERE user_id = ?', userId)!.n;

/* ── Dieselben Rechnungen wie im Browser, nur mit node:crypto ─────────── */

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (t: string) => new Uint8Array(Buffer.from(t, 'base64url'));
const sha256 = async (t: string) => new Uint8Array(await subtle.digest('SHA-256', enc.encode(t)));

/* — Geräteweg (ECDH), wortgleich zu lib/vertraulich.ts — */

const paarErzeugen = () =>
  subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as Promise<webcrypto.CryptoKeyPair>;

async function gemeinsamerSchluessel(privat: webcrypto.CryptoKey, fremdJwk: string, kontext: string) {
  const fremd = await subtle.importKey('jwk', JSON.parse(fremdJwk), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: fremd }, privat, 256);
  const roh = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode('stellium/vertraulich/paket/v1') },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

const notizKontext = (id: string, f: number, von: string, fuer: string) => `stellium/notiz/${id}/${f}/${von}>${fuer}`;

async function geraetPaketPacken(von: string, privat: webcrypto.CryptoKey, fuerJwk: string, key: webcrypto.CryptoKey, kontext: string): Promise<SchluesselPaket> {
  const roh = await subtle.exportKey('raw', key);
  const huelle = await gemeinsamerSchluessel(privat, fuerJwk, kontext);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return { alg: PAKET_ALG, von, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) };
}

async function geraetPaketAuspacken(privat: webcrypto.CryptoKey, absenderJwk: string, paket: SchluesselPaket, kontext: string) {
  const huelle = await gemeinsamerSchluessel(privat, absenderJwk, kontext);
  const roh = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten));
  return subtle.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/* — Kontoweg, wortgleich zu lib/kontoschluessel.ts — */

/** PBKDF2 über das Passwort, danach HKDF mit der Kontokennung im Kontext. */
async function passwortSchluessel(passwort: string, salz: Uint8Array, runden: number, userId: string) {
  const roh = await subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256);
  const zwischen = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontoKekKontext(userId)), info: enc.encode('stellium/konto/kek/v1') },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function kontoAbdruck(roh: Uint8Array): Promise<string> {
  const vorspann = enc.encode(KONTO_ABDRUCK_VORSPANN);
  const zusammen = new Uint8Array(vorspann.length + roh.length);
  zusammen.set(vorspann, 0); zusammen.set(roh, vorspann.length);
  return b64u(new Uint8Array(await subtle.digest('SHA-256', zusammen)));
}

/** Einen Kontoschlüssel in eine Hülle legen — wie es ein Gerät täte. */
async function kontoUmschliessen(roh: Uint8Array, passwort: string, userId: string): Promise<KontoSchluesselBlob> {
  const salz = crypto.randomBytes(16);
  const huelle = await passwortSchluessel(passwort, salz, KONTO_RUNDEN, userId);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return {
    kdf: KONTO_KDF, salz: b64u(salz), runden: KONTO_RUNDEN, alg: KONTO_PAKET_ALG,
    iv: b64u(iv), daten: b64u(new Uint8Array(daten)), fassung: 0, abdruck: await kontoAbdruck(roh),
  };
}

/** Und wieder auf. `null` heißt: das Passwort passt nicht — nichts wird geraten. */
async function kontoAuspacken(blob: KontoSchluesselBlob, passwort: string, userId: string): Promise<Uint8Array | null> {
  try {
    const huelle = await passwortSchluessel(passwort, unb64u(blob.salz), blob.runden, userId);
    const roh = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(blob.iv) }, huelle, unb64u(blob.daten)));
    return (await kontoAbdruck(roh)) === blob.abdruck ? roh : null;
  } catch {
    return null;
  }
}

async function notizHuelle(kontoRoh: Uint8Array, notizId: string, fassung: number) {
  const zwischen = await subtle.importKey('raw', kontoRoh, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(notizKontoKontext(notizId, fassung)), info: enc.encode('stellium/notiz/konto/v1') },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function kontoPaketPacken(kontoRoh: Uint8Array, kontoFassung: number, notizKey: webcrypto.CryptoKey, notizId: string, fassung: number): Promise<KontoPaket> {
  const roh = await subtle.exportKey('raw', notizKey);
  const huelle = await notizHuelle(kontoRoh, notizId, fassung);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return { alg: KONTO_PAKET_ALG, kontoFassung, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) };
}

async function kontoPaketAuspacken(kontoRoh: Uint8Array, paket: KontoPaket, notizId: string, fassung: number) {
  const huelle = await notizHuelle(kontoRoh, notizId, fassung);
  const roh = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten));
  return subtle.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/* — Inhalt — */

async function inhaltVerschluesseln(fassung: number, key: webcrypto.CryptoKey, inhalt: { titel: string; text: string }) {
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(inhalt)));
  return nutzlastSchreiben({ fassung, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) });
}

/** `null` statt eines Wurfs: "geht nicht auf" ist hier ein Ergebnis, kein Unfall. */
async function inhaltEntschluesseln(key: webcrypto.CryptoKey, roh: string): Promise<{ titel: string; text: string } | null> {
  try {
    const nutzlast = nutzlastLesen(roh)!;
    const klar = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(nutzlast.iv) }, key, unb64u(nutzlast.daten));
    return JSON.parse(dec.decode(klar));
  } catch {
    return null;
  }
}

/**
 * Eine Notiz über den Kontoweg lesen — oder `null`, wenn dafür etwas fehlt.
 *
 * Bewusst ohne Absturz bei fehlendem Paket: eine Prüfung, die beim ersten
 * Loch abbricht, verschweigt alles danach — und dann sagt ein Lauf mit
 * zurückgedrehtem Fix nicht mehr, WELCHE Zusagen daran hängen.
 */
async function ueberKontoweg(kontoRoh: Uint8Array | null, notizId: string, chiffrat: string) {
  if (!kontoRoh) return null;
  const p = notizen.kontoPaketeFuerAlle(KONTO).find((x) => x.notizId === notizId);
  if (!p) return null;
  try {
    return await inhaltEntschluesseln(await kontoPaketAuspacken(kontoRoh, p.paket, notizId, p.fassung), chiffrat);
  } catch {
    return null;
  }
}

/* ── Bühne: EIN Konto, ZWEI Geräte ────────────────────────────────────── */

const KONTO = 'konto1';
const FREMD = 'fremd1';
const PASSWORT = 'ein-langes-passwort-1';
const PASSWORT_NEU = 'ein-anderes-langes-passwort-2';

db.run(
  `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,0)`,
  KONTO, KONTO, KONTO, hashPassword(PASSWORT), 'member',
);
db.run(
  `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,0)`,
  FREMD, FREMD, FREMD, hashPassword('irgendein-langes-passwort'), 'owner',
);

// Zwei Geräte, zwei ECDH-Paare — dasselbe Konto.
const geraetA = await paarErzeugen();
const geraetB = await paarErzeugen();
const jwkA = JSON.stringify(await subtle.exportKey('jwk', geraetA.publicKey));
const jwkB = JSON.stringify(await subtle.exportKey('jwk', geraetB.publicKey));

// Gerät A meldet seinen öffentlichen Teil — so wie schluesselBereitstellen()
// es beim Start tut.
vertraulich.schluesselMelden({ userId: KONTO, jwk: jwkA, abdruck: 'abdruck-a' });

const TITEL = 'Rückruf Meyer';
const TEXT = 'Nur für dieses Konto bestimmt — auf jedem seiner Geräte lesbar, für den Server nie.';

/* ── Teil 1: der Fehler selbst, ohne Kontoschlüssel ───────────────────── */

console.log('\n\x1b[1mTeil 1 — Der Geräteweg allein: das zweite Gerät kommt nicht hinein\x1b[0m');

const notizId = `nz_${crypto.randomBytes(16).toString('hex')}`;
const notizKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const chiffrat = await inhaltVerschluesseln(1, notizKey, { titel: TITEL, text: TEXT });

// Gerät A legt an — mit dem Selbstpaket, wie es die App seit jeher tut.
const paketA = await geraetPaketPacken(KONTO, geraetA.privateKey, jwkA, notizKey, notizKontext(notizId, 1, KONTO, KONTO));
notizen.anlegen({ id: notizId, ownerId: KONTO, chiffrat, paket: paketA });

// Gerät B meldet sich an: es hinterlegt SEINEN öffentlichen Teil und
// überschreibt damit den von A — genau das tut schluesselBereitstellen() auf
// einem zweiten Gerät, und genau darin steckt die Verwechslung.
vertraulich.schluesselMelden({ userId: KONTO, jwk: jwkB, abdruck: 'abdruck-b' });
const oeffentlichLautServer = vertraulich.oeffentlicheSchluessel([KONTO])[0]?.jwk;
pruefWahr('Der Server kennt je KONTO nur EINEN öffentlichen Teil — nach der Anmeldung von Gerät B ist es dessen', oeffentlichLautServer === jwkB);

const geraetPaket = notizen.paketFuer(notizId, KONTO)!;
const bMitGeraeteweg = await (async () => {
  try {
    // So, wie paketAuspacken() es täte: den Absender über `von` nachschlagen —
    // und `von` ist die KONTO-Kennung, also kommt der Teil von Gerät B zurück.
    const key = await geraetPaketAuspacken(geraetB.privateKey, oeffentlichLautServer!, geraetPaket.paket, notizKontext(notizId, 1, KONTO, KONTO));
    return await inhaltEntschluesseln(key, chiffrat);
  } catch {
    return null;
  }
})();
pruefWahr('Gerät B kann das Gerätepaket NICHT öffnen — der gemeldete Fehler, hier reproduziert', bMitGeraeteweg === null);

const aMitGeraeteweg = await inhaltEntschluesseln(
  await geraetPaketAuspacken(geraetA.privateKey, jwkA, geraetPaket.paket, notizKontext(notizId, 1, KONTO, KONTO)),
  chiffrat,
);
pruef('Gerät A dagegen liest sie ganz normal (der Geräteweg ist nicht kaputt, er ist nur geräteeigen)', aMitGeraeteweg?.titel, TITEL);

/* ── Teil 2: mit Kontoschlüssel öffnet das zweite Gerät ───────────────── */

console.log('\n\x1b[1mTeil 2 — Mit dem Kontoschlüssel öffnet dasselbe Gerät B dieselbe Notiz\x1b[0m');

// Gerät A meldet sich an: Kontoschlüssel gibt es noch keinen -> es legt einen an.
pruefWahr('Vor der ersten Anmeldung liegt kein Kontoschlüssel beim Server', kontoschluessel.holen(KONTO) === null);
const kontoRohA = crypto.randomBytes(32);
const fassungA = kontoschluessel.hinterlegen(KONTO, await kontoUmschliessen(kontoRohA, PASSWORT, KONTO));
pruef('Der erste hinterlegte Kontoschlüssel steht in Fassung 1', fassungA, 1);

// Und legt eine zweite Notiz an — diesmal gleich mit Kontopaket, wie
// notizErstellen() es seit dieser Fassung tut.
const notizId2 = `nz_${crypto.randomBytes(16).toString('hex')}`;
const notizKey2 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const TITEL2 = 'Am Mac geschrieben';
const TEXT2 = 'Diese Notiz muss auf dem Handy aufgehen, ohne dass der Mac je wieder online ist.';
const chiffrat2 = await inhaltVerschluesseln(1, notizKey2, { titel: TITEL2, text: TEXT2 });
notizen.anlegen({
  id: notizId2, ownerId: KONTO, chiffrat: chiffrat2,
  paket: await geraetPaketPacken(KONTO, geraetA.privateKey, jwkA, notizKey2, notizKontext(notizId2, 1, KONTO, KONTO)),
  kontoPaket: await kontoPaketPacken(kontoRohA, fassungA, notizKey2, notizId2, 1),
});

// Gerät B meldet sich mit DEMSELBEN Passwort an — mehr hat es nicht.
const blobFuerB = kontoschluessel.holen(KONTO)!;
const kontoRohB = await kontoAuspacken(blobFuerB, PASSWORT, KONTO);
pruefWahr('Gerät B holt aus derselben Hülle denselben Kontoschlüssel — allein aus dem Passwort', kontoRohB !== null);
pruefWahr('… und es ist wirklich derselbe (Abdruckvergleich, kein Schlüssel wird ausgegeben)', Boolean(kontoRohB) && await kontoAbdruck(kontoRohB!) === await kontoAbdruck(kontoRohA));

pruefWahr(
  'Der Server gibt Gerät B das Kontopaket der frisch angelegten Notiz heraus',
  notizen.kontoPaketeFuerAlle(KONTO).some((p) => p.notizId === notizId2),
);
const gelesenVonB = await ueberKontoweg(kontoRohB, notizId2, chiffrat2);
pruef('GERÄT B LIEST DEN ECHTEN TITEL — nur über das Passwort, ohne jedes Zutun von Gerät A', gelesenVonB?.titel, TITEL2);
pruef('… und den echten Text', gelesenVonB?.text, TEXT2);

// Ein falsches Passwort bekommt dieselbe Hülle nicht auf.
pruefWahr('Mit einem falschen Passwort geht die Hülle nicht auf — es wird nichts geraten', (await kontoAuspacken(blobFuerB, 'falsches-langes-passwort', KONTO)) === null);
// Und ein anderes Konto ebenso wenig: die Kennung steckt in der Ableitung.
pruefWahr('Auch mit dem RICHTIGEN Passwort, aber unter fremder Kennung, geht sie nicht auf', (await kontoAuspacken(blobFuerB, PASSWORT, FREMD)) === null);

/* ── Teil 3: der Server sieht nichts ──────────────────────────────────── */

console.log('\n\x1b[1mTeil 3 — Was in der rohen Datenbank steht\x1b[0m');

const alleZeilen = [
  ...db.all<any>('SELECT * FROM notizen'),
  ...db.all<any>('SELECT * FROM notiz_schluessel_pakete'),
  ...db.all<any>('SELECT * FROM notiz_konto_pakete'),
  ...db.all<any>('SELECT * FROM konto_schluessel'),
  ...db.all<any>('SELECT * FROM users'),
].map((r) => JSON.stringify(r));
for (const [name, wert] of [['der Titel', TITEL2], ['der Text', TEXT2], ['das Passwort', PASSWORT]] as const) {
  pruefWahr(`In keiner dieser fünf Tabellen steht ${name}`, alleZeilen.every((z) => !z.includes(wert)));
}
pruefWahr(
  'Der Kontoschlüssel selbst steht NIRGENDS in den Tabellen — auch nicht in der Zeile, die ihn verwahrt',
  alleZeilen.every((z) => !z.includes(b64u(kontoRohA))),
);
const kontoZeile = db.get<any>('SELECT * FROM konto_schluessel WHERE user_id = ?', KONTO)!;
pruefWahr('konto_schluessel.daten ist nicht der Schlüssel, sondern seine Hülle', kontoZeile.daten !== b64u(kontoRohA));
pruef('konto_schluessel führt das Verfahren offen mit (damit ein späterer Wechsel alte Hüllen nicht bricht)', kontoZeile.kdf, KONTO_KDF);
pruef('… und die Rundenzahl, mit der diese Hülle gerechnet wurde', kontoZeile.runden, KONTO_RUNDEN);
pruefWahr('konto_schluessel trägt kein Feld mit dem Passwort', !Object.keys(kontoZeile).some((k) => /pass|kennwort/i.test(k)));

// Nicht nur über SQL: die Datei selbst, byteweise. WAL-Checkpoint zuerst,
// sonst läge das eben Geschriebene noch daneben.
db.exec('PRAGMA wal_checkpoint(FULL)');
const dateien = [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-journal`].filter((p) => fs.existsSync(p));
for (const pfad of dateien) {
  const inhalt = fs.readFileSync(pfad);
  const kurz = pfad.split('/').pop();
  pruefWahr(`${kurz}: kein Titel im Klartext`, inhalt.indexOf(Buffer.from(TITEL2, 'utf8')) === -1);
  pruefWahr(`${kurz}: kein Text im Klartext`, inhalt.indexOf(Buffer.from(TEXT2, 'utf8')) === -1);
  pruefWahr(`${kurz}: kein Passwort im Klartext`, inhalt.indexOf(Buffer.from(PASSWORT, 'utf8')) === -1);
  pruefWahr(`${kurz}: der Kontoschlüssel steht nirgends — weder roh noch als Text`, inhalt.indexOf(Buffer.from(kontoRohA)) === -1 && inhalt.indexOf(Buffer.from(b64u(kontoRohA), 'utf8')) === -1);
}

/* ── Teil 4: der Altbestand wächst nach ───────────────────────────────── */

console.log('\n\x1b[1mTeil 4 — Eine Notiz von vorher bekommt ihren Kontoweg\x1b[0m');

// notizId (Teil 1) entstand ohne Kontopaket — genau wie jede Notiz, die es
// vor dieser Fassung schon gab.
pruefWahr('Der Server führt die alte Notiz als Lücke (notizenOhneKontoPaket)', notizen.notizenOhneKontoPaket(KONTO).includes(notizId));
pruefWahr('Die neue Notiz steht dort nicht — sie hat ihren Kontoweg schon', !notizen.notizenOhneKontoPaket(KONTO).includes(notizId2));

/* Gerät A schließt die Lücke — und zwar erst, nachdem es den Schlüssel am
   Chiffrat der Notiz SELBST erprobt hat. Genau diese Reihenfolge steht auch
   in lib/notizen.ts: ein Kontopaket aus einem ungeprüften Schlüssel sähe in
   der Datenbank tadellos aus und ließe sich nie öffnen. */
const schluesselAusGeraeteweg = await geraetPaketAuspacken(geraetA.privateKey, jwkA, geraetPaket.paket, notizKontext(notizId, 1, KONTO, KONTO));
const erprobt = await inhaltEntschluesseln(schluesselAusGeraeteweg, chiffrat);
pruef('Gerät A erprobt den Schlüssel am Chiffrat, bevor es irgendetwas schreibt', erprobt?.titel, TITEL);
try {
  notizen.kontoPaketSetzen({
    notizId, userId: KONTO, fassung: 1,
    paket: await kontoPaketPacken(kontoRohA, fassungA, schluesselAusGeraeteweg, notizId, 1),
  });
} catch (err) {
  console.log(`  \x1b[31m✗\x1b[0m Gerät A darf sein eigenes Kontopaket nachtragen  (abgewiesen: ${(err as Error).message})`);
  fehler++;
}
pruefWahr('Danach ist die Lücke zu', !notizen.notizenOhneKontoPaket(KONTO).includes(notizId));

const alteNotizAufB = await ueberKontoweg(kontoRohB, notizId, chiffrat);
pruef('GERÄT B LIEST JETZT AUCH DIE ALTE NOTIZ — die Kette ist durchgelaufen', alteNotizAufB?.titel, TITEL);
pruef('… mit dem echten Text', alteNotizAufB?.text, TEXT);
pruefWahr('Der Geräteweg steht unangetastet daneben', Boolean(notizen.paketFuer(notizId, KONTO)));

/* ── Teil 5: Wachen gegen Pakete, die nur gesund aussehen ─────────────── */

console.log('\n\x1b[1mTeil 5 — Was der Server NICHT annimmt\x1b[0m');

const nimmtNicht = async (name: string, tun: () => void) => {
  let abgewiesen = false;
  try { tun(); } catch { abgewiesen = true; }
  pruefWahr(name, abgewiesen);
};
await nimmtNicht('Ein Kontopaket mit veralteter Kontofassung', () => notizen.kontoPaketSetzen({
  notizId, userId: KONTO, fassung: 1, paket: { alg: KONTO_PAKET_ALG, kontoFassung: fassungA + 1, iv: 'AAAA', daten: 'BBBB' },
}));
await nimmtNicht('Ein Kontopaket mit falscher Schlüsselfassung der Notiz', () => notizen.kontoPaketSetzen({
  notizId, userId: KONTO, fassung: 9, paket: { alg: KONTO_PAKET_ALG, kontoFassung: fassungA, iv: 'AAAA', daten: 'BBBB' },
}));
await nimmtNicht('Ein Kontopaket von jemandem, der die Notiz gar nicht sehen darf', () => notizen.kontoPaketSetzen({
  notizId, userId: FREMD, fassung: 1, paket: { alg: KONTO_PAKET_ALG, kontoFassung: fassungA, iv: 'AAAA', daten: 'BBBB' },
}));
await nimmtNicht('Eine unvollständige Hülle für den Kontoschlüssel', () => kontoschluessel.hinterlegen(KONTO, {
  ...blobFuerB, daten: '',
}));

/* ── Teil 6: Passwortwechsel ──────────────────────────────────────────── */

console.log('\n\x1b[1mTeil 6 — Passwort wechseln, ohne dass ein Gerät etwas verliert\x1b[0m');

const paketeVorher = notizen.kontoPaketeFuerAlle(KONTO).length;
users.changeOwnPassword(KONTO, PASSWORT, PASSWORT_NEU, verifyPassword, await kontoUmschliessen(kontoRohA, PASSWORT_NEU, KONTO));

pruef('Die Fassung des Kontoschlüssels bleibt — es ist derselbe Schlüssel, nur eine neue Hülle', kontoschluessel.aktuelleFassung(KONTO), fassungA);
pruef('Kein einziges Kontopaket ging dabei verloren', notizen.kontoPaketeFuerAlle(KONTO).length, paketeVorher);

const blobNachWechsel = kontoschluessel.holen(KONTO)!;
pruefWahr('Mit dem ALTEN Passwort geht die Hülle nicht mehr auf', (await kontoAuspacken(blobNachWechsel, PASSWORT, KONTO)) === null);
const kontoRohNeu = await kontoAuspacken(blobNachWechsel, PASSWORT_NEU, KONTO);
pruefWahr('Mit dem neuen geht sie auf …', kontoRohNeu !== null);
pruefWahr('… und liefert DENSELBEN Kontoschlüssel wie vorher', Boolean(kontoRohNeu) && await kontoAbdruck(kontoRohNeu!) === await kontoAbdruck(kontoRohA));

const gelesenNachWechsel = await ueberKontoweg(kontoRohNeu, notizId2, chiffrat2);
pruef('Gerät B liest nach dem Wechsel weiter — mit dem neuen Passwort', gelesenNachWechsel?.titel, TITEL2);
const aNachWechsel = await inhaltEntschluesseln(
  await geraetPaketAuspacken(geraetA.privateKey, jwkA, notizen.paketFuer(notizId2, KONTO)!.paket, notizKontext(notizId2, 1, KONTO, KONTO)),
  chiffrat2,
);
pruef('Und Gerät A auch — über seinen unveränderten Geräteweg', aNachWechsel?.titel, TITEL2);

// Und die Gegenprobe: eine App, die beim Umschließen versehentlich einen
// ANDEREN Schlüssel einpackt, darf die alten Kontopakete nicht stehen lassen.
console.log('\n  Gegenprobe — ein umschlossener FREMDER Schlüssel:');
const fassungVorFehler = kontoschluessel.aktuelleFassung(KONTO);
kontoschluessel.hinterlegen(KONTO, await kontoUmschliessen(crypto.randomBytes(32), PASSWORT_NEU, KONTO));
pruef('Der Abdruck weicht ab -> der Server zählt die Fassung hoch', kontoschluessel.aktuelleFassung(KONTO), fassungVorFehler + 1);
pruef('… und räumt JEDES Kontopaket weg, statt eines stehen zu lassen, das niemand öffnen kann (rohe Tabelle, nicht die gefilterte Sicht)', roheKontopakete(KONTO), 0);
pruefWahr('Beide Notizen stehen wieder als Lücke — sie wachsen über den Geräteweg nach', [notizId, notizId2].every((id) => notizen.notizenOhneKontoPaket(KONTO).includes(id)));
pruefWahr('Der Geräteweg hat davon nichts abbekommen', Boolean(notizen.paketFuer(notizId2, KONTO)));
const aTrotzdem = await inhaltEntschluesseln(
  await geraetPaketAuspacken(geraetA.privateKey, jwkA, notizen.paketFuer(notizId2, KONTO)!.paket, notizKontext(notizId2, 1, KONTO, KONTO)),
  chiffrat2,
);
pruef('Gerät A liest die Notiz unverändert — kein Inhalt ging verloren', aTrotzdem?.titel, TITEL2);

/* ── Teil 7: Zurücksetzen durch die Verwaltung ────────────────────────── */

console.log('\n\x1b[1mTeil 7 — Zurückgesetztes Passwort: die Hülle wird ehrlich weggeworfen\x1b[0m');

// Erst wieder einen brauchbaren Stand herstellen.
const kontoRohZwei = crypto.randomBytes(32);
const fassungZwei = kontoschluessel.hinterlegen(KONTO, await kontoUmschliessen(kontoRohZwei, PASSWORT_NEU, KONTO));
try {
  notizen.kontoPaketSetzen({
    notizId: notizId2, userId: KONTO, fassung: 1,
    paket: await kontoPaketPacken(kontoRohZwei, fassungZwei, notizKey2, notizId2, 1),
  });
} catch (err) {
  console.log(`  \x1b[31m✗\x1b[0m Kontopaket für den zweiten Anlauf  (abgewiesen: ${(err as Error).message})`);
  fehler++;
}
pruef('Vor dem Zurücksetzen liegt wieder ein Kontopaket', roheKontopakete(KONTO), 1);

users.resetPassword(KONTO, FREMD);

pruefWahr('Danach gibt der Server keinen Kontoschlüssel mehr heraus', kontoschluessel.holen(KONTO) === null);
pruef('aktuelleFassung() sagt 0 — es gibt keinen Kontoschlüssel, also darf auch kein Paket dagegen geschrieben werden', kontoschluessel.aktuelleFassung(KONTO), 0);
pruefWahr(
  'Der Zähler in der Zeile läuft trotzdem weiter — eine spätere Fassung darf nie mit einer früheren zusammenfallen',
  (db.get<{ fassung: number }>('SELECT fassung FROM konto_schluessel WHERE user_id = ?', KONTO)?.fassung ?? 0) > fassungZwei,
);
pruef('Und kein Kontopaket bleibt liegen, das niemand mehr öffnen könnte (rohe Tabelle)', roheKontopakete(KONTO), 0);
pruef('notizenOhneKontoPaket schweigt jetzt — ohne Kontoschlüssel gäbe es nichts, womit sich die Lücke füllen ließe', notizen.notizenOhneKontoPaket(KONTO), []);
const aNachReset = await inhaltEntschluesseln(
  await geraetPaketAuspacken(geraetA.privateKey, jwkA, notizen.paketFuer(notizId2, KONTO)!.paket, notizKontext(notizId2, 1, KONTO, KONTO)),
  chiffrat2,
);
pruef('DER GERÄTEWEG TRÄGT WEITER — das ist der Sinn zweier unabhängiger Wege', aNachReset?.titel, TITEL2);

/* ── Ergebnis ─────────────────────────────────────────────────────────── */

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mJedes Gerät desselben Kontos öffnet dieselbe Notiz — allein über das Passwort. Der Server verwahrt dabei nur Hüllen.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
