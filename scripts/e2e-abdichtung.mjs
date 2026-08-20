/**
 * Die Stellen, an denen die Zusagen undicht waren.
 *
 * Zwei Zusagen stehen hier auf dem Prüfstand, und beide wurden gebrochen,
 * bevor diese Datei entstand:
 *
 *   „Wer keinen Zugang mehr hat, kommt nicht mehr herein."
 *      Ein gesperrtes Konto arbeitete mit seinem alten Token weiter — die
 *      Anmeldung war zu, jeder andere Weg offen. Ein gelöschtes Konto kam über
 *      HTTP weiter durch. Ein Passwortwechsel nach einem Diebstahl änderte am
 *      gestohlenen Token nichts, dreißig Tage lang.
 *
 *   „In einem vertraulichen Kanal liegt nur Chiffrat."
 *      Für Nachrichten, Anhänge, Umfragen, Entwürfe und Sprachnachrichten
 *      stimmte das. Die Team-Ablage nahm daneben eine Datei im Klartext
 *      entgegen, legte sie in den Blockspeicher und trug Name, Typ und
 *      Beschreibung offen in die Tabelle — der Klartext lag danach byteweise
 *      im Datenverzeichnis.
 *
 * Der Maßstab ist derselbe wie in e2e-vertraulich.mjs: gemessen wird nicht an
 * einer Antwort des Servers, sondern dort, wo die Bytes wirklich liegen. Das
 * ganze Datenverzeichnis wird durchsucht, und zwar auf einem Server ohne
 * Masterpasswort — was dort nicht lesbar ist, ist wirklich nicht lesbar.
 *
 * Die Verschlüsselung ist hier noch einmal ausgeschrieben statt aus
 * packages/desktop/src/lib/vertraulich.ts eingebunden. Eine Prüfung, die
 * dieselbe Rechnung wie der Prüfling benutzt, prüft nur, dass er mit sich
 * selbst einig ist.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

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
const su = globalThis.crypto.subtle;
const b64u = (d) => Buffer.from(d instanceof Uint8Array ? d : new Uint8Array(d)).toString('base64url');
const sha256 = async (t) => new Uint8Array(await su.digest('SHA-256', typeof t === 'string' ? enc.encode(t) : t));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const paketKontext = (ch, f, von, fuer) => `stellium/kanal/${ch}/${f}/${von}>${fuer}`;
const STUECK = 4 * 1024 * 1024;

/* ── Eine App ─────────────────────────────────────────────────── */

