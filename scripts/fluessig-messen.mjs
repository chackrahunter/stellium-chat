/**
 * Wie flüssig läuft die Oberfläche wirklich?
 *
 * „Fühlt sich zäh an" lässt sich nicht reparieren, weil man nicht sieht, ob
 * eine Änderung geholfen hat. Deshalb Zahlen — und zwar die vier, die dem
 * Finger entsprechen:
 *
 *   1. Leerlauf    Was kostet die App, wenn NIEMAND etwas tut? Der Hintergrund
 *                  animiert durchgehend. Was hier verbrennt, fehlt später beim
 *                  Scrollen, und auf dem Telefon ist es der Akku.
 *   2. Scrollen    Bilder pro Sekunde und die langen Einzelbilder. Ein Ruckler
 *                  ist genau ein Einzelbild, das zu lange gebraucht hat.
 *   3. Tippen      Zeit von der Taste bis der Buchstabe wirklich auf dem Schirm
 *                  steht. Das ist die Zahl, die Don als „hängt" beschreibt.
 *   4. Kanalwechsel Wie lange steht die App, wenn man einen Kanal anklickt?
 *
 * Gemessen wird auf drei Geräteklassen. Das Telefon ist dabei nicht nur klein,
 * sondern auch langsam gestellt (Emulation.setCPUThrottlingRate) — ein iPhone
 * oder ein Android-Gerät hat einen Bruchteil der Rechenleistung des Macs, und
 * was dort flüssig ist, ist überall flüssig.
 *
 * Zwei Quellen, weil eine allein lügt:
 *   · Performance.getMetrics im Renderer — Skript-, Stil- und Layoutzeit im
 *     Hauptfaden, dazu die Zähler. Verdoppelte Layouts sieht man nur hier.
 *   · Prozesszeit des ganzen Browserbaums über ps — die Arbeit im
 *     Grafikprozess (Weichzeichner, backdrop-filter) taucht in den
 *     Renderer-Zahlen NICHT auf und wäre sonst unsichtbar.
 *
 * Aufruf:
 *   node scripts/fluessig-messen.mjs                      # messen und zeigen
 *   node scripts/fluessig-messen.mjs --schreiben vorher.json
 *   node scripts/fluessig-messen.mjs --gegen vorher.json  # Vorher/Nachher
 *   node scripts/fluessig-messen.mjs --pruefen            # als Prüflauf (Schranken)
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { verlaufSaeen } from './verlauf-saeen.mjs';
import { WS_PROTOCOL_VERSION } from '../packages/shared/dist/index.js';

/* Gemessen wird der FERTIGE Bau, nicht der Entwicklungsserver.
   Das ist kein Detail: unter Vite läuft React in der Entwicklungsfassung, und
   die kostet ein Vielfaches. Im Profil des Tippens stand ganz oben `jsxDEV`
   mit 1,64 ms je Anschlag, dazu `validateProperty` und `updatedAncestorInfo` —
   Namen, die es im ausgelieferten Bau gar nicht gibt. Dazu kommt StrictMode,
   der jede Darstellung doppelt ausführt. Wer gegen Vite misst, misst also
   etwas, das kein Benutzer je zu sehen bekommt, und optimiert Gespenster.
   Der Probeserver liefert denselben Bau aus, den auch der Raspberry Pi
   ausliefert. Mit --entwicklung lässt sich der alte Weg erzwingen. */
const GEGEN_VITE = process.argv.includes('--entwicklung');
const APP_ENTWICKLUNG = process.env.STELLIUM_APP ?? 'http://localhost:5173';

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const SCHREIBEN = arg('--schreiben');
const GEGEN = arg('--gegen');
const PRUEFEN = process.argv.includes('--pruefen');
const NUR = arg('--nur');
const OHNE_GPU = process.argv.includes('--ohne-gpu');

/* Drei Geräteklassen. Die Bremse (`bremse`) ist der Faktor, um den der
   Hauptfaden verlangsamt wird — 4× trifft ein Mittelklasse-Android recht gut,
   2× ein älteres iPad. */
