/**
 * Sitzt die Oberfläche auf einem iPhone?
 *
 * Geprüft wird mit WebKit — der Maschine, die auch in Safari steckt — in der
 * Größe eines iPhone 17 Pro, samt der Ränder, die Dynamic Island und
 * Home-Leiste freihalten wollen.
 */
import { webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const probe = await probeserver();
const browser = await webkit.launch({ headless: true });

// iPhone 17 Pro: 402 × 874 Punkte, Dynamic Island oben, Home-Leiste unten.
const ctx = await browser.newContext({
  ...devices['iPhone 15 Pro'],
  viewport: { width: 402, height: 874 },
  locale: 'de-DE',
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
await p.waitForTimeout(1500);

console.log('\niPhone 17 Pro (402 × 874)');

await pruefe('Die Seite läuft nicht seitlich über', async () => {
  const ueber = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  muss(ueber <= 1, `${ueber} px zu breit`);
});

await pruefe('Kein Element ragt über den rechten Rand', async () => {
  const raus = await p.evaluate(() => {
    const breite = document.documentElement.clientWidth;
    const schuldige = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > breite + 1) {
        schuldige.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} (+${Math.round(r.right - breite)}px)`);
      }
    }
    return [...new Set(schuldige)].slice(0, 5);
  });
  muss(raus.length === 0, raus.join(', '));
});

await pruefe('Die eingeklappte Liste bleibt draußen', async () => {
  const links = await p.evaluate(() => {
    const el = document.querySelector('.sidebar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { rechts: Math.round(r.right), sichtbar: getComputedStyle(el).visibility };
  });
  muss(links, 'keine Liste gefunden');
  muss(links.sichtbar === 'hidden' || links.rechts <= 0, `ragt bis ${links.rechts} px herein`);
});

await pruefe('Der Kanalname wird nicht auf ein Zeichen gestutzt', async () => {
  const text = await p.evaluate(() => document.querySelector('.header__title, .header h1, .header__name')?.textContent?.trim() ?? '');
  muss(text.replace(/[.…]/g, '').length >= 3, `Kopfzeile zeigt „${text}"`);
  return `„${text}"`;
});

await pruefe('Oben und unten bleibt Platz für Insel und Home-Leiste', async () => {
  const werte = await p.evaluate(() => {
    const stil = getComputedStyle(document.documentElement);
    return {
      oben: stil.getPropertyValue('--sicher-oben').trim(),
      unten: stil.getPropertyValue('--sicher-unten').trim(),
    };
  });
  muss(werte.oben !== '' && werte.unten !== '', 'die Ränder sind nirgends berücksichtigt');
  return `oben ${werte.oben}, unten ${werte.unten}`;
});

await ctx.close();
await browser.close();
await probe.stop();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
