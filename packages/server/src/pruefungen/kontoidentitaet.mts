/**
 * Prüft die KONTOIDENTITÄT — den privaten ECDH-Teil, der dem KONTO gehört
 * statt einem Gerät.
 *
 * DER FEHLERBERICHT, um den es geht, ist Dons eigener Satz: „Alles was
 * verschlüsselt wird — private Dateien, Notizen und und und — muss auf jedem
 * Gerät verfügbar sein, wenn man sich anmeldet. Auch ohne dass das Gerät, wo
 * es erstellt wurde, online sein muss."
 *
 * Für Notizen und den Tresor löst das der Kontoschlüssel je Datensatz
 * (notiz_konto_pakete, passwort_konto_pakete). Für zwei Datenarten geht das
 * grundsätzlich nicht:
 *
 *   · Eine PRIVATE DATEI trägt ihren Schlüssel im eigenen Umschlag. Es gibt
 *     nichts, wozu sich ein Kontopaket nachtragen ließe — und ihr
 *     Hüllenschlüssel ist ein ECDH-Geheimnis des Schlüsselpaars mit sich
 *     selbst. Anderes Paar, anderer Schlüssel, Datei für immer zu.
 *   · Ein VERTRAULICHER KANAL könnte eines bekommen, aber nur von einem
 *     Gerät, das den Kanalschlüssel schon hat — also einem, das gerade
 *     online sein müsste.
 *
 * Beide hängen am selben Paar. Also wandert das Paar selbst ans Konto:
 * verpackt mit dem Kontoschlüssel, abgelegt in identitaet_konto_pakete.
 *
 * Dieser Lauf prüft die SERVERSEITE davon und die Rechnung dahinter, beides
 * gegen eine wegwerfbare Datenbank. Nachgerechnet und nicht importiert
 * (dieselbe Machart wie notiz-kontoschluessel.mts): eine Prüfung, die den
 * geprüften Code als Maßstab benutzt, prüft nichts.
 *
 * WAS HIER NIE INS PROTOKOLL GEHT: Schlüssel, Hüllen, Salze, Passwörter.
 * `pruef()` druckt bei einem Fehlschlag den Istwert — deshalb geht alles
 * Geheime vorher durch eine Verrechnung und kommt als Wahrheitswert an.
 *
 * Aufruf:  node scripts/kontoidentitaet-pruefen.mjs
 */
import { webcrypto } from 'node:crypto';
import {
  KONTO_ABDRUCK_VORSPANN, KONTO_KDF, KONTO_PAKET_ALG, KONTO_RUNDEN,
  identitaetKontoKontext, kontoKekKontext,
  type IdentitaetPaket, type KontoSchluesselBlob,
} from '@stellium/shared';
import { db, initDb } from '../db/index.js';
import { hashPassword } from '../auth.js';
import * as kontoschluessel from '../services/kontoschluessel.js';
import * as kontoidentitaet from '../services/kontoidentitaet.js';
import { kontoPaketTabellen } from '../services/kontoverwerfen.js';

initDb();
const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const b64u = (b: Uint8Array | ArrayBuffer) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const unb64u = (t: string) => new Uint8Array(Buffer.from(t, 'base64url'));

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};
const pruefWahr = (name: string, ist: boolean) => pruef(name, ist, true);

/* ── Die Rechnung, unabhängig nachgebaut ──────────────────────────────── */

const sha256 = async (t: string) => new Uint8Array(await subtle.digest('SHA-256', enc.encode(t)));

async function passwortSchluessel(passwort: string, salz: Uint8Array, runden: number, userId: string) {
  const roh = await subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256);
  const zwischen = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontoKekKontext(userId)), info: enc.encode('stellium/konto/kek/v1') },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function identitaetHuelle(kontoRoh: Uint8Array, userId: string) {
  const zwischen = await subtle.importKey('raw', kontoRoh, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(identitaetKontoKontext(userId)), info: enc.encode('stellium/identitaet/konto/v1') },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function abdruckVonKonto(roh: Uint8Array) {
  const vorspann = enc.encode(KONTO_ABDRUCK_VORSPANN);
  const zusammen = new Uint8Array(vorspann.length + roh.length);
  zusammen.set(vorspann, 0); zusammen.set(roh, vorspann.length);
  return b64u(new Uint8Array(await subtle.digest('SHA-256', zusammen)));
}

async function huelleBauen(kontoRoh: Uint8Array, passwort: string, userId: string): Promise<KontoSchluesselBlob> {
  const salz = webcrypto.getRandomValues(new Uint8Array(16));
  const kek = await passwortSchluessel(passwort, salz, KONTO_RUNDEN, userId);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, kek, kontoRoh);
  return {
    kdf: KONTO_KDF, salz: b64u(salz), runden: KONTO_RUNDEN, alg: KONTO_PAKET_ALG,
    iv: b64u(iv), daten: b64u(new Uint8Array(daten)), fassung: 0,
    abdruck: await abdruckVonKonto(kontoRoh),
  };
}

