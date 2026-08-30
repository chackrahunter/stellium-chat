#!/usr/bin/env node
/**
 * Prüft die Rechteschwelle vor `GET /api/fern/zugang-ansehen` — gegen eine
 * WEGWERFBARE Datenbank, über die echten Routen (Fastifys `inject()`, kein
 * Port). Die Begründung und die Abschnitte stehen im Kopf von
 * src/pruefungen/fern-passwort-anzeigen.mts.
 *
 * DER DATEINAME BLEIBT. Die Route hieß einmal `/api/fern/passwort`; seit sie
 * auch die Adresse liefert, heißt sie anders. Diesen Lauf mitumzubenennen
 * hieße, jeden Verweis darauf (Prüfliste, Auslieferung, Notizen) am selben
 * Tag mitzuziehen — für einen Dateinamen, der niemandem etwas verspricht.
 *
 * Dieselbe Machart wie scripts/rechte-eskalation-pruefen.mjs: eigener
 * DATA_DIR in einem Temp-Ordner, damit der Lauf die laufende Datenbank
 * niemals anfasst — er legt Konten an und LÖSCHT am Ende den hinterlegten
 * Fernzugang, was auf der echten Datenbank das Team aussperren würde.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-fern-passwort-'));
try {
  execFileSync('npx', ['tsx', 'src/pruefungen/fern-passwort-anzeigen.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: { ...process.env, DATA_DIR: ordner },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
