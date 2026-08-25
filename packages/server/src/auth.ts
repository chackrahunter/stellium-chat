import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db/index.js';

/* ── Passwörter: scrypt aus node:crypto, keine native Abhängigkeit ── */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/* Fest und öffentlich: hier wird nichts geschützt, nur Zeit verbraucht. */
const AUSGLEICH_SALZ = Buffer.from('stellium/kein-konto');

/**
 * Dieselbe Arbeit leisten und trotzdem Nein sagen.
 *
 * Gerufen, wenn der hinterlegte Hash unbrauchbar ist — bei einem Konto, das es
 * nicht gibt, reicht die Anmeldung dafür einen Platzhalter herein. Ohne diesen
 * Umweg käme die Antwort dann sofort, während ein echtes Konto erst dreißig
 * Millisekunden scrypt kostet. Genau das war der Zustand: gemessen 1,2 ms für
 * einen erfundenen Benutzernamen gegen 29,8 ms für einen echten. Wer die Zeit
 * misst, hätte damit die Namensliste des Hauses abfragen können, ohne ein
 * einziges Passwort zu erraten.
 *
 * Der Ausgleich steht hier und nicht bei der Anmeldung, obwohl er dort
 * gemeint war: ein Platzhalter, der sich am Aufrufer versehentlich als
 * unbrauchbar erweist, ist eine stille Lücke — genau so ist sie entstanden.
 * Hier kann sie niemand mehr aus Versehen abschalten.
 */
function nachDerselbenZeit(password: string): false {
  try {
    crypto.scryptSync(password, AUSGLEICH_SALZ, SCRYPT.keylen, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
    });
  } catch { /* Der Wert zählt nicht, nur die Zeit. */ }
  return false;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return nachDerselbenZeit(password);
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(keyB64, 'base64url');
    if (!salt.length || !expected.length) return nachDerselbenZeit(password);
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return nachDerselbenZeit(password);
  }
}

/* ── Tokens: kompaktes HMAC-signiertes JWT (HS256), ohne Fremdpaket ── */

/**
 * `iat` und `exp` stehen in Sekunden, weil das bei JWT so verabredet ist.
 *
 * `ms` steht daneben und ist derselbe Zeitpunkt auf die Millisekunde genau.
 * Er ist nötig, um ein Token gegen `sitzungen_ab` zu halten: aus einer
 * Sekundenangabe lässt sich nicht entscheiden, ob ein Token vor oder nach
 * einem Passwortwechsel derselben Sekunde entstanden ist — und beide Antworten
 * wären falsch. Zu streng würfe man das frisch ausgestellte Token gleich mit
 * weg; zu milde überlebte das alte den Wechsel.
 *
 * Optional, weil Token aus der Zeit davor noch dreißig Tage unterwegs sind.
 * Für sie gilt die milde Regel: lieber eine Sekunde zu lang gültig als ein
 * ganzes Team ausgesperrt.
 */
interface TokenPayload { sub: string; iat: number; exp: number; ms?: number }

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signToken(userId: string, ttlSeconds = config.tokenTtlSeconds): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const ms = Date.now();
  const iat = Math.floor(ms / 1000);
  const payload = b64url(JSON.stringify(
    { sub: userId, iat, exp: iat + ttlSeconds, ms } satisfies TokenPayload,
  ));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Trägt das Konto dieses Token noch?
 *
 * Eine Unterschrift beweist nur, dass der Server dieses Token einmal
 * ausgestellt hat — sie sagt nichts darüber, ob das Konto dahinter heute noch
 * hereindarf. Dreißig Tage sind eine lange Zeit: sperren, löschen und ein
 * neues Passwort blieben ohne diese Prüfung folgenlos, bis die Frist von
 * selbst abläuft. Genau das war der Zustand — gesperrte Konten arbeiteten mit
 * ihrem alten Token weiter, und ein Passwortwechsel nach einem Diebstahl
 * änderte nichts an dem gestohlenen Token.
 *
 * Die Prüfung steht hier und nicht an den Aufrufstellen, und das ist der
 * ganze Punkt: `verifyToken` ist die einzige Tür, durch die ein Token zu
 * einer Kennung wird — im Gateway, in den HTTP-Wegen und in den
 * Adress-Nachweisen für Downloads. Stünde sie daneben, müsste man sie an
 * jeder neuen Stelle mitdenken, und eine davon vergäße man. Sie kostet einen
 * Blick auf einen Primärschlüssel, also nichts.
 */
