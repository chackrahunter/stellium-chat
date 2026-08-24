/**
 * Prüft den Passwort-Tresor — gegen eine WEGWERFBARE Datenbank.
 *
 * Dieselbe Machart wie notizen-verschluesselung.mts und notiz-kontoschluessel.mts,
 * zu einem Lauf zusammengeführt, weil der Tresor beide Wege gleichzeitig
 * braucht (Geräteweg per ECDH zum Teilen, Kontoweg per Kontoschlüssel fürs
 * zweite Gerät derselben Person) und ein Vorfall an einem der beiden Wege
 * niemanden interessiert, der nur den anderen geprüft hat.
 *
 * Der Server bekommt in diesem Lauf, wie im echten Betrieb, an keiner Stelle
 * einen Klartext oder einen Schlüssel zu sehen — nur `chiffrat`, `iv`,
 * `daten`. Die Kryptografie hier ist NACHGEBAUT (node:crypto/webcrypto),
 * nicht aus lib/kontoschluessel.ts importiert: eine Prüfung, die den
 * geprüften Code als eigenen Maßstab nimmt, prüft nichts. Für den
 * Nachweis, dass die AUSGELIEFERTE lib/kontoschluessel.ts dieselbe Rechnung
 * macht, sorgt bereits notiz-kontoschluessel-pruefen.mjs (Teil 2) — sie
 * benutzt exakt dieselben Kontexte aus shared/vertraulich.ts wie hier, nur
 * mit einem anderen Präfix (passwortKontoKontext statt notizKontoKontext).
 *
 * TEIL A — Kryptografie und Dienst (services/passwoerter.ts, services/
 * kontoschluessel.ts): Anlegen, Geräteweg, Kontoweg (zweites Gerät),
 * Teilen, Ausschluss einer dritten Person, rohe Datenbank ohne Klartext,
 * Offenlegung ohne Wert.
 *
 * TEIL A3 — DIE ZWEI HÜLLEN. Das Öffnen der Liste darf kein Passwort
 * ergeben, das Holen des Geheimnisses muss genau eine Zeile schreiben, und
 * ein Eintrag aus dem Altbestand muss die Umstellung überstehen, ohne
 * zwischendurch unlesbar oder still falsch zu werden.
 *
 * WIE HIER GEMESSEN WIRD, UND WARUM SO
 *
 * Gezählt werden ROHE ZEILEN (`SELECT COUNT(*)`), nie die Ausgabe von
 * offenlegungenFuer() — dieselbe Lehre wie in Teil A2: der Lesefilter deckt
 * zu, was die Tabelle noch trägt.
 *
 * Und geprüft wird, was der Client nach dem Entschlüsseln IN DER HAND HÄLT,
 * nicht, ob irgendwo im Chiffrat zufällig Klartextbytes stehen. Ein
 * Byte-Suchlauf über die Datei ist in JEDER Fassung grün — auch in der, in
 * der die Liste das Passwort mitlieferte, denn verschlüsselt war es ja. Die
 * Frage ist nicht „steht es im Klartext da", sondern „bekommt man es, ohne
 * danach zu fragen".
 *
 * TEIL B — HTTP-Schicht (http/passwoerter.ts): dieselbe Lehre wie in
 * partnergruppen-routen.mts und rechte-eskalation.mts — ein Lauf gegen den
 * DIENST beweist nicht, dass die ROUTE dieselbe Schranke durchsetzt. Hier
 * lief `registerPasswoerter()` auf einer nackten Fastify-Instanz, mit
 * `app.inject()`, ohne Netzwerkport.
 *
 * Aufruf:  node scripts/passwort-tresor-pruefen.mjs
 */
import fs from 'node:fs';
import crypto, { webcrypto } from 'node:crypto';
import Fastify from 'fastify';
import {
  KONTO_KDF, KONTO_PAKET_ALG, KONTO_RUNDEN, kontoKekKontext, passwortKontoKontext,
  nutzlastLesen, nutzlastSchreiben, PAKET_ALG,
  type KontoPaket, type KontoSchluesselBlob, type SchluesselPaket,
} from '@stellium/shared';
import { config } from '../config.js';
import { db, initDb } from '../db/index.js';
import { hashPassword, signToken } from '../auth.js';
import * as passwoerter from '../services/passwoerter.js';
import * as kontoschluessel from '../services/kontoschluessel.js';
import * as vertraulich from '../services/vertraulich.js';
import * as users from '../services/users.js';
import { registerPasswoerter } from '../http/passwoerter.js';

initDb();

let fehler = 0;
const fehlgeschlagen: string[] = [];
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) { fehler++; fehlgeschlagen.push(name); }
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};
const pruefWahr = (name: string, ist: boolean) => pruef(name, ist, true);

/* WICHTIG für jede künftige Zeile hier: `pruef()` DRUCKT den Istwert bei
   einem Fehlschlag. Ein Passwort, ein Schlüssel oder eine Hülle geht deshalb
   NIE direkt hinein — nur Kennungen, Zahlen und zuvor zu einem
   Wahrheitswert verrechnete Aussagen (pruefWahr). Diese Regel gilt für
   diesen Prüflauf selbst genauso wie für die App, die er prüft. */

/* ── Dieselbe Rechnung wie im Browser, nur mit node:crypto/webcrypto ──── */

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (t: string) => new Uint8Array(Buffer.from(t, 'base64url'));
const sha256 = async (t: string) => new Uint8Array(await subtle.digest('SHA-256', enc.encode(t)));

async function paarErzeugen() {
  return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as Promise<webcrypto.CryptoKeyPair>;
}
async function oeffentlichesJwk(paar: webcrypto.CryptoKeyPair): Promise<string> {
  return JSON.stringify(await subtle.exportKey('jwk', paar.publicKey));
}
async function oeffentlichEinlesen(jwkText: string): Promise<webcrypto.CryptoKey> {
  return subtle.importKey('jwk', JSON.parse(jwkText), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function gemeinsamerSchluessel(eigenerPrivat: webcrypto.CryptoKey, fremdesJwk: string, kontext: string): Promise<webcrypto.CryptoKey> {
  const fremd = await oeffentlichEinlesen(fremdesJwk);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: fremd }, eigenerPrivat, 256);
  const roh = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode('stellium/vertraulich/paket/v1') },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function eintragKontext(eintragId: string, fassung: number, von: string, fuer: string): string {
  return `stellium/passworttresor/${eintragId}/${fassung}/${von}>${fuer}`;
}

async function paketPacken(von: string, vonPrivat: webcrypto.CryptoKey, fuerJwk: string, key: webcrypto.CryptoKey, kontext: string): Promise<SchluesselPaket> {
  const roh = await subtle.exportKey('raw', key);
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

/* — Kontoweg, wortgleiche Rechnung zu lib/kontoschluessel.ts — */

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
  const vorspann = enc.encode('stellium/konto/abdruck/v1');
  const zusammen = new Uint8Array(vorspann.length + roh.length);
  zusammen.set(vorspann, 0); zusammen.set(roh, vorspann.length);
  return b64u(new Uint8Array(await subtle.digest('SHA-256', zusammen)));
}
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
async function eintragHuelle(kontoRoh: Uint8Array, eintragId: string, fassung: number) {
  const zwischen = await subtle.importKey('raw', kontoRoh, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(passwortKontoKontext(eintragId, fassung)), info: enc.encode('stellium/passwort/konto/v1') },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
async function kontoPaketPacken(kontoRoh: Uint8Array, kontoFassung: number, key: webcrypto.CryptoKey, eintragId: string, fassung: number): Promise<KontoPaket> {
  const roh = await subtle.exportKey('raw', key);
  const huelle = await eintragHuelle(kontoRoh, eintragId, fassung);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return { alg: KONTO_PAKET_ALG, kontoFassung, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) };
}
async function kontoPaketAuspacken(kontoRoh: Uint8Array, paket: KontoPaket, eintragId: string, fassung: number) {
  const huelle = await eintragHuelle(kontoRoh, eintragId, fassung);
  const roh = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten));
  return subtle.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/* — Inhalt: ZWEI Hüllen, wie im Browser (lib/passwoerter.ts) —
 *
 * `Schaufenster` ist, was die Liste zeigt — und hat kein Passwortfeld. Das
 * ist hier keine Bequemlichkeit, sondern der Maßstab: bekäme dieser Lauf
 * eine Hülle mit `passwort` darin, fiele es an den Prüfungen unten auf. */

