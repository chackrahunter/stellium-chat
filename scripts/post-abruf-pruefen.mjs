#!/usr/bin/env node
/**
 * Prüft den Abruf aus einem fremden Postfach: Dublettenfreiheit über beide
 * Wege, das Fenster des Erstabrufs, den Umgang mit einem Fehlschlag, das
 * Recht und die Antwort aus der Stellium-Adresse. Die Begründung und die
 * einzelnen Prüfpunkte stehen im Kopf von src/pruefungen/post-abruf.mts.
 *
 * Dieselbe Machart wie scripts/ki-schluessel-pruefen.mjs: eigener DATA_DIR in
 * einem Temp-Ordner, damit der Lauf weder die laufende Datenbank noch den
 * echten Tresor anfasst — er legt Konten an, schreibt Zugangsdaten und füllt
 * ein Postfach.
 *
 * ZWEI DINGE MEHR ALS DORT, und beide müssen VOR dem Start von Node stehen:
 *
 *   · DAS ZERTIFIKAT. Der IMAP-Doppelgänger spricht echtes TLS, sonst wäre
 *     der gemessene Weg nicht der, den der Betrieb geht. Ein selbst
 *     ausgestelltes Zertifikat auf 127.0.0.1 reicht dafür — es muss nur
 *     bekannt sein, und `NODE_EXTRA_CA_CERTS` liest Node EINMAL beim Start.
 *     Aus einer laufenden Datei heraus ließe es sich nicht mehr setzen.
 *
 *   · Es geht dabei NICHTS ins Netz und es wird KEIN echter Zugang
 *     verwendet. Das Zertifikat lebt zwei Tage und liegt in einem Ordner,
 *     der am Ende dieses Laufs gelöscht wird.
 *
 * Braucht `openssl` (auf macOS und Raspberry Pi OS vorhanden). Fehlt es,
 * scheitert der Lauf laut — ein übersprungener Wächter ist schlimmer als ein
 * roter.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-post-abruf-'));
const zert = path.join(ordner, 'doppel.pem');
const schluessel = path.join(ordner, 'doppel.key');

try {
  /* `subjectAltName=IP:127.0.0.1`, nicht nur ein CN: Node prüft den Namen
     gegen die SAN-Liste und lehnt ein Zertifikat ohne passenden Eintrag ab,
     auch wenn der CN stimmt. */
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', schluessel, '-out', zert, '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  execFileSync('npx', ['tsx', 'src/pruefungen/post-abruf.mts'], {
    cwd: path.join(wurzel, 'packages/server'),
    env: {
      ...process.env,
      /* Absolut, aus demselben Grund wie bei ki-schluessel-pruefen.mjs: der
         Lauf und config.ts rechnen sonst gegen verschiedene Verzeichnisse. */
      DATA_DIR: ordner,
      NODE_EXTRA_CA_CERTS: zert,
      PROBE_ZERT: zert,
      PROBE_SCHLUESSEL: schluessel,
    },
    stdio: 'inherit',
  });
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}
