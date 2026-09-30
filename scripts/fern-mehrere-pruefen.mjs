/**
 * Können mehrere gleichzeitig zusehen — und kommt man wieder herein, wenn
 * einer verschwindet, ohne sich abzumelden?
 *
 * Die zweite Frage ist die wichtigere. Sie war der Fehler, den Dons Kollege
 * gemeldet hat: „Es ist schon jemand verbunden", obwohl niemand zusah. Eine
 * Verbindung, die ohne `close` abreißt (Deckel zu, WLAN gewechselt, App
 * abgeschossen, Weiterleitung im Router abgelaufen), blieb dem Pi als
 * Zuschauer erhalten, bis TCP von selbst aufgab — eine Viertelstunde und
 * mehr. Und weil nur einer zusehen durfte, war die Fernsteuerung damit für
 * alle anderen dicht.
 *
 * Geprüft wird gegen den echten Dienst, mit einem nachgemachten Abgreifer:
 * `fern-host` braucht einen Wayland-Compositor und gibt es hier nicht. Alles
 * andere ist echt — Handschlag, Verschlüsselung, Bildverteilung,
 * Steuerungsübergabe, Lebenszeichen.
 *
 * Der Zuschauer, der die App nachstellt, benutzt bewusst das **eingebaute**
 * WebSocket von Node, genau wie electron/fernsteuerung.ts. Damit prüft der
 * Lauf nebenbei die Annahme, auf der die ganze Erkennung beruht: dass diese
 * Fassung `ping` von selbst mit `pong` beantwortet. Täte sie es nicht, würden
 * hier alle stillen Zuschauer nach zwei Fristen hinausfliegen — und in der
 * Praxis wären es Dons Leute mitten in der Sitzung.
 *
 *     node scripts/fern-mehrere-pruefen.mjs
 *
 * Kein laufender Server nötig, kein Pi, kein Netz.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kennungNeu, hallo, antwortBauen, Schatulle } from '../server-setup/fernsteuerung/dienst/anmeldung.mjs';

/*
 * `ws` braucht schon der Dienst selbst, den dieser Lauf startet — ohne das
 * Paket ist hier nichts zu prüfen. Es steht in den devDependencies und liegt
 * nach `npm install` da.
 *
 * Eingelesen wird es trotzdem von Hand, statt oben mitzuimportieren: dieser
 * Lauf ist einer der Wächter, die `scripts/ausliefern.mjs` VOR jedem
 * Ausliefern laufen lässt, und dort sieht man von einem gescheiterten Import
 * nur die ersten 800 Zeichen eines Stapelabbilds. Ein Satz, der sagt, was zu
 * tun ist, ist an dieser Stelle mehr wert als die Fundstelle.
 */
let WSPaket;
try {
  WSPaket = (await import('ws')).default;
} catch {
  console.error('\n\x1b[31m✗ Das Paket „ws" fehlt — der Fernsteuerungs-Dienst braucht es.\x1b[0m\n'
    + '  Einmal  \x1b[1mnpm install\x1b[0m  im Projektverzeichnis, dann läuft das hier.\n');
  process.exit(1);
}

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIENST = path.join(wurzel, 'server-setup/fernsteuerung/dienst/fern-dienst.mjs');

/* Absichtlich klein: die Vorgaben (10 s Lebenszeichen, 15 s Steuerungsfrist)
   würden diesen Lauf auf Minuten dehnen. Die Zahlen selbst sind nicht das
   Geprüfte — geprüft wird, dass die Fristen überhaupt greifen. */
const PING_MS = 400;
const RUHE_MS = 1000;
const MAX     = 3;

const N_BILD = 1, N_ABLAGE = 2, N_INFO = 3, N_EINGABE = 4, N_STEUER = 5;

