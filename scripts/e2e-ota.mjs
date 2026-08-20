/**
 * Die Update-Wege unter widrigen Umständen.
 *
 * Geprüft wird das, was im Ernstfall wehtut: falsche Prüfsummen, abgerissene
 * Verbindungen, Archive mit Pfaden nach draußen, halb geladene Dateien.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LOGIN, PW, SERVER as S } from './zugang.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

console.log('\nServerseitige Absicherung');

await pruefe('Ein Archiv mit "../" wird abgelehnt', async () => {
  /* Hier stand das Muster einmal ausgeschrieben — im Prüfling, nicht im
     Skript. Damit prüfte dieser Lauf seine eigene Zeile: wer die Absicherung
     in stellium-selbstupdate.sh ändert oder löscht, bekam weiterhin ein Häkchen.
     Das Muster wird jetzt aus dem ausgelieferten Skript gelesen und genau so
     angewandt, wie es dort steht. Fehlt es dort, fällt der Lauf durch. */
  const skript = fs.readFileSync('server-setup/stellium-selbstupdate.sh', 'utf8');
  const wache = skript.match(/tar -tzf "\$PAKET" \| grep -qE '([^']+)'/);
  muss(wache, 'in stellium-selbstupdate.sh sieht niemand mehr ins Archiv, bevor es ausgepackt wird');
  const muster = wache[1];

  const proben = [
    ['../ausbruch/datei', true],
    ['/etc/passwd', true],
    ['stellium-server/../../weg', true],
    ['stellium-server/server-setup/stellium-aktualisieren.sh', false],
    ['stellium-server/packages/server/dist/index.js', false],
    ['stellium-server/..punkte/datei', false],
  ];
  for (const [pfad, gefaehrlich] of proben) {
    const antwort = execFileSync('bash', ['-c',
      `printf '%s\\n' ${JSON.stringify(pfad)} | grep -qE ${JSON.stringify(muster)} && echo ja || echo nein`,
    ], { encoding: 'utf8' }).trim();
    muss((antwort === 'ja') === gefaehrlich, `"${pfad}" wurde als ${antwort === 'ja' ? 'gefährlich' : 'harmlos'} eingestuft`);
  }
  // Und die Wache muss vor dem Auspacken stehen, nicht danach.
  muss(skript.indexOf('grep -qE') < skript.indexOf('tar -C "$ARBEIT"'),
    'ins Archiv wird erst nach dem Auspacken gesehen');
  return `${proben.length} Pfade gegen das echte Muster geprüft`;
});

await pruefe('Das Skript hält die Prüfsumme für verbindlich', async () => {
  const skript = fs.readFileSync('server-setup/stellium-selbstupdate.sh', 'utf8');
  muss(/sha256sum/.test(skript), 'keine Prüfsumme');
  const i = skript.indexOf('sha256sum');
  const j = skript.indexOf('tar -C "$ARBEIT"');
  muss(i > 0 && j > i, 'die Prüfsumme wird erst nach dem Auspacken geprüft');
  return 'geprüft, bevor ausgepackt wird';
});

await pruefe('Vor dem Laden wird der Platz geprüft', async () => {
  const skript = fs.readFileSync('server-setup/stellium-selbstupdate.sh', 'utf8');
  muss(/df -Pk/.test(skript), 'keine Platzprüfung');
  // Verglichen wird mit dem Laden des Pakets, nicht mit der Anmeldung davor.
  muss(skript.indexOf('df -Pk') < skript.indexOf('-o "$PAKET"'), 'die Prüfung kommt zu spät');
});

