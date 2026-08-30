#!/usr/bin/env node
/**
 * Wächter für die Wächterliste (scripts/waechter-liste.mjs).
 *
 * WARUM ES DEN GEBEN MUSS
 * Die Ableitung entscheidet, WELCHE Wächter überhaupt laufen — beim
 * Ausliefern und beim Berichte-Abarbeiter. Sie war bis zum 29.08. die einzige
 * Stelle im Haus, die selbst unbewacht war. Eine einzige Zeile darin,
 * `.filter((n) => n.length < 28)`, ließ jeden Wächter grün: der Abarbeiter
 * merkte nichts, und ausliefern.mjs fand 27 statt 65 Läufe — über seiner
 * Schwelle von 20, die Auslieferung lief durch. 38 Wächter still weg.
 *
 * Eine Schwelle ist eine Katastrophenbremse. Sie sagt "irgendwas ist kaputt",
 * wenn schon fast alles kaputt ist. Dieser Lauf sagt es beim ERSTEN
 * verlorenen Wächter, weil er die abgeleitete Liste gegen das hält, was
 * tatsächlich im Ordner liegt — und für jede Datei, die NICHT läuft, einen
 * nachweisbaren Grund verlangt.
 *
 *     node scripts/waechter-liste-pruefen.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BESCHREIBUNG, waechterFinden, waechterUebersicht } from './waechter-liste.mjs';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const F = { aus: '\x1b[0m', gruen: '\x1b[32m', rot: '\x1b[31m', grau: '\x1b[90m' };

/**
 * Die erwartete Größenordnung, festgehalten statt geraten.
 *
 * Wächter kommen dazu, sie verschwinden nicht. Fällt diese Zahl, ist entweder
 * die Ableitung kaputt oder jemand hat Wächter gelöscht — beides gehört
 * gesehen und nicht durchgewinkt. Wer hier bewusst herunterzählt, trifft eine
 * Entscheidung; wer eine Filterzeile einbaut, trifft sie versehentlich.
 */
const MINDESTENS = 60;

/*
 * Die Wörter, an denen die Ableitung browsergestützte Läufe erkennt —
 * ZUSAMMENGESETZT und nicht ausgeschrieben.
 *
 * Steht eines davon wörtlich in dieser Datei, wirft die Ableitung DIESEN
 * Wächter hinaus: er läuft nie wieder, und niemand merkt es. Beim ersten
 * Schreiben ist genau das passiert — der Wächter der Wächterliste hat sich
 * selbst stillgelegt, weil er das Wort erwähnte, gegen das er prüft. Der
 * letzte Punkt unten hält fest, dass es nicht wieder passiert.
 */
const BROWSERWORT = new RegExp(['play', 'wright|chrom', 'ium|probe', 'server'].join(''));

let fehler = 0;
function pruefe(name, bedingung, hinweis = '') {
  if (bedingung) { console.log(`  ${F.gruen}✓${F.aus} ${name}`); return; }
  console.log(`  ${F.rot}✗${F.aus} ${name}${hinweis ? `\n      ${F.grau}${hinweis}${F.aus}` : ''}`);
  fehler += 1;
}

/* ── 1. Die Ableitung gegen den Ordner ─────────────────────────── */

