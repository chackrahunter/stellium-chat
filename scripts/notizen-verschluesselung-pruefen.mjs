#!/usr/bin/env node
/**
 * Prüft die Ende-zu-Ende-Verschlüsselung der Notizen — gegen eine
 * WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt eine Notiz an, liest
 * die rohe Datenbankdatei byteweise aus, und das darf niemals gegen die
 * echte Datenbank laufen. Siehe scripts/umfrage-anonym-pruefen.mjs für
 * dasselbe Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-notizen-verschluesselung-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/notizen-verschluesselung.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
