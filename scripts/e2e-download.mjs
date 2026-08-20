/** Die Download-Seite: aktuelle Fassung, passender Vorschlag, echte Datei. */
import { LOGIN, PW, SERVER as S } from './zugang.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/* Für die Prüfung müssen Fassungen hinterlegt sein. Auf dem Entwicklungsstand
   ist die Tabelle leer — dann werden die eben gebauten Pakete eingetragen. */
const DB = process.env.STELLIUM_DB ?? 'data/stellium.db';
{
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  const pfad = await import('node:path');
  const d = new DatabaseSync(DB);
  /* Auch neu eintragen, wenn die hinterlegten Pfade ins Leere zeigen —
     alte Pakete werden beim Aufräumen gelöscht. */
  const eintraege = d.prepare("SELECT path FROM releases WHERE platform <> 'server'").all();
  const brauchbar = eintraege.length > 0 && eintraege.every((r) => fs.existsSync(r.path));
  if (!brauchbar) {
    const ordner = 'packages/desktop/release';
    const version = JSON.parse(fs.readFileSync('packages/desktop/package.json', 'utf8')).version;
    const wer = d.prepare('SELECT id FROM users LIMIT 1').get().id;
    const dateien = fs.existsSync(ordner) ? fs.readdirSync(ordner) : [];
    const suche = (muster) => dateien.find((n) => muster.test(n) && n.includes(version));
    for (const [plattform, muster] of [
      ['darwin', /universal\.dmg$/], ['win32', /^Stellium-[\d.]+\.exe$/], ['linux', /x86_64\.AppImage$/],
    ]) {
      const name = suche(muster);
      if (!name) continue;
      const voll = pfad.resolve(ordner, name);
      // Echte Prüfsumme: die Update-Prüfung verlässt sich darauf.
      const krypto = await import('node:crypto');
      const summe = krypto.createHash('sha256').update(fs.readFileSync(voll)).digest('hex');
      d.prepare(`INSERT INTO releases (platform, version, notes, file_name, path, size, sha256, published_by, published_at)
                 VALUES (?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(platform) DO UPDATE SET version = excluded.version, path = excluded.path,
                   file_name = excluded.file_name, size = excluded.size, sha256 = excluded.sha256,
                   published_at = excluded.published_at`)
        .run(plattform, version, 'Erste Zeile der Änderungsliste\nZweite Zeile', name, voll,
             fs.statSync(voll).size, summe, wer, Date.now());
    }
    console.log('  (Fassungen für die Prüfung eingetragen)');
  }
  d.close();
}

const KENNUNGEN = {
  macOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  Windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
};
const ERWARTET = { macOS: 'macOS', Windows: 'Windows', Linux: 'Linux' };

/* Die Seite liegt hinter der Anmeldung — der Nachweis steht in der Adresse. */
const { token } = await (await fetch(`${S}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: LOGIN, password: PW }),
})).json();
const mitZugang = (pfad) => `${S}${pfad}${pfad.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

const seite = async (ua) => (await fetch(mitZugang('/download'), { headers: { 'user-agent': ua } })).text();

await pruefe('Seite ist mit Anmeldung erreichbar', async () => {
  const r = await fetch(mitZugang('/download'), { headers: { 'user-agent': KENNUNGEN.macOS } });
  muss(r.status === 200, `Status ${r.status}`);
  muss((r.headers.get('content-type') ?? '').includes('text/html'), 'kein HTML');
});

for (const [system, ua] of Object.entries(KENNUNGEN)) {
  await pruefe(`${system}: passender Vorschlag`, async () => {
    const html = await seite(ua);
    if (system === 'iPhone') {
      // Für ein Telefon gibt es keine App — dann ohne Empfehlung, aber mit Liste.
      muss(!/Für dieses Gerät/.test(html), 'schlägt eine Desktop-App fürs Telefon vor');
      muss(/Alle Systeme/.test(html), 'zeigt gar keine Liste');
      return 'ohne Empfehlung, alle Systeme gelistet';
    }
    const abschnitt = html.split('Für dieses Gerät')[1] ?? '';
    const grosse = abschnitt.split('Andere Systeme')[0] ?? '';
    muss(/Für dieses Gerät/.test(html), 'kein Vorschlag');
    muss(grosse.includes(`<strong>${ERWARTET[system]}</strong>`), `schlägt nicht ${ERWARTET[system]} vor`);
    return ERWARTET[system];
  });
}

await pruefe('Alle drei Systeme stehen zur Wahl', async () => {
  const html = await seite(KENNUNGEN.macOS);
  for (const name of ['macOS', 'Windows', 'Linux']) {
    muss(html.includes(`<strong>${name}</strong>`), `${name} fehlt`);
  }
});

await pruefe('Die Seite zeigt die neueste Fassung', async () => {
  const html = await seite(KENNUNGEN.macOS);
  /* Ohne Zugang antwortet diese Adresse mit 401 — `r.ok` war falsch,
     `gemeldet` blieb null, und der einzige Abgleich, für den es diese Prüfung
     gibt, kam nie zustande. Jede andere Abfrage in dieser Datei geht über
     `mitZugang()`; diese eine war übersehen worden. */
  const r = await fetch(mitZugang('/api/releases/check?platform=darwin&version=0.0.1'));
  muss(r.ok, `der Server antwortet mit ${r.status} — es gibt nichts zu vergleichen`);
  const gemeldet = (await r.json()).update?.version;
  const aufDerSeite = (html.match(/Aktuell ist Version ([\d.]+)/) ?? [])[1];
  muss(aufDerSeite, 'keine Version genannt');
  muss(gemeldet, 'der Server nennt keine Fassung');
  muss(aufDerSeite === gemeldet, `Seite ${aufDerSeite}, Server ${gemeldet}`);
  return aufDerSeite;
});

await pruefe('Die Datei kommt wirklich', async () => {
  const r = await fetch(mitZugang('/download/darwin'), { method: 'HEAD' });
  muss(r.status === 200, `Status ${r.status}`);
  const laenge = Number(r.headers.get('content-length'));
  muss(laenge > 1_000_000, `nur ${laenge} Bytes`);
  muss((r.headers.get('content-disposition') ?? '').includes('attachment'), 'wird nicht als Datei geliefert');
  muss(r.headers.get('x-stellium-sha256'), 'ohne Prüfsumme');
  return `${(laenge / 1048576).toFixed(0)} MB`;
});

await pruefe('Das Serverpaket bleibt außen vor', async () => {
  const r = await fetch(mitZugang('/download/server'));
  muss(r.status === 404, `Status ${r.status}`);
});

await pruefe('Unbekanntes System bekommt kein Paket', async () => {
  const r = await fetch(mitZugang('/download/haiku'));
  muss(r.status === 404, `Status ${r.status}`);
});

await pruefe('Ohne Anmeldung führt die Seite zur Anmeldung', async () => {
  const r = await fetch(`${S}/download`, { redirect: 'manual', headers: { 'user-agent': KENNUNGEN.macOS } });
  muss(r.status === 302 || r.status === 301, `Status ${r.status}`);
});

await pruefe('Ohne Anmeldung gibt es keine Datei', async () => {
  const r = await fetch(`${S}/download/darwin`, { method: 'HEAD' });
  muss(r.status === 401, `Status ${r.status}`);
});

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