class App {
  constructor(name, token) {
    this.name = name; this.token = token;
    this.ereignisse = []; this.horcher = new Set();
    this.fremde = new Map(); this.kanalKeys = new Map(); this.fassung = new Map();
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
        if (ev.t === 'vertraulich:schluessel') for (const s of ev.schluessel) this.fremde.set(s.userId, s.jwk);
        if (ev.t === 'ready') this.id = ev.self.id;
        for (const h of this.horcher) h(ev);
        if (ev.t === 'ready') { clearTimeout(timer); fertig(); }
        /* Eine Abweisung schon beim Ausweisen heißt: diese Leitung kommt nicht
           zustande. Ohne diesen Zweig liefe die Prüfung in die Zeitüberschreitung
           und meldete „keine Verbindung" statt „abgewiesen". */
        if (ev.t === 'error' && !this.id) { clearTimeout(timer); schief(new Error(ev.code ?? 'abgewiesen')); }
      };
      this.ws.onerror = () => { clearTimeout(timer); schief(new Error(`${this.name}: Verbindungsfehler`)); };
    });
    return this;
  }

  senden(ev) { this.ws.send(JSON.stringify(ev)); }

  warteAuf(passt, ms = 8000) {
    const schon = this.ereignisse.find(passt);
    if (schon) return Promise.resolve(schon);
    return new Promise((fertig) => {
      const timer = setTimeout(() => { this.horcher.delete(h); fertig({ t: 'zeitueberschreitung' }); }, ms);
      const h = (ev) => { if (!passt(ev)) return; clearTimeout(timer); this.horcher.delete(h); fertig(ev); };
      this.horcher.add(h);
    });
  }

  /** Ein Ereignis schicken und nur auf Antworten danach hören. */
  frage(ev, passt, ms = 8000) {
    const ab = this.ereignisse.length;
    this.senden(ev);
    return this.warteAuf((e) => this.ereignisse.indexOf(e) >= ab && (passt(e) || e.t === 'error'), ms);
  }

  async schluesselHolen(ids) {
    const fehlend = ids.filter((i) => !this.fremde.has(i));
    if (!fehlend.length) return;
    await this.frage({ t: 'vertraulich:schluessel-holen', userIds: fehlend },
      (e) => e.t === 'vertraulich:schluessel');
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
    return {
      alg: 'ecdh-p256+aes-gcm', von: this.id, iv: b64u(iv),
      daten: b64u(await su.encrypt({ name: 'AES-GCM', iv }, huelle, roh)),
    };
  }

  /** Den öffentlichen Teil hinterlegen — sonst kann niemand für uns verpacken. */
  async schluesselMelden() {
    const roh = JSON.parse(this.oeffentlichJwk);
    const abdruck = hex((await sha256(`${roh.x}|${roh.y}`)).slice(0, 8)).toUpperCase();
    await this.frage({ t: 'vertraulich:schluessel-melden', jwk: this.oeffentlichJwk, abdruck },
      (e) => e.t === 'vertraulich:schluessel');
    return this;
  }

  async kanalVertraulich(channelId, mitgliedIds) {
    await this.schluesselHolen(mitgliedIds);
    const key = await su.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const pakete = [];
    for (const uid of mitgliedIds) {
      pakete.push({
        userId: uid,
        paket: await this.packen(key, this.fremde.get(uid), paketKontext(channelId, 1, this.id, uid)),
      });
    }
    this.kanalKeys.set(`${channelId}:1`, key);
    this.fassung.set(channelId, 1);
    const antwort = await this.frage({ t: 'vertraulich:einschalten', channelId, pakete },
      (e) => e.t === 'channel:upsert' && e.channel.id === channelId && e.channel.vertraulich);
    if (antwort.t === 'error') throw new Error(antwort.message);
  }

  huelleSchluessel(huelle) {
    if (huelle.art === 'konto') return this.gemeinsam(this.oeffentlichJwk, `stellium/datei/konto/${this.id}`);
    const key = this.kanalKeys.get(`${huelle.channelId}:${huelle.fassung}`);
    if (!key) throw new Error('kein Kanalschlüssel für diese Hülle');
    return Promise.resolve(key);
  }

  /** Eine Datei verschließen — Zufallsschlüssel, verpackt mit der Hülle. */
  async dateiVerschluesseln(inhalt, name, mime, huelle) {
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
  }

  zu() { try { this.ws.close(); } catch { /* schon zu */ } }
}

/* ── Konten ───────────────────────────────────────────────────── */

const marke = Date.now().toString(36).slice(-5);
const anmelden = async (login, passwort) =>
  (await (await fetch(`${S}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: passwort }),
  })).json());

const leitung = await anmelden(probe.login, probe.passwort);
const leitungKopf = { authorization: `Bearer ${leitung.token}` };

async function kontoAnlegen(name, role = 'member') {
  const neu = await (await fetch(`${S}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...leitungKopf },
    body: JSON.stringify({ displayName: `${name} ${marke}`, handle: `${name}${marke}`, role, language: 'de' }),
  })).json();
  const passwort = `Passwort-${name}-${marke}`;
  const erste = await anmelden(neu.credential.handle, neu.credential.oneTimePassword);
  const einrichtung = await fetch(`${S}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${erste.token}` },
    body: JSON.stringify({ newPassword: passwort }),
  });
  const sitzung = await anmelden(neu.credential.handle, passwort);
  return {
    token: sitzung.token, id: neu.credential.userId, handle: neu.credential.handle,
    passwort, einrichtungStatus: einrichtung.status, einrichtungToken: erste.token,
  };
}

