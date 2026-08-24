/**
 * Prüft den Notzugang — „3 von 5", gegen eine wegwerfbare Datenbank.
 *
 * DIE FRAGE, DIE DIESER LAUF BEANTWORTET
 *
 * Der Notzugang soll zwei Dinge zugleich leisten, die einander widersprechen:
 * jemanden wieder hereinlassen, der sein Passwort vergessen hat, ohne dass
 * irgendjemand allein mitlesen kann. Aufgelöst wird das über eine Schwelle —
 * und eine Schwelle, die in Wirklichkeit bei zwei liegt oder die eine
 * Wiederherstellung mit einem falschen Schlüssel „gelingen" lässt, ist
 * schlimmer als gar keine, weil sie aussieht, als funktioniere sie.
 *
 * Deshalb wird hier nicht geprüft, ob die Oberfläche das Richtige anzeigt,
 * sondern ob die RECHNUNG stimmt und ob die Datenbank hinterher das enthält,
 * was sie enthalten muss:
 *
 *   · Drei beliebige der fünf Anteile ergeben denselben Notschlüssel.
 *   · Zwei ergeben ihn NIE — und die Prüfung sagt das nicht nur, sie zählt
 *     es (Teil 1 im Wrapper) erschöpfend nach.
 *   · Ein verfälschter Anteil wird ERKANNT, statt einen falschen Schlüssel
 *     zu liefern.
 *   · `fassung` des Kontoschlüssels bewegt sich bei einer Wiederherstellung
 *     NICHT — sie bewegt sich nur bei einem echten Schlüsselwechsel, und
 *     jedes Notiz- und Tresorpaket hängt daran.
 *   · Kein einziges Notiz- oder Tresorpaket geht dabei verloren.
 *
 * Die Kryptografie der App wird hier NACHGERECHNET, nicht eingebunden
 * (dieselbe Machart wie notiz-kontoschluessel.mts, siehe dort): eine
 * Prüfung, die den geprüften Code als Maßstab nimmt, prüft nichts. Die
 * einzige Ausnahme ist shared/geheimnisteilung.ts selbst — die IST der
 * Prüfgegenstand, und sie wird im Wrapper gegen veröffentlichte Tafeln und
 * gegen OpenSSL gemessen, also gegen Maßstäbe von außen.
 *
 * WAS HIER NIE AUF DEM BILDSCHIRM LANDET: kein Schlüssel, kein Anteil, kein
 * Passwort, kein Code. `pruef()` druckt bei einem Fehlschlag den Istwert —
 * deshalb geht durch pruef() nur, was auch auf einem Bildschirm stehen darf.
 * Alles andere wird VORHER zu einem Wahrheitswert verrechnet.
 *
 * Aufruf:  node scripts/notzugang-pruefen.mjs
 */
import crypto, { webcrypto } from 'node:crypto';
import {
  KONTO_ABDRUCK_VORSPANN, KONTO_KDF, KONTO_PAKET_ALG, KONTO_RUNDEN,
  NOTZUGANG_ABDRUCK_VORSPANN, NOTZUGANG_ANTEILE, NOTZUGANG_CODE_RUNDEN, NOTZUGANG_SCHWELLE,
  PAKET_ALG, kontoKekKontext, notizKontoKontext, notzugangAnteilKontext,
  notzugangBeitragKontext, notzugangKekKontext, nutzlastSchreiben, passwortKontoKontext,
  teilen, zusammenfuegen,
  type Anteil, type FluechtigesPaket, type KontoSchluesselBlob, type NotzugangAnteilBlob,
} from '@stellium/shared';
import { db, initDb } from '../db/index.js';
import { hashPassword } from '../auth.js';
import * as kontoschluessel from '../services/kontoschluessel.js';
import * as notzugang from '../services/notzugang.js';
import * as notizen from '../services/notizen.js';
import * as passwoerter from '../services/passwoerter.js';
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

async function wirftAb(name: string, tun: () => unknown): Promise<void> {
  let geworfen = false;
  try { await tun(); } catch { geworfen = true; }
  pruefWahr(name, geworfen);
}

/**
 * Wie wirftAb(), aber es muss die GEMEINTE Zählung abgewiesen haben.
 *
 * WARUM DAS NÖTIG IST: einrichten() wirft für sieben verschiedene Gründe
 * dieselbe Kennung (`fehler.notzugangUngueltig`) mit sieben verschiedenen
 * Sätzen. Ein wirftAb() ist damit grün, sobald IRGENDEINE der sieben
 * angeschlagen hat — auch dann, wenn die Zählung, um die es der Prüfzeile
 * ging, gar nicht erreicht wurde. Genau das war bei „Eine Person zweimal"
 * der Fall: die Stellenprüfung feuerte zuerst, und die Zählung im Namen der
 * Zeile hatte in Wahrheit keine einzige Prüfung.
 *
 * Verglichen wird der deutsche Rückfalltext, nicht die Kennung — die
 * Kennung ist bei allen sieben dieselbe. Kein Geheimnis geht hier durch:
 * die Sätze stehen wörtlich in services/notzugang.ts.
 */
async function wirftAbMit(name: string, teilText: string, tun: () => unknown): Promise<void> {
  let text = '';
  try { await tun(); } catch (err) { text = (err as Error).message; }
  pruef(name, text.includes(teilText) ? teilText : text, teilText);
}

/* ── Dieselben Rechnungen wie im Browser, nur mit node:crypto ─────────── */

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (t: string) => new Uint8Array(Buffer.from(t, 'base64url'));
const sha256 = async (t: string | Uint8Array) =>
  new Uint8Array(await subtle.digest('SHA-256', typeof t === 'string' ? enc.encode(t) : t));

const gleich = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/* — Kontoschlüssel: Hülle aus dem Passwort (lib/kontoschluessel.ts) — */

async function passwortKek(passwort: string, salz: Uint8Array, runden: number, userId: string) {
  const roh = await subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256,
  );
  const zwischen = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(kontoKekKontext(userId)), info: enc.encode('stellium/konto/kek/v1'),
    },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function kontoAbdruck(roh: Uint8Array): Promise<string> {
  const vorspann = enc.encode(KONTO_ABDRUCK_VORSPANN);
  const zusammen = new Uint8Array(vorspann.length + roh.length);
  zusammen.set(vorspann, 0); zusammen.set(roh, vorspann.length);
  return b64u(await sha256(zusammen));
}

async function kontoHuelleBauen(roh: Uint8Array, passwort: string, userId: string): Promise<KontoSchluesselBlob> {
  const salz = crypto.randomBytes(16);
  const kek = await passwortKek(passwort, salz, KONTO_RUNDEN, userId);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, kek, roh);
  return {
    kdf: KONTO_KDF, salz: b64u(salz), runden: KONTO_RUNDEN, alg: KONTO_PAKET_ALG,
    iv: b64u(iv), daten: b64u(new Uint8Array(daten)), fassung: 0,
    abdruck: await kontoAbdruck(roh),
  };
}

/* — Kontopakete für Notiz und Tresor — */

async function kontoPaketHuelle(kontoRoh: Uint8Array, kontext: string, info: string) {
  const zwischen = await subtle.importKey('raw', kontoRoh, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode(info) },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function kontoPaketPacken(kontoRoh: Uint8Array, kontext: string, info: string, roh: Uint8Array, kontoFassung: number) {
  const huelle = await kontoPaketHuelle(kontoRoh, kontext, info);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
  return { alg: KONTO_PAKET_ALG, kontoFassung, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) };
}

async function kontoPaketAuspacken(kontoRoh: Uint8Array, kontext: string, info: string, paket: { iv: string; daten: string }) {
  const huelle = await kontoPaketHuelle(kontoRoh, kontext, info);
  return new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten),
  ));
}

/* — Der Notzugang: Hülle aus dem Notschlüssel — */

async function notKek(notschluessel: Uint8Array, userId: string) {
  const zwischen = await subtle.importKey('raw', notschluessel, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(notzugangKekKontext(userId)), info: enc.encode('stellium/notzugang/kek/v1'),
    },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function notAbdruck(notschluessel: Uint8Array): Promise<Uint8Array> {
  const vorspann = enc.encode(NOTZUGANG_ABDRUCK_VORSPANN);
  const zusammen = new Uint8Array(vorspann.length + notschluessel.length);
  zusammen.set(vorspann, 0); zusammen.set(notschluessel, vorspann.length);
  return sha256(zusammen);
}

/* — Flüchtiges ECDH plus optionaler Code (lib/vertraulich.ts,
     gemeinsamerSchluesselMit) — */

const paarErzeugen = () => subtle.generateKey(
  { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
) as Promise<webcrypto.CryptoKeyPair>;

async function ableiten(privat: webcrypto.CryptoKey, fremdJwk: string, kontext: string, zusatz?: Uint8Array) {
  const fremd = await subtle.importKey('jwk', JSON.parse(fremdJwk), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: fremd }, privat, 256));
  const material = zusatz ? new Uint8Array(bits.length + zusatz.length) : bits;
  if (zusatz) { material.set(bits, 0); material.set(zusatz, bits.length); }
  const roh = await subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode('stellium/notzugang/paket/v1') },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function fluechtigVerschliessen(fremdJwk: string, kontext: string, klartext: Uint8Array, zusatz?: Uint8Array): Promise<FluechtigesPaket> {
  const paar = await paarErzeugen();
  const eph = JSON.stringify(await subtle.exportKey('jwk', paar.publicKey));
  const key = await ableiten(paar.privateKey, fremdJwk, kontext, zusatz);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, key, klartext);
  return { alg: 'aes-gcm', eph, iv: b64u(iv), daten: b64u(new Uint8Array(daten)) };
}

async function fluechtigOeffnen(privat: webcrypto.CryptoKey, paket: FluechtigesPaket, kontext: string, zusatz?: Uint8Array): Promise<Uint8Array | null> {
  try {
    const key = await ableiten(privat, paket.eph, kontext, zusatz);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(paket.iv) }, key, unb64u(paket.daten)));
  } catch {
    return null;
  }
}

async function codeBytes(code: string, kontext: string): Promise<Uint8Array> {
  const roh = await subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', salt: await sha256(kontext), iterations: NOTZUGANG_CODE_RUNDEN, hash: 'SHA-256' },
    roh, 256,
  ));
}

