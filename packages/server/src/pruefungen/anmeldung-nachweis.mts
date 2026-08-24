/**
 * Prüft die Anmeldung OHNE Passwort — und vor allem, dass die Anmeldung MIT
 * Passwort daneben unangetastet weiterläuft.
 *
 * WORUM ES GEHT
 *
 * `konto_schluessel` verwahrt den Kontoschlüssel in einer Hülle, die aus dem
 * PASSWORT abgeleitet ist. Solange `POST /api/auth/login` das Passwort im
 * Klartext bekam, war diese Hülle gegen den Server selbst wertlos: er hätte
 * in genau dem Augenblick mitschreiben und dieselbe Ableitung rechnen
 * können. Seit services/anmeldenachweis.ts geht statt des Passworts ein
 * daraus abgeleiteter Nachweis über die Leitung.
 *
 * WAS DIESER LAUF VOR ALLEM PRÜFT: DASS NIEMAND AUSGESPERRT IST
 *
 * Der Server steht auf einem Rechner, an den niemand herankommt. Ein Umbau
 * am Anmeldeweg, der eine alte App oder ein gemerktes Browser-Bündel
 * aussperrt, wäre dort nicht zurückzunehmen. Deshalb ist der wichtigste
 * Abschnitt hier nicht 3), sondern 4): ein Konto, das längst umgestellt ist,
 * MUSS sich weiter mit dem blanken Passwort anmelden lassen.
 *
 * UND DIE GEFÄHRLICHSTE STELLE: ABSCHNITT 5
 *
 * Der Kontoschlüssel-KEK wird aus dem Passwort abgeleitet, der Nachweis
 * ebenfalls. Würden die beiden je verwechselt — ginge etwa der Nachweis
 * dorthin, wo das Passwort hingehört —, ließe sich die bestehende Hülle
 * nicht mehr öffnen, die App legte einen NEUEN Kontoschlüssel an, der Server
 * zählte die Fassung hoch und räumte dabei JEDES Notiz-Kontopaket weg. Kein
 * Fehler, den man am Bildschirm sähe: die Notizen blieben stehen und ließen
 * sich nur nie wieder öffnen. Abschnitt 5 packt deshalb einen echten
 * Notizschlüssel VOR der Umstellung ein und wieder aus, NACHDEM die
 * Anmeldung über den neuen Weg lief — mit echter Kryptografie, nicht mit
 * einem Vergleich zweier Zeichenketten.
 *
 * KEINE GEHEIMNISSE IN DER AUSGABE
 *
 * Jede Prüfung hier vergleicht Wahrheitswerte oder Zahlen. Kein Salz, kein
 * Abdruck, kein Nachweis und kein Passwort steht je in einer Zeile, die
 * dieser Lauf ausgibt — auch nicht gekürzt und auch nicht im Fehlerfall.
 * `pruef()` DRUCKT bei einer Abweichung den Istwert, deshalb bekommt es hier
 * ausschließlich Wahrheitswerte und Zählungen zu sehen.
 *
 * Aufruf:  node scripts/anmeldung-nachweis-pruefen.mjs
 */
import Fastify from 'fastify';
import {
  ANMELDE_KDF, ANMELDE_NACHWEIS_KONTEXT, ANMELDE_RUNDEN,
  KONTO_ABDRUCK_VORSPANN, KONTO_KDF, KONTO_PAKET_ALG, KONTO_RUNDEN,
  kontoKekKontext, notizKontoKontext,
} from '@stellium/shared';
import { hashPassword } from '../auth.js';
import { db, initDb } from '../db/index.js';
import { registerRoutes } from '../http/routes.js';
import { changeOwnPassword, deleteAccount, resetPassword } from '../services/users.js';
import { verifyPassword } from '../auth.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/* ── Der Server, ohne app.listen() ─────────────────────────────────────
   Dieselbe Machart wie partnergruppen-routen.mts: Fastifys eigenes
   inject() durchläuft dieselbe Weg-Zuordnung wie ein echter Aufruf, ohne je
   einen Port zu öffnen. Für die Frage hier — "welche Antwort gibt die
   Anmeldung auf welchen Rumpf?" — ist das genau der richtige Ausschnitt. */

const app = Fastify({ logger: false });
await registerRoutes(app);

interface Antwort { statusCode: number; body: any }

async function anfrage(pfad: string, rumpf: unknown, token?: string): Promise<Antwort> {
  const antwort = await app.inject({
    method: 'POST', url: pfad,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    payload: JSON.stringify(rumpf),
  });
  let body: any;
  try { body = antwort.json(); } catch { body = undefined; }
  return { statusCode: antwort.statusCode, body };
}

async function holen(pfad: string, token: string): Promise<Antwort> {
  const antwort = await app.inject({ method: 'GET', url: pfad, headers: { authorization: `Bearer ${token}` } });
  let body: any;
  try { body = antwort.json(); } catch { body = undefined; }
  return { statusCode: antwort.statusCode, body };
}

/* ── Die Nachrechnung: eigene Fassung, absichtlich nicht importiert ────
   Eine Prüfung, die ihren Maßstab aus dem geprüften Code bezieht, ist
   keine. Dieselbe Begründung wie in notiz-kontoschluessel.mts. */

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (t: string) => new Uint8Array(Buffer.from(t, 'base64url'));
const sha256 = async (t: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(t)));