async function identitaetBauen(kontoRoh: Uint8Array, userId: string, jwkText: string,
                               kontoFassung: number, abdruck: string): Promise<IdentitaetPaket> {
  const h = await identitaetHuelle(kontoRoh, userId);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, h, enc.encode(jwkText));
  return { alg: KONTO_PAKET_ALG, kontoFassung, iv: b64u(iv), daten: b64u(new Uint8Array(daten)), abdruck };
}

/* ── Zwei Konten, zwei Geräte ─────────────────────────────────────────── */

const KONTO = 'ident1';
const PASSWORT = 'ein-langes-passwort-1';
db.run(
  'INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,0)',
  KONTO, KONTO, KONTO, hashPassword(PASSWORT), 'member',
);

const paarA = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as webcrypto.CryptoKeyPair;
const paarB = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as webcrypto.CryptoKeyPair;
const privAText = JSON.stringify(await subtle.exportKey('jwk', paarA.privateKey));
const privBText = JSON.stringify(await subtle.exportKey('jwk', paarB.privateKey));

console.log('\n\x1b[1mOhne Kontoschlüssel gibt es keine Identität\x1b[0m');
{
  pruef('Es liegt keine Identität, solange es keinen Kontoschlüssel gibt',
    kontoidentitaet.holen(KONTO), null);
  let abgewiesen = false;
  try {
    kontoidentitaet.hinterlegen(KONTO, { alg: KONTO_PAKET_ALG, kontoFassung: 1, iv: 'x', daten: 'y', abdruck: 'z' });
  } catch { abgewiesen = true; }
  pruefWahr('… und ein Angebot wird abgewiesen statt angenommen — ein Paket, das niemand öffnen kann, '
    + 'ist schlimmer als keines', abgewiesen);
}

/* Jetzt der Kontoschlüssel — so wie ihn ein Gerät aus dem Passwort baut. */
const kontoRoh = webcrypto.getRandomValues(new Uint8Array(32));
const fassung1 = kontoschluessel.hinterlegen(KONTO, await huelleBauen(kontoRoh, PASSWORT, KONTO));
pruef('Der Kontoschlüssel steht in Fassung 1', fassung1, 1);

console.log('\n\x1b[1mWer zuerst schreibt, gilt\x1b[0m');
const abdruckA = 'AAAA-BBBB-CCCC-DDDD';
const abdruckB = 'EEEE-FFFF-1111-2222';
{
  const angebotA = await identitaetBauen(kontoRoh, KONTO, privAText, fassung1, abdruckA);
  const giltA = kontoidentitaet.hinterlegen(KONTO, angebotA);
  pruef('Gerät A bietet seine Identität an und sie gilt', giltA.abdruck, abdruckA);

  /* DIE ENTSCHEIDENDE ZEILE. Ein frisch eingerichtetes Gerät hat ein
     EIGENES Paar, bevor es den Server fragt. Dürfte es seines hinterlegen,
     wäre in derselben Sekunde jedes Kanalpaket und jede private Datei des
     Kontos an eine Identität gebunden, die niemand mehr hat. */
  const angebotB = await identitaetBauen(kontoRoh, KONTO, privBText, fassung1, abdruckB);
  const giltB = kontoidentitaet.hinterlegen(KONTO, angebotB);
  pruef('Gerät B bietet seine eigene an und bekommt die von A zurück — überschrieben wird nie',
    giltB.abdruck, abdruckA);
  pruef('… und in der Datenbank steht weiterhin die von A',
    kontoidentitaet.holen(KONTO)!.abdruck, abdruckA);

  /* Und das Zurückgegebene ist BRAUCHBAR: Gerät B leitet aus demselben
     Passwort denselben Kontoschlüssel ab und packt damit A's privaten Teil
     aus. Genau das ist der ganze Weg eines zweiten Geräts. */
  const blob = kontoschluessel.holen(KONTO)!;
  const kek = await passwortSchluessel(PASSWORT, unb64u(blob.salz), blob.runden, KONTO);
  const rohB = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(blob.iv) }, kek, unb64u(blob.daten)));
  const h = await identitaetHuelle(rohB, KONTO);
  let heraus: string | null = null;
  try {
    heraus = new TextDecoder().decode(await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64u(giltB.iv) }, h, unb64u(giltB.daten)));
  } catch { /* bleibt null */ }
  pruefWahr('AUS PASSWORT ALLEIN: Gerät B leitet den Kontoschlüssel ab und packt damit den privaten '
    + 'Teil des Kontos aus — genau derselbe wie auf Gerät A', heraus === privAText);
  pruefWahr('… und der ist WIRKLICH ein Schlüsselpaar, nicht bloß gleiche Bytes',
    Boolean(await subtle.importKey('jwk', JSON.parse(heraus!), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])));
}