await pruefe('Der Rückfall steht im Aktualisierungsskript', async () => {
  const skript = fs.readFileSync('server-setup/stellium-aktualisieren.sh', 'utf8');
  muss(/zurueck\(\)/.test(skript), 'keine Rückfallebene');
  /* `zurueck$` allein genügte hier nicht: es traf auch `einstellungen_zurueck`
     — eine ganz andere Funktion, die es unabhängig davon gibt. Damit blieb die
     Prüfung grün, während der `trap` gelöscht war. Verlangt wird deshalb der
     Auslöser selbst. */
  muss(/^\s*trap\s+'?zurueck'?\s+.*ERR/m.test(skript),
    'kein "trap zurueck ERR" — der Rückfall wird bei einem Fehler nie ausgelöst');
  muss(/^\s*trap\s+'?zurueck'?\s+.*(INT|TERM)/m.test(skript),
    'kein "trap zurueck INT TERM" — ein Abbruch von Hand lässt den Server halb aktualisiert stehen');
});

console.log('\nClientseitige Absicherung');

const quelle = fs.readFileSync('packages/desktop/electron/updater.ts', 'utf8');

await pruefe('Die Prüfsumme entscheidet vor dem Umbenennen', async () => {
  const iSumme = quelle.indexOf('const summe = await summeVonDatei');
  const iName = quelle.indexOf('fs.renameSync(halb, ziel)');
  muss(iSumme > 0 && iName > iSumme, 'umbenannt wird vor dem Prüfen');
});

await pruefe('Geladen wird als Datenstrom, nicht in den Speicher', async () => {
  muss(/createWriteStream\(halb/.test(quelle), 'schreibt nicht als Strom');
  muss(!/Buffer\.concat\(stuecke\)/.test(quelle), 'sammelt weiterhin alles im Speicher');
});

await pruefe('Abgerissene Übertragungen werden fortgesetzt', async () => {
  muss(/kopf\.range = `bytes=/.test(quelle), 'kein Wiederaufsetzen');
  muss(/versuch <= 3/.test(quelle), 'kein zweiter Anlauf');
});

await pruefe('Eine stehende Leitung wird abgebrochen', async () => {
  muss(/AbortController/.test(quelle) && /letzteRegung/.test(quelle), 'keine Wache');
});

await pruefe('Vor dem Laden wird der Platz geprüft', async () => {
  muss(/statfsSync/.test(quelle), 'keine Platzprüfung');
});

await pruefe('Die alte App wird erst nach dem Kopieren entfernt', async () => {
  const i = quelle.indexOf('cp -R "$NEU" "$FRISCH"');
  const j = quelle.indexOf('mv "$ZIEL" "$ALT"');
  muss(i > 0 && j > i, 'gelöscht wird vor dem Kopieren');
  muss(/mv "\$ALT" "\$ZIEL"/.test(quelle), 'kein Weg zurück, wenn es klemmt');
});

await pruefe('Updates liegen nicht im gemeinsamen Zwischenspeicher', async () => {
  muss(/app\.getPath\('userData'\), 'updates'/.test(quelle), 'liegt weiterhin in /tmp');
});

console.log('\nServer meldet, was er anbietet');

const { token } = await (await fetch(`${S}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login: LOGIN, password: PW }),
})).json();

await pruefe('Die Prüfsumme kommt mit der Auskunft', async () => {
  const r = await fetch(`${S}/api/releases/check?platform=darwin&version=0.0.1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const daten = await r.json();
  /* Ein Übersprung ist kein bestandener Lauf: hier stand einmal
     `return '… übersprungen'`, und damit galten die beiden Zusagen darunter
     als erfüllt, obwohl niemand sie gemessen hatte. */
  muss(daten.update, 'keine Fassung hinterlegt — dann sagt diese Prüfung nichts');
  muss(/^[a-f0-9]{64}$/.test(daten.update.sha256 ?? ''), 'keine oder unsinnige Prüfsumme');
  muss(daten.update.size > 0, 'keine Größe');
  return `${daten.update.version} · ${daten.update.sha256.slice(0, 12)}…`;
});

await pruefe('Eine ältere Fassung löst kein Update aus', async () => {
  const r = await fetch(`${S}/api/releases/check?platform=darwin&version=99.0.0`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const daten = await r.json();
  muss(daten.update === null, 'bietet ein Zurückgehen an');
});

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