/** Der Nachweis, wie ihn ein Gerät bildet. */
async function nachweisBilden(passwort: string, salz: Uint8Array, runden: number): Promise<string> {
  const roh = await crypto.subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256,
  );
  const zwischen = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
  const fertig = await crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(ANMELDE_NACHWEIS_KONTEXT), info: enc.encode(ANMELDE_NACHWEIS_KONTEXT),
    },
    zwischen, 256,
  );
  return b64u(new Uint8Array(fertig));
}

/* `CryptoKey` steht in den DOM-Typen, die dieses Paket nicht lädt — der
   Server rechnet sonst nirgends mit WebCrypto. Der abgeleitete Typ aus
   deriveKey() reicht hier vollauf. */
type Schluessel = Awaited<ReturnType<typeof crypto.subtle.deriveKey>>;

/** Der Kontoschlüssel-KEK, wie ihn lib/kontoschluessel.ts bildet. */
async function kek(passwort: string, salz: Uint8Array, runden: number, userId: string): Promise<Schluessel> {
  const roh = await crypto.subtle.importKey('raw', enc.encode(passwort), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salz, iterations: runden, hash: 'SHA-256' }, roh, 256,
  );
  const zwischen = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
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
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', zusammen)));
}

async function notizHuelle(kontoRoh: Uint8Array, notizId: string, fassung: number): Promise<Schluessel> {
  const zwischen = await crypto.subtle.importKey('raw', kontoRoh, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: await sha256(notizKontoKontext(notizId, fassung)), info: enc.encode('stellium/notiz/konto/v1'),
    },
    zwischen, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/* ── Konten, roh per SQL ───────────────────────────────────────────────
   must_change_password bleibt 0: der Einrichtungsriegel in index.ts ist
   hier nicht der Gegenstand, und ein Konto mitten in der Einrichtung würde
   /api/auth/nachweis zu Recht abweisen. */

const PASSWORT = 'ein-langes-passwort-1';
const FALSCH = 'ein-ganz-anderes-passwort';

function kontoAnlegen(id: string, passwort: string): void {
  db.run(
    `INSERT INTO users (id, handle, display_name, password_hash, role, created_at, must_change_password)
     VALUES (?,?,?,?,?,?,0)`,
    id, id, id, hashPassword(passwort), 'member', Date.now(),
  );
}

kontoAnlegen('anna', PASSWORT);

/* ── 1) Der alte Weg — unverändert ────────────────────────────────── */
console.log('\n1) Der alte Weg mit Passwort im Klartext');

const altAnmeldung = await anfrage('/api/auth/login', { login: 'anna', password: PASSWORT });
pruef('Eine App aus der Zeit davor meldet sich an', altAnmeldung.statusCode, 200);
pruef('… und bekommt ein Token', typeof altAnmeldung.body?.token === 'string' && altAnmeldung.body.token.length > 0, true);
const tokenAlt: string = altAnmeldung.body.token;

const altFalsch = await anfrage('/api/auth/login', { login: 'anna', password: FALSCH });
pruef('Ein falsches Passwort wird abgewiesen', altFalsch.statusCode, 401);
pruef('… mit der gewohnten Kennung', altFalsch.body?.code, 'fehler.loginFalsch');

/* ── 2) Die Auskunft vor der Anmeldung ────────────────────────────── */
console.log('\n2) Verrät die Wegbeschreibung, ob es ein Konto gibt?');

const salzAnna = await anfrage('/api/auth/anmeldesalz', { login: 'anna' });
const salzNiemand = await anfrage('/api/auth/anmeldesalz', { login: 'gibtesnicht' });
const salzNiemand2 = await anfrage('/api/auth/anmeldesalz', { login: 'gibtesnicht' });

pruef('Ein vorhandenes Konto bekommt eine Wegbeschreibung', salzAnna.statusCode, 200);
pruef('Ein erfundener Name bekommt AUCH eine — gleicher Status', salzNiemand.statusCode, 200);
pruef('… mit genau denselben Feldern',
  JSON.stringify(Object.keys(salzAnna.body).sort()) === JSON.stringify(Object.keys(salzNiemand.body).sort()), true);
pruef('… derselben Rundenzahl',
  salzAnna.body.runden === salzNiemand.body.runden && salzAnna.body.runden === ANMELDE_RUNDEN, true);
pruef('… demselben Verfahren', salzAnna.body.kdf === salzNiemand.body.kdf && salzAnna.body.kdf === ANMELDE_KDF, true);
pruef('… und einem Salz derselben Länge',
  unb64u(salzAnna.body.salz).length === unb64u(salzNiemand.body.salz).length, true);
pruef('Das Salz eines erfundenen Namens ist BESTÄNDIG — ein wechselndes wäre selbst die Auskunft',
  salzNiemand.body.salz === salzNiemand2.body.salz, true);
pruef('… und je Name verschieden, nicht ein einziges für alle',
  salzNiemand.body.salz !== (await anfrage('/api/auth/anmeldesalz', { login: 'auchnicht' })).body.salz, true);

/* ── 3) Der neue Weg ──────────────────────────────────────────────── */
console.log('\n3) Der neue Weg ohne Passwort auf der Leitung');

const nachweisVorher = await nachweisBilden(PASSWORT, unb64u(salzAnna.body.salz), salzAnna.body.runden);
const zuFrueh = await anfrage('/api/auth/login', { login: 'anna', nachweis: nachweisVorher });
pruef('Vor der Umstellung führt der neue Weg zu nichts', zuFrueh.statusCode, 401);
pruef('… und sagt dabei NICHT, dass es das Konto gibt', zuFrueh.body?.code, 'fehler.loginFalsch');

/* Die Umstellung selbst — genau das, was die App nach einer Anmeldung über
   den alten Weg tut: eigenes Salz würfeln, Nachweis bilden, hinterlegen. */
const salzEigen = crypto.getRandomValues(new Uint8Array(16));
const nachweisAnna = await nachweisBilden(PASSWORT, salzEigen, ANMELDE_RUNDEN);
const hinterlegt = await anfrage('/api/auth/nachweis', {
  kdf: ANMELDE_KDF, salz: b64u(salzEigen), runden: ANMELDE_RUNDEN, nachweis: nachweisAnna,
}, tokenAlt);
pruef('Das Gerät hinterlegt einen Nachweis', hinterlegt.statusCode, 200);

const neuAnmeldung = await anfrage('/api/auth/login', { login: 'anna', nachweis: nachweisAnna });
pruef('DIE ANMELDUNG OHNE PASSWORT GEHT DURCH', neuAnmeldung.statusCode, 200);
pruef('… und bekommt ein Token', typeof neuAnmeldung.body?.token === 'string' && neuAnmeldung.body.token.length > 0, true);
const tokenNeu: string = neuAnmeldung.body.token;

const nachweisFalsch = await nachweisBilden(FALSCH, salzEigen, ANMELDE_RUNDEN);
pruef('Ein Nachweis aus dem falschen Passwort wird abgewiesen',
  (await anfrage('/api/auth/login', { login: 'anna', nachweis: nachweisFalsch })).statusCode, 401);
pruef('Das blanke Passwort im NACHWEIS-Feld ist kein Nachweis',
  (await anfrage('/api/auth/login', { login: 'anna', nachweis: PASSWORT })).statusCode, 401);

/* Was in der Datenbank steht, ist nicht der Nachweis selbst. */
const gespeichert = db.get<{ nachweis: string; salz: string }>(
  'SELECT nachweis, salz FROM anmelde_nachweise WHERE user_id = ?', 'anna',
);
pruef('In der Datenbank liegt der Nachweis nicht roh, sondern gehasht',
  gespeichert !== undefined && gespeichert.nachweis !== nachweisAnna, true);
pruef('… und zwar mit demselben scrypt wie das Passwort daneben',
  gespeichert !== undefined && verifyPassword(nachweisAnna, gespeichert.nachweis), true);
pruef('Das Passwort selbst steht nirgends in dieser Zeile',
  gespeichert !== undefined && !JSON.stringify(gespeichert).includes(PASSWORT), true);

/* Und jetzt noch einmal Abschnitt 2 — der Fall, der wirklich verrät. */
const salzAnnaNachher = await anfrage('/api/auth/anmeldesalz', { login: 'anna' });
pruef('Auch NACH der Umstellung sieht die Wegbeschreibung aus wie die eines erfundenen Namens',
  JSON.stringify(Object.keys(salzAnnaNachher.body).sort()) === JSON.stringify(Object.keys(salzNiemand.body).sort())
  && salzAnnaNachher.body.runden === salzNiemand.body.runden
  && salzAnnaNachher.body.kdf === salzNiemand.body.kdf
  && unb64u(salzAnnaNachher.body.salz).length === unb64u(salzNiemand.body.salz).length, true);

/* Drei Nein-Fälle, die einander nicht verraten dürfen. */
const neinUnbekannt = await anfrage('/api/auth/login', { login: 'gibtesnicht', nachweis: nachweisAnna });
kontoAnlegen('bert', PASSWORT);
const salzBert = await anfrage('/api/auth/anmeldesalz', { login: 'bert' });
const neinOhneNachweis = await anfrage('/api/auth/login', {
  login: 'bert', nachweis: await nachweisBilden(PASSWORT, unb64u(salzBert.body.salz), salzBert.body.runden),
});
const neinFalsch = await anfrage('/api/auth/login', { login: 'anna', nachweis: nachweisFalsch });
pruef('Kein Konto / Konto ohne Nachweis / falscher Nachweis geben ALLE DREI dieselbe Antwort',
  JSON.stringify([neinUnbekannt.statusCode, neinUnbekannt.body?.code])
  === JSON.stringify([neinOhneNachweis.statusCode, neinOhneNachweis.body?.code])
  && JSON.stringify([neinFalsch.statusCode, neinFalsch.body?.code])
  === JSON.stringify([neinOhneNachweis.statusCode, neinOhneNachweis.body?.code]), true);

/* ── 4) DER WICHTIGSTE ABSCHNITT: niemand ist ausgesperrt ─────────── */
console.log('\n4) Ein umgestelltes Konto und eine alte App');

const altNachUmstellung = await anfrage('/api/auth/login', { login: 'anna', password: PASSWORT });
pruef('EIN UMGESTELLTES KONTO MELDET SICH WEITER MIT DEM BLANKEN PASSWORT AN', altNachUmstellung.statusCode, 200);
pruef('… und bekommt ein brauchbares Token',
  typeof altNachUmstellung.body?.token === 'string' && altNachUmstellung.body.token.length > 0, true);
pruef('Der hinterlegte Passwort-Hash ist dabei unangetastet geblieben',
  verifyPassword(PASSWORT, db.get<{ h: string }>('SELECT password_hash AS h FROM users WHERE id = ?', 'anna')!.h), true);
pruef('Ein falsches Passwort wird auch bei einem umgestellten Konto abgewiesen',
  (await anfrage('/api/auth/login', { login: 'anna', password: FALSCH })).statusCode, 401);

/* ── 5) Der Kontoschlüssel überlebt die Umstellung ────────────────── */
console.log('\n5) Der Kontoschlüssel — echte Kryptografie über die Umstellung hinweg');

kontoAnlegen('carla', PASSWORT);
const carlaAlt = await anfrage('/api/auth/login', { login: 'carla', password: PASSWORT });
const tokenCarla: string = carlaAlt.body.token;

/* VOR der Umstellung: Kontoschlüssel anlegen wie die App, Notizschlüssel
   damit einpacken. */
const kontoRoh = crypto.getRandomValues(new Uint8Array(32));
const kontoSalz = crypto.getRandomValues(new Uint8Array(16));
const kontoIv = crypto.getRandomValues(new Uint8Array(12));
const huelleVorher = await kek(PASSWORT, kontoSalz, KONTO_RUNDEN, 'carla');
const kontoDaten = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: kontoIv }, huelleVorher, kontoRoh));
const abdruck = await kontoAbdruck(kontoRoh);
const gelegt = await anfrage('/api/konto/schluessel', {
  kdf: KONTO_KDF, salz: b64u(kontoSalz), runden: KONTO_RUNDEN, alg: KONTO_PAKET_ALG,
  iv: b64u(kontoIv), daten: b64u(kontoDaten), abdruck, fassung: 0,
}, tokenCarla);
pruef('Ein Kontoschlüssel liegt beim Server', gelegt.statusCode, 200);
const fassungVorher: number = gelegt.body.fassung;

