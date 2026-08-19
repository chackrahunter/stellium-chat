/**
 * Wer malt den dunklen Streifen ganz unten?
 *
 * Berechnete Stile taugen dafür nicht. getComputedStyle(el).backgroundColor
 * läuft, wenn man sie über die Elternkette hochsucht, an jedem
 * Geschwisterelement vorbei — und genau der Hintergrund (.cosmos) ist ein
 * Geschwister von .rahmen, kein Vorfahre. Deshalb wird hier zweierlei
 * gemessen: die echten Kästen aller beteiligten Flächen, und die wirkliche
 * Farbe einzelner Bildpunktzeilen aus einem Bildschirmabzug.
 *
 * Aufruf:  node scripts/streifen-messen.mjs [--marke name]
 */
import { webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { pngLesen } from './png-lesen.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const MARKE = (process.argv[process.argv.indexOf('--marke') + 1] ?? 'vorher').replace(/[^a-z0-9-]/gi, '');

/* Der Probeserver würfelt seinen Port. Auf einer Maschine, auf der schon
   andere Läufe stehen, trifft er einen besetzten und redet mit dem falschen
   Server. Deshalb mehrere Anläufe. */
async function probeserverMitAnlaeufen(versuche = 6) {
  let letzter;
  for (let i = 0; i < versuche; i += 1) {
    try { return await probeserver(); } catch (f) { letzter = f; await new Promise((r) => setTimeout(r, 400)); }
  }
  throw letzter;
}

const SICHER = ':root { --sicher-oben: 59px; --sicher-unten: 34px; --sicher-links: 0px; --sicher-rechts: 0px; }';
const RUHIG = '.cosmos__blob { animation: none !important; }';

/* Die Versuchsreihe. Jeder Eintrag ändert genau eine Sache — so lässt sich
   zuordnen, woran der Streifen hängt. */
const VERSUCHE = [
  { name: 'A · ohne Geräteränder',      css: [RUHIG] },
  { name: 'B · mit Geräteränder 59/34', css: [SICHER, RUHIG] },
  { name: 'C · Ränder, .cosmos aus',    css: [SICHER, RUHIG, '.cosmos { display: none !important; }'] },
  { name: 'D · Ränder, ohne contain',   css: [SICHER, RUHIG, '.cosmos { contain: none !important; }'] },
  { name: 'E · Ränder, .cosmos bündig', css: [SICHER, RUHIG, '.cosmos { inset: 0 !important; }'] },
];

const probe = await probeserverMitAnlaeufen();
const b = await webkit.launch({ headless: true });
const ctx = await b.newContext({
  ...devices['iPhone 15 Pro'],
  viewport: { width: 402, height: 874 },   // iPhone 16/17 Pro in Punkten
  deviceScaleFactor: 1,                    // ein Bildpunkt im Bild = ein Punkt im Fenster
  locale: 'de-DE',
});
const p = await ctx.newPage();
await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [probe.S, probe.token]);

const SPALTEN = [30, 130, 201, 300, 380];
const ergebnisse = [];

