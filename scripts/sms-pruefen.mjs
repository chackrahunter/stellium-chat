#!/usr/bin/env node
/**
 * Prüft die SMS-Anbindung an Twilio: die Signaturprüfung des öffentlichen
 * Webhooks, die Wiederholungsfestigkeit, das Recht auf die Zugangsdaten, den
 * Versand aus der eigenen Nummer und die Ehrlichkeit der Fehlermeldungen bei
 * Trial und 10DLC. Die Begründung und die einzelnen Prüfpunkte stehen im Kopf
 * von src/pruefungen/sms.mts.
 *
 * Dieselbe Machart wie scripts/ki-schluessel-pruefen.mjs: eigener DATA_DIR in
 * einem Temp-Ordner, damit der Lauf weder die laufende Datenbank noch den
 * echten Tresor anfasst — er legt Konten an UND schreibt Zugangsdaten.
 *
 * Masterpasswort und TWILIO_ENDE setzt der Lauf selbst (siehe dort): er
 * braucht keine Keychain, kein Twilio-Konto und schickt nichts ins Netz.
 * Anders als scripts/post-abruf-pruefen.mjs braucht er auch kein Zertifikat —
 * der Doppelgänger für den Versand spricht gewöhnliches HTTP auf 127.0.0.1,
 * und der eingehende Weg läuft ohne Netz über Fastifys `inject()`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-sms-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/sms.mts'], {
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
