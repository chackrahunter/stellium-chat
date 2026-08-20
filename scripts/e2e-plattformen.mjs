/**
 * Die Oberfläche auf allen drei Browser-Motoren und in allen Größen.
 *
 * Chromium deckt Chrome, Edge und die Electron-App ab, WebKit ist Safari
 * (macOS und jedes iPhone), Firefox steht für sich. Was hier durchgeht, geht
 * überall — was hier bricht, hätten wir sonst erst von einem Kollegen erfahren.
 */
import { chromium, firefox, webkit } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

const MOTOREN = [
  { name: 'Chromium', starte: chromium, gilt: 'Chrome, Edge, die App selbst' },
  { name: 'WebKit', starte: webkit, gilt: 'Safari auf Mac und iPhone' },
  { name: 'Firefox', starte: firefox, gilt: 'Firefox' },
];

const GROESSEN = [
  { name: 'Groß', breite: 1920, hoehe: 1080 },
  { name: 'Laptop', breite: 1440, hoehe: 900 },
  { name: 'Klein', breite: 1180, hoehe: 720 },
  { name: 'Tablet', breite: 834, hoehe: 1112 },
  { name: 'Telefon', breite: 390, hoehe: 844 },
];

const ergebnisse = [];
const merke = (motor, groesse, name, ok, hinweis = '') => {
  ergebnisse.push({ motor, groesse, name, ok, hinweis });
  if (!ok) console.log(`  ✗ ${motor} · ${groesse} · ${name}${hinweis ? ` — ${hinweis}` : ''}`);
};

for (const motor of MOTOREN) {
  let browser;
  try {
    browser = await motor.starte.launch({ headless: true });
  } catch (e) {
    /* Ein Motor, der nicht startet, war bisher ein Übersprung ohne Spur.
       Starteten alle drei nicht, blieb `ergebnisse` leer, „0/0 bestanden"
       stand da und der Rückgabewert war 0 — ein grüner Lauf, der nichts
       ausgeführt hat. */
    console.log(`\n${motor.name}: nicht startbar — ${e.message.split('\n')[0]}`);
    merke(motor.name, '—', 'Motor startet', false, e.message.split('\n')[0]);
    continue;
  }
  console.log(`\n${motor.name} (${motor.gilt})`);

  for (const g of GROESSEN) {
    const ctx = await browser.newContext({ viewport: { width: g.breite, height: g.hoehe }, locale: 'de-DE' });
    const p = await ctx.newPage();
    const fehler = [];
    p.on('pageerror', (e) => fehler.push(String(e).slice(0, 120)));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR/.test(m.text())) fehler.push(m.text().slice(0, 120)); });

    try {
      await p.goto(APP, { waitUntil: 'domcontentloaded' });
      await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1500);

      if (await p.locator('.auth').count()) {
        await p.locator('.auth input').first().fill(LOGIN);
        await p.locator('.auth input[type="password"]').first().fill(PW);
        await p.locator('.auth button[type="submit"]').first().click();
      }
      await p.waitForSelector('.app', { timeout: 25000 });
      await p.waitForTimeout(1800);
    } catch (e) {
      merke(motor.name, g.name, 'Anmeldung und Aufbau', false, e.message.split('\n')[0]);
      await ctx.close();
      continue;
    }
    merke(motor.name, g.name, 'Anmeldung und Aufbau', true);

    // Läuft etwas seitlich aus dem Bild?
    const ueber = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    merke(motor.name, g.name, 'Nichts läuft seitlich heraus', ueber <= 1, `${ueber} px zu breit`);

    // Sind die tragenden Teile da und sichtbar?
    const teile = await p.evaluate(() => {
      const messe = (s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return {
          b: Math.round(r.width), h: Math.round(r.height),
          sichtbar: r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.opacity !== '0',
          imBild: r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0,
        };
      };
      return { rail: messe('.rail'), stream: messe('.stream'), composer: messe('.composer__input'), header: messe('.header') };
    });
    for (const [name, m] of Object.entries(teile)) {
      merke(motor.name, g.name, `${name} vorhanden`, Boolean(m && m.sichtbar && m.imBild),
        m ? `${m.b}×${m.h}` : 'fehlt');
    }

    // Der Eingabebereich darf nicht unter den unteren Rand rutschen.
    const composer = await p.locator('.composer__input').boundingBox().catch(() => null);
    merke(motor.name, g.name, 'Eingabe liegt im Bild',
      Boolean(composer && composer.y + composer.height <= g.hoehe + 2),
      composer ? `endet bei ${Math.round(composer.y + composer.height)} von ${g.hoehe}` : 'fehlt');

    // Ein Fenster öffnen und prüfen, dass es hineinpasst.
    try {
      await p.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+t' : 'Control+Shift+t');
      await p.waitForSelector('.panel', { timeout: 8000 });
      await p.waitForTimeout(700);
      const k = await p.locator('.panel').first().boundingBox();
      merke(motor.name, g.name, 'Fenster passt ins Bild',
        Boolean(k && k.x >= -1 && k.y >= -1 && k.x + k.width <= g.breite + 2 && k.y + k.height <= g.hoehe + 2),
        k ? `${Math.round(k.x)},${Math.round(k.y)} ${Math.round(k.width)}×${Math.round(k.height)}` : 'kein Fenster');
      await p.keyboard.press('Escape');
      await p.waitForTimeout(400);
    } catch (e) {
      merke(motor.name, g.name, 'Fenster passt ins Bild', false, e.message.split('\n')[0]);
    }

    // Schreiben muss überall gehen.
    try {
      const text = `Plattformprobe ${motor.name}`;
      await p.locator('.composer__input').fill(text);
      await p.waitForTimeout(300);
      const drin = await p.locator('.composer__input').inputValue();
      merke(motor.name, g.name, 'Eingabe nimmt Text an', drin === text, `"${drin}"`);
      await p.locator('.composer__input').fill('');
    } catch (e) {
      merke(motor.name, g.name, 'Eingabe nimmt Text an', false, e.message.split('\n')[0]);
    }

    merke(motor.name, g.name, 'Keine Fehler in der Konsole', fehler.length === 0, fehler[0] ?? '');

    if (g.name === 'Laptop') {
      await p.screenshot({ path: `/tmp/plattform-${motor.name}.png` });
    }
    await ctx.close();
  }
  await browser.close();
}

/* ── Zusammenfassung ────────────────────────────────────────── */
console.log('\n');
const proMotor = new Map();
for (const e of ergebnisse) {
  const k = e.motor;
  if (!proMotor.has(k)) proMotor.set(k, { gut: 0, schlecht: 0 });
  proMotor.get(k)[e.ok ? 'gut' : 'schlecht'] += 1;
}
for (const [motor, z] of proMotor) {
  console.log(`${motor.padEnd(10)} ${z.gut}/${z.gut + z.schlecht}`);
}
const schlecht = ergebnisse.filter((e) => !e.ok).length;
if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