const PROFILE = [
  { name: 'Laptop',  breite: 1440, hoehe: 900,  bremse: 1 },
  { name: 'Tablet',  breite: 820,  hoehe: 1180, bremse: 2 },
  { name: 'Handy',   breite: 390,  hoehe: 844,  bremse: 4 },
];

/** Wie viele Nachrichten im Kanal liegen. Genug, dass die Liste lang ist. */
const NACHRICHTEN = 120;

/* ── Prozesszeit des Browserbaums ─────────────────────────────── */

const sekunden = (s) => s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

/**
 * Summierte CPU-Zeit eines Prozesses und aller seiner Nachkommen.
 *
 * Der Renderer allein genügt nicht: Weichzeichner und backdrop-filter werden
 * im Grafikprozess gerastert, und der ist ein Geschwisterprozess. Wer nur den
 * Renderer misst, hält eine teure Fläche für kostenlos.
 */
function cpuBaum(wurzel) {
  const zeit = new Map();
  const kinder = new Map();
  for (const z of execFileSync('ps', ['-eo', 'pid=,ppid=,time=']).toString().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(z);
    if (!m) continue;
    const pid = Number(m[1]); const ppid = Number(m[2]);
    zeit.set(pid, sekunden(m[3]));
    if (!kinder.has(ppid)) kinder.set(ppid, []);
    kinder.get(ppid).push(pid);
  }
  let summe = 0;
  const stapel = [wurzel];
  while (stapel.length) {
    const p = stapel.pop();
    summe += zeit.get(p) ?? 0;
    for (const k of kinder.get(p) ?? []) stapel.push(k);
  }
  return summe;
}

/* ── Auswertung der Einzelbilder ──────────────────────────────── */

/**
 * Aus den Zeitstempeln der Einzelbilder die Zahlen machen, die zählen.
 *
 * Der Mittelwert ist die unehrlichste Zahl der ganzen Messung: 59 gute Bilder
 * und ein Ruckler von 200 ms ergeben immer noch „58 fps". Gesehen wird der
 * Ruckler. Deshalb steht hier das schlechteste Prozent im Vordergrund.
 */
function bilder(ts) {
  if (ts.length < 3) return { anzahl: ts.length, fps: 0, p95: 0, laengstes: 0, lahm: 0 };
  const abstand = ts.slice(1).map((t, i) => t - ts[i]);
  const sortiert = [...abstand].sort((a, b) => a - b);
  const spanne = ts[ts.length - 1] - ts[0];
  return {
    anzahl: ts.length,
    fps: Math.round((abstand.length / spanne) * 1000 * 10) / 10,
    median: Math.round(sortiert[sortiert.length >> 1] * 10) / 10,
    p95: Math.round(sortiert[Math.floor(sortiert.length * 0.95)] * 10) / 10,
    laengstes: Math.round(sortiert[sortiert.length - 1] * 10) / 10,
    /* Ein Einzelbild, das über 32 ms braucht, hat bei 60 Hz mindestens eines
       ausgelassen — genau das sieht man als Ruckeln. */
    lahm: abstand.filter((d) => d > 32).length,
  };
}

const rund = (x, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

/* ── Der Messstand im Browser ─────────────────────────────────── */

/**
 * Wird in die Seite gelegt und sammelt dort, was von außen nicht sichtbar ist:
 * Einzelbilder, lange Aufgaben und die echte Tastenverzögerung.
 *
 * Die Tastenverzögerung wird über zwei aufeinanderfolgende Einzelbilder
 * gemessen: das erste läuft VOR dem Zeichnen des Bildes mit dem neuen
 * Buchstaben, das zweite danach. Erst die zweite Marke bedeutet „steht auf dem
 * Schirm". Gerechnet wird ab `event.timeStamp` — dem Augenblick, in dem die
 * Taste anfiel, nicht dem, in dem JavaScript davon erfuhr. Nur so ist die
 * Wartezeit in der Schlange mit drin, und die ist bei einem blockierten
 * Hauptfaden der größte Teil.
 */
function messstand() {
  const m = {
    ts: [], lang: [], tipp: [], laeuft: false,
    start() {
      this.ts = []; this.lang = []; this.laeuft = true;
      const schleife = (t) => { if (!this.laeuft) return; this.ts.push(t); requestAnimationFrame(schleife); };
      requestAnimationFrame(schleife);
    },
    stop() { this.laeuft = false; return { ts: this.ts.slice(), lang: this.lang.slice(), tipp: this.tipp.slice() }; },
  };
  window.__mess = m;
  try {
    new PerformanceObserver((liste) => {
      for (const e of liste.getEntries()) if (m.laeuft) m.lang.push(Math.round(e.duration * 10) / 10);
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* WebKit kennt longtask nicht */ }
  window.addEventListener('keydown', (e) => {
    if (!m.laeuft) return;
    const start = e.timeStamp;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      m.tipp.push(Math.round((performance.now() - start) * 10) / 10);
    }));
  }, true);
}