/** Der übliche Nachweis, ob ein Token noch trägt: ein gewöhnlicher Abruf. */
const httpMitToken = (token, pfad = '/api/permissions') =>
  fetch(`${S}${pfad}`, { headers: { authorization: `Bearer ${token}` } });

/** Kommt eine frische Leitung mit diesem Token zustande? */
async function wsTraegt(token) {
  try { const app = await new App('probe', token).verbinden(); app.zu(); return true; }
  catch { return false; }
}

/** Byteweise durch das ganze Datenverzeichnis. */
function imDatenordner(nadel) {
  const treffer = [];
  const gehe = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { gehe(p); continue; }
      try { if (fs.readFileSync(p).includes(nadel)) treffer.push(p); } catch { /* gerade in Arbeit */ }
    }
  };
  gehe(probe.datenordner);
  return treffer;
}

const inAblage = async (token, bytes, name, felder = {}) => {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
  for (const [k, v] of Object.entries(felder)) form.append(k, v);
  const antwort = await fetch(`${S}/api/files`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  });
  const daten = await antwort.json().catch(() => ({}));
  return { status: antwort.status, ...daten };
};

/* ── Sitzungen ────────────────────────────────────────────────── */

console.log('\nWer keinen Zugang mehr hat');

await pruefe('Die Ersteinrichtung entwertet ihr eigenes Token nicht', async () => {
  /* Die Gegenprobe zu allem Folgenden. Ein Passwortwechsel entwertet ältere
     Token — die Ersteinrichtung setzt aber ein Passwort mit genau dem Token in
     der Hand, das sie sonst selbst wegwürfe. Wer beides zusammenlegt, sperrt
     jeden neuen Kollegen mitten in seiner Einrichtung aus. */
  const frisch = await kontoAnlegen('frisch');
  muss(frisch.einrichtungStatus === 200, `Einrichtung gab ${frisch.einrichtungStatus}`);
  muss((await httpMitToken(frisch.einrichtungToken)).status === 200,
    'das Token der Einrichtung war danach wertlos');
  muss(frisch.token, 'die Anmeldung mit dem neuen Passwort ging nicht');
  return 'Einrichtung läuft durch';
});

await pruefe('Ein gesperrtes Konto kommt über HTTP nicht mehr herein', async () => {
  const opfer = await kontoAnlegen('gesperrt');
  muss((await httpMitToken(opfer.token)).status === 200, 'vor der Sperrung kam es nicht durch');

  const gesperrt = await fetch(`${S}/api/admin/users/${opfer.id}/disabled`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...leitungKopf },
    body: JSON.stringify({ disabled: true }),
  });
  muss(gesperrt.status === 200, `Sperren gab ${gesperrt.status}`);

  const nachher = await httpMitToken(opfer.token);
  muss(nachher.status === 401, `mit dem alten Token noch ${nachher.status}`);
  probe.gesperrt = opfer;
  return '401 statt 200';
});

await pruefe('Ein gesperrtes Konto kommt auch über die Ereignisleitung nicht mehr herein', async () => {
  muss(!(await wsTraegt(probe.gesperrt.token)), 'die Leitung kam zustande');
});

await pruefe('Die schon offene Leitung eines gesperrten Kontos fällt sofort', async () => {
  /* Der eigentliche Grund, warum die Prüfung in `verifyToken` allein nicht
     genügt: eine WebSocket-Leitung weist sich einmal aus und trägt ihre
     Kennung danach in der Sitzung. Ohne einen Ruf beim Sperren läse das
     Konto weiter mit, solange es die Leitung offen hält. */
  const opfer = await kontoAnlegen('offen');
  const app = await new App('offen', opfer.token).verbinden();
  const gefallen = app.warteAuf((e) => e.t === 'error', 6000);
  await fetch(`${S}/api/admin/users/${opfer.id}/disabled`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...leitungKopf },
    body: JSON.stringify({ disabled: true }),
  });
  const ev = await gefallen;
  app.zu();
  muss(ev.t === 'error', 'die offene Leitung lief weiter');
  return ev.code ?? ev.t;
});

