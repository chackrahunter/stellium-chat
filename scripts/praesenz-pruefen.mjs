#!/usr/bin/env node
/**
 * Prüft die Online-Zeit — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt Zeilen an und löscht
 * sie wieder, und das darf niemals in der echten Datenbank passieren. Ein
 * Prüflauf, der Daten anfassen kann, wird irgendwann welche verlieren.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-praesenz-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/praesenz.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
