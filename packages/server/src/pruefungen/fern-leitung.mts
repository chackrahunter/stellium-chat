/**
 * Die Fernsteuerung im Browser — der Chat-Server als Vermittler zum Pi
 * (http/fernleitung.ts), gegen den ECHTEN Pi-Dienst.
 *
 * `fern-host` braucht einen Wayland-Compositor, den gibt es hier nicht; an
 * seiner Stelle steht ein nachgemachter Abgreifer wie in
 * scripts/fern-mehrere-pruefen.mjs. Echt sind: der Dienst mit Handschlag,
 * Verschlüsselung und Regelung, der Server mit Rechteprüfung und Bremse,
 * und der „Browser" spricht mit dem eingebauten WebSocket von Node genau das,
 * was net/fern-browser.ts spricht.
 *
 * Geprüft wird vor allem, was NICHT passieren darf: Zugang ohne Recht, das
 * Passwort beim Browser, ein vom Browser untergeschobener Name, ein Rückstau,
 * den der Pi nicht sieht.
 *
 * Aufruf über scripts/fern-leitung-pruefen.mjs (setzt DATA_DIR).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { db, initDb } from '../db/index.js';
import { WebSocketServer, WebSocket as WsKlient } from 'ws';
import {
  registerFernleitung, bremseZuruecksetzen, ziele, eingabeGueltig, herkunftErlaubt, scryptPasst, ABLAGE_MAX,
  absender, nurLoslassen,
} from '../http/fernleitung.js';
import * as users from '../services/users.js';
import { signToken } from '../auth.js';
import * as fernzugang from '../services/fernzugang.js';

initDb();

let fehler = 0;
const pruef = (name: string, ok: boolean, zusatz = '') => {
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${zusatz ? `  \x1b[90m${zusatz}\x1b[0m` : ''}`);
};
const schlaf = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Auf einen Zustand warten statt auf eine feste Zeit — unter Last dauert
 *  alles länger, und eine feste Zeit macht daraus einen falschen Fehler. */
async function bis(bedingung: () => boolean, fristMs = 8000): Promise<boolean> {
  const ende = Date.now() + fristMs;
  while (Date.now() < ende) { if (bedingung()) return true; await schlaf(25); }
  return bedingung();
}

/* ── 0) scrypt mit genau den Werten des Pi, gegen RFC 7914 ─────────── */

console.log('\n0) scrypt — die Parameter des Pi gegen den veröffentlichten Prüfwert');
{
  /* RFC 7914, Abschnitt 12, dritter Vektor: N=16384, r=8, p=1 — dieselben
     Zahlen, die anmeldung.mjs als SCRYPT verwendet. Abgeschrieben aus der
     Norm, nicht aus einer Rechnung dieses Hauses. */
  const soll = '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2'
    + 'd5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887';
  const ist = await new Promise<Buffer>((fertig, schade) => crypto.scrypt(
    'pleaseletmein', 'SodiumChloride', 64, { N: 16384, r: 8, p: 1 },
    (f, k) => (f ? schade(f) : fertig(k))));
  pruef('crypto.scrypt (asynchron, wie der Vermittler) trifft den RFC-Wert', ist.toString('hex') === soll);
  const sync = crypto.scryptSync('pleaseletmein', 'SodiumChloride', 64, { N: 16384, r: 8, p: 1 });
  pruef('…und dasselbe wie scryptSync (wie Pi und Desktop-App)', sync.equals(ist));
}

/* ── 1) Wohin gewählt wird ─────────────────────────────────────────── */

console.log('\n1) Ziele');
pruef('hinterlegte Adresse draußen: erst 127.0.0.1 auf demselben Port, dann sie',
  JSON.stringify(ziele('ws://203.0.113.7:7788')) === JSON.stringify(['ws://127.0.0.1:7788', 'ws://203.0.113.7:7788']));
pruef('schon lokal: nur sie', JSON.stringify(ziele('ws://127.0.0.1:9')) === JSON.stringify(['ws://127.0.0.1:9']));
pruef('kein ws/wss: gar nichts', ziele('http://203.0.113.7:7788').length === 0 && ziele('quatsch').length === 0);

