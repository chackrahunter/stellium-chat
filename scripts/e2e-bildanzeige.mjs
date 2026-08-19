/**
 * Bilder im Chat: werden sie angezeigt — und bleiben sie Fremden verschlossen?
 *
 * Beide Hälften gehören in denselben Lauf, denn sie ziehen gegeneinander. Wer
 * nur die erste prüft, macht die Route irgendwann wieder auf; wer nur die
 * zweite prüft, merkt nicht, dass in der Oberfläche seit Wochen nur noch
 * kaputte Bildsymbole stehen. Genau das ist passiert: der Server verlangte
 * einen Nachweis, die App legte keinen bei, und niemand hat es gemessen.
 *
 * Deshalb reicht hier kein Statuscode. Geprüft wird, was der Browser aus der
 * Antwort macht — `naturalWidth` ist erst dann größer als null, wenn er das
 * Bild wirklich dekodiert hat. Ein 200er mit falschem Inhalt bestünde diese
 * Prüfung nicht.
 *
 * Braucht die Oberfläche unter http://localhost:5173 (`npm run dev`). Der
 * Server kommt aus dem Lauf selbst — eine frische Datenbank, damit das
 * Probekonto volle Rechte hat und niemandes Daten im Weg liegen.
 *
 *   node scripts/e2e-bildanzeige.mjs
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const ZIEL = process.env.STELLIUM_BILDER ?? 'schirmbilder';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/**
 * Ein echtes PNG bauen — kein Platzhalter.
 *
 * Der Server liest die Maße aus dem Kopf der Datei, und die Oberfläche stellt
 * sie als `width`/`height` in das Bild. Ein Behelfsbild ohne gültigen Kopf
 * würde genau den Weg auslassen, um den es hier geht.
 */
function png(breite, hoehe) {
  const crc = (bytes) => {
    let c = ~0;
    for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const stueck = (typ, daten) => {
    const laenge = Buffer.alloc(4); laenge.writeUInt32BE(daten.length);
    const rumpf = Buffer.concat([Buffer.from(typ, 'ascii'), daten]);
    const summe = Buffer.alloc(4); summe.writeUInt32BE(crc(rumpf));
    return Buffer.concat([laenge, rumpf, summe]);
  };
  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(breite, 0); kopf.writeUInt32BE(hoehe, 4);
  kopf[8] = 8; kopf[9] = 2;  // 8 Bit je Kanal, Echtfarben
  const zeilen = Buffer.concat(Array.from({ length: hoehe }, (_, y) => Buffer.concat([
    Buffer.from([0]),
    Buffer.concat(Array.from({ length: breite }, (_, x) => {
      // Ein weithin sichtbares Schachmuster: auf einem Schirmbild erkennt man
      // sofort, ob da ein Bild steht oder nur ein Rahmen.
      const hell = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 === 0;
      return hell ? Buffer.from([124, 92, 255]) : Buffer.from([34, 211, 238]);
    })),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    stueck('IHDR', kopf), stueck('IDAT', zlib.deflateSync(zeilen)), stueck('IEND', Buffer.alloc(0)),
  ]);
}

const probe = await probeserver();
const S = probe.S;
const meinKopf = { authorization: `Bearer ${probe.token}` };
const marke = Date.now().toString(36).slice(-5);

/* Der Probeserver muss weg, auch wenn mittendrin etwas platzt. Bleibt er
   liegen, hält er seinen Port besetzt — und weil der Port zufällig aus einem
   kleinen Bereich kommt, hält der nächste Lauf den Zombie für seinen eigenen
   Server und scheitert an einer Datenbank, die er nie gefüllt hat. Genau so
   ist dieser Lauf beim ersten Mal falsch fehlgeschlagen. */
let maschine = null;
process.on('uncaughtException', async (fehler) => {
  console.error(`\n✗ Abbruch: ${fehler.message}`);
  await maschine?.close().catch(() => {});
  await probe.stop();
  process.exit(1);
});
process.on('unhandledRejection', async (fehler) => {
  console.error(`\n✗ Abbruch: ${(fehler instanceof Error ? fehler.message : String(fehler))}`);
  await maschine?.close().catch(() => {});
  await probe.stop();
  process.exit(1);
});

/** Ein Ereignis über die WebSocket-Verbindung schicken und auf die Antwort warten. */
function ueberWs(token, ereignis, warteAuf, passt = null) {
  return new Promise((fertig, schief) => {
    const ws = new WebSocket(`${S.replace(/^http/, 'ws')}/ws`);
    const uhr = setTimeout(() => { ws.close(); schief(new Error('Zeitüberschreitung')); }, 15000);
    let bereit = false;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token, protocol: 1 }));
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.t === 'ready' && !bereit) { bereit = true; ws.send(JSON.stringify(ereignis)); return; }
      if (bereit && ev.t === warteAuf) {
        if (passt && !passt(ev)) return;
        clearTimeout(uhr); ws.close(); fertig(ev);
      }
      if (bereit && ev.t === 'error') { clearTimeout(uhr); ws.close(); fertig(ev); }
    };
    ws.onerror = () => { clearTimeout(uhr); schief(new Error('Verbindungsfehler')); };
  });
}