const NOTIZ = 'nz_probe';
const notizKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const notizRoh = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', notizKey)));
const notizIv = crypto.getRandomValues(new Uint8Array(12));
const notizPaket = new Uint8Array(await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv: notizIv }, await notizHuelle(kontoRoh, NOTIZ, 1), unb64u(notizRoh),
));

/* Die Umstellung. */
const salzCarla = crypto.getRandomValues(new Uint8Array(16));
const nachweisCarla = await nachweisBilden(PASSWORT, salzCarla, ANMELDE_RUNDEN);
await anfrage('/api/auth/nachweis', {
  kdf: ANMELDE_KDF, salz: b64u(salzCarla), runden: ANMELDE_RUNDEN, nachweis: nachweisCarla,
}, tokenCarla);

/* NACH der Umstellung: Anmeldung über den neuen Weg, und von dort aus alles
   noch einmal — mit demselben Klartextpasswort, das die App weiterhin im
   Anmeldefeld stehen hat. */
const carlaNeu = await anfrage('/api/auth/login', { login: 'carla', nachweis: nachweisCarla });
pruef('Carla meldet sich ohne Passwort an', carlaNeu.statusCode, 200);
const tokenCarlaNeu: string = carlaNeu.body.token;

const geholt = await holen('/api/konto/schluessel', tokenCarlaNeu);
/* Bewusst über einen Platzhalter statt direkt: bliebe die Zeile leer (genau
   das wäre der Schaden, den dieser Abschnitt sucht), risse ein Zugriff auf
   `null` den ganzen Lauf mit — und die eine Prüfung, auf die es hier
   ankommt, käme nie zum Zug. Ein unbrauchbarer Platzhalter lässt jede
   folgende Prüfung sauber Nein sagen. */