/* ── Aufbau: Dienst, Abgreifer, Server ─────────────────────────────── */

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DIENST = path.join(wurzel, 'server-setup/fernsteuerung/dienst/fern-dienst.mjs');
const { kennungNeu, grussBauen, antwortPruefen, Schatulle: PiSchatulle } = await import(path.join(wurzel, 'server-setup/fernsteuerung/dienst/anmeldung.mjs'));

/* scrypt zählen: wie oft, und wie viele gleichzeitig. Der Vermittler schlägt
   `crypto.scrypt` bei jedem Aufruf nach, also greift das Ersetzen hier. */
const scryptEcht = crypto.scrypt;
const scryptZahl = { laeufe: 0, jetzt: 0, hoechstens: 0, bremse: 0 };
(crypto as unknown as { scrypt: unknown }).scrypt = (...a: unknown[]) => {
  const ruf = a[a.length - 1] as (f: Error | null, k: Buffer) => void;
  scryptZahl.laeufe += 1;
  scryptZahl.jetzt += 1;
  scryptZahl.hoechstens = Math.max(scryptZahl.hoechstens, scryptZahl.jetzt);
  (scryptEcht as unknown as (...b: unknown[]) => void)(...a.slice(0, -1), (f: Error | null, k: Buffer) => {
    setTimeout(() => { scryptZahl.jetzt -= 1; ruf(f, k); }, scryptZahl.bremse);
  });
};

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'fern-leitung-'));
const kennung = kennungNeu(ordner);
const PASSWORT: string = kennung.klartext;
const LOG = path.join(ordner, 'abgreifer.log');
const abgreifer = path.join(ordner, 'abgreifer.mjs');
/* Größere Bilder als in fern-mehrere-pruefen: 24 KB alle 50 ms sind knapp
   4 Mbit/s — genug, dass ein Browser, der nichts quittiert, binnen Sekunden
   über die Stauschwelle des Pi kommt. */
fs.writeFileSync(abgreifer, `#!/usr/bin/env node
import fs from 'node:fs';
const merk = (z) => { try { fs.appendFileSync(process.env.PROBE_LOG, z + '\\n'); } catch {} };
merk('start');
function rahmen(art, inhalt) {
  const kopf = Buffer.alloc(5); kopf[0] = art; kopf.writeUInt32LE(inhalt.length, 1);
  process.stdout.write(Buffer.concat([kopf, inhalt]));
}
const schluessel = () => Buffer.concat([Buffer.from([0, 0, 1, 0x67]), Buffer.alloc(30000, 7)]);
const zwischen = () => Buffer.concat([Buffer.from([0, 0, 1, 0x61]), Buffer.alloc(24000, 3)]);
rahmen(1, schluessel());
setInterval(() => rahmen(1, zwischen()), 50);
setInterval(() => rahmen(3, Buffer.from('20,0 B/s')), 250);
let rest = '';
process.stdin.on('data', (d) => {
  rest += String(d);
  for (;;) { const i = rest.indexOf('\\n'); if (i < 0) break; const z = rest.slice(0, i); rest = rest.slice(i + 1);
    if (z) merk('befehl ' + z); if (z[0] === 's') rahmen(1, schluessel()); }
});
process.on('SIGTERM', () => { merk('ende'); process.exit(0); });
`, { mode: 0o755 });