for (const v of VERSUCHE) {
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  // Sterne aus: sie funkeln und machen jede Farbmessung verrauscht.
  await p.addStyleTag({ content: '.cosmos__stars { display: none !important; }' });
  for (const c of v.css) await p.addStyleTag({ content: c });
  await p.waitForTimeout(700);

  const kaesten = await p.evaluate(() => {
    const namen = ['html', 'body', '#root', '.cosmos', '.rahmen', '.app', '.main', '.stream', '.composer-wrap', '.composer'];
    const mass = (wahl) => {
      const el = wahl === 'html' ? document.documentElement
        : wahl === 'body' ? document.body : document.querySelector(wahl);
      if (!el) return { wahl, fehlt: true };
      const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return {
        wahl,
        oben: Math.round(r.top * 10) / 10, unten: Math.round(r.bottom * 10) / 10,
        hoehe: Math.round(r.height * 10) / 10,
        pos: s.position, contain: s.contain,
        hg: s.backgroundColor, bild: s.backgroundImage === 'none' ? '—' : 'verlauf',
      };
    };
    return { innerHeight: window.innerHeight, kaesten: namen.map(mass) };
  });

  const pfad = `/tmp/streifen-${MARKE}-${v.name[0]}.png`;
  await p.screenshot({ path: pfad });
  const bild = pngLesen(pfad);

  /* Harte Kanten suchen: eine Zeile, die sich stark von der darüber
     unterscheidet, obwohl ringsum nur ein Verlauf sein sollte. Gemittelt über
     mehrere Spalten, damit der Rahmen des Eingabefelds nicht als Kante zählt. */
  const mittel = (y) => {
    const s = [0, 0, 0];
    for (const x of SPALTEN) { const c = bild.punkt(x, y); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
    return s.map((n) => Math.round(n / SPALTEN.length));
  };
  const reihe = [];
  for (let y = bild.hoehe - 120; y < bild.hoehe; y += 1) reihe.push({ y, c: mittel(y) });
  const kanten = [];
  for (let i = 1; i < reihe.length; i += 1) {
    const d = Math.abs(reihe[i].c[0] - reihe[i - 1].c[0])
            + Math.abs(reihe[i].c[1] - reihe[i - 1].c[1])
            + Math.abs(reihe[i].c[2] - reihe[i - 1].c[2]);
    if (d >= 6) kanten.push({ y: reihe[i].y, von: reihe[i - 1].c, nach: reihe[i].c, d });
  }
  ergebnisse.push({ v, kaesten, bild, reihe, kanten, pfad });
}

await b.close();
await probe.stop();

const hell = (c) => Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);

for (const e of ergebnisse) {
  console.log(`\n╔═══ ${e.v.name} ═══ ${e.bild.breite}×${e.bild.hoehe} ═══`);
  console.log('║ Auswahl          pos       contain    oben     unten    Höhe   Hintergrund');
  for (const k of e.kaesten.kaesten) {
    if (k.fehlt) { console.log(`║ ${k.wahl.padEnd(16)} fehlt`); continue; }
    console.log(`║ ${k.wahl.padEnd(16)} ${String(k.pos).padEnd(9)} ${String(k.contain).padEnd(10)} ${String(k.oben).padStart(7)} ${String(k.unten).padStart(8)} ${String(k.hoehe).padStart(6)}   ${k.hg} ${k.bild}`);
  }
  console.log('║');
  const zeig = [-120, -100, -80, -60, -50, -45, -42, -40, -36, -34, -30, -20, -10, -4, -1];
  console.log('║ Bildpunktfarbe (Mittel über 5 Spalten), Abstand vom unteren Rand:');
  for (const off of zeig) {
    const r = e.reihe.find((x) => x.y === e.bild.hoehe + off);
    if (r) console.log(`║   ${String(off).padStart(5)} px   rgb(${r.c.map((n) => String(n).padStart(3)).join(',')})   Helligkeit ${String(hell(r.c)).padStart(3)}`);
  }
  console.log(`║ Harte Kanten (Δ≥6) in den letzten 120 Zeilen: ${e.kanten.length}`);
  for (const k of e.kanten) {
    console.log(`║   y=${k.y}  (${k.y - e.bild.hoehe} vom Rand)  rgb(${k.von.join(',')}) → rgb(${k.nach.join(',')})  Δ${k.d}`);
  }
  console.log(`║ Bild: ${e.pfad}`);
}

/* Vergleich B gegen C: so sieht der Bereich aus, wenn .cosmos ihn NICHT malt. */
const B = ergebnisse.find((e) => e.v.name.startsWith('B'));
const C = ergebnisse.find((e) => e.v.name.startsWith('C'));
if (B && C) {
  console.log('\n╔═══ Vergleich: was fehlt ohne .cosmos? ═══');
  for (const off of [-200, -100, -50, -20, -4]) {
    const y = B.bild.hoehe + off;
    const mb = B.reihe.find((x) => x.y === y)?.c ?? B.bild.punkt(201, y);
    const mc = C.reihe.find((x) => x.y === y)?.c ?? C.bild.punkt(201, y);
    console.log(`║ ${String(off).padStart(5)} px vom Rand:  mit .cosmos rgb(${mb.join(',')}) Hell ${hell(mb)}   ohne .cosmos rgb(${mc.join(',')}) Hell ${hell(mc)}`);
  }
}
console.log('');
