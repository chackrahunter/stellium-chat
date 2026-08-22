import crypto from 'node:crypto';
import type { PushSubscriptionJSON } from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { config, pushConfigured } from '../config.js';
import { oeffentlichAusRoh, rohOeffentlich, schluesselpaarAusRoh } from '../crypto/ec.js';

/**
 * Web Push — Benachrichtigungen, die ankommen, ohne dass die App läuft.
 *
 * DER UNTERSCHIED ZUM BISHERIGEN WEG
 *
 * Jede Benachrichtigung bis hierher — `state/store.ts` → `zeigen()` →
 * `ServiceWorkerRegistration.showNotification` oder `new Notification()` —
 * setzt eine offene Verbindung voraus: ein Browser-Tab oder eine
 * Startbildschirm-App, die gerade läuft und am Draht hängt. Auf einem
 * gesperrten Telefon ist beides nicht der Fall, egal wie das Ereignis
 * entsteht. Deshalb kam bisher jedes ECHTE Ereignis nie an, während die
 * Probe-Benachrichtigung funktionierte — sie entsteht ja genau in dem
 * Moment, in dem man auf die offene App schaut.
 *
 * Web Push braucht keine offene Verbindung. Der Server schickt eine
 * verschlüsselte Nachricht an einen Push-Dienst (Apples, Googles oder
 * Mozillas, je nachdem woher das Gerät kam) — der liefert sie zu, auch wenn
 * das Telefon in der Tasche liegt. Der eigentliche Anzeige-Aufruf läuft dann
 * im Service Worker (`public/sw.js`, Ereignis `push`), nicht mehr in dieser
 * Datei.
 *
 * WARUM OHNE DAS PAKET "web-push"
 *
 * Fünf andere Beauftragte arbeiten gerade an diesem Repository, mehrere davon
 * an package.json-Dateien. Eine gemeinsame package-lock.json mitten in einem
 * `npm install` von zwei Prozessen gleichzeitig zu treffen, ist ein Risiko,
 * das dieses eine Paket nicht wert ist — der Algorithmus dahinter (RFC 8291,
 * RFC 8292) ist mit Node-Bordmitteln (node:crypto, HKDF, AES-128-GCM,
 * ECDH) vollständig nachbaubar, siehe unten.
 *
 * ZUSTÄNDIGKEIT
 *
 * Dieser Dienst kennt weder das Gateway noch den Aufbau einer Nachricht. Er
 * beantwortet zwei Fragen — "soll diese Person gerade etwas hören?" und
 * "dann schick es ihr" — und lässt offen, WELCHES Ereignis das war. Das
 * Gateway entscheidet, wann er gerufen wird.
 */

interface Abo { id: string; endpoint: string; p256dh: string; auth: string }

/* ── Abonnements ──────────────────────────────────────────────── */

export function abonnieren(userId: string, sub: PushSubscriptionJSON): void {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;
  db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    newId('psh_'), userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now(),
  );
}

export function abbestellen(endpoint: string): void {
  db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', endpoint);
}

function abosFuer(userId: string): Abo[] {
  return db.all<Abo>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', userId,
  );
}

/* ── Soll überhaupt benachrichtigt werden? ───────────────────────
   Gegenstück zu notifyIfNeeded() in packages/desktop/src/state/store.ts.
   Muss hier noch einmal stehen, weil im Moment des Zustellens kein
   Browser-Tab mehr läuft, der selbst entscheiden könnte. */

interface Empfaenger {
  notify_on: string;
  status: string;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  timezone: string;
}

/** Minuten seit Mitternacht — in der Zeitzone der Person, nicht des Servers. */
function minutenSeitMitternacht(timezone: string): number {
  try {
    const teile = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    // hour12:false liefert für Mitternacht in manchen Engines "24" statt "00".
    const stunde = Number(teile.find((t) => t.type === 'hour')?.value ?? '0') % 24;
    const minute = Number(teile.find((t) => t.type === 'minute')?.value ?? '0');
    return stunde * 60 + minute;
  } catch {
    // Unbekannte oder falsch eingetragene Zeitzone: lieber wie "immer wach"
    // rechnen als eine Ruhezeit zu erfinden, die niemand gesetzt hat.
    const jetzt = new Date();
    return jetzt.getUTCHours() * 60 + jetzt.getUTCMinutes();
  }
}

