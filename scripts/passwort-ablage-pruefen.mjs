#!/usr/bin/env node
/**
 * Prüft, dass der Passwort-Tresor die Zwischenablage WIRKLICH wieder leert.
 *
 * WORAN DAS VORHER SCHEITERTE — UND WARUM ES NIEMAND MERKTE
 *
 * `kopierenUndLoeschen()` legte den Wert per `navigator.clipboard.writeText`
 * ab und wollte ihn zwanzig Sekunden später mit `readText()` zurücklesen, um
 * ihn nur dann zu löschen, wenn inzwischen nichts anderes hineinkam. Der
 * Vergleich war richtig gedacht; das Zurücklesen konnte nie laufen:
 *
 *   · In der App fragt Chromium `clipboard-read` an, und electron/main.ts
 *     lehnt alles außer Ton ab.
 *   · Chromium verweigert das Lesen ohne Fokus im Dokument — und der Sinn
 *     des Kopierens ist, dass die Person inzwischen woanders einfügt.
 *   · Der Aufruf steckt in einem Timer, hat also keine Nutzerhandlung im
 *     Rücken.
 *
 * Jede Hürde für sich genügt. Der Fehlschlag landete in einem leeren
 * `catch`: Kopieren klappte, Aufräumen nie, gemeldet wurde nichts. Das
 * Passwort blieb in der Ablage liegen — für jedes Verlaufsprogramm, für die
 * geräteübergreifende Zwischenablage auf einem Mac und für die eigene
 * Fernsteuerungsbrücke, die die Ablage zweimal je Sekunde abfragt.
 *
 * ZWEI TEILE
 *
 *   TEIL 1 lädt die ECHTE packages/desktop/src/lib/passwoerter.ts in Node
 *   (nur ihre Nachbarn mit Seiteneffekten sind auf Leerlauf umgeleitet,
 *   dieselbe Machart wie notiz-kontoschluessel-pruefen.mjs, Teil 2) und
 *   lässt sie gegen eine nachgebaute Ablage arbeiten. `navigator.clipboard`
 *   ist dabei ABSICHTLICH eine Attrappe, deren `readText()` immer ablehnt —
 *   genau wie das echte Chromium in dieser Lage. Wer den alten Weg
 *   wiederherstellt, sieht es hier sofort.
 *
 *   TEIL 2 prüft statisch, dass der Weg über den Hauptprozess auch wirklich
 *   angelegt ist (electron/main.ts, electron/preload.ts) — und dass
 *   `clipboard-read` dort weiterhin ABGELEHNT wird. Ein Prüflauf in Node
 *   kann keine Electron-IPC-Brücke starten; was er statt dessen NICHT sieht,
 *   steht am Ende dieses Laufs ausdrücklich als Liste.
 *
 * NIE EIN ECHTER WERT: dieser Lauf arbeitet mit einer erfundenen
 * Zeichenkette und druckt sie an keiner Stelle — auch nicht bei einem
 * Fehlschlag. Dieselbe Regel wie in pruefungen/passwort-tresor.mts.
 *
 * Aufruf:  node scripts/passwort-ablage-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopPaket = path.join(wurzel, 'packages/desktop');
let fehlerGesamt = 0;

/* ── Teil 1: die ausgelieferte lib/passwoerter.ts gegen eine Attrappe ─── */

