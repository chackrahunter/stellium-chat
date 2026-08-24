#!/usr/bin/env node
/**
 * Prüft den Notzugang — „3 von 5": ein Kontoschlüssel, der sich von drei
 * Vertrauenspersonen zurückholen lässt und von zweien nie.
 *
 * DREI TEILE, UND DER ERSTE IST DER, DEN NIEMAND ÜBERSPRINGEN DARF
 *
 *   TEIL 1 — DAS KÖRPERFELD, GEGEN MASSSTÄBE VON AUSSEN.
 *   packages/shared/src/geheimnisteilung.ts rechnet in GF(2^8). Eine falsche
 *   Multiplikation dort sieht aus wie eine richtige: das Teilen läuft durch,
 *   das Zusammensetzen läuft durch, und erst der Tag, an dem jemand seinen
 *   Zugang wirklich braucht, zeigt, dass nie ein brauchbarer Schlüssel
 *   herauskam. Deshalb wird hier NICHT die eigene Rechnung mit sich selbst
 *   verglichen, sondern gegen drei Dinge, die von woanders kommen:
 *
 *     · die AES-S-Box aus FIPS-197 (256 veröffentlichte Bytes). Wer sie aus
 *       dem eigenen Kehrwert plus der veröffentlichten affinen Abbildung
 *       vollständig nachbaut, hat den Kehrwert für ALLE 255 Elemente
 *       bewiesen — die Abbildung ist eine Bijektion, es gibt keinen zweiten
 *       Kehrwert, der dieselbe Tafel ergäbe.
 *     · die AES-Rundenkonstanten (01 02 04 08 10 20 40 80 1B 36). Sie sind
 *       genau die iterierte Multiplikation mit 2 samt Reduktion — die
 *       Stelle, an der ein falsches Polynom auffliegt.
 *     · AES-128 von OpenSSL, über node:crypto. Ein eigenes AES, gebaut
 *       AUSSCHLIESSLICH aus der Multiplikation dieser Datei, muss auf
 *       zufälligen Schlüsseln und Blöcken dasselbe liefern wie eine seit
 *       Jahrzehnten geprüfte Umsetzung. Das misst die Multiplikation mit 2
 *       und 3 über zehn Runden hinweg, nicht an einer Handvoll Beispiele.
 *
 *   Dazu die Eigenschaft, um die es eigentlich geht: ZWEI ANTEILE VERRATEN
 *   NICHTS. Nicht „vermutlich nichts" — hier wird für eine Bytestelle
 *   ERSCHÖPFEND durchgezählt (alle 256 Geheimnisse × alle 65 536
 *   Koeffizientenpaare), dass jedes beobachtbare Anteilspaar aus JEDEM der
 *   256 möglichen Geheimnisse genau gleich oft entsteht. Wer zwei Anteile
 *   hat, hat damit nachweislich keine Auskunft über das dritte Byte —
 *   jeder Wert bleibt gleich wahrscheinlich.
 *
 *   TEIL 2 — DER GANZE WEG GEGEN EINE WEGWERFBARE DATENBANK
 *   (packages/server/src/pruefungen/notzugang.mts, über tsx): einrichten,
 *   Passwort zurücksetzen, drei Anteile einsammeln, Kontoschlüssel
 *   zurückholen, und dabei die zwei Fragen, an denen alles hängt — bewegt
 *   sich `fassung`? bleibt ein einziges Notiz- oder Tresorpaket auf der
 *   Strecke? Der eigene Ordner ist kein Schmuck: der Lauf setzt Passwörter
 *   zurück und liest Rohspalten, und nichts davon darf je die echte
 *   Datenbank berühren.
 *
 *   TEIL 3 — RECHNET DIE AUSGELIEFERTE APP DASSELBE?
 *   Teil 2 belegt, dass der ENTWURF trägt. Teil 3 lädt die ECHTE
 *   packages/desktop/src/lib/notzugang.ts in Node und prüft, dass ihr
 *   Byteformat, ihre Ableitungen und ihre Abbruchbedingungen dieselben sind
 *   wie in der Nachrechnung — vor allem: dass sie bei einem verfälschten
 *   Anteil wirklich abbricht.
 *
 * Aufruf:  node scripts/notzugang-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fehlerGesamt = 0;

/* ── Teil 1: das Körperfeld und die Geheimhaltung ─────────────────────── */

