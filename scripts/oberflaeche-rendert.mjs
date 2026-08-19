/**
 * Kommt überhaupt etwas auf den Schirm?
 *
 * Zwei Vorfälle an einem Abend haben gezeigt, dass die Typprüfung das nicht
 * beantwortet. Ein `t(...)` außerhalb seines Gültigkeitsbereichs in
 * Sidebar.tsx hat React den ganzen Baum aushängen lassen — `#root` war leer,
 * die App zeigte nichts, und `tsc` meldete dabei null Fehler. Ein Fehler
 * dieser Art ist von außen nicht zu übersehen und von innen nicht zu sehen.
 *
 * Deshalb die stumpfste aller Fragen: Seite laden, nachsehen, ob unter
 * `#root` etwas hängt. Zusätzlich wird jeder unbehandelte Fehler der Seite
 * eingesammelt — ein leerer Baum kommt fast immer mit einem im Schlepptau.
 *
 * Bewusst gegen einen eigenen Probeserver statt gegen die
 * Entwicklungsdatenbank: sonst hängt der Lauf an fremden Zugangsdaten.
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
const browser = await chromium.launch({ headless: true });

/* Fehler der Seite gehören zum Befund, nicht ins Leere. */
function beobachte(p) {
  const fehler = [];
  p.on('pageerror', (e) => fehler.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  return fehler;
}

const kinder = (p) => p.evaluate(() => document.getElementById('root')?.children.length ?? -1);

console.log('\nOberfläche');

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'de-DE' });
const p = await ctx.newPage();
const fehler = beobachte(p);

await pruefe('Die Seite antwortet', async () => {
  const a = await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 30000 });
  muss(a && a.status() < 400, `HTTP ${a?.status()}`);
  return `HTTP ${a.status()}`;
});

await pruefe('#root ist nicht leer — die Anmeldung erscheint', async () => {
  await p.waitForFunction(() => (document.getElementById('root')?.children.length ?? 0) > 0, { timeout: 30000 });
  const n = await kinder(p);
  muss(n > 0, `#root hat ${n} Kinder`);
  return `${n} Kind(er)`;
});

await pruefe('Die Seite trägt sichtbaren Text', async () => {
  const t = (await p.evaluate(() => document.body.innerText || '')).trim();
  muss(t.length > 10, `nur ${t.length} Zeichen sichtbar`);
  return `${t.length} Zeichen`;
});

await pruefe('Angemeldet hängt die App unter #root', async () => {
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
  }, [probe.S, probe.token]);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.app', { timeout: 30000 });
  const n = await kinder(p);
  muss(n > 0, `#root hat ${n} Kinder`);
  return `${n} Kind(er), .app vorhanden`;
});

await pruefe('Kein unbehandelter Fehler beim Laden', async () => {
  /* Fehlende Symbole und Netzhänger der Probeumgebung sind kein Befund über
     den Baum — gesucht sind die Abstürze, die das Rendern beenden. */
  const echt = fehler.filter((f) => !/favicon|net::ERR|Failed to load resource/i.test(f));
  muss(echt.length === 0, `${echt.length}: ${echt[0]?.slice(0, 120)}`);
  return 'keiner';
});

await ctx.close();
await browser.close();
await probe.stop();

const gut = ergebnisse.filter(Boolean).length;
console.log(`\n${gut}/${ergebnisse.length} bestanden`);
process.exit(gut === ergebnisse.length ? 0 : 1);