/* — Das Byteformat eines Anteils (lib/notzugang.ts, anteilBytes) — */

const ANTEIL_FORMAT = 1;
const ANTEIL_KOPF = 4;
const ABDRUCK_BYTES = 32;

function anteilBytes(anteil: Anteil, abdruck: Uint8Array, schwelle: number, anzahl: number): Uint8Array {
  const raus = new Uint8Array(ANTEIL_KOPF + anteil.werte.length + ABDRUCK_BYTES);
  raus[0] = ANTEIL_FORMAT; raus[1] = schwelle; raus[2] = anzahl; raus[3] = anteil.stelle;
  raus.set(anteil.werte, ANTEIL_KOPF);
  raus.set(abdruck, ANTEIL_KOPF + anteil.werte.length);
  return raus;
}

function anteilLesen(bytes: Uint8Array): { anteil: Anteil; abdruck: Uint8Array; schwelle: number } | null {
  if (bytes.length <= ANTEIL_KOPF + ABDRUCK_BYTES || bytes[0] !== ANTEIL_FORMAT) return null;
  return {
    anteil: { stelle: bytes[3]!, werte: bytes.slice(ANTEIL_KOPF, bytes.length - ABDRUCK_BYTES) },
    abdruck: bytes.slice(bytes.length - ABDRUCK_BYTES),
    schwelle: bytes[1]!,
  };
}

/* ── Bühne ────────────────────────────────────────────────────────────── */

const KONTO = 'konto1';
const PASSWORT = 'ein-langes-passwort-1';
const PASSWORT_NEU = 'ein-ganz-anderes-langes-passwort-2';
/* Fünf haltende Personen und die Rollen, mit denen sie im Team stehen. Zwei
   aus der Verwaltung sind erlaubt, drei wären es nicht — genau das prüft
   Teil 6. */
const HALTER = [
  { id: 'halter1', rolle: 'admin' },
  { id: 'halter2', rolle: 'member' },
  { id: 'halter3', rolle: 'member' },
  { id: 'halter4', rolle: 'teamlead' },
  { id: 'halter5', rolle: 'member' },
] as const;

function nutzerAnlegen(id: string, rolle: string): void {
  db.run(
    'INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,0)',
    id, id, id, hashPassword(`langes-passwort-${id}`), rolle,
  );
}

nutzerAnlegen(KONTO, 'member');
nutzerAnlegen('chefin', 'owner');
for (const h of HALTER) nutzerAnlegen(h.id, h.rolle);

/* Jede haltende Person hat ein Schlüsselpaar und meldet ihren öffentlichen
   Teil — genau wie schluesselBereitstellen() beim Start. */
const paare = new Map<string, webcrypto.CryptoKeyPair>();
const jwks = new Map<string, string>();
for (const h of [...HALTER.map((x) => x.id), KONTO]) {
  const paar = await paarErzeugen();
  paare.set(h, paar);
  const jwk = JSON.stringify(await subtle.exportKey('jwk', paar.publicKey));
  jwks.set(h, jwk);
  vertraulich.schluesselMelden({ userId: h, jwk, abdruck: `fp-${h}` });
}

/* ── Teil 1: Kontoschlüssel, eine Notiz und ein Tresoreintrag ─────────── */

console.log('\n\x1b[1mTeil 1 — Ein Konto mit Notiz und Tresoreintrag, beide über den Kontoweg\x1b[0m');

const kontoRoh = crypto.randomBytes(32);
const fassungAnfang = kontoschluessel.hinterlegen(KONTO, await kontoHuelleBauen(kontoRoh, PASSWORT, KONTO));
pruef('Der Kontoschlüssel steht in Fassung 1', fassungAnfang, 1);

const notizId = `nz_${crypto.randomBytes(16).toString('hex')}`;
const notizKey = crypto.randomBytes(32);
notizen.anlegen({
  id: notizId, ownerId: KONTO,
  chiffrat: nutzlastSchreiben({ fassung: 1, iv: b64u(crypto.randomBytes(12)), daten: b64u(crypto.randomBytes(48)) }),
  paket: { alg: PAKET_ALG, von: KONTO, iv: b64u(crypto.randomBytes(12)), daten: b64u(crypto.randomBytes(48)) },
});
notizen.kontoPaketSetzen({
  notizId, userId: KONTO, fassung: 1,
  paket: await kontoPaketPacken(kontoRoh, notizKontoKontext(notizId, 1), 'stellium/notiz/konto/v1', notizKey, fassungAnfang),
});

const eintragId = `pw_${crypto.randomBytes(16).toString('hex')}`;
const eintragKey = crypto.randomBytes(32);
passwoerter.anlegen({
  id: eintragId, ownerId: KONTO,
  chiffrat: nutzlastSchreiben({ fassung: 1, iv: b64u(crypto.randomBytes(12)), daten: b64u(crypto.randomBytes(48)) }),
  paket: { alg: PAKET_ALG, von: KONTO, iv: b64u(crypto.randomBytes(12)), daten: b64u(crypto.randomBytes(48)) },
});
passwoerter.kontoPaketSetzen({
  eintragId, userId: KONTO, fassung: 1,
  paket: await kontoPaketPacken(kontoRoh, passwortKontoKontext(eintragId, 1), 'stellium/passwort/konto/v1', eintragKey, fassungAnfang),
});

pruef('Ein Notiz-Kontopaket liegt da', notizen.kontoPaketeFuerAlle(KONTO).length, 1);
pruef('Ein Tresor-Kontopaket liegt da', passwoerter.kontoPaketeFuerAlle(KONTO).length, 1);

/* ── Teil 2: Den Notzugang einrichten ─────────────────────────────────── */

console.log('\n\x1b[1mTeil 2 — Notzugang einrichten: fünf Anteile, fünf Menschen\x1b[0m');

/** Einen frischen Notzugang bauen und hinterlegen. Gibt zurück, was nachher
 *  gebraucht wird — und ausdrücklich NICHT den Notschlüssel selbst. */
async function notzugangEinrichten(
  kontoBytes: Uint8Array, fassung: number, halterIds: readonly string[], wer: string = KONTO,
) {
  const notschluessel = crypto.randomBytes(32);
  const abdruck = await notAbdruck(notschluessel);
  const kek = await notKek(notschluessel, wer);
  const iv = crypto.randomBytes(12);
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, kek, kontoBytes);
  const anteile = teilen(notschluessel, NOTZUGANG_SCHWELLE, NOTZUGANG_ANTEILE);

  const bloecke: NotzugangAnteilBlob[] = [];
  for (const [i, halterId] of halterIds.entries()) {
    bloecke.push({
      halterId, stelle: anteile[i]!.stelle, halterAbdruck: `fp-${halterId}`,
      paket: await fluechtigVerschliessen(
        jwks.get(halterId)!, notzugangAnteilKontext(wer, halterId),
        anteilBytes(anteile[i]!, abdruck, NOTZUGANG_SCHWELLE, NOTZUGANG_ANTEILE),
      ),
    });
  }
  const huelle = {
    alg: KONTO_PAKET_ALG, iv: b64u(iv), daten: b64u(new Uint8Array(daten)),
    kontoAbdruck: await kontoAbdruck(kontoBytes), kontoFassung: fassung,
    schwelle: NOTZUGANG_SCHWELLE, anteile: NOTZUGANG_ANTEILE,
  };
  return { huelle, bloecke, abdruck, anteile };
}

const eingerichtet = await notzugangEinrichten(kontoRoh, fassungAnfang, HALTER.map((h) => h.id));
notzugang.einrichten(KONTO, eingerichtet.huelle, eingerichtet.bloecke);

const stand = notzugang.standFuer(KONTO);
pruefWahr('Der Notzugang steht', stand.eingerichtet);
pruef('Fünf Anteile, drei nötig', [stand.anteile, stand.schwelle], [NOTZUGANG_ANTEILE, NOTZUGANG_SCHWELLE]);
pruef('Alle fünf sind brauchbar', stand.brauchbar, 5);
/* HIER STAND EINE ZEILE, DIE NICHTS MESSEN KONNTE: „Die Fassung des
   Kontoschlüssels hat sich davon NICHT bewegt". einrichten() schreibt
   überhaupt nie in `konto_schluessel` — die Zeile war grün, bevor sie lief,
   und wäre auch dann grün geblieben, wenn die Fassungsprüfung in
   einrichten() ersatzlos entfallen wäre. Dass sich die Fassung bei einer
   WIEDERHERSTELLUNG nicht bewegt, ist die eigentliche Zusage, und sie wird
   in Teil 5 an einem echten Vorgang gemessen.

   An ihrer Stelle steht jetzt die Prüfung, die in einrichten() bisher
   niemand angefasst hat: die Hülle muss die HEUTIGE Fassung nennen. Teil 7
   verdreht nur den Abdruck; eine Hülle mit richtigem Abdruck und falscher
   Fassung ging überall durch. Sie gehörte zu einem Kontoschlüssel, den es
   so nicht mehr gibt — sie ginge auf und öffnete nichts. */
await wirftAbMit(
  'Eine Hülle, die eine ANDERE Fassung des Kontoschlüssels nennt, wird abgewiesen',
  'gehört nicht zum aktuellen Kontoschlüssel',
  async () => notzugang.einrichten(
    KONTO,
    { ...eingerichtet.huelle, kontoFassung: eingerichtet.huelle.kontoFassung + 1 },
    eingerichtet.bloecke,
  ),
);
pruef('… und der stehende Notzugang hat das unbeschadet überstanden',
  [notzugang.standFuer(KONTO).brauchbar, notzugang.gedeckterAbdruck(KONTO) === eingerichtet.huelle.kontoAbdruck],
  [5, true]);

/* ── Teil 3: Der Server sieht nichts davon ────────────────────────────── */

console.log('\n\x1b[1mTeil 3 — Was in der Datenbank steht: Chiffrat und Kennungen, kein Geheimnis\x1b[0m');

