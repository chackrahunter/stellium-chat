/** Arabisch wird von rechts nach links gelesen — die Oberfläche muss mitdrehen. */
import { chromium, webkit } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const anmelden = async (browser) => {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'de-DE' })).newPage();
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
  return p;
};

for (const [name, starte] of [['Chromium', chromium], ['WebKit', webkit]]) {
  console.log(`\n${name}`);
  const b = await starte.launch({ headless: true });
  const p = await anmelden(b);

  const vorher = await p.evaluate(() => ({
    dir: document.documentElement.dir,
    lang: document.documentElement.lang,
    rail: document.querySelector('.rail')?.getBoundingClientRect().x,
  }));

  await pruefe('Deutsch steht auf links-nach-rechts', async () => {
    muss(vorher.dir === 'ltr', `dir="${vorher.dir}"`);
    muss(vorher.lang === 'de', `lang="${vorher.lang}"`);
    return `dir=${vorher.dir} lang=${vorher.lang}`;
  });

  // Auf Arabisch umstellen.
  await p.evaluate(() => window.__stelliumStore.getState().updatePrefs({ uiLanguage: 'ar' }));
  await p.waitForTimeout(2000);

  const nachher = await p.evaluate(() => ({
    dir: document.documentElement.dir,
    lang: document.documentElement.lang,
    rail: document.querySelector('.rail')?.getBoundingClientRect().x,
    railBreite: document.querySelector('.rail')?.getBoundingClientRect().width,
    seitlich: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    composer: document.querySelector('.composer__input')?.getBoundingClientRect(),
  }));

  await pruefe('Arabisch dreht das Dokument', async () => {
    muss(nachher.dir === 'rtl', `dir="${nachher.dir}"`);
    muss(nachher.lang === 'ar', `lang="${nachher.lang}"`);
    return `dir=${nachher.dir} lang=${nachher.lang}`;
  });

  await pruefe('Die Symbolleiste wandert auf die andere Seite', async () => {
    muss(nachher.rail > 1000, `liegt bei x=${Math.round(nachher.rail)} statt rechts`);
    return `x=${Math.round(nachher.rail)} (vorher ${Math.round(vorher.rail)})`;
  });

  await pruefe('Nichts läuft seitlich heraus', async () => {
    muss(nachher.seitlich <= 1, `${nachher.seitlich} px zu breit`);
  });

  await pruefe('Der Eingabebereich bleibt im Bild', async () => {
    const c = nachher.composer;
    muss(c && c.x >= -1 && c.x + c.width <= 1281, `x=${Math.round(c?.x)} b=${Math.round(c?.width)}`);
  });

  await pruefe('Die Oberfläche steht auf Arabisch', async () => {
    // Die Symbolleiste trägt nur Bilder — Text steht in der Kanalliste.
    const text = await p.locator('.sidebar').innerText();
    muss(/[؀-ۿ]/.test(text), `kein arabischer Text: "${text.slice(0, 60)}"`);
    return text.split('\n').find((z) => /[؀-ۿ]/.test(z))?.slice(0, 30);
  });

  await p.screenshot({ path: `/tmp/rtl-${name}.png` });

  // Wieder zurück, damit die Prüfdatenbank nicht auf Arabisch stehen bleibt.
  await p.evaluate(() => window.__stelliumStore.getState().updatePrefs({ uiLanguage: 'de' }));
  await p.waitForTimeout(1200);
  await b.close();
}

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