console.log('\n\x1b[1mTeil 1 — kopierenUndLoeschen() gegen eine nachgebaute Ablage\x1b[0m');

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-passwort-ablage-'));
try {
  fs.writeFileSync(path.join(ordner, 'benachrichtigung-stub.mjs'),
    `export const erlaubnisStand = () => 'default';
export function pushAbonnieren() {}
export function titelZaehler() {}
export function vapidSchluesselSetzen() {}
export function zeigen() {}
`);
  fs.writeFileSync(path.join(ordner, 'kern-stub.mjs'),
    `export function translate(_l, key) { return key; }
export function spracheDesSystems() { return 'de'; }
export function dokumentSpracheSetzen() {}
`);
  fs.writeFileSync(path.join(ordner, 'verkauf-stub.mjs'),
    `export const useVerkaufMeldungenUi = { getState: () => ({ zuruecksetzen() {} }), setState() {} };
`);
  fs.writeFileSync(path.join(ordner, 'api-stub.mjs'),
    `export class ApiError extends Error {}
export const serverUrl = () => 'http://127.0.0.1:0';
export const wsUrl = () => 'ws://127.0.0.1:0';
export const token = () => null;
export const setToken = () => {};
export const dateiUrl = () => '';
/* Keine Tresor-Route wird in diesem Lauf gerufen — kopierenUndLoeschen()
   spricht mit niemandem außer der Zwischenablage. */
export const api = new Proxy({}, { get: () => async () => { throw new Error('keine Route in dieser Probe'); } });
`);
  fs.writeFileSync(path.join(ordner, 'loader-hook.mjs'),
    `const KARTE = {
  '/lib/benachrichtigung': new URL('./benachrichtigung-stub.mjs', import.meta.url).href,
  '/i18n/kern': new URL('./kern-stub.mjs', import.meta.url).href,
  '/verkaufMeldungen': new URL('./verkauf-stub.mjs', import.meta.url).href,
  '/net/api': new URL('./api-stub.mjs', import.meta.url).href,
};
export async function resolve(specifier, context, nextResolve) {
  const ohneEndung = specifier.replace(/\\.(ts|js|mts|mjs)$/, '');
  for (const [leiden, ziel] of Object.entries(KARTE)) {
    if (ohneEndung.endsWith(leiden)) return { url: ziel, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.endsWith('/packages/desktop/src/state/store.ts')) {
    const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    return { ...result, source: src.replace('import.meta.env', 'globalThis') };
  }
  return result;
}
`);
  fs.writeFileSync(path.join(ordner, 'register-hook.mjs'),
    `import { register } from 'node:module';
register('./loader-hook.mjs', import.meta.url);
`);

  const pfad = (rel) => JSON.stringify(`file://${path.join(desktopPaket, rel).replace(/\\/g, '/')}`);

  const probe = `
const ablageSpeicher = new Map();
globalThis.localStorage = {
  getItem: (k) => (ablageSpeicher.has(k) ? ablageSpeicher.get(k) : null),
  setItem: (k, v) => ablageSpeicher.set(k, String(v)),
  removeItem: (k) => ablageSpeicher.delete(k),
};
globalThis.window = globalThis;
globalThis.DEV = false;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.document = { addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {} } };
class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = FakeWS.CONNECTING;
  send() {} close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
}
globalThis.WebSocket = FakeWS;

/* DIE SYSTEM-ABLAGE, nachgebaut. Nur diese eine Variable sagt am Ende, ob
   das Passwort noch irgendwo liegt. */
let systemAblage = '';

/* navigator.clipboard — die Attrappe, die sich verhält wie das echte
   Chromium in genau der Lage, um die es geht: schreiben geht, LESEN NICHT.
   Genau daran scheiterte die alte Fassung still. */
let readTextVersuche = 0;
/* defineProperty statt schlichter Zuweisung: seit Node 21 ist
   globalThis.navigator ein Nur-Lese-Zugriff. */
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      writeText: async (v) => { systemAblage = v; },
      readText: async () => {
        readTextVersuche += 1;
        throw new Error('NotAllowedError: Read permission denied.');
      },
    },
  },
});

/* Die Brücke zum Hauptprozess, nachgebaut — sie kennt weder Berechtigung
   noch Fokus, genau wie das Original. */
let bruecke = null;
const brueckeEchte = {
  aufrufe: [],
  schreibenAntwort: true,
  leerenWirft: false,
  schreiben: async (v) => {
    brueckeEchte.aufrufe.push('schreiben');
    if (!brueckeEchte.schreibenAntwort) return false;
    systemAblage = v;
    return true;
  },
  leerenWennUnveraendert: async (v) => {
    brueckeEchte.aufrufe.push('leeren');
    if (brueckeEchte.leerenWirft) throw new Error('Brücke antwortet nicht');
    if (systemAblage !== v) return true;
    systemAblage = '';
    return true;
  },
};
Object.defineProperty(globalThis, 'stellium', { get: () => (bruecke ? { ablage: bruecke } : undefined), configurable: true });

await import(${pfad('src/state/store.ts')});
await import(${pfad('src/net/socket.ts')});
const echt = await import(${pfad('src/lib/passwoerter.ts')});

let fehler = 0;
const pruefWahr = (name, ist) => {
  if (!ist) fehler++;
  console.log(\`  \${ist ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\`);
};
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

/* Ein erfundener Wert. Er wird an keiner Stelle gedruckt — verglichen wird
   immer zu einem Wahrheitswert, nie als Istwert ausgegeben. */
const WERT = 'probe-wert-ohne-bedeutung-1';
const ANDERES = 'irgendetwas-anderes-2';

/* ── 1. Mit Brücke: der Wert verschwindet wirklich wieder ── */
bruecke = brueckeEchte;
pruefWahr('ablageLoeschbar() ist wahr, solange die Brücke da ist', echt.ablageLoeschbar() === true);

brueckeEchte.aufrufe.length = 0;
let gemeldet = 0;
let selbstloeschend = await echt.kopierenUndLoeschen(WERT, () => { gemeldet += 1; }, 20);
pruefWahr('kopierenUndLoeschen() sagt zu: es wird von selbst geleert', selbstloeschend === true);
pruefWahr('… der Wert liegt danach in der Ablage', systemAblage === WERT);
pruefWahr('… und er ging über die Brücke, nicht über navigator.clipboard', brueckeEchte.aufrufe[0] === 'schreiben');
await warte(80);
pruefWahr('NACH DER FRIST IST DIE ABLAGE LEER — das ist die Zeile, die vorher nie grün war', systemAblage === '');
pruefWahr('… und dafür wurde die Brücke gefragt, nicht navigator.clipboard.readText()', brueckeEchte.aufrufe.includes('leeren'));
pruefWahr('… navigator.clipboard.readText() wurde kein einziges Mal versucht (es könnte nur scheitern)', readTextVersuche === 0);
pruefWahr('… und es gab nichts zu melden', gemeldet === 0);

/* ── 2. Der Vergleich bleibt: was jemand DANACH kopiert, bleibt liegen ── */
brueckeEchte.aufrufe.length = 0;
await echt.kopierenUndLoeschen(WERT, undefined, 20);
systemAblage = ANDERES; // die Person kopiert zwischendurch etwas anderes
await warte(80);
pruefWahr('Wurde zwischenzeitlich etwas anderes kopiert, bleibt DAS stehen — der Tresor reißt es nicht weg', systemAblage === ANDERES);
systemAblage = '';

/* ── 3. Scheitert das Leeren, bleibt es NICHT still ── */
brueckeEchte.leerenWirft = true;
gemeldet = 0;
await echt.kopierenUndLoeschen(WERT, () => { gemeldet += 1; }, 20);
await warte(80);
pruefWahr('Scheitert das Leeren, wird es gemeldet statt verschluckt', gemeldet === 1);
brueckeEchte.leerenWirft = false;
systemAblage = '';

/* ── 4. Scheitert schon das Schreiben, wirft es — "kopiert!" wäre gelogen ── */
brueckeEchte.schreibenAntwort = false;
let geworfen = false;
try { await echt.kopierenUndLoeschen(WERT, undefined, 20); } catch { geworfen = true; }
pruefWahr('Scheitert das Schreiben, wirft kopierenUndLoeschen() — die Tafel kann es melden', geworfen);
brueckeEchte.schreibenAntwort = true;
systemAblage = '';

/* ── 5. Ohne Brücke (Browser): kopieren ja, Selbstlöschung ehrlich nein ── */
bruecke = null;
pruefWahr('ablageLoeschbar() ist falsch, sobald die Brücke fehlt (Browser, ältere App)', echt.ablageLoeschbar() === false);
selbstloeschend = await echt.kopierenUndLoeschen(WERT, undefined, 20);
pruefWahr('Im Browser wird kopiert — verweigern hieße, dass jemand abtippt', systemAblage === WERT);
pruefWahr('… aber die Selbstlöschung wird NICHT behauptet (Rückgabe false)', selbstloeschend === false);
await warte(80);
pruefWahr('… und es wird auch nicht heimlich doch versucht, per readText() zu lesen', readTextVersuche === 0);
systemAblage = '';

console.log(fehler ? \`\\x1b[31m\${fehler} fehlgeschlagen\\x1b[0m\` : '\\x1b[32mok\\x1b[0m');
process.exit(fehler ? 1 : 0);
`;
  fs.writeFileSync(path.join(ordner, 'probe.mts'), probe);

  try {
    execFileSync(
      'node',
      ['--import', path.join(ordner, 'register-hook.mjs'), '--import', 'tsx', path.join(ordner, 'probe.mts')],
      { cwd: desktopPaket, stdio: 'inherit' },
    );
  } catch {
    fehlerGesamt += 1;
  }
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}

