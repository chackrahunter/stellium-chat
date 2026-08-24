#!/usr/bin/env node
/**
 * Prüft packages/desktop/src/lib/benachrichtigung.ts OHNE Browser: darf ein
 * kaputter Meldeweg jemals als "erlaubt" gemeldet werden?
 *
 * Der Befund lautete: `meldewegPruefen()` rief bisher
 * `window.stellium?.notifyMoeglich?.().then(...).catch(...)` — EINE
 * zusammenhängende optionale Kette. Fehlte `notifyMoeglich` (ältere
 * App-Fassung ohne diesen Aufruf), brach nicht nur der Aufruf selbst ab,
 * sondern die GANZE Kette bis zum Schluss: `.then()` UND `.catch()` liefen
 * dann NIE, ganz ohne Fehler und ohne Wert. `appKannMelden` blieb für immer
 * bei `null` stehen, und `erlaubnisStand()` deutete das als "erlaubt" —
 * genau der Fall, den die Einstellungen NIE zeigen sollten. Der Fix ersetzt
 * das durch eine synchrone `typeof`-Prüfung VOR jedem Verkettungsversuch.
 *
 * WARUM e2e-benachrichtigung.mjs DIESEN ZWEIG NICHT SIEHT
 * Der Lauf dort öffnet ein reines Chromium ohne Electron-Bridge — dort ist
 * `window.stellium` von Haus aus `undefined`, `inDerApp()` also immer
 * `false`, und der GANZE App-Zweig in benachrichtigung.ts (inklusive der
 * kaputten Kette) läuft nie an. Der Test dort ist grün, WEIL das Feature in
 * seiner Umgebung abgeschaltet ist — die Grundgesamtheit, gegen die dieser
 * Prüflauf hier antritt.
 *
 * WIE DAS MODUL OHNE BUNDLER LÄDT
 * benachrichtigung.ts hat genau EINEN echten Laufzeit-Import:
 * `./mac-benachrichtigung.js`. Der zieht transitiv i18n/index.ts ->
 * state/store.ts -> net/socket.ts nach sich, und state/store.ts ruft beim
 * Laden `window.addEventListener(...)` GANZ OBEN im Modul auf — ESM lädt
 * jeden statischen Import vollständig, unabhängig davon, welche Funktion
 * aus der Datei am Ende aufgerufen wird. Weder meldewegPruefen() noch
 * erlaubnisStand() (die zwei Funktionen, um die es hier geht) rufen
 * macAnzeigen() jemals auf — der Import ist für diesen Test ein reiner
 * ESM-Ladeartefakt, keine echte Abhängigkeit.
 *
 * Deshalb: ein Node-ESM-Loader-Hook leitet GENAU diesen einen
 * Geschwister-Import auf einen Leerlauf-Stub um — benachrichtigung.ts
 * selbst (das Modul UNTER TEST) läuft unverändert und ungemockt, mit seiner
 * echten Logik. Ohne diese Umleitung bräuchte es ein vollständiges
 * DOM (jsdom/happy-dom) oder Vitest — beides ist in diesem Paket nicht
 * eingerichtet (kein Eintrag in package.json, nichts in node_modules), und
 * es einzurichten wäre selbst ein Bundler/Test-Runner-Schritt. Diese Datei
 * bleibt bewusst unterhalb dieser Schwelle: ein einzelner, eng gezielter
 * Loader-Hook für eine nie aufgerufene Geschwisterdatei, nicht mehr.
 *
 * Ein zweiter, minimaler `window`-Stub genügt: `window.stellium` ist alles,
 * was meldewegPruefen()/erlaubnisStand() lesen — kein DOM, kein
 * addEventListener, weil mit der Umleitung oben net/socket.ts nie geladen
 * wird.
 *
 * DREI Szenarien, nicht zwei: die zwei aus der Vorgabe (Bridge fehlt ganz;
 * Bridge da, lehnt aber ab) MÜSSEN beide "geht-nicht" melden. Ein drittes,
 * FUNKTIONIERENDES Szenario (Bridge da, sagt "geht") ist die Gegenprobe:
 * ohne sie bewiese ein Lauf, der immer "geht-nicht" ausgibt, gar nichts —
 * dieselbe leere-Fixture-Falle wie überall sonst in diesem Haus.
 *
 * Jedes Szenario läuft in einem EIGENEN Node-Prozess: appKannMelden ist
 * veränderlicher Modulzustand, ein zweiter Import über denselben
 * ESM-Cache liefert dieselbe Instanz zurück und ließe ein Szenario am
 * Rest des vorigen weiterlaufen.
 *
 * Aufruf:  node scripts/benachrichtigung-lib-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulPfad = path.join(wurzel, 'packages/desktop/src/lib/benachrichtigung.ts');
const desktopPaket = path.join(wurzel, 'packages/desktop');

if (!fs.existsSync(modulPfad)) {
  console.error(`Nicht gefunden: ${modulPfad}`);
  process.exit(1);
}

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-benachrichtigung-lib-'));
let fehlerGesamt = 0;
try {
  // Leerlauf-Ersatz für die eine Geschwisterdatei, die keine der beiden
  // geprüften Funktionen je aufruft (siehe Kopfkommentar).
  fs.writeFileSync(
    path.join(ordner, 'mac-stub.mjs'),
    `export function macAnzeigen() { return false; }\n`,
  );

  // Der Loader-Hook selbst: leitet nur den EINEN Spezifizierer um, sonst
  // unverändert an den nächsten Resolver weiter. tsx schreibt `.js` beim
  // Weiterreichen intern zu `.ts` um — deshalb hier ein Teilstring-Treffer
  // auf den Dateinamen statt eines exakten Vergleichs mit der Endung.
  fs.writeFileSync(
    path.join(ordner, 'loader-hook.mjs'),
    `export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('mac-benachrichtigung')) {
    return { url: new URL('./mac-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`,
  );
  fs.writeFileSync(
    path.join(ordner, 'register-hook.mjs'),
    `import { register } from 'node:module';
register('./loader-hook.mjs', import.meta.url);
`,
  );

  // Ein Probelauf, per Umgebungsvariable auf eines von drei Szenarien
  // gestellt — derselbe Programmkörper, damit kein Szenario eine andere
  // Prüfung als die anderen zwei bekommt.
  fs.writeFileSync(
    path.join(ordner, 'probe.mts'),
    `const szenario = process.env.BENACHRICHTIGUNG_SZENARIO;

let fehler = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(\`  \${ok ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\${ok ? '' : \`  \${JSON.stringify(ist)} statt \${JSON.stringify(soll)}\`}\`);
};

if (szenario === 'bridge-fehlt') {
  // Ältere App-Fassung: die Bridge selbst gibt es, notifyMoeglich noch nicht.
  globalThis.window = { stellium: {} };
} else if (szenario === 'bridge-lehnt-ab') {
  // Die Bridge gibt es, der Aufruf schlägt fehl (echter Fehler, keine Lücke).
  globalThis.window = { stellium: { notifyMoeglich: () => Promise.reject(new Error('kaputt')) } };
} else if (szenario === 'bridge-geht') {
  // Gegenprobe: funktionierender Weg muss auch als funktionierend erkannt werden.
  globalThis.window = { stellium: { notifyMoeglich: () => Promise.resolve(true) } };
} else {
  throw new Error(\`unbekanntes Szenario: \${szenario}\`);
}

const mod = await import(${JSON.stringify(pathToFileUrlLiteral(modulPfad))});
mod.meldewegPruefen();
// Der Fehlerzweig (bridge-lehnt-ab) hängt am .catch() einer echten Promise —
// die läuft über die Mikrotask-Warteschlange, nicht synchron.
await new Promise((r) => setTimeout(r, 50));
const stand = mod.erlaubnisStand();

if (szenario === 'bridge-geht') {
  pruef(\`\${szenario}: erlaubnisStand() meldet "erlaubt" (Gegenprobe — ein echter Weg wird auch erkannt)\`, stand, 'erlaubt');
} else {
  pruef(\`\${szenario}: erlaubnisStand() meldet "geht-nicht", NICHT das trügerisch sichere "erlaubt"\`, stand, 'geht-nicht');
}

console.log(fehler ? \`\\x1b[31m\${fehler} fehlgeschlagen\\x1b[0m\` : '\\x1b[32mok\\x1b[0m');
process.exit(fehler ? 1 : 0);
`,
  );

  for (const szenario of ['bridge-fehlt', 'bridge-lehnt-ab', 'bridge-geht']) {
    console.log(`\nSzenario "${szenario}":`);
    try {
      execFileSync(
        'node',
        ['--import', path.join(ordner, 'register-hook.mjs'), '--import', 'tsx', path.join(ordner, 'probe.mts')],
        { cwd: desktopPaket, env: { ...process.env, BENACHRICHTIGUNG_SZENARIO: szenario }, stdio: 'inherit' },
      );
    } catch {
      fehlerGesamt += 1;
    }
  }
} finally {
  // WICHTIG: process.exit() steht bewusst NICHT hier im try — ein Aufruf
  // dort würde den Prozess sofort beenden und dieses finally überspringen,
  // der Temp-Ordner bliebe liegen (genau das ist beim ersten Schreiben
  // dieser Datei passiert und wurde beim Prüflauf bemerkt).
  fs.rmSync(ordner, { recursive: true, force: true });
}

console.log(fehlerGesamt
  ? `\n\x1b[31m${fehlerGesamt} Szenario(en) fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mEin kaputter Meldeweg meldet sich ehrlich als "geht-nicht" — in jedem der drei Szenarien.\x1b[0m\n');
process.exit(fehlerGesamt ? 1 : 0);

/** file://-URL als Literal für die generierte Probedatei — Windows-Backslashes eingeschlossen. */
function pathToFileUrlLiteral(p) {
  return `file://${p.replace(/\\/g, '/')}`;
}
