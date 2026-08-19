#!/usr/bin/env node
/**
 * Eine neue Version bauen und auf den Stellium-Server hochladen.
 *
 *   node scripts/veroeffentlichen.mjs 1.2.0 "Was neu ist"
 *   node scripts/veroeffentlichen.mjs 1.2.0 --nur-mac
 *   node scripts/veroeffentlichen.mjs --nur-hochladen 1.2.0
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
import fs from 'node:fs';
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
const nurMac = args.includes('--nur-mac');
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const notizen = args.find((a) => !a.startsWith('--') && a !== version) ?? '';

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
    lauf('npm', ['run', ziel, '-w', '@stellium/desktop'], { stdio: 'inherit' });
  }
  ok('fertig');
}

/* ── Dateien einsammeln ──────────────────────────────────────── */

const ordner = path.join(wurzel, 'packages/desktop/release');
const suche = (muster) => fs.readdirSync(ordner).find((n) => muster.test(n) && n.includes(version));

const dateien = {
  darwin: suche(/universal\.dmg$/),
  win32: suche(/^Stellium-[\d.]+\.exe$/),
  linux: suche(/x86_64\.AppImage$/),
};

schritt('Gefundene Pakete');
for (const [system, datei] of Object.entries(dateien)) {
  if (datei) ok(`${system.padEnd(8)} ${datei}`);
  else sag(`  ${F.grau}${system.padEnd(8)} keins${F.aus}`);
}
if (!Object.values(dateien).some(Boolean)) raus('Nichts zum Hochladen gefunden.');

/* ── Hochladen ───────────────────────────────────────────────── */

const server = (process.env.STELLIUM_SERVER || await frage('Serveradresse (z.B. https://chat.firma.de): ')).replace(/\/+$/, '');
const login = process.env.STELLIUM_LOGIN || await frage('Benutzername: ');
const passwort = process.env.STELLIUM_PASSWORT || await frage('Passwort: ');
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
for (const [system, datei] of Object.entries(dateien)) {
  if (!datei) continue;
  const pfad = path.join(ordner, datei);
  const groesse = fs.statSync(pfad).size;
  sag(`  ${F.grau}${system} · ${(groesse / 1024 / 1024).toFixed(0)} MB …${F.aus}`);

  const form = new FormData();
  form.append('version', version);
  if (text) form.append('notes', text);
  form.append('file', new Blob([fs.readFileSync(pfad)]), datei);

  const antwort = await fetch(`${server}/api/releases/${system}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  });
  if (!antwort.ok) {
    const fehler = await antwort.text();
    raus(`${system}: ${fehler.slice(0, 200)}`);
  }
  const { release } = await antwort.json();
  ok(`${system} · ${release.version} · ${release.sha256.slice(0, 12)}…`);
}

sag(`
${F.gruen}${F.fett}   Version ${version} ist veröffentlicht.${F.aus}

   Alle laufenden Clients sehen den Hinweis sofort, laden im
   Hintergrund und werden gefragt, bevor installiert wird.
`);
