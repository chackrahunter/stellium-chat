#!/usr/bin/env node
/**
 * Prüft die Fußzeile einer KI-beteiligten ausgehenden Mail (Text- und
 * HTML-Teil, alle drei Fälle, Whitespace-Robustheit) und die dazugehörige
 * Lernsperre in post-lernen.ts — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt, genau wie bei post-aufbewahrung-pruefen.mjs:
 * der Prüflauf legt Zeilen an, das darf niemals gegen die echte Datenbank
 * laufen.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-post-fussnote-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/post-fussnote.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
