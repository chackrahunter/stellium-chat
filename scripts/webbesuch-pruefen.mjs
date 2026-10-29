#!/usr/bin/env node
/**
 * Prüft das Besuchersignal von stellium.club gegen eine WEGWERFBARE
 * Datenbank — siehe packages/server/src/pruefungen/webbesuch.mts.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-webbesuch-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/webbesuch.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