await pruefe('Entsperren bringt den Zugang zurück', async () => {
  // Eine Sperre, die man nicht mehr lösen kann, wäre die schlechtere Antwort.
  await fetch(`${S}/api/admin/users/${probe.gesperrt.id}/disabled`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...leitungKopf },
    body: JSON.stringify({ disabled: false }),
  });
  const wieder = await anmelden(probe.gesperrt.handle, probe.gesperrt.passwort);
  muss(wieder.token, `Anmeldung: ${wieder.error}`);
  muss((await httpMitToken(wieder.token)).status === 200, 'das neue Token trägt nicht');
});

await pruefe('Ein gelöschtes Konto kommt über HTTP nicht mehr herein', async () => {
  /* Über die Ereignisleitung war das schon zu — geprüft in e2e-sicherheit.mjs.
     Die HTTP-Wege prüften den Kontostand gar nicht: `requireUser` sah nur die
     Unterschrift an. Damit blieb der Download jeder Datei offen, an die das
     Konto vorher herankam. */
  const weg = await kontoAnlegen('geloescht');
  muss((await httpMitToken(weg.token)).status === 200, 'vor dem Löschen kam es nicht durch');
  const gelöscht = await fetch(`${S}/api/admin/users/${weg.id}`, { method: 'DELETE', headers: leitungKopf });
  muss(gelöscht.status === 200, `Löschen gab ${gelöscht.status}`);
  const nachher = await httpMitToken(weg.token);
  muss(nachher.status === 401, `mit dem alten Token noch ${nachher.status}`);
  return '401 statt 200';
});

await pruefe('Nach einem Passwortwechsel ist das alte Token wertlos', async () => {
  const konto = await kontoAnlegen('wechsel');
  const alt = konto.token;
  const gewechselt = await fetch(`${S}/api/auth/password`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alt}` },
    body: JSON.stringify({ current: konto.passwort, next: `Ganz-Neues-Passwort-${marke}` }),
  });
  muss(gewechselt.status === 200, `Wechsel gab ${gewechselt.status}`);

  const http = await httpMitToken(alt);
  muss(http.status === 401, `das alte Token gilt über HTTP noch (${http.status})`);
  muss(!(await wsTraegt(alt)), 'das alte Token trägt noch eine Leitung');

  const neu = await anmelden(konto.handle, `Ganz-Neues-Passwort-${marke}`);
  muss(neu.token && (await httpMitToken(neu.token)).status === 200, 'das neue Token trägt nicht');
  return 'HTTP und Leitung beide zu';
});

await pruefe('Die Antwortzeit verrät nicht, ob es den Benutzernamen gibt', async () => {
  /* Die Anmeldung prüft auch bei unbekanntem Konto ein Passwort, damit beide
     Fälle gleich lange dauern. Der Platzhalter dafür war aber unbrauchbar —
     ein „$" zu viel am Anfang, und verifyPassword() brach vor dem scrypt ab.
     Gemessen: 1,2 ms für einen erfundenen Namen gegen 29,8 ms für einen
     echten. Damit ließ sich die Namensliste des Hauses abfragen, ohne ein
     einziges Passwort zu erraten.

     Gemessen wird der Median über mehrere Versuche und mit reichlich Abstand
     zur Schwelle: eine Zeitmessung auf einem beschäftigten Rechner schwankt,
     ein Faktor von zwanzig tut es nicht. Die Bremse greift ab dem achten
     Fehlversuch je Name — deshalb sieben. */
  const messen = async (login) => {
    const proben = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const r = await fetch(`${S}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login, password: `falsch-${i}-${marke}` }),
      });
      if (r.status === 429) break;
      proben.push(performance.now() - t0);
      await new Promise((f) => setTimeout(f, 20));
    }
    proben.sort((a, b) => a - b);
    return proben[Math.floor(proben.length / 2)];
  };

  const echtes = await kontoAnlegen('zeitprobe');
  const unbekannt = await messen(`gibtesnicht-${marke}`);
  const bekannt = await messen(echtes.handle);

  muss(unbekannt > 5,
    `ein unbekanntes Konto kostet nur ${unbekannt.toFixed(1)} ms — es wird gar nichts gerechnet`);
  const verhaeltnis = Math.max(bekannt, unbekannt) / Math.min(bekannt, unbekannt);
  muss(verhaeltnis < 3,
    `${bekannt.toFixed(1)} ms für ein echtes Konto gegen ${unbekannt.toFixed(1)} ms für ein erfundenes (${verhaeltnis.toFixed(1)}×)`);
  return `${unbekannt.toFixed(0)} ms zu ${bekannt.toFixed(0)} ms (${verhaeltnis.toFixed(1)}×)`;
});