function inRuhezeit(u: Empfaenger): boolean {
  if (u.quiet_hours_start == null || u.quiet_hours_end == null) return false;
  const jetzt = minutenSeitMitternacht(u.timezone);
  const { quiet_hours_start: start, quiet_hours_end: end } = u;
  return start <= end ? jetzt >= start && jetzt < end : jetzt >= start || jetzt < end;
}

/**
 * Soll diese Person gerade eine Push-Benachrichtigung bekommen?
 *
 * `dringend` steht für alles, was direkt an die Person adressiert ist —
 * eine Erwähnung, eine Direktnachricht, eine zugeteilte Aufgabe, ein für sie
 * bestimmter KI-Vorschlag, eine eigene fällige Erinnerung. Genau wie im
 * Vorbild in store.ts kommt Dringendes durch Ruhezeiten, Stummschaltung und
 * "nur Erwähnungen" hindurch — nur "aus" und "nicht stören" halten auch das
 * noch zurück.
 */
export function sollBenachrichtigen(
  userId: string,
  opts: { channelId?: string | null; dringend: boolean },
): boolean {
  const u = db.get<Empfaenger>(
    'SELECT notify_on, status, quiet_hours_start, quiet_hours_end, timezone FROM users WHERE id = ?', userId,
  );
  if (!u) return false;
  if (u.notify_on === 'none') return false;
  if (u.status === 'dnd') return false;
  if (u.notify_on === 'mentions' && !opts.dringend) return false;
  if (opts.channelId && !opts.dringend) {
    const mitgliedschaft = db.get<{ muted: number }>(
      'SELECT muted FROM channel_members WHERE channel_id = ? AND user_id = ?', opts.channelId, userId,
    );
    if (mitgliedschaft?.muted) return false;
  }
  if (inRuhezeit(u) && !opts.dringend) return false;
  return true;
}

/* ── VAPID: diesen Server gegenüber dem Push-Dienst ausweisen ───── */

function b64url(input: Buffer): string { return input.toString('base64url'); }

/**
 * Ein VAPID-JWT für genau diesen Push-Dienst (RFC 8292).
 *
 * `aud` muss der bloße Ursprung des Zustell-Endpunkts sein (z. B.
 * "https://fcm.googleapis.com"), nicht die volle Adresse — sonst weist der
 * Dienst die Anfrage ab. Zwölf Stunden Gültigkeit sind großzügig: das Token
 * entsteht neu bei jedem Versand, es muss nur diesen einen Versand
 * überstehen.
 */
