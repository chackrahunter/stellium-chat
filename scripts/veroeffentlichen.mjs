#!/usr/bin/env node
/**
 * Eine neue Version bauen und auf den Stellium-Server hochladen.
 *
 *   node scripts/veroeffentlichen.mjs 1.2.0 "Was neu ist"
 *   node scripts/veroeffentlichen.mjs 1.2.0 --nur-mac
 *   node scripts/veroeffentlichen.mjs --nur-hochladen 1.2.0
 *   node scripts/veroeffentlichen.mjs 1.2.0 --mit-server   auch den Server
 *   node scripts/veroeffentlichen.mjs 1.2.0 --notizen=AENDERUNGEN.txt
 *
 * Server und Zugang kommen aus der Umgebung:
 *   STELLIUM_SERVER    https://chat.meinefirma.de
 *   STELLIUM_LOGIN     Benutzername
 *   STELLIUM_PASSWORT  Passwort
 *
 * Alles, was fehlt, wird erfragt. Die Änderungsliste darf mehrzeilig sein —
 * jede Zeile wird den anderen nach dem Update als eigener Punkt gezeigt.
 */
import { execFileSync } from 'node:child_process';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = { aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m', gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', blau: '\x1b[38;5;111m' };
const sag = (t = '') => process.stdout.write(`${t}\n`);
const ok = (t) => sag(`  ${F.gruen}✓${F.aus} ${t}`);
const schritt = (t) => sag(`\n${F.blau}${F.fett}▸ ${t}${F.aus}`);
const raus = (t) => { sag(`\n${F.rot}✗ ${t}${F.aus}\n`); process.exit(1); };

const args = process.argv.slice(2);
const nurHochladen = args.includes('--nur-hochladen');
/** --nur=win32,linux beschränkt auf einzelne Ziele — für einen zweiten Anlauf. */
const nurZiele = args.find((a) => a.startsWith('--nur='))?.slice('--nur='.length).split(',').filter(Boolean) ?? null;
const nurMac = args.includes('--nur-mac');
const mitServer = args.includes('--mit-server') || args.includes('--nur-server');
const nurServer = args.includes('--nur-server');
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const notizenDatei = args.find((a) => a.startsWith('--notizen='))?.slice('--notizen='.length);
// Aus einer Datei, damit eine lange Änderungsliste nicht in die Befehlszeile muss.
const notizen = notizenDatei
  ? fs.readFileSync(path.resolve(wurzel, notizenDatei), 'utf8').trim()
  : args.find((a) => !a.startsWith('--') && a !== version) ?? '';

if (!version) raus('Welche Version? z.B.  node scripts/veroeffentlichen.mjs 1.2.0 "Umfragen werden übersetzt"');

async function frage(text, still = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const antwort = await rl.question(`  ${text}`);
  rl.close();
  if (still) process.stdout.write('\n');
  return antwort.trim();
}

const lauf = (befehl, argumente, optionen = {}) =>
  execFileSync(befehl, argumente, { cwd: wurzel, encoding: 'utf8', stdio: 'pipe', ...optionen });

/* ── Bauen ───────────────────────────────────────────────────── */

if (nurHochladen) {
  /* Beim reinen Hochladen wird die Fassung nicht gesetzt — dann muss sie schon
     stimmen. Sonst entsteht ein Paket, dessen Inhalt eine andere Nummer trägt
     als die Ankündigung: der Server hält sich danach für aktuell, obwohl er es
     nicht ist, und das Selbstupdate verwirft das Paket zu Recht. Lieber hier
     abbrechen als draußen ein widersprüchliches Paket. */
  const paketDatei = path.join(wurzel, 'packages/desktop/package.json');
  const drin = JSON.parse(fs.readFileSync(paketDatei, 'utf8')).version;
  if (drin !== version) {
    fehler(`Das Paket trägt Fassung ${drin}, hochgeladen werden soll ${version}.\n`
      + '  Entweder ohne --nur-hochladen laufen lassen (setzt die Nummer selbst)\n'
      + `  oder packages/desktop/package.json vorher auf ${version} stellen.`);
  }
}

