/** Der Thread muss bei jeder Fensterbreite neben dem Verlauf liegen, nicht darin. */
import { chromium } from 'playwright';
import { APP, LOGIN, PW, SERVER as S } from './zugang.mjs';


const ergebnisse = [];
const pruefe = (n, f) => {
  try { const x = f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true });

for (const breite of [1440, 1100, 1000, 940, 900, 860, 700, 390]) {
  const p = await (await b.newContext({ viewport: { width: breite, height: 760 }, locale: 'de-DE' })).newPage();
  await p.goto(APP);
  await p.evaluate((s) => { localStorage.setItem('stellium.serverUrl', s); localStorage.setItem('stellium.tourGesehen', 'ja'); }, S);
  await p.reload(); await p.waitForTimeout(1200);
  if (await p.locator('.auth').count()) {
    await p.locator('.auth input').first().fill(LOGIN);
    await p.locator('.auth input[type="password"]').first().fill(PW);
    await p.locator('.auth button[type="submit"]').first().click();
  }
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1600);

  await p.evaluate(() => {
    const s = window.__stelliumStore.getState();
    const liste = s.messages[s.activeChannelId] ?? [];
    const letzte = liste[liste.length - 1];
    if (letzte) s.openThread(letzte.id);
  });
  await p.waitForSelector('.thread', { timeout: 8000 });
  await p.waitForTimeout(700);

  const m = await p.evaluate(() => {
    const t = document.querySelector('.thread').getBoundingClientRect();
    const haupt = document.querySelector('.main')?.getBoundingClientRect();
    const kopf = document.querySelector('.thread__head, .thread h3, .thread header');
    return {
      t: { x: t.x, r: t.right, b: t.width, h: t.height },
      haupt: haupt ? { x: haupt.x, r: haupt.right, b: haupt.width } : null,
      kopfB: kopf ? kopf.getBoundingClientRect().width : null,
      seitlich: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  pruefe(`${breite} px: Thread liegt am rechten Rand`, () => {
    muss(Math.abs(m.t.r - breite) < 2, `endet bei ${Math.round(m.t.r)} statt ${breite}`);
    muss(m.t.b >= 300, `nur ${Math.round(m.t.b)} px breit`);
    return `${Math.round(m.t.b)} px`;
  });

  /* Unter 880 legt sich der Thread bewusst über den Verlauf — dort gibt es
     nichts zu prüfen, und die Prüfung wird deshalb gar nicht erst angemeldet.
     Vorher stand sie in der Liste und gab ein Häkchen zurück, ohne etwas
     gemessen zu haben: bei drei der vier Breiten war sie ein bestandener Lauf
     ohne Inhalt. Auch `!m.haupt` — gar kein Verlauf zu sehen — zählte dort als
     bestanden, und das ist kein gewollter Fall, sondern ein kaputter. */
  if (breite > 880) {
    pruefe(`${breite} px: Verlauf und Thread überlappen nicht`, () => {
      muss(m.haupt, 'kein Verlauf sichtbar');
      muss(m.haupt.r <= m.t.x + 2, `Verlauf endet bei ${Math.round(m.haupt.r)}, Thread beginnt bei ${Math.round(m.t.x)}`);
      muss(m.haupt.b > 200, `Verlauf nur ${Math.round(m.haupt.b)} px breit`);
      return `Verlauf ${Math.round(m.haupt.b)} px`;
    });
  } else {
    console.log(`  · ${breite} px: Thread liegt bewusst über dem Verlauf — nichts zu prüfen`);
  }

  pruefe(`${breite} px: nichts läuft seitlich heraus`, () => {
    muss(m.seitlich <= 1, `${m.seitlich} px zu breit`);
  });

  await p.context().close();
}

await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
