#!/usr/bin/env node
/**
 * Prüft, was eine Kontolöschung anfasst und was bewusst stehen bleibt —
 * gegen eine WEGWERFBARE Datenbank. Siehe scripts/praesenz-pruefen.mjs für
 * dasselbe Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-konto-loeschen-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/konto-loeschen.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
