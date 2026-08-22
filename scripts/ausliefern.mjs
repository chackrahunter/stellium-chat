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

/* Die zuletzt WIRKLICH veröffentlichte Fassung — aus den Marken, nicht aus
   package.json. Die Marke entsteht erst beim Veröffentlichen; die Datei kann
   längst weitergezählt sein. */
function letzteMarke() {
  try {
    lauf('git', ['fetch', '--tags', '--quiet']);
  } catch { /* ohne Netz eben mit dem, was da ist */ }
  try {
    const alle = lauf('git', ['tag', '--list', 'v*.*.*']).trim().split('\n').filter(Boolean);
    const zahlen = alle
      .map((t) => t.replace(/^v/, '').split('.').map(Number))
      .filter((z) => z.length === 3 && z.every(Number.isFinite))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return zahlen.length ? zahlen[zahlen.length - 1].join('.') : null;
  } catch { return null; }
}

function hoeher(a, b) {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const naechste = gesetzt ?? (() => {
  const marke = letzteMarke();
  /* Steht in package.json schon eine Fassung, die nie veröffentlicht wurde,
     dann IST das die nächste — hochzählen würde eine Nummer überspringen.
     Genau das drohte am 21.08.2026: die Datei stand auf 1.0.21, der Server
     lief auf 1.0.20, und der Vorschlag lautete 1.0.22. Die Änderungsliste
     hieß bereits AENDERUNGEN-1.0.21.txt — sie hätte nicht mehr gepasst. */
  if (marke && hoeher(jetzige, marke)) {
    sag(`  ${F.gelb}!${F.aus} ${jetzige} war vorbereitet, aber nie veröffentlicht `
      + `${F.grau}(letzte Marke v${marke}) — sie wird jetzt ausgeliefert${F.aus}`);
    return jetzige;
  }
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

/* Trägt die Datei eine Fassung im Namen, muss sie die sein, die ausgeliefert
   wird. Sonst geht eine Änderungsliste für 1.0.21 als 1.0.22 hinaus, und
   niemand merkt es — der Text ist ja fehlerfrei, nur eben zur falschen
   Fassung. Genau das drohte am 21.08.2026. */
if (notizenDatei) {
  const drin = notizenDatei.match(/(\d+\.\d+\.\d+)/);
  if (drin && drin[1] !== naechste) {
    sag(`  ${F.rot}✗${F.aus} ${notizenDatei} gehört zu ${drin[1]}, `
      + `ausgeliefert würde aber ${F.fett}${naechste}${F.aus}.`);
    sag(`    ${F.grau}Entweder die Datei umbenennen oder die Fassung `
      + `ausdrücklich mitgeben:${F.aus}`);
    sag(`    ${F.grau}node scripts/ausliefern.mjs ${drin[1]} --notizen=${notizenDatei}${F.aus}`);
    process.exit(1);
  }
}

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

/* Kommt der Server auf der Datenbank hoch, die draußen wirklich liegt?
   Die Prüfläufe legen ihre Datenbank frisch an — dort bringt CREATE TABLE
   jede neue Spalte gleich mit, und ein Fehler in der Nachrüstung fällt nie
   auf. Fassung 1.0.17 ist genau daran auf dem Server gescheitert und musste
   zurückgenommen werden. Deshalb steht diese Probe vor dem Bauen. */
try {
  lauf('node', ['scripts/e2e-nachruesten.mjs']);
  ok('Server kommt auf einer alten Datenbank hoch');
} catch (err) {
  raus(`Nachrüstung der Datenbank fehlgeschlagen:\n${(err.stdout || err.message).slice(0, 1200)}`);
}

try {
  const bericht = lauf('node', ['scripts/deutsch-finden.mjs']);
  const zahl = Number((bericht.match(/Gesamt: (\d+)/) ?? [])[1] ?? 0);
  if (zahl > 0) warn(`${zahl} Texte stehen noch fest im Code — nicht übersetzt (scripts/deutsch-finden.mjs)`);
  else ok('Kein fest verdrahteter Text');
} catch { warn('Textprüfung nicht möglich'); }

/*
 * Die Wächter, die es im Haus gibt — und die hier bisher nicht liefen.
 *
 * Ein Prüflauf, den man von Hand aufrufen muss, ist keiner: er läuft genau
 * so lange, wie sich jemand daran erinnert. Sie kosten zusammen ein paar
 * Sekunden und stehen deshalb vor dem Bauen, nicht danach.
 *
 * ABBRUCH und nicht Warnung: jeder dieser Wächter bewacht einen Fehler, der
 * schon einmal draußen war — ein verschluckter Sicherheitsabstand, ein
 * schwarzer Streifen am Rand, ein Verweis auf einen Namen, den es nicht gibt,
 * eine Linie, die fehlende Tage überspringt. Eine Warnung hätte keinen davon
 * aufgehalten.
 */
for (const [datei, was] of [
  ['scripts/mobil-pruefen.mjs', 'Handyansicht'],
  ['scripts/randfarbe-pruefen.mjs', 'Rand'],
  ['scripts/tokens-pruefen.mjs', 'Namen im Stylesheet'],
  ['scripts/praesenz-pruefen.mjs', 'Online-Zeit'],
]) {
  if (!fs.existsSync(path.join(wurzel, datei))) continue;
  try {
    lauf('node', [datei]);
    ok(was);
  } catch (err) {
    raus(`${was} (${datei}):\n${(err.stdout || err.stderr || err.message).slice(0, 800)}`);
  }
}

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

  /*
   * Den Stand JETZT festhalten, nicht nach dem Bauen.
   *
   * Hier stand nichts, und `git add -A` kam erst hinter dem Bauen — also
   * hinter zwanzig Minuten, in denen jemand weiterarbeiten kann. Wer das
   * tut, bekommt seine Zwischenstände in den Commit „Fassung x.y.z", obwohl
   * sie in den gebauten Paketen gar nicht drin sind. Genau das ist am
   * 22.08.2026 passiert: v1.0.25 trug Änderungen, die kein Paket enthielt.
   * Wer später fragt, aus welchem Stand eine Fassung gebaut wurde, bekommt
   * dann eine Antwort, die stimmt aussieht und falsch ist.
   *
   * `git commit` schreibt den INDEX, nicht den Arbeitsbaum. Wird er vor dem
   * Bauen gefüllt, kann danach am Arbeitsbaum passieren was will — der
   * Commit bleibt der Stand, aus dem gebaut wurde.
   *
   * Scheitert das Bauen, bleibt ein gefüllter Index zurück. Das ist kein
   * Schaden (committet wurde nichts) und mit `git reset` in einem Schritt
   * zurückgenommen.
   */
  if (!ohneGit) {
    try {
      lauf('git', ['add', '-A']);
      sag(`  ${F.grau}Stand für den Commit festgehalten${F.aus}`);
    } catch (err) {
      warn(`Stand ließ sich nicht festhalten: ${String(err.message).slice(0, 120)}`);
    }
  }
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
    /* Der Index steht schon (siehe „Version setzen"). Nachzutragen ist nur,
       was das Veröffentlichen selbst noch angefasst hat — es schreibt
       `packages/desktop/package.json` ein zweites Mal auf dieselbe Version.
       Ein `git add -A` an dieser Stelle würde wieder den ganzen
       Arbeitsbaum einsammeln und damit genau den Fehler zurückholen, den
       das Festhalten davor verhindert. */
    lauf('git', ['add', '--', 'packages/desktop/package.json']);
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
    /* Committen und Schieben getrennt, und das ist keine Förmlichkeit.
       Vorher standen beide in einem try: `git commit` endet mit einem
       Fehlercode, wenn nichts vorliegt — etwa weil schon von Hand committet
       wurde —, und dann sprang der Ablauf in den catch, BEVOR geschoben
       wurde. Ergebnis am 21.08.2026: die Marke v1.0.21 stand auf GitHub,
       der Quelltext dazu lag noch lokal. Wer das später sucht, findet eine
       Fassung ohne den Stand, aus dem sie gebaut wurde.
       Geschoben wird deshalb IMMER — auch wenn es hier nichts zu committen
       gab, können ältere Commits offen sein. */
    let etwasCommittet = false;
    try {
      lauf('git', ['commit', '-q', '-F', '-'], { input: nachricht });
      etwasCommittet = true;
    } catch (err) {
      const text = (err.stdout || err.stderr || err.message);
      if (/nichts zu committen|nothing to commit/i.test(text)) {
        sag(`  ${F.grau}nichts Neues zu committen${F.aus}`);
      } else {
        warn(`Commit übersprungen: ${text.slice(0, 200)}`);
      }
    }
    lauf('git', ['push', '-q', 'origin', 'HEAD']);
    /* Nachsehen statt hoffen: bleibt hier etwas offen, ist die Fassung
       draußen, aber niemand kann sie nachvollziehen. */
    const offen = lauf('git', ['rev-list', '--count', '@{u}..HEAD']).trim();
    if (offen !== '0') {
      warn(`${offen} Commits stehen noch aus — 'git push' von Hand nachholen`);
    } else {
      ok(etwasCommittet ? `committet und geschoben (${betreff})` : 'geschoben, Stand ist vollständig');
    }
  } catch (err) {
    warn(`Git übersprungen: ${(err.stdout || err.stderr || err.message).slice(0, 200)}`);
  }
}

/* ── GitHub ──────────────────────────────────────────────────── */

if (!ohneGithub && !probe) {
  schritt('Release auf GitHub');
  const ordner = path.join(wurzel, 'packages/desktop/release');
  /* Fehlt der Ordner, ist das eine leere Liste und kein Absturz. Er fehlte
     schon einmal, weil das Aufräumen eine Zeile zu früh stand — und dann
     brach der ganze Lauf NACH dem erfolgreichen Hochladen ab. Die Fassung
     war draußen, die Marke fehlte, und wer das Protokoll las, hielt die
     Auslieferung für gescheitert. */
  const finde = (muster) => {
    let namen = [];
    try { namen = fs.readdirSync(ordner); } catch { return []; }
    return namen
      .filter((n) => muster.test(n) && n.includes(naechste))
      .map((n) => path.join(ordner, n));
  };

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

/* ── Aufräumen ───────────────────────────────────────────────────
   ERST HIER, nach dem Hochladen UND nach dem Release auf GitHub — das
   braucht dieselben Dateien. Stand es davor, brach der Lauf mit ENOENT ab,
   nachdem die Fassung längst draußen war.

   Warum überhaupt: `release/` wurde nie geleert und wuchs mit jeder
   Auslieferung — vier Plattformen, jeweils entpackt UND geschnürt, rund
   15 GB. Am 22.08.2026 war die Platte davon voll, und der Windows-Bau brach
   mit ENOSPC ab, ohne eine Zeile im Protokoll: electron-builder konnte
   seinen eigenen Fehler nicht mehr schreiben. */
if (!probe) {
  try {
    fs.rmSync(path.join(wurzel, 'packages/desktop/release'), { recursive: true, force: true });
    sag(`  ${F.grau}Bauordner geleert${F.aus}`);
  } catch { /* liegen zu bleiben ist kein Grund zu klagen */ }
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
