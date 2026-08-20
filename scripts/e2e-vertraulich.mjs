/**
 * Beweist, dass vertrauliche Kanäle halten, was sie versprechen.
 *
 * Die vier Zusagen, um die es geht:
 *
 *   1. Der Server sieht keinen Klartext. Geprüft wird nicht über eine
 *      Schnittstelle, sondern in der Datenbankdatei selbst — und zwar auf
 *      einem Server ohne Masterpasswort, also mit ausgeschalteter
 *      serverseitiger Verschlüsselung. Was dort trotzdem nicht lesbar ist,
 *      ist wirklich nicht lesbar.
 *   2. Mitglieder lesen mit.
 *   3. Fremde nicht.
 *   4. Die Freigabe per Code funktioniert — und nur mit dem richtigen Code.
 *
 * Die Verschlüsselung ist hier absichtlich noch einmal ausgeschrieben, statt
 * packages/desktop/src/lib/vertraulich.ts einzubinden. Eine Prüfung, die
 * dieselbe Rechnung wie der Prüfling benutzt, prüft nur, dass er mit sich
 * selbst einig ist. So prüft sie das vereinbarte Format.
 *
 * Vorbild: scripts/e2e-sicherheit.mjs.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { probeserver } from './probeserver.mjs';
/* Die Verschlüsselung des Servers, mit dem Masterpasswort dieses Rechners.
   Damit lässt sich die schärfste Frage stellen: was findet der Server, wenn er
   seinen eigenen Tresor aufschließt? */
import { entschluesseln as serverEntschluesseln } from '../packages/server/dist/crypto/nachrichten.js';

const probe = await probeserver();
const S = probe.S;

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/* ── Krypto, wie die App sie macht ────────────────────────────── */

const enc = new TextEncoder();
const dec = new TextDecoder();
const su = globalThis.crypto.subtle;

const b64u = (d) => Buffer.from(d instanceof Uint8Array ? d : new Uint8Array(d)).toString('base64url');
const unb64u = (t) => new Uint8Array(Buffer.from(t, 'base64url'));
const sha256 = async (t) => new Uint8Array(await su.digest('SHA-256', typeof t === 'string' ? enc.encode(t) : t));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function zufallsCode(n) {
  const roh = new Uint32Array(n);
  globalThis.crypto.getRandomValues(roh);
  return [...roh].map((z) => ALPHABET[z % ALPHABET.length]).join('');
}

const paketKontext = (ch, f, von, fuer) => `stellium/kanal/${ch}/${f}/${von}>${fuer}`;
const freigabeKontext = (ch, f, von, fuer) => `stellium/freigabe/${ch}/${f}/${von}>${fuer}`;

async function codeSchluessel(code, salzText, runden = 310_000) {
  const roh = await su.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return su.deriveKey(
    { name: 'PBKDF2', salt: await sha256(salzText), iterations: runden, hash: 'SHA-256' },
    roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/* ── Eine App ─────────────────────────────────────────────────── */

class App {
  constructor(name, token) {
    this.name = name; this.token = token;
    this.ereignisse = [];
    this.horcher = new Set();
    this.fremde = new Map();          // userId -> jwk
    this.kanalKeys = new Map();       // "<channelId>:<fassung>" -> CryptoKey
    this.fassung = new Map();
  }

  async verbinden() {
    const paar = await su.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    this.privat = paar.privateKey;
    this.oeffentlichJwk = JSON.stringify(await su.exportKey('jwk', paar.publicKey));

    await new Promise((fertig, schief) => {
      this.ws = new WebSocket(S.replace(/^http/, 'ws') + '/ws');
      const timer = setTimeout(() => schief(new Error(`${this.name}: keine Verbindung`)), 12000);
      this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'auth', token: this.token, protocol: 1 }));
      this.ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        this.ereignisse.push(ev);
        /* Erst den eigenen Zustand nachziehen, dann die Horcher rufen. Andersherum
           prüft ein wartender Horcher den Stand von vor dieser Meldung und
           verpasst genau das Ereignis, auf das er wartet. */
        if (ev.t === 'vertraulich:schluessel') {
          for (const s of ev.schluessel) this.fremde.set(s.userId, s.jwk);
        }
        if (ev.t === 'ready') {
          this.id = ev.self.id;
          this.handle = ev.self.handle;
        }
        for (const h of this.horcher) h(ev);
        if (ev.t === 'ready') { clearTimeout(timer); fertig(); }
      };
      this.ws.onerror = () => { clearTimeout(timer); schief(new Error(`${this.name}: Verbindungsfehler`)); };
    });

    const abdruckRoh = JSON.parse(this.oeffentlichJwk);
    const abdruck = hex((await sha256(`${abdruckRoh.x}|${abdruckRoh.y}`)).slice(0, 8)).toUpperCase();
    this.senden({ t: 'vertraulich:schluessel-melden', jwk: this.oeffentlichJwk, abdruck });
    await this.warteAuf((ev) => ev.t === 'vertraulich:schluessel');
    return this;
  }

  senden(ev) { this.ws.send(JSON.stringify(ev)); }

  /** Auf ein Ereignis warten — auch auf eines, das schon da war. */
  warteAuf(passt, ms = 8000) {
    const schon = this.ereignisse.find(passt);
    if (schon) return Promise.resolve(schon);
    return new Promise((fertig, schief) => {
      const timer = setTimeout(() => { this.horcher.delete(h); schief(new Error('Zeitüberschreitung')); }, ms);
      const h = (ev) => {
        if (!passt(ev)) return;
        clearTimeout(timer); this.horcher.delete(h); fertig(ev);
      };
      this.horcher.add(h);
    });
  }

  /** Ereignis schicken und auf die erste passende Antwort ODER einen Fehler warten. */
  async frage(ev, erwartet, ms = 8000) {
    const ab = this.ereignisse.length;
    this.senden(ev);
    return this.warteAuf((e, i) => {
      const idx = this.ereignisse.indexOf(e);
      if (idx < ab) return false;
      return erwartet(e) || e.t === 'error';
    }, ms);
  }

  async schluesselHolen(ids) {
    const fehlend = ids.filter((i) => !this.fremde.has(i));
    if (!fehlend.length) return;
    const ab = this.ereignisse.length;
    this.senden({ t: 'vertraulich:schluessel-holen', userIds: fehlend });
    await this.warteAuf((e) => this.ereignisse.indexOf(e) >= ab && e.t === 'vertraulich:schluessel');
    const offen = fehlend.filter((i) => !this.fremde.has(i));
    if (offen.length) throw new Error(`kein öffentlicher Schlüssel für ${offen.join(', ')}`);
  }

  async gemeinsam(fremdJwk, kontext) {
    const fremd = await su.importKey('jwk', JSON.parse(fremdJwk), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const bits = await su.deriveBits({ name: 'ECDH', public: fremd }, this.privat, 256);
    const roh = await su.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return su.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: await sha256(kontext), info: enc.encode('stellium/vertraulich/paket/v1') },
      roh, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }

  async packen(kanalKey, fremdJwk, kontext) {
    const roh = await su.exportKey('raw', kanalKey);
    const huelle = await this.gemeinsam(fremdJwk, kontext);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const daten = await su.encrypt({ name: 'AES-GCM', iv }, huelle, roh);
    return { alg: 'ecdh-p256+aes-gcm', von: this.id, iv: b64u(iv), daten: b64u(daten) };
  }

  async auspacken(paket, kontext) {
    await this.schluesselHolen([paket.von]);
    const huelle = await this.gemeinsam(this.fremde.get(paket.von), kontext);
    const roh = await su.decrypt({ name: 'AES-GCM', iv: unb64u(paket.iv) }, huelle, unb64u(paket.daten));
    return su.importKey('raw', roh, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  }

  async kanalVertraulich(channelId, mitgliedIds) {
    await this.schluesselHolen(mitgliedIds);
    const key = await su.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const pakete = [];
    for (const uid of mitgliedIds) {
      pakete.push({ userId: uid, paket: await this.packen(key, this.fremde.get(uid), paketKontext(channelId, 1, this.id, uid)) });
    }
    this.kanalKeys.set(`${channelId}:1`, key);
    this.fassung.set(channelId, 1);
    this.senden({ t: 'vertraulich:einschalten', channelId, pakete });
    await this.warteAuf((ev) => ev.t === 'channel:upsert' && ev.channel.id === channelId && ev.channel.vertraulich);
  }

  /** Die eigenen Pakete holen und auspacken. */
  async kanalAufschliessen(channelId) {
    this.senden({ t: 'vertraulich:paket-holen', channelId });
    const ev = await this.warteAuf((e) => e.t === 'vertraulich:paket' && e.channelId === channelId);
    this.fassung.set(channelId, ev.fassung);
    for (const { fassung, paket } of ev.pakete) {
      try {
        this.kanalKeys.set(`${channelId}:${fassung}`,
          await this.auspacken(paket, paketKontext(channelId, fassung, paket.von, this.id)));
      } catch { /* alte Fassung, nicht für uns */ }
    }
    return ev.pakete.length;
  }

  async verschluesseln(channelId, text) {
    const f = this.fassung.get(channelId);
    const key = this.kanalKeys.get(`${channelId}:${f}`);
    if (!key) throw new Error('kein Kanalschlüssel');
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const daten = await su.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return `e1:${f}:${b64u(iv)}:${b64u(daten)}`;
  }

  async entschluesseln(channelId, roh) {
    const teile = roh.slice(3).split(':');
    const key = this.kanalKeys.get(`${channelId}:${Number(teile[0])}`);
    if (!key) return null;
    try {
      return dec.decode(await su.decrypt({ name: 'AES-GCM', iv: unb64u(teile[1]) }, key, unb64u(teile[2])));
    } catch { return null; }
  }

  zu() { try { this.ws.close(); } catch { /* schon zu */ } }
}

