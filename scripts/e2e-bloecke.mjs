/**
 * Der Blockspeicher darf niemals ein Byte verändern.
 *
 * Geprüft wird der ganze Weg: hochladen, im Blockspeicher ablegen, wieder
 * herunterladen, Prüfsumme vergleichen. Dazu die Ersparnis bei zwei Fassungen
 * derselben Datei — und dass das Löschen der einen die andere nicht anfasst.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };
const summe = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

const probe = await probeserver();
const S = probe.S;
const kopf = { authorization: probe.kopf.authorization };

/** Baut eine Datei, die einer zweiten Fassung ähnelt: gleicher Rumpf, anderer Kopf. */
function bauen(groesse, saat, abweichungAb = null) {
  const daten = Buffer.alloc(groesse);
  // Wiederholbarer Inhalt, damit beide Fassungen dieselbe Grundlage haben.
  let zustand = crypto.createHash('sha256').update(saat).digest();
  for (let i = 0; i < groesse; i += 32) {
    zustand = crypto.createHash('sha256').update(zustand).digest();
    zustand.copy(daten, i, 0, Math.min(32, groesse - i));
  }
  if (abweichungAb !== null) daten.fill(0x42, abweichungAb, abweichungAb + 512 * 1024);
  return daten;
}

async function hochladen(inhalt, name) {
  const form = new FormData();
  form.append('file', new Blob([inhalt], { type: 'application/octet-stream' }), name);
  const antwort = await (await fetch(`${S}/api/uploads`, { method: 'POST', headers: kopf, body: form })).json();
  return antwort.attachment ?? antwort;
}

const herunterladen = async (pfad) =>
  Buffer.from(await (await fetch(`${S}${pfad}`, { headers: kopf })).arrayBuffer());

console.log('\nBlockspeicher');

const eins = bauen(6 * 1024 * 1024, 'fassung-eins');
const zwei = bauen(6 * 1024 * 1024, 'fassung-eins', 1024 * 1024);   // dieselbe Datei, 512 KB anders

let a; let b;

await pruefe('Eine Datei kommt unverändert zurück', async () => {
  a = await hochladen(eins, 'programm-1.0.bin');
  muss(a.id, 'kein Anhang angelegt');
  const zurueck = await herunterladen(a.url);
  muss(summe(zurueck) === summe(eins), 'die Bytes haben sich verändert');
  return `${mb(eins.length)} unversehrt`;
});

await pruefe('Zweite Fassung wird ebenfalls unverändert zurückgegeben', async () => {
  b = await hochladen(zwei, 'programm-1.1.bin');
  const zurueck = await herunterladen(b.url);
  muss(summe(zurueck) === summe(zwei), 'die Bytes haben sich verändert');
});

await pruefe('Die zweite Fassung teilt sich Blöcke mit der ersten', async () => {
  // In der Datenbank nachsehen statt zu vermuten: wie viel liegt wirklich da?
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const { belegt } = db.prepare('SELECT COALESCE(SUM(belegt), 0) belegt FROM bloecke').get();
  const { geteilt } = db.prepare('SELECT COUNT(*) geteilt FROM bloecke WHERE verweise > 1').get();
  db.close();

  const hochgeladen = eins.length + zwei.length;
  muss(geteilt > 0, 'kein einziger Block wird geteilt');
  muss(belegt < hochgeladen * 0.75,
    `belegt ${mb(belegt)} von ${mb(hochgeladen)} — zu wenig gespart`);
  const gespart = 100 - (100 * belegt) / hochgeladen;
  return `${mb(hochgeladen)} hochgeladen, ${mb(belegt)} gespeichert (${gespart.toFixed(0)} % gespart, ${geteilt} Blöcke geteilt)`;
});

await pruefe('Dieselbe Datei ein zweites Mal kostet fast nichts', async () => {
  const nochmal = await hochladen(eins, 'programm-1.0-kopie.bin');
  const zurueck = await herunterladen(nochmal.url);
  muss(summe(zurueck) === summe(eins), 'die Kopie kam verändert zurück');
});

await pruefe('Nach dem Löschen der ersten bleibt die zweite heil', async () => {
  await fetch(`${S}/api/uploads/${a.id}`, { method: 'DELETE', headers: kopf }).catch(() => {});
  const zurueck = await herunterladen(b.url);
  muss(summe(zurueck) === summe(zwei), 'die zweite Fassung ist beschädigt');
});

await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