const F = { rot: '\x1b[31m', gruen: '\x1b[32m', grau: '\x1b[90m', fett: '\x1b[1m', aus: '\x1b[0m' };
let fehler = 0;
const pruefe = (was, bedingung, zusatz = '') => {
  const ok = Boolean(bedingung);
  if (!ok) fehler++;
  console.log(`  ${ok ? F.gruen + '✓' : F.rot + '✗'}${F.aus} ${was}` +
              (zusatz ? `  ${F.grau}${zusatz}${F.aus}` : ''));
};
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Auf einen ZUSTAND warten, nicht auf eine Zeit.
 *
 * Hier standen feste Pausen (`schlaf(500)`, dann prüfen). Einzeln lief das
 * immer grün; im vollen Auslieferungslauf, wo parallel gebaut und geprüft
 * wird, scheiterte „jeder sieht, dass drei zusehen" einmal: die Lagemeldung
 * mit der Drei kam nach der Pause statt davor. Das ist kein Fehler des
 * Dienstes, sondern einer der Prüfung — sie hat Geschwindigkeit gemessen,
 * wo sie Verhalten messen sollte.
 *
 * Jetzt wird bis zu einer großzügigen Frist nachgesehen, ob der erwartete
 * Zustand eintritt. Im Normalfall kostet das nicht mehr als vorher (es geht
 * weiter, sobald er da ist); unter Last wartet es, statt rot zu werden.
 * Feste Pausen bleiben nur dort, wo das Ausbleiben von etwas geprüft wird
 * — ein „kommt nicht an" lässt sich nicht abwarten, nur absitzen.
 */
const FRIST_MS = 8000;
async function bis(bedingung, fristMs = FRIST_MS) {
  const ende = Date.now() + fristMs;
  while (Date.now() < ende) {
    if (bedingung()) return true;
    await schlaf(25);
  }
  return bedingung();
}

/* ── Der nachgemachte Abgreifer ──────────────────────────────── */

/*
 * Er tut genau drei Dinge wie das Original: Rahmen schreiben
 * ([Art:1][Länge:4 LE][Inhalt]), Befehle zeilenweise von stdin lesen und auf
 * `s` ein Schlüsselbild schicken. Jeder Start und jeder Befehl landet in einer
 * Datei — daran lässt sich hinterher ablesen, ob es wirklich nur EINEN Abgriff
 * für alle gab und wessen Eingaben durchgekommen sind.
 */
const ABGREIFER = `#!/usr/bin/env node
import fs from 'node:fs';
const LOG = process.env.PROBE_LOG;
const merk = (z) => { try { fs.appendFileSync(LOG, z + '\\n'); } catch {} };
merk('start ' + process.argv.slice(2).join(' '));

function rahmen(art, inhalt) {
  const kopf = Buffer.alloc(5);
  kopf[0] = art;
  kopf.writeUInt32LE(inhalt.length, 1);
  process.stdout.write(Buffer.concat([kopf, inhalt]));
}
/* Kein echtes H.264 — nur die ersten Bytes, an denen Dienst und App ein
   Schlüsselbild erkennen: 00 00 01 67 ist SPS, 00 00 01 61 ein Zwischenbild. */
const schluesselbild = () => Buffer.concat([Buffer.from([0, 0, 1, 0x67]), Buffer.alloc(200, 7)]);
const zwischenbild   = () => Buffer.concat([Buffer.from([0, 0, 1, 0x61]), Buffer.alloc(80, 3)]);

rahmen(1, schluesselbild());
const bilder = setInterval(() => rahmen(1, zwischenbild()), 60);
const meldung = setInterval(() => rahmen(3, Buffer.from('12,0 B/s · 900 kbit/s')), 250);

/* Taub: liest stdin erst, wenn die Datei PROBE_TAUB auftaucht — ein
   Abgreifer, der am Compositor hängt. Dann wird nur gezählt, nicht jede
   Zeile protokolliert (es werden sehr viele). */
const TAUB = process.env.PROBE_TAUB;
let gezaehlt = 0;
if (TAUB) {
  process.stdin.pause();
  const warte = setInterval(() => { if (fs.existsSync(TAUB)) { clearInterval(warte); process.stdin.resume(); } }, 50);
  setInterval(() => { try { fs.writeFileSync(LOG + '.zahl', String(gezaehlt)); } catch {} }, 100);
}
let rest = '';
process.stdin.on('data', (d) => {
  rest += String(d);
  for (;;) {
    const i = rest.indexOf('\\n');
    if (i < 0) break;
    const zeile = rest.slice(0, i);
    rest = rest.slice(i + 1);
    if (!zeile) continue;
    /* Nur Loslassen wird protokolliert — daran prüft der Lauf, dass es
       auch im Stau durchkommt. */
    if (TAUB) { gezaehlt += 1; if (/^[kt] \\d+ 0$/.test(zeile)) merk('befehl ' + zeile); continue; }
    merk('befehl ' + zeile);
    if (zeile[0] === 's') rahmen(1, schluesselbild());
    /* Wie der echte: setzt jemand die Ablage, meldet der Compositor die
       neue Auswahl zurück, und fern-host schickt sie als Rahmen 2. */
    if (zeile.startsWith('a ')) rahmen(2, Buffer.from(zeile.slice(2), 'base64'));
  }
});
const aus = () => { merk('ende'); clearInterval(bilder); clearInterval(meldung); process.exit(0); };
process.on('SIGTERM', aus);
process.on('SIGINT', aus);
`;