/* ── Teil 2: der Weg über den Hauptprozess ist angelegt ───────────────── */

console.log('\n\x1b[1mTeil 2 — Hauptprozess und Brücke (statisch)\x1b[0m');

let fehler2 = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) { fehler2 += 1; }
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ist=${JSON.stringify(ist)} soll=${JSON.stringify(soll)}`}`);
};

const mainText = fs.readFileSync(path.join(desktopPaket, 'electron/main.ts'), 'utf8');
const preloadText = fs.readFileSync(path.join(desktopPaket, 'electron/preload.ts'), 'utf8');

pruef("main.ts holt sich Electrons `clipboard`", /import \{[^}]*\bclipboard\b[^}]*\} from 'electron'/.test(mainText), true);
pruef("main.ts behandelt 'ablage:schreiben'", mainText.includes("ipcMain.handle('ablage:schreiben'"), true);
pruef("main.ts behandelt 'ablage:leerenWennUnveraendert'", mainText.includes("ipcMain.handle('ablage:leerenWennUnveraendert'"), true);
pruef('… und vergleicht dort, bevor es leert (der Vergleich ist der Sinn der Sache)',
  /clipboard\.readText\(\) !== wert/.test(mainText), true);
pruef('… und leert mit clipboard.clear(), nicht mit einem leeren String',
  /clipboard\.clear\(\)/.test(mainText), true);

