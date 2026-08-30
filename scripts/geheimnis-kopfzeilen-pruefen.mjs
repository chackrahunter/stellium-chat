#!/usr/bin/env node
/**
 * Prüft, ob jede Antwort mit einem Geheimnis darin `Cache-Control: no-store`
 * trägt — und ob die harmlosen Wege nachweislich ohne auskommen. Die
 * Begründung, die Liste der geprüften Wege und die Gegenprobe stehen im Kopf
 * von src/pruefungen/geheimnis-kopfzeilen.mts.
 *
 * Dieselbe Machart wie scripts/fern-passwort-anzeigen-pruefen.mjs: eigener
 * DATA_DIR in einem Temp-Ordner, damit der Lauf die laufende Datenbank
 * niemals anfasst — er legt Konten an und hinterlegt einen Fernzugang.
 *
 * Das Masterpasswort setzt der Lauf selbst: seit auch der Groq-Schlüssel
 * geprüft wird, muss der verschlüsselte Tresor im Temp-Ordner beschreibbar
 * sein — und zwar auf jedem Rechner gleich, ohne Keychain und ohne dass es
 * eine Rolle spielt, was in einer echten liegt.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-kopfzeilen-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/geheimnis-kopfzeilen.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: {
      ...process.env,
      DATA_DIR: ordner,
      STELLIUM_MASTER_PASSPHRASE: `pruef-${crypto.randomBytes(24).toString('hex')}`,
    },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
