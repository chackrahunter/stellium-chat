#!/usr/bin/env node
/**
 * Eine Änderung fertig ausliefern — in einem Aufruf.
 *
 *   node scripts/ausliefern.mjs "Was neu ist (eine Zeile je Punkt)"
 *   node scripts/ausliefern.mjs --notizen=AENDERUNGEN.txt
 *   node scripts/ausliefern.mjs 1.3.0 "Große Sache"
 *
 * Der Reihe nach: Version hochzählen, prüfen, bauen, auf den Stellium-Server
 * hochladen (Apps und Server — dadurch laufen die OTA-Updates an), ein Release
 * auf GitHub anlegen, den Quelltextstand committen und schieben und die neue
 * Fassung auf diesem Mac installieren.
 *
 * Jeder Schritt lässt sich abschalten:
 *   --ohne-github     kein Release auf GitHub
 *   --ohne-server     Serverpaket nicht mitschicken (dann kein Server-Update)
 *   --ohne-hier       nicht lokal installieren
 *   --ohne-git        nicht committen und schieben
 *   --nur-mac         nur macOS bauen (schneller beim Ausprobieren)
 *   --minor / --major welche Stelle hochgezählt wird
 *   --probe           alles bauen, aber nichts senden
 *
 * Zugang: Benutzername und Passwort für den Stellium-Server kommen aus
 *   1. den Umgebungsvariablen STELLIUM_LOGIN / STELLIUM_PASSWORT
 *   2. dem Schlüsselbund (Dienst "stellium-veroeffentlichen")
 *   3. ~/.stellium-veroeffentlichen  (Zeile 1 Benutzername, Zeile 2 Passwort)
 * Steht nichts davon bereit, sagt das Skript, was zu tun ist, und hört auf.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = {
  aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m',
  gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', blau: '\x1b[38;5;111m', gelb: '\x1b[38;5;221m',
};
const sag = (t = '') => process.stdout.write(`${t}\n`);
const ok = (t) => sag(`  ${F.gruen}✓${F.aus} ${t}`);
const info = (t) => sag(`  ${F.grau}${t}${F.aus}`);
const warn = (t) => sag(`  ${F.gelb}!${F.aus} ${t}`);
const schritt = (t) => sag(`\n${F.blau}${F.fett}▸ ${t}${F.aus}`);
const raus = (t) => { sag(`\n${F.rot}✗ ${t}${F.aus}\n`); process.exit(1); };

const args = process.argv.slice(2);
const hat = (name) => args.includes(name);
const ohneGithub = hat('--ohne-github');
const ohneServer = hat('--ohne-server');
const ohneHier = hat('--ohne-hier');
const ohneGit = hat('--ohne-git');
const nurMac = hat('--nur-mac');
const probe = hat('--probe');
const stufe = hat('--major') ? 'major' : hat('--minor') ? 'minor' : 'patch';

const lauf = (befehl, argumente, optionen = {}) =>
  execFileSync(befehl, argumente, { cwd: wurzel, encoding: 'utf8', stdio: 'pipe', ...optionen });

/* ── Version ─────────────────────────────────────────────────── */

const paketDatei = path.join(wurzel, 'packages/desktop/package.json');
const paket = JSON.parse(fs.readFileSync(paketDatei, 'utf8'));
const jetzige = paket.version;

const gesetzt = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const naechste = gesetzt ?? (() => {
  const [gross, mittel, klein] = jetzige.split('.').map(Number);
  if (stufe === 'major') return `${gross + 1}.0.0`;
  if (stufe === 'minor') return `${gross}.${mittel + 1}.0`;
  return `${gross}.${mittel}.${klein + 1}`;
})();

/* ── Änderungsliste ──────────────────────────────────────────── */

const notizenDatei = args.find((a) => a.startsWith('--notizen='))?.slice('--notizen='.length);
const freierText = args.find((a) => !a.startsWith('--') && a !== gesetzt);
let notizen = notizenDatei
  ? fs.readFileSync(path.resolve(wurzel, notizenDatei), 'utf8').trim()
  : (freierText ?? '').trim();

/**
 * Ohne Angabe die Änderungsliste aus den Commits seit der letzten Fassung
 * bilden. Damit genügt ein Aufruf ohne Argumente — der Betreff jedes Commits
 * ist ohnehin als ein Satz geschrieben, der erklärt, was sich geändert hat.
 */