const liegt = geholt.body?.schluessel ?? null;
const blob = liegt ?? { fassung: -1, abdruck: '', salz: 'AAAA', runden: 1, iv: 'AAAA', daten: 'AAAA' };
pruef('Der Kontoschlüssel liegt noch da', liegt !== null, true);
pruef('DIE FASSUNG HAT SICH NICHT GEÄNDERT — kein Notiz-Kontopaket wurde weggeräumt',
  blob.fassung, fassungVorher);
pruef('… und es ist derselbe Schlüssel, nicht ein neu erzeugter',
  blob.abdruck === abdruck, true);

const huelleNachher = await kek(PASSWORT, unb64u(blob.salz), blob.runden, 'carla');
let kontoRohNachher: Uint8Array | null = null;
try {
  kontoRohNachher = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(blob.iv) }, huelleNachher, unb64u(blob.daten),
  ));
} catch { /* bleibt null */ }
pruef('DER KONTOSCHLÜSSEL LÄSST SICH NACH DER UMSTELLUNG MIT DEMSELBEN PASSWORT ÖFFNEN',
  kontoRohNachher !== null && (await kontoAbdruck(kontoRohNachher)) === abdruck, true);

let notizZurueck: string | null = null;
try {
  notizZurueck = b64u(new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: notizIv }, await notizHuelle(kontoRohNachher ?? new Uint8Array(32), NOTIZ, 1), notizPaket,
  )));
} catch { /* bleibt null */ }
pruef('EINE VOR DER UMSTELLUNG EINGEPACKTE NOTIZ GEHT DANACH AUF — derselbe Notizschlüssel',
  notizZurueck !== null && notizZurueck === notizRoh, true);