console.log('\n\x1b[1mDie Fassung wird geprüft, nicht geglaubt\x1b[0m');
{
  let abgewiesen = false;
  try {
    kontoidentitaet.hinterlegen(KONTO, await identitaetBauen(kontoRoh, KONTO, privBText, fassung1 + 5, abdruckB));
  } catch { abgewiesen = true; }
  pruefWahr('Ein Gerät mit veralteter (hier: erfundener) Kontoschlüsselfassung wird abgewiesen', abgewiesen);

  /* Und der Lesefilter, unabhängig vom Wegräumen: eine Zeile aus einer
     früheren Fassung wird gar nicht erst herausgegeben. Von Hand gesetzt,
     weil ein geordneter Ersatz sie ohnehin wegräumt — geprüft wird die
     Wache, nicht der Normalfall. */
  db.run('UPDATE identitaet_konto_pakete SET konto_fassung = 99 WHERE user_id = ?', KONTO);
  pruef('Eine Zeile aus einer fremden Fassung wird nicht ausgeliefert', kontoidentitaet.holen(KONTO), null);
  db.run('UPDATE identitaet_konto_pakete SET konto_fassung = ? WHERE user_id = ?', fassung1, KONTO);
  pruef('… und zurückgesetzt kommt sie wieder', kontoidentitaet.holen(KONTO)!.abdruck, abdruckA);
}

console.log('\n\x1b[1mUmschließen lässt sie stehen, Ersatz räumt sie weg\x1b[0m');
{
  /* PASSWORTWECHSEL — dieselbe Schlüsselseele, neue Hülle. Die Identität
     darf sich dabei NICHT bewegen: sie ist mit dem Kontoschlüssel verpackt,
     und der ist derselbe geblieben. */
  const fassungNachWechsel = kontoschluessel.hinterlegen(
    KONTO, await huelleBauen(kontoRoh, 'ein-anderes-langes-passwort-2', KONTO));
  pruef('Ein Passwortwechsel lässt die Fassung stehen (Umschließen, kein Ersatz)', fassungNachWechsel, fassung1);
  pruef('… und die Kontoidentität steht danach unverändert da', kontoidentitaet.holen(KONTO)!.abdruck, abdruckA);

  /* ERSATZ — ein anderer Kontoschlüssel. Jetzt MUSS sie weg: mit dem neuen
     ließe sie sich nie öffnen, und eine Zeile, die eine Identität behauptet,
     die niemand auspacken kann, hängt nicht an einem Datensatz, sondern an
     allem, was am Schlüsselpaar hängt. */
  pruefWahr('identitaet_konto_pakete steht in der Liste der Kontopaket-Tabellen',
    kontoPaketTabellen.includes('identitaet_konto_pakete'));
  const kontoRohNeu = webcrypto.getRandomValues(new Uint8Array(32));
  const fassung2 = kontoschluessel.hinterlegen(KONTO, await huelleBauen(kontoRohNeu, PASSWORT, KONTO));
  pruef('Ein ERSATZ zählt die Fassung hoch', fassung2, fassung1 + 1);
  pruef('… und räumt die Kontoidentität mit weg', kontoidentitaet.holen(KONTO), null);
  pruef('… und zwar wirklich aus der Tabelle, nicht nur aus der Auslieferung',
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM identitaet_konto_pakete WHERE user_id = ?', KONTO)!.n, 0);

  /* Und das erste Gerät mit Paar trägt sie neu ein — die Lücke heilt. */
  const wieder = kontoidentitaet.hinterlegen(
    KONTO, await identitaetBauen(kontoRohNeu, KONTO, privAText, fassung2, abdruckA));
  pruef('Das nächste Gerät mit Schlüsselpaar trägt sie neu ein — die Lücke heilt von selbst',
    wieder.abdruck, abdruckA);
  pruef('… unter der NEUEN Fassung', kontoidentitaet.holen(KONTO)!.kontoFassung, fassung2);
}

console.log('\n\x1b[1mWas der Server dabei sieht\x1b[0m');
{
  const zeile = db.get<Record<string, unknown>>('SELECT * FROM identitaet_konto_pakete WHERE user_id = ?', KONTO)!;
  const text = JSON.stringify(zeile);
  pruefWahr('In der Zeile steht kein Passwort', !text.includes(PASSWORT));
  pruefWahr('… und auch nicht der private Teil im Klartext', !text.includes(JSON.parse(privAText).d as string));
  pruefWahr('… und kein Kontoschlüssel', !text.includes(b64u(kontoRoh)) && !text.includes(b64u(kontoRoh)));
}

console.log(fehler ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDie Identität gehört dem Konto: ein zweites Gerät bekommt sie aus dem Passwort allein, '
    + 'und niemand kann sie einem anderen wegnehmen.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
