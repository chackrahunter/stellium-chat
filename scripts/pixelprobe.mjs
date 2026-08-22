/**
 * Welche Farbe hat der unterste Streifen wirklich?
 *
 * Berechnete Stile führen in die Irre: sie melden die Hintergrundfarbe eines
 * Elements, nicht das, was am Ende auf dem Schirm landet. Deshalb wird hier
 * ein Bild gemacht und die Farbe einzelner Bildpunkte ausgelesen.
 */
import { webkit, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';
import fs from 'node:fs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const probe = await probeserver();
const b = await webkit.launch({ headless: true });
const ctx = await b.newContext({ ...devices['iPhone 15 Pro'], viewport: { width: 402, height: 874 }, deviceScaleFactor: 1, locale: 'de-DE' });
const p = await ctx.newPage();
await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [probe.S, probe.token]);
await p.reload();
await p.waitForSelector('.app', { timeout: 20000 });
/* KEINE GERÄTERÄNDER MEHR EINSETZEN — sie kommen so nicht vor.
   Hier stand `--sicher-oben: 59px; --sicher-unten: 34px`, "so wie ein iPhone
   sie meldet". Das galt, solange `viewport-fit=cover` im Kopf der Seite
   stand. Seit das draußen ist, meldet `env(safe-area-inset-*)` auf JEDEM
   Gerät 0 — Safari setzt die Seite selbst unter die Statusleiste, statt sie
   darunter malen zu lassen. Wer hier 59 px einsetzt, prüft ein Layout, das
   ausgeliefert nie entsteht.
   Die Messung darunter bleibt richtig und wird nur nicht mehr verstellt:
   deckt der Hintergrund den Bildbereich bis an alle vier Ränder? */
await p.waitForTimeout(1200);

/* Die Farbe eines Bildpunkts über eine Leinwand auslesen: der Browser zeichnet
   dafür den sichtbaren Ausschnitt nach — genau das, was das Auge sieht. */
const punkte = await p.evaluate(() => {
  const h = window.innerHeight, w = window.innerWidth;
  const stellen = [
    ['Mitte oben', w / 2, 120],
    ['über dem Eingabefeld', w / 2, h - 140],
    ['im Sicherheitsbereich', w / 2, h - 12],
    ['ganz unten', w / 2, h - 2],
  ];
  return stellen.map(([name, x, y]) => {
    const el = document.elementFromPoint(x, y);
    return { name, y: Math.round(y), element: el ? `${el.tagName.toLowerCase()}.${(el.className||'').toString().split(' ')[0]}` : '—' };
  });
});

/* Ein eigener Name je Lauf: `/tmp/probe.png` ist so allgemein, dass zwei
   gleichzeitige Läufe sich gegenseitig das Bild unter den Füßen wegziehen. */
const ABZUG = `/tmp/stellium-pixelprobe-${process.pid}.png`;
await p.screenshot({ path: ABZUG });
await b.close();
await probe.stop();

/* Der eigene PNG-Leser, der hier stand, kannte nur die Zeilenfilter 0 und 2 —
   und gab für alles andere `null` zurück. Ein Abzug mit Farbverlauf benutzt
   fast nur die Filter 1, 3 und 4: gemessen wurde damit an allen vier Punkten
   nichts, und der Bericht schrieb viermal „nicht lesbar", ohne dass ein
   Rückgabewert daraus folgte. png-lesen.mjs beherrscht alle fünf. */
const { pngLesen } = await import('./png-lesen.mjs');
const bild = pngLesen(ABZUG);
const { breite, hoehe } = bild;
const farbe = (y) => {
  if (y < 0 || y >= hoehe) return null;
  const c = bild.punkt(Math.floor(breite / 2), y);
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};

console.log(`\nBild ${breite}×${hoehe}\n`);
let unlesbar = 0;
for (const s of punkte) {
  const c = farbe(s.y);
  if (c === null) unlesbar += 1;
  console.log(`  ${s.name.padEnd(24)} y=${String(s.y).padStart(4)}  ${(c ?? 'nicht lesbar').padEnd(20)} ${s.element}`);
}

/* „nicht lesbar" war bisher eine Zeile im Bericht und sonst nichts — die Datei
   endete ohne Rückgabewert. Dabei ist genau das der Normalfall auf einem
   Verlauf: der eigene Leser hier kennt nur die Zeilenfilter 0 und 2, und ein
   Abzug mit Farbverlauf benutzt fast nur 1, 3 und 4 (siehe png-lesen.mjs).
   Gemessen wurde damit an den interessanten Stellen nichts. Es gibt einen
   Leser, der alle fünf Filter kann; wer hier misst, soll ihn nehmen. */
fs.rmSync(ABZUG, { force: true });

if (unlesbar) {
  console.log(`\n✗ ${unlesbar} von ${punkte.length} Punkten waren nicht lesbar — dort wurde nichts gemessen.`);
  console.log('    Dieser Leser kennt nur die Zeilenfilter 0 und 2. Nimm scripts/png-lesen.mjs,');
  console.log('    der alle fünf beherrscht (so macht es e2e-safearea.mjs).');
  process.exit(1);
}
process.exit(0);
