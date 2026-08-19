import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'de-DE' })).newPage();
await p.goto('http://localhost:5173');
await p.evaluate(() => { localStorage.setItem('stellium.serverUrl','http://localhost:8787'); localStorage.setItem('stellium.tourGesehen','ja'); });
await p.reload(); await p.waitForTimeout(1000);
if (await p.locator('.auth').count()) {
  await p.locator('.auth input').first().fill('don');
  await p.locator('.auth input[type="password"]').first().fill('MeinLangesPasswort-2026');
  await p.locator('.auth button[type="submit"]').first().click();
}
await p.waitForSelector('.app', { timeout: 20000 }); await p.waitForTimeout(1200);
// Auf Französisch stellen und sehen, was aus den Kanälen wird
await p.locator('.rail [data-tour="settings"]').click();
await p.waitForSelector('.panel--wide select');
console.log('Oberflächensprachen zur Auswahl:', await p.locator('.panel--wide select').first().locator('option').count());
await p.locator('.panel--wide select').first().selectOption('fr');
await p.waitForTimeout(1500);
console.log('Oberfläche jetzt:', (await p.locator('.panel--wide').innerText()).split('\n').slice(3,6).join(' | '));
await p.locator('.panel--wide select').nth(1).selectOption('fr');
await p.waitForTimeout(2000);
await p.keyboard.press('Escape'); await p.waitForTimeout(500);
console.log('Kanäle vorher:', await p.locator('.chan__name').allInnerTexts());
await p.waitForTimeout(25000);
console.log('Kanäle nachher:', await p.locator('.chan__name').allInnerTexts());
console.log('Kopfzeile:', await p.locator('.header__topic').first().innerText().catch(()=>'—'));
await b.close();
