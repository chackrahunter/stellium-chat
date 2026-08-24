#!/usr/bin/env node
/**
 * Prüft tabellengetrieben, dass kein admin-verändernder Endpunkt sich mit
 * nur einem nicht-ownerOnly Recht zur Rechte-Eskalation missbrauchen lässt —
 * gegen eine WEGWERFBARE Datenbank, direkt gegen den Dienst (kein Bau, kein
 * HTTP — siehe Kopfkommentar in src/pruefungen/rechte-eskalation.mts für die
 * Begründung). Siehe scripts/praesenz-pruefen.mjs für dasselbe Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-rechte-eskalation-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/rechte-eskalation.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
