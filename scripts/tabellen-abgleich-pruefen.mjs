#!/usr/bin/env node
/**
 * Prüft, ob jede Tabelle, die migrate.ts zusätzlich zu schema.sql anlegt
 * ("Wortgleich mit dort", z. B. mail_wissen), an beiden Stellen wirklich
 * dieselbe Spaltenliste trägt. Reiner Textvergleich — DATA_DIR zeigt trotzdem
 * auf ein Wegwerfverzeichnis, weil schon der Import von db/index.js eine
 * DatabaseSync-Datei öffnet (siehe dort), auch wenn dieser Lauf sie nie
 * benutzt.
 *
 * Aufruf:  node scripts/tabellen-abgleich-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-tabellen-abgleich-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/tabellen-abgleich.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
