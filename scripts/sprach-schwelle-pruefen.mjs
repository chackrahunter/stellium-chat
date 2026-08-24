#!/usr/bin/env node
/**
 * Prüft, dass Kanalangaben und Änderungslisten bei unsicherer Spracherkennung
 * die Sprache der verfassenden Person bekommen statt eines ungeprüften
 * "englisch" — gegen eine WEGWERFBARE Datenbank. Siehe
 * scripts/kanal-loeschen-uebersetzungsspeicher-pruefen.mjs für dasselbe
 * Muster.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-sprach-schwelle-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/sprach-schwelle.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    // Kein AI_PROVIDER gesetzt -> Voreinstellung 'groq' ohne Schlüssel ->
    // DemoProvider (siehe translation/index.ts, build()) — offline, kein
    // Netzzugriff nötig, und der Demo-Übersetzer ändert jeden Text, den er
    // wirklich übersetzt (Flaggen-Emoji voran), sodass NOOP und Übersetzung
    // hier eindeutig unterscheidbar bleiben.
    env: { ...process.env, DATA_DIR: ordner, JWT_SECRET: 'pruefunglaeuftmitfestemgeheimnis' },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