function vapidJwt(audience: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: config.push.subject,
  })));
  const signingInput = `${header}.${claims}`;
  const schluessel = schluesselpaarAusRoh(
    Buffer.from(config.push.privateKey, 'base64url'),
    Buffer.from(config.push.publicKey, 'base64url'),
  );
  /* dsaEncoding: 'ieee-p1363' liefert r‖s als feste 64 Byte statt ASN.1/DER —
     genau die Rohform, die ein JWS-Signaturteil braucht. Ohne diese Angabe
     läge hier eine DER-Struktur, die kein Browser als JWT akzeptiert. */
  const signatur = crypto.sign('sha256', Buffer.from(signingInput), {
    key: schluessel, dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signatur)}`;
}

/* ── Nutzlast verschlüsseln (RFC 8291, Content-Encoding aes128gcm) ── */

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, laenge: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, laenge));
}

/**
 * Eine Nutzlast für genau ein Abonnement verschlüsseln.
 *
 * Ein zweites Schlüsselpaar kommt hier ins Spiel — nicht das VAPID-Paar von
 * oben (das weist nur den Server aus), sondern ein frisches, nur für diese
 * eine Nachricht erzeugtes ECDH-Paar. Der Push-Dienst selbst kann die
 * Nutzlast nicht lesen, nur das Gerät, dessen `p256dh`/`auth` hier eingehen —
 * das ist der Sinn der Übung: der Dienst liefert nur zu, er liest nicht mit.
 */
function verschluesseln(klartext: Buffer, p256dhB64: string, authB64: string): Buffer {
  const empfaengerPunkt = Buffer.from(p256dhB64, 'base64url');
  const authSecret = Buffer.from(authB64, 'base64url');
  const empfaenger = oeffentlichAusRoh(empfaengerPunkt);

  const { publicKey: ephPub, privateKey: ephPriv } =
    crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ephPubRoh = rohOeffentlich(ephPub);

  const geheim = crypto.diffieHellman({ privateKey: ephPriv, publicKey: empfaenger });

  // Erste HKDF-Runde: aus dem ECDH-Geheimnis und dem Auth-Secret des Geräts
  // ein gemeinsames IKM ableiten (RFC 8291 Abschnitt 3.4).
  const authInfo = Buffer.concat([Buffer.from('WebPush: info\0'), empfaengerPunkt, ephPubRoh]);
  const ikm = hkdf(authSecret, geheim, authInfo, 32);

  // Zweite Runde: aus dem IKM und einem zufälligen Salt Schlüssel und Nonce
  // für AES-128-GCM ableiten (RFC 8188).
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 markiert "letzter (und hier: einziger) Datensatz" — die Nutzlast
  // ist ein paar hundert Byte groß, Push-Dienste erlauben ohnehin nur bis
  // 4096 verschlüsselt, ein zweiter Datensatz wird nie gebraucht.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const chiffrat = Buffer.concat([
    cipher.update(Buffer.concat([klartext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // Aufbau nach RFC 8188 §2: Salt(16) ‖ RecordSize(4, big-endian) ‖
  // KeyIdLänge(1) ‖ KeyId(der eigene öffentliche Punkt) ‖ Chiffrat.
  const kopf = Buffer.alloc(16 + 4 + 1);
  salt.copy(kopf, 0);
  kopf.writeUInt32BE(4096, 16);
  kopf.writeUInt8(ephPubRoh.length, 20);

  return Buffer.concat([kopf, ephPubRoh, chiffrat]);
}

/* ── Versand ──────────────────────────────────────────────────── */

/** Ein Tag — länger liegen gebliebene Chat-Ereignisse sind meist ohnehin überholt. */
const TTL_SEKUNDEN = 24 * 3600;

async function anEinGeraet(abo: Abo, nutzlast: Buffer): Promise<void> {
  const ziel = new URL(abo.endpoint);
  const antwort = await fetch(abo.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'aes128gcm',
      ttl: String(TTL_SEKUNDEN),
      authorization: `vapid t=${vapidJwt(ziel.origin)}, k=${config.push.publicKey}`,
    },
    body: nutzlast,
  });

  if (antwort.status === 404 || antwort.status === 410) {
    // Der Push-Dienst kennt das Gerät nicht mehr — abgemeldet, Browserdaten
    // gelöscht, oder es war nie ein gültiges Abonnement. Aufräumen statt bei
    // jeder künftigen Nachricht erneut daran zu scheitern.
    abbestellen(abo.endpoint);
    return;
  }
  if (!antwort.ok) {
    throw new Error(`Push-Dienst antwortete ${antwort.status} ${antwort.statusText}`);
  }
}

/**
 * Eine Benachrichtigung an alle Geräte einer Person schicken.
 *
 * Wirft nie — ein unerreichbarer Push-Dienst oder ein einzelnes verfallenes
 * Abonnement darf weder das Absenden einer Chat-Nachricht verzögern noch die
 * Zustellung an die anderen Geräte derselben Person verhindern. Der Aufrufer
 * ruft das bewusst ohne `await` auf (siehe ws/gateway.ts).
 */
export async function sendenAn(
  userId: string,
  nachricht: { titel: string; text: string; kanalId?: string | null; gruppe?: string },
): Promise<void> {
  if (!pushConfigured()) return;
  const abos = abosFuer(userId);
  if (!abos.length) return;

  const nutzlast = Buffer.from(JSON.stringify({
    titel: nachricht.titel.slice(0, 200),
    text: nachricht.text.slice(0, 500),
    kanalId: nachricht.kanalId ?? null,
    gruppe: nachricht.gruppe ?? null,
  }));

  await Promise.all(abos.map(async (abo) => {
    try {
      await anEinGeraet(abo, verschluesseln(nutzlast, abo.p256dh, abo.auth));
    } catch (err) {
      console.error('[push]', abo.id, (err as Error).message);
    }
  }));
}
