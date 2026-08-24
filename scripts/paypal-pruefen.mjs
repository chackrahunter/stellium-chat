#!/usr/bin/env node
/**
 * Prüft die PayPal-Anbindung — gegen eine WEGWERFBARE Datenbank und eine
 * Attrappe statt PayPal. Es fließt kein Byte zu PayPal, und es braucht keine
 * Zugangsdaten: die trägt der Inhaber selbst ein, und niemand sonst.
 *
 * Der eigene Ordner ist der Punkt: der Prüflauf schreibt Zugangsdaten und
 * Zwischenstände in `app_settings`, und das darf niemals gegen die echte
 * Datenbank laufen. Dasselbe Muster wie
 * scripts/verkaufsstatistik-pruefen.mjs und scripts/umfrage-anonym-pruefen.mjs.
 *
 * Zwei Umgebungsvariablen setzt dieser Lauf zusätzlich:
 *
 *   STELLIUM_MASTER_PASSPHRASE      damit die Feldverschlüsselung wirklich
 *                                   läuft — sonst prüfte der Lauf die
 *                                   Klartext-Notlösung statt der Ablage,
 *                                   die im Betrieb greift. Ein Wegwerfwert,
 *                                   der mit dem Ordner verschwindet.
 *
 *   STELLIUM_KURS_HISTORISCH_URL    zeigt bewusst ins Leere. Der Prüflauf
 *                                   legt den einen gebrauchten Wechselkurs
 *                                   selbst in die Tabelle; würde ihn trotzdem
 *                                   jemand aus dem Netz holen wollen, fiele
 *                                   das sofort auf statt still zu gelingen.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-paypal-'));
try {
  execFileSync('npx', ['tsx', path.join(wurzel, 'scripts/paypal-pruefung.mts')], {
    cwd: path.join(wurzel, 'packages/server'),
    env: {
      ...process.env,
      DATA_DIR: ordner,
      STELLIUM_MASTER_PASSPHRASE: crypto.randomBytes(24).toString('base64url'),
      STELLIUM_KURS_HISTORISCH_URL: 'http://127.0.0.1:1/kein-kursdienst',
    },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
