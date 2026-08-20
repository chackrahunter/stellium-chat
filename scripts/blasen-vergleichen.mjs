/**
 * Was kostet der Weichzeichner im Hintergrund — und sieht man ihn überhaupt?
 *
 * Die Zerlegung hat gezeigt: die drei Farbblasen sind auf einer Maschine ohne
 * Grafikbeschleunigung mit Abstand der teuerste Teil der Oberfläche (15 statt
 * 42 Bildern je Sekunde). Auf einer Maschine MIT Beschleunigung kosten sie
 * nichts. Beide Aussagen sind wahr, und beide Maschinen gibt es beim Benutzer.
 *
 * Bevor daran etwas geändert wird, muss aber die andere Frage beantwortet
 * sein — Don sagt ausdrücklich: es darf nicht hässlicher werden. Also nicht
 * nur messen, was es kostet, sondern auch nachsehen, was man davon SIEHT.
 * Verglichen wird Bildpunkt für Bildpunkt gegen den heutigen Stand.
 *
 * Aufruf:  node scripts/blasen-vergleichen.mjs
 *          → Bilder in schirmbilder/blasen/, Zahlen auf der Kommandozeile
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { pngLesen } from './png-lesen.mjs';

/* Der fertige Bau, nicht der Entwicklungsserver — siehe die Begründung in
   fluessig-messen.mjs. */
const GEGEN_VITE = process.argv.includes('--entwicklung');
const APP_ENTWICKLUNG = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const ZIEL = 'schirmbilder/blasen';
fs.mkdirSync(ZIEL, { recursive: true });

/**
 * Die Kandidaten.
 *
 * `blur(70px)` auf einem Verlauf, der ohnehin schon bei 68 % auf durchsichtig
 * ausläuft, tut vor allem eines: er zieht den Rand noch weiter nach außen. Die
 * Frage ist, ob man das sieht — und ob ein Verlauf mit mehr Stufen dasselbe
 * ohne Weichzeichner schafft.
 */
const KANDIDATEN = [
  { name: '0-wie-es-ist', css: '' },
  { name: '1-blur-40', css: '.cosmos__blob{filter:blur(40px)!important}' },
  { name: '2-blur-24', css: '.cosmos__blob{filter:blur(24px)!important}' },
  { name: '3-ohne-blur', css: '.cosmos__blob{filter:none!important}' },
  {
    name: '4-weicher-verlauf',
    /* Ohne Weichzeichner, dafür der Verlauf selbst weicher: die Stufen bilden
       den glockenförmigen Abfall nach, den ein Weichzeichner erzeugt. Farbe
       und Deckkraft kommen aus denselben Marken wie vorher. */
    css: `.cosmos__blob{filter:none!important}
      .cosmos__blob--a{background:radial-gradient(circle,
        color-mix(in srgb, var(--violet) 100%, transparent) 0%,
        color-mix(in srgb, var(--violet) 88%, transparent) 20%,
        color-mix(in srgb, var(--violet) 62%, transparent) 38%,
        color-mix(in srgb, var(--violet) 34%, transparent) 55%,
        color-mix(in srgb, var(--violet) 14%, transparent) 72%,
        transparent 90%)!important}
      .cosmos__blob--b{background:radial-gradient(circle,
        color-mix(in srgb, var(--cyan) 100%, transparent) 0%,
        color-mix(in srgb, var(--cyan) 88%, transparent) 20%,
        color-mix(in srgb, var(--cyan) 62%, transparent) 38%,
        color-mix(in srgb, var(--cyan) 34%, transparent) 55%,
        color-mix(in srgb, var(--cyan) 14%, transparent) 72%,
        transparent 90%)!important}
      .cosmos__blob--c{background:radial-gradient(circle,
        color-mix(in srgb, var(--pink) 100%, transparent) 0%,
        color-mix(in srgb, var(--pink) 88%, transparent) 20%,
        color-mix(in srgb, var(--pink) 62%, transparent) 38%,
        color-mix(in srgb, var(--pink) 34%, transparent) 55%,
        color-mix(in srgb, var(--pink) 14%, transparent) 72%,
        transparent 92%)!important}`,
  },
];

const sekunden = (s) => s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
function cpuBaum(wurzel) {
  const zeit = new Map(); const kinder = new Map();
  for (const z of execFileSync('ps', ['-eo', 'pid=,ppid=,time=']).toString().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(z);
    if (!m) continue;
    zeit.set(Number(m[1]), sekunden(m[3]));
    if (!kinder.has(Number(m[2]))) kinder.set(Number(m[2]), []);
    kinder.get(Number(m[2])).push(Number(m[1]));
  }
  let summe = 0; const stapel = [wurzel];
  while (stapel.length) { const p = stapel.pop(); summe += zeit.get(p) ?? 0; for (const k of kinder.get(p) ?? []) stapel.push(k); }
  return summe;
}