/* Und die Gegenprobe, die den Vertauschungsfehler fängt: der Nachweis ist
   NICHT das Passwort. Wer ihn dorthin gäbe, wo das Passwort hingehört,
   bekäme die Hülle nicht auf — genau das wäre der stille Totalverlust. */
let mitNachweisGeoeffnet = false;
try {
  const falscheHuelle = await kek(nachweisCarla, unb64u(blob.salz), blob.runden, 'carla');
  await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64u(blob.iv) }, falscheHuelle, unb64u(blob.daten),
  );
  mitNachweisGeoeffnet = true;
} catch { /* soll so */ }
pruef('Der NACHWEIS öffnet die Hülle des Kontoschlüssels NICHT — er ist eine andere Ableitung',
  mitNachweisGeoeffnet, false);
pruef('… und ist auch nicht schlicht das Passwort', nachweisCarla !== PASSWORT, true);

/* ── 6) Die Bremse gilt für beide Wege — und nur einmal ───────────── */
console.log('\n6) Die Ratenbremse');

kontoAnlegen('dora', PASSWORT);
for (let i = 0; i < 8; i++) await anfrage('/api/auth/login', { login: 'dora', password: FALSCH });
pruef('Nach acht Fehlversuchen auf dem ALTEN Weg bremst der alte Weg',
  (await anfrage('/api/auth/login', { login: 'dora', password: PASSWORT })).statusCode, 429);
pruef('… UND der neue Weg ist damit ebenfalls gebremst (kein Weg um die Bremse herum)',
  (await anfrage('/api/auth/login', { login: 'dora', nachweis: nachweisAnna })).statusCode, 429);
pruef('… und auch die Wegbeschreibung wird nicht mehr herausgegeben',
  (await anfrage('/api/auth/anmeldesalz', { login: 'dora' })).statusCode, 429);
pruef('Ein anderes Konto ist davon unberührt',
  (await anfrage('/api/auth/anmeldesalz', { login: 'anna' })).statusCode, 200);

/* Die eigentliche Lücke, die dieser Abschnitt vorher NICHT prüfte: das Salz
   wird bewusst NICHT gezählt (siehe Kommentar über der Route in routes.ts,
   "GEZÄHLT wird hier bewusst nicht"). Ohne diese Probe hätte eine Änderung,
   die dort plötzlich doch zählt, hier nichts zum Kippen gebracht — die
   beiden Proben oben ändern sich nicht dadurch, dass GEZÄHLT wird, sondern
   nur dadurch, dass die Bremse schon GESETZT ist (über den Login-Weg).
   Genau DAS wäre aber der Fehler: würde das Salz mitgezählt, könnte ein
   Außenstehender ein fremdes Konto allein durch Salz-Anfragen aussperren,
   ohne je ein Passwort zu raten — ohne eigenes Login-Wissen, nur mit dem
   Benutzernamen. Deshalb: viel öfter als die Grenze Salz abfragen und
   danach die ANMELDUNG MIT RICHTIGEM PASSWORT prüfen, nicht nur den
   Statuscode der Salz-Antworten selbst. */
kontoAnlegen('hilde', PASSWORT);
for (let i = 0; i < 20; i++) await anfrage('/api/auth/anmeldesalz', { login: 'hilde' });
pruef('Zwanzig Salz-Anfragen hintereinander sperren das Konto NICHT aus — '
  + 'die richtige Anmeldung geht danach noch ganz normal durch',
  (await anfrage('/api/auth/login', { login: 'hilde', password: PASSWORT })).statusCode, 200);

kontoAnlegen('emil', PASSWORT);
const salzEmil = await anfrage('/api/auth/anmeldesalz', { login: 'emil' });
const emilFalsch = await nachweisBilden(FALSCH, unb64u(salzEmil.body.salz), salzEmil.body.runden);
for (let i = 0; i < 8; i++) await anfrage('/api/auth/login', { login: 'emil', nachweis: emilFalsch });
pruef('Und andersherum: acht Fehlversuche auf dem NEUEN Weg bremsen den alten mit',
  (await anfrage('/api/auth/login', { login: 'emil', password: PASSWORT })).statusCode, 429);

/* ── 6b) Dieselbe Person, andere Schreibweise — DERSELBE EIMER ───
 *
 * WAS ABSCHNITT 6 NICHT SIEHT
 *
 * Die Proben oben tippen den Namen jedes Mal gleich. Damit prüfen sie, DASS
 * die Bremse zählt — nicht, WORAUF sie zählt. Wäre der Schlüssel der Bremse
 * anders zurechtgelegt als die Kontosuche, änderte sich an keiner einzigen
 * Zeile dort etwas, und die Bremse wäre trotzdem wirkungslos.
 *
 * GENAU DAS WAR DER FALL. Der Schlüssel bestand aus Herkunft und
 * `login.toLowerCase()` — ohne `trim()`. Die Kontosuche legt den Namen aber
 * mit `trim().toLowerCase()` zurecht (blindIndex() in crypto/pii.ts, und im
 * Altbestands-Zweig von users.findByLogin() mit `login.trim()`). Ein Name
 * mit einem angehängten Leerzeichen öffnet also DASSELBE Konto, bekam aber
 * einen ZWEITEN Eimer. Wer bei jedem Versuch ein weiteres Leerzeichen
 * anhängt, zählt nie über eins: GRENZE = 8 wird nie erreicht, jedes Raten
 * wird trotzdem gegen den echten Nachweis geprüft, und weil das
 * blockierende scrypt daran hängt, hält das nebenbei den Server auf.
 *
 * WIE HIER GEPRÜFT WIRD
 *
 * Nicht mit einer ausgedachten Auswahl von Leerzeichen, sondern mit ALLEN
 * Zeichen, die String.prototype.trim() wirklich entfernt — die Liste wird
 * unten gegen die laufende Maschine nachgezählt, damit sie nicht altert.
 */