interface Schaufenster { label: string; benutzername: string; notiz: string; url: string; totpKontoId: string | null }
/** Die alte Form von VOR der Trennung — nur noch für den Altbestand-Teil. */
interface AlteHuelle extends Schaufenster { passwort: string }

/** Wortgleich zu GEHEIM_BLOCK in lib/passwoerter.ts. Der Grund steht dort:
 *  ohne Auffüllen verriete die Chiffratlänge die Passwortlänge — etwas, das
 *  die eine gemeinsame Hülle nie preisgab. */
const GEHEIM_BLOCK = 256;
function geheimKlartext(passwort: string): Uint8Array {
  const roh = enc.encode(JSON.stringify({ passwort }));
  const laenge = Math.max(GEHEIM_BLOCK, Math.ceil(roh.length / GEHEIM_BLOCK) * GEHEIM_BLOCK);
  const voll = new Uint8Array(laenge).fill(0x20);
  voll.set(roh, 0);
  return voll;
}

async function huelleVerschluesseln(fassung: number, key: webcrypto.CryptoKey, klar: Uint8Array) {
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, key, klar);
  return nutzlastSchreiben({ fassung, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) });
}
async function huelleLesen(key: webcrypto.CryptoKey, roh: string): Promise<Record<string, unknown> | null> {
  try {
    const nutzlast = nutzlastLesen(roh)!;
    const klar = await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(nutzlast.iv) }, key, unb64u(nutzlast.daten));
    return JSON.parse(dec.decode(klar));
  } catch {
    return null;
  }
}

const schaufensterVerschluesseln = (fassung: number, key: webcrypto.CryptoKey, w: Schaufenster) =>
  huelleVerschluesseln(fassung, key, enc.encode(JSON.stringify(w)));
const geheimnisVerschluesseln = (fassung: number, key: webcrypto.CryptoKey, passwort: string) =>
  huelleVerschluesseln(fassung, key, geheimKlartext(passwort));
/** Die eine alte Hülle mit allem drin — nur zum Herstellen von Altbestand. */
const alteHuelleVerschluesseln = (fassung: number, key: webcrypto.CryptoKey, h: AlteHuelle) =>
  huelleVerschluesseln(fassung, key, enc.encode(JSON.stringify(h)));

/** Das Geheimnis eines Eintrags ROH aus der Tabelle lesen und aufmachen —
 *  absichtlich AM DIENST VORBEI. `geheimnisAusliefern()` schriebe eine
 *  Offenlegungszeile, und die Zeilen sind hier der Messgegenstand: eine
 *  Prüfung, die selbst mitschreibt, kann nicht zählen. */
async function geheimnisRohLesen(key: webcrypto.CryptoKey, eintragId: string): Promise<string | null> {
  const zeile = db.get<{ chiffrat: string }>('SELECT chiffrat FROM passwort_geheimnisse WHERE eintrag_id = ?', eintragId);
  if (!zeile) return null;
  const roh = await huelleLesen(key, zeile.chiffrat);
  return roh && typeof roh.passwort === 'string' ? roh.passwort : null;
}

/* ══════════════════════════════════════════════════════════════════════
   TEIL A — Kryptografie und Dienst
   ══════════════════════════════════════════════════════════════════════ */

console.log('\n\x1b[1mTeil A — Verschlüsselung, Geräteweg, Kontoweg, Teilen, Ausschluss\x1b[0m');

const PROBE1 = 'probe1'; // besitzt den Eintrag, zwei Geräte
const PROBE2 = 'probe2'; // wird hinzugefügt
const PROBE3 = 'probe3'; // bleibt außen vor
const PASSWORT1 = 'ein-langes-passwort-fuer-probe1';

for (const [id, rolle] of [[PROBE1, 'member'], [PROBE2, 'member'], [PROBE3, 'member']] as const) {
  db.run(
    `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,0)`,
    id, id, id, hashPassword(id === PROBE1 ? PASSWORT1 : `${id}-passwort-lang-genug`), rolle,
  );
}

// Gerät A von probe1 — legt den Eintrag an.
const geraetA = await paarErzeugen();
const jwkA = await oeffentlichesJwk(geraetA);
vertraulich.schluesselMelden({ userId: PROBE1, jwk: jwkA, abdruck: 'abdruck-a' });

const paar2 = await paarErzeugen();
const jwk2 = await oeffentlichesJwk(paar2);
vertraulich.schluesselMelden({ userId: PROBE2, jwk: jwk2, abdruck: 'abdruck-2' });
// probe3 hinterlegt bewusst NIE einen Schlüssel.

const LABEL = 'Google — Firmenkonto';
const BENUTZERNAME = 'team@firma-probe.example';
const PASSWORTWERT = 'K9!mLxQ7#vR2wZpN';
const NOTIZWERT = 'Wiederherstellungscodes liegen im Safe im Büro.';
const URLWERT = 'https://accounts.google.com';
const SCHAUFENSTER: Schaufenster = { label: LABEL, benutzername: BENUTZERNAME, notiz: NOTIZWERT, url: URLWERT, totpKontoId: null };

const eintragId = `pw_${crypto.randomBytes(16).toString('hex')}`;
const eintragKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const chiffrat = await schaufensterVerschluesseln(1, eintragKey, SCHAUFENSTER);
const geheimChiffrat = await geheimnisVerschluesseln(1, eintragKey, PASSWORTWERT);

// Kontoschlüssel für probe1 einrichten — wie bei der Anmeldung.
const kontoRohA = crypto.randomBytes(32);
const fassungKonto = kontoschluessel.hinterlegen(PROBE1, await kontoUmschliessen(kontoRohA, PASSWORT1, PROBE1));

const eigenesPaket = await paketPacken(PROBE1, geraetA.privateKey, jwkA, eintragKey, eintragKontext(eintragId, 1, PROBE1, PROBE1));
const kontoPaket = await kontoPaketPacken(kontoRohA, fassungKonto, eintragKey, eintragId, 1);

console.log('\nAnlegen (Geräteweg UND Kontoweg gleich mit):');
const angelegt = passwoerter.anlegen({ id: eintragId, ownerId: PROBE1, chiffrat, geheimChiffrat, paket: eigenesPaket, kontoPaket });
pruef('Eintrag wurde angelegt', angelegt.id, eintragId);
pruef('Besitzende Person steht', angelegt.ownerId, PROBE1);

console.log('\nZweites Gerät desselben Kontos — nur über den Kontoweg, ohne ECDH:');
// Gerät B hat kein ECDH-Schlüsselpaar für diesen Test — es kennt nur das
// Passwort. Es leitet den Kontoschlüssel unabhängig neu her.
const blobFuerB = kontoschluessel.holen(PROBE1)!;
const huelleB = await passwortSchluessel(PASSWORT1, unb64u(blobFuerB.salz), blobFuerB.runden, PROBE1);
const kontoRohB = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(blobFuerB.iv) }, huelleB, unb64u(blobFuerB.daten)));
pruefWahr('Gerät B leitet AUS DEM PASSWORT denselben Kontoschlüssel her wie Gerät A', Buffer.from(kontoRohB).equals(kontoRohA));

// find() statt find()! — ein fehlendes Kontopaket ist ein Ergebnis, das diese
// Probe SELBST feststellen soll (siehe unten), kein Absturzgrund. Ein Wurf
// hier würde jede Zeile danach verschweigen, genau wie ueberKontoweg() in
// notiz-kontoschluessel.mts das für denselben Fall vermeidet.
const kontoPaketZeile = passwoerter.kontoPaketeFuerAlle(PROBE1).find((p) => p.eintragId === eintragId);
pruefWahr('Für Gerät B liegt beim Server ein Kontopaket für diesen Eintrag', Boolean(kontoPaketZeile));
const schluesselUeberKontoweg = kontoPaketZeile
  ? await kontoPaketAuspacken(kontoRohB, kontoPaketZeile.paket, eintragId, kontoPaketZeile.fassung)
  : null;
