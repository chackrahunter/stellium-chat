#!/usr/bin/env node
/**
 * Fernsteuerung mit dem Finger — die Umrechnung in
 * packages/desktop/src/lib/fern-eingabe.ts, ohne Browser und ohne Telefon.
 *
 * Nachgespielt wird jede Geste als Folge von runter/bewegt/hoch mit Zeiten,
 * und verglichen wird, welche Zeilen beim Pi ankämen. Dazu die Rechnung für
 * Zoom und Verschieben und die Bildschirmtastatur gegen die US-Belegung des
 * Pi (host/eingabe.c).
 *
 *     node scripts/fern-eingabe-pruefen.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* Das Modul ist TypeScript. Unter tsx neu starten, falls wir nicht schon
   darunter laufen — derselbe Weg wie bei den Prüfungen des Servers. */
if (!process.env.FERN_EINGABE_TSX) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
    stdio: 'inherit', env: { ...process.env, FERN_EINGABE_TSX: '1' },
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  });
  process.exit(r.status ?? 1);
}

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const m = await import(pathToFileURL(path.join(wurzel, 'packages/desktop/src/lib/fern-eingabe.ts')).href);
const { nachSchirm, ansichtNachziehen, Gesten, textNachTasten, EINFUEGEN, LANG_MS, ZIEH_SCHWELLE } = m;

