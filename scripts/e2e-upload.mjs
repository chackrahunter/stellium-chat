/** Große Dateien in Teilen: das Ergebnis muss Byte für Byte dasselbe sein. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';


const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const { token } = await (await fetch(`${S}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: LOGIN, password: PW }),
})).json();
const kopf = { authorization: `Bearer ${token}` };

const datei = '/tmp/probe-upload.bin';
const GROESSE = 30 * 1024 * 1024;
fs.writeFileSync(datei, crypto.randomBytes(GROESSE));
const inhalt = fs.readFileSync(datei);
const summe = crypto.createHash('sha256').update(inhalt).digest('hex');

/** Derselbe Weg wie in der App: Teile parallel, dann zusammensetzen. */
const inTeilen = async (teilgroesse, gleichzeitig) => {
  const teile = Math.ceil(GROESSE / teilgroesse);
  const { uploadId } = await (await fetch(`${S}/api/uploads/start`, {
    method: 'POST', headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'probe.bin', mime: 'application/octet-stream', size: GROESSE, parts: teile }),
  })).json();

  let naechster = 0;
  const arbeiter = async () => {
    for (;;) {
      const n = naechster++;
      if (n >= teile) return;
      const stueck = inhalt.subarray(n * teilgroesse, Math.min((n + 1) * teilgroesse, GROESSE));
      const r = await fetch(`${S}/api/uploads/${uploadId}/part/${n}`, {
        method: 'PUT', headers: { ...kopf, 'content-type': 'application/octet-stream' }, body: stueck,
      });
      if (!r.ok) throw new Error(`Teil ${n}: ${r.status}`);
    }
  };
  const start = performance.now();
  await Promise.all(Array.from({ length: gleichzeitig }, arbeiter));
  const r = await fetch(`${S}/api/uploads/${uploadId}/finish`, { method: 'POST', headers: kopf });
  const daten = await r.json();
  if (!r.ok) throw new Error(daten.error);
  return { dauer: (performance.now() - start) / 1000, anhang: daten.attachment };
};

let geteilt = null;

await pruefe('Zusammengesetzte Datei ist unverändert', async () => {
  geteilt = await inTeilen(4 * 1024 * 1024, 4);
  muss(geteilt.anhang.size === GROESSE, `${geteilt.anhang.size} statt ${GROESSE}`);
  const r = await fetch(`${S}/files/${geteilt.anhang.id}`, { headers: kopf });
  const zurueck = Buffer.from(await r.arrayBuffer());
  const summeZurueck = crypto.createHash('sha256').update(zurueck).digest('hex');
  muss(summeZurueck === summe, 'Inhalt weicht ab');
  return `${(GROESSE / 1048576).toFixed(0)} MB · ${summe.slice(0, 12)}…`;
});

await pruefe('Fehlende Teile werden erkannt', async () => {
  const { uploadId } = await (await fetch(`${S}/api/uploads/start`, {
    method: 'POST', headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'luecke.bin', mime: 'application/octet-stream', size: GROESSE, parts: 4 }),
  })).json();
  await fetch(`${S}/api/uploads/${uploadId}/part/0`, {
    method: 'PUT', headers: { ...kopf, 'content-type': 'application/octet-stream' }, body: inhalt.subarray(0, 1024),
  });
  const r = await fetch(`${S}/api/uploads/${uploadId}/finish`, { method: 'POST', headers: kopf });
  const daten = await r.json();
  muss(r.status === 400, `Status ${r.status}`);
  muss(/fehlen Teile/i.test(daten.error ?? ''), `unerwartet: ${daten.error}`);
});

await pruefe('Fremde Uploads sind nicht erreichbar', async () => {
  const r = await fetch(`${S}/api/uploads/up_gibtsnicht/part/0`, {
    method: 'PUT', headers: { ...kopf, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(8),
  });
  muss(r.status === 404, `Status ${r.status}`);
});

await pruefe('Zu große Dateien werden abgelehnt', async () => {
  const r = await fetch(`${S}/api/uploads/start`, {
    method: 'POST', headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'riese.bin', mime: 'application/octet-stream', size: 5_000_000_000, parts: 10 }),
  });
  muss(r.status === 413, `Status ${r.status}`);
});

await pruefe('Ein Strom gegen vier Ströme', async () => {
  const einer = await inTeilen(GROESSE, 1);
  const tempoEiner = (GROESSE / 1048576) / einer.dauer;
  const tempoVier = (GROESSE / 1048576) / geteilt.dauer;
  return `1 Strom ${tempoEiner.toFixed(0)} MB/s · 4 Ströme ${tempoVier.toFixed(0)} MB/s`;
});

await pruefe('Eine bekannte Datei wird nicht noch einmal übertragen', async () => {
  const summe = crypto.createHash('sha256').update(inhalt).digest('hex');
  const start = performance.now();
  const r = await fetch(`${S}/api/uploads/bekannt`, {
    method: 'POST', headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({ sha256: summe, size: GROESSE, name: 'nochmal.bin', mime: 'application/octet-stream' }),
  });
  const daten = await r.json();
  const dauer = (performance.now() - start) / 1000;
  muss(r.ok, `Status ${r.status}`);
  muss(daten.bekannt === true, 'die Datei gilt als unbekannt');
  muss(daten.attachment?.size === GROESSE, `Größe ${daten.attachment?.size}`);

  // Und der Verweis muss wirklich dieselben Bytes liefern.
  const zurueck = Buffer.from(await (await fetch(`${S}/files/${daten.attachment.id}`, { headers: kopf })).arrayBuffer());
  muss(crypto.createHash('sha256').update(zurueck).digest('hex') === summe, 'Inhalt weicht ab');
  return `${(GROESSE / 1048576).toFixed(0)} MB in ${dauer.toFixed(2)} s statt zu übertragen`;
});

await pruefe('Eine unbekannte Datei gilt als unbekannt', async () => {
  const r = await fetch(`${S}/api/uploads/bekannt`, {
    method: 'POST', headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({ sha256: 'a'.repeat(64), size: 123, name: 'neu.bin' }),
  });
  const daten = await r.json();
  muss(daten.bekannt === false, 'behauptet, sie zu kennen');
});

await pruefe('Eine unsinnige Prüfsumme wird abgelehnt', async () => {
  const r = await fetch(`${S}/api/uploads/bekannt`, {
    method: 'POST', headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({ sha256: 'unsinn', size: 1 }),
  });
  muss(r.status === 400, `Status ${r.status}`);
});

fs.rmSync(datei, { force: true });
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