if (!notizen) {
  try {
    /* Die Marken der letzten Fassungen entstehen beim Veröffentlichen auf
       GitHub und fehlen lokal, solange niemand sie geholt hat. */
    const marke = () => {
      try { return lauf('git', ['describe', '--tags', '--abbrev=0']).trim(); } catch { return ''; }
    };
    /* Immer erst holen: die Marken entstehen beim Veröffentlichen auf GitHub.
       Wer sie nur beim ersten Fehlversuch nachlädt, bekommt beim nächsten Mal
       eine Liste, die bis zur vorletzten Fassung zurückreicht — und damit
       Punkte doppelt, die längst draußen sind. */
    try { lauf('git', ['fetch', '--tags', '--quiet']); } catch { /* ohne Netz eben nicht */ }
    let letzterStand = marke();
    // Immer noch nichts: dann ab dem Commit, der die Version zuletzt anhob.
    if (!letzterStand) {
      letzterStand = lauf('git', ['log', '-1', '--format=%H', '--', 'packages/desktop/package.json']).trim();
    }
    const roh = lauf('git', ['log', `${letzterStand}..HEAD`, '--format=%s']).trim();
    notizen = roh
      .split('\n')
      .map((z) => z.trim())
      .filter((z) => z && !/^(Merge|WIP|fixup!)/i.test(z))
      .join('\n');
    if (notizen) info(`Änderungsliste aus ${notizen.split('\n').length} Commits seit ${letzterStand}`);
  } catch { /* kein Tag, kein Git — dann bleibt es leer */ }
}

if (!notizen) {
  raus('Was ist neu? Als Text mitgeben, --notizen=DATEI.txt verwenden —\n'
    + '  oder committen, dann entsteht die Liste aus den Commit-Betreffen.\n'
    + '  Ohne Änderungsliste sieht niemand, warum er aktualisieren soll.');
}

/* ── Zugang ──────────────────────────────────────────────────── */

