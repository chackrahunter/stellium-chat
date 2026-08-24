import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeserver } from './probeserver.mjs';

/**
 * Kommt eine Push-Titel-Übersetzung wirklich unversehrt durch die ganze
 * Kette an: verschlüsselt (RFC 8291), mit VAPID ausgewiesen (RFC 8292),
 * zugestellt, entschlüsselt, im richtigen Titel gerendert?
 *
 * Läuft gegen den echten, gebauten Server — echte VAPID-Schlüssel (aus
 * config.ts, per .vapid-keys.json), echte Datenbank, echte, kompilierte
 * services/push.ts (inkl. push-i18n.ts). Der Push-DIENST selbst (Apple,
 * Google, Mozilla) wird durch einen lokalen HTTP-Server ersetzt, der nur
 * aufzeichnet statt zuzustellen — alles davor ist unverändert echt.
 *
 * Die Entschlüsselung unten ist ABSICHTLICH nicht aus push.ts kopiert,
 * sondern eigenständig aus dem RFC nachgebaut: ein Fehler in push.ts würde
 * sich sonst hier unbemerkt spiegeln können, statt aufzufallen.
 *
 * Prüft nur die vier im Auftrag genannten Sprachen (de/en/ja/ar) — die
 * übrigen 18 laufen über dasselbe push-i18n.ts und sind durch
 * scripts/push-woerterbuch-pruefen.mjs bereits gegen die 22 Wörterbücher
 * geprüft.
 */

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function rohOeffentlich(key) {
  const jwk = key.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const probe = await probeserver();

function mitDb(schreibbar, fn) {
  const db = new DatabaseSync(probe.datenbank, schreibbar ? {} : { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
const userId = mitDb(false, (db) => db.prepare('SELECT id FROM users LIMIT 1').get()).id;

// Echter VAPID-Öffentlich-Schlüssel, so wie ihn config.ts hält.
const vapid = JSON.parse(fs.readFileSync(path.join(probe.datenordner, '.vapid-keys.json'), 'utf8'));
const vapidPub = crypto.createPublicKey({
  key: {
    kty: 'EC', crv: 'P-256',
    x: Buffer.from(vapid.publicKey, 'base64url').subarray(1, 33).toString('base64url'),
    y: Buffer.from(vapid.publicKey, 'base64url').subarray(33, 65).toString('base64url'),
  },
  format: 'jwk',
});

// "Gerät": ein frisches EC-Schlüsselpaar + Auth-Secret — wie ein Browser es
// bei pushManager.subscribe() erzeugen würde.
const geraet = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const authSecret = crypto.randomBytes(16);

// "Push-Dienst": zeichnet auf statt zuzustellen.
const empfangen = [];
const dienst = http.createServer((req, res) => {
  const teile = [];
  req.on('data', (c) => teile.push(c));
  req.on('end', () => {
    empfangen.push({ headers: { ...req.headers }, body: Buffer.concat(teile) });
    res.writeHead(201, { location: `${req.url}/1` });
    res.end();
  });
});
await new Promise((f) => dienst.listen(0, '127.0.0.1', f));
const dienstPort = dienst.address().port;
const endpoint = `http://127.0.0.1:${dienstPort}/push-dienst-probe`;

mitDb(true, (db) => {
  db.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
              VALUES (?,?,?,?,?,?)`)
    .run('psh_e2e_i18n', userId, endpoint, b64u(rohOeffentlich(geraet.publicKey)), b64u(authSecret), Date.now());
});

function entschluesseln(nutzlast) {
  const salt = nutzlast.subarray(0, 16);
  const recordSize = nutzlast.readUInt32BE(16);
  const keyIdLen = nutzlast.readUInt8(20);
  const ephPubRoh = nutzlast.subarray(21, 21 + keyIdLen);
  const chiffratMitTag = nutzlast.subarray(21 + keyIdLen);

  const ephPub = crypto.createPublicKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: ephPubRoh.subarray(1, 33).toString('base64url'),
      y: ephPubRoh.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const geheim = crypto.diffieHellman({ privateKey: geraet.privateKey, publicKey: ephPub });
  const geraetOeffentlichRoh = rohOeffentlich(geraet.publicKey);

  const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), geraetOeffentlichRoh, ephPubRoh]);
  const ikm = hkdf(authSecret, geheim, authInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const tag = chiffratMitTag.subarray(chiffratMitTag.length - 16);
  const chiffrat = chiffratMitTag.subarray(0, chiffratMitTag.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const klartextMitPolster = Buffer.concat([decipher.update(chiffrat), decipher.final()]);

  muss(klartextMitPolster[klartextMitPolster.length - 1] === 0x02, 'Kein 0x02-Trenner am Ende — Polsterung stimmt nicht.');
  return { klartext: klartextMitPolster.subarray(0, -1), recordSize };
}

function vapidPruefen(authHeader, erwarteterUrsprung) {
  const m = authHeader.match(/^vapid t=([^,]+), k=(.+)$/);
  muss(Boolean(m), `Authorization-Kopf hat nicht die erwartete Form: ${authHeader}`);
  const [, jwt, k] = m;
  const [headerB64, claimsB64, sigB64] = jwt.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString());
  muss(header.alg === 'ES256' && header.typ === 'JWT', `Unerwarteter JWT-Kopf: ${JSON.stringify(header)}`);
  muss(claims.aud === erwarteterUrsprung, `aud stimmt nicht: ${claims.aud} != ${erwarteterUrsprung}`);
  muss(claims.exp > Date.now() / 1000, 'JWT ist abgelaufen.');
  const gueltig = crypto.verify(
    'sha256', Buffer.from(`${headerB64}.${claimsB64}`),
    { key: vapidPub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sigB64, 'base64url'),
  );
  muss(gueltig, 'VAPID-Signatur ist UNGÜLTIG.');
  muss(k === vapid.publicKey, 'k im Authorization-Kopf stimmt nicht mit dem VAPID-Schlüssel überein.');
  return { header, claims };
}

process.env.DATA_DIR = probe.datenordner;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const push = await import(path.resolve(REPO, 'packages/server/dist/services/push.js'));

const SPRACHEN = { de: 'Deutsch', en: 'Englisch', ja: 'Japanisch', ar: 'Arabisch' };
const titel = {};

for (const [code, name] of Object.entries(SPRACHEN)) {
  await pruefe(`${name} (${code}): verschlüsselt, zugestellt, VAPID gültig, entschlüsselt, richtiger Titel`, async () => {
    mitDb(true, (db) => { db.prepare('UPDATE users SET ui_language = ? WHERE id = ?').run(code, userId); });
    empfangen.length = 0;

    await push.sendenAn(userId, {
      titel: { text: 'Neue Nachricht', code: 'toast.newMessage' },
      text: { text: 'Ada Lovelace: Bist du gleich da?' },
      kanalId: 'probe-kanal',
      gruppe: 'probe-kanal',
    });

    const bis = Date.now() + 5000;
    while (!empfangen.length && Date.now() < bis) await new Promise((f) => setTimeout(f, 50));
    muss(empfangen.length > 0, 'keine Zustellung beim fingierten Push-Dienst angekommen');

    const { headers, body } = empfangen[0];
    muss(headers['content-encoding'] === 'aes128gcm', `content-encoding: ${headers['content-encoding']}`);
    muss(headers.ttl === String(24 * 3600), `ttl: ${headers.ttl}`);
    vapidPruefen(headers.authorization, `http://127.0.0.1:${dienstPort}`);
    const { klartext, recordSize } = entschluesseln(body);
    muss(recordSize === 4096, `record size ${recordSize} != 4096`);
    const daten = JSON.parse(klartext.toString('utf8'));
    muss(typeof daten.titel === 'string' && daten.titel.length > 0, 'kein Titel in der entschlüsselten Nutzlast');
    titel[code] = daten.titel;
    return `"${daten.titel}"`;
  });
}

await pruefe('Der Nachrichtentext selbst bleibt unübersetzt (kein UI-Text)', async () => {
  const { text } = JSON.parse(entschluesseln(empfangen[0].body).klartext.toString('utf8'));
  muss(text === 'Ada Lovelace: Bist du gleich da?', `text wurde verändert: "${text}"`);
});

dienst.close();
await probe.stop();

console.log('\nAufgelöste Titel:');
for (const [code, name] of Object.entries(SPRACHEN)) {
  if (titel[code]) console.log(`  ${name.padEnd(10)} (${code})  ${titel[code]}`);
}

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
