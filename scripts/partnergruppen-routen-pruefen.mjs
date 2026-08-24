#!/usr/bin/env node
/**
 * Prüft die HTTP-Schicht der Briefpartner-Gruppen — gegen eine WEGWERFBARE
 * Datenbank. Ergänzt scripts/partnergruppen-pruefen.mjs (das prüft den
 * Dienst direkt) um die Ebene, auf der die eigentliche Lücke saß: fehlende
 * Registrierung in http/routes.ts. Siehe
 * packages/server/src/pruefungen/partnergruppen-routen.mts für den
 * ausgeschriebenen Grund.
 *
 * Dieselbe Machart wie partnergruppen-pruefen.mjs: eigener, wegwerfbarer
 * Datenordner, Masterpasswort schon beim Start gesetzt (sonst wäre
 * verschluesseln() ein No-Op, siehe dort).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-partnergruppen-routen-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/partnergruppen-routen.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner, STELLIUM_MASTER_PASSPHRASE: 'Probe-Partnergruppen-Routen-4711' },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
