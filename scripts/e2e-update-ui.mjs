/**
 * Prüft den Update-Hinweis in der Oberfläche. Die Brücke zu Electron wird
 * nachgebildet — im Browser gibt es sie nicht, die Anzeige aber schon.
 */
import { chromium } from 'playwright';
const APP = 'http://localhost:5173';
const S = 'http://localhost:8787';
const ergebnisse = [];
const pruefe = async (n, f) => { try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x?` — ${x}`:''}`); } catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'de-DE' });

// Die Brücke vor allem anderen einsetzen, damit sie beim Start schon da ist.
await ctx.addInitScript(() => {
  const hoerer = [];
  window.__update = (art, daten) => hoerer.forEach((h) => h(art, daten));
  window.__protokoll = [];
  window.stellium = {
    platform: 'darwin',
    locale: 'de-DE',
    info: async () => ({ locale: 'de-DE', platform: 'darwin', arch: 'arm64', version: '1.0.0', isDev: false }),
    notify: async () => true, setBadge: async () => true, flashWindow: async () => true,
    setTheme: async () => true, openExternal: async () => true,
    onMenu: () => () => {}, onNotificationClick: () => () => {},
    updateSignIn: async () => true, updateSignOut: async () => true,
    checkForUpdate: async () => { window.__protokoll.push('pruefen'); return null; },
    installUpdate: async () => { window.__protokoll.push('installieren'); return true; },
    postponeUpdate: async () => { window.__protokoll.push('verschieben'); window.__update('postponed', { version: '9.9.9' }); return true; },
    lastUpdate: async () => { const r = localStorage.getItem('__letztes'); return r ? JSON.parse(r) : null; },
    onUpdate: (h) => { hoerer.push(h); return () => {}; },
  };
});

const p = await ctx.newPage();
await p.goto(APP);
await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
await p.reload(); await p.waitForTimeout(1000);
if (await p.locator('.auth').count()) {
  await p.locator('.auth input').first().fill('don');
  await p.locator('.auth input[type="password"]').first().fill(process.env.STELLIUM_TEST_PASSWORT ?? 'MeinLangesPasswort-2026');
  await p.locator('.auth button[type="submit"]').first().click();
}
await p.waitForSelector('.app', { timeout: 20000 });
await p.waitForTimeout(1000);

await pruefe('Ohne Update kein Streifen', async () => {
  muss(!(await p.locator('.update-band').count()), 'Streifen ohne Anlass sichtbar');
});

await pruefe('Gefundene Version wird angekündigt', async () => {
  await p.evaluate(() => window.__update('found', { version: '9.9.9', notes: 'Umfragen werden übersetzt' }));
  await p.waitForSelector('.update-band', { timeout: 5000 });
  return (await p.locator('.update-band__text').innerText()).slice(0, 60);
});

await pruefe('Fortschritt beim Laden', async () => {
  await p.evaluate(() => window.__update('progress', { version: '9.9.9', geladen: 45, gesamt: 100 }));
  await p.waitForTimeout(400);
  const text = await p.locator('.update-band__text').innerText();
  muss(/45/.test(text), `kein Fortschritt: ${text}`);
  muss(await p.locator('.update-band__bar').count(), 'kein Balken');
});

await pruefe('Countdown bis zur Installation', async () => {
  await p.evaluate(() => {
    window.__update('ready', { version: '9.9.9', notes: 'Umfragen werden übersetzt' });
    window.__update('deadline', { version: '9.9.9', sekunden: 300 });
  });
  await p.waitForTimeout(1600);
  const text = await p.locator('.update-band__text').innerText();
  muss(/\d:\d\d/.test(text), `keine Restzeit: ${text}`);
  // Sie muss auch wirklich laufen.
  const erste = /(\d:\d\d)/.exec(text)[1];
  await p.waitForTimeout(2200);
  const zweite = /(\d:\d\d)/.exec(await p.locator('.update-band__text').innerText())[1];
  muss(erste !== zweite, 'die Uhr steht');
  return `${erste} → ${zweite}`;
});

await pruefe('Später hält die Uhr an', async () => {
  await p.locator('.update-band button').filter({ hasText: 'Später' }).click({ force: true });
  await p.waitForTimeout(700);
  const text = await p.locator('.update-band__text').innerText();
  muss(/Beenden/i.test(text), `Text unerwartet: ${text}`);
  muss(!/\d:\d\d/.test(text), 'die Uhr läuft weiter');
  const gerufen = await p.evaluate(() => window.__protokoll);
  muss(gerufen.includes('verschieben'), 'der Hauptprozess wurde nicht benachrichtigt');
});

await pruefe('Jetzt installieren löst aus', async () => {
  await p.locator('.update-band button').filter({ hasText: 'installieren' }).click({ force: true });
  await p.waitForTimeout(500);
  const gerufen = await p.evaluate(() => window.__protokoll);
  muss(gerufen.includes('installieren'), 'nichts ausgelöst');
});

await pruefe('Nach dem Neustart steht da, was neu ist', async () => {
  await p.evaluate(() => {
    localStorage.setItem('__letztes', JSON.stringify({
      version: '9.9.9',
      notes: 'Umfragen werden übersetzt\nEmoji-Liste bleibt im Fenster',
      installiertAm: Date.now(),
    }));
  });
  await p.reload();
  await p.waitForSelector('.neu', { timeout: 15000 });
  const punkte = await p.locator('.neu__liste li').count();
  muss(punkte === 2, `${punkte} Punkte statt 2`);
  const titel = await p.locator('.neu__titel').innerText();
  muss(/9\.9\.9/.test(titel), `Titel: ${titel}`);
  // Nur einmal — beim nächsten Start ist er weg.
  await p.locator('.neu .btn--primary').click();
  await p.waitForTimeout(400);
  muss(!(await p.locator('.neu').count()), 'lässt sich nicht schließen');
  return `${punkte} Punkte`;
});

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
