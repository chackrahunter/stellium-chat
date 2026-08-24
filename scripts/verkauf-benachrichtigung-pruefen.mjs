#!/usr/bin/env node
/**
 * Beweis für die Dublettensperre bei Verkaufsmeldungen — gegen eine
 * WEGWERFBARE Datenbank, mit zwei GETRENNTEN Prozessen (nicht zwei
 * Funktionsaufrufen im selben Lauf), damit ein echter Serverneustart
 * simuliert wird und nicht nur ein zweiter Blick im selben Speicher.
 *
 * Siehe packages/server/src/pruefungen/verkauf-benachrichtigung.mts für die
 * Begründung und die einzelnen Fälle. Der eigene Ordner ist der Punkt (wie
 * bei scripts/verkaufsstatistik-pruefen.mjs): dieser Lauf legt Zeilen an und
 * liest die rohe Datenbank aus, und das darf niemals gegen die echte
 * Datenbank laufen.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-verkauf-benachrichtigung-'));

const lauf = (phase) => execFileSync(
  'npx', ['tsx', 'src/pruefungen/verkauf-benachrichtigung.mts', phase],
  { cwd: path.join(wurzel, 'packages/server'), env: { ...process.env, DATA_DIR: ordner }, stdio: 'inherit' },
);

try {
  console.log('\n\x1b[1mPhase 1 — erster Sync-Lauf, frischer Prozess, frische Datenbank\x1b[0m');
  lauf('1');

  console.log('\x1b[1mPhase 2 — SIMULIERTER SERVERNEUSTART: zweiter, komplett neuer Prozess, dieselbe Datenbankdatei\x1b[0m');
  lauf('2');

  console.log('\x1b[32m✓ Dublettensperre bewiesen — dieselbe Verkaufs-ID über einen Prozessneustart hinweg löst genau eine Meldung aus, nicht zwei. Details je Fall stehen oben.\x1b[0m\n');
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
