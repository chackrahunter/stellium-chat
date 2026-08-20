/**
 * Zugangsdaten für die Prüfläufe — an einer Stelle statt in jeder Datei.
 *
 * Das Repository ist öffentlich. Ein Passwort im Quelltext wäre damit für
 * jeden lesbar, auch wenn es "nur" für die Entwicklungsdatenbank gilt: zu
 * oft ist dasselbe anderswo noch einmal in Gebrauch.
 *
 * Einmal einrichten (die Datei ist von Git ausgenommen):
 *
 *   echo 'don'                > .stellium-test
 *   echo 'DEIN-TESTPASSWORT' >> .stellium-test
 *
 * Oder über die Umgebung: STELLIUM_TEST_LOGIN und STELLIUM_TEST_PASSWORT.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ausDatei() {
  const datei = path.join(wurzel, '.stellium-test');
  if (!fs.existsSync(datei)) return null;
  const [login, passwort] = fs.readFileSync(datei, 'utf8').split('\n').map((z) => z.trim());
  return login && passwort ? { login, passwort } : null;
}

const datei = ausDatei();

export const LOGIN = process.env.STELLIUM_TEST_LOGIN || datei?.login || '';
export const PW = process.env.STELLIUM_TEST_PASSWORT || datei?.passwort || '';
/* Bewusst NICHT STELLIUM_SERVER: das ist in diesem Repo die dokumentierte
   PRODUKTIONS-Adresse (veroeffentlichen.mjs, AUSLIEFERN.md) und steht in der
   Shell oft dauerhaft exportiert. Die Prüfläufe legen Nachrichten, Aufgaben
   und Ideen an — ein vergessener Export hätte sie in den Firmen-Chat
   geschrieben. Prüfläufe haben deshalb ihre eigene Variable. */
export const SERVER = (process.env.STELLIUM_TEST_SERVER || 'http://localhost:8787').replace(/\/+$/, '');
export const APP = process.env.STELLIUM_APP || 'http://localhost:5173';

if (!LOGIN || !PW) {
  console.error(
    '\n✗ Kein Testzugang hinterlegt.\n\n'
    + '  Lege ihn einmalig an (die Datei bleibt außerhalb von Git):\n'
    + "    echo 'don'                > .stellium-test\n"
    + "    echo 'DEIN-TESTPASSWORT' >> .stellium-test\n\n"
    + '  Oder setze STELLIUM_TEST_LOGIN und STELLIUM_TEST_PASSWORT.\n',
  );
  process.exit(1);
}