/* ── Konten anlegen ───────────────────────────────────────────── */

const marke = Date.now().toString(36).slice(-5);
const anmelden = async (login, passwort) =>
  (await (await fetch(`${S}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: passwort }),
  })).json());

const leitung = await anmelden(probe.login, probe.passwort);
const leitungKopf = { authorization: `Bearer ${leitung.token}` };

async function kontoAnlegen(name) {
  const neu = await (await fetch(`${S}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...leitungKopf },
    body: JSON.stringify({ displayName: `${name} ${marke}`, handle: `${name}${marke}`, role: 'member', language: 'de' }),
  })).json();
  const erste = await anmelden(neu.credential.handle, neu.credential.oneTimePassword);
  await fetch(`${S}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${erste.token}` },
    body: JSON.stringify({ newPassword: `Passwort-${name}-${marke}` }),
  });
  const sitzung = await anmelden(neu.credential.handle, `Passwort-${name}-${marke}`);
  return { token: sitzung.token, id: neu.credential.userId };
}

const mitgliedKonto = await kontoAnlegen('mitglied');
const fremdeKonto = await kontoAnlegen('fremde');

const chefin = await new App('Leitung', leitung.token).verbinden();
const kollege = await new App('Mitglied', mitgliedKonto.token).verbinden();
const fremde = await new App('Fremde', fremdeKonto.token).verbinden();

/* ── Kanal aufsetzen ──────────────────────────────────────────── */

const GEHEIM = `Der Quartalsbonus liegt bei ${marke} Euro und bleibt unter uns.`;

chefin.senden({ t: 'channel:create', kind: 'private', name: `vertraulich-${marke}`, memberIds: [kollege.id] });
const kanalEv = await chefin.warteAuf((ev) => ev.t === 'channel:upsert' && ev.channel.name === `vertraulich-${marke}`);
const kanalId = kanalEv.channel.id;

console.log('\nVertraulich stellen');

await pruefe('Kanal lässt sich vertraulich stellen', async () => {
  await chefin.kanalVertraulich(kanalId, [chefin.id, kollege.id]);
  const ev = await chefin.warteAuf((e) => e.t === 'channel:upsert' && e.channel.id === kanalId && e.channel.vertraulich);
  muss(ev.channel.schluesselFassung === 1, `Fassung ${ev.channel.schluesselFassung} statt 1`);
  return `Fassung ${ev.channel.schluesselFassung}`;
});

await pruefe('Offene Kanäle lassen sich nicht vertraulich stellen', async () => {
  chefin.senden({ t: 'channel:create', kind: 'public', name: `offen-${marke}` });
  const offen = await chefin.warteAuf((e) => e.t === 'channel:upsert' && e.channel.name === `offen-${marke}`);
  const antwort = await chefin.frage(
    { t: 'vertraulich:einschalten', channelId: offen.channel.id, pakete: [] },
    (e) => e.t === 'channel:upsert' && e.channel.id === offen.channel.id && e.channel.vertraulich,
  );
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.message.slice(0, 40) + '…';
});

console.log('\nDer Server sieht keinen Klartext');

let nachrichtId = null;
/* Das Chiffrat so, wie eine App es bekommt. Der Rohwert aus der Tabelle taugt
   dafür nicht: liegt ein Masterpasswort vor, steckt er zusätzlich in der
   Serverschicht "m1:" und ist nicht dasselbe. */
let nachrichtChiffrat = null;

await pruefe('Verschlüsselte Nachricht kommt an', async () => {
  const chiffrat = await chefin.verschluesseln(kanalId, GEHEIM);
  muss(chiffrat.startsWith('e1:'), 'kein Chiffrat erzeugt');
  chefin.senden({ t: 'message:send', clientId: 'v1', channelId: kanalId, text: chiffrat });
  const ev = await chefin.warteAuf((e) => e.t === 'message:new' && e.message.channelId === kanalId && e.message.text.startsWith('e1:'));
  nachrichtId = ev.message.id;
  nachrichtChiffrat = ev.message.text;
  return `${ev.message.text.slice(0, 18)}…`;
});

await pruefe('Klartext wird im vertraulichen Kanal abgewiesen', async () => {
  const antwort = await chefin.frage(
    { t: 'message:send', clientId: 'v2', channelId: kanalId, text: 'Das hier ist offen' },
    (e) => e.t === 'message:new' && e.message.text === 'Das hier ist offen',
  );
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(antwort.code === 'fehler.vertraulichNoetig', `Kennung ${antwort.code}`);
  return antwort.code;
});

await pruefe('In der Datenbank steht nichts Lesbares', async () => {
  const roh = fs.readFileSync(probe.datenbank);
  muss(!roh.includes(Buffer.from(GEHEIM, 'utf8')), 'der Klartext steht in der Datenbankdatei');
  muss(!roh.includes(Buffer.from('Quartalsbonus', 'utf8')), 'ein Wort des Klartexts steht in der Datei');

  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeile = db.prepare('SELECT text, source_lang FROM messages WHERE id = ?').get(nachrichtId);
  db.close();
  muss(zeile, 'die Nachricht fehlt in der Datenbank');
  muss(zeile.source_lang === null, `Sprache "${zeile.source_lang}" geraten statt offengelassen`);
  return `gespeichert als ${String(zeile.text).slice(0, 3)}…`;
});

await pruefe('Auch mit dem Masterpasswort kommt der Server nicht heran', async () => {
  /* Die eigentliche Zusage. Liegt ein Masterpasswort vor, ist der Text doppelt
     verpackt: außen die Verschlüsselung des Servers gegen den gestohlenen
     Datenträger, innen die des Kanals gegen den Server selbst. Hier wird die
     äußere mit dem echten Masterpasswort geöffnet — und darunter liegt
     weiterhin Chiffrat. Ohne Masterpasswort gibt entschluesseln() den Wert
     unverändert zurück, dann steht das innere Chiffrat gleich da. */
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeile = db.prepare('SELECT text FROM messages WHERE id = ?').get(nachrichtId);
  db.close();

  const darunter = serverEntschluesseln(zeile.text);
  muss(darunter, 'der Server bekam beim Aufschließen gar nichts');
  muss(darunter.startsWith('e1:'), `darunter lag "${darunter.slice(0, 40)}"`);
  muss(!darunter.includes('Quartalsbonus'), 'der Klartext lag unter der Serverschicht');
  return `${String(zeile.text).slice(0, 3)} → ${darunter.slice(0, 5)}… und nicht weiter`;
});

await pruefe('Der Volltextindex bleibt leer', async () => {
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) n FROM message_fts WHERE message_id = ?').get(nachrichtId);
  db.close();
  muss(n.n === 0, `${n.n} Einträge im Index`);
  return '0 Einträge';
});

await pruefe('Die serverseitige Suche findet nichts', async () => {
  const antwort = await (await fetch(`${S}/api/search?q=Quartalsbonus`, { headers: leitungKopf })).json();
  muss(Array.isArray(antwort.hits), 'keine Trefferliste');
  muss(antwort.hits.length === 0, `${antwort.hits.length} Treffer trotz Verschlüsselung`);
  return '0 Treffer';
});

