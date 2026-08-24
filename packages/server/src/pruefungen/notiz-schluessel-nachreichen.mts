/**
 * Prüft die Server-Seite des Fehlerberichts "Notiz bleibt für immer bei
 * 'Wird entschlüsselt…' stehen": eine Notiz mit einem Mitglied, für das
 * gerade kein Schlüsselpaket mehr vorliegt (Person hat gerade erst einen
 * neuen Schlüssel hinterlegt, oder das Paket ist aus einem anderen Grund
 * verschwunden), UND die besitzende Person war offline, als der bisherige
 * Anstoß (ws/gateway.ts, `vertraulich:schluessel-melden` →
 * `notizen.fehlendeMitgliedschaften`) verschickt wurde — er verpuffte, ohne
 * dass sich das Paket je gefüllt hätte.
 *
 * `eigeneUnverpackteMitglieder()` (services/notizen.ts) ist der zweite Weg
 * dorthin: aus Sicht der BESITZENDEN Person selbst, bei jeder eigenen
 * Rückkehr aus dem Offline-Zustand (ws/gateway.ts, `ready()`, `wasOffline`).
 * Dieser Lauf prüft NUR die Abfrage selbst — den echten Verbindungsaufbau
 * gegen die WS-Gegenstelle nachzustellen würde einen laufenden Server
 * brauchen, den dieser Auftrag ausdrücklich ausschließt. Die Verdrahtung in
 * `ready()` ist stattdessen von Hand gelesen (siehe Bericht).
 *
 * Aufruf:  node scripts/notiz-schluessel-nachreichen-pruefen.mjs
 */
import crypto, { webcrypto } from 'node:crypto';
import { nutzlastLesen, nutzlastSchreiben, PAKET_ALG, type SchluesselPaket } from '@stellium/shared';
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

