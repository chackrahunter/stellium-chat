/**
 * Ruft die Python-Prüfung der SSH-Wache auf.
 *
 * `wache.py` und `konsole.py` sind Python, nicht Teil des JS-Schwungs aus
 * *-pruefen.mjs — dieser Wrapper reiht sie trotzdem dort ein, damit sie mit
 * jedem Durchlauf mitlaufen. Die eigentlichen Prüfungen stehen in
 * `server-setup/ssh-wache/pruefen.py` und rufen die echte Anzeige-Logik auf,
 * nicht eine Abschrift davon.
 *
 *     node scripts/ssh-wache-pruefen.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pruefung = path.join(wurzel, 'server-setup', 'ssh-wache', 'pruefen.py');

// „-B“: keine .pyc-Dateien ablegen. Die Prüfung lädt wache.py und konsole.py
// unter Fantasienamen (importlib) — ohne das flag hinterließe jeder Lauf
// Bytecode-Reste in fremden __pycache__-Ordnern, die sonst mit eingecheckt
// aussähen, aber nur von diesem Test stammen.
const lauf = spawnSync('python3', ['-B', pruefung], { stdio: 'inherit' });

if (lauf.error) {
  console.error(`\nKonnte python3 nicht starten: ${lauf.error.message}\n`);
  process.exit(1);
}
process.exit(lauf.status ?? 1);