await pruefe('Nach einem Zurücksetzen durch die Verwaltung ebenso', async () => {
  const konto = await kontoAnlegen('zurueck');
  const alt = konto.token;
  const zurueck = await fetch(`${S}/api/admin/users/${konto.id}/reset-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...leitungKopf }, body: '{}',
  });
  muss(zurueck.status === 200, `Zurücksetzen gab ${zurueck.status}`);
  const http = await httpMitToken(alt);
  muss(http.status === 401, `das alte Token gilt noch (${http.status})`);
});

/* ── Die Ablage in einem vertraulichen Kanal ──────────────────── */

console.log('\nDie Ablage als Weg in einen vertraulichen Kanal');

const chefinKonto = { token: leitung.token, id: null };
const chefin = await new App('Leitung', leitung.token).verbinden();
chefinKonto.id = chefin.id;
await chefin.schluesselMelden();

const mitgliedKonto = await kontoAnlegen('mitglied');
const fremdeKonto = await kontoAnlegen('fremde');
const kollege = await (await new App('Mitglied', mitgliedKonto.token).verbinden()).schluesselMelden();
const fremde = await (await new App('Fremde', fremdeKonto.token).verbinden()).schluesselMelden();

const kanalAnlegen = async (name, mitgliedIds = []) => {
  const ev = await chefin.frage({ t: 'channel:create', kind: 'private', name, memberIds: mitgliedIds },
    (e) => e.t === 'channel:upsert' && e.channel.name === name);
  if (ev.t === 'error') throw new Error(ev.message);
  return ev.channel.id;
};

const kanalId = await kanalAnlegen(`abdicht-${marke}`, [kollege.id]);
const zweiterKanal = await kanalAnlegen(`abdicht-zwei-${marke}`, [kollege.id]);
await chefin.kanalVertraulich(kanalId, [chefin.id, kollege.id]);
await chefin.kanalVertraulich(zweiterKanal, [chefin.id, kollege.id]);

const GEHEIM = `BONUSLISTE-${marke}: Standort Nord wird zum Quartalsende geschlossen.`;
const GEHEIMES_PAPIER = Buffer.concat([
  Buffer.from(GEHEIM, 'utf8'),
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(2048))),
]);

await pruefe('Eine Klartextdatei weist der vertrauliche Kanal ab', async () => {
  const antwort = await inAblage(leitung.token, GEHEIMES_PAPIER, 'Bonusliste.txt', { channelId: kanalId });
  muss(antwort.status !== 200, `der Server nahm sie an (${antwort.status})`);
  muss(antwort.code === 'fehler.dateiVertraulichNoetig', `Kennung "${antwort.code}"`);
  return `${antwort.status} / ${antwort.code}`;
});

await pruefe('Und danach liegt der Klartext nirgends im Datenverzeichnis', async () => {
  /* Der schärfere Teil derselben Prüfung. Eine Abweisung mit einer Datei, die
     trotzdem liegen bleibt, wäre keine — abgewiesen wird erst nach dem
     Schreiben auf die Platte, und der Blockspeicher lief bis eben mit. */
  await new Promise((f) => setTimeout(f, 1200));
  const treffer = imDatenordner(Buffer.from(GEHEIM, 'utf8'));
  muss(treffer.length === 0, `Klartext liegt in ${treffer.map((p) => path.basename(p)).join(', ')}`);
  return 'nichts gefunden';
});

let kanalDateiId = null;

await pruefe('Eine für den Kanal verschlossene Datei kommt an', async () => {
  const zu = await chefin.dateiVerschluesseln(
    GEHEIMES_PAPIER, 'Bonusliste.txt', 'text/plain',
    { art: 'kanal', channelId: kanalId, fassung: 1 },
  );
  const antwort = await inAblage(leitung.token, zu, 'verschlossen', { channelId: kanalId });
  muss(antwort.status === 200, `abgewiesen: ${antwort.error ?? antwort.status}`);
  kanalDateiId = antwort.file.id;
  muss(antwort.file.mime === 'application/octet-stream',
    `der Server behauptet den Typ "${antwort.file.mime}" über Bytes, die er nicht lesen kann`);
  return `angenommen als ${antwort.file.mime}`;
});

await pruefe('Auch von ihr liegt kein Klartext auf der Platte', async () => {
  await new Promise((f) => setTimeout(f, 1200));
  const treffer = imDatenordner(Buffer.from(GEHEIM, 'utf8'));
  muss(treffer.length === 0, `Klartext liegt in ${treffer.map((p) => path.basename(p)).join(', ')}`);
  return 'nichts gefunden';
});

await pruefe('Sie geht am Blockspeicher vorbei', async () => {
  /* Aus demselben Grund wie eine private Datei: legte der Server gleiche Bytes
     zusammen, verriete ihm genau diese Ersparnis, was er verwahrt. Bisher hing
     das an `privat` — eine für den Kanal verschlossene Datei ist nicht privat
     und wäre glatt hindurchgelaufen. */
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const bloecke = db.prepare(
    "SELECT COUNT(*) n FROM datei_bloecke WHERE art = 'file' AND datei_id = ?").get(kanalDateiId);
  db.close();
  muss(bloecke.n === 0, `${bloecke.n} Blöcke`);
  return '0 Blöcke';
});

await pruefe('Ihre Mitglieder sehen sie im Verzeichnis', async () => {
  /* Die Gegenprobe zur Abdichtung: verschlossen heißt nicht unsichtbar. Wäre
     sie wie eine private Datei behandelt worden, stünde sie nur beim
     Hochladenden — und die Ablage eines vertraulichen Kanals wäre für alle
     anderen leer. */
  const beim = await (await fetch(`${S}/api/files?channelId=${kanalId}`, {
    headers: { authorization: `Bearer ${mitgliedKonto.token}` },
  })).json();
  muss(beim.files.some((f) => f.id === kanalDateiId), 'das Mitglied sieht sie nicht');
  return `${beim.files.length} Eintrag im Kanal`;
});

await pruefe('Sie geht nie inline hinaus', async () => {
  const antwort = await fetch(`${S}/storage/${kanalDateiId}`, { headers: leitungKopf });
  muss(antwort.ok, `Abruf: ${antwort.status}`);
  muss(antwort.headers.get('content-type') === 'application/octet-stream',
    `Typ "${antwort.headers.get('content-type')}"`);
  muss(!/inline/.test(antwort.headers.get('content-disposition') ?? ''), 'ging inline hinaus');
});

await pruefe('Eine Datei mit der Hülle eines anderen Kanals wird abgewiesen', async () => {
  /* Lesen könnte sie dort niemand — liegen hätte sie aber ein Kreis, der nie
     gemeint war. Dieselbe Regel wie für Anhänge in services/messages.ts. */
  const zu = await chefin.dateiVerschluesseln(
    GEHEIMES_PAPIER, 'falsch.txt', 'text/plain',
    { art: 'kanal', channelId: zweiterKanal, fassung: 1 },
  );
  const antwort = await inAblage(leitung.token, zu, 'verschlossen', { channelId: kanalId });
  muss(antwort.status !== 200, `der Server nahm sie an (${antwort.status})`);
  muss(antwort.code === 'fehler.dateiAndererKreis', `Kennung "${antwort.code}"`);
  return antwort.code;
});

await pruefe('Ein Kanalschlüssel in einem offenen Kanal wird ebenso abgewiesen', async () => {
  const offen = await chefin.frage({ t: 'channel:create', kind: 'private', name: `offen-${marke}` },
    (e) => e.t === 'channel:upsert' && e.channel.name === `offen-${marke}`);
  const zu = await chefin.dateiVerschluesseln(
    GEHEIMES_PAPIER, 'falsch.txt', 'text/plain',
    { art: 'kanal', channelId: kanalId, fassung: 1 },
  );
  const antwort = await inAblage(leitung.token, zu, 'verschlossen', { channelId: offen.channel.id });
  muss(antwort.status !== 200, `der Server nahm sie an (${antwort.status})`);
  return antwort.code;
});

/* ── Wer wo ablegen und nachsehen darf ────────────────────────── */

console.log('\nOhne Kanalzugang keine Ablage');

await pruefe('In einen fremden Kanal lässt sich nichts ablegen', async () => {
  const antwort = await inAblage(fremdeKonto.token, Buffer.from('eindringling'), 'eindringling.txt',
    { channelId: kanalId });
  muss(antwort.status !== 200, `der Server nahm sie an (${antwort.status})`);
  muss(antwort.code === 'fehler.dateiKanalFremd', `Kennung "${antwort.code}"`);
  return antwort.code;
});

await pruefe('Das Verzeichnis eines fremden Kanals bleibt über HTTP leer', async () => {
  /* Der Abruf war offen für jede Kennung: Name, Beschreibung, Größe und
     Urheber jeder Datei eines fremden Kanals. Die Bytes gab /storage/:id zwar
     nicht heraus — "Kündigung Meier.pdf, Entwurf für Herrn Meier" braucht die
     Bytes aber nicht mehr. */
  const liste = await (await fetch(`${S}/api/files?channelId=${kanalId}`, {
    headers: { authorization: `Bearer ${fremdeKonto.token}` },
  })).json();
  muss(Array.isArray(liste.files), 'keine Liste gekommen');
  muss(liste.files.length === 0,
    `${liste.files.length} Einträge: ${liste.files.map((f) => f.name).join(', ')}`);
  return 'leer';
});

await pruefe('Und über die Ereignisleitung ebenso', async () => {
  const ev = await fremde.frage({ t: 'file:list', channelId: kanalId }, (e) => e.t === 'file:list');
  muss(ev.t === 'file:list', `bekam ${ev.t}`);
  muss(ev.files.length === 0,
    `${ev.files.length} Einträge: ${ev.files.map((f) => f.name).join(', ')}`);
  return 'leer';
});

await pruefe('Auch die ungefilterte Ablage zeigt keine fremde Kanaldatei', async () => {
  /* Sonst wäre der Aufruf ohne Filter der bequemere Weg an der Prüfung vorbei. */
  const liste = await (await fetch(`${S}/api/files`, {
    headers: { authorization: `Bearer ${fremdeKonto.token}` },
  })).json();
  muss(!liste.files.some((f) => f.id === kanalDateiId), 'die Kanaldatei steht in der Ablage der Fremden');
  const eigene = await (await fetch(`${S}/api/files`, {
    headers: { authorization: `Bearer ${mitgliedKonto.token}` },
  })).json();
  muss(eigene.files.some((f) => f.id === kanalDateiId), 'dem Mitglied fehlt sie in der eigenen Ablage');
  return 'für Mitglieder da, für Fremde nicht';
});

/* ── Rechte und Freigaben ─────────────────────────────────────── */

console.log('\nRechte und Freigaben');

await pruefe('Ein ownerOnly-Recht vergibt nur der Inhaber', async () => {
  /* Die Oberfläche sperrt diese drei Rechte für alle außer den Owner — der
     Server tat es nicht. Solange nur der Owner „Rechte vergeben" hat, fällt
     das nicht auf; gibt er es einmal weiter, gilt plötzlich die Beschriftung
     statt der Regel, und wer es hat, holt sich damit auch das Lesen fremder
     Freigaben. */
  const stellvertretung = await kontoAnlegen('stellv', 'admin');
  await fetch(`${S}/api/admin/users/${stellvertretung.id}/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...leitungKopf },
    body: JSON.stringify({ permission: 'permission.manage', allowed: true }),
  });
  const rechte = await (await httpMitToken(stellvertretung.token, '/api/permissions')).json();
  void rechte;

  const opfer = await kontoAnlegen('empfaenger');
  const versuch = await fetch(`${S}/api/admin/users/${opfer.id}/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${stellvertretung.token}` },
    body: JSON.stringify({ permission: 'user.delete', allowed: true }),
  });
  muss(versuch.status !== 200, 'ein Nicht-Inhaber durfte ein ownerOnly-Recht vergeben');
  const antwort = await versuch.json().catch(() => ({}));
  muss(antwort.code === 'fehler.nurOwnerRecht', `Kennung "${antwort.code}"`);

  // Gegenprobe: der Inhaber darf es, und ein gewöhnliches Recht bleibt offen.
  const gewoehnlich = await fetch(`${S}/api/admin/users/${opfer.id}/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${stellvertretung.token}` },
    body: JSON.stringify({ permission: 'message.pin', allowed: false }),
  });
  muss(gewoehnlich.status === 200, `ein gewöhnliches Recht wurde mitgesperrt (${gewoehnlich.status})`);
  return `${versuch.status} für ownerOnly, 200 für den Rest`;
});