function kontoTraegtToken(userId: string, ausgestellt: number): boolean {
  const stand = db.get<{
    disabled: number; deleted_at: number | null; sitzungen_ab: number | null;
  }>('SELECT disabled, deleted_at, sitzungen_ab FROM users WHERE id = ?', userId);

  if (!stand) return false;                 // Konto gibt es nicht (mehr)
  if (stand.deleted_at) return false;
  if (stand.disabled) return false;

  /* Der Zeitpunkt, ab dem Sitzungen gelten. Wer sein Passwort wechselt oder
     wem es zurückgesetzt wurde, macht damit jedes ältere Token wertlos —
     sonst wäre der Passwortwechsel nach einem Vorfall eine Beruhigung ohne
     Wirkung. */
  if (stand.sitzungen_ab && ausgestellt < stand.sitzungen_ab) return false;

  return true;
}

function tokenPruefen(token: string): { sub: string; ausgestellt: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof claims.sub !== 'string') return null;
    if (claims.exp * 1000 < Date.now()) return null;
    /* Wann dieses Token entstand. Mit `ms` auf die Millisekunde genau; ohne —
       also bei allem, was vor dieser Fassung ausgestellt wurde — die ganze
       Sekunde ausgeschöpft, damit ein Wechsel in derselben Sekunde ein altes
       Token höchstens zu lang gelten lässt und nie ein gültiges verwirft. */
    const ausgestellt = typeof claims.ms === 'number'
      ? claims.ms
      : (typeof claims.iat === 'number' ? claims.iat : 0) * 1000 + 999;
    if (!kontoTraegtToken(claims.sub, ausgestellt)) return null;
    return { sub: claims.sub, ausgestellt };
  } catch {
    return null;
  }
}

export function verifyToken(token: string): string | null {
  return tokenPruefen(token)?.sub ?? null;
}

/**
 * Wie verifyToken, verlangt aber zusätzlich ein FRISCHES Token.
 *
 * Für Wege, die etwas Einmaliges an einem Konto verändern dürfen — im Haus
 * steht dafür nur eine Tür: das Hinterlegen des Anmeldenachweises. Ein
 * gestohlenes Token ist dort besonders wertvoll, weil der Nachweis ein
 * dauerhafter zweiter Zugang wäre, der einen Passwortwechsel überdauert,
 * solange niemand merkt, dass er existiert. Der echte Aufrufer legt den
 * Nachweis im selben Atemzug nach der Anmeldung ab — sein Token ist Sekunden
 * alt. Ein gestohlenes ist es in der Regel nicht; und selbst im ungünstigen
 * Fall bleibt nur das schmale Fenster, nicht mehr die unbegrenzte Tür.
 */
export function verifyTokenFrisch(token: string, hoechstalterMs: number): string | null {
  const geprueft = tokenPruefen(token);
  if (!geprueft) return null;
  if (Date.now() - geprueft.ausgestellt > hoechstalterMs) return null;
  return geprueft.sub;
}

/** Farbe für den Fallback-Avatar aus dem Handle ableiten. */
export function avatarColorFor(seed: string): string {
  const palette = [
    '#7c5cff', '#22d3ee', '#f472b6', '#34d399', '#fbbf24',
    '#fb7185', '#a78bfa', '#38bdf8', '#4ade80', '#f97316',
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}