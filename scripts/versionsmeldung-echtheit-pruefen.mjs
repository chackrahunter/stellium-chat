#!/usr/bin/env node
/**
 * Prüft, dass die vom Client gemeldete Fassung und Plattform auf ihre FORM
 * geprüft werden, bevor sie in users.client_version/client_platform landen:
 * Erfundenes wird verworfen (und überschreibt den bekannten Wert nicht), die
 * Werte der heutigen Clients kommen alle durch, und eine Anmeldung scheitert
 * daran nie — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt ein Konto an und
 * schreibt in dessen Spalten — das darf niemals gegen die echte Datenbank
 * laufen. Siehe scripts/versionsmeldung-pruefen.mjs für dasselbe Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-versionsmeldung-echtheit-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/versionsmeldung-echtheit.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