/* ── Ein Profil messen ────────────────────────────────────────── */

/**
 * Alles wegräumen, was sich über die App gelegt hat.
 *
 * Ein Schleier fängt jeden Klick ab, und die Messung scheiterte dann an etwas,
 * das mit Flüssigkeit nichts zu tun hat. Erst Escape — das ist der Weg, den
 * die App selbst vorsieht —, und wenn der Schleier bleibt, ein Klick darauf:
 * er schließt sich per Entwurf beim Klick auf sich selbst.
 */
async function kanalWaehlen(p, nummer) {
  const knopf = p.locator('.chan').nth(nummer);
  if (!await knopf.isVisible()) {
    await p.locator('.header__menue').first().click({ timeout: 5000 });
    await p.waitForTimeout(400);
  }
  await knopf.waitFor({ state: 'visible', timeout: 15000 });
  await knopf.click({ timeout: 8000 });
  await p.waitForSelector('.stream', { timeout: 20000 });
}

async function freiraeumen(p) {
  for (let i = 0; i < 6; i += 1) {
    if (!await p.locator('.scrim, .tour').count()) return;
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    if (!await p.locator('.scrim, .tour').count()) return;
    await p.locator('.scrim').first().click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {});
    await p.waitForTimeout(200);
  }
}

async function messen(browserPid, browser, probe, profil) {
  const ctx = await browser.newContext({
    viewport: { width: profil.breite, height: profil.hoehe },
    deviceScaleFactor: 2,
    locale: 'de-DE',
    hasTouch: profil.breite < 700,
  });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Performance.enable');

  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 25000 });
  await p.waitForTimeout(1500);

  /* Den Kanal über die Oberfläche öffnen, nicht über den Zustand: im fertigen
     Bau gibt es `window.__stelliumStore` nicht — der Haken hängt bewusst an
     import.meta.env.DEV. Ein Klick auf den Kanal tut ohnehin genau das, was
     ein Mensch täte. */
  await freiraeumen(p);
  /* Auf schmalen Geräten ist die Kanalliste eingeklappt; ihre Knöpfe sind da,
     aber unsichtbar. Dann erst die Schublade aufziehen — genau der Handgriff,
     den auch ein Mensch macht. */
  await kanalWaehlen(p, 0);
  await p.waitForSelector('.stream', { timeout: 20000 });
  await p.waitForTimeout(1800);
  await p.evaluate(() => { const s = document.querySelector('.stream'); if (s) s.scrollTop = s.scrollHeight; });
  await p.waitForTimeout(600);

  await p.evaluate(messstand);
  // Erst jetzt bremsen: das Laden soll nicht künstlich langsam sein, das Tippen schon.
  if (profil.bremse > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profil.bremse });
  await p.waitForTimeout(400);

  const werte = {};

  const zaehler = async () => (await cdp.send('Performance.getMetrics')).metrics
    .reduce((a, m) => { a[m.name] = m.value; return a; }, {});

  /**
   * Eine Messstrecke: Zähler und Prozesszeit vorher, die Handlung, Zähler und
   * Prozesszeit nachher. Alles, was dazwischen passiert, steht in der Differenz.
   */
  const strecke = async (name, handlung) => {
    await p.evaluate(() => window.__mess.start());
    const cpu0 = cpuBaum(browserPid);
    const m0 = await zaehler();
    await handlung();
    const m1 = await zaehler();
    const cpu1 = cpuBaum(browserPid);
    const roh = await p.evaluate(() => window.__mess.stop());
    const dauer = m1.Timestamp - m0.Timestamp;
    const b = bilder(roh.ts);
    werte[name] = {
      dauer: rund(dauer, 2),
      ...b,
      /* Auf dem Hauptfaden — hier entstehen die Ruckler. */
      skript: rund((m1.ScriptDuration - m0.ScriptDuration) * 1000),
      stil: rund((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000),
      layout: rund((m1.LayoutDuration - m0.LayoutDuration) * 1000),
      aufgaben: rund((m1.TaskDuration - m0.TaskDuration) * 1000),
      layoutZahl: m1.LayoutCount - m0.LayoutCount,
      stilZahl: m1.RecalcStyleCount - m0.RecalcStyleCount,
      /* Der ganze Browser, alle Prozesse — inklusive Grafik. In Prozent eines
         Kerns, damit die Zahl unabhängig von der Streckenlänge vergleichbar ist. */
      cpu: rund(((cpu1 - cpu0) / dauer) * 100),
      lang: roh.lang.length,
      langSumme: rund(roh.lang.reduce((a, x) => a + x, 0)),
      langLaengste: roh.lang.length ? Math.max(...roh.lang) : 0,
      tipp: roh.tipp,
    };
    return werte[name];
  };

  /* 1 — Leerlauf. Niemand tut etwas. Was jetzt läuft, läuft immer. */
  await strecke('leerlauf', () => p.waitForTimeout(4000));

  /* 2 — Scrollen. Mit dem Rad durch den Verlauf, hin und zurück, und bewusst
     nicht bis ganz nach oben: dort lädt die Liste nach, und das wäre eine
     andere Messung. */
  const mitte = { x: Math.round(profil.breite * 0.6), y: Math.round(profil.hoehe * 0.5) };
  await p.mouse.move(mitte.x, mitte.y);
  await strecke('scrollen', async () => {
    for (let runde = 0; runde < 2; runde += 1) {
      for (let i = 0; i < 18; i += 1) { await p.mouse.wheel(0, -110); await p.waitForTimeout(16); }
      for (let i = 0; i < 18; i += 1) { await p.mouse.wheel(0, 110); await p.waitForTimeout(16); }
    }
  });

  /* 3 — Tippen. 40 Zeichen in gleichmäßigem Takt ins Schreibfeld. */
  await p.evaluate(() => { const s = document.querySelector('.stream'); if (s) s.scrollTop = s.scrollHeight; });
  await p.click('.composer textarea, textarea.composer__input, textarea').catch(() => {});
  await p.waitForTimeout(300);
  await strecke('tippen', async () => {
    await p.keyboard.type('Guten Morgen zusammen, kurze Rueckmeldung', { delay: 55 });
  });
  await p.evaluate(() => {
    const el = document.querySelector('.composer textarea, textarea');
    if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
  });

  /* 4 — Kanalwechsel. Der Griff, bei dem eine App am deutlichsten „steht". */
  await freiraeumen(p);
  const wieViele = await p.locator('.chan').count();
  if (wieViele >= 1) {
    /* Diese Strecke ist die einzige, die die Oberfläche wirklich bedient —
       und damit die einzige, die an einem Dialog hängenbleiben kann, der
       gerade aufgegangen ist. Sie darf den ganzen Lauf nicht mitreißen: die
       drei Strecken davor sind dann schon gemessen. */
    try {
      await strecke('kanalwechsel', async () => {
        for (let i = 0; i < 6; i += 1) {
          await freiraeumen(p);
          await kanalWaehlen(p, i % wieViele);
          await p.waitForTimeout(450);
        }
      });
    } catch (fehler) {
      delete werte.kanalwechsel;
      console.log(`     (Kanalwechsel übersprungen: ${String(fehler.message).split('\n')[0].slice(0, 70)})`);
    }
  }

  await ctx.close();
  return werte;
}

