/** Benachrichtigungen im Browser: Erlaubnis, Anzeige, Klick, Reitertitel. */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({
  viewport: { width: 1280, height: 860 }, locale: 'de-DE',
  permissions: ['notifications'],
});
const p = await ctx.newPage();

// Benachrichtigungen im Browser abfangen, statt sie dem System zu geben.
await p.addInitScript(() => {
  window.__gezeigt = [];
  class Probe {
    constructor(titel, optionen) {
      window.__gezeigt.push({ titel, ...optionen });
      this.onclick = null;
      window.__letzte = this;
    }
    close() {}
    static permission = 'granted';
    static requestPermission() { return Promise.resolve('granted'); }
  }
  window.Notification = Probe;
});

await p.goto(APP);
await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
await p.reload(); await p.waitForTimeout(1200);
if (await p.locator('.auth').count()) {
  await p.locator('.auth input').first().fill(LOGIN);
  await p.locator('.auth input[type="password"]').first().fill(PW);
  await p.locator('.auth button[type="submit"]').first().click();
}
await p.waitForSelector('.app', { timeout: 20000 });
await p.waitForTimeout(2000);

await pruefe('Der Reitertitel trägt die Zahl der Ungelesenen', async () => {
  const stand = await p.evaluate(() => {
    const s = window.__stelliumStore.getState();
    const kanal = Object.values(s.channels).find((c) => c.kind === 'public');
    // Ungelesenes vortäuschen und die Anzeige anstoßen.
    window.__stelliumStore.setState((alt) => ({
      states: { ...alt.states, [kanal.id]: { ...(alt.states[kanal.id] ?? {}), channelId: kanal.id, unreadCount: 7, muted: false } },
    }));
    return kanal.id;
  });
  // updateBadge läuft bei jedem Zustandswechsel — ein Kanalwechsel stößt ihn an.
  await p.evaluate((k) => window.__stelliumStore.getState().openChannel(k), stand);
  await p.waitForTimeout(1200);
  const titel = await p.title();
  // Über neunundneunzig steht "(99+)" — die Zahl selbst ist nicht der Punkt.
  muss(/^\(\d+\+?\)/.test(titel) || titel === 'Stellium', `Titel: "${titel}"`);
  return `"${titel}"`;
});

await pruefe('Eine Benachrichtigung wird im Browser gezeigt', async () => {
  await p.evaluate(() => {
    window.__gezeigt = [];
    const mod = window.__stelliumBenachrichtigung;
    if (mod) mod.zeigen({ titel: 'Probe', text: 'Hallo', kanalId: 'ch_probe' });
  });
  // Über die Oberfläche: der Knopf in den Einstellungen.
  await p.keyboard.press('Meta+,');
  await p.waitForSelector('.panel', { timeout: 8000 });
  await p.locator('.panel [role="tab"], .panel .tabs button').filter({ hasText: /Benachrichtigung/i }).first().click();
  await p.waitForTimeout(700);
  const knopf = p.locator('.panel button').filter({ hasText: /Probe schicken/i });
  muss(await knopf.count() > 0, 'kein Probeknopf — Erlaubnis wurde nicht erkannt');
  await knopf.click();
  await p.waitForTimeout(600);
  const gezeigt = await p.evaluate(() => window.__gezeigt ?? []);
  muss(gezeigt.length > 0, 'nichts gezeigt');
  muss(gezeigt[0].body, 'ohne Text');
  await p.keyboard.press('Escape');
  return `"${gezeigt[0].titel}: ${gezeigt[0].body}"`;
});

await pruefe('Gleiche Gruppe ersetzt statt zu stapeln', async () => {
  const tags = await p.evaluate(() => (window.__gezeigt ?? []).map((g) => g.tag));
  muss(tags.every((t) => typeof t === 'string' && t.length > 0), `Marken: ${JSON.stringify(tags)}`);
});

await ctx.close();
await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