/* ── Ein Zuschauer, so wie die App einer ist ──────────────────── */

class Zuschauer {
  constructor(name, adresse, passwort, { roh = false } = {}) {
    this.name = name; this.adresse = adresse; this.passwort = passwort;
    /* `roh` heißt: das Paket `ws` statt des eingebauten WebSocket. Nur dafür
       nötig, dass sich eine Verbindung wie ein abgerissenes Kabel beenden
       lässt (`terminate`) — das eingebaute kann das nicht. */
    this.roh = roh;
    this.bilder = 0; this.schluesselbilder = 0; this.infos = []; this.ablagen = [];
    this.schliessCode = null; this.offen = false;
  }

  verbinden() {
    return new Promise((fertig, schade) => {
      const mac = hallo();
      const ws = this.roh ? new WSPaket(this.adresse) : new WebSocket(this.adresse);
      this.ws = ws;
      if (!this.roh) ws.binaryType = 'arraybuffer';
      let phase = 'gruss';
      const frist = setTimeout(() => schade(new Error(`${this.name}: keine Antwort`)), 20_000);

      const daten = (roh) => {
        const alsText = () => (typeof roh === 'string' ? roh : Buffer.from(roh).toString('utf8'));
        if (phase === 'gruss') {
          const gruss = JSON.parse(alsText());
          const antwort = antwortBauen(this.passwort, gruss, mac.paar);
          if (!antwort.ok) { schade(new Error(`${this.name}: ${antwort.grund}`)); return; }
          this.hinaus = new Schatulle(antwort.schluessel, 'mac');
          this.herein = new Schatulle(antwort.schluessel, 'pi');
          ws.send(JSON.stringify(antwort.hinaus));
          this.steuer({ art: 'konto', name: this.name });
          phase = 'offen';
          return;
        }
        if (!this.offen) {
          const o = JSON.parse(alsText());
          if (o.art === 'offen') { this.offen = true; clearTimeout(frist); fertig(this); }
          return;
        }
        const paket = this.herein.auf(Buffer.from(roh));
        if (!paket) return;
        if (paket.art === N_BILD) {
          this.bilder += 1;
          if (paket.inhalt[3] === 0x67) this.schluesselbilder += 1;
        } else if (paket.art === N_INFO) {
          this.infos.push(JSON.parse(paket.inhalt.toString('utf8')));
        } else if (paket.art === N_ABLAGE) {
          this.ablagen.push(paket.inhalt.toString('utf8'));
        }
      };

      if (this.roh) {
        ws.on('open', () => ws.send(JSON.stringify(mac.hinaus)));
        ws.on('message', (d) => daten(d));
        ws.on('close', (code) => { this.schliessCode = code; this.offen = false; clearTimeout(frist); });
        ws.on('error', () => { /* der Schließen-Code sagt, was war */ });
      } else {
        ws.addEventListener('open', () => ws.send(JSON.stringify(mac.hinaus)));
        ws.addEventListener('message', (e) => daten(e.data));
        ws.addEventListener('close', (e) => {
          this.schliessCode = e.code; this.offen = false; clearTimeout(frist);
          /* Abgewiesen zu werden ist hier ein Ergebnis, kein Absturz. */
          fertig(this);
        });
        ws.addEventListener('error', () => { /* siehe close */ });
      }
    });
  }

