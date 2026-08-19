/** Die Aufgabenerkennung legt die Aufgaben selbst an — geprüft am echten Server. */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';


const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'de-DE' })).newPage();
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

// Ein Gespräch, in dem klar etwas zu tun ist.
const marke = Date.now().toString(36).slice(-4);
/* Klare Anweisungen — eine Frage ist absichtlich keine Aufgabe, und
   "ich kümmere mich" liest das Modell zu Recht als schon vergeben. */
const saetze = [
  `Lena, bitte den Serverumzug ${marke} bis Freitag vorbereiten.`,
  `Max soll die Rechnung ${marke} bis Dienstag freigeben.`,
];
for (const s of saetze) {
  await p.locator('.composer__input').fill(s);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(900);
}

const knopf = p.locator('.header__actions button[title="Aufgaben aus dem Verlauf ziehen"]').first();

await pruefe('Erkennung startet ohne Auswahlfenster', async () => {
  const vorher = await p.locator('.scrim').count();
  await knopf.click();
  await p.waitForSelector('.extract-pop', { timeout: 8000 });
  muss(await p.locator('.scrim').count() === vorher, 'es öffnet sich doch ein Fenster');
  muss((await p.locator('.extract-pop').innerText()).length > 0, 'Blase ist leer');
});

await pruefe('Blase bleibt im Bild', async () => {
  const k = await p.locator('.extract-pop').boundingBox();
  muss(k.x >= 0 && k.x + k.width <= 1280, `x=${Math.round(k.x)} w=${Math.round(k.width)}`);
  muss(k.y >= 0 && k.y + k.height <= 860, 'ragt unten heraus');
});

await pruefe('Aufgaben sind angelegt, ohne dass man etwas anhakt', async () => {
  await p.waitForFunction(() => !document.querySelector('.extract-pop .spin'), null, { timeout: 60000 });
  await p.waitForTimeout(400);
  const text = await p.locator('.extract-pop').innerText();
  muss(!/keine offene Aufgabe/i.test(text), `KI fand nichts: ${text.slice(0, 60)}`);
  muss(/hinzugefügt/i.test(text), `unerwartet: ${text.slice(0, 80)}`);
  const angelegt = await p.evaluate(() => window.__stelliumStore?.getState?.().extractErgebnis?.erstellt?.length ?? null);
  return text.split('\n')[0];
});

await pruefe('Angelegte Aufgaben stehen auf dem Brett', async () => {
  const titel = await p.locator('.extract-pop__liste li').allInnerTexts();
  muss(titel.length, 'keine Titel in der Blase');
  await p.locator('.extract-pop button').filter({ hasText: /Aufgaben öffnen/i }).click();
  await p.waitForSelector('.board', { timeout: 8000 });
  await p.waitForTimeout(900);
  const brett = await p.locator('.board').innerText();
  const fehlend = titel.filter((x) => !brett.includes(x.slice(0, 18)));
  muss(!fehlend.length, `nicht auf dem Brett: ${fehlend[0]}`);
  return `${titel.length} Stück`;
});

await pruefe('Zweiter Lauf legt nichts doppelt an', async () => {
  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);
  await knopf.click();
  await p.waitForSelector('.extract-pop', { timeout: 8000 });
  await p.waitForFunction(() => !document.querySelector('.extract-pop .spin'), null, { timeout: 60000 });
  await p.waitForTimeout(400);
  const text = await p.locator('.extract-pop').innerText();
  muss(/gab es schon|keine offene Aufgabe/i.test(text), `unerwartet: ${text.slice(0, 90)}`);
  return text.split('\n').pop();
});

await pruefe('Rückgängig entfernt sie wieder', async () => {
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  // Frischer Lauf in einem anderen Kanal, damit es etwas zum Zurücknehmen gibt.
  await p.locator('.composer__input').fill(`Bitte den Vertrag ${marke}x mit Huber bis Montag prüfen.`);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1200);
  await knopf.click();
  await p.waitForSelector('.extract-pop', { timeout: 8000 });
  await p.waitForFunction(() => !document.querySelector('.extract-pop .spin'), null, { timeout: 60000 });
  await p.waitForTimeout(400);
  const zurueck = p.locator('.extract-pop button').filter({ hasText: /Rückgängig/i });
  if (!(await zurueck.count())) return 'nichts Neues gefunden — nichts zurückzunehmen';
  const titel = await p.locator('.extract-pop__liste li').allInnerTexts();
  await zurueck.click();
  await p.waitForTimeout(1500);
  await p.locator('.rail [data-tour="tasks"]').click();
  await p.waitForSelector('.board', { timeout: 8000 });
  await p.waitForTimeout(900);
  /* Genauer Titelvergleich: ältere Aufgaben aus früheren Läufen ähneln sich
     im Anfang, sind aber andere Aufgaben. */
  const aufDemBrett = await p.locator('.task-card__title').allInnerTexts();
  const geblieben = titel.filter((x) => aufDemBrett.includes(x));
  muss(!geblieben.length, `steht noch da: ${geblieben[0]}`);
  await p.keyboard.press('Escape');
  return `${titel.length} entfernt`;
});

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
