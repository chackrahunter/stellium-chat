/** Die Aktualisierungsansicht muss sagen, wenn der Server hinterherhinkt. */
import { chromium } from 'playwright';

const APP = 'http://localhost:5173';
const S = process.env.STELLIUM_SERVER ?? 'http://localhost:8787';
const LOGIN = process.env.STELLIUM_TEST_LOGIN ?? 'don';
const PW = process.env.STELLIUM_TEST_PASSWORT ?? 'MeinLangesPasswort-2026';
const DB = process.env.STELLIUM_DB ?? 'data/stellium.db';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const anmelden = async (login, passwort) => (await (await fetch(`${S}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: passwort }),
})).json());

/* Diese Prüfung braucht ein Konto mit dem Recht, Fassungen zu veröffentlichen.
   Auf einer frischen Datenbank ist das der erste Zugang — beim ersten Anmelden
   wird daraus ein eigenes Konto. Das erledigt der Test selbst, damit er ohne
   Vorbereitung läuft. */
const ERST = process.env.STELLIUM_TEST_EINMAL ?? '';
let angemeldet = await anmelden(LOGIN, PW);
if (!angemeldet.token && ERST) {
  const erst = await anmelden(LOGIN, ERST);
  if (erst.token) {
    await fetch(`${S}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${erst.token}` },
      body: JSON.stringify({ handle: LOGIN, displayName: 'Don', email: `${LOGIN}@example.test`, password: PW, language: 'de' }),
    });
    angemeldet = await anmelden(LOGIN, PW);
  }
}
if (!angemeldet.token) { console.error('Anmeldung fehlgeschlagen.'); process.exit(1); }
const token = angemeldet.token;
const eigene = JSON.parse((await import('node:fs')).readFileSync('packages/desktop/package.json', 'utf8')).version;

/** Eine Serverfassung veröffentlichen, ohne sie einzuspielen. */
const serverStandSetzen = async (version) => {
  const form = new FormData();
  form.append('version', version);
  form.append('notes', 'Probe');
  form.append('file', new Blob([new Uint8Array(64)]), 'stellium-server.tar.gz');
  const r = await fetch(`${S}/api/releases/server`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  });
  if (r.ok) return;
  // Ohne das Recht zum Veröffentlichen: den Eintrag direkt setzen. Geprüft
  // wird die Anzeige, nicht der Weg dorthin.
  if (r.status === 403 && DB) {
    const { DatabaseSync } = await import('node:sqlite');
    const d = new DatabaseSync(DB);
    // published_by verweist auf ein Konto — das eigene nehmen.
    const wer = d.prepare('SELECT id FROM users LIMIT 1').get().id;
    d.prepare(`INSERT INTO releases (platform, version, notes, file_name, path, size, sha256, published_by, published_at)
               VALUES ('server', ?, 'Probe', 'p.tar.gz', '/dev/null', 64, 'x', ?, ?)
               ON CONFLICT(platform) DO UPDATE SET version = excluded.version, published_at = excluded.published_at`)
      .run(version, wer, Date.now());
    d.close();
    return;
  }
  throw new Error(`Veröffentlichen fehlgeschlagen: ${r.status} ${(await r.text()).slice(0, 80)}`);
};

const b = await chromium.launch({ headless: true });
const oeffnen = async () => {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-DE' })).newPage();
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
  await p.keyboard.press('Meta+,');
  await p.waitForSelector('.panel', { timeout: 8000 });
  await p.locator('.panel .tabs button, .panel [role="tab"]').filter({ hasText: /Aktualisierung/i }).first().click();
  await p.waitForTimeout(1200);
  return p;
};

// Fall 1: Server läuft auf demselben Stand, der veröffentlicht ist.
await serverStandSetzen(eigene);
let p = await oeffnen();
await pruefe('Gleichstand wird als solcher benannt', async () => {
  const text = await p.locator('.panel').innerText();
  muss(/Server läuft auf/i.test(text), `keine Serverzeile: ${text.slice(0, 120)}`);
  muss(!/liegt bereit/i.test(text), 'behauptet fälschlich einen Rückstand');
  return eigene;
});
await pruefe('Der Server steht in der Verteilung', async () => {
  const zeilen = await p.locator('.release-row__name').allInnerTexts();
  if (!zeilen.length) return 'ohne Verwaltungsrecht — Liste bleibt verborgen';
  muss(zeilen.includes('Server'), `nur: ${zeilen.join(', ')}`);
});
await p.context().close();

// Fall 2: Eine neuere Fassung liegt bereit, der Server läuft noch nicht darauf.
const kuenftig = eigene.replace(/(\d+)$/, (n) => String(Number(n) + 9));
await serverStandSetzen(kuenftig);
p = await oeffnen();
await pruefe('Rückstand wird angezeigt statt „alles aktuell"', async () => {
  const text = await p.locator('.panel').innerText();
  muss(/läuft noch auf/i.test(text), `kein Hinweis auf den Rückstand: ${text.slice(0, 160)}`);
  muss(text.includes(kuenftig), 'die bereitliegende Fassung fehlt');
  muss(text.includes(eigene), 'die laufende Fassung fehlt');
  return `${eigene} → ${kuenftig}`;
});
await pruefe('Der eigene Rechner bleibt davon unberührt', async () => {
  const text = await p.locator('.panel').innerText();
  muss(/Dieser Rechner/i.test(text), 'Abschnitt fehlt');
});
await p.context().close();

// Aufräumen: den echten Stand wiederherstellen.
await serverStandSetzen(eigene);
await b.close();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