console.log('\nAbgeleitete Liste gegen den Ordner');
{
  const { waechter, dateien, uebersprungen } = waechterUebersicht(WURZEL);
  const gelaufen = new Set(waechter.map(([p]) => p.replace(/^scripts\//, '')));
  const uebergangen = new Set(uebersprungen.map(([n]) => n));

  /* Der eigentliche Punkt: JEDE Datei im Ordner ist entweder ein Wächter, der
     läuft, oder eine mit einem Grund. Ein stiller dritter Zustand — weder
     gelaufen noch begründet — ist genau das Loch, das der Namensfilter riss. */
  const verschwunden = dateien.filter((n) => !gelaufen.has(n) && !uebergangen.has(n));
  pruefe('keine Datei fällt still aus der Ableitung',
    verschwunden.length === 0,
    `ohne Grund weggefallen: ${verschwunden.join(', ')}`);

  pruefe('gelaufen + übersprungen = alle Dateien im Ordner',
    waechter.length + uebersprungen.length === dateien.length,
    `${waechter.length} + ${uebersprungen.length} ≠ ${dateien.length}`);

  /* Ein Grund muss stimmen, nicht bloß dastehen: die Datei muss wirklich
     browsergestützt sein. Sonst ließe sich alles mit einem Grund versehen. */
  const ordner = path.join(WURZEL, 'scripts');
  const faule = uebersprungen
    .map(([n]) => n)
    .filter((n) => !BROWSERWORT.test(fs.readFileSync(path.join(ordner, n), 'utf8')));
  pruefe('jeder übersprungene Wächter ist wirklich browsergestützt',
    faule.length === 0, `ohne Beleg übersprungen: ${faule.join(', ')}`);
  console.log(`  ${F.grau}${waechter.length} laufen, ${uebersprungen.length} browsergestützt `
    + `(${uebersprungen.map(([n]) => n).join(', ') || '—'}), ${dateien.length} Dateien im Ordner${F.aus}`);

  pruefe(`die Größenordnung stimmt (mindestens ${MINDESTENS})`,
    waechter.length >= MINDESTENS,
    `nur ${waechter.length} Wächter — Wächter kommen dazu, sie verschwinden nicht. `
    + 'Ist die Ableitung kaputt, oder wurde bewusst gelöscht? Dann diese Zahl bewusst senken.');

  /* Dieser Lauf muss in der Liste stehen, die er prüft. Ein Wächter, der aus
     der eigenen Ableitung fällt, ist ein Wächter, den niemand mehr startet. */
  pruefe('dieser Wächter läuft selbst mit',
    gelaufen.has('waechter-liste-pruefen.mjs'),
    'Steht ein Erkennungswort wörtlich in dieser Datei? Dann hat sie sich selbst stillgelegt.');
  pruefe('der Wächter des Abarbeiters läuft mit',
    gelaufen.has('abarbeiter-pruefen.mjs'),
    'Dieselbe Falle, eine Datei weiter.');

  pruefe('waechterFinden liefert dasselbe wie die Übersicht',
    waechterFinden(WURZEL).map(([p]) => p).join('|') === waechter.map(([p]) => p).join('|'),
    'Zwei Wege, zwei Ergebnisse — dann ist einer davon der falsche.');
}

/* ── 2. Die Ableitung filtert nicht nach dem NAMEN ─────────────── */

console.log('\nKein Namensfilter (gegen einen Wegwerf-Ordner)');
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-waechterliste-'));
try {
  const ordner = path.join(probe, 'scripts');
  fs.mkdirSync(ordner, { recursive: true });
  /* Zwei Namen, ein kurzer und ein absurd langer. Genau daran ist die
     Sabotage `n.length < 20` bzw. `< 28` zu erkennen — und nur daran: die
     echte Liste sähe mit einem Namensfilter immer noch plausibel aus. */
  const kurz = 'a-pruefen.mjs';
  const lang = `${'ein-sehr-langer-name-fuer-einen-waechter'.repeat(2)}-pruefen.mjs`;
  const browser = 'mit-browser-pruefen.mjs';
  fs.writeFileSync(path.join(ordner, kurz), 'process.exit(0);\n');
  fs.writeFileSync(path.join(ordner, lang), 'process.exit(0);\n');
  fs.writeFileSync(path.join(ordner, browser), `// braucht ${BROWSERWORT.source.split('|')[0]}\nprocess.exit(0);\n`);
  fs.writeFileSync(path.join(ordner, 'kein-waechter.mjs'), 'process.exit(0);\n');

  const gefunden = waechterFinden(probe).map(([p]) => p.replace(/^scripts\//, ''));
  pruefe('ein kurzer Name läuft mit', gefunden.includes(kurz));
  pruefe('ein sehr langer Name läuft ebenfalls mit', gefunden.includes(lang),
    `${lang.length} Zeichen — ein Namensfilter würde genau hier zuschlagen. Gefunden: ${gefunden.join(', ')}`);
  pruefe('eine Datei ohne -pruefen.mjs läuft nicht mit', !gefunden.includes('kein-waechter.mjs'));
  pruefe('ein browsergestützter Wächter bleibt draußen', !gefunden.includes(browser));
  pruefe('genau die zwei erwarteten', gefunden.length === 2, `gefunden: ${gefunden.join(', ')}`);
  pruefe('sortiert', gefunden.join('|') === [...gefunden].sort().join('|'));
} finally {
  fs.rmSync(probe, { recursive: true, force: true });
}

/* ── 3. Die Beschreibungen zeigen auf echte Dateien ────────────── */

console.log('\nBeschreibungen');
{
  const ordner = path.join(WURZEL, 'scripts');
  const verwaist = Object.keys(BESCHREIBUNG).filter((n) => !fs.existsSync(path.join(ordner, n)));
  pruefe('keine Beschreibung zeigt ins Leere', verwaist.length === 0,
    `es gibt keine ${verwaist.join(', ')} (mehr) — dann gehört der Eintrag weg.`);
}

console.log(fehler
  ? `\n${F.rot}${fehler} Punkt(e) rot.${F.aus}\n`
  : `\n${F.gruen}Die Wächterliste hält: jede Datei im Ordner läuft oder hat einen `
    + `belegten Grund, und kein Filter geht nach dem Namen.${F.aus}\n`);
process.exit(fehler ? 1 : 0);
