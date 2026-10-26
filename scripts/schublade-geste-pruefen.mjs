/**
 * Folgt die Schublade auf dem Telefon dem Finger?
 *
 *     node scripts/schublade-geste-pruefen.mjs
 *
 * Bringt einen Probeserver mit und braucht Google Chrome von Playwright.
 * Die Berührungen gehen über das Entwicklerprotokoll (Input.dispatchTouchEvent)
 * — sie kommen beim Browser an wie ein echter Finger, mit echten Zeitstempeln.
 * Davon hängt die Prüfung ab: ob ein Wisch reicht, entscheidet das Tempo.
 *
 * Wer an lib/schublade-geste.ts oder der Schublade in mobil.css dreht, prüft
 * damit.
 */
import { chromium, devices } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const probe = await probeserver();
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE' });
const p = await ctx.newPage();
p.on('pageerror', (f) => console.log('  ⚠ Seitenfehler:', f.message));
await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [probe.S, probe.token]);
await p.reload();
await p.waitForSelector('.app > .sidebar', { state: 'attached', timeout: 20000 });
await p.waitForTimeout(800);
const cdp = await ctx.newCDPSession(p);

const pause = (ms) => new Promise((f) => setTimeout(f, ms));
const beruehren = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
});
/** Von (x0,y0) nach (x1,y1) in `schritte` Schritten, `ms` zwischen den Schritten. */
async function wisch(x0, y0, x1, y1, { schritte = 12, ms = 16, loslassen = true } = {}) {
  await beruehren('touchStart', x0, y0);
  for (let i = 1; i <= schritte; i++) {
    await pause(ms);
    await beruehren('touchMove', x0 + ((x1 - x0) * i) / schritte, y0 + ((y1 - y0) * i) / schritte);
  }
  if (loslassen) await beruehren('touchEnd');
}
const offen = () => p.evaluate(() => document.querySelector('.app').classList.contains('app--schublade'));
const stellung = () => p.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.app > .sidebar')).transform).m41);
const breite = await p.evaluate(() => document.querySelector('.app > .rail').offsetWidth + document.querySelector('.app > .sidebar').offsetWidth);
const ausrollen = () => pause(550);
/* Die Schnipser unten sind 90 px lang — weniger als die halbe Breite, also
   entscheidet allein der Schwung. Kürzer wäre auf einem ausgelasteten Rechner
   unzuverlässig: dort kommen die Berührungen über das Protokoll so spät an,
   dass der „Finger" wirklich langsam ist. Ein Gerät stempelt die Zeit selbst. */

let fehler = 0;
function pruefe(name, ok, detail = '') {
  console.log(ok ? '  ✓' : '  ✗', name, ok ? '' : detail);
  if (!ok) fehler++;
}

console.log(`\nSchublade (Breite ${breite}px)\n`);

await wisch(120, 400, 320, 400);
await ausrollen();
pruefe('Mitten im Gespräch aufgesetzt öffnet nichts', !(await offen()));

await wisch(4, 400, 140, 400, { loslassen: false });
const mitte = await stellung();
const schleier = Number(await p.evaluate(() => getComputedStyle(document.querySelector('.schublade-schleier')).opacity));
pruefe('Vom Rand gezogen folgt sie dem Finger', mitte > -breite + 100 && mitte < 0, `Stellung ${mitte}`);
pruefe('… und der Schleier dunkelt im selben Maß ab', schleier > 0.2 && schleier < 0.95, `Deckkraft ${schleier}`);
await beruehren('touchEnd');
await ausrollen();
pruefe('Losgelassen über der Hälfte geht sie ganz auf', await offen());
pruefe('… und steht danach genau offen', Math.abs(await stellung()) < 1, `Stellung ${await stellung()}`);

await wisch(200, 400, 200 + 180, 400, { loslassen: false });
const ueber = await stellung();
pruefe('Über offen hinaus gibt sie nur gedämpft nach', ueber > 0 && ueber < 180 * 0.55, `Stellung ${ueber}`);
await beruehren('touchEnd');
await ausrollen();
pruefe('… und federt zurück', Math.abs(await stellung()) < 1);

await wisch(200, 300, 205, 600, { schritte: 10 });
await ausrollen();
pruefe('Senkrecht gescrollt bleibt sie offen und still', (await offen()) && Math.abs(await stellung()) < 1);

await wisch(220, 400, 160, 400, { schritte: 30, ms: 20 });
await ausrollen();
pruefe('Langsam ein Stück zurück bleibt sie offen', await offen());

await wisch(220, 400, 130, 400, { schritte: 3, ms: 10 });
await ausrollen();
pruefe('Ein kurzer Schnipser schließt sie', !(await offen()));
pruefe('… ganz', Math.abs((await stellung()) + breite) < 1, `Stellung ${await stellung()}`);

await wisch(4, 400, 94, 400, { schritte: 3, ms: 10 });
await ausrollen();
pruefe('Ein kurzer Schnipser vom Rand öffnet sie', await offen());

// Mitten im Zuklappen wieder zufassen: sie bleibt, wo sie ist.
await wisch(220, 400, 130, 400, { schritte: 3, ms: 10 });
/* Nicht nach fester Zeit greifen: unter Last läuft der Übergang später an,
   und nach 60 ms stand sie mal noch fast offen. Gewartet wird, bis sie
   wirklich unterwegs ist. */
let imLauf = await stellung();
for (let i = 0; i < 40 && imLauf > -breite * 0.2; i++) { await pause(5); imLauf = await stellung(); }
await beruehren('touchStart', 150, 400);
await pause(16);
await beruehren('touchMove', 150, 412);
await pause(16);
await beruehren('touchMove', 162, 412);
const gegriffen = await stellung();
await pause(250);
const gehalten = await stellung();
/* Zwischen dem Ablesen von `imLauf` und dem Aufsetzen vergehen einige
   Millisekunden, in denen sie weiterläuft — gegriffen liegt deshalb etwas
   weiter Richtung zu. Entscheidend ist: weder Sprung zurück noch weiter zu,
   sondern sie bleibt unter dem Finger stehen. */
pruefe('Im Lauf gegriffen bleibt sie unter dem Finger stehen',
  imLauf < -5 && imLauf > -breite + 5 && gegriffen <= imLauf + 13 && gegriffen > -breite + 5 && Math.abs(gehalten - gegriffen) < 1,
  `im Lauf ${imLauf}, gegriffen ${gegriffen}, 250 ms später ${gehalten}`);
await beruehren('touchMove', 300, 412);
await beruehren('touchEnd');
await ausrollen();
pruefe('… und lässt sich zurück aufziehen', await offen());

await browser.close();
await probe.stop();
console.log(fehler ? `\n✗ ${fehler} Prüfung(en) fehlgeschlagen\n` : '\n✓ Alles in Ordnung\n');
process.exit(fehler ? 1 : 0);