if (!nurHochladen) {
  schritt(`Version ${version} setzen`);
  const paketDatei = path.join(wurzel, 'packages/desktop/package.json');
  const paket = JSON.parse(fs.readFileSync(paketDatei, 'utf8'));
  paket.version = version;
  fs.writeFileSync(paketDatei, `${JSON.stringify(paket, null, 2)}\n`);
  ok(`packages/desktop/package.json → ${version}`);

  schritt('Bauen');
  lauf('npm', ['run', 'build'], { stdio: 'inherit' });
  ok('Quelltext gebaut');

  schritt('Pakete schnüren');
  const ziele = nurMac ? ['dist:mac:universal'] : ['dist:mac:universal', 'dist:win', 'dist:linux'];
  for (const ziel of ziele) {
    sag(`  ${F.grau}${ziel} …${F.aus}`);
    /* Das DMG scheitert gelegentlich an "hdiutil detach" — der Mac hängt
       dann noch an einem Abbild von vorhin. Beim zweiten Anlauf geht es
       durch, deshalb einer statt eines Abbruchs. */
    try {
      lauf('npm', ['run', ziel, '-w', '@stellium/desktop'], { stdio: 'inherit' });
    } catch {
      sag(`  ${F.grau}${ziel} abgebrochen — zweiter Anlauf …${F.aus}`);
      lauf('npm', ['run', ziel, '-w', '@stellium/desktop'], { stdio: 'inherit' });
    }
  }
  ok('fertig');
}

/* ── Dateien einsammeln ──────────────────────────────────────── */

/* ── Serverpaket schnüren ────────────────────────────────────── */

if (mitServer) {
  schritt('Serverpaket schnüren');
  const arbeit = path.join(os.tmpdir(), `stellium-server-${Date.now()}`);
  fs.mkdirSync(arbeit, { recursive: true });
  const ziel = path.join(arbeit, 'stellium-server');
  fs.mkdirSync(ziel);

  // Dasselbe Paket, das auch von Hand eingespielt wird — ohne node_modules,
  // fertige Pakete und Daten.
  // Was .gitignore verschweigt, darf erst recht nicht in ein Paket, das jeder
  // Server herunterlädt: .env trägt Groq-Schlüssel und Masterpasswort,
  // .stellium-test ein echtes Konto. Bewusst ohne Stern — .env.example soll
  // mitkommen, sie ist ja die Vorlage.
  lauf('bash', ['-c',
    `tar -C ${JSON.stringify(wurzel)} --exclude=node_modules --exclude=.git `
    + '--exclude=release --exclude=downloads --exclude=data --exclude=dist-electron '
    + '--exclude=.env --exclude=.env.local --exclude=.stellium-test '
    + '--exclude=.stellium-veroeffentlichen --exclude=*.pem --exclude=*.key '
    + `--exclude=.DS_Store --exclude=screenshots -cf - . | tar -C ${JSON.stringify(ziel)} -xf -`]);

  /* Vertrauen ist gut, Nachsehen ist besser: bevor das Paket rausgeht, wird
     geprüft, dass wirklich nichts Geheimes drinliegt. Lieber ein Abbruch als
     ein Schlüssel auf fremden Rechnern. */
  const verboten = ['.env', '.env.local', '.stellium-test', '.stellium-veroeffentlichen'];
  const gefunden = [];
  const durchsehen = (ordner) => {
    for (const eintrag of fs.readdirSync(ordner, { withFileTypes: true })) {
      const voll = path.join(ordner, eintrag.name);
      if (eintrag.isDirectory()) durchsehen(voll);
      else if (verboten.includes(eintrag.name) || /\.(pem|key|p12)$/.test(eintrag.name)) {
        gefunden.push(path.relative(ziel, voll));
      }
    }
  };
  durchsehen(ziel);
  if (gefunden.length) {
    throw new Error(`Im Serverpaket liegen Geheimnisse: ${gefunden.join(', ')}`);
  }

  const paket = path.join(wurzel, 'downloads/stellium-server.tar.gz');
  fs.mkdirSync(path.dirname(paket), { recursive: true });
  fs.rmSync(paket, { force: true });
  lauf('tar', ['-C', arbeit, '-czf', paket, 'stellium-server']);
  fs.rmSync(arbeit, { recursive: true, force: true });
  ok(`downloads/stellium-server.tar.gz (${(fs.statSync(paket).size / 1024 / 1024).toFixed(1)} MB)`);
}

