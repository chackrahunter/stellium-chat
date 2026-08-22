/** Prüft die Ansicht auf Telefonen: nichts läuft heraus, alles erreichbar. */
import { chromium, devices } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';


const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });

/* Auch quer: dort liegen Kamera und Home-Leiste an anderen Kanten, und die
   Höhe ist knapper als jede geprüfte Breite schmal. */
for (const name of ['iPhone 13', 'iPhone SE', 'Pixel 5', 'iPhone 13 landscape', 'iPhone SE landscape']) {
  const geraet = devices[name];
  console.log(`\n${name} (${geraet.viewport.width}×${geraet.viewport.height})`);
  const ctx = await b.newContext({ ...geraet, locale: 'de-DE' });
  const p = await ctx.newPage();
  await p.goto(APP);
  await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
  await p.reload(); await p.waitForTimeout(1200);
  if (await p.locator('.auth').count()) {
    await p.locator('.auth input').first().fill(LOGIN);
    await p.locator('.auth input[type="password"]').first().fill(PW);
    await p.locator('.auth button[type="submit"]').first().click();
  }
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1500);

  const seitlich = () => p.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);

  await pruefe('Nichts läuft seitlich heraus', async () => {
    const ueber = await seitlich();
    muss(ueber <= 1, `${ueber} px zu breit`);
  });

  await pruefe('Kanalliste ist erreichbar', async () => {
    muss(await p.locator('.header__menue').isVisible(), 'kein Griff zur Liste');
    await p.locator('.header__menue').click();
    await p.waitForTimeout(500);
    muss(await p.locator('.sidebar').isVisible(), 'Liste öffnet nicht');
    const kasten = await p.locator('.sidebar').boundingBox();
    muss(kasten.x >= 0, 'Liste liegt außerhalb');
    return `${Math.round(kasten.width)} px breit`;
  });

  await pruefe('Kanalwechsel schließt die Liste', async () => {
    const kanal = p.locator('.chan').filter({ hasText: 'allgemein' }).first();
    await kanal.click();
    await p.waitForTimeout(700);
    const kasten = await p.locator('.sidebar').boundingBox();
    muss(!kasten || kasten.x + kasten.width <= 60, 'Liste bleibt offen');
  });

  await pruefe('Eingabefeld ist erreichbar', async () => {
    const feld = await p.locator('.composer__input').boundingBox();
    muss(feld, 'kein Eingabefeld');
    muss(feld.y + feld.height <= geraet.viewport.height + 2,
      `liegt bei ${Math.round(feld.y + feld.height)}, Fenster ist ${geraet.viewport.height}`);
    // Unter 16px zoomt iOS beim Antippen hinein.
    const groesse = await p.locator('.composer__input').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    muss(groesse >= 16, `Schrift nur ${groesse} px — iOS zoomt dann hinein`);
    return `Schrift ${groesse} px`;
  });

  await pruefe('Sicherheitsabstände wirken (Insel, Home-Leiste, Kamera)', async () => {
    /* Das prüft die MECHANIK, nicht einen Zustand: reagiert das Layout, wenn
       Geräteränder gemeldet werden? Kommen tut das derzeit nirgends — ohne
       `viewport-fit=cover` meldet env() überall 0, und sichere-bereiche.ts
       setzt nur noch --wischzone. Die Prüfung bleibt trotzdem: sie hält die
       Verkabelung in mobil.css am Leben, falls `cover` je zurückkommt. */
    const vorher = await p.locator('.header').boundingBox();
    await p.evaluate(() => {
      const s = document.documentElement.style;
      s.setProperty('--sicher-oben', '59px');
      s.setProperty('--sicher-unten', '34px');
      s.setProperty('--sicher-links', '47px');
    });
    const kopf = await p.locator('.header').boundingBox();
    const wuchs = Math.round(kopf.height - vorher.height);
    muss(wuchs >= 55, `Kopfzeile wächst nur um ${wuchs} px statt 59`);
    const polster = await p.locator('.composer-wrap')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    muss(polster >= 40, `Composer-Abstand zur Home-Leiste nur ${polster} px`);
    const rand = await p.locator('.rahmen')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    muss(rand >= 46, `seitlicher Abstand nur ${rand} px`);
    await p.evaluate(() => {
      const s = document.documentElement.style;
      for (const n of ['--sicher-oben', '--sicher-unten', '--sicher-links']) s.removeProperty(n);
    });
    return `Kopfzeile +${wuchs} px, Composer ${polster} px, seitlich ${rand} px`;
  });

  await pruefe('Schreiben geht', async () => {
    const text = `Vom Telefon ${Date.now().toString(36).slice(-4)}`;
    await p.locator('.composer__input').fill(text);
    await p.locator('.composer button[type="submit"], .composer__send').first().click().catch(async () => {
      await p.keyboard.press('Enter');
    });
    await p.waitForTimeout(1600);
    muss((await p.locator('.app').innerText()).includes(text.slice(0, 12)), 'Nachricht erscheint nicht');
    muss((await seitlich()) <= 1, 'nach dem Senden läuft es seitlich heraus');
  });

  await pruefe('Fenster füllen den Bildschirm ohne herauszuragen', async () => {
    /* Auf Telefonen steckt die Symbolleiste in der geschlossenen Schublade —
       erst über den Griff öffnen, sonst ist der Knopf nicht anklickbar. */
    if (!(await p.locator('.rail [data-tour="tasks"]').isVisible())) {
      await p.locator('.header__menue').click();
      await p.waitForTimeout(400);
    }
    await p.locator('.rail [data-tour="tasks"]').click();
    await p.waitForSelector('.panel', { timeout: 8000 });
    await p.waitForTimeout(700);
    const k = await p.locator('.panel').first().boundingBox();
    muss(k.x >= -1 && k.width <= geraet.viewport.width + 2, `${Math.round(k.width)} px auf ${geraet.viewport.width}`);
    muss(k.y >= -1 && k.y + k.height <= geraet.viewport.height + 2, 'ragt unten heraus');
    await p.keyboard.press('Escape');
    return `${Math.round(k.width)}×${Math.round(k.height)}`;
  });

  await p.screenshot({ path: `/tmp/handy-${name.replace(/\W+/g, '-')}.png` });
  await ctx.close();
}

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
