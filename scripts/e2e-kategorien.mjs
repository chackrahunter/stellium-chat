/** Schubladen in der Kontenverwaltung: automatisch einsortiert, frei umsortierbar. */
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/* Kategorien zu ändern ist Sache der Leitung — dafür braucht es ein Konto mit
   vollen Rechten. Das bringt der Prüflauf sich selbst mit. */
const server = await probeserver();
const { S, kopf, login: LOGIN, passwort: PW } = server;
const APP = process.env.STELLIUM_APP || 'http://localhost:5173';

const konten = async () => (await (await fetch(`${S}/api/admin/users`, { headers: kopf })).json()).users;

/* Auf einer frischen Datenbank gibt es nur Leitung und Bot — für die Prüfung
   braucht es jemanden zum Einsortieren. */
for (const [name, handle] of [['Probe Mitglied', 'probemitglied'], ['Probe Zweiter', 'probezweiter']]) {
  await fetch(`${S}/api/admin/users`, {
    method: 'POST', headers: kopf,
    body: JSON.stringify({ displayName: name, handle, role: 'member', language: 'de' }),
  });
}

let alle = [];
await pruefe('Die Verwaltung liefert die Kategorie mit', async () => {
  alle = await konten();
  muss(Array.isArray(alle) && alle.length, 'keine Konten — fehlt das Recht?');
  muss('kategorie' in alle[0], 'Feld fehlt');
  return `${alle.length} Konten`;
});

await pruefe('Ein Bot landet von selbst bei den technischen', async () => {
  const bot = alle.find((u) => u.role === 'bot');
  if (!bot) return 'kein Bot vorhanden — übersprungen';
  muss(bot.kategorie === null, 'trägt schon eine Wahl');
  return `${bot.displayName} ohne Wahl → technisch`;
});

await pruefe('Umsortieren geht', async () => {
  const wer = alle.find((u) => !u.deletedAt && u.role === 'member');
  muss(wer, 'kein passendes Konto');
  const r = await fetch(`${S}/api/admin/users/${wer.id}/kategorie`, {
    method: 'POST', headers: kopf, body: JSON.stringify({ kategorie: 'extern' }),
  });
  muss(r.ok, `Status ${r.status}`);
  const danach = (await r.json()).users.find((u) => u.id === wer.id);
  muss(danach.kategorie === 'extern', `steht auf ${danach.kategorie}`);
  return `${wer.displayName} → extern`;
});

await pruefe('Zurück auf automatisch', async () => {
  const wer = (await konten()).find((u) => u.kategorie === 'extern');
  muss(wer, 'nichts umsortiert');
  const r = await fetch(`${S}/api/admin/users/${wer.id}/kategorie`, {
    method: 'POST', headers: kopf, body: JSON.stringify({ kategorie: null }),
  });
  muss(r.ok, `Status ${r.status}`);
  const danach = (await r.json()).users.find((u) => u.id === wer.id);
  muss(danach.kategorie === null, `steht auf ${danach.kategorie}`);
});

await pruefe('Eine erfundene Kategorie wird abgelehnt', async () => {
  const wer = alle.find((u) => !u.deletedAt);
  const r = await fetch(`${S}/api/admin/users/${wer.id}/kategorie`, {
    method: 'POST', headers: kopf, body: JSON.stringify({ kategorie: 'quatsch' }),
  });
  muss(r.status === 400, `Status ${r.status}`);
});

await pruefe('Gelöschte lassen sich nicht einsortieren', async () => {
  const weg = alle.find((u) => u.deletedAt);
  if (!weg) return 'kein gelöschtes Konto — übersprungen';
  const r = await fetch(`${S}/api/admin/users/${weg.id}/kategorie`, {
    method: 'POST', headers: kopf, body: JSON.stringify({ kategorie: 'mitglieder' }),
  });
  muss(r.status === 400, `Status ${r.status}`);
});

/* ── In der Oberfläche ─────────────────────────────────────── */
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1400, height: 900 }, locale: 'de-DE' })).newPage();
await p.goto(APP);
await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
await p.reload(); await p.waitForTimeout(1200);
if (await p.locator('.auth').count()) {
  await p.locator('.auth input').first().fill(LOGIN);
  await p.locator('.auth input[type="password"]').first().fill(PW);
  await p.locator('.auth button[type="submit"]').first().click();
}
await p.waitForSelector('.app', { timeout: 20000 });
await p.waitForTimeout(1800);

await pruefe('Die Verwaltung zeigt Schubladen', async () => {
  await p.evaluate(() => window.__stelliumStore.getState().setOverlay('team'));
  await p.waitForSelector('.kat-gruppe, .admin__detail', { timeout: 10000 });
  await p.waitForTimeout(1200);
  const koepfe = await p.locator('.kat-gruppe__kopf').allInnerTexts();
  if (!koepfe.length) return 'ohne Verwaltungsrecht nicht sichtbar — übersprungen';
  muss(koepfe.length >= 2, `nur ${koepfe.length} Gruppe`);
  return koepfe.map((k) => k.replace(/\n/g, ' ')).join(' · ');
});

await pruefe('Jede Gruppe trägt ihre Anzahl', async () => {
  const zahlen = await p.locator('.kat-gruppe__zahl').allInnerTexts();
  if (!zahlen.length) return 'übersprungen';
  muss(zahlen.every((z) => /^\d+$/.test(z.trim())), `Zahlen: ${zahlen.join(',')}`);
});

await p.screenshot({ path: '/tmp/kategorien.png' });
await b.close();
await server.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