const gelesenUeberKontoweg = schluesselUeberKontoweg ? await huelleLesen(schluesselUeberKontoweg, angelegt.chiffrat) : null;
pruef('Gerät B liest denselben Benutzernamen — allein über das Passwort, ohne je den ECDH-Schlüssel von Gerät A gesehen zu haben', gelesenUeberKontoweg?.benutzername, BENUTZERNAME);
// Derselbe Schlüssel macht BEIDE Hüllen auf — die Trennung ist eine Frage
// der Auslieferung, keine zweite Kryptografie.
pruefWahr('Gerät B liest dasselbe Passwort zurück (Kontoweg, zweite Hülle)',
  schluesselUeberKontoweg !== null && await geheimnisRohLesen(schluesselUeberKontoweg, eintragId) === PASSWORTWERT);

console.log('\nTeilen mit probe2:');
const paketFuer2 = await paketPacken(PROBE1, geraetA.privateKey, jwk2, eintragKey, eintragKontext(eintragId, 1, PROBE1, PROBE2));
passwoerter.mitgliedHinzufuegen({ eintragId, ownerId: PROBE1, zielUserId: PROBE2, paket: paketFuer2 });
const nachTeilen = passwoerter.getEintrag(eintragId, PROBE1)!;
pruef('probe2 steht als Mitglied', nachTeilen.memberIds, [PROBE2]);

const paketFuerProbe2 = passwoerter.paketFuer(eintragId, PROBE2)!;
const schluesselProbe2 = await paketAuspacken(paar2.privateKey, jwkA, paketFuerProbe2.paket, eintragKontext(eintragId, paketFuerProbe2.fassung, PROBE1, PROBE2));
const gelesenVonProbe2 = await huelleLesen(schluesselProbe2, nachTeilen.chiffrat);
pruef('probe2 (geteilt) liest denselben Benutzernamen', gelesenVonProbe2?.benutzername, BENUTZERNAME);
pruefWahr('probe2 (geteilt) liest dasselbe Passwort (zweite Hülle)',
  await geheimnisRohLesen(schluesselProbe2, eintragId) === PASSWORTWERT);

console.log('\nprobe3 (nie geteilt) bekommt NICHTS:');
pruef('Kein Schlüsselpaket für probe3', passwoerter.paketFuer(eintragId, PROBE3), null);
pruef('getEintrag() liefert für probe3 nichts — nicht einmal das Etikett', passwoerter.getEintrag(eintragId, PROBE3), null);
pruefWahr('Der Eintrag taucht in probe3s Liste nicht auf', !passwoerter.listEintraege(PROBE3).some((e) => e.id === eintragId));

let probe3DarfHinzufuegen = false;
try {
  passwoerter.mitgliedHinzufuegen({ eintragId, ownerId: PROBE3, zielUserId: PROBE3, paket: eigenesPaket });
  probe3DarfHinzufuegen = true;
} catch { /* erwartet */ }
pruefWahr('probe3 kann sich nicht selbst hinzufügen (ist nicht die besitzende Person)', !probe3DarfHinzufuegen);

let probe3DarfLoeschen = false;
try {
  passwoerter.loeschen(eintragId, PROBE3);
  probe3DarfLoeschen = true;
} catch { /* erwartet */ }
pruefWahr('probe3 kann den Eintrag nicht löschen', !probe3DarfLoeschen);

/* ── Rohe Datenbank: kein Klartext, an keiner Stelle ──────────────────── */

console.log('\nRohe Datenbank — kein Klartext:');

const roheZeile = db.get<{ chiffrat: string }>('SELECT chiffrat FROM passwort_eintraege WHERE id = ?', eintragId)!;
pruefWahr('passwort_eintraege.chiffrat beginnt mit dem E2E-Kennzeichen "e1:"', roheZeile.chiffrat.startsWith('e1:'));
pruefWahr('passwort_eintraege.chiffrat enthält NICHT das Passwort im Klartext', !roheZeile.chiffrat.includes(PASSWORTWERT));
pruefWahr('passwort_eintraege.chiffrat enthält NICHT den Benutzernamen im Klartext', !roheZeile.chiffrat.includes(BENUTZERNAME));
pruefWahr('passwort_eintraege.chiffrat enthält NICHT die Notiz im Klartext', !roheZeile.chiffrat.includes(NOTIZWERT));

const alleTabellenzeilen = [
  ...db.all<any>('SELECT * FROM passwort_eintraege'),
  ...db.all<any>('SELECT * FROM passwort_mitglieder'),
  ...db.all<any>('SELECT * FROM passwort_schluessel_pakete'),
  ...db.all<any>('SELECT * FROM passwort_konto_pakete'),
  ...db.all<any>('SELECT * FROM passwort_offenlegungen'),
  ...db.all<any>('SELECT * FROM passwort_geheimnisse'),
].map((r) => JSON.stringify(r));
pruefWahr('Das Passwort steht in KEINER der sechs Tabellen', alleTabellenzeilen.every((z) => !z.includes(PASSWORTWERT)));
pruefWahr('Der Benutzername steht in KEINER der sechs Tabellen', alleTabellenzeilen.every((z) => !z.includes(BENUTZERNAME)));

// Nicht nur über SQL — auch die Datei selbst, byteweise. WAL-Checkpoint
// zuerst, sonst läge das eben erst Geschriebene noch in der -wal-Datei.
db.exec('PRAGMA wal_checkpoint(FULL)');
const rohDatei = fs.readFileSync(config.dbFile);
const alsBytesPasswort = Buffer.from(PASSWORTWERT, 'utf8');
const alsBytesBenutzername = Buffer.from(BENUTZERNAME, 'utf8');
pruefWahr('Die Datenbankdatei auf der Platte enthält das Passwort an KEINER Stelle', rohDatei.indexOf(alsBytesPasswort) === -1);
pruefWahr('Die Datenbankdatei auf der Platte enthält den Benutzernamen an KEINER Stelle', rohDatei.indexOf(alsBytesBenutzername) === -1);
for (const nebendatei of [`${config.dbFile}-wal`, `${config.dbFile}-journal`]) {
  if (!fs.existsSync(nebendatei)) continue;
  const inhalt = fs.readFileSync(nebendatei);
  pruefWahr(`${nebendatei.split('/').pop()} enthält das Passwort an KEINER Stelle`, inhalt.indexOf(alsBytesPasswort) === -1);
}

/* ── Offenlegung: WER, WANN — nie WAS ─────────────────────────────────── */

console.log('\nOffenlegung — vermerkt, aber ohne Wert:');

/* Zweimal HOLEN — und nicht mehr zweimal „melden". Die Zeile entsteht jetzt
   in geheimnisAusliefern(), also genau dann, wenn ein Passwort das Haus
   verlässt. Eine Funktion, die nur vermerkt, ohne etwas herauszugeben, gibt
   es nicht mehr; es gibt deshalb auch keine Zeile ohne Aushändigung. */
const offenlegungenVorher = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ?', eintragId)!.n;
const geholt1 = passwoerter.geheimnisAusliefern(eintragId, PROBE2);
passwoerter.geheimnisAusliefern(eintragId, PROBE2);
const offenlegungenNachher = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ?', eintragId)!.n;
pruef('Zwei Aushändigungen an probe2 sind vermerkt — roh gezählt', offenlegungenNachher - offenlegungenVorher, 2);
pruefWahr('… und was ausgehändigt wurde, war wirklich das Passwort (sonst zählte die Zeile nichts)',
  await huelleLesen(schluesselProbe2, geholt1.chiffrat).then((r) => r?.passwort === PASSWORTWERT));

const offenlegungsSpalten = db.all<any>('SELECT * FROM passwort_offenlegungen WHERE eintrag_id = ?', eintragId).map((r) => JSON.stringify(r));
pruefWahr('Keine Offenlegungszeile enthält das Passwort', offenlegungsSpalten.every((z) => !z.includes(PASSWORTWERT)));
pruefWahr('Keine Offenlegungszeile trägt mehr Spalten als id/eintrag_id/user_id/am', db.all<any>('PRAGMA table_info(passwort_offenlegungen)').map((c: any) => c.name).sort().join(',') === 'am,eintrag_id,id,user_id');

const offenlegungenFuerBesitzer = passwoerter.offenlegungenFuer(eintragId, PROBE1);
pruefWahr('Die besitzende Person sieht mindestens die zwei Offenlegungen von probe2', offenlegungenFuerBesitzer.filter((o) => o.userId === PROBE2).length >= 2);