console.log('\n6b) Zählt die Bremse je KONTO oder je Schreibweise?');

/* WhiteSpace und LineTerminator nach ECMA-262 — genau die Zeichen, die
   `trim()` vorn und hinten wegnimmt. Als Codepunkt geschrieben, nie als
   Zeichen: ein blankes U+2028 im Quelltext wäre nicht zu sehen, und in
   einer Ausgabezeile wäre es nicht zu deuten. */
const TRIMMBAR: [string, string][] = ([
  ['U+0009 TAB', 0x0009], ['U+000A LF', 0x000a], ['U+000B VT', 0x000b],
  ['U+000C FF', 0x000c], ['U+000D CR', 0x000d], ['U+0020 SP', 0x0020],
  ['U+00A0 NBSP', 0x00a0], ['U+1680 OGHAM', 0x1680], ['U+2000', 0x2000],
  ['U+2001', 0x2001], ['U+2002', 0x2002], ['U+2003', 0x2003],
  ['U+2004', 0x2004], ['U+2005', 0x2005], ['U+2006', 0x2006],
  ['U+2007', 0x2007], ['U+2008', 0x2008], ['U+2009', 0x2009],
  ['U+200A', 0x200a], ['U+2028 LS', 0x2028], ['U+2029 PS', 0x2029],
  ['U+202F NNBSP', 0x202f], ['U+205F MMSP', 0x205f], ['U+3000 IDEO', 0x3000],
  ['U+FEFF ZWNBSP', 0xfeff],
] as [string, number][]).map(([name, cp]) => [name, String.fromCodePoint(cp)]);

/* Die Liste darf nicht aus dem Gedächtnis stammen. Der Durchlauf über den
   gesamten Coderaum kostet Millisekunden und hält sie auf dem Stand der
   Maschine, auf der dieser Lauf gerade stattfindet. */
const wirklichTrimmbar: string[] = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;          // halbe Ersatzzeichen
  const z = String.fromCodePoint(cp);
  if (`x${z}`.trim() === 'x') wirklichTrimmbar.push(z);
}
pruef('Die Liste hier IST, was trim() entfernt — nicht mehr und nicht weniger',
  TRIMMBAR.map(([, z]) => z).sort().join('') === wirklichTrimmbar.sort().join(''), true);
pruef('… und das sind 25 Zeichen', wirklichTrimmbar.length, 25);

/* Ein Konto, ein voller Eimer — gefüllt mit der schlichten Schreibweise. */
kontoAnlegen('ida', PASSWORT);
for (let i = 0; i < 8; i++) await anfrage('/api/auth/login', { login: 'ida', password: FALSCH });
pruef('Acht Fehlversuche füllen den Eimer',
  (await anfrage('/api/auth/login', { login: 'ida', password: PASSWORT })).statusCode, 429);

/* DIE PROBE. Jede Schreibweise, die dasselbe Konto öffnet, muss in denselben
   Eimer laufen — und zwar mit dem RICHTIGEN Passwort, damit ein 429 nicht
   mit einem gewöhnlichen 401 zu verwechseln ist. Ohne `trim()` im Schlüssel
   kommt hier jedes Mal 401 statt 429: frischer Eimer, echtes scrypt, Grenze
   nie erreicht. Gemeldet wird nur der Codepunkt, nie der Name. */
const durchgerutscht: string[] = [];
for (const [name, zeichen] of TRIMMBAR) {
  for (const schreibweise of [`ida${zeichen}`, `${zeichen}ida`, `${zeichen}IDA${zeichen}`]) {
    const a = await anfrage('/api/auth/login', { login: schreibweise, password: PASSWORT });
    if (a.statusCode !== 429) durchgerutscht.push(name);
  }
}
pruef('KEINE Schreibweise desselben Kontos bekommt einen frischen Eimer '
  + '(vorn, hinten, und mit Großbuchstaben)',
  [...new Set(durchgerutscht)].join(' '), '');

/* Und dieselbe Frage für die ZWEITE Tür: die Wegbeschreibung liest die
   Bremse ebenfalls, mit einem eigenen Schlüssel an einer eigenen Zeile. Nur
   eine der beiden zu reparieren ließe die andere offen. */
const salzDurchgerutscht: string[] = [];
for (const [name, zeichen] of TRIMMBAR) {
  const a = await anfrage('/api/auth/anmeldesalz', { login: `ida${zeichen}` });
  if (a.statusCode !== 429) salzDurchgerutscht.push(name);
}
pruef('Auch die Wegbeschreibung kennt keine frischen Eimer je Schreibweise',
  salzDurchgerutscht.join(' '), '');

