#!/usr/bin/env node
/**
 * Prüft, dass die Link-Vorschau dem Server keine Umleitung ins interne Netz
 * unterschiebt — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist Pflicht: der Lauf legt Zeilen in link_previews an
 * (fetchPreview merkt sich auch Absagen) und darf dabei niemals die echte
 * Datenbank anfassen. Siehe scripts/sprach-schwelle-pruefen.mjs für dasselbe
 * Grundmuster.
 *
 * Der Lauf geht NICHT ins Netz: beide Gegenstellen sind Attrappen auf
 * 127.0.0.1 mit vom System vergebenen Ports.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-link-umleitung-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/link-vorschau-umleitung.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner, JWT_SECRET: 'pruefunglaeuftmitfestemgeheimnis' },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