await pruefe('Übersetzen wird abgewiesen', async () => {
  const antwort = await chefin.frage(
    { t: 'translate:request', messageId: nachrichtId, targetLang: 'en' },
    (e) => e.t === 'translation',
  );
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(antwort.code === 'fehler.vertraulich', `Kennung ${antwort.code}`);
  return antwort.code;
});

await pruefe('Zusammenfassen wird abgewiesen', async () => {
  const antwort = await chefin.frage(
    { t: 'ai:catchup', requestId: 'r1', channelId: kanalId },
    (e) => e.t === 'ai:catchup',
  );
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.code;
});

await pruefe('Die Vorschau beim Tippen wird abgewiesen', async () => {
  // Die heikelste Stelle: hier ginge Klartext hinaus, bevor er verschlüsselt ist.
  const antwort = await chefin.frage(
    { t: 'compose:preview', requestId: 'r2', text: GEHEIM, targetLang: 'en', channelId: kanalId },
    (e) => e.t === 'compose:preview',
  );
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.code;
});

/**
 * Vorschläge der KI — geprüft am Dienst selbst, nicht an einem Ereignis.
 *
 * Die anderen KI-Funktionen weist das Gateway ab, und genau das steht oben.
 * Vorschläge entstehen aber nicht auf Zuruf, sondern von selbst in einem
 * Hintergrundlauf: es gibt kein Ereignis, das man schicken und abweisen
 * lassen könnte. Die ehrliche Frage lautet deshalb nicht „wird es
 * abgewiesen", sondern „entsteht überhaupt etwas" — und die beantwortet nur
 * ein Blick in die Tabelle.
 *
 * Der Dienst läuft dafür in einem eigenen Prozess. Ihn hier zu laden zöge
 * halb den Server in diesen Prüflauf hinein; ein Kindprozess mit demselben
 * DATA_DIR sieht dieselbe Datenbank und ist danach wieder weg.
 */
await pruefe('In einem vertraulichen Kanal entsteht kein KI-Vorschlag', async () => {
  const modul = pathToFileURL(
    path.resolve('packages/server/dist/services/vorschlaege.js'),
  ).href;

  const sonde = [
    "const V = await import(process.env.SONDE_MODUL);",
    "const kanal = process.env.SONDE_KANAL;",
    "const lauf = await V.laufFuerKanal(kanal);",
    "const eintrag = V.kandidatenEintragen(kanal, [{",
    "  art: 'aufgabe', titel: process.env.SONDE_TITEL,",
    "  quelleMessageId: process.env.SONDE_NACHRICHT, genanntUserId: null, faelligAm: null,",
    "}]);",
    "console.log('SONDE ' + JSON.stringify({",
    "  laufGrund: lauf.grund, laufAngelegt: lauf.angelegt.length,",
    "  eintragGrund: eintrag.grund, eintragAngelegt: eintrag.angelegt.length,",
    "  imKanal: V.zaehlenImKanal(kanal),",
    "  klartext: V.klartextGefunden(process.env.SONDE_GEHEIM),",
    "  faellig: V.faelligeKanaele(Date.now() + 86400000).includes(kanal),",
    "}));",
  ].join('\n');

  const ausgabe = execFileSync('node', ['--input-type=module', '-e', sonde], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_DIR: probe.datenordner,
      SONDE_MODUL: modul,
      SONDE_KANAL: kanalId,
      SONDE_NACHRICHT: nachrichtId,
      SONDE_TITEL: `${GEHEIM} neu berechnen`,
      SONDE_GEHEIM: GEHEIM,
    },
  });

  const zeile = ausgabe.split('\n').find((z) => z.startsWith('SONDE '));
  muss(zeile, `keine Antwort der Sonde:\n${ausgabe.slice(-400)}`);
  const r = JSON.parse(zeile.slice(6));

  muss(r.laufGrund === 'vertraulich', `der Lauf lief mit Grund "${r.laufGrund}"`);
  muss(r.laufAngelegt === 0, `${r.laufAngelegt} Vorschläge aus dem Lauf`);
  muss(r.eintragGrund === 'vertraulich', `das Eintragen lief mit Grund "${r.eintragGrund}"`);
  muss(r.eintragAngelegt === 0, `${r.eintragAngelegt} Vorschläge eingetragen`);
  muss(r.imKanal === 0, `${r.imKanal} Zeilen stehen in der Vorschlagstabelle`);
  muss(!r.faellig, 'der vertrauliche Kanal wurde zum Lesen ausgewählt');
  muss(!r.klartext, 'der Klartext steht in der Vorschlagstabelle');
  return 'nichts entstanden, nichts gelesen';
});

/* ── Die übrigen Wege in einen Kanal hinein ───────────────────── */

/* Klartext abzuweisen nützt nur, wenn es an jeder Tür passiert. Die
   Oberfläche blendet Umfrage, Sprachnachricht und Weiterleiten in einem
   vertraulichen Kanal aus — geprüft wird hier, dass auch eine App, die das
   nicht tut, nicht durchkommt. Deshalb geht jede dieser Prüfungen über die
   echte Ereignisleitung und nicht an ihr vorbei. */

console.log('\nKein anderer Weg schreibt Klartext hinein');

const kanalAnlegen = async (art, name, mitgliedIds = []) => {
  chefin.senden({ t: 'channel:create', kind: art, name, memberIds: mitgliedIds });
  return (await chefin.warteAuf((e) => e.t === 'channel:upsert' && e.channel.name === name)).channel.id;
};

// Zwei offene Kanäle für die Gegenprobe, ein zweiter vertraulicher für den
// vierten Fall des Weiterleitens: zwei geschlossene Kanäle, zwei Schlüssel.
const offenA = await kanalAnlegen('public', `weiter-a-${marke}`);
const offenB = await kanalAnlegen('public', `weiter-b-${marke}`);
const kanalZwei = await kanalAnlegen('private', `vertraulich-zwei-${marke}`);
await chefin.kanalVertraulich(kanalZwei, [chefin.id]);

const AUSHANG = `Offener Aushang ${marke}`;
chefin.senden({ t: 'message:send', clientId: 'o1', channelId: offenA, text: AUSHANG });
const offeneNachricht = (await chefin.warteAuf(
  (e) => e.t === 'message:new' && e.message.channelId === offenA && e.message.text === AUSHANG)).message.id;

await pruefe('Eine Umfrage im Klartext wird abgewiesen', async () => {
  const antwort = await chefin.frage({
    t: 'poll:create', clientId: 'u1', channelId: kanalId,
    question: `Schließen wir den Standort Nord, ${marke}?`,
    options: ['Ja, zum Quartalsende', 'Nein'], multiple: false, anonymous: false,
  }, (e) => e.t === 'message:new' && e.message.channelId === kanalId);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(antwort.code === 'fehler.vertraulichNoetig', `Kennung ${antwort.code}`);
  return antwort.code;
});

await pruefe('Auch eine Umfrage mit offenen Antwortmöglichkeiten wird abgewiesen', async () => {
  /* Die Frage verschlossen, die Antworten offen — der Gegenstand der Umfrage
     stünde damit genauso im Kanal. Ohne Prüfung jeder einzelnen Antwort ginge
     genau das durch. */
  const antwort = await chefin.frage({
    t: 'poll:create', clientId: 'u2', channelId: kanalId,
    question: await chefin.verschluesseln(kanalId, 'Standortfrage'),
    options: ['Ja, zum Quartalsende', 'Nein'], multiple: false, anonymous: false,
  }, (e) => e.t === 'message:new' && e.message.channelId === kanalId);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(antwort.code === 'fehler.vertraulichNoetig', `Kennung ${antwort.code}`);
  return antwort.code;
});

await pruefe('Eine Sprachnachricht wird abgewiesen', async () => {
  /* Die Aufnahme ginge als gewöhnlicher Anhang auf den Server — unverschlüsselt,
     denn für Anhänge gibt es die Ende-zu-Ende-Verschlüsselung noch nicht. */
  const antwort = await chefin.frage({
    t: 'voice:send', clientId: 's1', channelId: kanalId,
    attachmentId: 'at_gibtsnicht', durationMs: 2000,
  }, (e) => e.t === 'message:new' && e.message.channelId === kanalId);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(antwort.code === 'fehler.vertraulichSprachnachricht', `Kennung ${antwort.code}`);
  return antwort.code;
});