let probe2SiehtOffenlegungen = false;
try {
  passwoerter.offenlegungenFuer(eintragId, PROBE2);
  probe2SiehtOffenlegungen = true;
} catch { /* erwartet */ }
pruefWahr('probe2 (nicht die besitzende Person) sieht den Offenlegungsverlauf NICHT', !probe2SiehtOffenlegungen);

let probe3SiehtOffenlegungen = false;
try {
  passwoerter.offenlegungenFuer(eintragId, PROBE3);
  probe3SiehtOffenlegungen = true;
} catch { /* erwartet */ }
pruefWahr('probe3 (fremd) sieht den Offenlegungsverlauf erst recht nicht', !probe3SiehtOffenlegungen);

/* ══════════════════════════════════════════════════════════════════════
   TEIL A2 — Ein Zurücksetzen schließt den Kontoweg WIRKLICH
   ══════════════════════════════════════════════════════════════════════

   WAS HIER GEPRÜFT WIRD UND WARUM ES BISHER NIEMAND SAH

   Der Tresor hat zwei Hälften eines Versprechens (shared/vertraulich.ts,
   KontoPaket): der Server GIBT nur Pakete heraus, deren `konto_fassung` zur
   aktuellen Zeile passt — UND er WIRFT beim Ersetzen des Kontoschlüssels
   alle alten weg. Die zweite Hälfte fehlte: `verwerfen()` räumte nur
   `notiz_konto_pakete` weg, `passwort_konto_pakete` blieb stehen.

   Der Lesefilter allein deckt das zu. Jede Abfrage über den Dienst kommt
   nach einem Zurücksetzen leer zurück — die Zeile ist ja gefiltert. Die
   Zeile STEHT aber weiter in der Datenbank, verpackt unter dem
   Kontoschlüssel aus dem ALTEN Passwort. Wer das alte Passwort kennt (nach
   einem Zurücksetzen wegen Verdachts ist das genau die Person, die man
   aussperren wollte) und an eine Sicherung von VORHER plus die heutige
   Platte kommt, rechnet damit das heutige Chiffrat auf.

   Diese Probe geht deshalb absichtlich AN DEN DIENSTEN VORBEI und zählt
   rohe Zeilen (`SELECT COUNT(*)`). Über `kontoPaketeFuerAlle()` wäre sie in
   jeder Fassung grün gewesen — genau das ist die Falle, die hier vermieden
   wird.

   Und sie ist an keiner Stelle ein Byte-Suchlauf über die Datei: dass das
   Passwort nirgends im Klartext steht, war NIE das Problem. Das Problem war
   eine Zeile, die richtig aussieht und mit dem falschen Schlüssel zu öffnen
   ist. */

console.log('\n\x1b[1mTeil A2 — Zurücksetzen räumt jeden Kontoweg weg\x1b[0m');

const PASSWORT2_ALT = 'ein-langes-passwort-fuer-probe2';
db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(PASSWORT2_ALT), PROBE2);

/* probe2 richtet einen Kontoschlüssel ein — wie bei jeder Anmeldung — und
   legt sich für den geteilten Eintrag ein Kontopaket an. Das ist die Zeile,
   um die es geht: sie enthält den Eintragsschlüssel, verpackt unter dem
   Kontoschlüssel aus PASSWORT2_ALT. */
const kontoRoh2 = crypto.randomBytes(32);
const fassungKonto2 = kontoschluessel.hinterlegen(PROBE2, await kontoUmschliessen(kontoRoh2, PASSWORT2_ALT, PROBE2));
passwoerter.kontoPaketSetzen({
  eintragId, userId: PROBE2, fassung: 1,
  paket: await kontoPaketPacken(kontoRoh2, fassungKonto2, eintragKey, eintragId, 1),
});

const zeilenVorReset = db.get<{ n: number }>(
  'SELECT COUNT(*) AS n FROM passwort_konto_pakete WHERE user_id = ?', PROBE2,
)!.n;
pruef('Vor dem Zurücksetzen liegt für probe2 genau ein Tresor-Kontopaket in der rohen Tabelle', zeilenVorReset, 1);

/* Die SICHERUNG von vorher — eine Kopie der Zeile, wie sie in jedem
   nächtlichen Backup steht. Sie wird gleich zum Angriff benutzt: nicht um zu
   zeigen, dass ein Backup gefährlich ist (das ist es immer), sondern um
   festzuhalten, WAS die stehengebliebene Zeile wert gewesen wäre. */
const sicherungZeile = db.get<any>(
  'SELECT alg, iv, daten, konto_fassung, fassung FROM passwort_konto_pakete WHERE user_id = ? AND eintrag_id = ?',
  PROBE2, eintragId,
)!;
const sicherungBlob = kontoschluessel.holen(PROBE2)!;

/* Der eigentliche Vorgang: der Verdacht steht im Raum, das Passwort von
   probe2 gilt als kompromittiert, die Verwaltung setzt zurück. Das
   Einmal-Passwort wird bewusst NICHT gebunden und nirgends gedruckt. */
users.resetPassword(PROBE2, PROBE1);

const zeilenNachReset = db.get<{ n: number }>(
  'SELECT COUNT(*) AS n FROM passwort_konto_pakete WHERE user_id = ?', PROBE2,
)!.n;
pruef('NACH dem Zurücksetzen steht in passwort_konto_pakete keine Zeile mehr für probe2 — roh gezählt, nicht über den Dienst', zeilenNachReset, 0);

/* Dieselbe Frage für JEDE Tabelle, die unter dem Kontoschlüssel verpackt ist
   — nicht nur für die eine, an der der Fund hing. Die Liste kommt aus
   services/kontoschluessel.ts selbst; sie hier abzuschreiben hieße, die
   nächste vergessene Tabelle wieder nicht zu sehen. */
for (const tabelle of kontoschluessel.kontoPaketTabellen) {
  const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabelle} WHERE user_id = ?`, PROBE2)!.n;
  pruef(`… und in ${tabelle} ebenso wenig`, n, 0);
}

/* DIE LISTE SELBST. Der Fund war nicht "eine Zeile blieb stehen", sondern
   "eine TABELLE stand nicht in der Liste". Deshalb wird hier gegen das
   Schema geprüft statt gegen eine zweite Handliste: jede Tabelle, die auf
   `_konto_pakete` endet, MUSS in kontoPaketTabellen stehen. Eine dritte,
   die jemand künftig anlegt, fällt hier auf — bevor ein Zurücksetzen sie
   stehen lässt. */
const tabellenImSchema = db.all<{ name: string }>(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_konto\\_pakete' ESCAPE '\\'`,
).map((r) => r.name).sort();
pruef('Jede *_konto_pakete-Tabelle des Schemas steht in kontoPaketTabellen (sonst überlebt sie das nächste Zurücksetzen)',
  tabellenImSchema, [...kontoschluessel.kontoPaketTabellen].sort());

/* WAS DIE STEHENGEBLIEBENE ZEILE WERT GEWESEN WÄRE — der Grund, warum die
   Zählung oben eine 0 sein muss und keine 1.

   Nachgestellt wird der Weg mit der Sicherung: altes Passwort + alte Hülle
   ergeben den alten Kontoschlüssel, damit öffnet das gesicherte Kontopaket,
   und der darin liegende Eintragsschlüssel macht das HEUTIGE Chiffrat auf —
   `schluessel_fassung` wandert nur beim Entfernen eines Mitglieds, nicht bei
   einem Passwortwechsel. Diese Zeilen sind Beleg, nicht Prüfung: sie sind in
   jeder Fassung grün, weil sie auf der Kopie rechnen. Grün werden ODER
   rotwerden muss die Zählung darüber. */
const huelleAlt = await passwortSchluessel(PASSWORT2_ALT, unb64u(sicherungBlob.salz), sicherungBlob.runden, PROBE2);
const kontoRohAusSicherung = new Uint8Array(
  await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(sicherungBlob.iv) }, huelleAlt, unb64u(sicherungBlob.daten)),
);
const heutigesChiffrat = db.get<{ chiffrat: string; schluessel_fassung: number }>(
  'SELECT chiffrat, schluessel_fassung FROM passwort_eintraege WHERE id = ?', eintragId,
)!;
/* Der Beleg zielt jetzt auf die GEHEIMNIS-Hülle, nicht mehr auf das
   Schaufenster: die Trennung nimmt einer stehengebliebenen Kontopaket-Zeile
   nichts von ihrer Sprengkraft — sie trägt den Eintragsschlüssel, und der
   macht beide Hüllen auf. */