/* Die Gegenrichtung: nicht nur das LESEN der Bremse, auch das ZÄHLEN muss
   auf dem gemeinsamen Schlüssel liegen. Acht Fehlversuche in acht
   VERSCHIEDENEN Schreibweisen — danach ist die schlichte Schreibweise
   gebremst, ohne dass sie selbst je danebengelegen hätte. */
kontoAnlegen('jonas', PASSWORT);
for (let i = 0; i < 8; i++) {
  await anfrage('/api/auth/login', { login: `jonas${TRIMMBAR[i][1]}`, password: FALSCH });
}
pruef('Acht Fehlversuche in acht verschiedenen Schreibweisen bremsen auch die schlichte',
  (await anfrage('/api/auth/login', { login: 'jonas', password: PASSWORT })).statusCode, 429);

/* DIE LINIE NACH AUSSEN. U+200B (Nullbreiten-Leerzeichen), U+2060 und
   U+180E sehen aus wie nichts, werden von trim() aber NICHT entfernt — sie
   sind keine Zs, sondern Formatzeichen. Sie gehören deshalb auch nicht in
   denselben Eimer: sie öffnen das Konto gar nicht erst. Wer damit rät, rät
   gegen den gleichzeitigen Nein-Weg und erfährt über das echte Passwort
   nichts. Diese Probe zieht die Linie genau dort, wo die Kontosuche sie
   zieht — und hält damit fest, dass der Schlüssel nicht MEHR wegwerfen darf
   als die Suche. */
for (const [name, cp] of [['U+200B', 0x200b], ['U+2060', 0x2060], ['U+180E', 0x180e]] as [string, number][]) {
  const zeichen = String.fromCodePoint(cp);
  pruef(`${name} wird von trim() NICHT entfernt`, `x${zeichen}`.trim() === 'x', false);
  pruef(`… und öffnet das Konto deshalb auch mit richtigem Passwort nicht`,
    (await anfrage('/api/auth/login', { login: `ida${zeichen}`, password: PASSWORT })).statusCode, 401);
}

/* ── 6c) Und sperrt das gröbere Zusammenlegen jemanden aus? ────
 *
 * Der Server steht auf einem Rechner, an den niemand herankommt — dieselbe
 * Sorge wie in Abschnitt 4. Der Schlüssel ist jetzt GRÖBER als vorher: er
 * legt Eimer zusammen, er teilt keine auf. Es kann also kein Eimer neu
 * entstehen, in den jemand fällt, der vorher durchkam. Das ist das
 * Argument; hier steht die Probe dazu.
 */
console.log('\n6c) Kann das niemanden aussperren?');

kontoAnlegen('karl', PASSWORT);
for (let i = 0; i < 7; i++) await anfrage('/api/auth/login', { login: 'karl', password: FALSCH });
pruef('Sieben Fehlversuche — die richtige Anmeldung geht durch, auch mit angehängtem Leerzeichen',
  (await anfrage('/api/auth/login', { login: 'karl ', password: PASSWORT })).statusCode, 200);
/* Und der gelungene Login hat den GEMEINSAMEN Eimer geräumt, nicht bloß
   einen eigenen für die Schreibweise mit Leerzeichen — sonst stünde der
   Zähler noch bei sieben und der nächste Fehlversuch schlüge sofort in die
   Grenze. */
for (let i = 0; i < 7; i++) await anfrage('/api/auth/login', { login: 'karl', password: FALSCH });
pruef('… und danach zählt der gemeinsame Eimer wieder von vorn',
  (await anfrage('/api/auth/login', { login: 'karl', password: PASSWORT })).statusCode, 200);

/* Zwei Namen teilen sich nur dann einen Eimer, wenn sie auch dieselbe
   Kontozeile finden — der Schlüssel IST ja die Normalisierung der
   Kontosuche. Ein Name, der einen anderen als Anfang enthält, ist ein
   anderes Konto und bleibt unbehelligt. */
kontoAnlegen('karlchen', PASSWORT);
for (let i = 0; i < 8; i++) await anfrage('/api/auth/login', { login: 'karl', password: FALSCH });
pruef('Ein voller Eimer bremst das namensähnliche Nachbarkonto nicht',
  (await anfrage('/api/auth/login', { login: 'karlchen', password: PASSWORT })).statusCode, 200);

/* ── 6d) Ein Rumpf, der nicht aus der eigenen App kommt ──────
 *
 * `login` wurde nur auf "irgendwas Wahres" geprüft und danach als
 * Zeichenkette behandelt. {"login":{}} lief deshalb erst in der
 * Normalisierung auf einen Fehler: 500 statt 400. Keine Lücke — aber eine
 * 500 ist die Auskunft "hier ist etwas kaputt", und das lädt zum
 * Weitersuchen ein.
 */
console.log('\n6d) Ein Rumpf mit falschen Typen');

for (const [was, rumpf] of [
  ['ein Objekt', { login: {}, password: PASSWORT }],
  ['eine Zahl', { login: 7, password: PASSWORT }],
  ['eine Liste', { login: ['ida'], password: PASSWORT }],
] as [string, unknown][]) {
  const a = await anfrage('/api/auth/login', rumpf);
  pruef(`Anmeldung, login ist ${was}: 400 statt 500`, a.statusCode, 400);
  pruef('… mit der gewohnten Kennung', a.body?.code, 'fehler.zugangsdatenFehlen');
}
pruef('Wegbeschreibung, login ist ein Objekt: 400 statt 500',
  (await anfrage('/api/auth/anmeldesalz', { login: {} })).statusCode, 400);

