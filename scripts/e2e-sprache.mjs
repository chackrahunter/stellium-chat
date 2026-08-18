/** Startet die Oberfläche mit englischem System und prüft, dass alles englisch ist. */
import { chromium } from 'playwright';

const APP = 'http://localhost:5173';
const SERVER = 'http://localhost:8787';
const ergebnisse = [];

async function pruefe(name, fn) {
  try { await fn(); ergebnisse.push(true); console.log('  ✓', name); }
  catch (e) { ergebnisse.push(false); console.log('  ✗', name, '—', e.message.split('\n')[0]); }
}

const b = await chromium.launch({ headless: true });

for (const [locale, erwartet, fehlt] of [
  ['en-US', ['Sign in', 'Username or email', 'Password'], 'Anmelden'],
  ['de-DE', ['Anmelden', 'Benutzername oder E-Mail'], 'Sign in'],
]) {
  const ctx = await b.newContext({ locale, viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  await p.goto(APP);
  await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.removeItem('stellium.token'); }, SERVER);
  await p.reload();
  await p.waitForSelector('.auth', { timeout: 15000 });
  // Beschriftungen erscheinen per CSS in Großbuchstaben — Vergleich ohne Rücksicht darauf.
  const text = (await p.locator('.auth').innerText()).toLowerCase();

  await pruefe(`Anmeldung erscheint auf ${locale}`, () => {
    for (const wort of erwartet) {
      if (!text.includes(wort.toLowerCase())) throw new Error(`"${wort}" fehlt — gesehen: ${text.slice(0, 120).replace(/\n/g, ' | ')}`);
    }
    if (text.includes(fehlt.toLowerCase())) throw new Error(`fremdes Wort "${fehlt}" sichtbar`);
  });
  await ctx.close();
}

await b.close();
const schlecht = ergebnisse.filter((r) => !r).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