const schluesselAusSicherung = await kontoPaketAuspacken(
  kontoRohAusSicherung,
  { alg: sicherungZeile.alg, kontoFassung: sicherungZeile.konto_fassung, iv: sicherungZeile.iv, daten: sicherungZeile.daten },
  eintragId, sicherungZeile.fassung,
);
pruefWahr('BELEG (immer grün, rechnet auf einer Kopie): eine Sicherung derselben Zeile plus das alte Passwort öffnet das HEUTIGE Geheimnis — deshalb muss die Zählung oben 0 sein',
  await geheimnisRohLesen(schluesselAusSicherung, eintragId) === PASSWORTWERT);
pruef('… und die Schlüsselfassung des Eintrags hat sich durch das Zurücksetzen nicht bewegt (nur ein Mitgliederwechsel bewegt sie)',
  heutigesChiffrat.schluessel_fassung, sicherungZeile.fassung);

/* Der Kontoschlüssel selbst ist danach unbrauchbar — sonst wäre die
   Aufräumaktion oben nur die halbe Miete. */
pruef('Nach dem Zurücksetzen gibt es für probe2 keinen brauchbaren Kontoschlüssel mehr', kontoschluessel.holen(PROBE2), null);
pruef('… und aktuelleFassung() sagt 0, es darf also auch kein neues Paket dagegen geschrieben werden', kontoschluessel.aktuelleFassung(PROBE2), 0);

/* Der Geräteweg bleibt ausdrücklich unberührt: er hängt am privaten Teil des
   Geräts, nicht am Passwort. Verschwände er mit, verlöre probe2 durch ein
   Zurücksetzen den geteilten Eintrag ganz — das wäre kein Sicherheitsgewinn,
   sondern Datenverlust. */
pruefWahr('Das ECDH-Gerätepaket von probe2 steht weiterhin — ein Zurücksetzen nimmt niemandem den Geräteweg',
  Boolean(passwoerter.paketFuer(eintragId, PROBE2)));

/* Und dieselbe Frage für den ANDEREN Auslöser: ein Kontoschlüssel mit
   fremdem Abdruck ist ein ERSATZ, und auch dort muss der Tresor mitgeräumt
   werden (hinterlegenInTransaktion, Zweig `if (!derselbe)`). Getrennt
   geprüft, weil es ein zweiter Codepfad ist — eine Reparatur, die nur
   verwerfen() erwischt, ist keine. */
