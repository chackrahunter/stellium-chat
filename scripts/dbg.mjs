/** Sucht nach einem Schleier, der bleibt, obwohl nichts darauf zu sehen ist. */
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1350, height: 870 }, locale: 'de-DE' })).newPage();
p.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0,240)));
await p.goto('http://localhost:5173');
await p.evaluate(() => { localStorage.setItem('stellium.serverUrl','http://localhost:8787'); localStorage.setItem('stellium.tourGesehen','ja'); });
await p.reload(); await p.waitForTimeout(1200);
if (await p.locator('.auth').count()) {
  await p.locator('.auth input').first().fill('don');
  await p.locator('.auth input[type="password"]').first().fill('MeinLangesPasswort-2026');
  await p.locator('.auth button[type="submit"]').first().click();
}
await p.waitForSelector('.app', { timeout: 20000 }); await p.waitForTimeout(1500);

const pruefen = async (was) => {
  const scrim = await p.locator('.scrim').count();
  const tour = await p.locator('.tour').count();
  if (!scrim && !tour) return;
  const inhalt = await p.evaluate(() => {
    const s = document.querySelector('.scrim') || document.querySelector('.tour');
    if (!s) return null;
    const sichtbar = [...s.children].filter((c) => c.getBoundingClientRect().width > 40);
    return { kinder: s.children.length, sichtbar: sichtbar.length, text: (s.innerText||'').slice(0,60) };
  });
  if (inhalt && inhalt.sichtbar === 0) {
    console.log(`LEERER SCHLEIER nach: ${was} ·`, JSON.stringify(inhalt));
    await p.screenshot({ path: `/tmp/leer-${was.replace(/\W+/g,'-')}.png` });
  }
  await p.keyboard.press('Escape'); await p.waitForTimeout(450);
};

// Alles der Reihe nach durchklicken
for (const t of ['ai','tasks','calendar','files','ideas','reminders','settings','team']) {
  const k = p.locator(`[data-tour="${t}"]`);
  if (await k.count()) { await k.click(); await p.waitForTimeout(1300); await pruefen(`Reiter ${t}`); }
}
for (const [taste, name] of [['Meta+k','Schnellsuche'],['Meta+f','Suche'],['Meta+Shift+n','Neuer Kanal'],
                             ['Meta+Shift+t','Aufgaben'],['Meta+Shift+e','Kalender'],['Meta+Shift+d','Dateien'],
                             ['Meta+Shift+i','Ideen'],['Meta+,','Einstellungen']]) {
  await p.keyboard.press(taste); await p.waitForTimeout(1200); await pruefen(name);
}
// Die Kopfzeilen-Knöpfe
await p.locator('.chan').filter({ hasText: 'allgemein' }).first().click(); await p.waitForTimeout(900);
const knoepfe = await p.locator('.header__actions button').count();
for (let i = 0; i < knoepfe; i++) {
  await p.locator('.header__actions button').nth(i).click().catch(()=>{});
  await p.waitForTimeout(1600);
  await pruefen(`Kopfzeile ${i}`);
}
// Und das Tutorial
await p.evaluate(() => localStorage.removeItem('stellium.tourGesehen'));
await p.reload(); await p.waitForSelector('.app'); await p.waitForTimeout(2500);
await pruefen('Einführung');
console.log('durchgelaufen');
await b.close();
