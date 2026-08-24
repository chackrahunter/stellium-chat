#!/usr/bin/env node
/**
 * Prüft, dass das Löschen eines Kanals den Übersetzungsspeicher genauso
 * gezielt trifft wie das Löschen einer einzelnen Nachricht — gegen eine
 * WEGWERFBARE Datenbank. Siehe scripts/uebersetzungsspeicher-loeschen-pruefen.mjs
 * für dasselbe Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-kanal-tm-loeschen-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/kanal-loeschen-uebersetzungsspeicher.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