/* ── Dieselbe Rechnung wie in notizen-verschluesselung.mts ────────────── */

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url'); }
function unb64u(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, 'base64url')); }
async function sha256(text: string): Promise<Uint8Array> { return new Uint8Array(await subtle.digest('SHA-256', enc.encode(text))); }

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
function notizKontext(notizId: string, fassung: number, von: string, fuer: string): string {
  return `stellium/notiz/${notizId}/${fassung}/${von}>${fuer}`;
}
async function paketPacken(von: string, vonPrivat: webcrypto.CryptoKey, fuerJwk: string, notizKey: webcrypto.CryptoKey, kontext: string): Promise<SchluesselPaket> {
  const roh = await subtle.exportKey('raw', notizKey);
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

/* ── Bühne: eine besitzende Person, ein Mitglied ──────────────────────── */

function person(id: string): void {
  db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
          VALUES (?,?,?,'x',0)`, id, id, id);
}
person('besitzt1');
person('mitglied1');

const paarBesitzt = await paarErzeugen();
const paarMitglied = await paarErzeugen();
const jwkBesitzt = await oeffentlichesJwk(paarBesitzt);
const jwkMitglied = await oeffentlichesJwk(paarMitglied);
vertraulich.schluesselMelden({ userId: 'besitzt1', jwk: jwkBesitzt, abdruck: 'besitzt1-abdruck' });
vertraulich.schluesselMelden({ userId: 'mitglied1', jwk: jwkMitglied, abdruck: 'mitglied1-abdruck' });

const notizId = `nz_${crypto.randomBytes(16).toString('hex')}`;
const TITEL = 'Wiedervorlage';
const TEXT = 'Nur für besitzt1 und mitglied1 bestimmt.';
const notizKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const chiffrat = await inhaltVerschluesseln(1, notizKey, { titel: TITEL, text: TEXT });
const eigenesPaket = await paketPacken('besitzt1', paarBesitzt.privateKey, jwkBesitzt, notizKey, notizKontext(notizId, 1, 'besitzt1', 'besitzt1'));
notizen.anlegen({ id: notizId, ownerId: 'besitzt1', chiffrat, paket: eigenesPaket });

const paketFuerMitglied = await paketPacken('besitzt1', paarBesitzt.privateKey, jwkMitglied, notizKey, notizKontext(notizId, 1, 'besitzt1', 'mitglied1'));
notizen.mitgliedHinzufuegen({ notizId, ownerId: 'besitzt1', zielUserId: 'mitglied1', paket: paketFuerMitglied });

console.log('\nNormalfall — frisch hinzugefügt, Paket liegt vor:');
pruefWahr(
  'eigeneUnverpackteMitglieder(besitzt1) meldet nichts, solange das Paket steht',
  notizen.eigeneUnverpackteMitglieder('besitzt1').length === 0,
);
pruefWahr(
  'fehlendeMitgliedschaften(mitglied1) meldet ebenfalls nichts',
  notizen.fehlendeMitgliedschaften('mitglied1').length === 0,
);

/* ── Das Paket verschwindet (Schlüsselwechsel, verlorene Zeile, …) ────── */

console.log('\nPaket von mitglied1 fehlt — besitzt1 kommt zurück:');
db.run('DELETE FROM notiz_schluessel_pakete WHERE notiz_id = ? AND user_id = ?', notizId, 'mitglied1');

const luecke = notizen.eigeneUnverpackteMitglieder('besitzt1');
pruef('eigeneUnverpackteMitglieder(besitzt1) findet genau eine Lücke', luecke.length, 1);
pruef('… für genau diese Notiz und dieses Mitglied', luecke[0], { notizId, userId: 'mitglied1' });
pruefWahr(
  'fehlendeMitgliedschaften(mitglied1) sieht dieselbe Lücke aus Mitgliedssicht',
  notizen.fehlendeMitgliedschaften('mitglied1').some((e) => e.notizId === notizId && e.ownerId === 'besitzt1'),
);
pruef('paketFuer(notizId, mitglied1) liefert währenddessen nichts', notizen.paketFuer(notizId, 'mitglied1'), null);

/* ── besitzt1 (jetzt online) verpackt nach — derselbe Weg wie
   notiz:pakete-nachreichen, ausgelöst durch den Anstoß aus
   eigeneUnverpackteMitglieder() ── */

const nachgereichtesPaket = await paketPacken('besitzt1', paarBesitzt.privateKey, jwkMitglied, notizKey, notizKontext(notizId, 1, 'besitzt1', 'mitglied1'));
notizen.paketeNachreichen({ notizId, ownerId: 'besitzt1', zielUserId: 'mitglied1', paket: nachgereichtesPaket });

pruefWahr(
  'eigeneUnverpackteMitglieder(besitzt1) ist danach wieder leer',
  notizen.eigeneUnverpackteMitglieder('besitzt1').length === 0,
);

const geholtesPaket = notizen.paketFuer(notizId, 'mitglied1');
pruefWahr('paketFuer(notizId, mitglied1) liefert jetzt wieder etwas', geholtesPaket !== null);

/* Kryptografischer Rundweg: mitglied1 kann mit dem nachgereichten Paket
   TATSÄCHLICH denselben Notizschlüssel zurückgewinnen und die Notiz lesen —
   nicht nur "eine Zeile steht in der Tabelle". */
const zurueckgewonnenerSchluessel = await paketAuspacken(
  paarMitglied.privateKey, jwkBesitzt, geholtesPaket!.paket, notizKontext(notizId, geholtesPaket!.fassung, 'besitzt1', 'mitglied1'),
);
const gelesen = await inhaltEntschluesseln(zurueckgewonnenerSchluessel, chiffrat);
pruef('mitglied1 liest nach dem Nachverpacken den echten Titel', gelesen.titel, TITEL);
pruef('mitglied1 liest nach dem Nachverpacken den echten Text', gelesen.text, TEXT);

/* ── Wer nicht mehr aktives Mitglied ist, löst keinen Anstoß aus ─────── */

console.log('\nEntferntes Mitglied bleibt außen vor:');
db.run('DELETE FROM notiz_schluessel_pakete WHERE notiz_id = ? AND user_id = ?', notizId, 'mitglied1');
db.run(
  `UPDATE notiz_mitglieder SET entfernt_am = ? WHERE notiz_id = ? AND user_id = ?`,
  Date.now(), notizId, 'mitglied1',
);
pruefWahr(
  'eigeneUnverpackteMitglieder(besitzt1) meldet ENTFERNTE Mitglieder nicht als Lücke',
  notizen.eigeneUnverpackteMitglieder('besitzt1').length === 0,
);

/* ── Nur die besitzende Person selbst bekommt die eigene Lücke gemeldet ─ */

pruefWahr(
  'eigeneUnverpackteMitglieder(mitglied1) meldet nichts — mitglied1 besitzt keine eigenen Notizen',
  notizen.eigeneUnverpackteMitglieder('mitglied1').length === 0,
);

/* ── Der dritte Fehlerort: ein Schlüsselwechsel selbst (services/
   vertraulich.ts, schluesselMelden) muss das MITGLIEDS-Paket ungültig
   machen, damit obiger Mechanismus überhaupt eine Lücke zu melden hat — vor
   dem Fix blieb das Paket stehen, die Buchhaltung hielt die Person für
   versorgt, und niemand wurde je angestoßen. ────────────────────────── */

console.log('\nSchlüsselwechsel eines MITGLIEDS macht dessen Paket ungültig:');

person('besitzt2');
person('mitglied2');
const paarBesitzt2 = await paarErzeugen();
const paarMitglied2a = await paarErzeugen();
const jwkBesitzt2 = await oeffentlichesJwk(paarBesitzt2);
const jwkMitglied2a = await oeffentlichesJwk(paarMitglied2a);
vertraulich.schluesselMelden({ userId: 'besitzt2', jwk: jwkBesitzt2, abdruck: 'besitzt2-a' });
vertraulich.schluesselMelden({ userId: 'mitglied2', jwk: jwkMitglied2a, abdruck: 'mitglied2-a' });

const notizId2 = `nz_${crypto.randomBytes(16).toString('hex')}`;
const TITEL2 = 'Rückruf Weber';
const TEXT2 = 'Nur für besitzt2 und mitglied2 bestimmt.';
const notizKey2 = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const chiffrat2 = await inhaltVerschluesseln(1, notizKey2, { titel: TITEL2, text: TEXT2 });
const eigenesPaket2 = await paketPacken('besitzt2', paarBesitzt2.privateKey, jwkBesitzt2, notizKey2, notizKontext(notizId2, 1, 'besitzt2', 'besitzt2'));
notizen.anlegen({ id: notizId2, ownerId: 'besitzt2', chiffrat: chiffrat2, paket: eigenesPaket2 });

const paketFuerMitglied2a = await paketPacken('besitzt2', paarBesitzt2.privateKey, jwkMitglied2a, notizKey2, notizKontext(notizId2, 1, 'besitzt2', 'mitglied2'));
notizen.mitgliedHinzufuegen({ notizId: notizId2, ownerId: 'besitzt2', zielUserId: 'mitglied2', paket: paketFuerMitglied2a });

pruefWahr(
  'vor dem Wechsel: mitglied2 hat ein Paket',
  notizen.paketFuer(notizId2, 'mitglied2') !== null,
);

// mitglied2 meldet einen NEUEN öffentlichen Teil — derselbe Vorgang wie ein
// Gerätewechsel ohne wiederhergestelltes Backup, oder ein zweites Gerät, das
// noch keinen eigenen Schlüssel hinterlegt hatte.
const paarMitglied2b = await paarErzeugen();
const jwkMitglied2b = await oeffentlichesJwk(paarMitglied2b);
const wechselErgebnis = vertraulich.schluesselMelden({ userId: 'mitglied2', jwk: jwkMitglied2b, abdruck: 'mitglied2-b' });
pruef('schluesselMelden meldet den Wechsel korrekt (gewechselt, nicht neu)', wechselErgebnis, { neu: false, gewechselt: true });

pruef(
  'DANACH: das alte Paket von mitglied2 ist weg — es war für den alten öffentlichen Teil verpackt und damit wertlos',
  notizen.paketFuer(notizId2, 'mitglied2'),
  null,
);
pruefWahr(
  'fehlendeMitgliedschaften(mitglied2) meldet jetzt die Lücke an besitzt2',
  notizen.fehlendeMitgliedschaften('mitglied2').some((e) => e.notizId === notizId2 && e.ownerId === 'besitzt2'),
);

// besitzt2 (weiterhin online, derselbe Anstoß wie oben) verpackt mit dem
// NEUEN öffentlichen Teil von mitglied2 neu.
const nachgereichtesPaket2 = await paketPacken('besitzt2', paarBesitzt2.privateKey, jwkMitglied2b, notizKey2, notizKontext(notizId2, 1, 'besitzt2', 'mitglied2'));
notizen.paketeNachreichen({ notizId: notizId2, ownerId: 'besitzt2', zielUserId: 'mitglied2', paket: nachgereichtesPaket2 });

pruefWahr(
  'fehlendeMitgliedschaften(mitglied2) ist danach wieder leer — die Lücke ist geschlossen',
  notizen.fehlendeMitgliedschaften('mitglied2').length === 0,
);

const geholtesPaket2 = notizen.paketFuer(notizId2, 'mitglied2');
pruefWahr('paketFuer(notizId2, mitglied2) liefert jetzt das neue Paket', geholtesPaket2 !== null);

// Kryptografischer Rundweg mit dem NEUEN Schlüsselpaar von mitglied2 — nicht
// nur eine Zeile in der Tabelle, sondern eine Person, die tatsächlich wieder
// lesen kann.
const zurueckgewonnen2 = await paketAuspacken(
  paarMitglied2b.privateKey, jwkBesitzt2, geholtesPaket2!.paket,
  notizKontext(notizId2, geholtesPaket2!.fassung, 'besitzt2', 'mitglied2'),
);
const gelesen2 = await inhaltEntschluesseln(zurueckgewonnen2, chiffrat2);
pruef('mitglied2 liest mit dem NEUEN Schlüsselpaar den echten Titel', gelesen2.titel, TITEL2);
pruef('… und den echten Text', gelesen2.text, TEXT2);

// Zur Sicherheit: das alte Schlüsselpaar von mitglied2 kann das neue Paket
// nicht mehr öffnen — es ist wirklich für den neuen öffentlichen Teil
// verpackt, nicht zufällig für beide gleichzeitig lesbar.
let altesPaarSchlaegtFehl = false;
try {
  await paketAuspacken(
    paarMitglied2a.privateKey, jwkBesitzt2, geholtesPaket2!.paket,
    notizKontext(notizId2, geholtesPaket2!.fassung, 'besitzt2', 'mitglied2'),
  );
} catch { altesPaarSchlaegtFehl = true; }
pruefWahr('das ALTE Schlüsselpaar von mitglied2 kann das neue Paket nicht mehr öffnen', altesPaarSchlaegtFehl);

/* ── Das eigene Paket der BESITZENDEN Person bleibt beim eigenen Wechsel
   unangetastet — siehe services/vertraulich.ts (schluesselMelden) für die
   ausführliche Begründung, warum sich das NICHT heilen lässt: kein anderes
   Gerät kann für "sich selbst" einspringen, und das Paket zu löschen würde
   nur ein zweites, noch gültiges Gerät desselben Kontos beschädigen, ohne
   dass irgendjemand davon profitiert. ─────────────────────────────────── */

console.log('\nEigener Schlüsselwechsel der BESITZENDEN Person lässt ihr eigenes Paket unangetastet:');

pruefWahr(
  'vor dem eigenen Wechsel: besitzt2 hat ein eigenes Paket zu notizId2',
  notizen.paketFuer(notizId2, 'besitzt2') !== null,
);
const eigenesPaketVorWechsel = notizen.paketFuer(notizId2, 'besitzt2');

const paarBesitzt2b = await paarErzeugen();
const jwkBesitzt2b = await oeffentlichesJwk(paarBesitzt2b);
const eigenerWechsel = vertraulich.schluesselMelden({ userId: 'besitzt2', jwk: jwkBesitzt2b, abdruck: 'besitzt2-b' });
pruef('schluesselMelden meldet auch hier korrekt einen Wechsel', eigenerWechsel, { neu: false, gewechselt: true });

pruef(
  'das eigene Paket von besitzt2 zu notizId2 steht UNVERÄNDERT weiter — es wäre sonst für niemanden mehr zu heilen gewesen',
  notizen.paketFuer(notizId2, 'besitzt2'),
  eigenesPaketVorWechsel,
);
pruefWahr(
  'das Mitgliedspaket von mitglied2 (oben frisch nachgereicht) ist von besitzt2s eigenem Wechsel unberührt',
  notizen.paketFuer(notizId2, 'mitglied2') !== null,
);

/* ── Eine erstmalige Schlüsselmeldung darf NIE etwas löschen ──────────── */

console.log('\nErstmalige Schlüsselmeldung zerstört nichts:');

person('frisch1');
person('besitztFuerFrisch');
const paarBesitztFuerFrisch = await paarErzeugen();
const jwkBesitztFuerFrisch = await oeffentlichesJwk(paarBesitztFuerFrisch);
vertraulich.schluesselMelden({ userId: 'besitztFuerFrisch', jwk: jwkBesitztFuerFrisch, abdruck: 'x' });

// frisch1 bekommt (auf eine Weise, wie sie im Alltag nie vorkommt, hier aber
// bewusst konstruiert) schon ein Notizpaket, BEVOR die eigene App je einen
// Schlüssel gemeldet hat — die Buchhaltung erlaubt das technisch, weil
// notiz_schluessel_pakete keine Fremdschlüsselbedingung an
// vertraulich_schluessel hat. Genau dieser Zustand ist der, den die
// "neu"-Abzweigung in schluesselMelden NICHT anrühren darf.
const notizIdFrisch = `nz_${crypto.randomBytes(16).toString('hex')}`;
const notizKeyFrisch = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const chiffratFrisch = await inhaltVerschluesseln(1, notizKeyFrisch, { titel: 'x', text: 'x' });
notizen.anlegen({
  id: notizIdFrisch, ownerId: 'besitztFuerFrisch', chiffrat: chiffratFrisch,
  paket: { alg: PAKET_ALG, von: 'besitztFuerFrisch', iv: 'AA', daten: 'BB' },
});
notizen.mitgliedHinzufuegen({
  notizId: notizIdFrisch, ownerId: 'besitztFuerFrisch', zielUserId: 'frisch1',
  paket: { alg: PAKET_ALG, von: 'besitztFuerFrisch', iv: 'AA', daten: 'BB' },
});

const paarFrisch1 = await paarErzeugen();
const jwkFrisch1 = await oeffentlichesJwk(paarFrisch1);
const ersteMeldung = vertraulich.schluesselMelden({ userId: 'frisch1', jwk: jwkFrisch1, abdruck: 'frisch1-a' });
pruef('die erste Meldung eines Kontos ist "neu", nicht "gewechselt"', ersteMeldung, { neu: true, gewechselt: false });
pruefWahr(
  'ein Paket, das schon vor der ersten Meldung bestand, bleibt bei "neu" unangetastet',
  notizen.paketFuer(notizIdFrisch, 'frisch1') !== null,
);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDie besitzende Person findet beim eigenen Wiederverbinden jede eigene Notiz, der noch ein Paket fehlt; ein Schlüsselwechsel eines Mitglieds macht dessen Paket ungültig und heilt über denselben Weg; das eigene Paket der besitzenden Person bleibt beim eigenen Wechsel unangetastet, weil es niemand heilen könnte; und eine erstmalige Schlüsselmeldung zerstört nichts.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
