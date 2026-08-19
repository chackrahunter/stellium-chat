/**
 * Sichtprüfung der Oberfläche auf einem eigenen Server.
 *
 * Bewusst ohne die Entwicklungsdatenbank: die braucht persönliche Zugangsdaten
 * und ein Masterpasswort aus der Keychain. Ein Prüflauf, der davon abhängt,
 * läuft auf keinem zweiten Rechner — und schlägt fehl, sobald jemand sein
 * Passwort ändert.
 */
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const probe = await probeserver();
const kopf = probe.kopf;

// Ein paar Nachrichten, damit die Liste überhaupt scrollen kann.
const kanaele = await (await fetch(`${probe.S}/api/bootstrap`, { headers: kopf })).json();
const kanal = kanaele.channels?.find((c) => c.kind === 'public') ?? kanaele.channels?.[0];

const browser = await chromium.launch({ headless: true });

async function seite({ width, height }) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: 'de-DE' });
  const p = await ctx.newPage();
  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1200);
  if (kanal) {
    await p.evaluate((id) => window.dispatchEvent(new CustomEvent('stellium:kanal-oeffnen', { detail: id })), kanal.id);
    await p.waitForTimeout(900);
  }
  return { p, ctx };
}

console.log('\nTelefon (390 × 844)');
{
  const { p, ctx } = await seite({ width: 390, height: 844 });

  await pruefe('In der Kopfzeile bleiben Knöpfe übrig', async () => {
    const sichtbar = await p.locator('.header__actions button:visible').count();
    muss(sichtbar >= 1, 'kein einziger Knopf sichtbar');
    return `${sichtbar} Knöpfe`;
  });

  await pruefe('Nichts liegt über dem Eingabefeld', async () => {
    const feld = await p.locator('.composer').boundingBox();
    muss(feld, 'kein Eingabefeld gefunden');
    const mitte = { x: feld.x + feld.width / 2, y: feld.y + feld.height / 2 };
    const oben = await p.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}` : 'nichts';
    }, mitte);
    muss(!oben.includes('icon-btn'), `dort liegt ${oben}`);
    return oben;
  });

  await pruefe('Die Seite läuft nicht seitlich über', async () => {
    const ueber = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    muss(ueber <= 1, `${ueber}px zu breit`);
  });

  await ctx.close();
}

console.log('\nSchreibtisch (1440 × 900)');
{
  const { p, ctx } = await seite({ width: 1440, height: 900 });
  await pruefe('Der Chat steht neben der Liste', async () => {
    const liste = await p.locator('.sidebar').boundingBox();
    const chat = await p.locator('.main').boundingBox();
    muss(liste && chat, 'Aufbau unvollständig');
    muss(chat.x >= liste.x + liste.width - 2, 'der Chat liegt unter der Liste');
  });
  await pruefe('Keine leeren Flächen durch fehlende Farbwerte', async () => {
    const durchsichtig = await p.evaluate(() => {
      let n = 0;
      for (const el of document.querySelectorAll('.card, .panel, .msg, .sidebar, .rail')) {
        const f = getComputedStyle(el).backgroundColor;
        if (f === 'rgba(0, 0, 0, 0)' && el.classList.contains('card')) n += 1;
      }
      return n;
    });
    muss(durchsichtig === 0, `${durchsichtig} Flächen ohne Farbe`);
  });
  await ctx.close();
}

await browser.close();
await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
