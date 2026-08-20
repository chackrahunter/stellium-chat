/**
 * Wohin geht die Rechenzeit beim Tippen? — Werkzeug, kein Prüflauf.
 *
 * Die Gesamtmessung sagt: rund 6 ms JavaScript je Anschlag auf einem schnellen
 * Mac. Auf einem Telefon, das ein Viertel davon leistet, sind das 24 ms — und
 * damit ist ein Einzelbild schon weg, bevor irgendetwas gezeichnet wurde.
 *
 * Wo die 6 ms hingehen, lässt sich nicht erraten. Deshalb hier der Profiler
 * aus dem Chrome-Protokoll: er zählt, in welcher Funktion die Zeit wirklich
 * verbracht wurde. Ausgegeben wird die Eigenzeit — nicht die Zeit inklusive
 * aufgerufener Funktionen, denn sonst steht ganz oben immer nur „React".
 *
 * Aufruf:  node scripts/tippen-profil.mjs [--bremse 4]
 */
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { verlaufSaeen } from './verlauf-saeen.mjs';
import { WS_PROTOCOL_VERSION } from '../packages/shared/dist/index.js';

/* Der fertige Bau, nicht der Entwicklungsserver — siehe fluessig-messen.mjs. */
const GEGEN_VITE = process.argv.includes('--entwicklung');
const APP_ENTWICKLUNG = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const BREMSE = Number(arg('--bremse') ?? 1);

const probe = await probeserver();
/* Erst jetzt steht die Adresse fest: ohne --entwicklung ist es der
   Probeserver mit dem fertigen Bau. */
const APP = GEGEN_VITE ? APP_ENTWICKLUNG : probe.S;
const saat = await verlaufSaeen(probe, 60, WS_PROTOCOL_VERSION);
console.log(`  Verlauf gesät: ${saat.anzahl} Nachrichten`);
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);

await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [probe.S, probe.token]);
await p.reload();
await p.waitForSelector('.app', { timeout: 25000 });
await p.waitForTimeout(1500);

await p.waitForTimeout(1200);

await p.click('textarea');
await p.waitForTimeout(300);
if (BREMSE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: BREMSE });

await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });   // 0,1 ms
await cdp.send('Profiler.start');
await p.keyboard.type('Guten Morgen zusammen, kurze Rueckmeldung zum Termin', { delay: 55 });
const { profile } = await cdp.send('Profiler.stop');

/* Eigenzeit je Funktion. Die Zeitstempel im Profil sind Mikrosekunden zwischen
   zwei Stichproben — jede Stichprobe wird ihrem Knoten gutgeschrieben. */
const knoten = new Map(profile.nodes.map((n) => [n.id, n]));
const eigen = new Map();
for (let i = 0; i < profile.samples.length; i += 1) {
  const dauer = (profile.timeDeltas[i] ?? 0) / 1000;         // ms
  const n = knoten.get(profile.samples[i]);
  if (!n) continue;
  const f = n.callFrame;
  const datei = (f.url || '').split('/').slice(-1)[0].split('?')[0];
  const name = `${f.functionName || '(anonym)'}${datei ? `  ${datei}:${f.lineNumber + 1}` : ''}`;
  eigen.set(name, (eigen.get(name) ?? 0) + dauer);
}

const gesamt = [...eigen.values()].reduce((a, b) => a + b, 0);
const sortiert = [...eigen.entries()].sort((a, b) => b[1] - a[1]);
const anschlaege = 51;

console.log(`\n  Tippen, ${anschlaege} Anschläge${BREMSE > 1 ? `, CPU ${BREMSE}× gebremst` : ''}`);
console.log(`  JavaScript zusammen: ${gesamt.toFixed(1)} ms  →  ${(gesamt / anschlaege).toFixed(2)} ms je Anschlag\n`);
console.log('  Eigenzeit   je Anschlag   Funktion');
console.log('  ' + '─'.repeat(88));
for (const [name, ms] of sortiert.slice(0, 22)) {
  if (ms < 0.4) break;
  console.log(`  ${(ms.toFixed(1) + ' ms').padStart(9)}   ${((ms / anschlaege).toFixed(2) + ' ms').padStart(11)}   ${name.slice(0, 62)}`);
}

await browser.close();
await probe.stop();
console.log('');