  senden(art, inhalt) {
    if (!this.hinaus) return;
    try { this.ws.send(this.hinaus.zu(art, inhalt)); } catch { /* zu */ }
  }
  eingabe(zeile) { this.senden(N_EINGABE, Buffer.from(zeile, 'utf8')); }
  ablage(text)   { this.senden(N_ABLAGE, Buffer.from(text, 'utf8')); }
  steuer(wunsch) { this.senden(N_STEUER, Buffer.from(JSON.stringify(wunsch), 'utf8')); }
  /** Die letzte Lagemeldung — sie trägt Zuschauerzahl und Steuerung. */
  info() { return this.infos[this.infos.length - 1] ?? null; }
  trennen() { try { this.ws.close(); } catch { /* zu */ } }
  /** Kabel raus: kein `close`, keine Abmeldung — genau der Fall, an dem die
   *  Fernsteuerung im Alltag scheiterte. Nur mit `roh` möglich. */
  kabelZiehen() { this.ws.terminate(); }
}

/* ── Aufbau ──────────────────────────────────────────────────── */

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'fern-mehrere-'));
const kennung = kennungNeu(ordner);
const PASSWORT = kennung.klartext;
const LOG = path.join(ordner, 'abgreifer.log');
const abgreifer = path.join(ordner, 'abgreifer.mjs');
fs.writeFileSync(abgreifer, ABGREIFER, { mode: 0o755 });

async function freierHafen() {
  return new Promise((fertig) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => fertig(p));
    });
  });
}

const HAFEN = await freierHafen();
const ADRESSE = `ws://127.0.0.1:${HAFEN}`;

const dienst = spawn(process.execPath, [DIENST], {
  env: {
    ...process.env,
    FERN_ORDNER: ordner,
    FERN_HOST: abgreifer,
    FERN_PORT: String(HAFEN),
    FERN_ZUSCHAUER: String(MAX),
    FERN_PING_MS: String(PING_MS),
    FERN_STEUER_RUHE: String(RUHE_MS),
    PROBE_LOG: LOG,
  },
  stdio: ['ignore', 'inherit', 'pipe'],
});

let dienstAusgabe = '';
dienst.stderr.on('data', (d) => { dienstAusgabe += String(d); });

const bereit = await new Promise((fertig) => {
  const frist = setTimeout(() => fertig(false), 8000);
  const sehen = () => {
    if (dienstAusgabe.includes('lauscht auf')) { clearTimeout(frist); dienst.stderr.off('data', sehen); fertig(true); }
  };
  dienst.stderr.on('data', sehen);
});

function aufraeumen() {
  try { dienst.kill('SIGKILL'); } catch { /* schon weg */ }
  try { fs.rmSync(ordner, { recursive: true, force: true }); } catch { /* egal */ }
}
process.on('exit', aufraeumen);

const protokoll = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : []);
const starts = () => protokoll().filter((z) => z.startsWith('start')).length;
const befehle = () => protokoll().filter((z) => z.startsWith('befehl ')).map((z) => z.slice(7));
const zustand = () => JSON.parse(fs.readFileSync(path.join(ordner, 'zustand.json'), 'utf8'));

console.log(`\n${F.fett}Mehrere Zuschauer${F.aus}   ID ${kennung.id}   Hafen ${HAFEN}\n`);
pruefe('Dienst läuft', bereit, bereit ? '' : dienstAusgabe.slice(-300));
if (!bereit) { console.log(); process.exit(1); }