/* ── Ausgabe ──────────────────────────────────────────────────── */

const STRECKEN = [
  ['leerlauf', 'Leerlauf (nichts tun)'],
  ['scrollen', 'Scrollen im Verlauf'],
  ['tippen', 'Tippen ins Schreibfeld'],
  ['kanalwechsel', 'Kanal wechseln'],
];

function zeigen(bericht, alt) {
  for (const profil of PROFILE) {
    const w = bericht[profil.name];
    if (!w) continue;
    const a = alt?.[profil.name];
    console.log(`\n╔═══ ${profil.name}  ${profil.breite}×${profil.hoehe}${profil.bremse > 1 ? `  CPU ${profil.bremse}× gebremst` : ''} ═══`);
    for (const [schluessel, titel] of STRECKEN) {
      const s = w[schluessel];
      if (!s) continue;
      const v = a?.[schluessel];
      const d = (jetzt, frueher, einheit = '', weniger = true) => {
        if (frueher == null) return `${jetzt}${einheit}`;
        const diff = jetzt - frueher;
        const gut = weniger ? diff < 0 : diff > 0;
        const marke = Math.abs(diff) < 0.001 ? '·' : (gut ? '▼' : '▲');
        return `${jetzt}${einheit} (${marke} war ${frueher}${einheit})`;
      };
      console.log(`║`);
      console.log(`║ ${titel}`);
      console.log(`║   Bilder/s          ${d(s.fps, v?.fps, '', false)}`);
      console.log(`║   längstes Bild     ${d(s.laengstes, v?.laengstes, ' ms')}`);
      console.log(`║   Bilder über 32 ms ${d(s.lahm, v?.lahm)}  von ${s.anzahl}`);
      console.log(`║   Hauptfaden        Skript ${d(s.skript, v?.skript, ' ms')} · Stil ${d(s.stil, v?.stil, ' ms')} · Layout ${d(s.layout, v?.layout, ' ms')}`);
      console.log(`║   Layouts / Stile   ${d(s.layoutZahl, v?.layoutZahl)} / ${d(s.stilZahl, v?.stilZahl)}`);
      console.log(`║   lange Aufgaben    ${d(s.lang, v?.lang)}  zusammen ${d(s.langSumme, v?.langSumme, ' ms')}`);
      console.log(`║   CPU ganzer Browser ${d(s.cpu, v?.cpu, ' %')}`);
      if (s.tipp?.length) {
        const t = [...s.tipp].sort((x, y) => x - y);
        const vt = v?.tipp?.length ? [...v.tipp].sort((x, y) => x - y) : null;
        console.log(`║   Taste → Buchstabe  median ${d(t[t.length >> 1], vt ? vt[vt.length >> 1] : null, ' ms')} · schlechteste ${d(t[t.length - 1], vt ? vt[vt.length - 1] : null, ' ms')}  (${t.length} Tasten)`);
      }
    }
  }
}

