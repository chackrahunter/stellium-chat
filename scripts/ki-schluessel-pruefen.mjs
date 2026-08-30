#!/usr/bin/env node
/**
 * Prüft den Groq-Schlüssel aus den Einstellungen: Recht, Vorrang gegenüber
 * der Umgebung, Wirksamkeit ohne Neustart und Löschen über ein leeres Feld.
 * Die Begründung und die einzelnen Prüfpunkte stehen im Kopf von
 * src/pruefungen/ki-schluessel.mts.
 *
 * Dieselbe Machart wie scripts/geheimnis-kopfzeilen-pruefen.mjs: eigener
 * DATA_DIR in einem Temp-Ordner, damit der Lauf weder die laufende Datenbank
 * noch den echten Tresor anfasst — er legt Konten an UND schreibt Schlüssel.
 *
 * Masterpasswort und GROQ_BASE_URL setzt der Lauf selbst (siehe dort): er
 * braucht keine Keychain und schickt nichts ins Netz.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-ki-schluessel-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/ki-schluessel.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    /* DATA_DIR absolut: der Lauf liest die Tresordatei für seine Gegenprobe
       selbst noch einmal, und ein relativer Pfad zeigte dabei woandershin als
       der, den config.ts gegen das Paketverzeichnis rechnet. */
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