/* ── 1. Drei im selben Augenblick ────────────────────────────── */

console.log('Drei verbinden gleichzeitig');
const [a, b, c] = await Promise.all([
  new Zuschauer('Anna', ADRESSE, PASSWORT).verbinden(),
  new Zuschauer('Ben', ADRESSE, PASSWORT).verbinden(),
  new Zuschauer('Cem', ADRESSE, PASSWORT).verbinden(),
]);
pruefe('alle drei sind offen', a.offen && b.offen && c.offen);
pruefe('alle drei bekommen Bilder', await bis(() => a.bilder > 0 && b.bilder > 0 && c.bilder > 0),
       `${a.bilder} / ${b.bilder} / ${c.bilder}`);
pruefe('jeder hat ein Schlüsselbild bekommen',
       await bis(() => a.schluesselbilder > 0 && b.schluesselbilder > 0 && c.schluesselbilder > 0),
       `${a.schluesselbilder} / ${b.schluesselbilder} / ${c.schluesselbilder}`);
pruefe('genau EIN Abgriff für alle', starts() === 1, `${starts()} Start(s)`);
pruefe('die Dazugekommenen haben ein Bild angefordert',
       await bis(() => befehle().filter((z) => z === 's').length >= 2));
pruefe('der Zustand zählt drei', await bis(() => zustand().zuschauer === 3), JSON.stringify(zustand().zuschauer));
/* Die Namen kommen erst NACH dem Handschlag über die verschlüsselte Leitung
   (`konto`) — sie können also später dastehen als die Zahl. */
pruefe('und nennt alle drei Namen', await bis(() => (zustand().namen ?? []).length === 3),
       (zustand().namen ?? []).join(', '));
/* Wer „Anna" ist, entscheidet die Reihenfolge, in der die drei Handschläge
   fertig werden — und die ist bei drei gleichzeitigen scrypt-Rechnungen
   nicht festgelegt. Geprüft wird darum, dass der Erste der Liste genannt
   wird, nicht welcher Name das ist. */
pruefe('`verbunden` steht weiter für die ältere Anzeige',
       await bis(() => zustand().verbunden === true && zustand().konto === (zustand().namen ?? [])[0]),
       zustand().konto ?? '—');
pruefe('jeder sieht, dass drei zusehen',
       await bis(() => [a, b, c].every((z) => z.info()?.zuschauer === 3)),
       [a, b, c].map((z) => z.info()?.zuschauer ?? '—').join(' / '));

/* ── 2. Der vierte ───────────────────────────────────────────── */

console.log('\nEiner mehr, als erlaubt ist');
const d = await new Zuschauer('Dora', ADRESSE, PASSWORT).verbinden();
pruefe('wird abgewiesen — mit 4010, nicht mit „schon jemand verbunden"',
       d.schliessCode === 4010, `Code ${d.schliessCode}`);
pruefe('die drei anderen merken nichts davon', a.offen && b.offen && c.offen);

/* ── 3. Einer steuert, die anderen sehen zu ──────────────────── */

console.log('\nTastatur und Maus');
a.steuer({ art: 'steuerung', an: true });
/* Erst weiter, wenn der Pi Anna die Steuerung bestätigt hat — sonst könnte
   Bens Eingabe unten die freie Maus zuerst erwischen. */
pruefe('der Steuernde weiß es', await bis(() => a.info()?.steuert === true));
a.eingabe('z 100 200\n');
b.eingabe('z 900 900\n');
pruefe('die Eingabe des Steuernden kommt an', await bis(() => befehle().includes('z 100 200')));
/* Das Ausbleiben lässt sich nicht abwarten. Bens Zeile ging im selben
   Augenblick hinaus wie Annas; ist Annas angekommen, hatte seine dieselbe
   Zeit — die kurze Nachfrist deckt nur die Reihenfolge zweier Leitungen ab. */