{
  /* Kein Rohbyte-Scan über die ganze Datei — der ginge in JEDER Fassung
     durch und belegt darum nichts (siehe Bericht). Stattdessen die
     Gegenprobe an genau den Spalten, die es angeht: Lässt sich die Nothülle
     mit dem ZUSAMMENGESETZTEN Schlüssel öffnen und mit sonst nichts, was in
     der Datenbank steht? */
  const zeile = db.get<{ daten: string }>('SELECT daten FROM konto_notzugang WHERE user_id = ?', KONTO)!;
  const mitFalschem = await (async () => {
    try {
      const kek = await notKek(crypto.randomBytes(32), KONTO);
      await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(notzugang.huelleHolen(KONTO)!.iv) }, kek, unb64u(zeile.daten));
      return true;
    } catch { return false; }
  })();
  pruefWahr('Die Nothülle geht mit einem beliebigen anderen Schlüssel NICHT auf', !mitFalschem);

  const anteilZeilen = db.all<{ daten: string; halter_id: string }>(
    'SELECT daten, halter_id FROM notzugang_anteile WHERE user_id = ?', KONTO,
  );
  pruef('Fünf Anteilszeilen', anteilZeilen.length, 5);
  const alleVerschieden = new Set(anteilZeilen.map((z) => z.daten)).size === 5;
  pruefWahr('Jede Zeile trägt ein eigenes Chiffrat — kein Anteil ist zweimal derselbe', alleVerschieden);

  const spuren = db.all<{ art: string }>('SELECT art FROM notzugang_protokoll WHERE user_id = ?', KONTO);
  pruefWahr('Das Einrichten steht in der Spur', spuren.some((s) => s.art === 'eingerichtet'));
}

/* ── Teil 4: Der WEG einer ausgesperrten Person, Schritt für Schritt ──── */

/**
 * WARUM DIESER TEIL EINEN SCHRITT MEHR HAT ALS FRÜHER
 *
 * Hier stand bis eben: `users.resetPassword(...)`, drei Prüfungen, weiter zur
 * Wiederherstellung. Diese Reihenfolge kann der ausgelieferte Client nicht.
 * Wer zurückgesetzt wird, trägt `must_change_password = 1`; der
 * Einrichtungsriegel (server/index.ts) lässt in diesem Zustand sechs Wege zu,
 * und App.tsx zeigt nichts als den Einrichtungsschirm. Der einzige Ausgang
 * ist `api.setup()` — also `users.completeSetup()`, und DAS ruft
 * verwerfen() ein ZWEITES Mal.
 *
 * Genau dort lag der Fehler, den diese Prüfung nie sehen konnte: beim zweiten
 * Aufruf war `daten` schon leer, der schonende Zweig fiel weg, und der harte
 * räumte jedes Notiz- und Tresorpaket weg. Die Wiederherstellung holte danach
 * den richtigen Kontoschlüssel zurück und fand nichts mehr, das er öffnen
 * konnte. Die alte Prüfung sprang über genau den Schritt, der zerstört —
 * und bescheinigte dem Weg, dass er trägt.
 *
 * Deshalb läuft hier ab jetzt die vollständige Folge: zurücksetzen,
 * Riegelzustand, Ersteinrichtung durch die Person selbst, und erst danach die
 * Wiederherstellung.
 */
console.log('\n\x1b[1mTeil 4 — Der ganze Weg einer ausgesperrten Person: zurücksetzen, einrichten, dann erst retten\x1b[0m');

const paketeZaehlen = () => [
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notiz_konto_pakete WHERE user_id = ?', KONTO)!.n,
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_konto_pakete WHERE user_id = ?', KONTO)!.n,
];
const schluesselZeile = () => db.get<{ abdruck: string; fassung: number; daten: string }>(
  'SELECT abdruck, fassung, daten FROM konto_schluessel WHERE user_id = ?', KONTO,
)!;

/* Schritt 1 — die Verwaltung setzt das Passwort zurück. */
users.resetPassword(KONTO, 'chefin');

pruefWahr('Es gibt keine brauchbare Passworthülle mehr', kontoschluessel.holen(KONTO) === null);
pruef('… aber Notiz- und Tresor-Kontopaket stehen noch in der Datenbank', paketeZaehlen(), [1, 1]);
pruefWahr('Der Notzugang zeigt weiter auf denselben Kontoschlüssel',
  notzugang.deckt(KONTO, eingerichtet.huelle.kontoAbdruck));
pruef('Der Abdruck des Kontoschlüssels steht noch, die Fassung auch',
  [schluesselZeile().abdruck === eingerichtet.huelle.kontoAbdruck, schluesselZeile().fassung],
  [true, fassungAnfang]);
pruefWahr('Das Schonen steht in der Spur',
  notzugang.protokollFuer(KONTO).some((z) => z.art === 'geschont'));

/* Schritt 2 — der Riegelzustand. Genau hier endet, was der Client tun kann:
   `must_change_password = 1` heißt Einrichtungsschirm, sonst nichts. */
pruef('Das Konto steht jetzt unter dem Einrichtungsriegel',
  db.get<{ v: number }>('SELECT must_change_password AS v FROM users WHERE id = ?', KONTO)!.v, 1);

/* Schritt 3 — die Person meldet sich mit dem Einmal-Passwort an und setzt im
   Einrichtungsschirm ihr neues. DAS ist der Aufruf, den diese Prüfung nie
   gemacht hat. */
users.completeSetup(KONTO, { newPassword: PASSWORT_NEU });

pruef('NACH DER ERSTEINRICHTUNG STEHEN BEIDE KONTOPAKETE NOCH DA', paketeZaehlen(), [1, 1]);
pruef('… der Abdruck ebenso, und die Fassung hat sich nicht bewegt',
  [schluesselZeile().abdruck === eingerichtet.huelle.kontoAbdruck, schluesselZeile().fassung],
  [true, fassungAnfang]);
pruefWahr('… und der Notzugang deckt weiterhin genau diesen Schlüssel',
  notzugang.deckt(KONTO, eingerichtet.huelle.kontoAbdruck));
pruef('Das zweite Verwerfen hat NICHTS getan — es steht auch keine zweite „geschont"-Zeile in der Spur',
  notzugang.protokollFuer(KONTO).filter((z) => z.art === 'geschont').length, 1);

/* Schritt 4 — der Riegel ist offen. Erst ab hier zeigt App.tsx die
   gewöhnliche Oberfläche, und erst ab hier ist die Tafel „Notzugang"
   überhaupt erreichbar. */
pruef('Der Einrichtungsriegel ist offen — die Tafel „Notzugang" ist erreichbar',
  db.get<{ v: number }>('SELECT must_change_password AS v FROM users WHERE id = ?', KONTO)!.v, 0);

/* Schritt 5 — was der Client als Nächstes tut: kontoSchluesselEinrichten()
   fragt GET /api/konto/schluessel. Beide Felder dieser Antwort müssen jetzt
   dasselbe sagen — sonst mintet die App einen frischen Schlüssel und räumt
   weg, was gerade gerettet werden soll. */
pruef('Die Antwort an die App: keine Hülle, aber eine Wiederherstellung steht aus',
  [kontoschluessel.holen(KONTO) === null, kontoschluessel.notzugangWartet(KONTO)],
  [true, true]);

/* Fail closed, und zwar in DIESEM Zustand: hier war die alte Sicherung tot,
   weil sie am `abdruck` hing, den der harte Zweig gerade geleert hatte. */
await wirftAb(
  'Ein FRISCHER Kontoschlüssel wird abgewiesen, solange der Notzugang aussteht',
  async () => kontoschluessel.hinterlegen(KONTO, await kontoHuelleBauen(crypto.randomBytes(32), PASSWORT_NEU, KONTO)),
);
pruef('… und die Pakete stehen danach unverändert da', paketeZaehlen(), [1, 1]);

/* ── Teil 4b: Eine Datenbank, in der es schon passiert ist ────────────── */

/**
 * Auf dem Server steht heute womöglich ein Konto, dem die Ersteinrichtung den
 * Abdruck schon weggeräumt hat — die Fassung ist hochgezählt, `abdruck` ist
 * leer, der Notzugang steht noch. Für DIESEN Zustand war die alte Sicherung
 * blind: sie fragte `konto_schluessel.abdruck`, und der war weg. Ein Gerät,
 * das nach eigener Regel einen frischen Kontoschlüssel mintete, kam damals
 * durch.
 *
 * Der Zustand wird hier von Hand hergestellt und danach wieder zurückgesetzt
 * — die folgenden Teile sollen dieselbe Bühne vorfinden wie bisher.
 */
console.log('\n\x1b[1mTeil 4b — Auch ohne Abdruck hält die Sperre (eine Datenbank von vorher)\x1b[0m');

