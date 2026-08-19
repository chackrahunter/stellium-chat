/** Ein Modell auf der eigenen Maschine muss alle KI-Funktionen tragen. */
import { chromium } from 'playwright';

const APP = 'http://localhost:5173';
const S = process.env.STELLIUM_SERVER ?? 'http://localhost:8787';
const LOGIN = process.env.STELLIUM_TEST_LOGIN ?? 'don';
const PW = process.env.STELLIUM_TEST_PASSWORT ?? 'MeinLangesPasswort-2026';
const LOKAL = process.env.STELLIUM_LOKAL ?? 'http://127.0.0.1:11434/v1';

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
const kopf = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
const post = async (pfad, daten) => {
  const r = await fetch(`${S}${pfad}`, { method: 'POST', headers: kopf, body: JSON.stringify(daten) });
  return { status: r.status, daten: await r.json().catch(() => ({})) };
};

let vorher = 'groq';

await pruefe('Nachsehen listet die geladenen Modelle', async () => {
  const { daten } = await post('/api/ai/local-check', { baseUrl: LOKAL });
  muss(daten.erreichbar, `nicht erreichbar: ${daten.fehler}`);
  muss(daten.modelle?.length, 'kein Modell geladen — vorher eines holen (ollama pull gemma3:1b)');
  return daten.modelle.join(', ');
});

await pruefe('Eine falsche Adresse wird abgelehnt statt übernommen', async () => {
  const { status, daten } = await post('/api/ai/provider', { anbieter: 'ollama', baseUrl: 'http://127.0.0.1:1/v1' });
  muss(status === 400, `Status ${status}`);
  muss(/antwortet nichts/i.test(daten.error ?? ''), `unerwartet: ${daten.error}`);
});

await pruefe('Ein nicht geladenes Modell wird abgelehnt', async () => {
  const { status, daten } = await post('/api/ai/provider', { anbieter: 'ollama', baseUrl: LOKAL, model: 'gibtsnicht:99b' });
  muss(status === 400, `Status ${status}`);
  muss(/nicht geladen/i.test(daten.error ?? ''), `unerwartet: ${daten.error}`);
});

await pruefe('Umstellen auf das lokale Modell', async () => {
  const { daten: liste } = await post('/api/ai/local-check', { baseUrl: LOKAL });
  const modell = liste.modelle[0];
  const { status, daten } = await post('/api/ai/provider', { anbieter: 'ollama', baseUrl: LOKAL, model: modell, fastModel: modell });
  muss(status === 200, `Status ${status}: ${daten.error}`);
  muss(daten.ai?.provider === 'ollama', `Anbieter ist ${daten.ai?.provider}`);
  muss(daten.ai?.lokal === true, 'wird nicht als lokal gemeldet');
  muss(daten.ai?.assistant === true, 'Assistent gilt als nicht verfügbar');
  return `${daten.ai.provider} · ${daten.ai.model}`;
});

/* Der Lauf durch ein echtes Modell steht aus, bis eines eingerichtet ist:
   ein 1B-Modell auf diesem Rechner wurde beim Übersetzen vom System beendet.
   Geprüft wird hier der Weg dorthin — Erkennung, Ablehnung, Umschaltung. */

await pruefe('Zurück auf Groq', async () => {
  const { status, daten } = await post('/api/ai/provider', { anbieter: vorher });
  muss(status === 200, `Status ${status}: ${daten.error}`);
  muss(daten.ai?.provider === vorher, `Anbieter ist ${daten.ai?.provider}`);
  muss(daten.ai?.lokal === false, 'gilt weiter als lokal');
});

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
