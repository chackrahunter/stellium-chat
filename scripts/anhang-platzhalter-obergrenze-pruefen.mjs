#!/usr/bin/env node
/**
 * Prüft, dass createMessage() Anzahl und Namenslänge von Anhang-Platzhaltern
 * begrenzt, ohne realistische Nachrichten abzuweisen — gegen eine
 * WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt Zeilen an, und das darf
 * niemals gegen die echte Datenbank laufen. Siehe scripts/umfrage-anonym-
 * pruefen.mjs für dasselbe Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-anhang-obergrenze-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/anhang-platzhalter-obergrenze.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