/** Wie stark unterscheiden sich zwei Abzüge? In Stufen von 0 bis 255. */
function unterschied(a, b) {
  if (a.breite !== b.breite || a.hoehe !== b.hoehe) return null;
  let summe = 0; let groesster = 0; let betroffen = 0; let n = 0;
  /* Nicht jeden Bildpunkt: bei 1440×900 wären das 1,3 Millionen Aufrufe je
     Vergleich. Jeder zweite in beiden Richtungen reicht für eine Fläche, die
     ohnehin aus weichen Verläufen besteht. */
  for (let y = 0; y < a.hoehe; y += 2) {
    for (let x = 0; x < a.breite; x += 2) {
      const p = a.punkt(x, y); const q = b.punkt(x, y);
      const d = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
      summe += d; n += 1;
      if (d > groesster) groesster = d;
      if (d > 3) betroffen += 1;    // unter 3 Stufen sieht ein Mensch nichts
    }
  }
  return { mittel: summe / n, groesster, anteil: (betroffen / n) * 100 };
}

const probe = await probeserver();
/* Erst jetzt steht die Adresse fest: ohne --entwicklung ist es der
   Probeserver mit dem fertigen Bau. */
const APP = GEGEN_VITE ? APP_ENTWICKLUNG : probe.S;
/* Zweimal messen: einmal auf der Grafikkarte (so läuft es auf Dons Mac) und
   einmal ohne (so läuft es auf einer Maschine ohne Beschleunigung — Linux mit
   gesperrtem Treiber, virtuelle Maschinen, Fernzugriff). */
const MASCHINEN = [
  { name: 'ohne Grafikkarte', args: [] },
  { name: 'mit Grafikkarte', args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] },
];

const bilderProKandidat = {};
for (const maschine of MASCHINEN) {
  const server = await chromium.launchServer({ headless: true, args: maschine.args });
  const browser = await chromium.connect(server.wsEndpoint());
  const pid = server.process().pid;

  console.log(`\n  ── ${maschine.name} ──`);
  console.log('  Kandidat                fps (Leerlauf)   CPU ganzer Browser');
  console.log('  ' + '─'.repeat(58));

  for (const k of KANDIDATEN) {
    /* Der Entwicklungsserver lädt die Seite neu, sobald irgendwo eine Quelle
       angefasst wird — mitten in einer Messung ist der Zusammenhang dann weg
       und der Lauf bricht ab. Das ist kein Befund, sondern Werkstattlärm.
       Deshalb bis zu dreimal von vorn statt aufgeben. */
    let versuch = 0;
    for (;;) {
      try { await einenKandidaten(k); break; } catch (fehler) {
        versuch += 1;
        if (versuch >= 3) throw fehler;
        console.log(`     (${k.name}: Anlauf ${versuch} unterbrochen — ${String(fehler.message).split('\n')[0].slice(0, 60)})`);
      }
    }
  }

  async function einenKandidaten(k) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
    const p = await ctx.newPage();
    await p.goto(APP);
    await p.evaluate(([s, t]) => {
      localStorage.setItem('stellium.serverUrl', s);
      localStorage.setItem('stellium.token', t);
      localStorage.setItem('stellium.tourGesehen', 'ja');
    }, [probe.S, probe.token]);
    await p.reload();
    await p.waitForSelector('.app', { timeout: 25000 });
    await p.waitForTimeout(1200);
    if (k.css) await p.addStyleTag({ content: k.css });

    /* Für den Bildvergleich müssen die Blasen still stehen — sonst misst man
       den Zeitpunkt und nicht den Entwurf. */
    await p.addStyleTag({ content: '.cosmos__blob{animation-play-state:paused!important;animation-delay:-17s!important}' });
    await p.waitForTimeout(700);

    if (maschine.name === 'mit Grafikkarte') {
      const datei = `${ZIEL}/${k.name}.png`;
      await p.screenshot({ path: datei });
      bilderProKandidat[k.name] = datei;
    }

    const cpu0 = cpuBaum(pid);
    const ts = await p.evaluate(() => new Promise((fertig) => {
      const t = []; const l = (x) => { t.push(x); if (t.length < 180) requestAnimationFrame(l); else fertig(t); };
      requestAnimationFrame(l);
    }));
    const cpu1 = cpuBaum(pid);
    const spanne = (ts[ts.length - 1] - ts[0]) / 1000;
    const fps = Math.round(((ts.length - 1) / spanne) * 10) / 10;
    const cpu = Math.round(((cpu1 - cpu0) / spanne) * 1000) / 10;
    console.log(`  ${k.name.padEnd(24)} ${String(fps).padStart(8)}   ${String(cpu).padStart(16)} %`);
    await ctx.close();
  }
  await browser.close();
  await server.close();
}
await probe.stop();

console.log('\n  Wie sehr unterscheidet sich das Bild vom heutigen Stand?');
console.log('  (Ein Mensch bemerkt einen Unterschied ab etwa 3 Stufen von 255.)\n');
console.log('  Kandidat                  mittlere Abweichung   größte   Fläche über 3 Stufen');
console.log('  ' + '─'.repeat(76));
const vorlage = pngLesen(bilderProKandidat['0-wie-es-ist']);
for (const k of KANDIDATEN.slice(1)) {
  const d = unterschied(vorlage, pngLesen(bilderProKandidat[k.name]));
  if (!d) { console.log(`  ${k.name.padEnd(24)} — Größe passt nicht`); continue; }
  console.log(`  ${k.name.padEnd(24)} ${d.mittel.toFixed(2).padStart(19)}   ${String(d.groesster).padStart(6)}   ${d.anteil.toFixed(1).padStart(18)} %`);
}
console.log(`\n  Bilder liegen in ${ZIEL}/ — ansehen, nicht nur den Zahlen glauben.\n`);