/* Beim GEHEIMNIS lag der Fall anders, und das gehört hier festgehalten:
   ein nicht-zeichenkettiges Passwort kam nie bis zu einer 500 — der
   try/catch in verifyPassword() (auth.ts) fängt den Fehler aus scryptSync
   und antwortet nach DERSELBEN ZEIT mit "falsch". Das war also schon in
   Ordnung. Die 400 hier ist die ehrlichere Antwort auf einen kaputten
   Rumpf, keine Reparatur einer Lücke — und sie fällt VOR jeder Kontosuche,
   verrät über das Konto also nichts.

   Ein Name mit LEEREM Eimer, sonst antwortete die Bremse mit 429, bevor
   der Typ überhaupt zum Tragen käme, und die Probe prüfte nicht mehr das,
   was sie behauptet. */
for (const [was, rumpf] of [
  ['password ist ein Objekt', { login: 'lena', password: {} }],
  ['nachweis ist ein Objekt', { login: 'lena', nachweis: {} }],
] as [string, unknown][]) {
  const a = await anfrage('/api/auth/login', rumpf);
  pruef(`Anmeldung, ${was}: 400 statt eines beiläufigen 401`, a.statusCode, 400);
  pruef('… mit der gewohnten Kennung', a.body?.code, 'fehler.zugangsdatenFehlen');
}

/* ── 7) Der Nachweis fällt mit dem Passwort ───────────────────────── */
console.log('\n7) Was mit dem Nachweis geschieht, wenn das Passwort wechselt');

const NEUES = 'noch-ein-langes-passwort';
changeOwnPassword('anna', PASSWORT, NEUES, verifyPassword);
pruef('Nach einem Passwortwechsel ist der Nachweis weg',
  db.all('SELECT 1 FROM anmelde_nachweise WHERE user_id = ?', 'anna').length, 0);
pruef('… der alte Nachweis öffnet also nichts mehr',
  (await anfrage('/api/auth/login', { login: 'anna', nachweis: nachweisAnna })).statusCode, 401);
pruef('… und die Anmeldung mit dem NEUEN Passwort geht ganz normal',
  (await anfrage('/api/auth/login', { login: 'anna', password: NEUES })).statusCode, 200);

/* Zurücksetzen durch die Verwaltung. */
kontoAnlegen('frida', PASSWORT);
const fridaToken: string = (await anfrage('/api/auth/login', { login: 'frida', password: PASSWORT })).body.token;
const salzFrida = crypto.getRandomValues(new Uint8Array(16));
await anfrage('/api/auth/nachweis', {
  kdf: ANMELDE_KDF, salz: b64u(salzFrida), runden: ANMELDE_RUNDEN,
  nachweis: await nachweisBilden(PASSWORT, salzFrida, ANMELDE_RUNDEN),
}, fridaToken);
pruef('Frida hat einen Nachweis', db.all('SELECT 1 FROM anmelde_nachweise WHERE user_id = ?', 'frida').length, 1);
resetPassword('frida', 'anna');
pruef('Nach dem Zurücksetzen durch die Verwaltung ist er weg',
  db.all('SELECT 1 FROM anmelde_nachweise WHERE user_id = ?', 'frida').length, 0);

/* Kontolöschung. Die users-Zeile wird nur GEÄNDERT, nie gelöscht — die
   Kaskade greift also nie von selbst, genau wie bei den Zustell-URLs. */
kontoAnlegen('gustav', PASSWORT);
const gustavToken: string = (await anfrage('/api/auth/login', { login: 'gustav', password: PASSWORT })).body.token;
const salzGustav = crypto.getRandomValues(new Uint8Array(16));
await anfrage('/api/auth/nachweis', {
  kdf: ANMELDE_KDF, salz: b64u(salzGustav), runden: ANMELDE_RUNDEN,
  nachweis: await nachweisBilden(PASSWORT, salzGustav, ANMELDE_RUNDEN),
}, gustavToken);
deleteAccount('gustav');
pruef('Nach einer Kontolöschung bleibt kein Nachweis als zweiter Zugang stehen',
  db.all('SELECT 1 FROM anmelde_nachweise WHERE user_id = ?', 'gustav').length, 0);

/* ── 8) Ein Rumpf ohne alles ──────────────────────────────────────── */
console.log('\n8) Unvollständige Anfragen');

pruef('Anmeldung ohne beides wird abgewiesen',
  (await anfrage('/api/auth/login', { login: 'anna' })).body?.code, 'fehler.zugangsdatenFehlen');
pruef('Wegbeschreibung ohne Namen wird abgewiesen',
  (await anfrage('/api/auth/anmeldesalz', {})).body?.code, 'fehler.zugangsdatenFehlen');
pruef('Ein Nachweis ohne Token wird abgewiesen',
  (await anfrage('/api/auth/nachweis', { kdf: ANMELDE_KDF, salz: 'x', runden: 1, nachweis: 'y' })).statusCode, 401);

console.log(fehler ? `\x1b[31m${fehler} fehlgeschlagen\x1b[0m` : '\x1b[32mok\x1b[0m');
process.exit(fehler ? 1 : 0);
