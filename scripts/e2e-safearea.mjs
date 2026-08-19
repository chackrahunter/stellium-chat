/**
 * Bleibt hinter Home-Leiste und Dynamic Island ein schwarzer Streifen?
 *
 * Ein Browser auf dem Schreibtisch kennt diese Ränder nicht — env() ist dort
 * null, und der Fehler bliebe unsichtbar. Deshalb werden die Werte hier von
 * Hand gesetzt, so wie ein iPhone sie meldet, und danach wird die Farbe an den
 * Rändern wirklich ausgelesen.
 */
import { webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const probe = await probeserver();
const b = await webkit.launch({ headless: true });
const ctx = await b.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, locale: 'de-DE' });
const p = await ctx.newPage();

await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [probe.S, probe.token]);
await p.reload();
await p.waitForSelector('.app', { timeout: 20000 });

// So meldet ein iPhone 15 Pro seine Ränder.
await p.addStyleTag({ content: ':root { --sicher-oben: 59px; --sicher-unten: 34px; --sicher-links: 0px; --sicher-rechts: 0px; }' });
await p.waitForTimeout(900);

const farben = await p.evaluate(() => {
  const lies = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return { punkt: `${x},${y}`, element: 'nichts', farbe: 'keine' };
    let v = el;
    while (v && getComputedStyle(v).backgroundColor === 'rgba(0, 0, 0, 0)') v = v.parentElement;
    return {
      punkt: `${x},${y}`,
      element: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`,
      farbe: v ? getComputedStyle(v).backgroundColor : 'keine',
    };
  };
  const h = window.innerHeight, w = window.innerWidth;
  return [lies(w / 2, 4), lies(w / 2, h - 4), lies(4, h / 2), lies(w - 4, h / 2)];
});

console.log('\nFarbe an den Rändern (iPhone-Ränder eingesetzt)');
for (const f of farben) console.log(`  ${f.punkt.padEnd(10)} ${f.element.padEnd(24)} ${f.farbe}`);
const schwarz = farben.filter((f) => f.farbe === 'rgb(0, 0, 0)' || f.farbe === 'keine');
console.log(schwarz.length
  ? `\n✗ ${schwarz.length} Rand${schwarz.length > 1 ? 'bereiche' : 'bereich'} ohne Farbe — dort bleibt es schwarz.`
  : '\n✓ Alle Ränder tragen die Hintergrundfarbe.');

await p.screenshot({ path: 'schirmbilder/safearea.png' });
await b.close();
await probe.stop();
process.exit(schwarz.length ? 1 : 0);