const ordner = path.join(wurzel, 'packages/desktop/release');
const suche = (muster) => fs.readdirSync(ordner).find((n) => muster.test(n) && n.includes(version));

const dateien = nurServer ? {} : {
  darwin: suche(/universal\.dmg$/),
  win32: suche(/^Stellium-[\d.]+\.exe$/),
  linux: suche(/x86_64\.AppImage$/),
};

schritt('Gefundene Pakete');
for (const [system, datei] of Object.entries(dateien)) {
  if (datei) ok(`${system.padEnd(8)} ${datei}`);
  else sag(`  ${F.grau}${system.padEnd(8)} keins${F.aus}`);
}
if (mitServer) ok('server   downloads/stellium-server.tar.gz');
if (!Object.values(dateien).some(Boolean) && !mitServer) raus('Nichts zum Hochladen gefunden.');


/* ── Zugang aus dem Schlüsselbund ────────────────────────────────
   Diese Abfragen standen bisher nur in `ausliefern.mjs`. Wer dieses Skript
   direkt aufrief — und das tut man, wenn die Fassung schon gesetzt ist —
   wurde nach Adresse, Benutzer und Passwort gefragt. Im Hintergrund, ohne
   Terminal, wartete es darauf **stundenlang**, ohne eine Zeile auszugeben.
   Es sah aus, als liefe der Bau noch. */