/**
 * Schranken für den Prüflauf.
 *
 * Abgeleitet aus einem gemessenen Stand, nicht geraten. Gemessen wurde am
 * fertigen Bau mit Grafikbeschleunigung, und dort steht überall dasselbe:
 * 60 Bilder je Sekunde, kein einziges Bild über 32 ms, Taste bis Buchstabe
 * 25 ms — auf dem Laptop wie auf dem vierfach gebremsten Telefon.
 *
 * Die Schranken liegen bewusst deutlich darüber. Sie sollen einen Rückschritt
 * fangen (jemand baut etwas ein, das die Bildrate halbiert), nicht bei
 * Messrauschen rot werden. Die einzige Ausnahme ist der Kanalwechsel auf dem
 * gebremsten Telefon: dort steht schon heute EIN langes Bild von 167 ms, wenn
 * die Liste neu aufgebaut wird — das ist bekannt und deshalb erlaubt.
 *
 * Die CPU-Zahl steht bewusst NICHT in den Schranken: sie hängt davon ab, was
 * sonst gerade auf der Maschine läuft, und würde den Lauf launisch machen.
 * Sie steht im Bericht, damit man sie ansehen kann.
 */
const SCHRANKEN = {
  Laptop: { scrollFps: 50, scrollLahm: 4, leerlaufLahm: 2, tippMedian: 45 },
  Tablet: { scrollFps: 50, scrollLahm: 6, leerlaufLahm: 3, tippMedian: 55 },
  Handy: { scrollFps: 45, scrollLahm: 8, leerlaufLahm: 4, tippMedian: 65 },
};