{
  const vorher = schluesselZeile();
  db.run("UPDATE konto_schluessel SET abdruck = '', fassung = fassung + 1 WHERE user_id = ?", KONTO);

  pruefWahr('Ohne Abdruck sagt der Server weiterhin: hier wartet eine Wiederherstellung',
    kontoschluessel.notzugangWartet(KONTO));
  await wirftAb('… und ein FRISCHER Kontoschlüssel wird auch jetzt abgewiesen',
    async () => kontoschluessel.hinterlegen(KONTO, await kontoHuelleBauen(crypto.randomBytes(32), PASSWORT_NEU, KONTO)));

  /* Und die Gegenrichtung, ohne die die Sperre eine Aussperrung wäre: der
     ECHTE Schlüssel kommt zurück und wird als derselbe erkannt — an der
     Zeile des Notzugangs, der einzigen Auskunft, die hier noch steht. */
  const zurueckFassung = kontoschluessel.hinterlegen(KONTO, await kontoHuelleBauen(kontoRoh, PASSWORT_NEU, KONTO));
  pruef('Der ECHTE Schlüssel kommt durch — als Umschließen, ohne die Fassung zu bewegen',
    zurueckFassung, vorher.fassung + 1);
  pruef('… und kein Kontopaket ist dabei weggeräumt worden', paketeZaehlen(), [1, 1]);

  db.run(
    "UPDATE konto_schluessel SET salz = '', runden = 0, iv = '', daten = '', abdruck = ?, fassung = ? WHERE user_id = ?",
    vorher.abdruck, vorher.fassung, KONTO,
  );
  /* Der obige Rücksprung war schon immer nötig — er stellt nur
     `konto_schluessel` zurück. Seit kontoFassungNachziehen() (services/
     notzugang.ts) im heimkehrOhneAbdruck-Zweig auch die Notiz- und
     Tresorpakete sowie `konto_notzugang.konto_fassung` mitzieht (derselbe
     Zweig lief gerade eben, drei Zeilen weiter oben), reicht das allein
     nicht mehr: die Pakete tragen jetzt `vorher.fassung + 1`, obwohl
     `konto_schluessel.fassung` gerade wieder auf `vorher.fassung`
     zurückgesetzt wurde. Ohne diese drei Zeilen fände Teil 5 — der dieselbe
     Bühne unverändert vorfinden soll — seine eigenen Pakete über den echten
     Leseweg nicht mehr, denn der filtert exakt auf die aktuelle Fassung. */
  db.run('UPDATE notiz_konto_pakete SET konto_fassung = ? WHERE user_id = ? AND konto_fassung = ?',
    vorher.fassung, KONTO, vorher.fassung + 1);
  db.run('UPDATE passwort_konto_pakete SET konto_fassung = ? WHERE user_id = ? AND konto_fassung = ?',
    vorher.fassung, KONTO, vorher.fassung + 1);
  db.run('UPDATE konto_notzugang SET konto_fassung = ? WHERE user_id = ? AND konto_fassung = ?',
    vorher.fassung, KONTO, vorher.fassung + 1);
  /* KEINE Probe über kontoPaketeFuerAlle() hier: „geschont" heißt `daten`
     leer, und aktuelleFassung() (services/kontoschluessel.ts) meldet dann
     IMMER 0 — der echte Leseweg liefert in diesem Zustand grundsätzlich
     nichts, ganz gleich, unter welcher Fassung die Pakete liegen (genau
     dasselbe gilt für die COUNT(*)-Proben in Teil 4 oben). Die rohe
     Zeilenzahl unten belegt nur, dass nichts gelöscht wurde; dass die
     Pakete unter der RICHTIGEN Fassung liegen, zeigt erst Teil 5, sobald
     `daten` wieder gefüllt ist. */
  pruef('Bühne zurückgestellt: wieder geschont, Abdruck und Fassung wie vorher',
    [schluesselZeile().abdruck === eingerichtet.huelle.kontoAbdruck, schluesselZeile().fassung, kontoschluessel.holen(KONTO) === null],
    [true, fassungAnfang, true]);
  pruef('… und beide Pakete stehen noch (rohe Zeilenzahl), unter der ursprünglichen Fassung zurückgestellt',
    paketeZaehlen(), [1, 1]);
}

/* ── Teil 5: Die Wiederherstellung ────────────────────────────────────── */

console.log('\n\x1b[1mTeil 5 — Drei von fünf holen den Kontoschlüssel zurück\x1b[0m');

const CODE = 'ABCDEFGHJKMNPQRSTUVW2345';
const anfrage = notzugang.anfragen(KONTO, b64u(await sha256(CODE)));
pruefWahr('Eine Anfrage steht offen', anfrage.stand === 'offen');
pruef('Fünf Menschen bekommen eine Aufgabe',
  HALTER.filter((h) => notzugang.aufgabenFuer(h.id).length === 1).length, 5);

/** Eine haltende Person steuert ihren Anteil bei — so wie beitragen() in
 *  lib/notzugang.ts: eigenen Anteil öffnen, für die anfragende Person mit
 *  Code neu verschließen. */
async function beitragen(halterId: string, code = CODE, verdrehen = false): Promise<boolean> {
  const aufgabe = notzugang.aufgabenFuer(halterId)[0];
  if (!aufgabe) return false;
  const klartext = await fluechtigOeffnen(
    paare.get(halterId)!.privateKey, aufgabe.anteil, notzugangAnteilKontext(aufgabe.userId, halterId),
  );
  if (!klartext) return false;
  /* „Verdrehen" heißt: ein einzelnes Wertbyte kippen, NACHDEM der Anteil
     geöffnet wurde — genau der Fall, den AES-GCM nicht mehr abfängt, weil
     das Paket selbst unversehrt ist. Nur der Abdruck kann das noch
     erkennen. */
  if (verdrehen) klartext[ANTEIL_KOPF] ^= 0x01;
  const kontext = notzugangBeitragKontext(aufgabe.anfrageId, halterId, aufgabe.userId);
  const paket = await fluechtigVerschliessen(
    jwks.get(aufgabe.userId)!, kontext, klartext, await codeBytes(code, kontext),
  );
  notzugang.beitragen(halterId, aufgabe.anfrageId, paket, b64u(await sha256(code)));
  return true;
}

/** Was die anfragende Person aus den eingegangenen Beiträgen lesen kann. */
async function beitraegeLesen(code = CODE) {
  const raus: { anteil: Anteil; abdruck: Uint8Array; schwelle: number }[] = [];
  for (const b of notzugang.beitraegeHolen(KONTO, anfrage.id)) {
    const kontext = notzugangBeitragKontext(anfrage.id, b.halterId, KONTO);
    const klartext = await fluechtigOeffnen(
      paare.get(KONTO)!.privateKey, b.paket, kontext, await codeBytes(code, kontext),
    );
    if (!klartext) continue;
    const a = anteilLesen(klartext);
    if (a) raus.push(a);
  }
  return raus;
}

pruefWahr('Halter 1 steuert bei', await beitragen('halter1'));
pruefWahr('Halter 2 steuert bei', await beitragen('halter2'));

{
  const zweiAnteile = await beitraegeLesen();
  pruef('Zwei Beiträge sind eingegangen', zweiAnteile.length, 2);
  /* ZWEI ANTEILE ERGEBEN NICHTS. Nicht „fast nichts": zusammenfuegen()
     verweigert unter der Schwelle die Arbeit, und selbst wenn man es
     erzwänge (Schwelle 2 vorgetäuscht), käme ein Wert heraus, dessen
     Abdruck nicht stimmt. Beides wird hier geprüft — das erste ist die
     Sperre, das zweite der Beweis, dass die Sperre kein Zufall ist. */
  let verweigert = false;
  try { zusammenfuegen(zweiAnteile.map((a) => a.anteil), NOTZUGANG_SCHWELLE); } catch { verweigert = true; }
  pruefWahr('Zusammensetzen mit zwei Anteilen wird verweigert', verweigert);

  const erzwungen = zusammenfuegen(zweiAnteile.map((a) => a.anteil), 2);
  pruefWahr('Und erzwungen käme ein FALSCHER Schlüssel heraus — der Abdruck sagt es',
    !gleich(await notAbdruck(erzwungen), zweiAnteile[0]!.abdruck));
}

pruefWahr('Halter 3 steuert bei', await beitragen('halter3'));

const dreiAnteile = await beitraegeLesen();
pruef('Drei Beiträge sind eingegangen', dreiAnteile.length, 3);
pruefWahr('Alle drei nennen dieselbe Schwelle',
  dreiAnteile.every((a) => a.schwelle === NOTZUGANG_SCHWELLE));
pruefWahr('Alle drei tragen denselben Abdruck',
  dreiAnteile.every((a) => gleich(a.abdruck, dreiAnteile[0]!.abdruck)));

const zurueck = zusammenfuegen(dreiAnteile.map((a) => a.anteil), NOTZUGANG_SCHWELLE);
pruefWahr('DREI ANTEILE ERGEBEN DEN NOTSCHLÜSSEL — der nachgerechnete Abdruck stimmt',
  gleich(await notAbdruck(zurueck), dreiAnteile[0]!.abdruck));

/* Der Kontoschlüssel aus der Nothülle — und dann zurück unter das NEUE
   Passwort, mit demselben Abdruck. */
const huelleJetzt = notzugang.huelleHolen(KONTO)!;
const kontoZurueck = new Uint8Array(await subtle.decrypt(
  { name: 'AES-GCM', iv: unb64u(huelleJetzt.iv) }, await notKek(zurueck, KONTO), unb64u(huelleJetzt.daten),
));
pruefWahr('Aus der Nothülle kommt GENAU DERSELBE Kontoschlüssel wie am Anfang',
  gleich(kontoZurueck, new Uint8Array(kontoRoh)));

const fassungNachher = kontoschluessel.hinterlegen(KONTO, await kontoHuelleBauen(kontoZurueck, PASSWORT_NEU, KONTO));
pruef('DIE FASSUNG BLEIBT STEHEN — die Wiederherstellung ist ein Umschließen, kein Ersatz',
  fassungNachher, fassungAnfang);
pruef('… und der Kontoschlüssel ist wieder brauchbar', kontoschluessel.aktuelleFassung(KONTO), fassungAnfang);

pruef('Das Notiz-Kontopaket hat alles überlebt', notizen.kontoPaketeFuerAlle(KONTO).length, 1);
pruef('Das Tresor-Kontopaket ebenso', passwoerter.kontoPaketeFuerAlle(KONTO).length, 1);

{
  /* DIE EIGENTLICHE FRAGE DIESES LAUFS: geht danach noch etwas AUF?
     Bewusst ohne `!` und in einem try: fehlt das Paket oder passt der
     Schlüssel nicht, soll hier eine rote Zeile stehen und nicht ein
     TypeError, der den Lauf abbricht. Ein Prüflauf, der abstürzt, statt zu
     berichten, verschweigt gerade den Fall, für den es ihn gibt — und der
     Abbruch nähme jeder folgenden Zeile die Stimme. */
  const lesbar = async (
    paket: { fassung: number; paket: { iv: string; daten: string } } | undefined,
    kontext: string, info: string, soll: Buffer,
  ): Promise<boolean> => {
    if (!paket) return false;
    try {
      return gleich(await kontoPaketAuspacken(kontoZurueck, kontext, info, paket.paket), new Uint8Array(soll));
    } catch {
      return false;
    }
  };

  const p = notizen.kontoPaketeFuerAlle(KONTO)[0];
  pruefWahr('Und der NOTIZSCHLÜSSEL kommt darunter unverändert wieder heraus',
    await lesbar(p, notizKontoKontext(notizId, p?.fassung ?? 0), 'stellium/notiz/konto/v1', notizKey));

  const q = passwoerter.kontoPaketeFuerAlle(KONTO)[0];
  pruefWahr('… und der TRESORSCHLÜSSEL auch',
    await lesbar(q, passwortKontoKontext(eintragId, q?.fassung ?? 0), 'stellium/passwort/konto/v1', eintragKey));
}