const PROBE4 = 'probe4';
db.run(
  `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,0)`,
  PROBE4, PROBE4, PROBE4, hashPassword('probe4-passwort-lang-genug'), 'member',
);
passwoerter.mitgliedHinzufuegen({
  eintragId, ownerId: PROBE1, zielUserId: PROBE4,
  paket: await paketPacken(PROBE1, geraetA.privateKey, jwkA, eintragKey, eintragKontext(eintragId, 1, PROBE1, PROBE4)),
});
const kontoRoh4 = crypto.randomBytes(32);
const fassung4 = kontoschluessel.hinterlegen(PROBE4, await kontoUmschliessen(kontoRoh4, 'probe4-passwort-lang-genug', PROBE4));
passwoerter.kontoPaketSetzen({
  eintragId, userId: PROBE4, fassung: 1,
  paket: await kontoPaketPacken(kontoRoh4, fassung4, eintragKey, eintragId, 1),
});
pruef('probe4 hat vor dem Schlüsselwechsel ein Tresor-Kontopaket', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_konto_pakete WHERE user_id = ?', PROBE4)!.n, 1);

// Ein GANZ anderer Kontoschlüssel: anderer Abdruck -> Ersatz, nicht Umschließen.
kontoschluessel.hinterlegen(PROBE4, await kontoUmschliessen(crypto.randomBytes(32), 'probe4-passwort-lang-genug', PROBE4));
for (const tabelle of kontoschluessel.kontoPaketTabellen) {
  const n = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${tabelle} WHERE user_id = ?`, PROBE4)!.n;
  pruef(`Ersatz des Kontoschlüssels räumt ${tabelle} für probe4 weg`, n, 0);
}

/* ══════════════════════════════════════════════════════════════════════
   TEIL A3 — Zwei Hüllen: die Liste gibt kein Passwort her
   ══════════════════════════════════════════════════════════════════════

   WAS HIER GEPRÜFT WIRD

   Vorher lag alles in EINER Hülle. Die Tafel zeigt Etiketten, musste also
   beim Öffnen genau die Hülle aufmachen, in der das Passwort steckte — und
   danach stand es im verdeckten Eingabefeld, für die Entwicklerwerkzeuge und
   für jedes Vorleseprogramm lesbar, ohne dass eine Zeile entstanden wäre.
   Der „Aufdecken"-Vermerk kam vom Client, bestenfalls nebenbei.

   WARUM DIE NAHELIEGENDE PRÜFUNG NICHTS TAUGT

   „Steht das Passwort im Klartext in der Datei?" war NIE das Problem — nein,
   stand es nie, auch vorher nicht, es war ja verschlüsselt. Ein Byte-Suchlauf
   ist in jeder Fassung grün und beweist deshalb nichts über diese Änderung.

   Die richtige Frage ist: WAS HÄLT EIN CLIENT IN DER HAND, der bloß die
   Liste geladen und alles aufgemacht hat, was sein Schlüssel öffnet? Genau
   das wird unten nachgestellt — mit dem echten Eintragsschlüssel, so weit
   entschlüsselt wie es nur geht — und darin darf kein Passwort sein.

   Gezählt wird durchgehend roh (`SELECT COUNT(*)`), nie über
   offenlegungenFuer(): dessen Filter deckt zu, was die Tabelle wirklich
   trägt (dieselbe Falle wie in Teil A2). */

console.log('\n\x1b[1mTeil A3 — Die Liste liefert Schaufenster, nie ein Passwort\x1b[0m');

/** Was ein Client nach dem Laden der Liste tatsächlich entschlüsselt hat —
 *  je Eintrag so weit, wie sein Schlüssel reicht. Genau dieser Satz ist der
 *  Messgegenstand: er ist das, was in der Oberfläche im Zustand landet. */
async function offenNachListenladen(userId: string, key: webcrypto.CryptoKey): Promise<string[]> {
  const offen: string[] = [];
  for (const e of passwoerter.listEintraege(userId)) {
    if (!e.chiffrat) continue;             // Altbestand: der Server gibt gar nichts heraus
    const inhalt = await huelleLesen(key, e.chiffrat);
    if (inhalt) offen.push(JSON.stringify(inhalt));
  }
  return offen;
}

const nachLaden = await offenNachListenladen(PROBE1, eintragKey);
pruefWahr('Die Liste ist überhaupt brauchbar — das Etikett kommt an (sonst prüfte das Folgende nichts)',
  nachLaden.some((h) => h.includes(LABEL)));
pruefWahr('KEIN Feld "passwort" in irgendetwas, das das Laden der Liste entschlüsselt hat',
  nachLaden.every((h) => !JSON.parse(h).hasOwnProperty('passwort')));
pruefWahr('… und der Passwortwert steht in nichts davon',
  nachLaden.every((h) => !h.includes(PASSWORTWERT)));

/* Dieselbe Frage für ein GETEILTES Mitglied mit eigenem Schlüsselweg: die
   Trennung darf nicht davon abhängen, auf welchem Weg jemand an den Schlüssel
   kam. */
const nachLadenProbe2 = await offenNachListenladen(PROBE2, schluesselProbe2);
pruefWahr('Auch bei probe2 (geteilt, Geräteweg) entschlüsselt das Laden der Liste kein Passwort',
  nachLadenProbe2.length > 0 && nachLadenProbe2.every((h) => !h.includes(PASSWORTWERT)));

/* Und die Gegenprobe: WER FRAGT, BEKOMMT — mit Zeile. Ohne diese Zeile wäre
   die Prüfung darüber trivial erfüllbar, indem man das Passwort einfach
   niemandem mehr gibt. */
const vorHolen = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ? AND user_id = ?', eintragId, PROBE1)!.n;
const geholt = passwoerter.geheimnisAusliefern(eintragId, PROBE1);
pruefWahr('Wer ausdrücklich fragt, bekommt das Passwort', await huelleLesen(eintragKey, geholt.chiffrat).then((r) => r?.passwort === PASSWORTWERT));
pruef('… und dadurch entsteht GENAU EINE Zeile, roh gezählt',
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ? AND user_id = ?', eintragId, PROBE1)!.n - vorHolen, 1);

/* probe3 steht nicht dabei — für ihn gibt es auch keinen Weg zum Geheimnis,
   und ein Fehlversuch hinterlässt keine Zeile (sonst ließe sich der Verlauf
   von außen vollschreiben). */
const vorFremdversuch = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ?', eintragId)!.n;
let probe3HoltGeheimnis = false;
try { passwoerter.geheimnisAusliefern(eintragId, PROBE3); probe3HoltGeheimnis = true; } catch { /* erwartet */ }
pruefWahr('probe3 (nie geteilt) bekommt das Geheimnis nicht', !probe3HoltGeheimnis);
pruef('… und sein Fehlversuch hinterlässt keine Zeile — roh gezählt',
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ?', eintragId)!.n - vorFremdversuch, 0);

/* ── Die Länge verrät nichts ──────────────────────────────────────────
   Eine Hülle um NUR das Passwort wäre so lang wie das Passwort — der Server
   erführe durch die Trennung etwas, das er aus der einen gemeinsamen Hülle
   nie herauslesen konnte. Verglichen werden hier ausschließlich ZAHLEN;
   die Werte selbst gehen nirgends in eine Ausgabe. */
const kurzesChiffrat = await geheimnisVerschluesseln(1, eintragKey, 'a');
const langesChiffrat = await geheimnisVerschluesseln(1, eintragKey, 'x'.repeat(120));
pruef('Ein sehr kurzes und ein sehr langes Passwort ergeben gleich lange Geheimnis-Hüllen (die Länge verrät nichts)',
  kurzesChiffrat.length, langesChiffrat.length);

/* WAS DIE ZEILE DARÜBER NICHT LEISTET, und wo die Lücke geschlossen wird.
   Sie rechnet auf der NACHGEBAUTEN Kryptografie dieses Laufs (siehe Kopf:
   das ist Absicht, eine Prüfung mit dem geprüften Code als Maßstab prüft
   nichts) — sie beweist also die Eigenschaft des Verfahrens, nicht, dass die
   ausgelieferte App sie anwendet. Diese beiden hängen an EINER Zahl, und die
   wird deshalb hier gegen die Quelle abgeglichen: nimmt jemand dort das
   Auffüllen heraus oder ändert die Blockgröße, wird es rot. */
const clientQuelle = fs.readFileSync(
  new URL('../../../desktop/src/lib/passwoerter.ts', import.meta.url), 'utf8',
);
const clientBlock = /const GEHEIM_BLOCK = (\d+);/.exec(clientQuelle)?.[1];
pruef('QUELLENABGLEICH: lib/passwoerter.ts füllt auf dieselbe Blockgröße auf wie dieser Lauf',
  Number(clientBlock), GEHEIM_BLOCK);
pruefWahr('QUELLENABGLEICH: und die Geheimnis-Hülle dort geht wirklich durch das Auffüllen',
  /geheimnisVerschluesseln[\s\S]{0,200}geheimKlartext\(/.test(clientQuelle));

/* ══════════════════════════════════════════════════════════════════════
   TEIL A4 — Der Altbestand: umstellen, ohne dass er je unlesbar wird
   ══════════════════════════════════════════════════════════════════════

   32 Fassungen lang gab es nur eine Hülle. Der Server kann diese Einträge
   nicht umstellen — er hat keinen der Schlüssel. Es muss also ein Gerät tun,
   das den Eintrag ohnehin schon öffnen kann, und dabei darf zu KEINEM
   Zeitpunkt ein Zustand entstehen, in dem das Passwort verloren ist (Hülle
   schon ohne, Geheimnis noch nicht da) oder doppelt steht (Geheimnis da,
   alte Hülle noch mit Passwort).

   Geprüft wird deshalb nach jedem Schritt an den ROHEN Zeilen. */

console.log('\n\x1b[1mTeil A4 — Altbestand: umstellen, durchgehend lesbar\x1b[0m');

const ALT_LABEL = 'PayPal — Firmenkonto';
const ALT_BENUTZER = 'zahlungen@firma-probe.example';
const ALT_PASSWORT = 'V3&hJ0pQ#sU7!bA5';
const altId = `pw_${crypto.randomBytes(16).toString('hex')}`;
const altKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

/* Genau so, wie eine App VOR der Trennung angelegt hätte: eine Hülle mit
   allem drin, kein `geheimChiffrat`. Das ist kein künstlicher Aufbau, es ist
   der Weg, den eine ältere App heute noch nimmt. */
const alteHuelle = await alteHuelleVerschluesseln(1, altKey, {
  label: ALT_LABEL, benutzername: ALT_BENUTZER, passwort: ALT_PASSWORT, notiz: '', url: '', totpKontoId: null,
});
passwoerter.anlegen({
  id: altId, ownerId: PROBE1, chiffrat: alteHuelle,
  paket: await paketPacken(PROBE1, geraetA.privateKey, jwkA, altKey, eintragKontext(altId, 1, PROBE1, PROBE1)),
});
pruef('Ein Eintrag ohne Geheimnis entsteht als Altbestand — keine Zeile in passwort_geheimnisse',
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_geheimnisse WHERE eintrag_id = ?', altId)!.n, 0);

const altInListe = passwoerter.listEintraege(PROBE1).find((e) => e.id === altId)!;
pruefWahr('Die Liste kennzeichnet ihn als Altbestand', altInListe.altbestand === true);
/* pruefWahr, nicht pruef: pruef() DRUCKT den Istwert bei einem Fehlschlag,
   und der Istwert wäre hier die alte Hülle. Die ist zwar Chiffrat und kein
   Klartext — aber die Regel am Kopf dieser Datei kennt bewusst keine
   Ausnahme für "ist ja verschlüsselt". */
pruefWahr('… und gibt seine alte Hülle NICHT heraus — sie enthielte das Passwort', altInListe.chiffrat === '');

/* Das ist die Prüfung, die vor der Änderung rot gewesen wäre: ein Client,
   der nur die Liste lädt, kommt an diesen Eintrag nicht heran — obwohl er
   den Schlüssel hat. Er MUSS fragen. */
const altNachLaden = await offenNachListenladen(PROBE1, altKey);
pruefWahr('Das Laden der Liste liefert vom Altbestand nichts Entschlüsselbares — auch nicht das Passwort',
  altNachLaden.every((h) => !h.includes(ALT_PASSWORT)));

/* Halb umgestellt: der Server lässt es nicht zu. Ein Umstellen ohne
   mitgeliefertes Geheimnis wäre Datenverlust — das Passwort stünde danach
   nirgends mehr. */
let halbUmgestellt = false;
try {
  passwoerter.speichern({
    eintragId: altId, userId: PROBE1, version: altInListe.version, getrennt: true,
    chiffrat: await schaufensterVerschluesseln(1, altKey, { label: ALT_LABEL, benutzername: ALT_BENUTZER, notiz: '', url: '', totpKontoId: null }),
  });
  halbUmgestellt = true;
} catch { /* erwartet */ }
pruefWahr('Umstellen OHNE das Geheimnis wird abgewiesen (sonst wäre das Passwort weg)', !halbUmgestellt);
pruefWahr('… und der Eintrag ist unverändert lesbar geblieben — die alte Hülle steht noch, mit allem drin',
  await huelleLesen(altKey, db.get<{ chiffrat: string }>('SELECT chiffrat FROM passwort_eintraege WHERE id = ?', altId)!.chiffrat)
    .then((r) => r?.passwort === ALT_PASSWORT));

/* Der echte Weg: holen (vermerkt, denn ein Passwort geht über die Leitung),
   zerlegen, in EINEM Aufruf zurückschreiben. */
const vorUmstellen = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ?', altId)!.n;
const altGeholt = passwoerter.geheimnisAusliefern(altId, PROBE1);
pruefWahr('Beim Altbestand liefert das Holen die ALTE Hülle — und sagt das auch', altGeholt.altbestand === true);
const altOffen = await huelleLesen(altKey, altGeholt.chiffrat);
pruefWahr('… die dieses Gerät zum Passwort aufmacht', altOffen?.passwort === ALT_PASSWORT);
pruef('… und das Holen ist vermerkt, weil dabei wirklich ein Passwort ausgehändigt wurde — roh gezählt',
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ?', altId)!.n - vorUmstellen, 1);

const umgestellt = passwoerter.speichern({
  eintragId: altId, userId: PROBE1, version: altInListe.version, getrennt: true,
  chiffrat: await schaufensterVerschluesseln(1, altKey, { label: ALT_LABEL, benutzername: ALT_BENUTZER, notiz: '', url: '', totpKontoId: null }),
  geheimChiffrat: await geheimnisVerschluesseln(1, altKey, ALT_PASSWORT),
});
pruefWahr('Das Umstellen mit beiden Hüllen geht durch', umgestellt.ok === true);
pruef('… und in passwort_geheimnisse steht jetzt genau eine Zeile', db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_geheimnisse WHERE eintrag_id = ?', altId)!.n, 1);
pruefWahr('… der Eintrag gilt nicht mehr als Altbestand', passwoerter.listEintraege(PROBE1).find((e) => e.id === altId)?.altbestand === false);

/* DURCHGEHEND LESBAR — beide Seiten einzeln nachgerechnet, an den rohen
   Zeilen, nicht am Dienst. */
const nachUmstellenSchaufenster = await huelleLesen(altKey, db.get<{ chiffrat: string }>('SELECT chiffrat FROM passwort_eintraege WHERE id = ?', altId)!.chiffrat);
pruef('Nach der Umstellung liest sich das Etikett unverändert', nachUmstellenSchaufenster?.label, ALT_LABEL);
pruefWahr('… und im Schaufenster steht kein Passwortfeld mehr', !Object.prototype.hasOwnProperty.call(nachUmstellenSchaufenster ?? {}, 'passwort'));
pruefWahr('… und der Passwortwert steht auch nicht darin', !JSON.stringify(nachUmstellenSchaufenster).includes(ALT_PASSWORT));
pruefWahr('… das Passwort selbst ist unverändert da, in der zweiten Hülle', await geheimnisRohLesen(altKey, altId) === ALT_PASSWORT);

const altNachUmstellung = await offenNachListenladen(PROBE1, altKey);
pruefWahr('Und jetzt liefert die Liste sein Etikett — ohne sein Passwort',
  altNachUmstellung.some((h) => h.includes(ALT_LABEL)) && altNachUmstellung.every((h) => !h.includes(ALT_PASSWORT)));

/* Rückfall verhindert: eine ältere App schickt ihre EINE Hülle. Auf einen
   getrennten Eintrag geschrieben stünde das Passwort wieder im Schaufenster
   — für jeden lesbar, der die Tafel bloß öffnet. */
const altVersion = passwoerter.listEintraege(PROBE1).find((e) => e.id === altId)!.version;
let alteAppSchreibt = false;
try {
  passwoerter.speichern({
    eintragId: altId, userId: PROBE1, version: altVersion,
    chiffrat: await alteHuelleVerschluesseln(1, altKey, {
      label: ALT_LABEL, benutzername: ALT_BENUTZER, passwort: ALT_PASSWORT, notiz: '', url: '', totpKontoId: null,
    }),
  });
  alteAppSchreibt = true;
} catch { /* erwartet */ }
pruefWahr('Eine App-Fassung von vor der Trennung darf einen getrennten Eintrag NICHT speichern', !alteAppSchreibt);
pruefWahr('… und das Schaufenster trägt danach immer noch kein Passwort',
  await huelleLesen(altKey, db.get<{ chiffrat: string }>('SELECT chiffrat FROM passwort_eintraege WHERE id = ?', altId)!.chiffrat)
    .then((r) => !JSON.stringify(r).includes(ALT_PASSWORT)));

/* ── Schlüsselwechsel nimmt beide Hüllen mit ─────────────────────────── */

passwoerter.mitgliedHinzufuegen({
  eintragId: altId, ownerId: PROBE1, zielUserId: PROBE2,
  paket: await paketPacken(PROBE1, geraetA.privateKey, jwk2, altKey, eintragKontext(altId, 1, PROBE1, PROBE2)),
});
const standVorWechsel = passwoerter.getEintrag(altId, PROBE1)!;
const neuerAltKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const neuesSchaufenster = await schaufensterVerschluesseln(2, neuerAltKey, { label: ALT_LABEL, benutzername: ALT_BENUTZER, notiz: '', url: '', totpKontoId: null });

let wechselOhneGeheimnis = false;
try {
  passwoerter.mitgliedEntfernen({
    eintragId: altId, ownerId: PROBE1, zielUserId: PROBE2, neueFassung: 2,
    chiffrat: neuesSchaufenster, version: standVorWechsel.version,
    pakete: [{ userId: PROBE1, paket: await paketPacken(PROBE1, geraetA.privateKey, jwkA, neuerAltKey, eintragKontext(altId, 2, PROBE1, PROBE1)) }],
  });
  wechselOhneGeheimnis = true;
} catch { /* erwartet */ }
pruefWahr('Ein Schlüsselwechsel ohne neu verpacktes Geheimnis wird abgewiesen (sonst bliebe das Passwort unter dem alten Schlüssel liegen)', !wechselOhneGeheimnis);
pruef('… und die Schlüsselfassung hat sich dabei nicht bewegt',
  db.get<{ f: number }>('SELECT schluessel_fassung AS f FROM passwort_eintraege WHERE id = ?', altId)!.f, 1);
pruefWahr('… und das Passwort ist unter dem ALTEN Schlüssel weiterhin zu öffnen', await geheimnisRohLesen(altKey, altId) === ALT_PASSWORT);

passwoerter.mitgliedEntfernen({
  eintragId: altId, ownerId: PROBE1, zielUserId: PROBE2, neueFassung: 2,
  chiffrat: neuesSchaufenster,
  geheimChiffrat: await geheimnisVerschluesseln(2, neuerAltKey, ALT_PASSWORT),
  version: standVorWechsel.version,
  pakete: [{ userId: PROBE1, paket: await paketPacken(PROBE1, geraetA.privateKey, jwkA, neuerAltKey, eintragKontext(altId, 2, PROBE1, PROBE1)) }],
});
pruef('Mit beiden Hüllen geht der Wechsel durch — die Schlüsselfassung wandert',
  db.get<{ f: number }>('SELECT schluessel_fassung AS f FROM passwort_eintraege WHERE id = ?', altId)!.f, 2);
pruef('… das Geheimnis trägt dieselbe neue Fassung (eine halb gedrehte Hülle wäre still unlesbar)',
  db.get<{ f: number }>('SELECT fassung AS f FROM passwort_geheimnisse WHERE eintrag_id = ?', altId)!.f, 2);
pruefWahr('… und beide Hüllen gehen unter dem NEUEN Schlüssel auf', await geheimnisRohLesen(neuerAltKey, altId) === ALT_PASSWORT);

/* ══════════════════════════════════════════════════════════════════════
   TEIL B — HTTP-Schicht: dieselbe Schranke, jetzt über die echte Route
   ══════════════════════════════════════════════════════════════════════ */

console.log('\n\x1b[1mTeil B — HTTP-Schicht: passwort.nutzen wird serverseitig durchgesetzt\x1b[0m');

const app = Fastify({ logger: false });
registerPasswoerter(app);

interface Antwort { statusCode: number; body: any }
async function anfrage(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pfad: string, token: string | null, payload?: unknown): Promise<Antwort> {
  const antwort = await app.inject({
    method, url: pfad,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: any;
  try { body = antwort.json(); } catch { body = undefined; }
  return { statusCode: antwort.statusCode, body };
}

const OHNE_RECHT = 'http-ohne-recht';
const MIT_RECHT = 'http-mit-recht';
const EIGENTUEMER_ROLLE = 'http-owner';
db.run(
  `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,'member',0)`,
  OHNE_RECHT, OHNE_RECHT, OHNE_RECHT, hashPassword('irgendein-langes-passwort-a'),
);
db.run(
  `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,'member',0)`,
  MIT_RECHT, MIT_RECHT, MIT_RECHT, hashPassword('irgendein-langes-passwort-b'),
);
db.run(
  `INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,'owner',0)`,
  EIGENTUEMER_ROLLE, EIGENTUEMER_ROLLE, EIGENTUEMER_ROLLE, hashPassword('irgendein-langes-passwort-c'),
);
users.setPermission(MIT_RECHT, 'passwort.nutzen', true, EIGENTUEMER_ROLLE);

pruefWahr('member ohne Zusage hat passwort.nutzen NICHT (nicht in ROLE_DEFAULTS)', !users.may(OHNE_RECHT, 'passwort.nutzen'));
pruefWahr('member mit Einzelzusage hat passwort.nutzen', users.may(MIT_RECHT, 'passwort.nutzen'));
pruefWahr('owner hat passwort.nutzen automatisch (ALLE)', users.may(EIGENTUEMER_ROLLE, 'passwort.nutzen'));

const tokenOhne = signToken(OHNE_RECHT);
const tokenMit = signToken(MIT_RECHT);
const tokenOwner = signToken(EIGENTUEMER_ROLLE);

console.log('\nOhne passwort.nutzen — jede Route weist ab, mit 403:');
const listeOhne = await anfrage('GET', '/api/passwoerter', tokenOhne);
pruef('GET /api/passwoerter ohne Recht → 403', listeOhne.statusCode, 403);
pruefWahr('… mit Wörterbuchkennung, nicht mit blankem Text', typeof listeOhne.body?.code === 'string' && listeOhne.body.code.startsWith('perm.'));

const anlegenOhne = await anfrage('POST', '/api/passwoerter', tokenOhne, { id: 'pw_x', chiffrat: 'e1:1:a:b', paket: { alg: PAKET_ALG, von: OHNE_RECHT, iv: 'a', daten: 'b' } });
pruef('POST /api/passwoerter ohne Recht → 403', anlegenOhne.statusCode, 403);

const geheimnisOhne = await anfrage('POST', `/api/passwoerter/${eintragId}/geheimnis`, tokenOhne);
pruef('POST .../geheimnis ohne Recht → 403 (der einzige Weg zum Passwort ist geschützt)', geheimnisOhne.statusCode, 403);
const offenlegungenNachAbweisung = db.get<{ n: number }>(
  'SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ? AND user_id = ?', eintragId, OHNE_RECHT,
)!.n;
pruef('… und die abgewiesene Anfrage hat KEINE Zeile hinterlassen (roh gezählt)', offenlegungenNachAbweisung, 0);

const ohneToken = await anfrage('GET', '/api/passwoerter', null);
pruef('Ganz ohne Anmeldung → 401', ohneToken.statusCode, 401);

console.log('\nMit passwort.nutzen — die Route lässt durch:');
const listeMit = await anfrage('GET', '/api/passwoerter', tokenMit);
pruef('GET /api/passwoerter mit Recht → 200', listeMit.statusCode, 200);
pruefWahr('… und liefert eine (anfangs leere) Liste, kein Fehlerobjekt', Array.isArray(listeMit.body?.eintraege));

const httpPaar = await paarErzeugen();
const httpJwk = await oeffentlichesJwk(httpPaar);
vertraulich.schluesselMelden({ userId: MIT_RECHT, jwk: httpJwk, abdruck: 'abdruck-http' });
const httpKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const HTTP_PASSWORT = 'Zq4$tW8!nD1&cE6v';
const httpChiffrat = await schaufensterVerschluesseln(1, httpKey, { label: 'HTTP-Probe', benutzername: 'x', notiz: '', url: '', totpKontoId: null });
const httpGeheim = await geheimnisVerschluesseln(1, httpKey, HTTP_PASSWORT);
const httpEintragId = `pw_${crypto.randomBytes(16).toString('hex')}`;
const httpPaket = await paketPacken(MIT_RECHT, httpPaar.privateKey, httpJwk, httpKey, eintragKontext(httpEintragId, 1, MIT_RECHT, MIT_RECHT));
const anlegenMit = await anfrage('POST', '/api/passwoerter', tokenMit, { id: httpEintragId, chiffrat: httpChiffrat, geheimChiffrat: httpGeheim, paket: httpPaket });
pruef('POST /api/passwoerter mit Recht → 200', anlegenMit.statusCode, 200);
pruef('… und der Eintrag trägt die richtige Kennung', anlegenMit.body?.eintrag?.id, httpEintragId);

/* Erst die Liste — sie ist der Weg, den das Öffnen der Tafel nimmt. Was
   hier herauskommt und sich entschlüsseln lässt, HAT der Client; alles
   andere muss er erfragen. */
const listeNachAnlegen = await anfrage('GET', '/api/passwoerter', tokenMit);
const httpAusListe = (listeNachAnlegen.body?.eintraege ?? []).find((e: any) => e.id === httpEintragId);
const alleHuellenAusListe: string[] = [];
for (const e of listeNachAnlegen.body?.eintraege ?? []) {
  const offen = await huelleLesen(httpKey, e.chiffrat ?? '');
  if (offen) alleHuellenAusListe.push(JSON.stringify(offen));
}
pruefWahr('GET /api/passwoerter liefert das Schaufenster dieses Eintrags (die Liste bleibt brauchbar)',
  alleHuellenAusListe.some((h) => h.includes('HTTP-Probe')));
pruefWahr('… und in NICHTS, was diese Liste liefert und dieser Client aufmachen kann, steht das Passwort',
  alleHuellenAusListe.every((h) => !h.includes(HTTP_PASSWORT)));
pruefWahr('… und die Antwort trägt das Passwort auch nicht irgendwo sonst mit (ganze Antwort, roh)',
  !JSON.stringify(listeNachAnlegen.body).includes(HTTP_PASSWORT));
pruefWahr('… und der Eintrag ist als getrennt gekennzeichnet, nicht als Altbestand', httpAusListe?.altbestand === false);

const offenlegungNachListe = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ?', httpEintragId)!.n;
pruef('Das Auflisten allein schreibt keine einzige Zeile — roh gezählt', offenlegungNachListe, 0);

/* Der alte Meldeweg ist fort. Eine ältere App ruft ihn noch; sie bekommt
   404 und fängt das ab. Wichtiger: NIEMAND kann darüber noch eine Zeile
   erzeugen, die keiner Aushändigung entspricht. */
const offenlegenAlt = await anfrage('POST', `/api/passwoerter/${httpEintragId}/offenlegen`, tokenMit);
pruef('POST .../offenlegen gibt es nicht mehr → 404 (kein Vermerk ohne Aushändigung)', offenlegenAlt.statusCode, 404);
pruef('… und die Anfrage hat entsprechend keine Zeile hinterlassen',
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ?', httpEintragId)!.n, 0);

const geheimnisMit = await anfrage('POST', `/api/passwoerter/${httpEintragId}/geheimnis`, tokenMit);
pruef('POST .../geheimnis mit Recht → 200', geheimnisMit.statusCode, 200);
pruefWahr('… und liefert eine Hülle, die dieser Client zum Passwort aufmacht',
  await huelleLesen(httpKey, geheimnisMit.body?.chiffrat ?? '').then((r) => r?.passwort === HTTP_PASSWORT));
pruef('… und GENAU EINE Zeile ist dadurch entstanden — roh gezählt',
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_offenlegungen WHERE eintrag_id = ? AND user_id = ?', httpEintragId, MIT_RECHT)!.n, 1);

await app.close();

/* ── Ergebnis ──────────────────────────────────────────────────────────── */

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen: ${fehlgeschlagen.join('; ')}\x1b[0m\n`
  : '\n\x1b[32mDas Laden der Liste entschlüsselt kein Passwort — auch nicht beim Altbestand; das Geheimnis gibt es nur einzeln, und jede Aushändigung steht als eigene Zeile in der Tabelle (roh gezählt, ohne Wertspalte); ein Altbestandseintrag bleibt über die Umstellung hinweg durchgehend lesbar, halb umgestellt geht nicht; Teilen und Ausschluss funktionieren; die Route erzwingt passwort.nutzen serverseitig.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