await schlaf(250);
pruefe('die des Zuschauers nicht', !befehle().includes('z 900 900'));
pruefe('der Zuschauer weiß, wer steuert', await bis(() => b.info()?.steuerungBei === 'Anna'),
       String(b.info()?.steuerungBei));

a.ablage('von Anna');
b.ablage('von Ben');
const ablagen = () => befehle().filter((z) => z.startsWith('a '))
  .map((z) => Buffer.from(z.slice(2), 'base64').toString('utf8'));
pruefe('die Zwischenablage des Steuernden geht zum Pi', await bis(() => ablagen().includes('von Anna')));
await schlaf(250);
pruefe('die des Zuschauers nicht — sonst überschreiben sich vier gegenseitig',
       !ablagen().includes('von Ben'), ablagen().join(' | '));
/* Die Ablage des Pi zurück: nur an den, der steuert. Die Desktop-App
   schreibt sie ungefragt in die Ablage des eigenen Rechners. */
pruefe('die Ablage des Pi kommt beim Steuernden an', await bis(() => a.ablagen.includes('von Anna')));
await schlaf(250);
pruefe('…und nicht bei denen, die nur zusehen', !b.ablagen.length && !c.ablagen.length,
       `Ben ${b.ablagen.length}, Cem ${c.ablagen.length}`);

console.log('\nÜbergabe');
a.steuer({ art: 'steuerung', an: false });
await bis(() => a.info()?.steuert === false);
b.steuer({ art: 'steuerung', an: true });
await bis(() => b.info()?.steuert === true);
b.eingabe('z 111 222\n');
pruefe('nach dem Abgeben darf der Nächste', await bis(() => befehle().includes('z 111 222')));
pruefe('und der Erste nicht mehr', await bis(() => b.info()?.steuert === true && a.info()?.steuert === false));

console.log('\nWer nichts tut, gibt die Maus nach der Frist frei');
/* Die Frist selbst muss verstreichen — das ist das Geprüfte. Danach aber
   nicht auf die eine Zeile hoffen, sondern nachschieben, bis der Pi sie
   annimmt: unter Last kann die erste noch knapp vor Ablauf der Frist
   ankommen und zu Recht verworfen werden. */
await schlaf(RUHE_MS + 300);
const cDran = await bis(() => { c.eingabe('z 333 444\n'); return befehle().includes('z 333 444'); });
pruefe('der Nächste kommt dran, ohne jemanden anzurufen', cDran);

/* ── 4. Der stille Zuschauer ─────────────────────────────────── */

console.log('\nLebenszeichen');
const stillVorher = a.bilder;
/* Hier ist die Zeit das Geprüfte: mehrere Lebenszeichen-Fristen lang still
   sein und trotzdem verbunden bleiben. */
await schlaf(PING_MS * 3 + 200);
pruefe('wer nur zusieht, bleibt verbunden (ping wird beantwortet)',
       a.offen && await bis(() => a.bilder > stillVorher), `${a.bilder - stillVorher} Bilder dazu`);

/* ── 5. Der Fehler, um den es ging ───────────────────────────── */

console.log('\nEine Verbindung reißt ab, ohne sich abzumelden');
b.trennen(); c.trennen();
await bis(() => zustand().zuschauer === 1);
const geist = await new Zuschauer('Geist', ADRESSE, PASSWORT, { roh: true }).verbinden();
pruefe('zwei sehen zu', await bis(() => zustand().zuschauer === 2), String(zustand().zuschauer));
geist.kabelZiehen();
pruefe('gleich nach dem Abriss zählt der Pi ihn noch mit', zustand().zuschauer === 2);
pruefe('nach zwei Fristen ohne Antwort ist der Platz frei',
       await bis(() => zustand().zuschauer === 1), String(zustand().zuschauer));

console.log('\nUnd die Plätze werden wieder vergeben');
const [e, f] = await Promise.all([
  new Zuschauer('Eva', ADRESSE, PASSWORT).verbinden(),
  new Zuschauer('Finn', ADRESSE, PASSWORT).verbinden(),
]);
pruefe('zwei kommen herein, wo vorher ein Geist saß', e.offen && f.offen,
       `Codes ${e.schliessCode} / ${f.schliessCode}`);
