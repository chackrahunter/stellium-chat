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
import { verlaufSaeen } from './verlauf-saeen.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const probe = await probeserver();

/* Ein paar Nachrichten, damit die Liste überhaupt scrollen kann.

   Hier stand einmal ein `fetch` auf `/api/bootstrap` — eine Adresse, die es
   nicht gibt. Sie antwortete mit 404, `kanaele.channels` war undefiniert, das
   `if (kanal)` weiter unten sprang still darüber hinweg, und sämtliche
   Layoutprüfungen maßen einen Bildschirm ohne geöffneten Kanal. Nichts davon
   war zu sehen: der Lauf meldete grün. Deshalb kommen die Nachrichten jetzt
   über den Weg, den auch die App nimmt, und der Kanal kommt aus der Antwort
   des Servers statt aus einer erfundenen Route. */
const { kanalId } = await verlaufSaeen(probe, 40);

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
  await p.evaluate((id) => window.dispatchEvent(new CustomEvent('stellium:kanal-oeffnen', { detail: id })), kanalId);
  /* Auf die Nachrichten warten und nicht auf die Uhr: ohne sie misst jede
     Prüfung darunter einen leeren Kanal — und ein leerer Kanal beschwert sich
     nicht, er sieht bloß aufgeräumt aus. */
  await p.waitForFunction(() => document.querySelectorAll('.msg').length > 0, null, { timeout: 20000 });
  return { p, ctx };
}

/* Alles ab hier in ein try/finally: bricht `seite()` ab — und sie kann das,
   sie wartet auf die Oberfläche und auf Nachrichten —, blieben sonst ein
   Browser und der Datenordner des Probeservers liegen. */
try {
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
    /* Diese Prüfung konnte nicht durchfallen. Gezählt wurde nur, was
       `el.classList.contains('card')` erfüllt — eine blanke Klasse `card`, die
       es in der Oberfläche nirgends gibt (es gibt `ai-card`, `task-card`,
       `link-card`, `tour__card`, `auth__card`). Die Schleife lief also über
       Elemente, von denen keines je gezählt wurde, und meldete jedes Mal 0.

       Gemessen wird jetzt an den Flächen, denen das Stylesheet ausdrücklich
       einen Hintergrund gibt (`.sidebar` und `.header` bekommen beide
       `var(--bg-panel)`). Fällt eine Farbvariable aus, stehen sie durchsichtig
       da — und genau das ist der Schaden, um den es hier geht. Dass überhaupt
       etwas gemessen wurde, wird mitgeprüft: eine leere Auswahl ist kein
       bestandener Lauf, sondern ein blinder. */
    const { gefunden, durchsichtig } = await p.evaluate(() => {
      const flaechen = [...document.querySelectorAll('.sidebar, .header')];
      return {
        gefunden: flaechen.length,
        durchsichtig: flaechen
          .filter((el) => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)')
          .map((el) => el.className)
          .join(', '),
      };
    });
    muss(gefunden > 0, 'keine einzige Fläche gefunden — dann sagt die Prüfung nichts');
    muss(!durchsichtig, `ohne Farbe: ${durchsichtig}`);
    return `${gefunden} Flächen`;
  });
  await ctx.close();
}
} finally {
  await browser.close().catch(() => { /* schon zu */ });
  await probe.stop();
}

const schlecht = ergebnisse.filter((x) => !x).length;
/* Ein Lauf ohne eine einzige Prüfung ist kein bestandener Lauf. Ohne diese
   Zeile hätte „0/0 bestanden" den Rückgabewert 0 — grün, ohne etwas gemessen
   zu haben. */
if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
