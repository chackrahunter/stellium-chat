import crypto, { type KeyObject } from 'node:crypto';

/**
 * P-256-Schlüssel in der rohen Form, die außerhalb von Node üblich ist.
 *
 * Node selbst denkt in DER/PEM/JWK. Alles, was mit einem Browser spricht —
 * `PushSubscription.getKey()`, `applicationServerKey`, das VAPID-Verfahren —
 * denkt in rohen Bytes: der öffentliche Schlüssel als unkomprimierter Punkt
 * (0x04 + 32 Byte X + 32 Byte Y, 65 Byte insgesamt), der private als reiner
 * 32-Byte-Skalar. Diese Datei übersetzt in beide Richtungen, einmal an einer
 * Stelle statt in jeder Funktion neu.
 *
 * Der Umweg über JWK statt über DER-Byte-Offsets ist kein Zufall: DER-Größen
 * hängen von Kodierungsdetails ab, die sich zwischen Node-Fassungen leise
 * ändern können. JWK benennt X, Y und D einzeln und base64url-kodiert —
 * daraus lässt sich der rohe Punkt ohne Rätselraten zusammensetzen.
 */

export function rohOeffentlich(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
}

export function rohPrivat(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { d: string };
  return Buffer.from(jwk.d, 'base64url');
}

/** Einen fremden öffentlichen Punkt einlesen — z. B. `p256dh` eines Abonnements. */
export function oeffentlichAusRoh(punkt: Buffer): KeyObject {
  if (punkt.length !== 65 || punkt[0] !== 0x04) {
    throw new Error('Kein unkomprimierter P-256-Punkt (65 Byte, beginnend mit 0x04).');
  }
  return crypto.createPublicKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: punkt.subarray(1, 33).toString('base64url'),
      y: punkt.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * Ein eigenes Schlüsselpaar wieder einlesen.
 *
 * Braucht beide Hälften zugleich: ein privater JWK-Schlüssel ohne X/Y ist
 * zwar zum Signieren genug, aber Node besteht beim Einlesen auf einem
 * vollständigen Punkt. Da ohnehin beide Hälften gemeinsam abgelegt werden
 * (siehe config.ts), kostet das nichts zusätzlich.
 */
export function schluesselpaarAusRoh(privatSkalar: Buffer, oeffentlichPunkt: Buffer): KeyObject {
  if (oeffentlichPunkt.length !== 65 || oeffentlichPunkt[0] !== 0x04) {
    throw new Error('Kein unkomprimierter P-256-Punkt (65 Byte, beginnend mit 0x04).');
  }
  return crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: oeffentlichPunkt.subarray(1, 33).toString('base64url'),
      y: oeffentlichPunkt.subarray(33, 65).toString('base64url'),
      d: privatSkalar.toString('base64url'),
    },
    format: 'jwk',
  });
}

export function neuesSchluesselpaar(): { oeffentlich: Buffer; privat: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { oeffentlich: rohOeffentlich(publicKey), privat: rohPrivat(privateKey) };
}
