/**
 * Bilder statt Zahlen: wie sieht die Oberfläche auf echten Geräten aus?
 *
 * Eine Zahl sagt, ob etwas überläuft — ein Bild sagt, ob es gut aussieht.
 * Der Lauf legt für jede Gerätegröße ein Bild ab, in beiden Maschinen:
 * WebKit steckt in Safari auf iPhone und iPad, Chromium in fast allem anderen.
 */
import fs from 'node:fs';
import { chromium, webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const ZIEL = process.env.STELLIUM_BILDER ?? 'schirmbilder';

const GERAETE = [
  { name: '01-iphone-se',        maschine: 'webkit',   breite: 375, hoehe: 667,  geraet: 'iPhone SE' },
  { name: '02-iphone-pro',       maschine: 'webkit',   breite: 402, hoehe: 874,  geraet: 'iPhone 15 Pro' },
  { name: '03-iphone-pro-max',   maschine: 'webkit',   breite: 440, hoehe: 956,  geraet: 'iPhone 15 Pro Max' },
  { name: '04-android-klein',    maschine: 'chromium', breite: 360, hoehe: 800,  geraet: 'Galaxy S9+' },
  { name: '05-android-gross',    maschine: 'chromium', breite: 412, hoehe: 915,  geraet: 'Pixel 7' },
  { name: '06-ipad-hoch',        maschine: 'webkit',   breite: 820, hoehe: 1180, geraet: 'iPad (gen 7)' },
  { name: '07-ipad-quer',        maschine: 'webkit',   breite: 1180, hoehe: 820, geraet: 'iPad (gen 7) landscape' },
  { name: '08-android-tablet',   maschine: 'chromium', breite: 800, hoehe: 1280, geraet: null },
  { name: '09-laptop',           maschine: 'chromium', breite: 1440, hoehe: 900, geraet: null },
  { name: '10-schirm-gross',     maschine: 'chromium', breite: 1920, hoehe: 1080, geraet: null },
];

fs.mkdirSync(ZIEL, { recursive: true });
const probe = await probeserver();
const maschinen = { chromium: await chromium.launch({ headless: true }), webkit: await webkit.launch({ headless: true }) };

console.log(`\nSchirmbilder nach ${ZIEL}/\n`);
const befunde = [];

for (const g of GERAETE) {
  const geraet = g.geraet && devices[g.geraet] ? devices[g.geraet] : {};
  const ctx = await maschinen[g.maschine].newContext({
    ...geraet,
    viewport: { width: g.breite, height: g.hoehe },
    locale: 'de-DE',
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1600);

  const mangel = await p.evaluate(() => {
    const breite = document.documentElement.clientWidth;
    const raus = [];
    /* Nur melden, was wirklich stört. Absichtlich beiseitegeschobenes (die
       eingeklappte Kanalliste) und sauber Abgeschnittenes (die Farbblasen im
       Hintergrund) sind kein Fehler — sie sind der Entwurf. */
    const abgeschnitten = (el) => {
      for (let v = el.parentElement; v; v = v.parentElement) {
        const st = getComputedStyle(v);
        if (st.overflowX !== 'visible' || st.contain.includes('strict')) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= breite + 1 && r.left >= -1) continue;
      if (abgeschnitten(el)) continue;
      raus.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`);
    }
    return {
      ueberlauf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      raus: [...new Set(raus)].slice(0, 3),
    };
  });

  await p.screenshot({ path: `${ZIEL}/${g.name}.png` });

  /* Auf schmalen Geräten auch die geöffnete Schublade festhalten — dort steckt
     die halbe Navigation, und ein Bild davon sagt mehr als die Zusicherung,
     dass nichts überläuft. */
  if (g.breite <= 680) {
    await p.evaluate(() => window.__stelliumStore.getState().setSchublade(true));
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${ZIEL}/${g.name}-schublade.png` });
    await p.evaluate(() => window.__stelliumStore.getState().setSchublade(false));
    await p.waitForTimeout(400);
  }
  const marke = mangel.ueberlauf <= 1 && mangel.raus.length === 0 ? '✓' : '✗';
  console.log(`  ${marke} ${g.name.padEnd(20)} ${g.breite}×${g.hoehe} ${g.maschine.padEnd(9)}`
    + (mangel.ueberlauf > 1 ? ` — ${mangel.ueberlauf}px zu breit` : '')
    + (mangel.raus.length ? ` — ragt heraus: ${mangel.raus.join(', ')}` : ''));
  if (marke === '✗') befunde.push(g.name);
  await ctx.close();
}

for (const m of Object.values(maschinen)) await m.close();
await probe.stop();
console.log(`\n${GERAETE.length - befunde.length}/${GERAETE.length} ohne Beanstandung`);
process.exit(befunde.length ? 1 : 0);
