import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';
/** Verteilung neuer App-Versionen: hochladen, prüfen, herunterladen. */
const ergebnisse = [];
const pruefe = async (name, fn) => {
  try { const n = await fn(); ergebnisse.push(true); console.log(`  ✓ ${name}${n ? ` — ${n}` : ''}`); }
  catch (e) { ergebnisse.push(false); console.log(`  ✗ ${name} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const anmeldung = await (await fetch(`${S}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    login: process.env.STELLIUM_TEST_LOGIN ?? 'don',
    password: PW,
  }),
})).json();
if (!anmeldung.token) {
  console.error('Anmeldung fehlgeschlagen:', JSON.stringify(anmeldung).slice(0, 160));
  console.error('Zugang über STELLIUM_TEST_LOGIN und STELLIUM_TEST_PASSWORT setzen.');
  process.exit(1);
}
const kopf = { authorization: `Bearer ${anmeldung.token}` };

const inhalt = new Uint8Array(256 * 1024).fill(7);
const hochladen = async (platform, version) => {
  const form = new FormData();
  form.append('version', version);
  form.append('notes', `Testversion ${version}`);
  form.append('file', new Blob([inhalt]), `Stellium-${version}.dmg`);
  const r = await fetch(`${S}/api/releases/${platform}`, { method: 'POST', headers: kopf, body: form });
  return { status: r.status, body: await r.json() };
};

console.log('\nVerteilung neuer Versionen');

await pruefe('Version hochladen', async () => {
  const r = await hochladen('darwin', '9.9.9');
  muss(r.status === 200, `Status ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
  muss(/^[a-f0-9]{64}$/.test(r.body.release.sha256), 'keine Prüfsumme');
  return `${r.body.release.version}, ${r.body.release.sha256.slice(0, 12)}…`;
});

await pruefe('Ältere Version löst kein Update aus', async () => {
  const r = await (await fetch(`${S}/api/releases/check?platform=darwin&version=9.9.9`, { headers: kopf })).json();
  muss(r.update === null, 'meldet ein Update auf dieselbe Version');
});

await pruefe('Neuere Version wird gemeldet', async () => {
  const r = await (await fetch(`${S}/api/releases/check?platform=darwin&version=0.1.0`, { headers: kopf })).json();
  muss(r.update?.version === '9.9.9', `bekommen: ${JSON.stringify(r.update)}`);
  muss(!('path' in r.update), 'der Dateipfad des Servers wird nach außen gegeben');
  return r.update.version;
});

await pruefe('Rückschritt wird abgelehnt', async () => {
  const r = await (await fetch(`${S}/api/releases/check?platform=darwin&version=10.0.0`, { headers: kopf })).json();
  muss(r.update === null, 'bietet eine ältere Version an');
});

await pruefe('Ungültige Versionsnummer wird abgewiesen', async () => {
  const r = await hochladen('win32', 'neueste');
  muss(r.status === 400, `Status ${r.status}`);
  return r.body.error;
});

await pruefe('Herunterladen liefert genau die Datei', async () => {
  const r = await fetch(`${S}/releases/darwin/download`, { headers: kopf });
  muss(r.ok, `Status ${r.status}`);
  const daten = new Uint8Array(await r.arrayBuffer());
  muss(daten.byteLength === inhalt.byteLength, `${daten.byteLength} statt ${inhalt.byteLength} Bytes`);
  muss(daten[0] === 7 && daten[daten.length - 1] === 7, 'Inhalt weicht ab');
  return `${(daten.byteLength / 1024).toFixed(0)} KB`;
});

await pruefe('Ohne Anmeldung kein Zugriff', async () => {
  const r = await fetch(`${S}/releases/darwin/download`);
  muss(r.status === 401, `Status ${r.status} statt 401`);
});

await pruefe('Version zurückziehen', async () => {
  const r = await fetch(`${S}/api/releases/darwin`, { method: 'DELETE', headers: kopf });
  muss(r.ok, `Status ${r.status}`);
  const nach = await (await fetch(`${S}/api/releases/check?platform=darwin&version=0.1.0`, { headers: kopf })).json();
  muss(nach.update === null, 'meldet weiterhin ein Update');
});

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
