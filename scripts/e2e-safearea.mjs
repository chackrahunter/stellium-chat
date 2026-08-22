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

/* KEINE GERÄTERÄNDER MEHR EINSETZEN — sie kommen so nicht vor.
   Hier stand `--sicher-oben: 59px; --sicher-unten: 34px`, "so wie ein iPhone
   sie meldet". Das galt, solange `viewport-fit=cover` im Kopf der Seite
   stand. Seit das draußen ist, meldet `env(safe-area-inset-*)` auf JEDEM
   Gerät 0 — Safari setzt die Seite selbst unter die Statusleiste, statt sie
   darunter malen zu lassen. Wer hier 59 px einsetzt, prüft ein Layout, das
   ausgeliefert nie entsteht.
   Die Messung darunter bleibt richtig und wird nur nicht mehr verstellt:
   deckt der Hintergrund den Bildbereich bis an alle vier Ränder? */
await p.waitForTimeout(900);

/* WAS HIER FRÜHER GEMESSEN WURDE — UND WARUM ES NICHTS SAGTE
   Der Leser stieg vom Element unter dem Punkt so lange nach oben, bis er einen
   nicht durchsichtigen Vorfahren fand, und meldete dessen Farbe. `body` ist in
   app.css ausdrücklich durchsichtig, `html` trägt den Verlauf — der Aufstieg
   endete also für jeden der vier Punkte bei `html` und meldete jedes Mal
   dieselbe Farbe. Ob der Browser an dieser Stelle wirklich etwas malt, kam
   dabei nie zur Sprache. Die Überschrift versprach „die Farbe an den Rändern
   wird wirklich ausgelesen"; ausgelesen wurde ein berechneter Stilwert.

   Gemessen wird jetzt am Abzug: ein Bildschirmfoto, und daraus die Pixel an
   den vier Rändern. Das ist, was ein Mensch sieht. */
const abzug = 'schirmbilder/safearea.png';
await p.screenshot({ path: abzug });
const { pngLesen } = await import('./png-lesen.mjs');
const bild = pngLesen(abzug);

const farben = (() => {
  const lies = (x, y, name) => {
    const p3 = bild.punkt(Math.max(0, Math.min(bild.breite - 1, Math.round(x))),
      Math.max(0, Math.min(bild.hoehe - 1, Math.round(y))));
    return {
      punkt: name,
      element: `${Math.round(x)},${Math.round(y)}`,
      farbe: p3 ? `rgb(${p3[0]}, ${p3[1]}, ${p3[2]})` : 'keine',
    };
  };
  const h = bild.hoehe, w = bild.breite;
  return [lies(w / 2, 2, 'oben'), lies(w / 2, h - 3, 'unten'), lies(2, h / 2, 'links'), lies(w - 3, h / 2, 'rechts')];
})();

console.log('\nFarbe an den Rändern (iPhone-Ränder eingesetzt)');
for (const f of farben) console.log(`  ${f.punkt.padEnd(10)} ${f.element.padEnd(24)} ${f.farbe}`);
const unlesbar = farben.filter((f) => f.farbe === 'keine');
const schwarz = farben.filter((f) => f.farbe === 'rgb(0, 0, 0)');
console.log(schwarz.length
  ? `\n✗ ${schwarz.length} Rand${schwarz.length > 1 ? 'bereiche' : 'bereich'} ohne Farbe — dort bleibt es schwarz.`
  : '\n✓ Alle Ränder tragen die Hintergrundfarbe.');

await b.close();
await probe.stop();

/* Und ein Rückgabewert. Bisher endete diese Datei ohne einen — was auch immer
   an den Rändern stand, der Lauf war grün. Ein unlesbarer Punkt zählt dabei
   als Fehlschlag und nicht als Übersprung: er heißt, dass hier nichts gemessen
   wurde, und das ist schlimmer als ein schwarzer Rand, den man sieht. */
if (unlesbar.length) {
  console.log(`✗ ${unlesbar.length} Punkt(e) waren nicht lesbar — es wurde nichts gemessen.`);
}
process.exit(schwarz.length || unlesbar.length ? 1 : 0);