function ausSchluesselbund(dienst, konto = null) {
  const wo = konto ? `-s ${JSON.stringify(dienst)} -a ${JSON.stringify(konto)}` : `-s ${JSON.stringify(dienst)}`;
  try {
    return execSync(`security find-generic-password ${wo} -w`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

/** Erst die Umgebung, dann der Schlüsselbund, dann fragen. */
function zugangsdaten() {
  const server = process.env.STELLIUM_SERVER || ausSchluesselbund('stellium-server');
  let login = process.env.STELLIUM_LOGIN || '';
  let passwort = process.env.STELLIUM_PASSWORT || '';
  if (!passwort) {
    for (const konto of [login || 'claude', 'don']) {
      const wert = ausSchluesselbund('stellium-veroeffentlichen', konto);
      if (wert) { login = konto; passwort = wert; break; }
    }
  }
  return { server, login, passwort };
}

/* ── Hochladen ───────────────────────────────────────────────── */

const gefunden = zugangsdaten();
const server = (gefunden.server || await frage('Serveradresse (z.B. https://chat.firma.de): ')).replace(/\/+$/, '');
const login = gefunden.login || await frage('Benutzername: ');
const passwort = gefunden.passwort || await frage('Passwort: ');
if (gefunden.server && gefunden.passwort) ok(`Zugang als ${login} (Schlüsselbund)`);
const text = notizen || await frage('Was ist neu? (eine Zeile je Punkt, leer = nichts): ');

schritt('Anmelden');
const anmeldung = await fetch(`${server}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login, password: passwort }),
});
if (!anmeldung.ok) raus(`Anmeldung fehlgeschlagen (${anmeldung.status}).`);
const { token } = await anmeldung.json();
ok(`als ${login}`);

schritt('Hochladen');
const hochzuladen = Object.entries(dateien)
  .filter(([, d]) => d)
  .map(([system, datei]) => [system, path.join(ordner, datei)]);
if (mitServer) hochzuladen.push(['server', path.join(wurzel, 'downloads/stellium-server.tar.gz')]);
if (nurZiele) {
  for (let i = hochzuladen.length - 1; i >= 0; i--) {
    if (!nurZiele.includes(hochzuladen[i][0])) hochzuladen.splice(i, 1);
  }
}

/* ── Der Weg am Tunnel vorbei ────────────────────────────────────
   Cloudflare deckelt Uploads durch den Tunnel bei 100 MB — das DMG hat gut
   200. SSH transportiert das Paket auf den Pi, dort nimmt der Server es über
   localhost an. Genau der Handgriff, mit dem 1.0.13 bis 1.0.15 von Hand
   ausgeliefert wurden — jetzt ohne Hand. Das SSH-Ziel ist der Alias aus
   server-setup/SSH-EINRICHTEN.md, übersteuerbar per STELLIUM_SSH. */
const sshZiel = process.env.STELLIUM_SSH || 'stellium';
let sshBereit = false;

function sshVorbereiten() {
  if (sshBereit) return;
  const ablage = `fassung-${version}`;
  /* Das Fernskript liest das Token von der Standardeingabe — stünde es im
     Aufruf, wäre es auf dem Pi in der Prozessliste für jeden lesbar. */
  const fernSkript = `#!/bin/bash
# Nimmt ein Paket über localhost an — am Cloudflare-Deckel vorbei.
# Aufruf: einspielen.sh <system> <datei> <version>; Token kommt über stdin.
set -u
IFS= read -r TOKEN
SYS="$1"; DATEI="$2"; VERSION="$3"
PORT="$(grep -oP '(?<=^PORT=)\\d+' /etc/stellium.env 2>/dev/null || echo 8787)"
NOTIZEN=""
[ -f "$HOME/fassung-$VERSION/notizen.txt" ] && NOTIZEN="-F notes=<$HOME/fassung-$VERSION/notizen.txt"
ANTWORT=$(curl -s -w $'\\n%{http_code}' -H "authorization: Bearer $TOKEN" \\
  -X POST "http://127.0.0.1:$PORT/api/releases/$SYS" \\
  --form-string "version=$VERSION" $NOTIZEN \\
  -F "file=@$HOME/fassung-$VERSION/$DATEI")
CODE="\${ANTWORT##*$'\\n'}"
KOERPER="\${ANTWORT%$'\\n'*}"
if [ "$CODE" != "200" ]; then echo "HTTP $CODE: $(echo "$KOERPER" | head -c 200)" >&2; exit 1; fi
rm -f "$HOME/fassung-$VERSION/$DATEI"
echo "$KOERPER"
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-ssh-'));
  fs.writeFileSync(path.join(tmp, 'einspielen.sh'), fernSkript, { mode: 0o755 });
  if (text) fs.writeFileSync(path.join(tmp, 'notizen.txt'), text);
  lauf('ssh', [sshZiel, `mkdir -p ~/${ablage}`]);
  const dateien = [path.join(tmp, 'einspielen.sh'), ...(text ? [path.join(tmp, 'notizen.txt')] : [])];
  lauf('scp', ['-q', ...dateien, `${sshZiel}:~/${ablage}/`]);
  fs.rmSync(tmp, { recursive: true, force: true });
  sshBereit = true;
}

/**
 * Überträgt eine Datei und setzt nach einem Abbruch dort wieder auf, wo sie
 * stehengeblieben ist.
 *
 * scp kann das nicht: reißt die Leitung bei 190 von 209 MB, fängt der nächste
 * Versuch wieder bei null an — und beim Ausliefern von 1.0.16 riss sie bei
 * jedem großen Paket genau einmal. dd hängt stattdessen ab der Byte-Zahl an,
 * die drüben schon liegt.
 *
 * Zwei Fallen, beide beim Ausliefern gefunden: Die Blockgröße als Zahl statt
 * "1M" — GNU-dd auf dem Pi und BSD-dd auf dem Mac schreiben die Einheit
 * verschieden, die nackte Zahl verstehen beide. Und der Fernpfad über $HOME
 * statt der Tilde: in Anführungszeichen bleibt sie stehen, dd schriebe ins
 * Leere.
 */
const BLOCK = 1048576;

function schieben(pfad, datei) {
  const fern = `$HOME/fassung-${version}/${datei}`;
  const gesamt = fs.statSync(pfad).size;
  const dortSchon = () => Number(
    lauf('ssh', [sshZiel, `stat -c%s "${fern}" 2>/dev/null || echo 0`]).trim(),
  ) || 0;

  for (let versuch = 1; versuch <= 5; versuch++) {
    let da = dortSchon();
    if (da > gesamt) { lauf('ssh', [sshZiel, `rm -f "${fern}"`]); da = 0; }
    if (da === gesamt) return;
    if (versuch > 1) {
      sag(`  ${F.grau}… ${(da / 1024 / 1024).toFixed(0)} von ${(gesamt / 1024 / 1024).toFixed(0)} MB — weiter${F.aus}`);
    }
    const bloecke = Math.floor(da / BLOCK);
    try {
      lauf('bash', ['-c',
        `dd if=${JSON.stringify(pfad)} bs=${BLOCK} skip=${bloecke} 2>/dev/null | `
        + `ssh -o ServerAliveInterval=15 ${sshZiel} `
        + `'dd of="${fern}" bs=${BLOCK} seek=${bloecke} conv=notrunc 2>/dev/null'`]);
    } catch { /* Leitung weg — der nächste Durchgang setzt an der Bruchstelle an. */ }
  }
  if (dortSchon() !== gesamt) throw new Error(`${datei} kam nicht vollständig an`);
}

function ueberSsh(system, pfad, datei) {
  sshVorbereiten();
  schieben(pfad, datei);
  const koerper = lauf(
    'ssh', [sshZiel, `bash ~/fassung-${version}/einspielen.sh ${system} ${datei} ${version}`],
    { input: `${token}\n` },
  );
  return JSON.parse(koerper).release;
}

for (const [system, pfad] of hochzuladen) {
  const datei = path.basename(pfad);
  const groesse = fs.statSync(pfad).size;
  sag(`  ${F.grau}${system} · ${(groesse / 1024 / 1024).toFixed(0)} MB …${F.aus}`);

  /* Über eine Hausleitung bricht eine Übertragung von 170 MB schon mal ab.
     Deshalb drei Versuche — und die Datei als Datenstrom statt am Stück im
     Speicher, sonst schiebt Node den ganzen Puffer in einem Rutsch in den
     Socket und scheitert daran (ERANGE). */
  let release = null;
  for (let versuch = 1; versuch <= 3; versuch++) {
    try {
      /* Hat der Tunnel einmal abgelehnt, lehnt er wieder ab — die weiteren
         Pakete nehmen gleich den SSH-Weg. */
      if (sshBereit) {
        release = ueberSsh(system, pfad, datei);
        break;
      }
      const form = new FormData();
      form.append('version', version);
      if (text) form.append('notes', text);
      form.append('file', await fs.openAsBlob(pfad), datei);

      const antwort = await fetch(`${server}/api/releases/${system}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
      });
      if (antwort.status === 413) {
        sag(`  ${F.grau}Tunnel deckelt bei 100 MB — Umweg über SSH (${sshZiel}) …${F.aus}`);
        try {
          release = ueberSsh(system, pfad, datei);
        } catch (err) {
          raus(`${system}: auch der SSH-Weg scheiterte (${(err.stderr || err.message || '').toString().slice(0, 200)}).\n` +
               `  Von Hand: Paket per scp nach ${sshZiel}:~/fassung-${version}/ und dort\n` +
               `  bash ~/fassung-${version}/einspielen.sh ${system} ${datei} ${version}`);
        }
        break;
      }
      if (!antwort.ok) {
        const fehler = await antwort.text();
        raus(`${system}: ${fehler.slice(0, 200)}`);
      }
      ({ release } = await antwort.json());
      break;
    } catch (err) {
      const grund = err?.cause?.code ?? err?.message ?? 'unbekannt';
      if (versuch === 3) raus(`${system}: Übertragung dreimal abgebrochen (${grund}).`);
      sag(`  ${F.grau}Versuch ${versuch} abgebrochen (${grund}) — neuer Anlauf …${F.aus}`);
      await new Promise((f) => setTimeout(f, versuch * 4000));
    }
  }
  ok(`${system} · ${release.version} · ${release.sha256.slice(0, 12)}…`);
}

sag(`
${F.gruen}${F.fett}   Version ${version} ist veröffentlicht.${F.aus}

   Alle laufenden Clients sehen den Hinweis sofort, laden im
   Hintergrund und werden gefragt, bevor installiert wird.
`);
