#!/usr/bin/env node
/**
 * Prüft, dass ein verwaister Anhang-Platzhalter (Upload nie angekommen)
 * nach seiner Frist verschwindet und alle Mitglieder davon per
 * message:updated erfahren — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt Zeilen an und öffnet
 * eine echte handleConnection()-Sitzung (gegen eine Attrappe statt einen
 * echten Netzwerk-Socket), und das darf niemals gegen die echte Datenbank
 * laufen. Siehe scripts/umfrage-anonym-pruefen.mjs für dasselbe Grundmuster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-anhang-frist-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/anhang-platzhalter-frist.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