/* DIE MELDUNG HÄNGT NICHT AM WOHLWOLLEN DES CLIENTS.
   Der Aufruf darunter (`einloesen`) kommt aus der App, NACHDEM sie den
   Kontoschlüssel schon zurückhat — eine App, die ihn wegließe, käme lautlos
   an fremde Daten. Der Server hält die Herausgabe deshalb dort fest, wo die
   Anteile wirklich über die Leitung gehen: beim Abholen der Beiträge
   (http/routes.ts ruft das direkt hinter beitraegeHolen()). */
{
  const gemeldet = notzugang.herausgabeVermerken(KONTO, anfrage.id);
  pruef('Die Herausgabe wird vermerkt, mit allen drei beitragenden Personen', gemeldet.length, 3);
  pruef('… ein zweiter Abruf meldet NICHT noch einmal', notzugang.herausgabeVermerken(KONTO, anfrage.id).length, 0);
  pruef('… und in der Spur steht je eine Zeile',
    notzugang.protokollFuer(KONTO).filter((z) => z.art === 'herausgegeben').length, 3);
}

/* ── Der Nachzügler ──────────────────────────────────────────────────
 *
 * Die vierte haltende Person steuert bei, NACHDEM die Schwelle schon
 * überschritten ist. Das ist kein Sonderfall, sondern der Regelfall: alle
 * fünf sind gleichzeitig angeschrieben worden, und keine weiß, wer schneller
 * war. Ihr Anteil geht mit heraus — `beitraegeHolen()` gibt ALLE Zeilen
 * zurück, hier wie in http/routes.ts.
 *
 * Bis eben erfuhr davon niemand. `herausgabeVermerken()` sperrte auf die
 * ANFRAGE: existierte irgendeine `herausgegeben`-Zeile, kam nichts mehr
 * zurück. Also keine Meldung an die vierte und fünfte Person, keine Zeile
 * mit ihrem Namen, und in der Tafel der besitzenden Person standen drei
 * Namen, während vier Anteile unterwegs waren. Ein Anteil, der über die
 * Leitung geht, ohne dass die haltende Person es je erfährt, ist genau das,
 * was diese Spur verhindern soll. */
pruefWahr('Halter 4 steuert bei — nach der Schwelle', await beitragen('halter4'));
{
  const vier = await beitraegeLesen();
  pruef('Der Server gibt jetzt VIER Anteile heraus', vier.length, 4);

  const nachgemeldet = notzugang.herausgabeVermerken(KONTO, anfrage.id);
  pruef('DER NACHZÜGLER WIRD GEMELDET — und nur er, nicht die drei von vorhin',
    nachgemeldet, ['halter4']);
  pruef('… in der Spur stehen jetzt vier Namen',
    notzugang.protokollFuer(KONTO).filter((z) => z.art === 'herausgegeben').length, 4);
  pruefWahr('… und einer davon ist die vierte Person',
    notzugang.protokollFuer(KONTO).some((z) => z.art === 'herausgegeben' && z.halterId === 'halter4'));
  pruef('… ein weiterer Abruf meldet wieder NICHTS — je Person genau einmal',
    notzugang.herausgabeVermerken(KONTO, anfrage.id).length, 0);
}