await pruefe('Weiterleiten aus einem vertraulichen Kanal hinaus wird abgewiesen', async () => {
  // Das Chiffrat verließe den Kanal. Lesen könnte es im Zielkanal niemand —
  // liegen hätten es ab dann aber Leute, die nie dabei waren.
  const antwort = await chefin.frage({
    t: 'message:forward', clientId: 'w1', messageId: nachrichtId, toChannelId: offenA,
  }, (e) => e.t === 'message:new' && e.message.channelId === offenA);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(antwort.code === 'fehler.vertraulichWeiterleiten', `Kennung ${antwort.code}`);
  return antwort.code;
});

await pruefe('Weiterleiten in einen vertraulichen Kanal hinein wird abgewiesen', async () => {
  // Offener Text in einem Kanal, in dem laut Zusage nur Chiffrat liegt.
  const antwort = await chefin.frage({
    t: 'message:forward', clientId: 'w2', messageId: offeneNachricht, toChannelId: kanalId,
  }, (e) => e.t === 'message:new' && e.message.channelId === kanalId);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(antwort.code === 'fehler.vertraulichWeiterleiten', `Kennung ${antwort.code}`);
  return antwort.code;
});

await pruefe('Weiterleiten zwischen zwei vertraulichen Kanälen wird abgewiesen', async () => {
  // Zwei Kanäle, zwei Kanalschlüssel: das Chiffrat des einen ist im anderen
  // wertlos, und umschlüsseln kann der Server nicht.
  const antwort = await chefin.frage({
    t: 'message:forward', clientId: 'w3', messageId: nachrichtId, toChannelId: kanalZwei,
  }, (e) => e.t === 'message:new' && e.message.channelId === kanalZwei);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(antwort.code === 'fehler.vertraulichWeiterleiten', `Kennung ${antwort.code}`);
  return antwort.code;
});

await pruefe('Zwischen offenen Kanälen bleibt Weiterleiten erlaubt', async () => {
  /* Die Gegenprobe. Ohne sie stünde hier eine Prüfung, die auch dann grün
     bliebe, wenn Weiterleiten überall abgeschaltet wäre. */
  const antwort = await chefin.frage({
    t: 'message:forward', clientId: 'w4', messageId: offeneNachricht, toChannelId: offenB,
  }, (e) => e.t === 'message:new' && e.message.channelId === offenB);
  muss(antwort.t === 'message:new', `bekam ${antwort.t}: ${antwort.message ?? ''}`);
  muss(String(antwort.message.text).includes(AUSHANG), `Text: "${antwort.message.text}"`);
  return 'unverändert erlaubt';
});

await pruefe('Ein Entwurf für einen vertraulichen Kanal bleibt auf dem Gerät', async () => {
  /* Der stillste der Wege: die App speichert beim Tippen mit. Ohne Prüfung
     käme jede Nachricht schon vor dem Absenden offen auf dem Server an. */
  const ENTWURF = `Halb getippt und noch nicht abgeschickt, ${marke}`;
  chefin.senden({ t: 'draft:save', channelId: kanalId, parentId: null, text: ENTWURF });
  // Der Server arbeitet je Verbindung der Reihe nach: ist das Pong da, ist
  // auch der Entwurf durch.
  await chefin.frage({ t: 'ping', ts: Date.now() }, (e) => e.t === 'pong');

  const roh = fs.readFileSync(probe.datenbank);
  muss(!roh.includes(Buffer.from(ENTWURF, 'utf8')), 'der Entwurf steht in der Datenbankdatei');
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) n FROM drafts WHERE channel_id = ?').get(kanalId);
  db.close();
  muss(n.n === 0, `${n.n} Entwürfe gespeichert`);
  return '0 Entwürfe';
});

await pruefe('Eine geplante Nachricht geht nicht in einen inzwischen vertraulichen Kanal', async () => {
  /* Beim Planen war der Kanal offen, beim Absenden ist er es nicht mehr. Der
     Text liegt dann fertig und unverschlüsselt bereit — verschlüsseln kann der
     Server ihn nicht, also darf er ihn auch nicht mehr hinausschicken. Die
     Prüfung beim Planen allein greift hier zu kurz. */
  const GEPLANT = `Diese Zeile war vor der Umstellung geplant, ${marke}`;
  const kanalDrei = await kanalAnlegen('private', `geplant-${marke}`);
  chefin.senden({ t: 'message:schedule', channelId: kanalDrei, text: GEPLANT, sendAt: Date.now() + 11_000 });
  await chefin.warteAuf((e) => e.t === 'scheduled:upsert');
  await chefin.kanalVertraulich(kanalDrei, [chefin.id]);

  /* Geplant werden kann frühestens elf Sekunden voraus (scheduleMessage besteht
     auf zehn), und der Absender sieht alle fünf Sekunden nach. Hier darf also
     ruhig gewartet werden. */
  const antwort = await chefin.warteAuf(
    (e) => e.t === 'error' && e.code === 'fehler.vertraulichGeplant', 30_000);
  muss(antwort.code === 'fehler.vertraulichGeplant', `Kennung ${antwort.code}`);
  const durchgerutscht = chefin.ereignisse.some(
    (e) => e.t === 'message:new' && e.message.channelId === kanalDrei && e.message.text === GEPLANT);
  muss(!durchgerutscht, 'die geplante Nachricht ging trotzdem offen hinaus');
  return antwort.code;
});

await pruefe('In einem offenen Kanal wird der Entwurf weiter gespeichert', async () => {
  // Gegenprobe: die Prüfung oben darf das Zwischenspeichern nicht überall abschalten.
  chefin.senden({ t: 'draft:save', channelId: offenA, parentId: null, text: `Halbfertig ${marke}` });
  await chefin.frage({ t: 'ping', ts: Date.now() }, (e) => e.t === 'pong');
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) n FROM drafts WHERE channel_id = ?').get(offenA);
  db.close();
  muss(n.n === 1, `${n.n} Entwürfe statt einem`);
  return 'weiter gespeichert';
});

console.log('\nMitglieder lesen mit, Fremde nicht');

await pruefe('Ein Mitglied entschlüsselt die Nachricht', async () => {
  const anzahl = await kollege.kanalAufschliessen(kanalId);
  muss(anzahl > 0, 'kein Schlüsselpaket bekommen');
  kollege.senden({ t: 'channel:open', channelId: kanalId });
  const verlauf = await kollege.warteAuf((e) => e.t === 'channel:history' && e.channelId === kanalId);
  const msg = verlauf.messages.find((m) => m.id === nachrichtId);
  muss(msg, 'die Nachricht fehlt im Verlauf');
  const klar = await kollege.entschluesseln(kanalId, msg.text);
  muss(klar === GEHEIM, `entschlüsselt zu "${klar}"`);
  return 'Klartext stimmt';
});

await pruefe('Fremde kommen nicht in den Kanal', async () => {
  const antwort = await fremde.frage(
    { t: 'channel:open', channelId: kanalId },
    (e) => e.t === 'channel:history' && e.channelId === kanalId,
  );
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.code;
});

await pruefe('Fremde bekommen kein Schlüsselpaket', async () => {
  const antwort = await fremde.frage(
    { t: 'vertraulich:paket-holen', channelId: kanalId },
    (e) => e.t === 'vertraulich:paket' && e.channelId === kanalId,
  );
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.code;
});

await pruefe('Auch mit abgefangenem Chiffrat kommen Fremde nicht weiter', async () => {
  /* Der harte Fall: die Fremde hat das Chiffrat wortwörtlich in der Hand —
     mitgeschnitten, aus einem Backup, egal woher — aber keinen Schlüssel. */
  muss(nachrichtChiffrat, 'kein Chiffrat zum Prüfen');
  fremde.fassung.set(kanalId, 1);
  const klar = await fremde.entschluesseln(kanalId, nachrichtChiffrat);
  muss(klar === null, `konnte lesen: "${klar}"`);
  return 'bleibt zu';
});

/* ── Dateien ──────────────────────────────────────────────────────
 *
 * Die zweite Hälfte der Zusage. Nachrichtentexte waren längst zu, Anhänge
 * lagen offen daneben — wer ein Bild in einen vertraulichen Kanal legte, bekam
 * eine Zusage, die für seinen Anhang nicht galt.
 *
 * Geprüft wird hier dasselbe wie bei den Texten, nur an den Bytes auf der
 * Platte statt an einer Spalte in der Datenbank. Und wie oben ist die
 * Verschlüsselung noch einmal ausgeschrieben statt eingebunden: eine Prüfung,
 * die dieselbe Rechnung wie der Prüfling benutzt, prüft nur, dass er mit sich
 * selbst einig ist.
 */