async function freierHafen(): Promise<number> {
  return new Promise((fertig) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => fertig(p)); });
  });
}
const HAFEN = await freierHafen();
const dienst = spawn(process.execPath, [DIENST], {
  /* Acht Plätze statt vier: sonst wiese beim Prüfen der Gesamtgrenze des
     Vermittlers schon der Pi ab, und die Prüfung sagte nichts. */
  env: { ...process.env, FERN_ORDNER: ordner, FERN_HOST: abgreifer, FERN_PORT: String(HAFEN), PROBE_LOG: LOG,
    FERN_ZUSCHAUER: '8' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let dienstAusgabe = '';
dienst.stderr!.on('data', (d) => { dienstAusgabe += String(d); });
const aufraeumen = () => {
  try { dienst.kill('SIGKILL'); } catch { /* weg */ }
  try { fs.rmSync(ordner, { recursive: true, force: true }); } catch { /* egal */ }
};
process.on('exit', aufraeumen);
await bis(() => dienstAusgabe.includes('lauscht auf'));

const befehle = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n') : [])
  .filter((z) => z.startsWith('befehl ')).map((z) => z.slice(7));
const zustand = () => JSON.parse(fs.readFileSync(path.join(ordner, 'zustand.json'), 'utf8'));

function konto(name: string, recht: string | null): string {
  const id = `u_${crypto.randomBytes(4).toString('hex')}`;
  db.run(`INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
    id, id, name, 'x', 'guest', Date.now());
  if (recht) {
    db.run(`INSERT INTO user_permissions (user_id, permission, allowed, set_by, set_at) VALUES (?,?,1,'pruefer',?)`,
      id, recht, Date.now());
  }
  return id;
}
const mitRecht = konto('Leitung Probe', 'fern.zugriff');
const ohneRecht = konto('Gast Probe', null);

const ADRESSE = `ws://127.0.0.1:${HAFEN}`;
fernzugang.zugangSetzen({ adresse: ADRESSE, passwort: PASSWORT, kennung: kennung.id }, 'pruefer');

const app = Fastify({ logger: false });
await app.register(websocket);
registerFernleitung(app);
await app.listen({ port: 0, host: '127.0.0.1' });
const LEITUNG = `ws://127.0.0.1:${(app.server.address() as net.AddressInfo).port}/api/fern/leitung`;

/* ── Der „Browser" ─────────────────────────────────────────────────── */

class Browser {
  ws: WebSocket;
  lagen: string[] = [];
  texte: string[] = [];
  bilder = 0; schluesselbilder = 0; bytes = 0;
  infos: any[] = [];
  code: number | null = null;
  quittieren: boolean;
  private takt: ReturnType<typeof setInterval> | null = null;
  constructor(token: string | null, { quittieren = true } = {}) {
    this.quittieren = quittieren;
    this.ws = new WebSocket(LEITUNG);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('open', () => { if (token !== null) this.ws.send(JSON.stringify({ art: 'anmelden', token })); });
    this.ws.addEventListener('message', (e: MessageEvent) => {
      if (typeof e.data !== 'string') {
        const b = new Uint8Array(e.data as ArrayBuffer);
        this.bilder++; this.bytes += b.length;
        if (b[3] === 0x67) this.schluesselbilder++;
        if (Buffer.from(b).includes(Buffer.from(PASSWORT))) this.texte.push('PASSWORT IM BILD');
        return;
      }
      this.texte.push(e.data);
      const n = JSON.parse(e.data);
      if (n.art === 'lage') this.lagen.push(n.lage);
      if (n.art === 'info') this.infos.push(n.info);
    });
    this.ws.addEventListener('close', (e: { code: number }) => { this.code = e.code; if (this.takt) clearInterval(this.takt); });
    this.takt = setInterval(() => {
      if (this.quittieren && this.ws.readyState === WebSocket.OPEN && this.bytes) {
        this.ws.send(JSON.stringify({ art: 'q', n: this.bytes }));
      }
    }, 250);
  }
  offen() { return this.lagen.includes('offen') && this.code === null; }
  info() { return this.infos[this.infos.length - 1] ?? null; }
  senden(n: object) { this.ws.send(JSON.stringify(n)); }
  zu() { try { this.ws.close(); } catch { /* zu */ } }
}

/* ── 2) Wer darf ───────────────────────────────────────────────────── */

console.log('\n2) Rechte');
{
  const b = new Browser('kein-gueltiges-token');
  await bis(() => b.code !== null);
  pruef('ungültiges Token → 4401', b.code === 4401, String(b.code));
  const c = new Browser(signToken(ohneRecht));
  await bis(() => c.code !== null);
  pruef('ohne fern.zugriff → 4403', c.code === 4403, String(c.code));
  pruef('…und dabei hat der Pi niemanden gesehen', zustand().zuschauer === 0);
}

/* ── 3) Der gute Fall ──────────────────────────────────────────────── */

console.log('\n3) Mit Recht');
const a = new Browser(signToken(mitRecht));
pruef('Leitung steht', await bis(() => a.offen()), `Lagen ${a.lagen.join(' → ')} Code ${a.code}`);
pruef('Lagen in der Reihenfolge der App', a.lagen.join(',') === 'verbindet,meldet an,offen', a.lagen.join(','));
pruef('Bilder kommen an, das erste ist ein Schlüsselbild',
  await bis(() => a.bilder > 5 && a.schluesselbilder > 0), `${a.bilder} Bilder`);
pruef('Lagemeldungen des Pi kommen an', await bis(() => (a.info()?.zuschauer ?? 0) === 1));
pruef('der Pi nennt den Namen AUS DEM KONTO', await bis(() => zustand().konto === 'Leitung Probe'), String(zustand().konto));
pruef('weder Passwort noch Adresse erreichen den Browser',
  !a.texte.some((t) => t.includes(PASSWORT) || t.includes(ADRESSE) || t.includes('PASSWORT IM BILD')));

console.log('\n4) Eingaben');
a.senden({ art: 'eingabe', zeilen: 'z 1 1\n' });
a.senden({ art: 'steuer', wunsch: { art: 'steuerung', an: true } });
pruef('Steuerung an kommt beim Pi an', await bis(() => a.info()?.steuert === true));
a.senden({ art: 'eingabe', zeilen: 'z 4242 4343\n' });
pruef('Eingabe geht durch', await bis(() => befehle().includes('z 4242 4343')));
a.senden({ art: 'ablage', text: 'vom Telefon' });
pruef('Ablage geht durch', await bis(() => befehle().some((z) => z === `a ${Buffer.from('vom Telefon').toString('base64')}`)));
a.senden({ art: 'steuer', wunsch: { art: 'konto', name: 'Mallory' } });
a.senden({ art: 'steuer', wunsch: { art: 'neuStarten', bilder: 5 } });
a.senden({ art: 'eingabe', zeilen: 'z 7 7\n' });
await bis(() => befehle().includes('z 7 7'));
pruef('einen fremden Namen kann der Browser nicht unterschieben', zustand().konto === 'Leitung Probe', String(zustand().konto));
pruef('den Abgriff kann er nicht neu starten',
  fs.readFileSync(LOG, 'utf8').split('\n').filter((z) => z === 'start').length === 1);

console.log('\n5) Rückstau hinter dem Vermittler');
{
  /* Der Pi sieht seinen Weg zum Server als frei. Ob er den Rückstau beim
     Browser trotzdem bemerkt, hängt allein an den Meldungen des Vermittlers. */
  pruef('wer quittiert, hat kaum etwas unterwegs', await bis(() => (a.info()?.unterwegs ?? 1e9) < 200_000),
    `${a.info()?.unterwegs} Bytes`);
  const langsam = new Browser(signToken(mitRecht), { quittieren: false });
  await bis(() => langsam.offen());
  /* 64 KB ist STAU_MINDEST im Dienst — darüber erst wertet er Stau. */
  pruef('wer nicht quittiert, dessen Rückstand sieht der Pi',
    await bis(() => (langsam.info()?.unterwegs ?? 0) > 64 * 1024), `${langsam.info()?.unterwegs} Bytes`);
  pruef('…und verwirft für ihn Zwischenbilder, statt weiter zu stauen',
    await bis(() => (langsam.info()?.verworfen ?? 0) > 0), `${langsam.info()?.verworfen} verworfen`);
  pruef('…und regelt die Bitrate herunter',
    await bis(() => befehle().some((z) => /^b\d+/.test(z)), 10_000), befehle().filter((z) => z[0] === 'b').join(' '));
  langsam.zu();
  await bis(() => zustand().zuschauer === 1);
}

console.log('\n6) Aufräumen');
a.zu();
pruef('schließt der Browser, gibt der Pi den Platz frei', await bis(() => zustand().zuschauer === 0));

/* ── 7) Widerruf während einer laufenden Leitung ──────────────────── */

console.log('\n7) Widerruf');
{
  bremseZuruecksetzen();
  const wer = konto('Widerruf Probe', 'fern.zugriff');
  const b = new Browser(signToken(wer));
  pruef('Leitung steht', await bis(() => b.offen()));
  db.run(`DELETE FROM user_permissions WHERE user_id = ?`, wer);
  pruef('fern.zugriff entzogen → die offene Leitung wird geschlossen (4403)', await bis(() => b.code === 4403, 5000), String(b.code));

  const zwei = konto('Sperre Probe', 'fern.zugriff');
  const c = new Browser(signToken(zwei));
  pruef('Leitung steht', await bis(() => c.offen()));
  users.setDisabled(zwei, true);
  pruef('Konto gesperrt → geschlossen (4403)', await bis(() => c.code === 4403, 5000), String(c.code));

  const drei = konto('Kennwort Probe', 'fern.zugriff');
  const d = new Browser(signToken(drei));
  pruef('Leitung steht', await bis(() => d.offen()));
  /* Passwortwechsel: ältere Tokens gelten ab `sitzungen_ab` nicht mehr. */
  db.run(`UPDATE users SET sitzungen_ab = ? WHERE id = ?`, Date.now() + 1, drei);
  pruef('Passwortwechsel → geschlossen (4403)', await bis(() => d.code === 4403, 5000), String(d.code));
  pruef('…und der Pi hat die Plätze wieder frei', await bis(() => zustand().zuschauer === 0));
}

/* ── 8) Ein falscher Pi, der scrypt-Werte vorgibt ─────────────────── */

console.log('\n8) scrypt-Werte der Gegenstelle');
pruef('die Werte des Pi passen', scryptPasst({ N: 16384, r: 8, p: 1 }) && scryptPasst(undefined));
pruef('größeres N, p oder ein maxmem nicht',
  !scryptPasst({ N: 1 << 20, r: 8, p: 1 }) && !scryptPasst({ N: 16384, r: 8, p: 16 })
  && !scryptPasst({ N: 16384, r: 8, p: 1, maxmem: 2 ** 31 }) && !scryptPasst('x') && !scryptPasst(null));

/* Eine Gegenstelle, die sich wie der Pi meldet. Mit `boese` gibt sie andere
   scrypt-Werte vor; mit `taub` hört sie nach dem Handschlag auf zu lesen. */
const falschOrdner = fs.mkdtempSync(path.join(os.tmpdir(), 'fern-falsch-'));
const falschKennung = kennungNeu(falschOrdner);
fs.rmSync(falschOrdner, { recursive: true, force: true });
const falscherPi = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((r) => falscherPi.on('listening', r));
const falsch = {
  modus: 'boese' as 'boese' | 'taub', empfangen: 0, buchse: null as null | { _socket: net.Socket },
  eingaben: [] as string[],
};
falscherPi.on('connection', (ws) => {
  let hs: any = null;
  ws.on('message', (roh) => {
    const text = String(roh);
    if (!hs) {
      hs = grussBauen(falschKennung, JSON.parse(text));
      if (falsch.modus === 'boese') hs.hinaus.scrypt = { N: 16384, r: 8, p: 16, maxmem: 2 ** 31 };
      ws.send(JSON.stringify(hs.hinaus));
      return;
    }
    if (!hs.fertig) {
      const urteil = antwortPruefen(hs, JSON.parse(text));
      hs.fertig = urteil.ok;
      hs.herein = new PiSchatulle(urteil.schluessel, 'mac');
      ws.send(JSON.stringify({ art: 'offen' }));
      if (falsch.modus === 'taub') {
        falsch.buchse = ws as unknown as { _socket: net.Socket };
        (ws as unknown as { _socket: net.Socket })._socket.pause();
      }
      return;
    }
    falsch.empfangen += 1;
    const paket = hs.herein?.auf(Buffer.from(roh as Buffer));
    if (paket?.art === 4) falsch.eingaben.push(paket.inhalt.toString('utf8'));
  });
});
const falschAdresse = `ws://127.0.0.1:${(falscherPi.address() as net.AddressInfo).port}`;
{
  bremseZuruecksetzen();
  fernzugang.zugangSetzen({ adresse: falschAdresse, passwort: falschKennung.klartext }, 'pruefer');
  const vorher = scryptZahl.laeufe;
  const b = new Browser(signToken(mitRecht));
  await bis(() => b.code !== null);
  pruef('Gruß mit p=16 und maxmem → Abbruch', b.code === 4000, String(b.code));
  pruef('…ohne dass scrypt überhaupt gerechnet hat', scryptZahl.laeufe === vorher, `${scryptZahl.laeufe - vorher} Läufe`);
  const quelle = fs.readFileSync(path.join(wurzel, 'packages/desktop/electron/fernsteuerung.ts'), 'utf8');
  pruef('die Desktop-App reicht die Werte aus dem Gruß ebenfalls nicht weiter',
    !/scryptSync\([^)]*gruss/.test(quelle) && /scryptSync\(passwort, salz, 32, SCRYPT\)/.test(quelle));
}

/* ── 9) Was vom Browser zum Pi darf ───────────────────────────────── */

console.log('\n9) Eingaben: nur was die Ansicht erzeugt');
pruef('Zeiger, Knopf, Taste, Rollen, Umschalter gehen',
  eingabeGueltig('z 1 2\nt 272 1\nk 30 0\nr 0 -7.50\nm 1 0 0 0\n'));
for (const [was, zeilen] of [
  ['Ablage-Befehl (a)', 'a eA==\n'], ['Bitrate (b)', 'b100\n'], ['Schlüsselbild (s)', 's\n'],
  ['ohne abschließendes \\n', 'z 1 2'], ['gültig + ungültig gemischt', 'z 1 2\nq\n'],
  ['leere Zeile', 'z 1 2\n\n'], ['Text statt Zahl', 'z eins 2\n'], ['zu lang', `${'z 1 1\n'.repeat(700)}`],
] as const) pruef(`abgewiesen: ${was}`, !eingabeGueltig(zeilen));
{
  bremseZuruecksetzen();
  fernzugang.zugangSetzen({ adresse: ADRESSE, passwort: PASSWORT }, 'pruefer');
  const b = new Browser(signToken(mitRecht));
  await bis(() => b.offen());
  b.senden({ art: 'steuer', wunsch: { art: 'steuerung', an: true } });
  await bis(() => b.info()?.steuert === true);
  const sVorher = befehle().filter((z) => z === 's').length;
  for (const z of ['a eA==\n', 'b 1\n', 's\n', 'z 11 11', 'z 12 12\nq\n']) b.senden({ art: 'eingabe', zeilen: z });
  b.senden({ art: 'eingabe', zeilen: 'z 13 13\n' });
  await bis(() => befehle().includes('z 13 13'));
  const neu = befehle();
  pruef('nur die gültige Nachricht kommt beim Pi an',
    !neu.includes('a eA==') && !neu.includes('b 1') && neu.filter((z) => z === 's').length === sVorher
    && !neu.includes('z 11 11') && !neu.includes('z 12 12'), neu.slice(-6).join(' | '));
  const lang = 'x'.repeat(ABLAGE_MAX);
  b.senden({ art: 'ablage', text: `${lang}y` });
  b.senden({ art: 'ablage', text: lang });
  const b64 = (t: string) => `a ${Buffer.from(t).toString('base64')}`;
  await bis(() => befehle().includes(b64(lang)));
  pruef(`Ablage bis ${ABLAGE_MAX} Bytes geht, darüber nicht`,
    befehle().includes(b64(lang)) && !befehle().includes(b64(`${lang}y`)));
  const umlaute = 'ä'.repeat(ABLAGE_MAX / 2 + 1);
  b.senden({ art: 'ablage', text: umlaute });
  b.senden({ art: 'eingabe', zeilen: 'z 14 14\n' });
  await bis(() => befehle().includes('z 14 14'));
  await schlaf(200);
  pruef('…gezählt in Bytes, nicht in Zeichen (fern-host verwirft Zeilen über 8 KB)', !befehle().includes(b64(umlaute)));
  b.zu();
  await bis(() => zustand().zuschauer === 0);
}
{
  /* Der Pi liest nicht mehr — dann darf der Vermittler nicht alles puffern. */
  bremseZuruecksetzen();
  falsch.modus = 'taub';
  falsch.empfangen = 0;
  fernzugang.zugangSetzen({ adresse: falschAdresse, passwort: falschKennung.klartext }, 'pruefer');
  const b = new Browser(signToken(mitRecht));
  pruef('Leitung zum tauben Pi steht', await bis(() => b.offen()));
  const block = 'z 1 1\n'.repeat(650);
  const GESENDET = 3000;
  for (let i = 0; i < GESENDET; i++) b.senden({ art: 'eingabe', zeilen: block });
  /* Mitten im Stau: eine Taste und die Maustaste loslassen. Das darf nie
     verworfen werden — sonst bleiben sie auf dem Pi gedrückt. Die Bewegung
     davor schon. */
  b.senden({ art: 'eingabe', zeilen: 'z 9 9\nk 30 0\nt 272 0\n' });
  /* Warten, bis der Vermittler alles gelesen hat, dann den Pi wieder lesen
     lassen und abwarten, bis nichts mehr kommt. */
  await schlaf(1500);
  falsch.buchse?._socket.resume();
  let zuletzt = -1;
  await bis(() => { const still = zuletzt === falsch.empfangen; zuletzt = falsch.empfangen; return still && zuletzt > 0; }, 15_000);
  pruef('staut es zum Pi, verwirft der Vermittler statt zu puffern',
    falsch.empfangen > 0 && falsch.empfangen < GESENDET / 2, `${falsch.empfangen} von ${GESENDET} angekommen`);
  pruef('…aber ein Loslassen kommt trotzdem an, ohne die Bewegung davor',
    falsch.eingaben.includes('k 30 0\nt 272 0\n'), falsch.eingaben.filter((e) => !e.startsWith('z 1 1')).join(' | '));
  pruef('nurLoslassen behält genau k … 0 und t … 0',
    nurLoslassen('z 1 1\nk 30 1\nk 30 0\nt 272 1\nt 272 0\nr 0 1.00\n') === 'k 30 0\nt 272 0\n');
  b.zu();
}

/* ── 10) Herkunft und Grenzen über alle Konten ────────────────────── */

console.log('\n10) Herkunft und Grenzen');
pruef('eigene Herkunft', herkunftErlaubt('https://chat.example', 'chat.example'));
/* nginx setzt `Host $host` — ohne Port. Läuft HTTPS auf 8443, steht der
   Port nur in der Herkunft. */
pruef('HTTPS auf 8443 hinter nginx (Host ohne Port)', herkunftErlaubt('https://chat.example:8443', 'chat.example'));
pruef('…und mit Port im Host', herkunftErlaubt('https://chat.example:8443', 'chat.example:8443'));
pruef('fremder Rechner mit gleichem Port nicht', !herkunftErlaubt('https://boese.example:8443', 'chat.example'));
pruef('fremde Herkunft nicht', !herkunftErlaubt('https://boese.example', 'chat.example'));
pruef('„null" (file:, Sandbox) nicht', !herkunftErlaubt('null', 'chat.example'));
pruef('Entwicklung: Loopback zu Loopback', herkunftErlaubt('http://localhost:5173', '127.0.0.1:8787'));
pruef('ohne Origin (kein Browser) — dann entscheidet das Token', herkunftErlaubt(undefined, 'chat.example'));
{
  const fremd = new WsKlient(LEITUNG, { origin: 'https://boese.example' });
  const code = await new Promise<number>((r) => fremd.on('close', (c) => r(c)));
  pruef('Upgrade von fremder Seite → 4406 (eigener Code, nicht „kein Recht")', code === 4406, String(code));
}
pruef('Absender: hinter nginx gilt X-Real-IP', absender('127.0.0.1', '203.0.113.9') === '203.0.113.9'
  && absender('::ffff:127.0.0.1', '203.0.113.9') === '203.0.113.9');
pruef('…direkt verbunden nicht (sonst erfände jeder Absender)', absender('198.51.100.4', '203.0.113.9') === '198.51.100.4');
{
  /* Nicht angemeldete Verbindungen: zwei je Absender. Wer ohne Konto acht
     offen hält, sperrt damit nur sich selbst, nicht die anderen. */
  const stumm = (ip: string) => {
    const k = new WsKlient(LEITUNG, { headers: { 'X-Real-IP': ip } });
    const z = { code: null as number | null, zu: () => { try { k.close(); } catch { /* zu */ } } };
    k.on('close', (c) => { z.code = c; });
    k.on('error', () => { /* Code reicht */ });
    return z;
  };
  const acht = Array.from({ length: 8 }, () => stumm('10.0.0.1'));
  await bis(() => acht.filter((b) => b.code === 4029).length === 6, 3000);
  pruef('ein Absender: zwei offen, die übrigen sechs sofort 4029',
    acht.filter((b) => b.code === 4029).length === 6 && acht.filter((b) => b.code === null).length === 2,
    acht.map((b) => b.code ?? '·').join(' '));
  const anderer = stumm('10.0.0.2');
  await schlaf(300);
  pruef('ein anderer Absender kommt trotzdem an die Anmeldung', anderer.code === null, String(anderer.code));
  for (const b of [...acht, anderer]) b.zu();
  await bis(() => [...acht, anderer].every((b) => b.code !== null));
}
{
  bremseZuruecksetzen();
  fernzugang.zugangSetzen({ adresse: ADRESSE, passwort: PASSWORT }, 'pruefer');
  const konten = [0, 1, 2].map((i) => signToken(konto(`Grenze ${i}`, 'fern.zugriff')));
  /* scrypt künstlich langsam: dann laufen die Handschläge sicher
     gleichzeitig, und man sieht, ob mehr als zwei auf einmal rechnen. */
  scryptZahl.bremse = 300;
  scryptZahl.hoechstens = 0;
  const vier = [konten[0], konten[0], konten[1], konten[1]].map((t) => new Browser(t));
  pruef('vier Leitungen kommen zustande', await bis(() => vier.every((b) => b.offen()), 15_000),
    vier.map((b) => b.code ?? b.lagen.at(-1)).join(' '));
  pruef('dabei rechnen höchstens zwei scrypt gleichzeitig', scryptZahl.hoechstens <= 2, `${scryptZahl.hoechstens} gleichzeitig`);
  scryptZahl.bremse = 0;
  const fuenfte = new Browser(konten[2]);
  await bis(() => fuenfte.code !== null);
  pruef('die fünfte Leitung über alle Konten → 4029', fuenfte.code === 4029, String(fuenfte.code));
  for (const b of vier) b.zu();
  await bis(() => zustand().zuschauer === 0);
}
falscherPi.close();

console.log('\n11) Bremse und Fehler');
{
  bremseZuruecksetzen();
  const token = signToken(mitRecht);
  const ersteSechs = [];
  for (let i = 0; i < 6; i++) {
    const b = new Browser(token);
    await bis(() => b.lagen.includes('verbindet') || b.code !== null);
    b.zu();
    ersteSechs.push(b);
  }
  const siebter = new Browser(token);
  await bis(() => siebter.code !== null);
  pruef('der siebte Versuch in einer Minute → 4029', siebter.code === 4029, String(siebter.code));
  await bis(() => zustand().zuschauer === 0);

  bremseZuruecksetzen();
  fernzugang.zugangSetzen({ adresse: `ws://127.0.0.1:${await freierHafen()}` }, 'pruefer');
  const weg = new Browser(token);
  await bis(() => weg.code !== null, 12_000);
  pruef('Pi nicht erreichbar → 4504', weg.code === 4504, String(weg.code));

  bremseZuruecksetzen();
  fernzugang.zugangSetzen({ adresse: ADRESSE, passwort: `falsch-${crypto.randomBytes(6).toString('hex')}` }, 'pruefer');
  const falsch = new Browser(token);
  await bis(() => falsch.code !== null, 12_000);
  pruef('falsches hinterlegtes Passwort → 4003, bevor der Pi etwas zeigt',
    falsch.code === 4003 && falsch.bilder === 0, `${falsch.code}, ${falsch.bilder} Bilder`);
}

await app.close();
console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n${dienstAusgabe.slice(-1500)}\n`
  : '\n\x1b[32mDie Browser-Leitung hält: nur mit Recht, ohne Passwort beim Browser, mit dem Namen aus dem Konto, und der Pi sieht den Rückstau dahinter.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