const anmelden = async (login, passwort) => (await (await fetch(`${S}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: passwort }),
})).json());

/* ── Eine zweite Person, die in nichts drin ist ───────────────── */

const neu = await (await fetch(`${S}/api/admin/users`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...meinKopf },
  body: JSON.stringify({ displayName: `Fremde ${marke}`, handle: `fremde${marke}`, role: 'member', language: 'de' }),
})).json();
const ersteAnmeldung = await anmelden(neu.credential.handle, neu.credential.oneTimePassword);
await fetch(`${S}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ersteAnmeldung.token}` },
  body: JSON.stringify({ newPassword: `Fremdes-Passwort-${marke}` }),
});
const fremde = await anmelden(neu.credential.handle, `Fremdes-Passwort-${marke}`);

/* ── Ein Bild in einem privaten Kanal ─────────────────────────── */

const bild = png(560, 360);
const summe = crypto.createHash('sha256').update(bild).digest('hex');

const form = new FormData();
form.append('file', new Blob([bild], { type: 'image/png' }), 'image.png');
const anhang = (await (await fetch(`${S}/api/uploads`, { method: 'POST', headers: meinKopf, body: form })).json()).attachment;

const kanal = await ueberWs(probe.token,
  { t: 'channel:create', kind: 'private', name: `bilder-${marke}` }, 'channel:upsert',
  (ev) => ev.channel?.name === `bilder-${marke}`);
const kanalId = kanal.channel?.id;
await ueberWs(probe.token, {
  t: 'message:send', clientId: `bild-${marke}`, channelId: kanalId,
  text: 'Ein Bild', attachmentIds: [anhang.id],
}, 'message:new');

console.log('\nAuslieferung');

await pruefe('Der Anhang trägt seine Maße', async () => {
  muss(anhang.width === 560 && anhang.height === 360, `${anhang.width}×${anhang.height}`);
  return `${anhang.width}×${anhang.height}`;
});

await pruefe('Mit Nachweis in der Adresse kommen dieselben Bytes zurück', async () => {
  const antwort = await fetch(`${S}${anhang.url}?token=${encodeURIComponent(probe.token)}`);
  muss(antwort.status === 200, `Status ${antwort.status}`);
  muss(antwort.headers.get('content-type') === 'image/png', `Inhaltstyp ${antwort.headers.get('content-type')}`);
  const zurueck = Buffer.from(await antwort.arrayBuffer());
  muss(crypto.createHash('sha256').update(zurueck).digest('hex') === summe, 'Inhalt weicht ab');
  return `${zurueck.length} Byte`;
});

await pruefe('Auch aus dem Blockspeicher entsteht wieder dasselbe Bild', async () => {
  // Der Upload legt die Datei in Blöcken ab; ohne Zusammensetzen käme hier
  // entweder ein 404 oder ein Strom, der mittendrin abbricht.
  const { DatabaseSync } = await import('node:sqlite');
  const nachsehen = () => {
    const db = new DatabaseSync(probe.datenbank, { readOnly: true });
    try {
      return {
        zeile: db.prepare('SELECT encoding FROM attachments WHERE id = ?').get(anhang.id),
        anzahl: db.prepare('SELECT COUNT(*) n FROM datei_bloecke WHERE art = ? AND datei_id = ?')
          .get('attachment', anhang.id).n,
      };
    } finally { db.close(); }
  };

  /* Die Zerlegung läuft hinter der Antwort her — bis sie durch ist, trägt die
     Zeile `uebernahme`. Ohne dieses Warten hinge die Prüfung daran, ob der
     Server zufällig schon fertig war, und wäre mal grün und mal rot. */
  const bis = Date.now() + 60_000;
  let stand = nachsehen();
  while (stand.zeile?.encoding === 'uebernahme' && Date.now() < bis) {
    await new Promise((f) => setTimeout(f, 100));
    stand = nachsehen();
  }

  muss(stand.zeile?.encoding === 'bloecke', `Ablage ist "${stand.zeile?.encoding}", nicht "bloecke"`);
  muss(stand.anzahl > 0, 'keine Blöcke eingetragen');
  return `${stand.anzahl} Block/Blöcke`;
});

console.log('\nAbsicherung');

await pruefe('Ohne Nachweis bleibt das Bild zu', async () => {
  const antwort = await fetch(`${S}${anhang.url}`);
  muss(antwort.status === 401, `Status ${antwort.status} statt 401`);
  return '401';
});

await pruefe('So, wie es eine alte App baute, bleibt es zu', async () => {
  /* Genau dieser Aufruf stand hinter den kaputten Bildsymbolen: die alte
     Fassung setzte nur Serveradresse und Pfad zusammen und legte keinen
     Nachweis bei. Der Fall gehört in die Prüfung, damit niemand ihn
     "repariert", indem er die Route wieder öffnet. */
  const antwort = await fetch(`${S}/files/${anhang.id}`);
  muss(antwort.status === 401, `Status ${antwort.status} statt 401`);
});

await pruefe('Mit erfundenem Nachweis bleibt das Bild zu', async () => {
  const antwort = await fetch(`${S}${anhang.url}?token=unsinn`);
  muss(antwort.status === 401, `Status ${antwort.status} statt 401`);
});

await pruefe('Ohne Zugang zum Kanal bekommt auch ein angemeldetes Konto nichts', async () => {
  const antwort = await fetch(`${S}${anhang.url}?token=${encodeURIComponent(fremde.token)}`);
  // 404 und nicht 403: sonst verriete schon der Unterschied, dass es die Datei gibt.
  muss(antwort.status === 404, `Status ${antwort.status} statt 404`);
  return '404 — nicht einmal die Existenz';
});

console.log('\nDateiablage');

const ablageForm = new FormData();
ablageForm.append('file', new Blob([bild], { type: 'image/png' }), `ablage-${marke}.png`);
ablageForm.append('channelId', kanalId);
const abgelegt = (await (await fetch(`${S}/api/files`, { method: 'POST', headers: meinKopf, body: ablageForm })).json()).file;

await pruefe('Ein Bild aus der Ablage kommt heil an', async () => {
  const antwort = await fetch(`${S}${abgelegt.url}?token=${encodeURIComponent(probe.token)}`);
  muss(antwort.status === 200, `Status ${antwort.status}`);
  muss(antwort.headers.get('content-type') === 'image/png', `Inhaltstyp ${antwort.headers.get('content-type')}`);
  const zurueck = Buffer.from(await antwort.arrayBuffer());
  muss(crypto.createHash('sha256').update(zurueck).digest('hex') === summe, 'Inhalt weicht ab');
});

await pruefe('Die Ablage ist ohne Nachweis zu', async () => {
  const antwort = await fetch(`${S}${abgelegt.url}`);
  muss(antwort.status === 401, `Status ${antwort.status} statt 401`);
});

await pruefe('Eine Ablagedatei am Kanal bleibt für Fremde zu', async () => {
  const antwort = await fetch(`${S}${abgelegt.url}?token=${encodeURIComponent(fremde.token)}`);
  muss(antwort.status === 404, `Status ${antwort.status} statt 404`);
});

/* ── Und jetzt das, worauf es ankommt: sieht man es? ──────────── */

console.log('\nIn der Oberfläche');

maschine = await chromium.launch({ headless: true });
const sicht = await maschine.newContext({
  viewport: { width: 1280, height: 800 }, locale: 'de-DE', deviceScaleFactor: 2,
});
const seite = await sicht.newPage();

const netz = [];
seite.on('response', (r) => {
  if (/\/(files|storage)\//.test(r.url())) {
    netz.push({ status: r.status(), mitNachweis: r.url().includes('token='), typ: r.headers()['content-type'] });
  }
});

await seite.goto(APP);
await seite.evaluate(([adresse, token]) => {
  localStorage.setItem('stellium.serverUrl', adresse);
  localStorage.setItem('stellium.token', token);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [S, probe.token]);
await seite.reload();
await seite.waitForSelector('.app', { timeout: 25000 }).catch(async () => {
  // Ohne diesen Hinweis rätselt man an einer Zeitüberschreitung herum. Steht
  // hier die Anmeldemaske, stimmt etwas mit dem Zugang nicht — nicht mit den
  // Bildern.
  const text = await seite.evaluate(() => document.body.innerText.slice(0, 200));
  throw new Error(`Die Oberfläche kam nicht herauf. Was steht: ${text.replace(/\s+/g, ' ')}`);
});
await seite.evaluate((id) => window.__stelliumStore.getState().openChannel(id), kanalId);
await seite.waitForSelector('img.att-img', { timeout: 20000 }).catch(() => null);
await seite.waitForTimeout(1800);

await pruefe('Der Browser zeigt das Bild wirklich an', async () => {
  const bilder = await seite.$$eval('img.att-img', (els) => els.map((el) => ({
    breite: el.naturalWidth, hoehe: el.naturalHeight, fertig: el.complete,
    nachweis: (el.getAttribute('src') ?? '').includes('token='),
  })));
  muss(bilder.length === 1, `${bilder.length} Bilder im Verlauf`);
  muss(bilder[0].nachweis, 'die Adresse trägt keinen Nachweis');
  // Der harte Teil: dekodiert oder nicht. Ein kaputtes Bild hat hier eine Null.
  muss(bilder[0].breite === 560 && bilder[0].hoehe === 360,
    `dekodiert als ${bilder[0].breite}×${bilder[0].hoehe} statt 560×360`);
  return `${bilder[0].breite}×${bilder[0].hoehe} dekodiert`;
});

await pruefe('Keine einzige Anfrage ging ohne Nachweis hinaus', async () => {
  const ohne = netz.filter((n) => !n.mitNachweis);
  muss(ohne.length === 0, `${ohne.length} Anfrage(n) ohne Nachweis: ${JSON.stringify(ohne)}`);
  muss(netz.every((n) => n.status === 200), `Statuscodes: ${netz.map((n) => n.status).join(', ')}`);
  return `${netz.length}× 200`;
});

await pruefe('Auch der Lichtkasten zeigt das Bild', async () => {
  await seite.click('img.att-img');
  await seite.waitForTimeout(1200);
  const gross = await seite.$$eval('.lightbox img', (els) => els.map((el) => ({
    breite: el.naturalWidth, nachweis: (el.getAttribute('src') ?? '').includes('token='),
  })));
  muss(gross.length === 1, `${gross.length} Bilder im Lichtkasten`);
  muss(gross[0].nachweis, 'die Adresse trägt keinen Nachweis');
  muss(gross[0].breite === 560, `dekodiert als ${gross[0].breite} statt 560`);
  await seite.screenshot({ path: `${ZIEL}/bildanzeige-lichtkasten.png` });
  await seite.keyboard.press('Escape');
  await seite.waitForTimeout(600);
  return `${ZIEL}/bildanzeige-lichtkasten.png`;
});

await pruefe('Der Reiter Dateiablage zeigt die Datei', async () => {
  await seite.evaluate(() => window.__stelliumStore.getState().setOverlay('files'));
  await seite.waitForTimeout(1800);
  const treffer = await seite.evaluate((name) => document.body.innerText.includes(name), abgelegt.name);
  muss(treffer, `"${abgelegt.name}" steht nicht in der Ablage`);
  await seite.screenshot({ path: `${ZIEL}/bildanzeige-ablage.png` });
  await seite.evaluate(() => window.__stelliumStore.getState().setOverlay(null));
  await seite.waitForTimeout(600);
});

await seite.screenshot({ path: `${ZIEL}/bildanzeige.png` });
console.log(`\n  Schirmbild: ${ZIEL}/bildanzeige.png`);

await maschine.close();
await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
