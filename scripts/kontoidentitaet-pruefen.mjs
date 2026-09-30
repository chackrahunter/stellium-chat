#!/usr/bin/env node
/**
 * Prüft die Kontoidentität — den privaten ECDH-Teil, der dem KONTO gehört
 * statt einem Gerät. Ohne sie hängen private Dateien und vertrauliche Kanäle
 * am Schlüsselpaar EINES Geräts, und ein zweites kommt nie daran.
 *
 * Läuft gegen eine wegwerfbare Datenbank in einem eigenen Ordner: der Lauf
 * setzt Kontoschlüssel und ersetzt sie, und nichts davon darf je die echte
 * Datenbank berühren (dieselbe Bauart wie notiz-kontoschluessel-pruefen.mjs).
 *
 * Aufruf:  node scripts/kontoidentitaet-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-kontoidentitaet-'));
let fehler = 0;
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/kontoidentitaet.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} catch {
  fehler = 1;
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
process.exit(fehler);