console.log('\nDateien: Anhänge in vertraulichen Kanälen');

const STUECK = 4 * 1024 * 1024;

/** Der Schlüssel, den nur das eigene Schlüsselpaar hergibt. */
App.prototype.kontoSchluessel = function kontoSchluessel() {
  return this.gemeinsam(this.oeffentlichJwk, `stellium/datei/konto/${this.id}`);
};

App.prototype.huelleSchluessel = function huelleSchluessel(huelle) {
  if (huelle.art === 'konto') return this.kontoSchluessel();
  const key = this.kanalKeys.get(`${huelle.channelId}:${huelle.fassung}`);
  if (!key) throw new Error('kein Kanalschlüssel für diese Hülle');
  return Promise.resolve(key);
};

/** Eine Datei verschließen — Zufallsschlüssel, verpackt mit der Hülle. */
App.prototype.dateiVerschluesseln = async function dateiVerschluesseln(inhalt, name, mime, huelle) {
  const huelleKey = await this.huelleSchluessel(huelle);
  const dateiKey = await su.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const beigabe = enc.encode(JSON.stringify(huelle));

  const schluesselIv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const verpackt = await su.encrypt(
    { name: 'AES-GCM', iv: schluesselIv, additionalData: beigabe },
    huelleKey, await su.exportKey('raw', dateiKey),
  );

  const kopfIv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const kopf = await su.encrypt(
    { name: 'AES-GCM', iv: kopfIv, additionalData: enc.encode('kopf') },
    dateiKey, enc.encode(JSON.stringify({ name, mime, groesse: inhalt.length })),
  );

  const umschlag = {
    alg: 'aes-gcm', stueck: STUECK, huelle,
    schluesselIv: b64u(schluesselIv), schluessel: b64u(verpackt),
    kopfIv: b64u(kopfIv), kopf: b64u(kopf),
  };
  const teile = [Buffer.from(`d1:${b64u(enc.encode(JSON.stringify(umschlag)))}\n`, 'utf8')];

  for (let nummer = 0, von = 0; von < inhalt.length; nummer++, von += STUECK) {
    const roh = inhalt.subarray(von, Math.min(von + STUECK, inhalt.length));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const chiffrat = Buffer.from(await su.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(String(nummer)) }, dateiKey, roh,
    ));
    const laenge = Buffer.alloc(4);
    laenge.writeUInt32BE(chiffrat.length, 0);
    teile.push(laenge, Buffer.from(iv), chiffrat);
  }
  return Buffer.concat(teile);
};

/** Umkehrung. Der Schlüssel steht nicht dabei — er ergibt sich aus der Hülle. */
App.prototype.dateiEntschluesseln = async function dateiEntschluesseln(daten) {
  const trenner = daten.indexOf(0x0a);
  if (trenner < 0) throw new Error('kein Umschlag');
  const umschlag = JSON.parse(
    Buffer.from(daten.subarray(3, trenner).toString('utf8'), 'base64url').toString('utf8'));

  const huelleKey = await this.huelleSchluessel(umschlag.huelle);
  const beigabe = enc.encode(JSON.stringify(umschlag.huelle));
  const rohSchluessel = await su.decrypt(
    { name: 'AES-GCM', iv: unb64u(umschlag.schluesselIv), additionalData: beigabe },
    huelleKey, unb64u(umschlag.schluessel),
  );
  const dateiKey = await su.importKey('raw', rohSchluessel, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);

  const kopf = JSON.parse(dec.decode(await su.decrypt(
    { name: 'AES-GCM', iv: unb64u(umschlag.kopfIv), additionalData: enc.encode('kopf') },
    dateiKey, unb64u(umschlag.kopf),
  )));

  const stuecke = [];
  let pos = trenner + 1;
  for (let nummer = 0; pos < daten.length; nummer++) {
    const laenge = daten.readUInt32BE(pos); pos += 4;
    const iv = daten.subarray(pos, pos + 12); pos += 12;
    const chiffrat = daten.subarray(pos, pos + laenge); pos += laenge;
    stuecke.push(Buffer.from(await su.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(String(nummer)) }, dateiKey, chiffrat,
    )));
  }
  return { kopf, inhalt: Buffer.concat(stuecke) };
};

/** Hochladen wie die App: ein Formular mit genau einer Datei. */
async function hochladen(token, bytes, name, mime = 'application/octet-stream') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), name);
  const antwort = await fetch(`${S}/api/uploads`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  });
  const daten = await antwort.json();
  if (!antwort.ok) throw new Error(daten.error ?? `Upload: ${antwort.status}`);
  return daten.attachment;
}

/** Dasselbe für die Team-Ablage. */
async function inAblage(token, bytes, name, felder = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
  for (const [k, v] of Object.entries(felder)) form.append(k, v);
  const antwort = await fetch(`${S}/api/files`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  });
  const daten = await antwort.json();
  if (!antwort.ok) throw new Error(daten.error ?? `Ablage: ${antwort.status}`);
  return daten.file;
}

/** Wo eine hochgeladene Datei wirklich liegt. */
function pfadVon(id, tabelle = 'attachments') {
  /* `sha256` gibt es nur bei Anhängen — die Ablage kennt keine Prüfsumme,
     weil sie nie über eine gesucht hat. */
  const spalten = tabelle === 'attachments'
    ? 'path, name, mime, huelle, sha256'
    : 'path, name, mime, huelle';
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeile = db.prepare(`SELECT ${spalten} FROM ${tabelle} WHERE id = ?`).get(id);
  db.close();
  return zeile;
}

const GEHEIMES_BILD = Buffer.concat([
  Buffer.from(`GEHEIME-ZEICHNUNG-${marke}: Standort Nord wird zum Quartalsende geschlossen.`, 'utf8'),
  globalThis.crypto.getRandomValues(new Uint8Array(4096)),
]);

let anhangId = null;

await pruefe('Ein offener Anhang wird im vertraulichen Kanal abgewiesen', async () => {
  /* Der eigentliche Fall. Bis eben nahm der Kanal die Datei entgegen: der Text
     kam als "e1:…" an, das Bild darunter lag ansehbar auf der Platte. */
  const offen = await hochladen(leitung.token, Buffer.from('Ganz offen und lesbar', 'utf8'), 'offen.txt', 'text/plain');
  const antwort = await chefin.frage({
    t: 'message:send', clientId: 'd1', channelId: kanalId,
    text: await chefin.verschluesseln(kanalId, 'Anbei'), attachmentIds: [offen.id],
  }, (e) => e.t === 'message:new' && e.message.channelId === kanalId && e.message.attachments.length > 0);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  muss(/verschlüsselt/i.test(antwort.message), `Meldung: "${antwort.message}"`);
  return antwort.message.slice(0, 44) + '…';
});

await pruefe('Ein verschlossener Anhang kommt an', async () => {
  const zu = await chefin.dateiVerschluesseln(
    GEHEIMES_BILD, 'Standortschliessung.png', 'image/png',
    { art: 'kanal', channelId: kanalId, fassung: chefin.fassung.get(kanalId) },
  );
  const anhang = await hochladen(leitung.token, zu, 'verschlossen');
  anhangId = anhang.id;

  const ev = await chefin.frage({
    t: 'message:send', clientId: 'd2', channelId: kanalId,
    text: await chefin.verschluesseln(kanalId, 'Anbei die Zeichnung'), attachmentIds: [anhang.id],
  }, (e) => e.t === 'message:new' && e.message.channelId === kanalId && e.message.attachments.length > 0);
  muss(ev.t === 'message:new', `bekam ${ev.t}: ${ev.message ?? ''}`);
  muss(ev.message.attachments[0].huelle?.art === 'kanal', 'die Hülle fehlt am Anhang');
  muss(ev.message.attachments[0].huelle.channelId === kanalId, 'die Hülle zeigt auf einen anderen Kanal');
  return `${zu.length} Byte, Hülle ${ev.message.attachments[0].huelle.art}`;
});

