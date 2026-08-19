/** Prüft, dass eine Umfrage in der Lesesprache ankommt. */
import { chromium } from 'playwright';
const APP = 'http://localhost:5173';
const S = 'http://localhost:8787';
const ergebnisse = [];
const pruefe = async (n, f) => { try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x?` — ${x}`:''}`); } catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); } };

const b = await chromium.launch({ headless: true });

async function sitzung(sprache) {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'de-DE' })).newPage();
  await p.goto(APP);
  await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
  await p.reload(); await p.waitForTimeout(1000);
  if (await p.locator('.auth').count()) {
    await p.locator('.auth input').first().fill('don');
    await p.locator('.auth input[type="password"]').first().fill(process.env.STELLIUM_TEST_PASSWORT ?? 'MeinLangesPasswort-2026');
    await p.locator('.auth button[type="submit"]').first().click();
  }
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1200);
  // Lesesprache setzen
  await p.locator('.rail [data-tour="settings"]').click();
  await p.waitForSelector('.panel--wide select');
  await p.locator('.panel--wide select').nth(1).selectOption(sprache);
  await p.waitForTimeout(1200);
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  return p;
}

const p = await sitzung('de');

await pruefe('Umfrage anlegen', async () => {
  await p.locator('.chan').filter({ hasText: 'allgemein' }).first().click();
  await p.waitForTimeout(800);
  await p.locator('.composer__bar button').nth(5).click();   // Umfrage-Knopf
  await p.waitForSelector('.panel input.input', { timeout: 8000 });
  const felder = p.locator('.panel input.input');
  await felder.nth(0).fill('Sieht die App gut aus?');
  await felder.nth(1).fill('Ja, sehr');
  await felder.nth(2).fill('Nein, gar nicht');
  await p.locator('.panel .btn--primary').last().click();
  await p.waitForSelector('.poll', { timeout: 10000 });
  return await p.locator('.poll__question').first().innerText();
});

await pruefe('Auf Englisch erscheint sie übersetzt', async () => {
  await p.locator('.rail [data-tour="settings"]').click();
  await p.waitForSelector('.panel--wide select');
  await p.locator('.panel--wide select').nth(1).selectOption('en');
  await p.waitForTimeout(1500);
  await p.keyboard.press('Escape');
  // Die Übersetzung kommt als eigenes Ereignis nach.
  await p.waitForFunction(() => {
    const q = document.querySelector('.poll__question')?.textContent ?? '';
    return /does|look|app/i.test(q) && !/Sieht/i.test(q);
  }, undefined, { timeout: 45000 });
  const frage = await p.locator('.poll__question').first().innerText();
  const antworten = await p.locator('.poll-option__text').allInnerTexts();
  return `${frage} · ${antworten.join(' / ')}`;
});

await pruefe('Zurück auf Deutsch steht wieder das Original', async () => {
  await p.locator('.rail [data-tour="settings"]').click();
  await p.waitForSelector('.panel--wide select');
  await p.locator('.panel--wide select').nth(1).selectOption('de');
  await p.waitForTimeout(1500);
  await p.keyboard.press('Escape');
  await p.waitForFunction(() => /Sieht/i.test(document.querySelector('.poll__question')?.textContent ?? ''),
    undefined, { timeout: 30000 });
});

await pruefe('Emoji-Auswahl bleibt im Fenster', async () => {
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.locator('.composer__bar button').nth(1).click();
  await p.waitForTimeout(600);
  const kasten = await p.locator('div').filter({ hasText: /^Emoji suchen/ }).first().boundingBox().catch(() => null);
  const auswahl = await p.evaluate(() => {
    const e = [...document.querySelectorAll('div')].find((d) => d.textContent?.startsWith('Emoji suchen') === false
      && d.style.position === 'fixed' && d.style.width === '306px');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, links: r.left, rechts: r.right, hoehe: r.height };
  });
  if (!auswahl) throw new Error('Auswahl nicht gefunden');
  if (auswahl.top < 0 || auswahl.bottom > 861) throw new Error(`ragt heraus: ${JSON.stringify(auswahl)}`);
  return `${Math.round(auswahl.hoehe)} px hoch, vollständig sichtbar`;
});

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
