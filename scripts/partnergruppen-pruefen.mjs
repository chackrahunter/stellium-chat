#!/usr/bin/env node
/**
 * Prüft die Briefpartner-Gruppen — gegen eine WEGWERFBARE Datenbank.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf legt Zeilen an und liest die
 * rohe Datenbank aus, und das darf niemals gegen die echte Datenbank laufen.
 * Siehe scripts/umfrage-anonym-pruefen.mjs für dasselbe Muster.
 *
 * Das Masterpasswort wird hier gesetzt (nicht im .mts-Lauf selbst), weil es
 * schon stehen muss, bevor `db/index.ts` und mit ihm `crypto/nachrichten.ts`
 * zum ersten Mal etwas verschlüsseln — sonst wäre "liegt nicht im Klartext"
 * gegenstandslos: ohne Masterpasswort ist verschluesseln() ein No-Op (siehe
 * scripts/e2e-postfach.mjs für dieselbe Überlegung).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-partnergruppen-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/partnergruppen.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner, STELLIUM_MASTER_PASSPHRASE: 'Probe-Partnergruppen-4711' },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