await pruefe('Beim Einschalten wird für Nichtmitglieder nichts verpackt', async () => {
  /* paketeNachreichen() und wechseln() filtern auf Mitglieder, einschalten()
     tat es als einziges nicht. Ein Paket für ein Konto außerhalb des Kanals
     ließe sich zwar nirgends abholen — es stünde aber in der Buchhaltung als
     versorgt und machte die Auskunft falsch, wer diesen Kanal aufschließen
     kann. */
  const eigener = await kanalAnlegen(`nurich-${marke}`);
  await chefin.schluesselHolen([fremde.id]);
  const key = await su.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const antwort = await chefin.frage({
    t: 'vertraulich:einschalten', channelId: eigener,
    pakete: [{
      userId: fremde.id,
      paket: await chefin.packen(key, chefin.fremde.get(fremde.id), paketKontext(eigener, 1, chefin.id, fremde.id)),
    }],
  }, (e) => e.t === 'channel:upsert' && e.channel.id === eigener && e.channel.vertraulich);
  muss(antwort.t !== 'error', antwort.message);

  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeilen = db.prepare('SELECT user_id FROM kanal_schluessel_pakete WHERE channel_id = ?').all(eigener);
  db.close();
  const fremdePakete = zeilen.filter((z) => z.user_id === fremde.id);
  muss(fremdePakete.length === 0, `${fremdePakete.length} Paket(e) für ein Nichtmitglied`);
  return `${zeilen.length} Pakete, keines für draußen`;
});

await pruefe('Eine unbekannte Freigabe verrät ohne Recht nichts über sich', async () => {
  /* Ohne das Recht darf die Antwort nicht davon abhängen, ob es die Kennung
     gibt — sonst ließe sich daran ablesen, in welchen Kanälen ein Vorfall
     gemeldet wurde. */
  const ev = await fremde.frage({ t: 'vertraulich:freigabe-oeffnen', freigabeId: 'fg_gibtesnicht', codeAbdruck: 'x' },
    (e) => e.t === 'vertraulich:freigabe-schluessel');
  muss(ev.t === 'error', `bekam ${ev.t}`);
  muss(/Verwaltung/.test(ev.message ?? ''), `Meldung verrät die Existenz: „${ev.message}"`);
  return 'Recht zuerst, dann die Freigabe';
});

chefin.zu(); kollege.zu(); fremde.zu();
await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
