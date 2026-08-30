#!/usr/bin/env node
/**
 * Prüft die Problemberichte — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt Zeilen an, löscht
 * sogar die Tabelle selbst wieder (Migrations-Probe), und das darf niemals
 * in der echten Datenbank passieren.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-problemberichte-'));
try {
  const optionen = {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  };
  // Zwei Prozesse mit demselben DATA_DIR, nacheinander: der zweite ist
  // absichtlich ein FRISCHER Prozess (Begründung im Kopf von
  // problemberichte-migration.mts) und läuft auf der Datenbank weiter, die
  // der erste hinterlassen hat.
  execFileSync('npx', ['tsx', 'src/pruefungen/problemberichte.mts'], optionen);
  execFileSync('npx', ['tsx', 'src/pruefungen/problemberichte-migration.mts'], optionen);
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