let fehler = 0;
const pruefe = (was, ok, zusatz = '') => {
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓' : '\x1b[31m✗'}\x1b[0m ${was}${zusatz ? `  \x1b[90m${zusatz}\x1b[0m` : ''}`);
};
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ── Umrechnung auf den Pi-Schirm ────────────────────────────── */

console.log('\nUmrechnung');
const rect = { left: 100, top: 50, width: 400, height: 225 };
pruefe('linke obere Ecke → 0 0', gleich(nachSchirm(100, 50, rect), [0, 0]));
pruefe('rechte untere Ecke → 65535 65535', gleich(nachSchirm(500, 275, rect), [65535, 65535]));
pruefe('Mitte → 32768 32768', gleich(nachSchirm(300, 162.5, rect), [32768, 32768]));
pruefe('außerhalb → nichts', nachSchirm(99, 60, rect) === null && nachSchirm(200, 276, rect) === null);
pruefe('leere Leinwand → nichts', nachSchirm(0, 0, { left: 0, top: 0, width: 0, height: 0 }) === null);

/* ── Zoom ────────────────────────────────────────────────────── */

console.log('\nZoom der Ansicht');
{
  const W = 400, H = 225;
  const a1 = ansichtNachziehen({ s: 1, x: 0, y: 0 }, W, H, { x: 200, y: 100 }, { x: 200, y: 100 }, 100, 200);
  pruefe('Finger auseinander: doppelt so groß', a1.s === 2, JSON.stringify(a1));
  /* Der Punkt unter der Mitte bleibt, wo er war: (200 - x) / s = 200. */
  pruefe('der Punkt zwischen den Fingern bleibt unter ihnen',
    (200 - a1.x) / a1.s === 200 && (100 - a1.y) / a1.s === 100);
  const weit = ansichtNachziehen(a1, W, H, { x: 200, y: 100 }, { x: 900, y: 600 }, 100, 100);
  pruefe('Verschieben bleibt im Rahmen — kein schwarzer Rand', weit.x === 0 && weit.y === 0, JSON.stringify(weit));
  const andere = ansichtNachziehen(a1, W, H, { x: 200, y: 100 }, { x: -900, y: -600 }, 100, 100);
  pruefe('…auch in die andere Richtung', andere.x === W * (1 - 2) && andere.y === H * (1 - 2), JSON.stringify(andere));
  const klein = ansichtNachziehen(a1, W, H, { x: 200, y: 100 }, { x: 200, y: 100 }, 400, 10);
  pruefe('ganz zusammen: zurück auf 1, ohne Versatz', gleich(klein, { s: 1, x: 0, y: 0 }), JSON.stringify(klein));
  const riesig = ansichtNachziehen({ s: 1, x: 0, y: 0 }, W, H, { x: 0, y: 0 }, { x: 0, y: 0 }, 1, 1000);
  pruefe('höchstens fünffach', riesig.s === 5);
}

/* ── Gesten ──────────────────────────────────────────────────── */

function spiel() {
  const zeilen = [];
  const zooms = [];
  let gross = false;
  const g = new Gesten({
    /* Ein Bildschirmpunkt ist hier einfach seine Pi-Koordinate × 100 —
       so bleiben die erwarteten Zeilen lesbar. */
    ort: (p) => (p.x < 0 ? null : [Math.round(p.x * 100), Math.round(p.y * 100)]),
    senden: (z) => zeilen.push(...z.trim().split('\n')),
    zoomen: (...a) => { zooms.push(a); gross = true; },
    vergroessert: () => gross,
  });
  return { g, zeilen, zooms, gross: (v) => { gross = v; } };
}

console.log('\nEin Finger');
{
  const { g, zeilen } = spiel();
  g.runter(1, { x: 10, y: 20 }, 0);
  g.bewegt(1, { x: 13, y: 22 }, 80);          /* wackelt, zieht aber nicht */
  g.hoch(1, { x: 13, y: 22 }, 120);
  pruefe('Tippen = Linksklick an der Stelle des Aufsetzens',
    gleich(zeilen, ['z 1000 2000', 't 272 1', 't 272 0']), zeilen.join(' | '));
}
{
  const { g, zeilen } = spiel();
  g.runter(1, { x: 10, y: 20 }, 0);
  g.bewegt(1, { x: 10 + ZIEH_SCHWELLE + 1, y: 20 }, 50);
  g.bewegt(1, { x: 40, y: 30 }, 90);
  g.hoch(1, { x: 50, y: 30 }, 130);
  pruefe('Ziehen = Knopf runter am Anfang, Zeiger folgt, Knopf hoch am Ende',
    gleich(zeilen, ['z 1000 2000', 't 272 1', 'z 2100 2000', 'z 4000 3000', 'z 5000 3000', 't 272 0']),
    zeilen.join(' | '));
}
{
  const { g, zeilen } = spiel();
  g.runter(1, { x: 5, y: 5 }, 0);
  g.zeit(LANG_MS - 1);
  pruefe('vor der halben Sekunde passiert nichts', zeilen.length === 0);
  g.zeit(LANG_MS);
  pruefe('lang drücken = Rechtsklick, schon während der Finger liegt',
    gleich(zeilen, ['z 500 500', 't 273 1', 't 273 0']), zeilen.join(' | '));
  g.bewegt(1, { x: 50, y: 50 }, LANG_MS + 50);
  g.hoch(1, { x: 50, y: 50 }, LANG_MS + 100);
  pruefe('…und danach weder ein Ziehen noch ein zweiter Klick', zeilen.length === 3, zeilen.join(' | '));
}
{
  const { g, zeilen } = spiel();
  g.runter(1, { x: 5, y: 5 }, 0);
  g.hoch(1, { x: 5, y: 5 }, LANG_MS + 10);   /* Zeitgeber kam nicht dran */
  pruefe('lang gedrückt ohne Zeitgeber: der Rechtsklick kommt beim Loslassen',
    gleich(zeilen, ['z 500 500', 't 273 1', 't 273 0']), zeilen.join(' | '));
}
{
  const { g, zeilen } = spiel();
  g.runter(1, { x: 5, y: 5 }, 0);
  g.hoch(1, { x: 5, y: 5 }, 50, true);
  pruefe('abgebrochene Berührung (pointercancel) klickt nicht', zeilen.length === 0);
}
{
  const { g, zeilen } = spiel();
  g.runter(1, { x: -5, y: 5 }, 0);
  g.hoch(1, { x: -5, y: 5 }, 50);
  pruefe('Tippen neben das Bild schickt nichts', zeilen.length === 0);
}

console.log('\nZwei Finger');
{
  const { g, zeilen, zooms } = spiel();
  g.runter(1, { x: 100, y: 100 }, 0);
  g.runter(2, { x: 200, y: 100 }, 10);
  g.bewegt(1, { x: 70, y: 100 }, 40);
  g.bewegt(2, { x: 230, y: 100 }, 50);
  g.hoch(1, { x: 70, y: 100 }, 90);
  g.hoch(2, { x: 230, y: 100 }, 100);
  pruefe('auseinander = Zoom der Ansicht', zooms.length > 0);
  pruefe('…und nichts davon geht an den Pi', zeilen.length === 0, zeilen.join(' | '));
}
{
  const { g, zeilen, zooms } = spiel();
  g.runter(1, { x: 100, y: 300 }, 0);
  g.runter(2, { x: 200, y: 300 }, 10);
  g.bewegt(1, { x: 100, y: 250 }, 40);
  g.bewegt(2, { x: 200, y: 250 }, 50);
  g.bewegt(1, { x: 100, y: 200 }, 60);
  g.bewegt(2, { x: 200, y: 200 }, 70);
  g.hoch(1, { x: 100, y: 200 }, 90);
  g.hoch(2, { x: 200, y: 200 }, 100);
  const rollen = zeilen.filter((z) => z.startsWith('r 0 '));
  const summe = rollen.reduce((s, z) => s + Number(z.split(' ')[2]), 0);
  pruefe('gemeinsam nach oben, nicht vergrößert = auf dem Pi rollen', rollen.length > 0 && zooms.length === 0,
    zeilen.join(' | '));
  pruefe('…in natürlicher Richtung (Finger hoch = nach unten rollen)', summe > 0, summe.toFixed(2));
  pruefe('…und kein Klick dabei', !zeilen.some((z) => z.startsWith('t ')));
}
{
  const { g, zeilen, zooms, gross } = spiel();
  gross(true);
  g.runter(1, { x: 100, y: 300 }, 0);
  g.runter(2, { x: 200, y: 300 }, 10);
  g.bewegt(1, { x: 100, y: 250 }, 40);
  g.bewegt(2, { x: 200, y: 250 }, 50);
  pruefe('vergrößert: zwei Finger verschieben die Ansicht statt zu rollen', zooms.length > 0 && zeilen.length === 0);
}
{
  const { g, zeilen } = spiel();
  g.runter(1, { x: 10, y: 10 }, 0);
  g.bewegt(1, { x: 40, y: 10 }, 30);           /* zieht bereits */
  g.runter(2, { x: 80, y: 80 }, 60);           /* zweiter Finger kommt dazu */
  g.hoch(2, { x: 80, y: 80 }, 90);
  g.bewegt(1, { x: 60, y: 10 }, 100);
  g.hoch(1, { x: 60, y: 10 }, 120);
  const runter = zeilen.filter((z) => z === 't 272 1').length;
  const hoch = zeilen.filter((z) => z === 't 272 0').length;
  pruefe('ein zweiter Finger beendet das Ziehen — kein Knopf bleibt hängen', runter === 1 && hoch === 1, zeilen.join(' | '));
  pruefe('…und zwar dort, wo der erste Finger gerade liegt, nicht am Anfang',
    zeilen[zeilen.indexOf('t 272 0') - 1] === 'z 4000 1000', zeilen.join(' | '));
  pruefe('…und der verbleibende Finger klickt nicht mehr', !zeilen.slice(zeilen.indexOf('t 272 0') + 1).some((z) => z.startsWith('t ')));
}

/* ── Bildschirmtastatur ──────────────────────────────────────── */

console.log('\nBildschirmtastatur');
const tasten = (t) => (textNachTasten(t) ?? '').trim().split('\n').filter(Boolean);
pruefe('„a" = KEY_A (30) drücken und loslassen', gleich(tasten('a'), ['k 30 1', 'k 30 0']));
pruefe('„z" liegt auf KEY_Z (44) — US-Belegung, nicht deutsch', gleich(tasten('z'), ['k 44 1', 'k 44 0']));
pruefe('„A" = Umschalt + KEY_A', gleich(tasten('A'), ['k 42 1', 'k 30 1', 'k 30 0', 'k 42 0']));
pruefe('„?" = Umschalt + KEY_SLASH (53)', gleich(tasten('?'), ['k 42 1', 'k 53 1', 'k 53 0', 'k 42 0']));
pruefe('Leerzeichen = KEY_SPACE (57), ohne Umschalt', gleich(tasten(' '), ['k 57 1', 'k 57 0']));
pruefe('Zeilenumbruch = KEY_ENTER (28)', gleich(tasten('\n'), ['k 28 1', 'k 28 0']));
pruefe('ls -la: sechs Zeichen, zwölf Zeilen', tasten('ls -la').length === 12);
pruefe('typografisches ’ von iOS wird zum geraden \' (KEY_APOSTROPHE 40)',
  gleich(tasten('’'), ['k 40 1', 'k 40 0']));
pruefe('„ä" gibt es auf US nicht → Weg über die Ablage', textNachTasten('ä') === null);
pruefe('Emoji ebenso', textNachTasten('ok 👍') === null);
pruefe('Einfügen = Strg (29) + V (47)',
  gleich(EINFUEGEN.trim().split('\n'), ['k 29 1', 'k 47 1', 'k 47 0', 'k 29 0']));
/* Jedes druckbare ASCII-Zeichen muss eine Taste haben — sonst ginge ein
   harmloses Zeichen ungefragt über die Zwischenablage. */
const fehlend = [];
for (let c = 32; c < 127; c++) if (textNachTasten(String.fromCharCode(c)) === null) fehlend.push(String.fromCharCode(c));
pruefe('alle 95 druckbaren ASCII-Zeichen sind abgedeckt', fehlend.length === 0, fehlend.join(' '));

console.log(fehler
  ? `\n\x1b[31m${fehler} Prüfung(en) fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mTippen, Ziehen, lange Drücken, zwei Finger und die Bildschirmtastatur rechnen richtig um.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
