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
/* Die Adresse steht einmal und nicht dreimal. Sie hat sich schon einmal
   geändert — beim Umzug auf den Cloudflare-Tunnel am 20.08. wurde
   stellium-chat.duckdns.org stillgelegt, und weil sie hier dreifach
   ausgeschrieben war, lief die Nachschau danach ins Leere, ohne dass es
   jemandem auffiel: `kopf` enthielt kein „200", also meldete der Lauf
   brav einen Fehlschlag — für eine Auslieferung, die geglückt war. */
const OEFFENTLICH = process.env.STELLIUM_SERVER?.replace(/\/+$/, '') || 'https://chat.stellium.club';

/* Geduldig nachsehen. Die Zeile davor startet den Server neu; er braucht ein
   paar Sekunden, bis er wieder antwortet. Ohne das Warten meldete dieser Lauf
   eine geglückte Auslieferung als Fehlschlag — und ein Werkzeug, das grundlos
   rot leuchtet, wird nach dem dritten Mal nicht mehr gelesen. Das ist derselbe
   Schaden wie ein Werkzeug, das grundlos grün meldet, nur andersherum. */
let kopf = '', seite = '', datei, cssKopf = '';
for (let versuch = 1; versuch <= 12; versuch++) {
  try {
    kopf = execFileSync('curl', ['-sI', '--max-time', '10', `${OEFFENTLICH}/`], { encoding: 'utf8' });
    seite = execFileSync('curl', ['-s', '--max-time', '10', `${OEFFENTLICH}/`], { encoding: 'utf8' });
    datei = (seite.match(/assets\/[^"]+\.css/) ?? [])[0];
    cssKopf = datei
      ? execFileSync('curl', ['-sI', '--max-time', '10', `${OEFFENTLICH}/${datei}`], { encoding: 'utf8' })
      : '';
    if (kopf.includes('200') && /content-type:\s*text\/css/i.test(cssKopf)) break;
  } catch { /* noch nicht da */ }
  if (versuch < 12) execFileSync('sleep', ['3']);
}

const gut = kopf.includes('200') && /content-type:\s*text\/css/i.test(cssKopf);
console.log(gut
  ? '\n✓ Die Seite lädt und liefert das Stylesheet mit dem richtigen Typ aus.'
  : `\n✗ Etwas stimmt nicht:\n${kopf}\n${cssKopf}`);
process.exit(gut ? 0 : 1);
