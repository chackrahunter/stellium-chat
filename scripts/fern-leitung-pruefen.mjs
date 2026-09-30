#!/usr/bin/env node
/**
 * Die Fernsteuerung im Browser: der Chat-Server als Vermittler zum Pi
 * (packages/server/src/http/fernleitung.ts), gegen den echten Pi-Dienst mit
 * nachgemachtem Abgreifer. Rechte, Bremse, kein Passwort beim Browser, der
 * Name aus dem Konto, und ob der Pi den Rückstau hinter dem Vermittler sieht.
 * Dazu scrypt mit den Parametern des Pi gegen RFC 7914.
 *
 * Die Prüfung selbst steht in packages/server/src/pruefungen/fern-leitung.mts.
 * Wer an fernleitung.ts oder server-setup/fernsteuerung/dienst/ dreht, prüft
 * damit. Kein laufender Server, kein Pi, kein Netz.
 *
 *     node scripts/fern-leitung-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-fern-leitung-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/fern-leitung.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} catch {
  process.exitCode = 1;
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
