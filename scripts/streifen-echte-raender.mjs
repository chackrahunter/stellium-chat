/**
 * Der Streifen mit ECHTEN Geräterändern.
 *
 * Bisher wurden die Ränder nachgestellt, indem die Merkmale --sicher-*
 * überschrieben wurden. Das prüft aber nur calc(-1 * 34px) — nicht den Weg,
 * den ein iPhone geht: calc(-1 * env(safe-area-inset-bottom)). Chromium kann
 * echte Ränder einstellen (Emulation.setSafeAreaInsetsOverride). Damit ist
 * env() im Prüflauf wirklich 34px, und jede Regel, die daran hängt, rechnet
 * genau wie auf dem Gerät.
 *
 * Aufruf:  node scripts/streifen-echte-raender.mjs [--marke name]
 */
import { chromium, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { pngLesen } from './png-lesen.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const MARKE = (process.argv[process.argv.indexOf('--marke') + 1] ?? 'vorher').replace(/[^a-z0-9-]/gi, '');

async function probeserverMitAnlaeufen(versuche = 6) {
  let letzter;
  for (let i = 0; i < versuche; i += 1) {
    try { return await probeserver(); } catch (f) { letzter = f; await new Promise((r) => setTimeout(r, 400)); }
  }
  throw letzter;
}

const probe = await probeserverMitAnlaeufen();
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({
  ...devices['Pixel 7'],
  viewport: { width: 402, height: 874 },
  deviceScaleFactor: 1,
  locale: 'de-DE',
});
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);

let echteRaender = false;
try {
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 59, bottom: 34, left: 0, right: 0 },
  });
  echteRaender = true;
} catch (f) {
  console.log(`⚠  Echte Ränder gehen nicht: ${f.message.split('\n')[0]}`);
}

await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [probe.S, probe.token]);
await p.reload();
await p.waitForSelector('.app', { timeout: 20000 });
await p.addStyleTag({ content: '.cosmos__stars { display: none !important; } .cosmos__blob { animation: none !important; }' });
await p.waitForTimeout(900);

const mass = await p.evaluate(() => {
  const w = getComputedStyle(document.documentElement);
  const namen = ['html', 'body', '#root', '.cosmos', '.rahmen', '.app', '.main', '.composer-wrap', '.composer'];
  const kasten = (wahl) => {
    const el = wahl === 'html' ? document.documentElement
      : wahl === 'body' ? document.body : document.querySelector(wahl);
    if (!el) return { wahl, fehlt: true };
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return { wahl, oben: Math.round(r.top), unten: Math.round(r.bottom), hoehe: Math.round(r.height), pos: s.position };
  };
  return {
    innerHeight: window.innerHeight,
    sicherOben: w.getPropertyValue('--sicher-oben').trim(),
    sicherUnten: w.getPropertyValue('--sicher-unten').trim(),
    cosmosTop: getComputedStyle(document.querySelector('.cosmos')).top,
    cosmosBottom: getComputedStyle(document.querySelector('.cosmos')).bottom,
    wrapPadUnten: getComputedStyle(document.querySelector('.composer-wrap')).paddingBottom,
    kaesten: namen.map(kasten),
  };
});

const pfad = `/tmp/streifen-echt-${MARKE}.png`;
await p.screenshot({ path: pfad });
await b.close();
await probe.stop();

const bild = pngLesen(pfad);
const SPALTEN = [30, 130, 201, 300, 380];
const mittel = (y) => {
  const s = [0, 0, 0];
  for (const x of SPALTEN) { const c = bild.punkt(x, y); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
  return s.map((n) => Math.round(n / SPALTEN.length));
};
const hell = (c) => Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);

console.log(`\n╔═══ Echte Geräteränder: ${echteRaender ? 'JA (Chromium)' : 'NEIN'} ═══ Bild ${bild.breite}×${bild.hoehe}`);
console.log(`║ innerHeight ${mass.innerHeight}   --sicher-oben ${mass.sicherOben}   --sicher-unten ${mass.sicherUnten}`);
console.log(`║ .cosmos  top ${mass.cosmosTop}  bottom ${mass.cosmosBottom}`);
console.log(`║ .composer-wrap padding-bottom ${mass.wrapPadUnten}`);
console.log('║');
console.log('║ Auswahl          pos        oben   unten   Höhe');
for (const k of mass.kaesten) {
  if (k.fehlt) { console.log(`║ ${k.wahl.padEnd(16)} fehlt`); continue; }
  console.log(`║ ${k.wahl.padEnd(16)} ${String(k.pos).padEnd(9)} ${String(k.oben).padStart(6)} ${String(k.unten).padStart(7)} ${String(k.hoehe).padStart(6)}`);
}
console.log('║\n║ Bildpunktfarbe (Mittel über 5 Spalten):');
const reihe = [];
for (let y = bild.hoehe - 130; y < bild.hoehe; y += 1) reihe.push({ y, c: mittel(y) });
for (const off of [-130, -110, -90, -70, -60, -50, -45, -40, -36, -34, -32, -28, -24, -20, -14, -10, -6, -2]) {
  const r = reihe.find((x) => x.y === bild.hoehe + off);
  if (r) console.log(`║   ${String(off).padStart(5)} px   rgb(${r.c.map((n) => String(n).padStart(3)).join(',')})  Helligkeit ${String(hell(r.c)).padStart(3)}`);
}
const kanten = [];
for (let i = 1; i < reihe.length; i += 1) {
  const d = Math.abs(reihe[i].c[0] - reihe[i - 1].c[0]) + Math.abs(reihe[i].c[1] - reihe[i - 1].c[1]) + Math.abs(reihe[i].c[2] - reihe[i - 1].c[2]);
  if (d >= 6) kanten.push({ y: reihe[i].y, off: reihe[i].y - bild.hoehe, von: reihe[i - 1].c, nach: reihe[i].c, d });
}
console.log(`║\n║ Harte Kanten (Δ≥6): ${kanten.length}`);
for (const k of kanten) console.log(`║   ${String(k.off).padStart(5)} px vom Rand:  rgb(${k.von.join(',')}) → rgb(${k.nach.join(',')})  Δ${k.d}`);
console.log(`║ Bild: ${pfad}\n`);