await pruefe('Name und Typ stehen nicht beim Server', async () => {
  /* "Standortschliessung.png" verriete den Inhalt, ohne dass jemand die Datei
     öffnen müsste. Der echte Name liegt verschlossen im Umschlag. */
  const zeile = pfadVon(anhangId);
  muss(zeile.name === 'verschlossen', `der Server führt sie als "${zeile.name}"`);
  muss(zeile.mime === 'application/octet-stream', `Typ "${zeile.mime}"`);
  muss(zeile.huelle, 'die Hülle fehlt in der Zeile');
  return `"${zeile.name}", ${zeile.mime}`;
});

await pruefe('Der Host kommt mit allen Serverschlüsseln nicht an die Bytes', async () => {
  /* Die schärfste Frage, und dieselbe wie oben bei den Nachrichtentexten —
     dort war die Antwort "m1: → e1:1:… und nicht weiter". Hier geht sie an die
     Datei selbst.
   *
   * Der Host hat: das Masterpasswort, die ganze Datenbank, das ganze
   * Datenverzeichnis. Er schließt damit auf, was er aufschließen kann, und
   * darunter liegt weiterhin Chiffrat. */
  const zeile = pfadVon(anhangId);
  const roh = fs.readFileSync(zeile.path);

  // 1. Was auf der Platte liegt, trägt keinen lesbaren Inhalt.
  muss(!roh.includes(Buffer.from(`GEHEIME-ZEICHNUNG-${marke}`, 'utf8')), 'der Klartext steht in der Datei');
  muss(!roh.includes(GEHEIMES_BILD.subarray(0, 64)), 'der Anfang des Originals steht in der Datei');

  // 2. Was ganz vorn steht, ist der Umschlag — und der ist die ganze Auskunft.
  const trenner = roh.indexOf(0x0a);
  muss(roh.subarray(0, 3).toString() === 'd1:', `Anfang "${roh.subarray(0, 8).toString('latin1')}"`);
  const umschlag = JSON.parse(
    Buffer.from(roh.subarray(3, trenner).toString('utf8'), 'base64url').toString('utf8'));
  muss(umschlag.huelle.art === 'kanal', 'der Umschlag nennt keine Kanalhülle');
  muss(!JSON.stringify(umschlag).includes('Standortschliessung'), 'der Name steht offen im Umschlag');
  muss(!JSON.stringify(umschlag).includes('image/png'), 'der Typ steht offen im Umschlag');

  // 3. Der Server öffnet seinen eigenen Tresor — und findet den Schlüssel nicht.
  //    In der Datenbank steht kein Kanalschlüssel, nur für Konten verpackte
  //    Pakete; und die gehen ohne einen privaten Teil nicht auf, den es hier
  //    nirgends gibt.
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const paket = db.prepare(
    'SELECT daten FROM kanal_schluessel_pakete WHERE channel_id = ? LIMIT 1').get(kanalId);
  const privateTeile = db.prepare(
    "SELECT COUNT(*) n FROM vertraulich_schluessel WHERE jwk LIKE '%\"d\"%'").get();
  db.close();
  muss(paket, 'gar kein Paket in der Datenbank — dann prüft das hier nichts');
  muss(serverEntschluesseln(paket.daten) === paket.daten,
    'das Paket lag zusätzlich in der Serverschicht — dann ist der Vergleich unten schief');
  muss(privateTeile.n === 0, `${privateTeile.n} private Schlüsselteile liegen beim Server`);

  // 4. Und der Klartext steht nirgends im ganzen Datenverzeichnis.
  const marker = Buffer.from(`GEHEIME-ZEICHNUNG-${marke}`, 'utf8');
  const gefunden = [];
  const durchsuchen = (ordner) => {
    for (const eintrag of fs.readdirSync(ordner, { withFileTypes: true })) {
      const voll = `${ordner}/${eintrag.name}`;
      if (eintrag.isDirectory()) { durchsuchen(voll); continue; }
      try { if (fs.readFileSync(voll).includes(marker)) gefunden.push(voll); } catch { /* egal */ }
    }
  };
  durchsuchen(probe.datenordner);
  muss(!gefunden.length, `der Klartext liegt in: ${gefunden.join(', ')}`);

  return `d1:{…} → verpackter Schlüssel, und kein Schlüssel dazu auf dem Server`;
});

await pruefe('Ein Mitglied öffnet den Anhang wieder', async () => {
  const antwort = await fetch(`${S}/files/${anhangId}`, {
    headers: { authorization: `Bearer ${mitgliedKonto.token}` },
  });
  muss(antwort.ok, `Abruf: ${antwort.status}`);
  /* Nie inline: was hier liegt, ist Chiffrat. Als Bild ausgeliefert ergäbe es
     ein kaputtes Bild und eine Angabe über den Inhalt, die nicht stimmt. */
  muss(antwort.headers.get('content-type') === 'application/octet-stream',
    `Typ "${antwort.headers.get('content-type')}"`);
  muss(!/inline/.test(antwort.headers.get('content-disposition') ?? ''), 'ging inline hinaus');

  const roh = Buffer.from(await antwort.arrayBuffer());
  const { kopf, inhalt } = await kollege.dateiEntschluesseln(roh);
  muss(kopf.name === 'Standortschliessung.png', `Name "${kopf.name}"`);
  muss(kopf.mime === 'image/png', `Typ "${kopf.mime}"`);
  muss(inhalt.equals(GEHEIMES_BILD), 'der Inhalt kam anders zurück');
  return `${kopf.name}, ${inhalt.length} Byte, Byte für Byte gleich`;
});

await pruefe('Ohne Kanalschlüssel bleibt der Anhang zu', async () => {
  /* Der harte Fall: die Fremde hat das Chiffrat wortwörtlich in der Hand —
     hier sogar aus der Datei auf der Platte — aber keinen Schlüssel. */
  const roh = fs.readFileSync(pfadVon(anhangId).path);
  let offen = false;
  try { await fremde.dateiEntschluesseln(roh); offen = true; } catch { /* so soll es sein */ }
  muss(!offen, 'die Fremde konnte den Anhang öffnen');
  return 'bleibt zu';
});

await pruefe('Ein Anhang für einen anderen Kreis wird abgewiesen', async () => {
  /* Verschlossen ist nicht genug — verschlossen für DIESEN Kanal muss es sein.
     Sonst läge im Kanal eine Datei, die dort niemand öffnen kann, und ein
     Kreis, der nie gemeint war, hätte sie. */
  const fuerAnderen = await chefin.dateiVerschluesseln(
    Buffer.from('Für einen anderen Kanal', 'utf8'), 'fremd.txt', 'text/plain',
    { art: 'kanal', channelId: kanalZwei, fassung: chefin.fassung.get(kanalZwei) },
  );
  const anhang = await hochladen(leitung.token, fuerAnderen, 'verschlossen');
  const antwort = await chefin.frage({
    t: 'message:send', clientId: 'd3', channelId: kanalId,
    text: await chefin.verschluesseln(kanalId, 'Anbei'), attachmentIds: [anhang.id],
  }, (e) => e.t === 'message:new' && e.message.channelId === kanalId && e.message.attachments.length > 0);
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.message.slice(0, 40) + '…';
});

await pruefe('In einem offenen Kanal bleibt ein offener Anhang erlaubt', async () => {
  /* Die Gegenprobe. Ohne sie stünde hier eine Prüfung, die auch dann grün
     bliebe, wenn Anhänge überall abgewiesen würden. */
  const offen = await hochladen(leitung.token, Buffer.from(`Aushang ${marke}`, 'utf8'), 'aushang.txt', 'text/plain');
  const antwort = await chefin.frage({
    t: 'message:send', clientId: 'd4', channelId: offenA, text: 'Anbei', attachmentIds: [offen.id],
  }, (e) => e.t === 'message:new' && e.message.channelId === offenA && e.message.attachments.length > 0);
  muss(antwort.t === 'message:new', `bekam ${antwort.t}: ${antwort.message ?? ''}`);
  muss(antwort.message.attachments[0].huelle === null, 'ein offener Anhang trägt eine Hülle');
  return 'unverändert erlaubt';
});

console.log('\nDateien: die private Ablage');

const GEHEIMES_PAPIER = Buffer.from(
  `PRIVATNOTIZ-${marke}: Gehaltsvorstellung und Kündigungsfrist.`, 'utf8');
let privatDateiId = null;