/* ── Lauf ─────────────────────────────────────────────────────── */

async function probeserverMitAnlaeufen(versuche = 6) {
  let letzter;
  for (let n = 0; n < versuche; n += 1) {
    try { return await probeserver(); } catch (f) { letzter = f; await new Promise((r) => setTimeout(r, 400)); }
  }
  throw letzter;
}

const probe = await probeserverMitAnlaeufen();
/* Erst jetzt steht die Adresse fest: ohne --entwicklung ist es der
   Probeserver mit dem fertigen Bau. */
const APP = GEGEN_VITE ? APP_ENTWICKLUNG : probe.S;
/* Der Verlauf entsteht über den echten Draht — siehe verlauf-saeen.mjs. */
await verlaufSaeen(probe, NACHRICHTEN, WS_PROTOCOL_VERSION);
/* Mit echter Grafikbeschleunigung messen — sonst rastert Chromium ohne
   Fenster über SwiftShader auf der CPU, und die Zahlen beschreiben eine
   Maschine, die kaum ein Benutzer hat. Auf einem Rechner ohne Grafikkarte
   fällt Chromium von selbst zurück; dann sind die Zahlen eben die der
   Notbeleuchtung, und das ist auch richtig so. */
const server = await chromium.launchServer({
  headless: true,
  args: OHNE_GPU ? [] : ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
});
const browser = await chromium.connect(server.wsEndpoint());
const browserPid = server.process().pid;

const bericht = {};
try {
  for (const profil of PROFILE) {
    if (NUR && profil.name.toLowerCase() !== NUR.toLowerCase()) continue;
    process.stdout.write(`  … ${profil.name}`);
    bericht[profil.name] = await messen(browserPid, browser, probe, profil);
    process.stdout.write('\r                        \r');
  }
} finally {
  await browser.close();
  await server.close();
  await probe.stop();
}

const alt = GEGEN && fs.existsSync(GEGEN) ? JSON.parse(fs.readFileSync(GEGEN, 'utf8')) : null;
zeigen(bericht, alt);

if (SCHREIBEN) {
  fs.writeFileSync(SCHREIBEN, JSON.stringify(bericht, null, 1));
  console.log(`\n  geschrieben nach ${SCHREIBEN}`);
}

if (PRUEFEN) {
  const klagen = [];
  for (const [name, w] of Object.entries(bericht)) {
    const g = SCHRANKEN[name];
    if (!g) continue;
    if (w.leerlauf.lahm > g.leerlaufLahm) klagen.push(`${name}: ${w.leerlauf.lahm} lahme Bilder, obwohl niemand etwas tut (erlaubt ${g.leerlaufLahm})`);
    if (w.scrollen.fps < g.scrollFps) klagen.push(`${name}: nur ${w.scrollen.fps} Bilder/s beim Scrollen (nötig ${g.scrollFps})`);
    if (w.scrollen.lahm > g.scrollLahm) klagen.push(`${name}: ${w.scrollen.lahm} lahme Bilder beim Scrollen (erlaubt ${g.scrollLahm})`);
    const t = [...w.tippen.tipp].sort((a, b) => a - b);
    const median = t[t.length >> 1] ?? 0;
    if (median > g.tippMedian) klagen.push(`${name}: Taste → Buchstabe ${median} ms im Mittel (erlaubt ${g.tippMedian} ms)`);
  }
  console.log('');
  for (const k of klagen) console.log(`  ✗ ${k}`);
  console.log(klagen.length ? `\n✗ ${klagen.length} Beanstandung(en).\n` : '\n✓ Alle Schranken eingehalten.\n');
  process.exit(klagen.length ? 1 : 0);
}
console.log('');
