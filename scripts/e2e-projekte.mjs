/**
 * Projekte, der Reiter „Prüfen" und die technischen Konten.
 *
 * Die drei hängen zusammen: Ein Projekt ist die Schublade, „Prüfen" der
 * Eingang für alles, was die KI selbst eingetragen hat, und ein technisches
 * Konto darf in keiner der beiden Listen auftauchen — es kann weder eine
 * Aufgabe übernehmen noch auf eine Direktnachricht antworten.
 */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' })).newPage();
p.on('pageerror', (e) => console.log('  ⚠ Seitenfehler:', e.message));
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

await pruefe('Aufgabenbrett kennt Projekte', async () => {
  await p.locator('.rail [data-tour="tasks"]').click();
  await p.waitForSelector('.panel', { timeout: 8000 });
  await p.waitForTimeout(600);
  muss(await p.locator('.panel .pill--select').count(), 'keine Projektwahl in der Kopfzeile');
  /* button.pill, nicht .pill: das Auswahlfeld daneben trägt dieselbe
     Beschriftung, und ein Klick darauf öffnet nichts. */
  const knopf = p.locator('.panel__head button.pill', { hasText: /Projekte|Projects/ });
  muss(await knopf.count(), 'kein Projekte-Knopf');
  return 'Auswahl und Knopf da';
});

await pruefe('Projekt anlegen und wieder löschen', async () => {
  await p.locator('.panel__head button.pill', { hasText: /Projekte|Projects/ }).first().click();
  await p.waitForTimeout(700);
  const dialog = p.locator('.panel').last();
  await dialog.locator('input.input').first().fill('Prüfprojekt');
  await dialog.locator('.btn--primary', { hasText: /Anlegen|Create/ }).first().click();
  await p.waitForTimeout(900);
  muss(await dialog.locator('.projekt-zeile', { hasText: 'Prüfprojekt' }).count(), 'Projekt erscheint nicht in der Liste');
  const zahl = await dialog.locator('.projekt-zeile', { hasText: 'Prüfprojekt' }).locator('.projekt-zeile__zahl').innerText();
  p.once('dialog', (d) => d.accept());
  await dialog.locator('.projekt-zeile', { hasText: 'Prüfprojekt' }).locator('.icon-btn').last().click();
  await p.waitForTimeout(800);
  muss(!(await dialog.locator('.projekt-zeile', { hasText: 'Prüfprojekt' }).count()), 'Projekt blieb nach dem Löschen stehen');
  return zahl.trim();
});

await pruefe('Aufgabe lässt sich einem Projekt zuordnen', async () => {
  const dialog = p.locator('.panel').last();
  await dialog.locator('input.input').first().fill('Dauerprojekt');
  await dialog.locator('.btn--primary', { hasText: /Anlegen|Create/ }).first().click();
  await p.waitForTimeout(900);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
  await p.locator('.panel__head .pill--accent', { hasText: /Neue Aufgabe|New task/ }).first().click();
  await p.waitForTimeout(700);
  const neu = p.locator('.panel').last();
  const optionen = await neu.locator('select').last().locator('option').allInnerTexts();
  muss(optionen.some((o) => o.includes('Dauerprojekt')), `Projekt fehlt in der Auswahl: ${optionen.join('|')}`);
  return `${optionen.length} Einträge`;
});

await pruefe('Technische Konten sind nicht erwähnbar', async () => {
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  const versteckt = await p.evaluate(() => {
    const store = window.__stelliumStore.getState();
    const alle = Object.values(store.users);
    return {
      gesamt: alle.length,
      technisch: alle.filter((u) => u.technisch).length,
      namen: alle.filter((u) => u.technisch).map((u) => u.handle),
    };
  });
  muss(versteckt.technisch > 0, 'kein technisches Konto vorhanden — Prüfung ohne Aussage');
  await p.locator('.composer__input').fill('@');
  await p.waitForTimeout(700);
  const vorschlaege = await p.locator('.mention-item, .autocomplete__item, .composer__auto li').allInnerTexts().catch(() => []);
  for (const name of versteckt.namen) {
    muss(!vorschlaege.some((v) => v.includes(name)), `technisches Konto ${name} steht in der Erwähnungsliste`);
  }
  await p.locator('.composer__input').fill('');
  return `${versteckt.technisch} technisch von ${versteckt.gesamt}`;
});

await pruefe('KI-Einstellung steht in den Einstellungen', async () => {
  /* Erst aufräumen, was der vorige Schritt offen gelassen hat: ein Fenster
     darüber fängt den Klick auf die Leiste ab, und die Prüfung scheitert an
     der Reihenfolge statt an der Sache. */
  for (let i = 0; i < 6 && await p.locator('.scrim').count(); i++) {
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
  }
  await p.locator('.rail [data-tour="settings"]').click();
  await p.waitForTimeout(900);
  const text = await p.locator('.panel').last().innerText();
  muss(/trägt selbst ein|adds entries itself/i.test(text), 'Schalter „KI trägt selbst ein" fehlt');
  return 'sichtbar';
});

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