pruefe('der Abgriff läuft die ganze Zeit derselbe', starts() === 1, `${starts()} Start(s)`);

/* ── 6. Niemand sieht mehr zu ────────────────────────────────── */

console.log('\nDer Letzte macht das Licht aus');
a.trennen(); e.trennen(); f.trennen();
pruefe('der Abgriff ist beendet', await bis(() => protokoll().includes('ende')));
pruefe('der Zustand sagt: niemand', await bis(() => zustand().verbunden === false && zustand().zuschauer === 0));

const g = await new Zuschauer('Gustl', ADRESSE, PASSWORT).verbinden();
pruefe('der Nächste startet ihn neu', await bis(() => starts() === 2 && g.bilder > 0),
       `${starts()} Starts, ${g.bilder} Bilder`);
g.trennen();

/* ── 7. Ein Abgreifer, der nicht mehr liest ──────────────────── */

console.log('\nDer Abgreifer hängt');
{
  /* Ein zweiter Dienst mit einem tauben Abgreifer: wer steuert, darf den
     Dienst nicht beliebig mit Eingaben füllen, die niemand abholt. */
  const taub = path.join(ordner, 'taub-los');
  const HAFEN2 = await freierHafen();
  const LOG2 = path.join(ordner, 'taub.log');
  const ordner2 = path.join(ordner, 'zwei');
  fs.mkdirSync(ordner2);
  const k2 = kennungNeu(ordner2);
  const dienst2 = spawn(process.execPath, [DIENST], {
    env: { ...process.env, FERN_ORDNER: ordner2, FERN_HOST: abgreifer, FERN_PORT: String(HAFEN2),
      PROBE_LOG: LOG2, PROBE_TAUB: taub },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let aus2 = '';
  dienst2.stderr.on('data', (x) => { aus2 += x; });
  await bis(() => aus2.includes('lauscht auf'));
  const h = await new Zuschauer('Hanna', `ws://127.0.0.1:${HAFEN2}`, k2.klartext).verbinden();
  h.steuer({ art: 'steuerung', an: true });
  await bis(() => h.info()?.steuert === true);
  const block = 'z 1 1\n'.repeat(650);
  const BLOECKE = 2000;
  for (let i = 0; i < BLOECKE; i++) h.eingabe(block);
  /* Loslassen mitten im Stau muss trotzdem ankommen. */
  h.eingabe('z 5 5\nt 272 0\n');
  await schlaf(1500);
  fs.writeFileSync(taub, '');
  const zahl = () => Number(fs.existsSync(LOG2 + '.zahl') ? fs.readFileSync(LOG2 + '.zahl', 'utf8') : 0);
  let vorher = -1;
  await bis(() => { const z = zahl(); const still = z === vorher && z > 0; vorher = z; return still; }, 15_000);
  pruefe('der Dienst verwirft, statt alles für den Abgreifer zu puffern',
         zahl() > 0 && zahl() < BLOECKE * 650 / 2, `${zahl()} von ${BLOECKE * 650} Zeilen angekommen`);
  const los = () => (fs.existsSync(LOG2) ? fs.readFileSync(LOG2, 'utf8') : '');
  pruefe('…ein Loslassen aber nie', await bis(() => los().includes('befehl t 272 0')), los().trim().split('\n').slice(-3).join(' | '));
  h.trennen();
  dienst2.kill('SIGKILL');
}

/* ── Schluss ─────────────────────────────────────────────────── */

await schlaf(200);
console.log(fehler
  ? `\n${F.rot}${fehler} Prüfung(en) fehlgeschlagen${F.aus}\n`
  : `\n${F.gruen}Alles in Ordnung — mehrere sehen zu, einer steuert, Geister fliegen raus.${F.aus}\n`);
if (fehler && dienstAusgabe) console.log(F.grau + dienstAusgabe.trim() + F.aus + '\n');
process.exit(fehler ? 1 : 0);
