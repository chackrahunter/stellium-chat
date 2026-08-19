/**
 * Kommen Fehlermeldungen in der eingestellten Sprache an?
 *
 * Der Server antwortet auf Deutsch und legt eine Kennung bei. Geprüft wird,
 * dass die Kennung wirklich mitkommt — ohne sie kann die Oberfläche nichts
 * übersetzen und zeigt jedem Menschen Deutsch, egal was er eingestellt hat.
 */
import { probeserver } from './probeserver.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const probe = await probeserver();
const S = probe.S;
const holen = async (pfad, rumpf) => {
  const antwort = await fetch(`${S}${pfad}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rumpf ?? {}),
  });
  return { status: antwort.status, ...(await antwort.json().catch(() => ({}))) };
};

console.log('\nFehlermeldungen tragen eine Kennung');

await pruefe('Falsches Passwort', async () => {
  const a = await holen('/api/auth/login', { login: 'niemand', password: 'falsch' });
  muss(a.status === 401, `Status ${a.status}`);
  muss(a.code === 'fehler.loginFalsch', `Kennung fehlt (${a.code ?? 'keine'})`);
  return a.code;
});

await pruefe('Zugangsdaten fehlen', async () => {
  const a = await holen('/api/auth/login', {});
  muss(a.code === 'fehler.zugangsdatenFehlen', `Kennung fehlt (${a.code ?? 'keine'})`);
});

await pruefe('Selbstanmeldung gibt es nicht', async () => {
  const a = await holen('/api/auth/register', {});
  muss(a.code === 'fehler.keineSelbstanmeldung', `Kennung fehlt (${a.code ?? 'keine'})`);
});

await pruefe('Der deutsche Text bleibt als Rückfall stehen', async () => {
  const a = await holen('/api/auth/login', { login: 'niemand', password: 'falsch' });
  muss(typeof a.error === 'string' && a.error.length > 5, 'kein Text dabei');
  return `„${a.error}"`;
});

await pruefe('Jede Kennung hat einen Text in allen 22 Sprachen', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const ordner = 'packages/desktop/src/i18n';
  const codes = ['fehler.loginFalsch', 'fehler.zugangsdatenFehlen', 'fehler.keineSelbstanmeldung',
    'fehler.zuVieleVersuche', 'fehler.kontoGesperrt', 'fehler.keinRecht',
    'fehler.keineDatei', 'fehler.nichtAngemeldet', 'fehler.dateiNichtGefunden'];
  const sprachen = readdirSync(ordner).filter((d) => /^[a-z]{2}\.ts$/.test(d));
  const fehlend = [];
  for (const datei of sprachen) {
    const inhalt = readFileSync(`${ordner}/${datei}`, 'utf8');
    for (const c of codes) if (!inhalt.includes(`'${c}'`)) fehlend.push(`${datei}:${c}`);
  }
  muss(fehlend.length === 0, `${fehlend.length} fehlen, z. B. ${fehlend[0]}`);
  return `${codes.length} Kennungen × ${sprachen.length} Sprachen`;
});

await probe.stop();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