function zugang() {
  const ausUmgebung = {
    login: (process.env.STELLIUM_LOGIN ?? '').trim(),
    passwort: (process.env.STELLIUM_PASSWORT ?? '').trim(),
  };
  if (ausUmgebung.login && ausUmgebung.passwort) return { ...ausUmgebung, quelle: 'Umgebung' };

  // Schlüsselbund: nichts liegt im Klartext auf der Platte.
  for (const konto of [ausUmgebung.login || 'claude', 'don']) {
    try {
      const wert = execSync(
        `security find-generic-password -s stellium-veroeffentlichen -a ${JSON.stringify(konto)} -w`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (wert) return { login: konto, passwort: wert, quelle: 'Schlüsselbund' };
    } catch { /* nächstes Konto */ }
  }

  /* Zeile 1 Benutzername, Zeile 2 Passwort, Zeile 3 (freiwillig) Serveradresse. */
  const datei = path.join(os.homedir(), '.stellium-veroeffentlichen');
  if (fs.existsSync(datei)) {
    const [login, passwort, adresse] = fs.readFileSync(datei, 'utf8').split('\n').map((z) => z.trim());
    if (login && passwort) return { login, passwort, server: adresse || '', quelle: datei };
  }
  return null;
}

/** Serveradresse aus dem Schlüsselbund — dort darf sie liegen. */
function serverAusSchluesselbund() {
  try {
    return execSync('security find-generic-password -s stellium-server -w', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

/* Die Adresse steht nicht im Quelltext: das Repository ist öffentlich, und
   die Anschrift des eigenen Servers geht niemanden etwas an. Sie kommt aus
   der Umgebung oder aus der Zugangsdatei. */
const server = (process.env.STELLIUM_SERVER || serverAusSchluesselbund() || zugang()?.server || '').replace(/\/+$/, '');

/* ── Los ─────────────────────────────────────────────────────── */

sag(`\n${F.blau}${F.fett}✦  Stellium ausliefern${F.aus}`);
sag(`   ${F.grau}${jetzige} → ${F.aus}${F.fett}${naechste}${F.aus}${probe ? `  ${F.gelb}(Probe — nichts wird gesendet)${F.aus}` : ''}`);
sag(`   ${F.grau}${notizen.split('\n').length} Punkte in der Änderungsliste${F.aus}`);

/* Auch bei einer Probe nachsehen, woher der Zugang käme: sonst merkt man
   erst beim echten Ausliefern, dass er nicht hinterlegt ist. Benutzt wird er
   dabei nicht. */
const daten = zugang();
if (!probe && !server && !ohneServer) {
  raus('Keine Serveradresse.\n\n'
    + '  Einmal im Schlüsselbund ablegen:\n'
    + `  ${F.fett}security add-generic-password -U -s stellium-server -w https://dein-server:9443${F.aus}\n\n`
    + '  Oder STELLIUM_SERVER setzen.');
}
if (!probe && !daten && !ohneServer) {
  raus('Kein Zugang zum Stellium-Server gefunden.\n\n'
    + '  Einmal im Schlüsselbund ablegen (Passwort wird nicht angezeigt):\n'
    + `  ${F.fett}security add-generic-password -U -s stellium-veroeffentlichen -a claude -w${F.aus}\n\n`
    + '  Danach läuft dieses Skript ohne weitere Eingabe.');
}
if (daten) info(`Zugang als ${daten.login} (${daten.quelle})`);
else if (probe) warn('Kein Zugang hinterlegt — beim echten Ausliefern wäre hier Schluss.');

/* ── Prüfen ──────────────────────────────────────────────────── */

schritt('Prüfen');
try {
  lauf('npx', ['tsc', '-p', 'packages/shared', '--noEmit']);
  lauf('npx', ['tsc', '-p', 'packages/server', '--noEmit']);
  lauf('npm', ['run', 'typecheck', '-w', '@stellium/desktop']);
  ok('Typen stimmen');
} catch (err) {
  raus(`Typprüfung fehlgeschlagen:\n${(err.stdout || err.message).slice(0, 1500)}`);
}

try {
  const bericht = lauf('node', ['scripts/deutsch-finden.mjs']);
  const zahl = Number((bericht.match(/Gesamt: (\d+)/) ?? [])[1] ?? 0);
  if (zahl > 0) warn(`${zahl} Texte stehen noch fest im Code — nicht übersetzt (scripts/deutsch-finden.mjs)`);
  else ok('Kein fest verdrahteter Text');
} catch { warn('Textprüfung nicht möglich'); }

/* ── Version setzen ──────────────────────────────────────────── */

schritt('Version setzen');
/* Bei einer Probe bleibt der Arbeitsstand unangetastet — sonst hinterlässt
   ein Trockenlauf eine hochgezählte Version und eine Änderungsdatei, die
   niemand bestellt hat. */
const notizenAblage = probe
  ? path.join(os.tmpdir(), `stellium-notizen-${naechste}.txt`)
  : path.join(wurzel, `AENDERUNGEN-${naechste}.txt`);
fs.writeFileSync(notizenAblage, `${notizen}\n`);

if (probe) {
  info(`Probe: Version bleibt bei ${jetzige}, Notizen in ${notizenAblage}`);
} else {
  paket.version = naechste;
  fs.writeFileSync(paketDatei, `${JSON.stringify(paket, null, 2)}\n`);
  ok(`packages/desktop/package.json → ${naechste}`);
  ok(path.basename(notizenAblage));
}

/* ── Bauen und hochladen ─────────────────────────────────────── */

schritt('Bauen und hochladen');
const veroeffentlichen = ['scripts/veroeffentlichen.mjs', naechste, `--notizen=${notizenAblage}`];
if (nurMac) veroeffentlichen.push('--nur-mac');
if (!ohneServer) veroeffentlichen.push('--mit-server');

if (probe) {
  info('Probe: baue nur, ohne zu senden');
  try {
    lauf('npm', ['run', 'build', '-w', '@stellium/desktop'], { stdio: 'inherit' });
    ok('gebaut');
  } catch (err) { raus(`Bauen fehlgeschlagen: ${err.message}`); }
} else {
  try {
    lauf('node', veroeffentlichen, {
      stdio: 'inherit',
      env: {
        ...process.env,
        STELLIUM_SERVER: server,
        STELLIUM_LOGIN: daten.login,
        STELLIUM_PASSWORT: daten.passwort,
      },
    });
    ok(`auf ${server} veröffentlicht — die Clients sehen es sofort`);
  } catch (err) {
    raus(`Veröffentlichen fehlgeschlagen: ${err.message}`);
  }
}

/* ── Quelltext festhalten ────────────────────────────────────── */

if (!ohneGit && !probe) {
  schritt('Quelltext festhalten');
  try {
    lauf('git', ['add', '-A']);
    /* „Fassung 1.0.17" statt der ersten Zeile der Änderungsliste.
       Die wurde bei 68 Zeichen abgeschnitten — und weil die nächste
       Änderungsliste aus den Commit-Betreffen entsteht, stand dieser
       halbe Satz später in den Notizen der Folgefassung. Der Betreff
       benennt jetzt, was der Commit ist; die Liste selbst steht im Körper. */
    const betreff = `Fassung ${naechste}`;
    const koerper = notizen.trim();
    const nachricht = [
      betreff,
      koerper ? `\n${koerper}` : '',
      '\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>',
    ].join('\n');
    lauf('git', ['commit', '-q', '-F', '-'], { input: nachricht });
    lauf('git', ['push', '-q', 'origin', 'HEAD']);
    ok(`committet und geschoben (${betreff})`);
  } catch (err) {
    warn(`Git übersprungen: ${(err.stdout || err.stderr || err.message).slice(0, 200)}`);
  }
}

/* ── GitHub ──────────────────────────────────────────────────── */

if (!ohneGithub && !probe) {
  schritt('Release auf GitHub');
  const ordner = path.join(wurzel, 'packages/desktop/release');
  const finde = (muster) => fs.readdirSync(ordner)
    .filter((n) => muster.test(n) && n.includes(naechste))
    .map((n) => path.join(ordner, n));

  const dateien = [
    ...finde(/universal\.dmg$/), ...finde(/-arm64\.dmg$/),
    ...finde(/^Stellium-[\d.]+\.exe$/), ...finde(/-x64\.exe$/), ...finde(/-arm64\.exe$/),
    ...finde(/x86_64\.AppImage$/), ...finde(/arm64\.AppImage$/),
  ];

  if (!dateien.length) warn('Keine Pakete gefunden — Release ohne Dateien angelegt');
  try {
    lauf('gh', [
      'release', 'create', `v${naechste}`,
      '--title', `Stellium ${naechste}`,
      '--notes-file', notizenAblage,
      '--target', 'main',
      ...dateien,
    ], { stdio: 'pipe' });
    ok(`v${naechste} mit ${dateien.length} Dateien`);
  } catch (err) {
    warn(`GitHub übersprungen: ${(err.stdout || err.stderr || err.message).slice(0, 200)}`);
  }
}

/* ── Hier installieren ──────────────────────────────────────── */

if (!ohneHier && !probe && process.platform === 'darwin') {
  schritt('Auf diesem Mac installieren');
  const dmg = path.join(wurzel, 'packages/desktop/release', `Stellium-${naechste}-universal.dmg`);
  if (!fs.existsSync(dmg)) {
    warn('Kein universal.dmg — übersprungen');
  } else {
    try {
      try { lauf('osascript', ['-e', 'tell application "Stellium" to quit']); } catch { /* lief nicht */ }
      lauf('bash', ['-c', 'sleep 3; pkill -f "Stellium.app/Contents/MacOS/Stellium" || true; sleep 1']);
      lauf('hdiutil', ['attach', '-nobrowse', '-quiet', dmg]);
      const band = `/Volumes/Stellium ${naechste}`;
      lauf('bash', ['-c', `rm -rf /Applications/Stellium.app && cp -R ${JSON.stringify(`${band}/Stellium.app`)} /Applications/`]);
      lauf('hdiutil', ['detach', band, '-quiet']);
      lauf('bash', ['-c', 'xattr -dr com.apple.quarantine /Applications/Stellium.app || true']);
      lauf('open', ['-a', 'Stellium']);
      ok(`Stellium ${naechste} läuft`);
    } catch (err) {
      warn(`Lokale Installation übersprungen: ${(err.stderr || err.message).slice(0, 200)}`);
    }
  }
}

/* ── Fertig ─────────────────────────────────────────────────── */

sag(`\n${F.gruen}${F.fett}   ${naechste} ist draußen.${F.aus}\n`);
if (!probe) {
  sag(`   ${F.grau}Apps:   Hinweis erscheint sofort, Installation nach Rückfrage${F.aus}`);
  if (!ohneServer) sag(`   ${F.grau}Server: prüft alle 30 Minuten, kündigt 15 Minuten vorher an${F.aus}`);
  if (!ohneGithub) sag(`   ${F.grau}GitHub: https://github.com/chackrahunter/stellium-chat/releases/tag/v${naechste}${F.aus}`);
}
sag();
