/**
 * Ist der dunkle Streifen unter dem Eingabefeld weg?
 *
 * Geprüft werden drei Dinge, und nur die dritte ist neu:
 *
 *   1. Malt die Seite selbst irgendwo eine harte Kante im unteren Bereich?
 *      (Sie tat es nie — das ist die Gegenprobe, damit die Änderung nicht
 *      versehentlich eine erzeugt.)
 *
 *   2. Sieht die Seite noch genauso aus wie vorher? Verglichen wird Zeile für
 *      Zeile gegen einen früheren Abzug. Die Änderung darf am Bild nichts
 *      ändern — .cosmos deckt die Seite vollständig ab.
 *
 *   3. Und der eigentliche Punkt: die flache Hintergrundfarbe der Seite. Sie
 *      ist das Einzige, was ein Browser für die Flächen nehmen kann, die er
 *      selbst füllt — hinter der Wischleiste, unter der Symbolleiste, beim
 *      Gummiband. Verläufe kann er dort nicht malen. Ist diese Farbe fast
 *      schwarz, während die Seite daneben schimmert, entsteht genau der
 *      Streifen mit der scharfen Kante. Die Prüfung fordert: der Abstand
 *      zwischen dieser Farbe und der untersten Bildpunktzeile der Seite ist
 *      klein genug, dass man die Grenze nicht mehr sieht.
 *
 * Aufruf:  node scripts/streifen-pruefen.mjs [--gegen /tmp/streifen-vorher-B.png]
 */
import { webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { pngLesen, hell } from './png-lesen.mjs';
import fs from 'node:fs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const i = process.argv.indexOf('--gegen');
const GEGEN = i > -1 ? process.argv[i + 1] : '/tmp/streifen-vorher-B.png';
const BILD = '/tmp/streifen-nachher.png';

/* Der Probeserver würfelt seinen Port; auf einer belegten Maschine trifft er
   einen besetzten. Deshalb mehrere Anläufe. */
async function probeserverMitAnlaeufen(versuche = 6) {
  let letzter;
  for (let n = 0; n < versuche; n += 1) {
    try { return await probeserver(); } catch (f) { letzter = f; await new Promise((r) => setTimeout(r, 400)); }
  }
  throw letzter;
}

const probe = await probeserverMitAnlaeufen();
const b = await webkit.launch({ headless: true });
const ctx = await b.newContext({
  ...devices['iPhone 15 Pro'],
  viewport: { width: 402, height: 874 },   // iPhone 16/17 Pro in Punkten
  deviceScaleFactor: 1,
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
// So meldet ein iPhone 16/17 Pro seine Ränder.
await p.addStyleTag({ content: ':root { --sicher-oben: 59px; --sicher-unten: 34px; --sicher-links: 0px; --sicher-rechts: 0px; }' });
// Sterne und Drift anhalten — sonst rauscht jede Farbmessung.
await p.addStyleTag({ content: '.cosmos__stars { display: none !important; } .cosmos__blob { animation: none !important; }' });
await p.waitForTimeout(900);

const mass = await p.evaluate(() => {
  const c = document.querySelector('.cosmos').getBoundingClientRect();
  const r = document.querySelector('.rahmen').getBoundingClientRect();
  return {
    innerHeight: window.innerHeight,
    /* Das ist die Farbe, die der Browser für seine eigenen Ränder nimmt.
       Verläufe stehen in background-image und zählen dort nicht mit. */
    randfarbe: getComputedStyle(document.documentElement).backgroundColor,
    cosmos: { oben: Math.round(c.top), unten: Math.round(c.bottom) },
    rahmen: { oben: Math.round(r.top), unten: Math.round(r.bottom) },
  };
});

await p.screenshot({ path: BILD });
await b.close();
await probe.stop();

const bild = pngLesen(BILD);
const SPALTEN = [30, 130, 201, 300, 380];
const mittel = (bl, y) => {
  const s = [0, 0, 0];
  for (const x of SPALTEN) { const c = bl.punkt(x, y); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
  return s.map((n) => Math.round(n / SPALTEN.length));
};
const zahl = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);

console.log(`\n╔═══ Streifen-Prüfung ═══ Bild ${bild.breite}×${bild.hoehe}`);
console.log(`║ innerHeight ${mass.innerHeight}`);
console.log(`║ .cosmos  ${mass.cosmos.oben} … ${mass.cosmos.unten}   (reicht ${mass.cosmos.unten - mass.innerHeight} px über den Rand hinaus)`);
console.log(`║ .rahmen  ${mass.rahmen.oben} … ${mass.rahmen.unten}   (Fenster ${mass.innerHeight})`);

/* ── 1. Harte Kanten unterhalb des Eingabefelds ───────────────── */
const wrapUnterkante = bild.hoehe - 40;   // knapp unter dem Rahmen des Eingabefelds
const reihe = [];
for (let y = wrapUnterkante; y < bild.hoehe; y += 1) reihe.push({ y, c: mittel(bild, y) });
/* Eine Kante ist nicht „irgendein Unterschied" — ein Verlauf ändert sich ja
   von Zeile zu Zeile. Eine Kante ist ein Ausreißer: ein Sprung, der weit über
   dem liegt, was der Verlauf ringsum tut. Deshalb wird gegen den Mittelwert
   der Zeilenunterschiede gemessen, nicht gegen eine feste Zahl. */
const stufen = [];
for (let n = 1; n < reihe.length; n += 1) {
  stufen.push({
    off: reihe[n].y - bild.hoehe, von: reihe[n - 1].c, nach: reihe[n].c,
    d: Math.abs(reihe[n].c[0] - reihe[n - 1].c[0])
     + Math.abs(reihe[n].c[1] - reihe[n - 1].c[1])
     + Math.abs(reihe[n].c[2] - reihe[n - 1].c[2]),
  });
}
const sortiert = [...stufen].map((s) => s.d).sort((a, b) => a - b);
const mitte = sortiert[Math.floor(sortiert.length / 2)];
const kanten = stufen.filter((s) => s.d >= 20 && s.d >= 4 * Math.max(mitte, 1));
console.log('║\n║ 1) Verlauf im Sicherheitsbereich (unter dem Eingabefeld):');
for (const off of [-40, -34, -28, -20, -12, -6, -1]) {
  const r = reihe.find((x) => x.y === bild.hoehe + off);
  if (r) console.log(`║      ${String(off).padStart(4)} px   rgb(${r.c.map((n) => String(n).padStart(3)).join(',')})  Helligkeit ${String(hell(r.c)).padStart(3)}`);
}
console.log(kanten.length
  ? `║    ✗ ${kanten.length} harte Kante(n): ${kanten.map((k) => `${k.off}px Δ${k.d}`).join(', ')}`
  : `║    ✓ Kein Sprung — nur der Verlauf. Größter Zeilenschritt Δ${sortiert[sortiert.length - 1]}, üblich Δ${mitte}.`);

/* ── 2. Hat sich das Bild der Seite geändert? ─────────────────── */
let bildGleich = null;
if (fs.existsSync(GEGEN)) {
  const alt = pngLesen(GEGEN);
  if (alt.breite === bild.breite && alt.hoehe === bild.hoehe) {
    let groesster = 0, wo = 0;
    for (let y = 0; y < bild.hoehe; y += 1) {
      const a = mittel(alt, y), n = mittel(bild, y);
      const d = Math.abs(a[0] - n[0]) + Math.abs(a[1] - n[1]) + Math.abs(a[2] - n[2]);
      if (d > groesster) { groesster = d; wo = y; }
    }
    bildGleich = groesster <= 3;
    console.log(`║\n║ 2) Gegen ${GEGEN}: größter Zeilenunterschied Δ${groesster} (bei y=${wo})`);
    console.log(bildGleich
      ? '║    ✓ Die Seite sieht unverändert aus — die Änderung greift nur dort, wo der Browser malt.'
      : '║    ✗ Die Seite hat sich verändert.');
  }
} else {
  console.log(`║\n║ 2) Kein Vergleichsbild unter ${GEGEN} — übersprungen.`);
}

/* ── 3. Die Farbe der browsereigenen Ränder ───────────────────── */
const rand = zahl(mass.randfarbe);
const unten = reihe.find((x) => x.y === bild.hoehe - 1).c;
const abstand = Math.abs(hell(rand) - hell(unten));
console.log('║\n║ 3) Farbe, mit der der Browser seine eigenen Ränder füllt:');
console.log(`║      Randfarbe der Seite   rgb(${rand.join(',')})   Helligkeit ${hell(rand)}`);
console.log(`║      unterste Zeile        rgb(${unten.join(',')})   Helligkeit ${hell(unten)}`);
console.log(`║      Abstand               ${abstand}`);
const randGut = abstand <= 6;
console.log(randGut
  ? '║    ✓ Rand und Seite sind gleich hell — dort kann keine sichtbare Kante mehr entstehen.'
  : `║    ✗ Der Rand ist um ${abstand} Stufen ${hell(rand) < hell(unten) ? 'dunkler' : 'heller'} als die Seite — genau das ergibt den Streifen.`);

const gut = kanten.length === 0 && randGut && bildGleich !== false;
console.log(`║\n║ Bild: ${BILD}`);
console.log(gut ? '╚═══ ✓ bestanden\n' : '╚═══ ✗ durchgefallen\n');
process.exit(gut ? 0 : 1);