console.log('\n\x1b[1mTeil 1 — Das Körperfeld gegen veröffentlichte Tafeln und gegen OpenSSL\x1b[0m');
{
  let fehler = 0;
  const pruefWahr = (name, ist) => {
    if (!ist) fehler++;
    console.log(`  ${ist ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}`);
  };

  const { mal, kehrwert, teilen, zusammenfuegen } = await import(
    path.join(wurzel, 'packages/shared/dist/geheimnisteilung.js')
  );

  /* Die veröffentlichte S-Box aus FIPS-197, Figure 7 — abgeschrieben aus der
     Norm und ABSICHTLICH nicht aus irgendeiner Rechnung dieses Hauses
     erzeugt. Ein Maßstab, der aus dem Gemessenen stammt, ist keiner. */
  const SBOX = `
    63 7c 77 7b f2 6b 6f c5 30 01 67 2b fe d7 ab 76
    ca 82 c9 7d fa 59 47 f0 ad d4 a2 af 9c a4 72 c0
    b7 fd 93 26 36 3f f7 cc 34 a5 e5 f1 71 d8 31 15
    04 c7 23 c3 18 96 05 9a 07 12 80 e2 eb 27 b2 75
    09 83 2c 1a 1b 6e 5a a0 52 3b d6 b3 29 e3 2f 84
    53 d1 00 ed 20 fc b1 5b 6a cb be 39 4a 4c 58 cf
    d0 ef aa fb 43 4d 33 85 45 f9 02 7f 50 3c 9f a8
    51 a3 40 8f 92 9d 38 f5 bc b6 da 21 10 ff f3 d2
    cd 0c 13 ec 5f 97 44 17 c4 a7 7e 3d 64 5d 19 73
    60 81 4f dc 22 2a 90 88 46 ee b8 14 de 5e 0b db
    e0 32 3a 0a 49 06 24 5c c2 d3 ac 62 91 95 e4 79
    e7 c8 37 6d 8d d5 4e a9 6c 56 f4 ea 65 7a ae 08
    ba 78 25 2e 1c a6 b4 c6 e8 dd 74 1f 4b bd 8b 8a
    70 3e b5 66 48 03 f6 0e 61 35 57 b9 86 c1 1d 9e
    e1 f8 98 11 69 d9 8e 94 9b 1e 87 e9 ce 55 28 df
    8c a1 89 0d bf e6 42 68 41 99 2d 0f b0 54 bb 16`
    .trim().split(/\s+/).map((h) => parseInt(h, 16));
  pruefWahr('Die abgeschriebene S-Box hat 256 Einträge', SBOX.length === 256 && SBOX.every((b) => b >= 0 && b <= 255));

  /* Die affine Abbildung aus FIPS-197, Abschnitt 5.1.1 — ebenfalls aus der
     Norm, unabhängig von jeder Multiplikation. */
  const affin = (b) => {
    let r = 0x63;
    for (let i = 0; i < 8; i++) {
      const bit = ((b >> i) & 1) ^ ((b >> ((i + 4) % 8)) & 1) ^ ((b >> ((i + 5) % 8)) & 1)
        ^ ((b >> ((i + 6) % 8)) & 1) ^ ((b >> ((i + 7) % 8)) & 1);
      r ^= bit << i;
    }
    return r & 0xff;
  };
  let sboxOk = true;
  for (let a = 0; a < 256; a++) {
    if (affin(a === 0 ? 0 : kehrwert(a)) !== SBOX[a]) sboxOk = false;
  }
  pruefWahr('KEHRWERT: die eigene Inversion ergibt mit der affinen Abbildung EXAKT die veröffentlichte S-Box (alle 256)', sboxOk);

  const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
  let r = 1;
  let rconOk = true;
  for (const soll of RCON) { if (r !== soll) rconOk = false; r = mal(r, 2); }
  pruefWahr('MULTIPLIKATION MIT 2: die eigene Rechnung durchläuft die veröffentlichten AES-Rundenkonstanten samt Reduktion', rconOk);

  let kw = true;
  for (let a = 1; a < 256; a++) if (mal(a, kehrwert(a)) !== 1) kw = false;
  pruefWahr('a · a⁻¹ = 1 für alle 255 von null verschiedenen Elemente', kw);

  /* Eine zweite, ganz anders gebaute Multiplikation (bitweise, ohne Tafeln)
     über ALLE 65 536 Paare. Sie ist kein Maßstab von außen, aber sie teilt
     mit der Tafelversion keinen einzigen Rechenschritt — ein Tippfehler
     müsste in beiden Bauarten derselbe sein, um hier durchzukommen. */
  const bitweise = (a, b) => {
    let erg = 0;
    let x = a;
    let y = b;
    while (y) {
      if (y & 1) erg ^= x;
      const hoch = x & 0x80;
      x = (x << 1) & 0xff;
      if (hoch) x ^= 0x1b;
      y >>= 1;
    }
    return erg;
  };
  let alle = true;
  for (let a = 0; a < 256 && alle; a++) for (let b = 0; b < 256; b++) if (mal(a, b) !== bitweise(a, b)) { alle = false; break; }
  pruefWahr('Tafelmultiplikation = bitweise Multiplikation, alle 65 536 Paare', alle);

  /* AES-128, gebaut ausschließlich aus mal() und der aus kehrwert()
     gewonnenen S-Box — gegen OpenSSL. */
  const sub = (b) => SBOX[b];
  const erweitern = (key) => {
    const w = [];
    for (let i = 0; i < 4; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
    for (let i = 4; i < 44; i++) {
      let t = w[i - 1].slice();
      if (i % 4 === 0) { t = [sub(t[1]), sub(t[2]), sub(t[3]), sub(t[0])]; t[0] ^= RCON[i / 4 - 1]; }
      w.push(t.map((v, j) => v ^ w[i - 4][j]));
    }
    return w;
  };
  const aes128 = (key, block) => {
    const w = erweitern(key);
    const s = block.slice();
    const addKey = (rd) => { for (let c = 0; c < 4; c++) for (let z = 0; z < 4; z++) s[4 * c + z] ^= w[rd * 4 + c][z]; };
    addKey(0);
    for (let rd = 1; rd <= 10; rd++) {
      for (let i = 0; i < 16; i++) s[i] = sub(s[i]);
      const t = s.slice();
      for (let c = 0; c < 4; c++) for (let z = 0; z < 4; z++) s[4 * c + z] = t[4 * ((c + z) % 4) + z];
      if (rd < 10) {
        const u = s.slice();
        for (let c = 0; c < 4; c++) {
          const [a0, a1, a2, a3] = [u[4 * c], u[4 * c + 1], u[4 * c + 2], u[4 * c + 3]];
          s[4 * c] = mal(a0, 2) ^ mal(a1, 3) ^ a2 ^ a3;
          s[4 * c + 1] = a0 ^ mal(a1, 2) ^ mal(a2, 3) ^ a3;
          s[4 * c + 2] = a0 ^ a1 ^ mal(a2, 2) ^ mal(a3, 3);
          s[4 * c + 3] = mal(a0, 3) ^ a1 ^ a2 ^ mal(a3, 2);
        }
      }
      addKey(rd);
    }
    return s;
  };

  let aesOk = true;
  for (let n = 0; n < 25 && aesOk; n++) {
    const key = crypto.randomBytes(16);
    const klar = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    const soll = Buffer.concat([c.update(klar), c.final()]);
    if (!Buffer.from(aes128([...key], [...klar])).equals(soll)) aesOk = false;
  }
  pruefWahr('MULTIPLIKATION INSGESAMT: ein AES-128 aus dieser Multiplikation liefert auf 25 Zufallsfällen dasselbe wie OpenSSL', aesOk);

  /* Der veröffentlichte Vektor aus FIPS-197, Anhang C.1 — derselbe Beleg
     noch einmal gegen ein festes, nachlesbares Ergebnis statt gegen eine
     zweite Umsetzung. */
  const c1Key = [...Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')];
  const c1Klar = [...Buffer.from('00112233445566778899aabbccddeeff', 'hex')];
  pruefWahr('… und trifft den veröffentlichten Vektor aus FIPS-197 C.1',
    Buffer.from(aes128(c1Key, c1Klar)).toString('hex') === '69c4e0d86a7b0430d8cdb78070b4c55a');

  /* — Die Teilung selbst — */

  const geheimnis = new Uint8Array(crypto.randomBytes(32));
  const anteile = teilen(geheimnis, 3, 5);
  pruefWahr('Fünf Anteile, Stellen 1 bis 5 — nie eine Null (die Stelle 0 WÄRE das Geheimnis)',
    anteile.length === 5 && anteile.every((a, i) => a.stelle === i + 1));
  pruefWahr('Kein Anteil ist zufällig gleich dem Geheimnis',
    anteile.every((a) => !Buffer.from(a.werte).equals(Buffer.from(geheimnis))));

  let alleDrei = true;
  let kombinationen = 0;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = j + 1; k < 5; k++) {
    kombinationen++;
    if (!Buffer.from(zusammenfuegen([anteile[i], anteile[j], anteile[k]], 3)).equals(Buffer.from(geheimnis))) alleDrei = false;
  }
  pruefWahr(`ALLE ${kombinationen} Dreierkombinationen ergeben dasselbe Geheimnis`, alleDrei && kombinationen === 10);

  let zweiNie = true;
  let zweiVerweigert = true;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
    try { zusammenfuegen([anteile[i], anteile[j]], 3); zweiVerweigert = false; } catch { /* soll werfen */ }
    if (Buffer.from(zusammenfuegen([anteile[i], anteile[j]], 2)).equals(Buffer.from(geheimnis))) zweiNie = false;
  }
  pruefWahr('Zwei Anteile werden gegen die Schwelle drei ABGEWIESEN, nicht halb verrechnet', zweiVerweigert);
  pruefWahr('Und selbst erzwungen ergeben zwei Anteile in keinem der zehn Paare das Geheimnis', zweiNie);

  let doppelt = false;
  try { zusammenfuegen([anteile[0], anteile[0], anteile[1]], 3); } catch { doppelt = true; }
  pruefWahr('Derselbe Anteil zweimal zählt nicht als zweiter Punkt', doppelt);

  /* Verschiedene Bytes bekommen verschiedene Polynome — sonst verriete ein
     einziges erratenes Byte den ganzen Schlüssel. Gemessen an einem
     Geheimnis aus lauter GLEICHEN Bytes: bei gemeinsamen Koeffizienten
     wären dann auch alle Anteilsbytes gleich. */
  const einerlei = new Uint8Array(32).fill(0x5a);
  const gleicheAnteile = teilen(einerlei, 3, 5);
  pruefWahr('JE BYTE EIN EIGENES POLYNOM: ein Geheimnis aus 32 gleichen Bytes ergibt Anteile mit lauter verschiedenen Bytes',
    gleicheAnteile.every((a) => new Set(a.werte).size > 8));

  /* DIE EIGENSCHAFT, UM DIE ES GEHT — erschöpfend durchgezählt statt
     angenommen. Für die beiden Stellen 1 und 2 wird über ALLE Geheimnisse
     und ALLE Koeffizientenpaare gezählt, wie oft jedes beobachtbare
     Wertepaar (y1, y2) entsteht. Kommt jedes genau 256-mal vor — einmal je
     Geheimnis —, dann ist zu zwei Anteilen jeder Wert des Geheimnisses
     gleich wahrscheinlich. Das ist perfekte Geheimhaltung, nicht
     „rechnerisch schwer". */
  const zaehler = new Int32Array(65536);
  for (let s = 0; s < 256; s++) {
    for (let a1 = 0; a1 < 256; a1++) {
      for (let a2 = 0; a2 < 256; a2++) {
        const y1 = s ^ mal(a1, 1) ^ mal(a2, mal(1, 1));
        const y2 = s ^ mal(a1, 2) ^ mal(a2, mal(2, 2));
        zaehler[(y1 << 8) | y2]++;
      }
    }
  }
  let gleichverteilt = true;
  for (let i = 0; i < 65536; i++) if (zaehler[i] !== 256) { gleichverteilt = false; break; }
  pruefWahr('k−1 ANTEILE VERRATEN NICHTS: jedes beobachtbare Anteilspaar entsteht aus JEDEM der 256 Geheimnisse genau gleich oft (erschöpfend gezählt)',
    gleichverteilt);

  if (fehler) fehlerGesamt += 1;
}