const beteiligte = notzugang.einloesen(KONTO, anfrage.id);
pruef('Beim Einlösen werden alle vier Beteiligten namentlich vermerkt', beteiligte.length, 4);
{
  const spur = notzugang.protokollFuer(KONTO);
  pruef('Für jede beitragende Person steht eine Zeile in der Spur',
    spur.filter((z) => z.art === 'beigetragen').length, 4);
  pruef('… und für jede eine Einlöse-Zeile mit Namen',
    spur.filter((z) => z.art === 'eingeloest' && z.halterId).length, 4);
  pruefWahr('Die Spur trägt keinerlei Chiffrat', spur.every((z) => !('daten' in z)));
  pruef('Die verbrauchten Beiträge sind weg',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notzugang_beitraege WHERE anfrage_id = ?', anfrage.id)!.n, 0);
}

/* ── Teil 6: Ein verfälschter Anteil ──────────────────────────────────── */

console.log('\n\x1b[1mTeil 6 — Ein verdrehter Anteil wird ERKANNT, nicht verrechnet\x1b[0m');

{
  const anfrage2 = notzugang.anfragen(KONTO, b64u(await sha256(CODE)));
  await beitragen('halter1');
  await beitragen('halter2');
  await beitragen('halter3', CODE, true); // ein Wertbyte gekippt

  const gelesen: { anteil: Anteil; abdruck: Uint8Array }[] = [];
  for (const b of notzugang.beitraegeHolen(KONTO, anfrage2.id)) {
    const kontext = notzugangBeitragKontext(anfrage2.id, b.halterId, KONTO);
    const klartext = await fluechtigOeffnen(
      paare.get(KONTO)!.privateKey, b.paket, kontext, await codeBytes(CODE, kontext),
    );
    const a = klartext && anteilLesen(klartext);
    if (a) gelesen.push(a);
  }
  pruef('Alle drei Beiträge gehen auf — die Verfälschung sitzt INNEN, AES-GCM merkt sie nicht',
    gelesen.length, 3);

  /* Alle drei tragen denselben mitgelieferten Abdruck — sonst wäre der
     Vergleich darunter gegen `gelesen[0]` eine Wette darauf, welchen man
     erwischt hat. */
  pruefWahr('Alle drei Beiträge nennen denselben Abdruck des Notschlüssels',
    gelesen.every((g) => gleich(g.abdruck, gelesen[0]!.abdruck)));

  const falsch = zusammenfuegen(gelesen.map((g) => g.anteil), NOTZUGANG_SCHWELLE);
  pruefWahr('DER ABDRUCK ERKENNT DAS — genau hier bricht lib/notzugang.ts ab, statt weiterzurechnen',
    !gleich(await notAbdruck(falsch), gelesen[0]!.abdruck));

  /* Die zweite Zeile hier behauptete bis eben WÖRTLICH DASSELBE wie die
     erste — derselbe Ausdruck, zwei Beschriftungen. Eine der beiden zählte
     mit und belegte nichts. Jetzt steht dort die FOLGE, um die es geht: mit
     diesem Wert lässt sich die Nothülle nicht öffnen. Der Abdruck ist die
     einzige Stelle, an der das VORHER auffällt; ohne ihn liefe die
     Wiederherstellung bis hierher und scheiterte erst an AES-GCM — nachdem
     der falsche Schlüssel schon hinterlegt worden wäre. */
  const huelleFalsch = notzugang.huelleHolen(KONTO)!;
  const gehtAuf = await (async () => {
    try {
      await subtle.decrypt(
        { name: 'AES-GCM', iv: unb64u(huelleFalsch.iv) },
        await notKek(falsch, KONTO), unb64u(huelleFalsch.daten),
      );
      return true;
    } catch { return false; }
  })();
  pruefWahr('… und mit diesem Wert geht die Nothülle auch nicht auf', !gehtAuf);

  /* Die Gegenprobe: mit einem verdrehten und den beiden anderen ECHTEN
     Anteilen — reicht nicht, weil jeder Punkt in die Kurve eingeht. */
  const nurEchte = gelesen.filter((g) => g.anteil.stelle !== 3);
  let verweigert = false;
  try { zusammenfuegen(nurEchte.map((g) => g.anteil), NOTZUGANG_SCHWELLE); } catch { verweigert = true; }
  pruefWahr('Die zwei übrigen echten Anteile allein reichen nicht — die Schwelle bleibt drei', verweigert);

  notzugang.abbrechen(KONTO, anfrage2.id);
  pruef('Die abgebrochene Anfrage hinterlässt keinen Beitrag',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notzugang_beitraege WHERE anfrage_id = ?', anfrage2.id)!.n, 0);
}

/* ── Teil 7: Die Zählungen, die niemand umgehen darf ──────────────────── */

console.log('\n\x1b[1mTeil 7 — Was der Server nicht annimmt\x1b[0m');

{
  const kontoJetzt = kontoZurueck;
  const fassung = kontoschluessel.aktuelleFassung(KONTO);

  const gut = await notzugangEinrichten(kontoJetzt, fassung, HALTER.map((h) => h.id));

  await wirftAb('Vier Anteile statt fünf', async () =>
    notzugang.einrichten(KONTO, gut.huelle, gut.bloecke.slice(0, 4)));

  /* EINE PERSON ZWEIMAL — und diesmal wirklich.
     Hier stand `[b0, b0, ...slice(2)]`: zwei Kopien desselben Blocks, beide
     mit stelle 1. Damit hatte die Aufstellung nur vier verschiedene Stellen,
     und die Stellenprüfung (`stellen.size !== NOTZUGANG_ANTEILE`) wies ab,
     bevor die Zählung im Namen dieser Zeile überhaupt erreicht war. Die
     Sperre gegen zwei Anteile in einer Hand — die, die aus „drei von fünf"
     sonst „zwei von vier" macht — hatte in diesem ganzen Lauf keine einzige
     Prüfung.

     Jetzt behält der zweite Block SEINE Stelle und bekommt nur die Kennung
     der ersten Person: fünf saubere Stellen, vier verschiedene Menschen. Und
     der Text der Abweisung belegt, dass wirklich diese Zählung angeschlagen
     hat und nicht wieder eine davor. */
  await wirftAbMit('Eine Person zweimal', 'nur einen Anteil halten', async () =>
    notzugang.einrichten(KONTO, gut.huelle, [
      gut.bloecke[0]!,
      { ...gut.bloecke[1]!, halterId: gut.bloecke[0]!.halterId, halterAbdruck: gut.bloecke[0]!.halterAbdruck },
      ...gut.bloecke.slice(2),
    ]));

  /* Die alte Aufstellung bleibt als eigene Zeile stehen — sie prüft die
     Stellen, und das ist eine andere Zählung. Nur heißt sie jetzt so. */
  await wirftAbMit('Zweimal dieselbe Stelle', 'keine sauberen Stellen', async () =>
    notzugang.einrichten(KONTO, gut.huelle, [gut.bloecke[0]!, gut.bloecke[0]!, ...gut.bloecke.slice(2)]));

  await wirftAb('Ein Anteil für die besitzende Person selbst', async () =>
    notzugang.einrichten(KONTO, gut.huelle, [
      { ...gut.bloecke[0]!, halterId: KONTO, halterAbdruck: `fp-${KONTO}` }, ...gut.bloecke.slice(1),
    ]));

  await wirftAb('Eine Hülle, die zu einem ANDEREN Kontoschlüssel gehört', async () =>
    notzugang.einrichten(KONTO, { ...gut.huelle, kontoAbdruck: await kontoAbdruck(crypto.randomBytes(32)) }, gut.bloecke));

  await wirftAb('Ein Anteil, dessen Schlüsselabdruck nicht zum hinterlegten passt', async () =>
    notzugang.einrichten(KONTO, gut.huelle, [
      { ...gut.bloecke[0]!, halterAbdruck: 'fp-erfunden' }, ...gut.bloecke.slice(1),
    ]));

  /* DREI aus der Verwaltung wären die Schwelle — und damit genau der Kreis,
     der ohnehin Passwörter zurücksetzt. */
  nutzerAnlegen('admin2', 'admin');
  nutzerAnlegen('admin3', 'admin');
  for (const id of ['admin2', 'admin3']) {
    const paar = await paarErzeugen();
    paare.set(id, paar);
    const jwk = JSON.stringify(await subtle.exportKey('jwk', paar.publicKey));
    jwks.set(id, jwk);
    vertraulich.schluesselMelden({ userId: id, jwk, abdruck: `fp-${id}` });
  }
  const zuVieleChefs = await notzugangEinrichten(kontoJetzt, fassung,
    ['halter1', 'admin2', 'admin3', 'halter2', 'halter3']);
  await wirftAb('Drei Anteile bei Inhaber/Administration — die Verwaltung erreichte die Schwelle allein',
    async () => notzugang.einrichten(KONTO, zuVieleChefs.huelle, zuVieleChefs.bloecke));

  // Und der gute Fall geht durch, damit die Abweisungen oben nicht bloß
  // „irgendetwas ist kaputt" bedeuten.
  notzugang.einrichten(KONTO, gut.huelle, gut.bloecke);
  pruef('Der saubere Notzugang wird angenommen', notzugang.standFuer(KONTO).brauchbar, 5);
}

/* ── Teil 8: Wer geht, senkt die Schwelle nicht heimlich ──────────────── */

console.log('\n\x1b[1mTeil 8 — Verlässt jemand die Firma, sagt es die Zahl\x1b[0m');

{
  db.run('UPDATE users SET disabled = 1 WHERE id = ?', 'halter5');
  const s = notzugang.standFuer(KONTO);
  pruef('Ein gesperrtes Konto zählt nicht mehr mit', s.brauchbar, 4);
  pruefWahr('… und die Tafel weiß, welche Person es war',
    s.halter.some((h) => h.halterId === 'halter5' && !h.aktiv));

  /* Ein gewechseltes Schlüsselpaar ist derselbe Fall: der Anteil ist für
     einen öffentlichen Teil verpackt, den es nicht mehr gibt. Ein WIRKLICH
     neues Paar, nicht nur ein neuer Abdruck — schluesselMelden() erkennt ein
     unverändertes JWK und tut dann zu Recht gar nichts. */
  const neuesPaar = await paarErzeugen();
  vertraulich.schluesselMelden({
    userId: 'halter4',
    jwk: JSON.stringify(await subtle.exportKey('jwk', neuesPaar.publicKey)),
    abdruck: 'fp-halter4-neu',
  });
  const s2 = notzugang.standFuer(KONTO);
  pruef('Ein gewechselter Schlüssel zählt ebenfalls nicht mehr mit', s2.brauchbar, 3);
  pruefWahr('… und wird als solcher benannt',
    s2.halter.some((h) => h.halterId === 'halter4' && h.aktiv && !h.schluesselPasst));

  db.run('UPDATE users SET disabled = 1 WHERE id = ?', 'halter3');
  const s3 = notzugang.standFuer(KONTO);
  pruef('Unter der Schwelle sagt die Zahl es klar', s3.brauchbar, 2);
  await wirftAb('… und eine neue Wiederherstellung wird gar nicht erst begonnen',
    async () => notzugang.anfragen(KONTO, b64u(await sha256(CODE))));
}

/* ── Teil 8b: Eine Beförderung verschiebt die Zählung ─────────────────── */

console.log('\n\x1b[1mTeil 8b — Wer befördert wird, bringt seinen Anteil mit\x1b[0m');

{
  db.run('UPDATE users SET disabled = 0 WHERE id IN (?,?)', 'halter3', 'halter5');

  const vorher = notzugang.standFuer(KONTO);
  pruef('Beim Einrichten war genau eine haltende Person aus der Verwaltung',
    [vorher.ausDerVerwaltung, vorher.verwaltungZuViele], [1, false]);

  /* Zwei Beförderungen später halten drei Verwaltende drei Anteile — genau
     die Aufstellung, die einrichten() ablehnt. Die Rollenvergabe wird
     deswegen NICHT abgelehnt: sie hat mit dem Notzugang nichts zu tun, und
     ein Fehlschlag dort wäre eine Überraschung an der falschen Stelle
     (Begründung an der Messstelle in services/notzugang.ts). */
  users.setRole('halter2', 'admin', 'chefin');
  users.setRole('halter3', 'admin', 'chefin');

  const nachher = notzugang.standFuer(KONTO);
  pruef('Nach zwei Beförderungen sind es drei — und die Tafel sagt es',
    [nachher.ausDerVerwaltung, nachher.verwaltungZuViele], [3, true]);
  pruefWahr('Der Notzugang trägt weiterhin — gesperrt wird deswegen nichts',
    notzugang.standFuer(KONTO).brauchbar >= NOTZUGANG_SCHWELLE);

  // Zurück auf Anfang, damit die folgenden Teile die alte Bühne vorfinden.
  users.setRole('halter2', 'member', 'chefin');
  users.setRole('halter3', 'member', 'chefin');
  pruef('Zurückgestuft zählt die Tafel wieder eine', notzugang.standFuer(KONTO).ausDerVerwaltung, 1);
}

/* ── Teil 9: Aufheben ist erlaubt, Einlösen nicht ─────────────────────── */

console.log('\n\x1b[1mTeil 9 — Zerstören darf eine Person allein, öffnen nie\x1b[0m');

{
  db.run('UPDATE users SET disabled = 0 WHERE id IN (?,?)', 'halter3', 'halter5');
  const a = notzugang.anfragen(KONTO, b64u(await sha256(CODE)));
  await beitragen('halter1');
  await wirftAb('Eine fremde Person bekommt die Beiträge nicht',
    async () => notzugang.beitraegeHolen('halter2', a.id));
  await wirftAb('Auch nicht die Verwaltung', async () => notzugang.beitraegeHolen('chefin', a.id));
  await wirftAb('Und einlösen kann sie erst recht nicht',
    async () => notzugang.einloesen('chefin', a.id));

  /* Mit EINEM Anteil ist nichts einzulösen — auch nicht für die besitzende
     Person selbst. Hier stand keine Zählung: eine Anfrage ließ sich mit null
     Beiträgen schließen, der Stand sprang auf „eingelöst", und in der Spur
     stand am Ende nicht eine einzige Zeile darüber. */
  pruef('Unter der Schwelle wird nichts herausgegeben und nichts vermerkt',
    notzugang.herausgabeVermerken(KONTO, a.id).length, 0);
  await wirftAb('… und einlösen lässt sich damit auch nicht',
    async () => notzugang.einloesen(KONTO, a.id));

  /* Absichtlich KEIN abbrechen() hier — die Anfrage `a` bleibt OFFEN, und ihr
     einziger Beitrag (von halter1, oben) bleibt stehen, als Chiffrat eines
     Anteils an einem Notschlüssel, den es gleich nicht mehr gibt. Zwei
     Dinge werden damit auf einmal geprüft: „eine offene Anfrage ist kein
     Hindernis" (Dateikopf, services/notzugang.ts) UND dass aufheben() selbst
     — nicht erst ein separates abbrechen() — den Beitrag mit wegräumt. */
  const beitraegeVorAufheben = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM notzugang_beitraege WHERE anfrage_id = ?', a.id,
  )!.n;
  pruef('Vor dem Aufheben steht der Beitrag noch (Ausgangslage der Probe)', beitraegeVorAufheben, 1);

  notzugang.aufheben(KONTO, 'chefin');
  pruefWahr('Die Verwaltung DARF den Notzugang aufheben — das öffnet nichts',
    !notzugang.standFuer(KONTO).eingerichtet);
  pruefWahr('… und es steht mit Namen in der Spur',
    notzugang.protokollFuer(KONTO).some((z) => z.art === 'aufgehoben' && z.halterId === 'chefin'));
  pruef('… die OFFENE Anfrage ist jetzt abgebrochen',
    db.get<{ stand: string }>('SELECT stand FROM notzugang_anfragen WHERE id = ?', a.id)?.stand, 'abgebrochen');
  pruef('… und ihr Beitrag ist mit weggeräumt — kein Chiffrat eines toten Notschlüssels bleibt liegen',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notzugang_beitraege WHERE anfrage_id = ?', a.id)!.n, 0);

  /* Danach brennt ein Zurücksetzen wieder alles nieder — genau so, wie es
     ohne Notzugang immer war. Das ist der Griff für ein DURCHGESICKERTES
     Passwort. */
  users.resetPassword(KONTO, 'chefin');
  pruef('Ohne Notzugang räumt das Zurücksetzen die Notiz-Kontopakete wieder weg',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notiz_konto_pakete WHERE user_id = ?', KONTO)!.n, 0);
  pruef('… und die des Tresors auch',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_konto_pakete WHERE user_id = ?', KONTO)!.n, 0);
}

/* ── Teil 10: Ein gelöschtes Konto lässt keinen Beitrag zurück ────────── */

console.log('\n\x1b[1mTeil 10 — Wird ein Konto gelöscht, bleibt kein Anteil und kein Beitrag liegen\x1b[0m');

{
  /* Direkt an den Zeilen und ohne Kryptografie: kontoBereinigen() sieht
     keinen Inhalt an, es räumt Zeilen weg. Geprüft wird genau das — und vor
     allem `notzugang_beitraege`, das dort bisher gar nicht vorkam und sich
     auf die Kaskade des Fremdschlüssels verließ. Die Kaskade ist hier
     lebendig; die Einstellung gilt aber je Verbindung, und was liegen
     bliebe, wäre Chiffrat eines Anteils an einem fremden Kontoschlüssel. */
  const zeit = Date.now();
  db.run(
    `INSERT INTO notzugang_anfragen (id, user_id, code_abdruck, stand, laeuft_ab, erstellt_am, eingeloest_am)
     VALUES (?,?,?,'offen',?,?,NULL)`,
    'nza_wegwerf', KONTO, 'abdruck-egal', zeit + 3600_000, zeit,
  );
  db.run(
    `INSERT INTO notzugang_beitraege (anfrage_id, halter_id, stelle, alg, eph, iv, daten, erstellt_am)
     VALUES (?,?,?,?,?,?,?,?)`,
    'nza_wegwerf', 'halter1', 1, 'aes-gcm', 'eph', 'iv', 'daten', zeit,
  );

  notzugang.kontoBereinigen(KONTO);

  pruef('Anteile, Hülle, Anfragen und Beiträge sind weg',
    [
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notzugang_anteile WHERE user_id = ?', KONTO)!.n,
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM konto_notzugang WHERE user_id = ?', KONTO)!.n,
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notzugang_anfragen WHERE user_id = ?', KONTO)!.n,
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notzugang_beitraege WHERE anfrage_id = ?', 'nza_wegwerf')!.n,
    ],
    [0, 0, 0, 0]);
}

/* ── Eine eigene Bühne für die Reihenfolgen ───────────────────────────── */

/**
 * Fünf frische haltende Personen — und warum nicht die fünf von oben.
 *
 * Teil 8 hat halter4 ein NEUES Schlüsselpaar gegeben (der Abdruck in der
 * Datenbank heißt seither `fp-halter4-neu`), Teil 8b hat Rollen hin- und
 * zurückgeschoben. `einrichten()` verlangt, dass der mitgeschickte Abdruck
 * der ist, den der Server kennt — mit den alten fünf ginge das nicht mehr
 * durch, und die folgenden Teile prüften dann eine Abweisung statt dessen,
 * was sie prüfen wollen.
 */
const NEUE_HALTER = ['neu1', 'neu2', 'neu3', 'neu4', 'neu5'] as const;
for (const h of NEUE_HALTER) {
  nutzerAnlegen(h, 'member');
  const paar = await paarErzeugen();
  paare.set(h, paar);
  const jwk = JSON.stringify(await subtle.exportKey('jwk', paar.publicKey));
  jwks.set(h, jwk);
  vertraulich.schluesselMelden({ userId: h, jwk, abdruck: `fp-${h}` });
}

const zaehlen = (id: string) => [
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notiz_konto_pakete WHERE user_id = ?', id)!.n,
  db.get<{ n: number }>('SELECT COUNT(*) AS n FROM passwort_konto_pakete WHERE user_id = ?', id)!.n,
];
const zeileVon = (id: string) => db.get<{ abdruck: string; fassung: number; daten: string }>(
  'SELECT abdruck, fassung, daten FROM konto_schluessel WHERE user_id = ?', id,
)!;

/**
 * Ein vollständiges Konto: Kontoschlüssel, ein Notiz-Kontopaket, ein
 * Tresor-Kontopaket, ein stehender Notzugang. Genau die Ausgangslage, in der
 * die Verwaltung vor der Frage steht, in welcher Reihenfolge sie aufräumt.
 */
async function buehne(id: string, passwort: string) {
  nutzerAnlegen(id, 'member');
  const roh = crypto.randomBytes(32);
  const fassung = kontoschluessel.hinterlegen(id, await kontoHuelleBauen(roh, passwort, id));

  const nId = `nz_${crypto.randomBytes(16).toString('hex')}`;
  notizen.anlegen({
    id: nId, ownerId: id,
    chiffrat: nutzlastSchreiben({ fassung: 1, iv: b64u(crypto.randomBytes(12)), daten: b64u(crypto.randomBytes(48)) }),
    paket: { alg: PAKET_ALG, von: id, iv: b64u(crypto.randomBytes(12)), daten: b64u(crypto.randomBytes(48)) },
  });
  notizen.kontoPaketSetzen({
    notizId: nId, userId: id, fassung: 1,
    paket: await kontoPaketPacken(roh, notizKontoKontext(nId, 1), 'stellium/notiz/konto/v1', crypto.randomBytes(32), fassung),
  });

  const eId = `pw_${crypto.randomBytes(16).toString('hex')}`;
  passwoerter.anlegen({
    id: eId, ownerId: id,
    chiffrat: nutzlastSchreiben({ fassung: 1, iv: b64u(crypto.randomBytes(12)), daten: b64u(crypto.randomBytes(48)) }),
    paket: { alg: PAKET_ALG, von: id, iv: b64u(crypto.randomBytes(12)), daten: b64u(crypto.randomBytes(48)) },
  });
  passwoerter.kontoPaketSetzen({
    eintragId: eId, userId: id, fassung: 1,
    paket: await kontoPaketPacken(roh, passwortKontoKontext(eId, 1), 'stellium/passwort/konto/v1', crypto.randomBytes(32), fassung),
  });

  const e = await notzugangEinrichten(roh, fassung, NEUE_HALTER, id);
  notzugang.einrichten(id, e.huelle, e.bloecke);
  return { roh, fassung, huelle: e.huelle };
}

/* ── Teil 11: Aufheben brennt nieder — in BEIDER Reihenfolge ──────────── */

/**
 * DER FUND, DEN DIESER TEIL FESTHÄLT
 *
 * Drei Stellen versprechen dasselbe: der Dateikopf von
 * services/notzugang.ts, der Kommentar an DELETE /api/admin/notzugang/:id in
 * http/routes.ts und der Warnsatz, den die Kontenliste der Verwaltung zeigt
 * (`team.notzugangVorhanden`). Alle drei sagen: bei einem DURCHGESICKERTEN
 * Passwort erst den Notzugang aufheben, dann zurücksetzen — dann brennt der
 * Kontoschlüssel wieder mit.
 *
 * Das stimmte in genau einer Reihenfolge. Wer zuerst das Passwort sperrte
 * (die naheliegende erste Handlung, wenn ein Passwort abhanden gekommen ist)
 * und DANACH die Warnung las und den Notzugang aufhob, stand am Ende mit
 * Notiz- und Tresorpaketen da, die unter einem Kontoschlüssel liegen, den das
 * durchgesickerte Passwort zusammen mit einer älteren Sicherung wieder
 * herleitet. Genau die Lage, die das Zurücksetzen beenden sollte.
 *
 * Gemessen wird deshalb nicht „aufheben tut etwas", sondern was am Ende in
 * der Datenbank STEHT — und das in beiden Reihenfolgen, weil eine Prüfung,
 * die nur die dokumentierte Reihenfolge läuft, genau den Fehler nicht sieht.
 */
console.log('\n\x1b[1mTeil 11 — Aufheben brennt nieder, in BEIDER Reihenfolge\x1b[0m');

{
  /* — Reihenfolge A: erst aufheben, dann zurücksetzen (die dokumentierte) — */
  const a = 'reihenfolgeA';
  const bA = await buehne(a, 'ein-langes-passwort-a');
  pruef('A: Ausgangslage — beide Kontopakete liegen da', zaehlen(a), [1, 1]);

  const verbranntA = notzugang.aufheben(a, 'chefin');
  pruefWahr('A: das Aufheben brennt NICHT — die Passworthülle steht, das Konto ist heil', !verbranntA);
  pruef('A: … also liegen die Pakete unverändert da', zaehlen(a), [1, 1]);
  pruef('A: … und der Kontoschlüssel ist weiter brauchbar',
    [kontoschluessel.holen(a) !== null, kontoschluessel.aktuelleFassung(a)], [true, bA.fassung]);

  users.resetPassword(a, 'chefin');
  pruef('A: das Zurücksetzen räumt beide Pakete weg — wie ohne Notzugang immer', zaehlen(a), [0, 0]);
  /* Der Abdruck wird VOR pruef() zu einem Wahrheitswert verrechnet und nicht
     roh übergeben — sonst stünde er bei einem Fehlschlag auf dem Bildschirm.
     Er verrät den Schlüssel zwar nicht (SHA-256 über 256 Bit Zufall), aber
     die Regel dieses Laufs ist, dass durch pruef() nur geht, was dort auch
     hingehört. Dieselbe Machart wie in Teil 4 und 4b. */
  pruef('A: … Abdruck leer, Fassung eins weiter',
    [zeileVon(a).abdruck === '', zeileVon(a).fassung], [true, bA.fassung + 1]);

  /* — Reihenfolge B: erst zurücksetzen, dann aufheben (die naheliegende) — */
  const b = 'reihenfolgeB';
  const bB = await buehne(b, 'ein-langes-passwort-b');

  users.resetPassword(b, 'chefin');
  pruef('B: das Zurücksetzen SCHONT — der Notzugang steht, beide Pakete bleiben', zaehlen(b), [1, 1]);
  pruef('B: … Hülle tot, Abdruck und Fassung aber unverändert',
    [zeileVon(b).daten === '', zeileVon(b).abdruck === bB.huelle.kontoAbdruck, zeileVon(b).fassung],
    [true, true, bB.fassung]);

  const verbranntB = notzugang.aufheben(b, 'chefin');
  pruefWahr('B: DAS AUFHEBEN HOLT DAS NIEDERBRENNEN NACH und meldet es zurück', verbranntB);
  pruef('B: … KEIN NOTIZ- UND KEIN TRESORPAKET BLEIBT ÜBRIG', zaehlen(b), [0, 0]);
  pruef('B: … der Abdruck ist weg und die Fassung eins weiter',
    [zeileVon(b).abdruck === '', zeileVon(b).fassung], [true, bB.fassung + 1]);
  pruefWahr('B: … und es steht mit Namen in der Spur',
    notzugang.protokollFuer(b).some((z) => z.art === 'verworfen' && z.halterId === 'chefin'));
  pruefWahr('B: … der Notzugang selbst ist ebenfalls weg',
    !notzugang.standFuer(b).eingerichtet && notzugang.gedeckterAbdruck(b) === null);

  /* B, FORTGESETZT: EIN ZWEITER AUFRUF — ein Skript, ein zweiter Klick, ein
     Wettlauf zweier Verwaltungen. Vorher lief aufheben() für JEDES Konto
     glatt durch, auch für eines ohne Notzugang, und `konto_schluessel.daten`
     ist hier seit dem ersten Aufruf leer — ein zweiter Aufruf hätte also ein
     ZWEITES Mal gebrannt: Spur, Fassung und Push, für eine Zerstörung, die
     nicht mehr stattfand, weil beim ersten Mal schon nichts mehr da war.
     Gemessen wird deshalb nicht nur die Abweisung selbst, sondern dass
     NICHTS in der Datenbank sich zwischen den beiden Aufrufen bewegt. */
  const spurVorher = notzugang.protokollFuer(b).length;
  const fassungVorher = zeileVon(b).fassung;
  await wirftAbMit(
    'B: EIN ZWEITER AUFRUF wird abgewiesen, statt ein zweites Mal niederzubrennen',
    'keinen Notzugang',
    async () => notzugang.aufheben(b, 'chefin'),
  );
  pruef('B: … die Spur trägt keine einzige Zeile mehr als vorher', notzugang.protokollFuer(b).length, spurVorher);
  pruef('B: … und die Fassung des Kontoschlüssels hat sich kein zweites Mal bewegt',
    zeileVon(b).fassung, fassungVorher);
}

/* ── Teil 12: Ein Notzugang, der einen ANDEREN Schlüssel deckt ────────── */

/**
 * Die Frage, die verwerfen() stellt, ist nicht „steht hier IRGENDEIN
 * Notzugang?", sondern „deckt er GENAU DEN Schlüssel, der hier liegt?".
 * Der Vergleich hing früher an deckt(userId, alt.abdruck) und fiel zusammen
 * mit dem Fehler weg, neben dem er stand.
 *
 * Der Zustand darunter wird VON HAND hergestellt. In dieser Fassung kann er
 * nicht mehr entstehen: einrichten() verlangt Gleichheit, und der Ersatzzweig
 * von hinterlegenInTransaktion() wird bei stehendem Notzugang abgewiesen.
 * Eine ältere Fassung konnte ihn hinterlassen — und eine Wache, die heute
 * nicht erreichbar ist, ist trotzdem eine Wache.
 */
console.log('\n\x1b[1mTeil 12 — Deckt der Notzugang einen anderen Schlüssel, wird nicht geschont\x1b[0m');

{
  const d = 'abdruckWeicht';
  const bD = await buehne(d, 'ein-langes-passwort-d');
  db.run(
    'UPDATE konto_notzugang SET konto_abdruck = ? WHERE user_id = ?',
    await kontoAbdruck(crypto.randomBytes(32)), d,
  );
  pruefWahr('Der gedeckte Abdruck und der lebende Schlüssel gehen jetzt auseinander',
    notzugang.gedeckterAbdruck(d) !== zeileVon(d).abdruck);

  users.resetPassword(d, 'chefin');
  pruef('DAS ZURÜCKSETZEN BRENNT — dieser Notzugang holt DIESEN Schlüssel nie zurück',
    zaehlen(d), [0, 0]);
  pruef('… Abdruck leer, Fassung eins weiter',
    [zeileVon(d).abdruck === '', zeileVon(d).fassung], [true, bD.fassung + 1]);
  pruefWahr('… und keine „geschont"-Zeile behauptet das Gegenteil',
    !notzugang.protokollFuer(d).some((z) => z.art === 'geschont'));

  /* Die Gegenprobe, ohne die die drei Zeilen darüber nur „irgendetwas
     brennt" hießen: derselbe Aufbau, nur mit PASSENDEM Abdruck. */
  const e = 'abdruckPasst';
  await buehne(e, 'ein-langes-passwort-e');
  users.resetPassword(e, 'chefin');
  pruef('Deckt der Notzugang DENSELBEN Schlüssel, überleben beide Pakete', zaehlen(e), [1, 1]);
  pruefWahr('… und das Schonen steht in der Spur',
    notzugang.protokollFuer(e).some((z) => z.art === 'geschont'));

  /* Und der dritte Zustand, den die Bedingung ausdrücklich durchlässt: gar
     kein Abdruck mehr. „Leer" darf nicht als „ein anderer" gelesen werden —
     sonst brennt genau hier wieder alles nieder, was der Notzugang gleich
     zurückholen will. Das ist die Datenbank aus Teil 4b, diesmal gegen
     verwerfen() statt gegen hinterlegen(). */
  const f = 'abdruckFehlt';
  await buehne(f, 'ein-langes-passwort-f');
  db.run("UPDATE konto_schluessel SET salz = '', runden = 0, iv = '', daten = '', abdruck = '' WHERE user_id = ?", f);
  users.resetPassword(f, 'chefin');
  pruef('Ohne Abdruck bleibt es beim Schonen — beide Pakete stehen noch', zaehlen(f), [1, 1]);
}

/* ── Teil 13: Die Heimkehr zieht die Fassung des Notzugangs nach ──────── */

/**
 * Der zweite Zweig von `derselbe` (services/kontoschluessel.ts) erkennt eine
 * Heimkehr in ein Konto, dem der Abdruck schon abhanden gekommen ist. In
 * genau diesem Zustand hat das alte, harte Verwerfen `konto_schluessel.fassung`
 * hochgezählt und `konto_notzugang.konto_fassung` stehen lassen — die beiden
 * Zahlen gehen auseinander.
 *
 * Das Gerät vergleicht sie (lib/kontoschluessel.ts,
 * mitNotschluesselWiederherstellen: `fassung !== huelle.kontoFassung`) und
 * bricht bei Ungleichheit ab. Zu Recht: dieselbe Ungleichheit entstünde
 * auch, wenn der Server heimlich den Ersatzzweig gelaufen wäre und dabei
 * jedes Paket mitgenommen hätte. Die Prüfung bleibt deshalb streng;
 * korrigiert wird die ZAHL, die falsch ist.
 */
console.log('\n\x1b[1mTeil 13 — Heimkehr ohne Abdruck: die Fassung des Notzugangs wird nachgezogen\x1b[0m');

{
  const g = 'heimkehr';
  const bG = await buehne(g, 'ein-langes-passwort-g');

  /* Wörtlich das, was das alte harte Verwerfen tat — nur die Zeile des
     Notzugangs bleibt unangetastet, denn die hat es nie angefasst. */
  db.run(
    "UPDATE konto_schluessel SET salz = '', runden = 0, iv = '', daten = '', abdruck = '', fassung = fassung + 1 WHERE user_id = ?",
    g,
  );
  const huelleVorher = notzugang.huelleHolen(g)!;
  pruef('Vorher gehen die beiden Fassungen auseinander',
    [huelleVorher.kontoFassung, zeileVon(g).fassung], [bG.fassung, bG.fassung + 1]);

  const zurueck = kontoschluessel.hinterlegen(g, await kontoHuelleBauen(bG.roh, 'ein-neues-langes-passwort-g', g));
  pruef('Der ECHTE Schlüssel kommt durch — erkannt an der Zeile des Notzugangs', zurueck, bG.fassung + 1);
  /* `zaehlen()` ist eine ROHE COUNT(*) — sie belegt nur, dass die Zeilen
     nicht GELÖSCHT wurden, nicht, dass sich irgendjemand mit ihnen öffnen
     lässt. Jeder Leseweg (services/notizen.ts, services/passwoerter.ts,
     beide kontoPaketeFuerAlle()) filtert exakt auf `konto_fassung =
     aktuelleFassung(userId)` — und genau DAS ist die Zahl, die
     kontoFassungNachziehen() unten für dieses Konto gerade mitbewegt hat.
     Die ehrliche Prüfung steht deshalb gleich danach, mit dem echten
     Leseweg statt einer rohen Zeilenzählung. */
  pruef('… und kein Kontopaket ist dabei GELÖSCHT worden (rohe Zeilenzahl)', zaehlen(g), [1, 1]);

  const huelleNachher = notzugang.huelleHolen(g)!;
  pruef('DIE ZEILE DES NOTZUGANGS IST NACHGEZOGEN', huelleNachher.kontoFassung, zurueck);

  /* DIE PROBE, DIE VORHER FEHLTE: nicht nachgerechnet (das wäre reine
     Algebra aus `zurueck = bG.fassung + 1` und `huelleVorher.kontoFassung =
     bG.fassung`, beides oben schon bewiesen — zwei Zeilen, die nichts Neues
     zeigten), sondern über denselben Leseweg gefragt, den die Notiz- und
     die Tresor-Tafel beim Öffnen tatsächlich nehmen. Das ist der Beweis,
     dass kontoFassungNachziehen() unten die Pakete wirklich mitzieht, statt
     nur eine Zahl in der Zeile des Notzugangs geradezurücken. */
  pruef('… und beide Pakete sind über den ECHTEN Leseweg wieder auffindbar',
    [notizen.kontoPaketeFuerAlle(g).length, passwoerter.kontoPaketeFuerAlle(g).length], [1, 1]);
  pruef('… unter der NEUEN Fassung, nicht mehr unter der alten',
    [notizen.kontoPaketeFuerAlle(g)[0]?.paket.kontoFassung, passwoerter.kontoPaketeFuerAlle(g)[0]?.paket.kontoFassung],
    [zurueck, zurueck]);

  /* Und wirklich durchgespielt: dieselbe Hinterlegung ein zweites Mal — der
     zweite Klick auf „Zugang wiederherstellen", dieselbe offene Anfrage,
     dieselben Beiträge. kontoFassungNachziehen() trifft beim zweiten
     Durchgang keine veraltete Zahl mehr an (die Zeile steht ja schon auf
     `zurueck`) und rührt nichts noch einmal an — verlustfrei, kein zweiter
     Sprung. */
  const zweiter = kontoschluessel.hinterlegen(g, await kontoHuelleBauen(bG.roh, 'ein-neues-langes-passwort-g', g));
  pruef('Der zweite Durchgang meldet dieselbe Fassung wie die Hülle',
    [zweiter, notzugang.huelleHolen(g)!.kontoFassung], [zurueck, zurueck]);
  pruef('… und beide Pakete bleiben über den echten Leseweg auffindbar',
    [notizen.kontoPaketeFuerAlle(g).length, passwoerter.kontoPaketeFuerAlle(g).length], [1, 1]);
}

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m`
  : '\n\x1b[32mDrei von fünf holen den Kontoschlüssel zurück, zwei nie — und die Fassung bewegt sich dabei nicht.\x1b[0m');
process.exit(fehler ? 1 : 0);