// Die Brücke darf KEIN blankes Lesen anbieten: sonst könnte die Ansicht (und
// alles, was je in sie hineingerät) die Ablage des ganzen Rechners auslesen.
pruef('preload.ts reicht `ablage.schreiben` durch', /schreiben:\s*\(wert: string\)/.test(preloadText), true);
pruef('preload.ts reicht `ablage.leerenWennUnveraendert` durch', preloadText.includes('leerenWennUnveraendert'), true);
pruef('preload.ts bietet KEIN blankes Lesen der Zwischenablage an',
  !/ablage:(lesen|readText)/.test(preloadText) && !/readText/.test(preloadText), true);

// Und die Berechtigung bleibt zu. Ein späteres "wir lassen clipboard-read
// doch durch" würde den Umweg überflüssig aussehen lassen und wäre trotzdem
// falsch — hier fällt es auf.
pruef('main.ts erlaubt weiterhin NUR Ton in setPermissionRequestHandler (clipboard-read bleibt abgelehnt)',
  /setPermissionRequestHandler/.test(mainText) && /permission === 'media'/.test(mainText)
  && !/permission === 'clipboard-read'/.test(mainText), true);

// Die Tafel: kein `void`-Aufruf ohne Auffangnetz, und der Hinweis am Feld
// wechselt, wenn nicht geleert werden kann.
const panelPfad = path.join(desktopPaket, 'src/components/PasswortPanel.tsx');
const panelText = fs.readFileSync(panelPfad, 'utf8');
const panelQuelle = ts.createSourceFile(panelPfad, panelText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

let kopierenPasswortHatCatch = false;
const findeKopieren = (n) => {
  if (kopierenPasswortHatCatch) return;
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'kopierenPasswort' && n.initializer) {
    let gefunden = false;
    const suche = (m) => { if (ts.isTryStatement(m) && m.catchClause) gefunden = true; ts.forEachChild(m, suche); };
    suche(n.initializer);
    kopierenPasswortHatCatch = gefunden;
    return;
  }
  ts.forEachChild(n, findeKopieren);
};
findeKopieren(panelQuelle);
pruef('PasswortPanel.kopierenPasswort() fängt seinen Fehlschlag ab (es wird als `void …()` gerufen)',
  kopierenPasswortHatCatch, true);
pruef('… und der Hinweis am Feld sagt es, wenn nicht geleert werden kann',
  panelText.includes('passwort.kopierenHinweisOhneLoeschung'), true);
pruef('… und beim Kopieren kommt dann zusätzlich eine Meldung',
  panelText.includes('passwort.ablageBleibtTitel'), true);