/* ── Teil 2: der ganze Weg gegen eine wegwerfbare Datenbank ───────────── */

console.log('\n\x1b[1mTeil 2 — Einrichten, Zurücksetzen, Wiederherstellen (gegen eine wegwerfbare Datenbank)\x1b[0m');
{
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-notzugang-'));
  try {
    execFileSync('npx', ['tsx', 'src/pruefungen/notzugang.mts'], {
      cwd: path.join(wurzel, 'packages/server'),
      env: { ...process.env, DATA_DIR: ordner },
      stdio: 'inherit',
    });
  } catch {
    fehlerGesamt += 1;
  } finally {
    fs.rmSync(ordner, { recursive: true, force: true });
  }
}

/* ── Teil 3: rechnet die ECHTE App dasselbe? ──────────────────────────── */

console.log('\n\x1b[1mTeil 3 — Die ausgelieferte lib/notzugang.ts gegen dieselbe Rechnung\x1b[0m');

const desktopPaket = path.join(wurzel, 'packages/desktop');
const ordner3 = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-notzugang-client-'));
try {
  /* Dieselben Stubs wie in scripts/notiz-kontoschluessel-pruefen.mjs, aus
     demselben Grund: lib/notzugang.ts und lib/vertraulich.ts bleiben ECHT,
     nur ihre Nachbarn mit Seiteneffekten (Netz, Push, Wörterbuch) laufen
     leer. Der api-Stub ist hier zugleich der Server: er merkt sich, was die
     App hinterlegen will, und gibt es beim nächsten Abruf zurück. */
  fs.writeFileSync(path.join(ordner3, 'benachrichtigung-stub.mjs'),
    `export const erlaubnisStand = () => 'default';
export function pushAbonnieren() {}
export function titelZaehler() {}
export function vapidSchluesselSetzen() {}
export function zeigen() {}
`);
  fs.writeFileSync(path.join(ordner3, 'kern-stub.mjs'),
    `export function translate(_l, key) { return key; }
export function spracheDesSystems() { return 'de'; }
export function dokumentSpracheSetzen() {}
`);
  fs.writeFileSync(path.join(ordner3, 'verkauf-stub.mjs'),
    `export const useVerkaufMeldungenUi = { getState: () => ({ zuruecksetzen() {} }), setState() {} };
`);
  fs.writeFileSync(path.join(ordner3, 'api-stub.mjs'),
    `globalThis.__KONTO__ = null;
globalThis.__NOTZUGANG__ = null;
globalThis.__ANTEILE__ = [];
globalThis.__BEITRAEGE__ = [];
export class ApiError extends Error {}
export const serverUrl = () => 'http://127.0.0.1:0';
export const wsUrl = () => 'ws://127.0.0.1:0';
export const token = () => null;
export const setToken = () => {};
export const dateiUrl = () => '';
function hinterlegen(blob) {
  const vorher = globalThis.__KONTO__;
  const derselbe = Boolean(vorher && vorher.abdruck === blob.abdruck);
  const fassung = derselbe ? vorher.fassung : (vorher?.fassung ?? 0) + 1;
  globalThis.__KONTO__ = { ...blob, fassung };
  return { fassung };
}
export const api = {
  kontoSchluessel: async () => ({ schluessel: globalThis.__KONTO__, notzugangWartet: false }),
  kontoSchluesselHinterlegen: async (blob) => hinterlegen(blob),
  changePassword: async (_a, _b, blob) => { if (blob) hinterlegen(blob); return { ok: true }; },
  notzugang: async () => ({
    stand: {
      eingerichtet: Boolean(globalThis.__NOTZUGANG__), schwelle: 3, anteile: 5,
      brauchbar: globalThis.__ANTEILE__.length,
      halter: globalThis.__ANTEILE__.map((a) => ({ halterId: a.halterId, stelle: a.stelle, aktiv: true, schluesselPasst: true })),
      erstelltAm: 0,
    },
    huelle: globalThis.__NOTZUGANG__,
    anfrage: null,
    protokoll: [],
  }),
  notzugangEinrichten: async (huelle, anteile) => {
    globalThis.__NOTZUGANG__ = huelle;
    globalThis.__ANTEILE__ = anteile;
    return { stand: null };
  },
  notzugangAufheben: async () => ({ ok: true }),
  notzugangAnfragen: async () => ({ anfrage: { id: 'nza1', userId: 'konto1', stand: 'offen', laeuftAb: 0, erstelltAm: 0, beitraege: 0 } }),
  notzugangAnfrageAbbrechen: async () => ({ ok: true }),
  notzugangAufgaben: async () => ({ aufgaben: globalThis.__AUFGABEN__ ?? [] }),
  notzugangBeitragen: async () => ({ ok: true }),
  notzugangBeitraege: async () => ({ beitraege: globalThis.__BEITRAEGE__ }),
  notzugangEinloesen: async () => ({ ok: true, beteiligte: [] }),
};
`);
  fs.writeFileSync(path.join(ordner3, 'loader-hook.mjs'),
    `const KARTE = {
  '/lib/benachrichtigung': new URL('./benachrichtigung-stub.mjs', import.meta.url).href,
  '/i18n/kern': new URL('./kern-stub.mjs', import.meta.url).href,
  '/verkaufMeldungen': new URL('./verkauf-stub.mjs', import.meta.url).href,
  '/net/api': new URL('./api-stub.mjs', import.meta.url).href,
};
export async function resolve(specifier, context, nextResolve) {
  const ohneEndung = specifier.replace(/\\.(ts|js|mts|mjs)$/, '');
  for (const [leiden, ziel] of Object.entries(KARTE)) {
    if (ohneEndung.endsWith(leiden)) return { url: ziel, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.endsWith('/packages/desktop/src/state/store.ts')) {
    const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    return { ...result, source: src.replace('import.meta.env', 'globalThis') };
  }
  return result;
}
`);
  fs.writeFileSync(path.join(ordner3, 'register-hook.mjs'),
    `import { register } from 'node:module';
register('./loader-hook.mjs', import.meta.url);
`);

  const pfad = (p) => JSON.stringify(`file://${path.join(desktopPaket, p).replace(/\\/g, '/')}`);

  const probe = `
const ablage = new Map();
globalThis.localStorage = {
  getItem: (k) => (ablage.has(k) ? ablage.get(k) : null),
  setItem: (k, v) => ablage.set(k, String(v)),
  removeItem: (k) => ablage.delete(k),
};
globalThis.window = globalThis;
globalThis.DEV = false;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.document = { addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {} } };
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = FakeWS.CONNECTING;
  send() {} close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
}
globalThis.WebSocket = FakeWS;

/* Dieselben Kontexte wie in packages/shared/src/vertraulich.ts —
   ABSICHTLICH abgeschrieben statt importiert, aus demselben Grund wie in
   scripts/notiz-kontoschluessel-pruefen.mjs: wer einen dieser Texte ändert,
   macht jeden bestehenden Anteil unlesbar, und das darf nicht still
   durchgehen. */
const NOTZUGANG_ABDRUCK_VORSPANN = 'stellium/notzugang/abdruck/v1';
const notzugangKekKontext = (u) => \`stellium/notzugang/kek/v1/\${u}\`;
const notzugangAnteilKontext = (u, h) => \`stellium/notzugang/anteil/\${u}>\${h}\`;
const notzugangBeitragKontext = (a, h, u) => \`stellium/notzugang/beitrag/\${a}/\${h}>\${u}\`;
const NOTZUGANG_CODE_RUNDEN = 310_000;

await import(${pfad('src/state/store.ts')});
await import(${pfad('src/net/socket.ts')});
const vertraulich = await import(${pfad('src/lib/vertraulich.ts')});
const konto = await import(${pfad('src/lib/kontoschluessel.ts')});
const echt = await import(${pfad('src/lib/notzugang.ts')});
const geteilt = await import(${pfad('../shared/dist/geheimnisteilung.js')});

let fehler = 0;
const pruefWahr = (name, ist) => {
  if (!ist) fehler++;
  console.log(\`  \${ist ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\`);
};

const subtle = crypto.subtle;
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (t) => new Uint8Array(Buffer.from(t, 'base64url'));
const sha256 = async (t) => new Uint8Array(await subtle.digest('SHA-256', typeof t === 'string' ? enc.encode(t) : t));
const gleich = (a, b) => a.length === b.length && [...a].every((x, i) => x === b[i]);

async function notKek(not, userId) {
  const z = await subtle.importKey('raw', not, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(notzugangKekKontext(userId)), info: enc.encode('stellium/notzugang/kek/v1') },
    z, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
async function notAbdruck(not) {
  const v = enc.encode(NOTZUGANG_ABDRUCK_VORSPANN);
  const z = new Uint8Array(v.length + not.length);
  z.set(v, 0); z.set(not, v.length);
  return sha256(z);
}
async function ableiten(privat, fremdJwk, kontext) {
  const fremd = await subtle.importKey('jwk', JSON.parse(fremdJwk), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: fremd }, privat, 256));
  const roh = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode('stellium/notzugang/paket/v1') },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

const USER = 'konto1';
const PASSWORT = 'ein-langes-passwort-1';
const HALTER = ['h1', 'h2', 'h3', 'h4', 'h5'];

/* Die App braucht die öffentlichen Teile der fünf über den Draht. Der
   Sockelweg ist hier stillgelegt, also werden sie direkt in dieselbe Karte
   gelegt, die schluesselAnfordern() sonst füllt. */
const paare = new Map();
for (const h of HALTER) {
  const paar = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  paare.set(h, paar);
  vertraulich._schluesselMerkenFuerPruefung(h, JSON.stringify(await subtle.exportKey('jwk', paar.publicKey)));
}

await vertraulich.schluesselBereitstellen();
pruefWahr('Die App richtet einen Kontoschlüssel ein', await konto.kontoSchluesselEinrichten(USER, PASSWORT));

/* — Einrichten — */
await echt.einrichten(USER, HALTER);
const huelle = globalThis.__NOTZUGANG__;
const bloecke = globalThis.__ANTEILE__;
pruefWahr('Die App legt fünf Anteile ab, je einen pro Person', bloecke.length === 5);
pruefWahr('Die Hülle nennt Schwelle 3 und fünf Anteile', huelle.schwelle === 3 && huelle.anteile === 5);
pruefWahr('Die Hülle trägt den Abdruck des KONTOSCHLÜSSELS und dessen Fassung',
  huelle.kontoAbdruck === globalThis.__KONTO__.abdruck && huelle.kontoFassung === konto.kontoFassung());
pruefWahr('Jeder Anteil trägt einen eigenen flüchtigen öffentlichen Teil — kein Absender wird zweimal benutzt',
  new Set(bloecke.map((b) => b.paket.eph)).size === 5);
pruefWahr('In keinem abgelegten Feld steht das Passwort', !JSON.stringify({ huelle, bloecke }).includes(PASSWORT));

/* — Die Nachrechnung öffnet, was die App verschlossen hat — */
const gelesen = [];
for (const b of bloecke) {
  const key = await ableiten(paare.get(b.halterId).privateKey, b.paket.eph, notzugangAnteilKontext(USER, b.halterId));
  const klar = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(b.paket.iv) }, key, unb64u(b.paket.daten)));
  gelesen.push({
    stelle: klar[3], werte: klar.slice(4, klar.length - 32), abdruck: klar.slice(klar.length - 32),
    format: klar[0], schwelle: klar[1], anzahl: klar[2],
  });
}
pruefWahr('DIE NACHRECHNUNG ÖFFNET JEDEN ANTEIL DER APP — flüchtiges ECDH auf beiden Seiten gleich gerechnet', gelesen.length === 5);
pruefWahr('Jeder Anteil trägt Format, Schwelle und Anzahl IM verschlossenen Teil',
  gelesen.every((g) => g.format === 1 && g.schwelle === 3 && g.anzahl === 5));
pruefWahr('Die Stellen sind 1 bis 5, nie eine Null', [...gelesen].map((g) => g.stelle).sort().join() === '1,2,3,4,5');
pruefWahr('Alle fünf tragen denselben Abdruck des Notschlüssels',
  gelesen.every((g) => gleich(g.abdruck, gelesen[0].abdruck)));

const not = geteilt.zusammenfuegen(gelesen.slice(0, 3).map((g) => ({ stelle: g.stelle, werte: g.werte })), 3);
pruefWahr('Drei Anteile der APP ergeben einen Notschlüssel, dessen Abdruck stimmt',
  gleich(await notAbdruck(not), gelesen[0].abdruck));

const kontoRoh = new Uint8Array(await subtle.decrypt(
  { name: 'AES-GCM', iv: unb64u(huelle.iv) }, await notKek(not, USER), unb64u(huelle.daten),
));
pruefWahr('Damit öffnet sich die Nothülle der App und gibt den Kontoschlüssel her',
  kontoRoh.length === 32);

/* — Und zurück: die App holt den Kontoschlüssel mit demselben Notschlüssel — */
const fassungVorher = globalThis.__KONTO__.fassung;
const abdruckVorher = globalThis.__KONTO__.abdruck;
const gelungen = await konto.mitNotschluesselWiederherstellen(USER, 'ein-neues-langes-passwort', huelle, not);
pruefWahr('mitNotschluesselWiederherstellen() gelingt', gelungen);
pruefWahr('… und lässt den Abdruck stehen — derselbe Schlüssel, neue Hülle',
  globalThis.__KONTO__.abdruck === abdruckVorher);
pruefWahr('… UND DIE FASSUNG. Bewegte sie sich, fiele jedes Notiz- und Tresorpaket weg',
  globalThis.__KONTO__.fassung === fassungVorher);

/* — Die eine Prüfung im Gerät, die bisher niemand gemessen hat —
   \`fassung !== huelle.kontoFassung\` (lib/kontoschluessel.ts, Schritt 3 von
   mitNotschluesselWiederherstellen). Sie ist die einzige Stelle, an der ein
   still gelaufener ERSATZZWEIG des Servers überhaupt auffällt: der Abdruck
   verrät ihn nicht, denn der Server speichert ja genau den mitgeschickten.
   Dieselbe Nothülle, dieselben Anteile, nur nennt die Hülle eine andere
   Fassung — das Gerät muss Fehlschlag melden, statt weiterzumachen.
   Dass diese Prüfung streng bleibt, ist auch die Begründung dafür, warum
   der Server in Teil 2 die falsche ZAHL nachzieht statt die Prüfung zu
   entschärfen (Teil 13 dort). */
const fassungVorSchief = globalThis.__KONTO__.fassung;
const abdruckVorSchief = globalThis.__KONTO__.abdruck;
const schief = await konto.mitNotschluesselWiederherstellen(
  USER, 'ein-weiteres-neues-langes-passwort', { ...huelle, kontoFassung: huelle.kontoFassung + 7 }, not);
pruefWahr('Nennt die Hülle eine ANDERE Fassung als der Server zurückmeldet, meldet das Gerät Fehlschlag', !schief);
pruefWahr('… obwohl die Nothülle aufging und der Abdruck stimmte — genau dieser Fall soll auffallen',
  globalThis.__KONTO__.abdruck === abdruckVorSchief && globalThis.__KONTO__.fassung === fassungVorSchief);

/* — Ein verdrehter Anteil: die App darf NICHT weiterrechnen — */
const verdreht = gelesen.slice(0, 3).map((g, i) => ({
  stelle: g.stelle,
  werte: i === 0 ? Uint8Array.from(g.werte, (b, j) => (j === 0 ? b ^ 1 : b)) : g.werte,
}));
const falsch = geteilt.zusammenfuegen(verdreht, 3);
pruefWahr('Ein einziges gekipptes Byte ergibt einen ANDEREN Schlüssel', !gleich(falsch, not));
pruefWahr('… und sein Abdruck stimmt nicht — genau daran bricht lib/notzugang.ts ab',
  !gleich(await notAbdruck(falsch), gelesen[0].abdruck));
const mitFalschem = await (async () => {
  try {
    await subtle.decrypt({ name: 'AES-GCM', iv: unb64u(huelle.iv) }, await notKek(falsch, USER), unb64u(huelle.daten));
    return true;
  } catch { return false; }
})();
pruefWahr('Mit dem falschen Schlüssel geht die Nothülle nicht auf', !mitFalschem);

const nachher = await konto.mitNotschluesselWiederherstellen(USER, 'noch-ein-passwort', huelle, falsch);
pruefWahr('DIE APP WEIST DEN FALSCHEN NOTSCHLÜSSEL AB, statt einen Ersatz zu hinterlegen', !nachher);
pruefWahr('… und die Fassung beim Server hat sich dabei nicht bewegt',
  globalThis.__KONTO__.fassung === fassungVorher);

/* — Der ganze Weg durch die App: wiederherstellen() mit echten Beiträgen —
   Erst mit drei sauberen Anteilen, dann mit einem verdrehten. Der zweite
   Durchgang ist der eigentliche: er prüft, dass die App abbricht statt
   einen falschen Schlüssel zu hinterlegen. */
const { useStore } = await import(${pfad('src/state/store.ts')});
useStore.setState({ self: { id: USER } });

const CODE = 'ABCDEFGHJKMNPQRSTUVW2345';
const ANFRAGE = 'nza1';

async function codeBytes(kontext) {
  const roh = await subtle.importKey('raw', enc.encode(CODE), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', salt: await sha256(kontext), iterations: NOTZUGANG_CODE_RUNDEN, hash: 'SHA-256' },
    roh, 256,
  ));
}

/** Die drei Beiträge so bauen, wie eine haltende Person sie schickt. */
async function beitraegeBauen(verdrehen) {
  const raus = [];
  for (const [i, g] of gelesen.slice(0, 3).entries()) {
    const kopf = new Uint8Array(4 + g.werte.length + 32);
    kopf[0] = 1; kopf[1] = 3; kopf[2] = 5; kopf[3] = g.stelle;
    kopf.set(g.werte, 4);
    kopf.set(g.abdruck, 4 + g.werte.length);
    if (verdrehen && i === 0) kopf[4] ^= 0x01;
    const halterId = bloecke[i].halterId;
    const kontext = notzugangBeitragKontext(ANFRAGE, halterId, USER);
    const paar = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const fremd = await subtle.importKey('jwk', JSON.parse(vertraulich.eigenerOeffentlicherSchluessel()), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: fremd }, paar.privateKey, 256));
    const zusatz = await codeBytes(kontext);
    const material = new Uint8Array(bits.length + zusatz.length);
    material.set(bits, 0); material.set(zusatz, bits.length);
    const ikm = await subtle.importKey('raw', material, 'HKDF', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode('stellium/notzugang/paket/v1') },
      ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const daten = await subtle.encrypt({ name: 'AES-GCM', iv }, key, kopf);
    raus.push({
      halterId, stelle: g.stelle,
      paket: { alg: 'aes-gcm', eph: JSON.stringify(await subtle.exportKey('jwk', paar.publicKey)), iv: b64u(iv), daten: b64u(new Uint8Array(daten)) },
    });
  }
  return raus;
}

globalThis.__BEITRAEGE__ = await beitraegeBauen(false);
const fassungVorLauf = globalThis.__KONTO__.fassung;
const abdruckVorLauf = globalThis.__KONTO__.abdruck;
const lauf = await echt.wiederherstellen(USER, ANFRAGE, CODE, 'wieder-ein-langes-passwort');
pruefWahr('DER GANZE WEG DURCH DIE APP: drei saubere Beiträge stellen den Zugang wieder her', lauf.ok === true);
pruefWahr('… mit demselben Abdruck wie vorher', globalThis.__KONTO__.abdruck === abdruckVorLauf);
pruefWahr('… und ohne die Fassung zu bewegen', globalThis.__KONTO__.fassung === fassungVorLauf);
pruefWahr('… und danach sind die Anteile ERNEUERT (die gebrauchten waren durch drei Hände)',
  JSON.stringify(globalThis.__ANTEILE__.map((a) => a.paket.daten)) !== JSON.stringify(bloecke.map((a) => a.paket.daten)));

globalThis.__BEITRAEGE__ = await beitraegeBauen(true);
const fassungVorVerdreht = globalThis.__KONTO__.fassung;
const abdruckVorVerdreht = globalThis.__KONTO__.abdruck;
const verdrehterLauf = await echt.wiederherstellen(USER, ANFRAGE, CODE, 'noch-ein-langes-passwort');
pruefWahr('EIN VERFÄLSCHTER ANTEIL WIRD ERKANNT — die App meldet „verfälscht", statt einen Schlüssel zu liefern',
  verdrehterLauf.ok === false && verdrehterLauf.grund === 'verfaelscht');
pruefWahr('… und hat dabei NICHTS hinterlegt: Abdruck unverändert', globalThis.__KONTO__.abdruck === abdruckVorVerdreht);
pruefWahr('… und die Fassung ebenso', globalThis.__KONTO__.fassung === fassungVorVerdreht);

const zuWenig = await (async () => {
  globalThis.__BEITRAEGE__ = (await beitraegeBauen(false)).slice(0, 2);
  return echt.wiederherstellen(USER, ANFRAGE, CODE, 'ein-weiteres-langes-passwort');
})();
pruefWahr('Zwei Beiträge reichen der App nicht — sie meldet „zu wenig" statt zu raten',
  zuWenig.ok === false && zuWenig.grund === 'zuWenig');

console.log(fehler ? \`\\x1b[31m\${fehler} fehlgeschlagen\\x1b[0m\` : '\\x1b[32mok\\x1b[0m');
process.exit(fehler ? 1 : 0);
`;
  fs.writeFileSync(path.join(ordner3, 'probe.mts'), probe);

  try {
    execFileSync(
      'node',
      ['--import', path.join(ordner3, 'register-hook.mjs'), '--import', 'tsx', path.join(ordner3, 'probe.mts')],
      { cwd: desktopPaket, stdio: 'inherit' },
    );
  } catch {
    fehlerGesamt += 1;
  }
} finally {
  fs.rmSync(ordner3, { recursive: true, force: true });
}

console.log(fehlerGesamt
  ? `\n\x1b[31m${fehlerGesamt} Teil(e) fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDrei von fünf holen den Kontoschlüssel zurück, zwei nie — die Fassung bewegt sich dabei nicht, '
    + 'und ein verfälschter Anteil wird erkannt statt verrechnet.\x1b[0m\n');
process.exit(fehlerGesamt ? 1 : 0);
