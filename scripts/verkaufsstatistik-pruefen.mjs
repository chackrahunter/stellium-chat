#!/usr/bin/env node
/**
 * Prüft die Verkaufsstatistik — gegen eine WEGWERFBARE Datenbank, mit
 * erfundenen Verkaufsdaten (es gibt heute wirklich null Verkäufe).
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt Zeilen an und liest
 * die rohe Datenbank aus, und das darf niemals gegen die echte Datenbank
 * laufen. Siehe scripts/umfrage-anonym-pruefen.mjs für dasselbe Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-verkaufsstatistik-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/verkaufsstatistik.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
