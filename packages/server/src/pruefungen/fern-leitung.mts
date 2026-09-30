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
import { registerFernleitung, bremseZuruecksetzen, ziele } from '../http/fernleitung.js';
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
const { kennungNeu } = await import(path.join(wurzel, 'server-setup/fernsteuerung/dienst/anmeldung.mjs'));

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
  env: { ...process.env, FERN_ORDNER: ordner, FERN_HOST: abgreifer, FERN_PORT: String(HAFEN), PROBE_LOG: LOG },
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

console.log('\n7) Bremse und Fehler');
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