await pruefe('Eine private Datei liegt verschlossen beim Server', async () => {
  const zu = await chefin.dateiVerschluesseln(
    GEHEIMES_PAPIER, 'Gehaltszettel.pdf', 'application/pdf',
    { art: 'konto', userId: chefin.id },
  );
  const datei = await inAblage(leitung.token, zu, 'Gehaltszettel.pdf', { privat: '1' });
  privatDateiId = datei.id;
  muss(datei.privat, 'der Server hat sie nicht als privat vermerkt');

  const zeile = pfadVon(datei.id, 'files');
  const roh = fs.readFileSync(zeile.path);
  muss(!roh.includes(Buffer.from(`PRIVATNOTIZ-${marke}`, 'utf8')), 'der Klartext liegt auf der Platte');
  muss(roh.subarray(0, 3).toString() === 'd1:', 'kein Umschlag am Anfang');
  const umschlag = JSON.parse(Buffer.from(
    roh.subarray(3, roh.indexOf(0x0a)).toString('utf8'), 'base64url').toString('utf8'));
  muss(umschlag.huelle.art === 'konto', `Hülle "${umschlag.huelle.art}"`);
  muss(umschlag.huelle.userId === chefin.id, 'die Hülle nennt ein anderes Konto');
  return `Hülle konto/${umschlag.huelle.userId.slice(0, 8)}…`;
});

await pruefe('Privat ohne Verschlüsselung weist der Server ab', async () => {
  /* Ein Formularfeld ist eine Behauptung. Die Zusage "nicht einmal der Host"
     darf nicht auf einer Behauptung ruhen — sonst bekäme eine ältere App das
     Schloss danebengemalt und schickte den Klartext. */
  let durch = false;
  try {
    await inAblage(leitung.token, Buffer.from('Ganz offen', 'utf8'), 'offen.txt', { privat: '1' });
    durch = true;
  } catch (e) {
    muss(/unverschlüsselt/i.test(e.message), `Meldung: "${e.message}"`);
  }
  muss(!durch, 'eine unverschlüsselte Datei kam als privat durch');
  return 'abgewiesen';
});

await pruefe('Die Ablage anderer zeigt die private Datei nicht', async () => {
  const meine = await (await fetch(`${S}/api/files`, {
    headers: { authorization: `Bearer ${leitung.token}` },
  })).json();
  const fremde = await (await fetch(`${S}/api/files`, {
    headers: { authorization: `Bearer ${fremdeKonto.token}` },
  })).json();
  muss(meine.files.some((f) => f.id === privatDateiId), 'die eigene private Datei fehlt in der eigenen Ablage');
  muss(!fremde.files.some((f) => f.id === privatDateiId), 'eine fremde private Datei steht in der Ablage');
  return `${meine.files.length} eigene, ${fremde.files.length} fremde`;
});

await pruefe('Private Dateien gehen am Blockspeicher vorbei', async () => {
  /* Privatsphäre vor Speicherplatz. Würde der Dateischlüssel aus dem Inhalt
     entstehen — der einzige Weg, verschlüsselt noch zusammenzulegen —, dann
     verriete das Zusammenlegen dem Server, ob er eine bestimmte Datei schon
     verwahrt: er müsste sie nur selbst verschlüsseln und die Blöcke
     vergleichen. */
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const bloecke = db.prepare(
    "SELECT COUNT(*) n FROM datei_bloecke WHERE art = 'file' AND datei_id = ?").get(privatDateiId);
  const anhangBloecke = db.prepare(
    "SELECT COUNT(*) n FROM datei_bloecke WHERE art = 'attachment' AND datei_id = ?").get(anhangId);
  db.close();
  muss(bloecke.n === 0, `${bloecke.n} Blöcke für eine private Datei`);
  muss(anhangBloecke.n === 0, `${anhangBloecke.n} Blöcke für einen verschlossenen Anhang`);
  muss(pfadVon(anhangId).sha256 === null, 'der Server führt eine Prüfsumme über das Chiffrat');
  return '0 Blöcke, keine Prüfsumme';
});

await pruefe('Auch privat geht nie inline hinaus', async () => {
  const antwort = await fetch(`${S}/storage/${privatDateiId}`, {
    headers: { authorization: `Bearer ${leitung.token}` },
  });
  muss(antwort.ok, `Abruf: ${antwort.status}`);
  muss(antwort.headers.get('content-type') === 'application/octet-stream',
    `Typ "${antwort.headers.get('content-type')}"`);
  muss(!/inline/.test(antwort.headers.get('content-disposition') ?? ''), 'ging inline hinaus');
  return 'als Anhang, nicht als Inhalt';
});

await pruefe('Eine fremde private Datei gibt der Server gar nicht erst heraus', async () => {
  /* Öffnen könnte sie ohnehin niemand. Sie herauszugeben hieße aber, ihre
     Existenz und ihre Größe zu bestätigen — und dafür gibt es keinen Grund. */
  const antwort = await fetch(`${S}/storage/${privatDateiId}`, {
    headers: { authorization: `Bearer ${fremdeKonto.token}` },
  });
  muss(antwort.status === 404, `Status ${antwort.status} statt 404`);
  return '404, wie bei einer, die es nicht gibt';
});

await pruefe('Der Wiederherstellungscode öffnet auch die privaten Dateien', async () => {
  /* Der Gerätewechsel. Der Schlüssel für private Dateien entsteht allein aus
     dem eigenen Schlüsselpaar — ein neues Gerät bekommt ihn also zurück, sobald
     der private Teil zurück ist, ohne dass je ein Dateischlüssel gesichert
     oder übertragen wurde. Genau das wird hier nachgestellt. */
  const codeRoh = zufallsCode(24);
  const jwk = JSON.stringify(await su.exportKey('jwk', chefin.privat));
  const key = await codeSchluessel(codeRoh, `stellium/wiederherstellung/${chefin.id}`);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const daten = await su.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(jwk));
  chefin.senden({
    t: 'vertraulich:schluessel-melden', jwk: chefin.oeffentlichJwk,
    abdruck: hex((await sha256('egal')).slice(0, 8)),
    sicherung: JSON.stringify({ iv: b64u(iv), daten: b64u(daten) }),
  });
  await chefin.frage({ t: 'ping', ts: Date.now() }, (e) => e.t === 'pong');

  /* Das neue Gerät. Es meldet bewusst keinen eigenen Schlüssel: eine zweite
     Meldung für dasselbe Konto wäre ein Schlüsselwechsel und würfe alle
     bestehenden Kanalpakete weg — richtig so, aber hier soll ja gerade der
     ALTE Schlüssel zurückkommen. Es fängt deshalb mit nichts an außer dem Code
     und dem, was der Server herausgibt. */
  const neuesGeraet = new App('Neues Gerät', leitung.token);
  chefin.senden({ t: 'vertraulich:sicherung-holen' });
  const ev = await chefin.warteAuf((e) => e.t === 'vertraulich:sicherung');
  muss(ev.paket, 'der Server gab keine Sicherung heraus');

  const { iv: iv2, daten: d2 } = JSON.parse(ev.paket);
  const key2 = await codeSchluessel(codeRoh, `stellium/wiederherstellung/${chefin.id}`);
  const jwkZurueck = dec.decode(await su.decrypt(
    { name: 'AES-GCM', iv: unb64u(iv2) }, key2, unb64u(d2)));
  neuesGeraet.privat = await su.importKey(
    'jwk', JSON.parse(jwkZurueck), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const { d: _d, key_ops: _ops, ...rest } = JSON.parse(jwkZurueck);
  neuesGeraet.oeffentlichJwk = JSON.stringify({ ...rest, ext: true });
  neuesGeraet.id = chefin.id;

  const roh = Buffer.from(await (await fetch(`${S}/storage/${privatDateiId}`, {
    headers: { authorization: `Bearer ${leitung.token}` },
  })).arrayBuffer());
  const { kopf, inhalt } = await neuesGeraet.dateiEntschluesseln(roh);
  muss(kopf.name === 'Gehaltszettel.pdf', `Name "${kopf.name}"`);
  muss(inhalt.equals(GEHEIMES_PAPIER), 'der Inhalt kam anders zurück');
  return `${kopf.name} wieder lesbar, ohne dass ein Dateischlüssel gesichert war`;
});

