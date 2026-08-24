#!/usr/bin/env node
/**
 * Prüft den Passwort-Tresor — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt Tresoreinträge an,
 * liest die rohe Datenbankdatei byteweise aus und schickt echte HTTP-
 * Anfragen gegen eine eingebettete Fastify-Instanz — das darf niemals gegen
 * die echte Datenbank laufen. Dieselbe Bauart wie
 * scripts/notizen-verschluesselung-pruefen.mjs und
 * scripts/notiz-kontoschluessel-pruefen.mjs.
 *
 * Aufruf:  node scripts/passwort-tresor-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-passwort-tresor-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/passwort-tresor.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
