/**
 * Prüft die Zusammenfassung der Online-Zeit gegen eine frische Datenbank.
 *
 * Der Kern ist nicht das Summieren — das ist eine Zeile SQL —, sondern das
 * Füllen der Lücken. Ein Tag ohne Eintrag muss als null Sekunden erscheinen
 * und nicht fehlen: eine Linie, die fehlende Tage überspringt, zeigt eine
 * Steigung, die es nie gab. Genau das lässt sich beim Lesen leicht übersehen
 * und im Bild nicht erkennen, weil eine falsche Linie ebenso glatt aussieht
 * wie eine richtige.
 *
 * Aufruf:  node scripts/praesenz-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import * as p from '../services/praesenz.js';

initDb();
const tag = (v: number) => new Date(Date.now() - v * 86_400_000).toISOString().slice(0, 10);

db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('probe', 'probe', 'Probe', 'x', 0)`);
db.run("DELETE FROM praesenz_tage WHERE user_id = 'probe'");
/* Absichtlich mit Lücken: heute, vorgestern, vor sechs Tagen. */
for (const [zurueck, sek] of [[0, 3600], [2, 1800], [6, 600]] as const) {
  db.run('INSERT INTO praesenz_tage (user_id, tag, sekunden) VALUES (?,?,?)', 'probe', tag(zurueck), sek);
}

const v = p.verlauf('probe', 'woche');
const s = p.summen('probe');
let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = ist === soll;
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${ist} statt ${soll}`}`);
};

pruef('Woche hat sieben Tage', v.length, 7);
pruef('kein Tag fehlt', v.every((x) => typeof x.sekunden === 'number'), true);
pruef('aufsteigend sortiert', v.map((x) => x.tag).join() === [...v].map((x) => x.tag).sort().join(), true);
pruef('letzter Tag ist heute', v[v.length - 1].tag, tag(0));
pruef('heute zählt', v[v.length - 1].sekunden, 3600);
pruef('Lücke wird zu null, nicht übersprungen', v[v.length - 2].sekunden, 0);
pruef('vorgestern zählt', v[v.length - 3].sekunden, 1800);
pruef('Summe heute', s.heute, 3600);
pruef('Summe Woche', s.woche, 6000);
pruef('Jahr enthält die Woche', s.jahr >= s.woche, true);

console.log(fehler ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n` : '\n\x1b[32mDie Online-Zeit rechnet richtig.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
