/**
 * Nur die Weboberfläche auf den Server bringen — ohne den ganzen Serverstand.
 *
 * Zwei Regeln, die beim ersten Versuch von Hand gefehlt haben und die Seite
 * für alle unbrauchbar gemacht haben:
 *
 *   1. Die alten Dateien bleiben liegen. Wer die vorherige index.html noch im
 *      Zwischenspeicher hat, sucht nach Namen wie index-Bg7wJ7Xr.js — sind die
 *      gelöscht, antwortet der Server mit der Startseite, und der Browser
 *      bekommt HTML, wo er ein Stylesheet erwartet. Das Ergebnis ist eine
 *      Seite ganz ohne Gestaltung.
 *   2. Danach muss der Dienst neu starten. Er liest das Verzeichnis einmal
 *      beim Start ein; neue Dateinamen kennt er sonst nicht.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WURZEL = path.resolve(import.meta.dirname, '..');
const ZIEL = '/opt/stellium/packages/desktop/dist';
const WIRT = process.env.STELLIUM_SSH ?? 'stellium';

const lauf = (befehl, args, optionen = {}) =>
  execFileSync(befehl, args, { stdio: 'inherit', cwd: WURZEL, ...optionen });

console.log('→ Oberfläche bauen');
lauf('npx', ['vite', 'build'], { cwd: path.join(WURZEL, 'packages/desktop'), stdio: 'pipe' });

const paket = '/tmp/stellium-web.tgz';
console.log('→ einpacken');
// --no-xattrs: sonst landen macOS-Zusatzdateien (._*) im Paket.
lauf('tar', ['-C', 'packages/desktop/dist', '--no-xattrs', '-czf', paket, '.']);

console.log('→ übertragen');
lauf('scp', ['-q', paket, `${WIRT}:/tmp/`]);

console.log('→ einspielen');
lauf('ssh', [WIRT, `set -e
  sudo mkdir -p ${ZIEL}/assets
  # Nur ergänzen, nichts wegräumen — siehe Regel 1 oben.
  sudo tar -C ${ZIEL} -xzf ${paket}
  sudo find ${ZIEL} -name '._*' -delete
  sudo chown -R stellium:stellium-dev ${ZIEL}
  sudo systemctl restart stellium`]);

console.log('→ nachsehen');
const kopf = execFileSync('curl', ['-sI', 'https://stellium-chat.duckdns.org/'], { encoding: 'utf8' });
const seite = execFileSync('curl', ['-s', 'https://stellium-chat.duckdns.org/'], { encoding: 'utf8' });
const datei = (seite.match(/assets\/[^"]+\.css/) ?? [])[0];
const cssKopf = datei
  ? execFileSync('curl', ['-sI', `https://stellium-chat.duckdns.org/${datei}`], { encoding: 'utf8' })
  : '';

const gut = kopf.includes('200') && /content-type:\s*text\/css/i.test(cssKopf);
console.log(gut
  ? '\n✓ Die Seite lädt und liefert das Stylesheet mit dem richtigen Typ aus.'
  : `\n✗ Etwas stimmt nicht:\n${kopf}\n${cssKopf}`);
process.exit(gut ? 0 : 1);
