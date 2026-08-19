/**
 * Öffnet jeden Dialog und jedes Aufklappmenü und misst, ob es vollständig im
 * Fenster liegt. Abgeschnittene Fenster sind der Fehler, der in dieser App am
 * häufigsten aufgetreten ist — meist, weil ein Weichzeichner darüber alles
 * darin einsperrt.
 */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';


const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};

const b = await chromium.launch({ headless: true });

/** Bei mehreren Fenstergrößen prüfen — auf einem kleinen fällt mehr auf. */
for (const [breite, hoehe] of [[1440, 900], [1180, 720], [900, 620]]) {
  console.log(`\n${breite}×${hoehe}`);
  const p = await (await b.newContext({ viewport: { width: breite, height: hoehe }, locale: 'de-DE' })).newPage();
  await p.goto(APP);
  await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
  await p.reload(); await p.waitForTimeout(1000);
  if (await p.locator('.auth').count()) {
    await p.locator('.auth input').first().fill(LOGIN);
    await p.locator('.auth input[type="password"]').first().fill(PW);
    await p.locator('.auth button[type="submit"]').first().click();
  }
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1200);

  /** Liegt alles Sichtbare im Fenster? */
  const misst = async (was) => {
    const mangel = await p.evaluate(({ b, h }) => {
      const schlecht = [];
      for (const el of document.querySelectorAll('.panel, .kontextmenue, .profile, .neu, [style*="position: fixed"]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 20) continue;
        if (r.top < -1 || r.left < -1 || r.bottom > h + 1 || r.right > b + 1) {
          schlecht.push({
            teil: el.className || el.tagName,
            oben: Math.round(r.top), unten: Math.round(r.bottom),
            links: Math.round(r.left), rechts: Math.round(r.right),
          });
        }
      }
      return schlecht;
    }, { b: breite, h: hoehe });
    if (mangel.length) {
      throw new Error(`ragt heraus: ${mangel.map((m) => `${m.teil} (${m.oben}…${m.unten})`).join(', ')}`);
    }
    return was;
  };

  const zu = async () => {
    for (let i = 0; i < 5; i++) {
      if (!(await p.locator('.scrim, .kontextmenue').count())) break;
      await p.keyboard.press('Escape');
      await p.waitForTimeout(260);
    }
  };

  /* ── Die Fenster aus der linken Leiste ─────────────────────── */
  for (const [reiter, name] of [
    ['tasks', 'Aufgaben'], ['calendar', 'Kalender'], ['files', 'Dateien'],
    ['ideas', 'Ideenboard'], ['reminders', 'Erinnerungen'], ['settings', 'Einstellungen'],
    ['team', 'Teamverwaltung'],
  ]) {
    const knopf = p.locator(`.rail [data-tour="${reiter}"]`);
    if (!(await knopf.count())) continue;
    await pruefe(name, async () => {
      await knopf.click();
      await p.waitForSelector('.panel', { timeout: 8000 });
      await p.waitForTimeout(700);
      return misst(await p.locator('.panel__head h2').first().innerText().catch(() => name));
    });
    await zu();
  }

  /* ── Fenster über Fenstern ─────────────────────────────────── */
  await pruefe('Aufgabe anlegen (im Brett)', async () => {
    await p.locator('.rail [data-tour="tasks"]').click();
    await p.waitForSelector('.panel');
    await p.locator('.panel__head .pill--accent').click();
    await p.waitForTimeout(700);
    return misst(`${await p.locator('.panel').count()} Ebenen`);
  });
  await zu();

  await pruefe('Aufgabe bearbeiten (Ansicht über dem Brett)', async () => {
    await p.locator('.rail [data-tour="tasks"]').click();
    await p.waitForSelector('.panel');
    await p.waitForTimeout(600);
    if (!(await p.locator('.task-card').count())) {
      await p.locator('.panel__head .pill--accent').click();
      await p.waitForTimeout(400);
      await p.locator('.panel input.input').first().fill(`Prüfaufgabe ${Date.now().toString(36).slice(-4)}`);
      await p.locator('.panel__foot .btn--primary').last().click();
      await p.waitForTimeout(1000);
    }
    await p.locator('.task-card').first().click();
    await p.waitForTimeout(800);
    return misst(`${await p.locator('.panel').count()} Ebenen`);
  });
  await zu();

  await pruefe('Termin anlegen (über dem Kalender)', async () => {
    await p.locator('.rail [data-tour="calendar"]').click();
    await p.waitForSelector('.week', { timeout: 8000 });
    await p.locator('.panel__head .pill--accent').click();
    await p.waitForTimeout(700);
    return misst(`${await p.locator('.panel').count()} Ebenen`);
  });
  await zu();

  await pruefe('Idee einbringen (über dem Board)', async () => {
    await p.locator('.rail [data-tour="ideas"]').click();
    await p.waitForSelector('.idea-bar', { timeout: 8000 });
    await p.locator('.panel__head .pill--accent').click();
    await p.waitForTimeout(700);
    return misst(`${await p.locator('.panel').count()} Ebenen`);
  });
  await zu();

  /* ── Aus dem Chat heraus ───────────────────────────────────── */
  await pruefe('Schnellsuche', async () => {
    await p.keyboard.press('Meta+k');
    await p.waitForTimeout(700);
    return misst();
  });
  await zu();

  await pruefe('Volltextsuche', async () => {
    await p.keyboard.press('Meta+f');
    await p.waitForTimeout(700);
    return misst();
  });
  await zu();

  await pruefe('Neuer Kanal', async () => {
    await p.keyboard.press('Meta+Shift+n');
    await p.waitForTimeout(700);
    return misst();
  });
  await zu();

  await pruefe('Emoji-Auswahl', async () => {
    await p.locator('.chan').filter({ hasText: 'allgemein' }).first().click();
    await p.waitForTimeout(700);
    await p.locator('.composer__bar button').nth(1).click();
    await p.waitForTimeout(700);
    return misst();
  });
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);

  await pruefe('Umfrage anlegen', async () => {
    await p.locator('.composer__bar button').nth(5).click();
    await p.waitForTimeout(800);
    return misst();
  });
  await zu();

  await pruefe('Kontextmenü am Kanal', async () => {
    await p.locator('.chan').filter({ hasText: 'allgemein' }).first().click({ button: 'right' });
    await p.waitForSelector('.kontextmenue', { timeout: 6000 });
    await p.waitForTimeout(400);
    return misst();
  });
  await zu();

  await pruefe('Kanaleinstellungen', async () => {
    await p.locator('.header__actions button').last().click();
    await p.waitForTimeout(800);
    return misst();
  });
  await zu();

  await pruefe('Profilkarte', async () => {
    await p.locator('.rail [data-tour="settings"]').click();
    await p.waitForTimeout(700);
    const r = await misst();
    await p.keyboard.press('Escape');
    return r;
  });
  await zu();

  await p.context().close();
}

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