await pruefe('Ein fremdes Konto öffnet die private Datei nicht', async () => {
  const roh = fs.readFileSync(pfadVon(privatDateiId, 'files').path);
  let offen = false;
  try { await fremde.dateiEntschluesseln(roh); offen = true; } catch { /* so soll es sein */ }
  muss(!offen, 'ein fremdes Konto konnte die private Datei öffnen');
  // Und auch ein Mitglied desselben Kanals nicht — privat heißt privat.
  let ueberKanal = false;
  try { await kollege.dateiEntschluesseln(roh); ueberKanal = true; } catch { /* gut */ }
  muss(!ueberKanal, 'ein Kanalmitglied konnte die private Datei öffnen');
  return 'auch für Kolleginnen zu';
});

console.log('\nFreigabe nach einem Vorfall');

let freigabeId = null;
let code = null;

await pruefe('Vorfall melden erzeugt eine Freigabe und einen Code', async () => {
  // Die Leitung ist die Verwaltung: sie hat als Owner das Freigaberecht.
  await kollege.schluesselHolen([chefin.id]);
  const f = kollege.fassung.get(kanalId);
  const key = kollege.kanalKeys.get(`${kanalId}:${f}`);
  muss(key, 'kein Kanalschlüssel beim Melder');

  code = zufallsCode(3) + '-' + zufallsCode(3);
  const codeKey = await codeSchluessel(code.replace('-', ''), `stellium/freigabe/${kanalId}/${kollege.id}`);

  const innen = await kollege.packen(key, kollege.fremde.get(chefin.id), freigabeKontext(kanalId, f, kollege.id, chefin.id));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const daten = await su.encrypt({ name: 'AES-GCM', iv }, codeKey, enc.encode(JSON.stringify(innen)));

  const antwort = await kollege.frage({
    t: 'vertraulich:vorfall-melden', channelId: kanalId,
    grund: 'Beleidigung im Gespräch',
    codeAbdruck: hex(await sha256(code.replace('-', ''))),
    pakete: [{ userId: chefin.id, paket: { alg: 'ecdh-p256+aes-gcm', von: kollege.id, iv: b64u(iv), daten: b64u(daten) } }],
  }, (e) => e.t === 'vertraulich:freigabe');
  muss(antwort.t === 'vertraulich:freigabe', `bekam ${antwort.t}: ${antwort.message ?? ''}`);
  freigabeId = antwort.freigabe.id;
  muss(antwort.freigabe.grund === 'Beleidigung im Gespräch', 'der Grund kam nicht zurück');
  return `Code ${code}`;
});

await pruefe('Die Freigabe erzeugt eine sichtbare Systemnachricht', async () => {
  const ev = await chefin.warteAuf((e) =>
    e.t === 'message:new' && e.message.channelId === kanalId && e.message.systemKind === 'vertraulich.freigabe');
  muss(ev.message.text.includes('für die Verwaltung geöffnet'), `Text: "${ev.message.text}"`);
  muss(ev.message.text.includes('Beleidigung im Gespräch'), 'der Grund fehlt in der Meldung');
  return 'im Kanal sichtbar';
});

await pruefe('Der Code steht nicht in der Datenbank', async () => {
  const roh = fs.readFileSync(probe.datenbank);
  muss(!roh.includes(Buffer.from(code, 'utf8')), 'der Code steht im Klartext in der Datei');
  muss(!roh.includes(Buffer.from(code.replace('-', ''), 'utf8')), 'der Code steht ohne Bindestrich in der Datei');
  return 'nur sein Abdruck';
});

await pruefe('Mit falschem Code gibt der Server nichts heraus', async () => {
  const antwort = await chefin.frage({
    t: 'vertraulich:freigabe-oeffnen', freigabeId,
    codeAbdruck: hex(await sha256('XXXXXX')),
  }, (e) => e.t === 'vertraulich:freigabe-schluessel');
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.message.slice(0, 40);
});

await pruefe('Mit richtigem Code liest die Verwaltung mit', async () => {
  const antwort = await chefin.frage({
    t: 'vertraulich:freigabe-oeffnen', freigabeId,
    codeAbdruck: hex(await sha256(code.replace('-', ''))),
  }, (e) => e.t === 'vertraulich:freigabe-schluessel');
  muss(antwort.t === 'vertraulich:freigabe-schluessel', `bekam ${antwort.t}: ${antwort.message ?? ''}`);

  const { channelId, fassung, paket } = antwort.schluessel;
  const codeKey = await codeSchluessel(code.replace('-', ''), `stellium/freigabe/${channelId}/${paket.von}`);
  const innenText = dec.decode(await su.decrypt({ name: 'AES-GCM', iv: unb64u(paket.iv) }, codeKey, unb64u(paket.daten)));
  const innen = JSON.parse(innenText);
  const key = await chefin.auspacken(innen, freigabeKontext(channelId, fassung, innen.von, chefin.id));

  // Und damit die Nachricht lesen, um die es geht.
  const teile = nachrichtChiffrat.slice(3).split(':');
  const klar = dec.decode(await su.decrypt({ name: 'AES-GCM', iv: unb64u(teile[1]) }, key, unb64u(teile[2])));
  muss(klar === GEHEIM, `entschlüsselt zu "${klar}"`);
  return 'Klartext stimmt';
});

await pruefe('Das Einlösen ist ebenfalls im Kanal zu sehen', async () => {
  const ev = await chefin.warteAuf((e) =>
    e.t === 'message:new' && e.message.channelId === kanalId && e.message.systemKind === 'vertraulich.eingeloest');
  muss(ev.message.text.includes('eingelöst'), `Text: "${ev.message.text}"`);
  return 'im Kanal sichtbar';
});

await pruefe('Eine zurückgenommene Freigabe gibt nichts mehr heraus', async () => {
  const weg = await kollege.frage(
    { t: 'vertraulich:freigabe-zuruecknehmen', freigabeId },
    (e) => e.t === 'vertraulich:freigabe' && e.freigabe.zurueckgenommenAm,
  );
  muss(weg.t === 'vertraulich:freigabe', `bekam ${weg.t}: ${weg.message ?? ''}`);

  const antwort = await chefin.frage({
    t: 'vertraulich:freigabe-oeffnen', freigabeId,
    codeAbdruck: hex(await sha256(code.replace('-', ''))),
  }, (e) => e.t === 'vertraulich:freigabe-schluessel');
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.message.slice(0, 30);
});

await pruefe('Fremde können keine Freigabe für sich erzeugen', async () => {
  const antwort = await fremde.frage({
    t: 'vertraulich:vorfall-melden', channelId: kanalId, grund: 'neugierig',
    codeAbdruck: hex(await sha256('AAAAAA')), pakete: [],
  }, (e) => e.t === 'vertraulich:freigabe');
  muss(antwort.t === 'error', `bekam ${antwort.t} statt einer Abweisung`);
  return antwort.message.slice(0, 40);
});

console.log('\nSchlüsselwechsel');

await pruefe('Wer entfernt wird, löst einen Wechsel aus', async () => {
  chefin.senden({ t: 'channel:members', channelId: kanalId, remove: [kollege.id] });
  const ev = await chefin.warteAuf((e) => e.t === 'vertraulich:wechsel-noetig' && e.channelId === kanalId);
  muss(ev.grund, 'kein Grund mitgeschickt');
  return ev.grund;
});

await pruefe('Nach dem Wechsel gilt eine neue Fassung', async () => {
  await chefin.schluesselHolen([chefin.id]);
  const neu = await su.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const paket = await chefin.packen(neu, chefin.fremde.get(chefin.id), paketKontext(kanalId, 2, chefin.id, chefin.id));
  chefin.kanalKeys.set(`${kanalId}:2`, neu);
  chefin.fassung.set(kanalId, 2);
  chefin.senden({ t: 'vertraulich:wechseln', channelId: kanalId, pakete: [{ userId: chefin.id, paket }] });
  const ev = await chefin.warteAuf((e) => e.t === 'vertraulich:paket' && e.channelId === kanalId && e.fassung === 2);
  muss(ev.fassung === 2, `Fassung ${ev.fassung}`);

  // Die neue Nachricht darf die entfernte Person nicht mehr lesen.
  const chiffrat = await chefin.verschluesseln(kanalId, 'Nur noch für die Leitung');
  muss(chiffrat.startsWith('e1:2:'), `Nutzlast "${chiffrat.slice(0, 8)}"`);
  const kannNoch = await kollege.entschluesseln(kanalId, chiffrat);
  muss(kannNoch === null, `die entfernte Person liest weiter: "${kannNoch}"`);
  return 'Fassung 2, alte Schlüssel greifen nicht mehr';
});

chefin.zu(); kollege.zu(); fremde.zu();
await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