pruef('… und ein späterer Fehlschlag beim Leeren wird ebenfalls gemeldet',
  panelText.includes('passwort.ablageNichtGeleertTitel'), true);

/* Dieselbe Familie von Defekt, andere Stelle: die Tafel darf nichts als
   erledigt zeigen, was der Server abgelehnt hat. `loeschen()` entfernte den
   Eintrag aus der Liste NACH dem try/catch — ein geteiltes Mitglied drückte
   auf den Papierkorb, bekam "Nur die besitzende Person löscht einen
   Tresoreintrag" und sah den Eintrag trotzdem verschwinden. Geprüft wird am
   Syntaxbaum, ob das Entfernen INNERHALB des try-Blocks steht. */
let entfernenImTry = null;
const findeLoeschen = (n) => {
  if (entfernenImTry !== null) return;
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'loeschen' && n.initializer) {
    let imTry = false;
    let ueberhaupt = false;
    const suche = (m, drin) => {
      if (ts.isCallExpression(m) && m.expression.getText(panelQuelle) === 'setEintraege') {
        ueberhaupt = true;
        if (drin) imTry = true;
      }
      ts.forEachChild(m, (k) => suche(k, drin || (ts.isTryStatement(m) && k === m.tryBlock)));
    };
    suche(n.initializer, false);
    entfernenImTry = ueberhaupt && imTry;
    return;
  }
  ts.forEachChild(n, findeLoeschen);
};
findeLoeschen(panelQuelle);
pruef('PasswortPanel.loeschen() nimmt den Eintrag erst aus der Liste, wenn der Server ihn wirklich gelöscht hat',
  entfernenImTry, true);

// Und der Papierkorb selbst: ein Knopf, der zuverlässig in eine
// Fehlermeldung führt, ist kein Angebot.
let papierkorbGeschuetzt = false;
const findePapierkorb = (n) => {
  if (papierkorbGeschuetzt) return;
  if (ts.isJsxExpression(n) && n.expression && ts.isBinaryExpression(n.expression)
      && n.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && n.expression.left.getText(panelQuelle) === 'darfVerwalten'
      && /onLoeschenAnfragen/.test(n.expression.right.getText(panelQuelle))) {
    papierkorbGeschuetzt = true;
    return;
  }
  ts.forEachChild(n, findePapierkorb);
};
findePapierkorb(panelQuelle);
pruef('… und der Papierkorb steht nur der besitzenden Person zur Verfügung (darfVerwalten)',
  papierkorbGeschuetzt, true);

if (fehler2) fehlerGesamt += 1;

/* ── Was dieser Lauf AUSDRÜCKLICH NICHT prüft ─────────────────────────── */

console.log(`
\x1b[1mWas hier NICHT geprüft ist — und ohne Browser auch nicht geprüft werden kann:\x1b[0m
  · Ob Electrons \`clipboard.readText()/clear()\` im Hauptprozess auf macOS,
    Windows und Linux tatsächlich das tun, was ihre Dokumentation sagt. Teil 2
    stellt nur fest, DASS sie gerufen werden.
  · Ob die IPC-Brücke im gebauten Programm wirklich ankommt (contextBridge,
    Sandbox, Signatur). Dafür braucht es einen echten Electron-Start.
  · Chromiums tatsächliches Verhalten bei \`readText()\` ohne Fokus, ohne
    Nutzerhandlung und ohne Berechtigung. Teil 1 baut es NACH — die Attrappe
    lehnt immer ab —, misst es aber nicht.
  · Safari (verlangt eine Geste) und Firefox (gibt \`readText()\` an Webseiten
    gar nicht heraus). Genau deshalb behauptet der Browser-Zweig die
    Selbstlöschung nicht, sondern sagt sie ab.
  · Ob die geräteübergreifende Zwischenablage eines Macs den Wert schon auf
    ein anderes Gerät getragen hat, bevor die Frist abläuft. Dagegen hilft
    kein Prüflauf, nur die kurze Frist.
`);

console.log(fehlerGesamt
  ? `\x1b[31m${fehlerGesamt} Teil(e) fehlgeschlagen\x1b[0m\n`
  : '\x1b[32mDas kopierte Passwort verschwindet wieder aus der Zwischenablage — und wo es das nicht kann, wird es gesagt statt verschwiegen.\x1b[0m\n');
process.exit(fehlerGesamt ? 1 : 0);
