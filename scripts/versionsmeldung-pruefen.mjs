#!/usr/bin/env node
/**
 * Prüft, dass eine gemeldete App-Fassung gespeichert wird, eine Anmeldung
 * ohne Fassung (älterer Client) nichts überschreibt und nicht abstürzt, der
 * Aktuell-Vergleich an einer echten Grenze richtig liegt, und die Auskunft
 * nur auf ManagedUser steht — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt Zeilen an, schreibt in
 * die releases-Tabelle und liest die rohe Datenbank aus — das darf niemals
 * gegen die echte Datenbank laufen. Siehe scripts/lesebestaetigung-
 * abschalten-pruefen.mjs für dasselbe Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-versionsmeldung-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/versionsmeldung.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
