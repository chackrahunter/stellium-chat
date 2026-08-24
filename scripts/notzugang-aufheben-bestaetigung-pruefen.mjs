#!/usr/bin/env node
/**
 * Prüft, dass „Notzugang aufheben" — in BEIDEN Tafeln, die den Knopf zeigen —
 * kein einziger, folgenloser Klick mehr ist.
 *
 * ZWEI TAFELN, ZWEI VERSCHIEDENE RÜCKFRAGEN
 *
 *   NotzugangPanel.tsx (SELBSTBEDIENUNG, am EIGENEN Konto): die Rückfrage
 *   erscheint GENAU DANN, wenn `stand.notzugangWartet` — vorher tat das
 *   erst der nächste gewöhnliche Zurücksetzvorgang.
 *
 *   TeamAdmin.tsx (VERWALTUNG, an einem FREMDEN Konto): die Rückfrage
 *   erscheint IMMER, mit einem von zwei Sätzen, je nachdem, ob
 *   `person.notzugangAufhebenVerbrennt` — derselbe Knopf bedeutete vorher in
 *   beiden Zuständen dasselbe: einen stillen Klick mit demselben festen
 *   Erfolgstext, obwohl er im einen Zustand nur eine künftige Absicherung
 *   kappt und im anderen Notizen und Passwort-Tresor sofort und endgültig
 *   löscht.
 *
 * Rein strukturell (Syntaxbaum + Text), kein React/DOM-Rendern nötig —
 * dasselbe Muster wie scripts/fangkorb-ausweg-pruefen.mjs und
 * scripts/icon-knoepfe-pruefen.mjs.
 *
 * WAS DIESE PRÜFUNG BELEGT
 *   1. packages/shared/src/vertraulich.ts: `NotzugangStand` trägt das Feld
 *      `notzugangWartet: boolean`, mit dem die Selbstbedienungs-Tafel den
 *      Zustand überhaupt erst kennt.
 *   2. packages/server/src/http/routes.ts: Der Wert kommt aus
 *      `kontoschluessel.notzugangWartet(userId)` — DERSELBEN Rechnung wie bei
 *      GET /api/konto/schluessel — und nicht aus einer zweiten, eigenen
 *      Formel, die mit der Zeit von ihr abweichen könnte.
 *   3. packages/desktop/src/components/NotzugangPanel.tsx:
 *      a) Es gibt eine benannte Funktion `aufhebenKlick`, die VOR dem
 *         eigentlichen Aufheben `window.confirm(...)` aufruft, GENAU DANN
 *         wenn `stand?.notzugangWartet` wahr ist, und bei einer Absage
 *         (`return`) den Vorgang abbricht, OHNE `aufheben()` je zu rufen.
 *      b) GENAU EIN `<button>` im Baum trägt die Beschriftung
 *         `t('notzugang.aufheben')` — nicht nur "mindestens einer, und der
 *         erste gefundene hängt richtig": jeder gefundene Knopf mit dieser
 *         Beschriftung wird eingesammelt, nicht nur der erste, und die
 *         Prüfung schlägt fehl, wenn es mehr als einen gibt. Dieser eine
 *         Knopf ist an `aufhebenKlick` verdrahtet — NICHT direkt an
 *         `aufheben()`.
 *      c) Der in `window.confirm(...)` verwendete Übersetzungsschlüssel
 *         existiert im deutschen Wörterbuch UND sein Text benennt den
 *         tatsächlichen Verlust — „Notizen" UND „Tresor" UND eines von
 *         „endgültig" / „kein Zurück" / „keine Rückkehr" / „unwiderruflich".
 *         Ein generisches „Wirklich sicher?" ohne diese Wörter fällt durch.
 *      d) Im GANZEN Syntaxbaum kommt der bloße Aufruf `aufheben()` (das
 *         lokale, verpackte `aufheben`, nicht `notzugang.aufheben` aus
 *         lib/notzugang.ts) genau EINMAL vor — und dieses eine Mal steht
 *         innerhalb von `aufhebenKlick`. Ein zweiter Knopf mit anderer
 *         Beschriftung, der `aufheben()` direkt riefe, läge damit offen:
 *         entweder die Gesamtzahl der Aufrufe stiege auf zwei, oder der
 *         einzige Aufruf läge außerhalb von `aufhebenKlick` — beides lässt
 *         die Prüfung fehlschlagen.
 *   4. packages/desktop/src/components/TeamAdmin.tsx:
 *      a) Es gibt eine benannte Funktion `notzugangAufhebenKlick`, die IMMER
 *         `window.confirm(...)` aufruft (nicht an eine Bedingung gebunden —
 *         anders als in NotzugangPanel.tsx, siehe Dateikopf dort) und bei
 *         einer Absage abbricht, ohne den API-Aufruf je zu erreichen.
 *      b) GENAU EIN `<button>` trägt die Beschriftung `t('notzugang.aufheben')`
 *         und ist an `notzugangAufhebenKlick` verdrahtet — nicht direkt an
 *         `api.notzugangAufhebenFuer`.
 *      c) `notzugangAufhebenKlick` verwendet ZWEI VERSCHIEDENE
 *         Übersetzungsschlüssel für die Rückfrage, ausgewählt über
 *         `notzugangAufhebenVerbrennt` — nicht denselben Satz für beide
 *         Zustände. Der Schlüssel für den brennenden Zustand existiert im
 *         deutschen Wörterbuch und sein Text benennt „Notizen", „Tresor" und
 *         die Endgültigkeit, genau wie in NotzugangPanel.tsx.
 *      d) Im GANZEN Syntaxbaum kommt `api.notzugangAufhebenFuer(` genau
 *         EINMAL vor — und dieses eine Mal steht innerhalb von
 *         `notzugangAufhebenKlick`.
 *
 * WAS SIE NICHT BELEGT
 *   · Dass `window.confirm` beim echten Klick im Browser tatsächlich
 *     erscheint (kein Rendern, kein DOM) — nur, dass der Aufruf im
 *     Kontrollfluss VOR dem zerstörenden API-Aufruf steht.
 *   · Dass `stand.notzugangWartet` bzw. `notzugangAufhebenVerbrennt` zur
 *     Laufzeit den richtigen Wert tragen — das prüft
 *     scripts/notzugang-pruefen.mjs (die Rechnung selbst) bzw. ist
 *     serverseitig durch den fail-closed-Vergleich in
 *     services/kontoschluessel.ts / services/notzugang.ts abgesichert, nicht
 *     durch dieses Skript.
 *   · Dass ein Knopf mit EINER ANDEREN Beschriftung nicht doch irgendwo im
 *     Baum `aufheben()` bzw. `api.notzugangAufhebenFuer(` aufruft, OHNE
 *     `aufhebenKlick`/`notzugangAufhebenKlick` zu heißen — das deckt Punkt
 *     3d/4d ab (die GESAMTZAHL der Aufrufe im Syntaxbaum, nicht nur die am
 *     benannten Knopf), aber nicht einen Aufruf, der außerhalb dieser Datei
 *     liegt (ein Test, eine Konsole, ein künftiger Refactor, der die
 *     Funktion exportiert).
 *   · Die Übersetzungen der anderen 21 Sprachen — es liest ausdrücklich nur
 *     das deutsche Wörterbuch. Vollständigkeit UND Registerfragen prüfen
 *     scripts/sprachen-vollstaendig.mjs und
 *     scripts/woerterbuecher-stimmigkeit-pruefen.mjs.
 *
 * Aufruf:  node scripts/notzugang-aufheben-bestaetigung-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedPfad = path.join(wurzel, 'packages/shared/src/vertraulich.ts');
const routesPfad = path.join(wurzel, 'packages/server/src/http/routes.ts');
const panelPfad = path.join(wurzel, 'packages/desktop/src/components/NotzugangPanel.tsx');
const adminPfad = path.join(wurzel, 'packages/desktop/src/components/TeamAdmin.tsx');
const dePfad = path.join(wurzel, 'packages/desktop/src/i18n/de.ts');

let fehler = 0;
const pruef = (name, ist, soll = true) => {
  const ok = ist === soll;
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ist=${JSON.stringify(ist)}`}`);
};

function parse(pfad, art) {
  return ts.createSourceFile(pfad, fs.readFileSync(pfad, 'utf8'), ts.ScriptTarget.Latest, true, art);
}

const deText = fs.readFileSync(dePfad, 'utf8');
function deWert(schluessel) {
  const zeile = new RegExp(`'${schluessel.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`);
  const treffer = deText.match(zeile);
  return treffer ? treffer[1] : null;
}
function prueveEndgueltigkeitsText(bezeichnung, schluessel) {
  console.log(`\n${bezeichnung}, deutscher Text (${schluessel ?? '—'}):`);
  if (!schluessel) {
    console.log('  \x1b[31m✗\x1b[0m übersprungen — kein Schlüssel gefunden');
    fehler++;
    return;
  }
  const wert = deWert(schluessel);
  pruef(`Schlüssel ${schluessel} existiert im deutschen Wörterbuch`, Boolean(wert));
  if (wert) {
    const klein = wert.toLowerCase();
    pruef('der Text nennt „Notizen"', klein.includes('notizen'));
    pruef('der Text nennt „Tresor"', klein.includes('tresor'));
    pruef('der Text nennt die Endgültigkeit (endgültig / kein Zurück / keine Rückkehr / unwiderruflich)',
      /endgültig|kein zurück|keine rückkehr|unwiderruflich/.test(klein));
  }
}

/* ── 1: NotzugangStand trägt notzugangWartet ─────────────────────────── */

console.log('\nshared/vertraulich.ts:');
const sharedQuelle = parse(sharedPfad, ts.ScriptKind.TS);
let standHatFeld = false;
const findeStand = (n) => {
  if (standHatFeld) return;
  if (ts.isInterfaceDeclaration(n) && n.name.text === 'NotzugangStand') {
    standHatFeld = n.members.some((m) => (
      m.name?.getText(sharedQuelle) === 'notzugangWartet'
      && ts.isPropertySignature(m) && m.type?.getText(sharedQuelle) === 'boolean'
    ));
    return;
  }
  ts.forEachChild(n, findeStand);
};
findeStand(sharedQuelle);
pruef('NotzugangStand trägt `notzugangWartet: boolean`', standHatFeld);

/* ── 2: Der Server rechnet nicht zweimal ─────────────────────────────── */

console.log('\nserver/http/routes.ts:');
const routesText = fs.readFileSync(routesPfad, 'utf8');
pruef(
  'die Notzugang-Auskunft übernimmt notzugangWartet von kontoschluessel.notzugangWartet(userId) '
  + '(dieselbe Rechnung wie GET /api/konto/schluessel, keine zweite)',
  /notzugangWartet:\s*kontoschluessel\.notzugangWartet\(userId\)/.test(routesText),
);

/* ── 3: Das Selbstbedienungs-Panel ────────────────────────────────────── */

console.log('\ndesktop/components/NotzugangPanel.tsx:');
const panelQuelle = parse(panelPfad, ts.ScriptKind.TSX);

let klickText = null;
let klickNode = null;
const findeKlick = (n) => {
  if (klickText) return;
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'aufhebenKlick' && n.initializer) {
    klickNode = n.initializer;
    klickText = n.initializer.getText(panelQuelle);
    return;
  }
  ts.forEachChild(n, findeKlick);
};
findeKlick(panelQuelle);

pruef('aufhebenKlick() wurde gefunden', Boolean(klickText));

let bestaetigungsSchluessel = null;
if (klickText) {
  pruef('aufhebenKlick() ruft window.confirm(...) auf', klickText.includes('window.confirm('));
  pruef('die Rückfrage hängt an stand?.notzugangWartet bzw. stand.notzugangWartet',
    /stand\??\.notzugangWartet/.test(klickText));
  // Die Absage darf den Vorgang nicht bloß melden, sondern MUSS ihn beenden:
  // ein `if (bedingung && !window.confirm(...)) return;` in einer Zeile, oder
  // gleichwertig über zwei Anweisungen. Geprüft wird die enge Form, die auch
  // tatsächlich im Code steht — kein allgemeines "irgendwo return".
  pruef('eine Absage der Rückfrage bricht sofort ab (`!window.confirm(...)) return;`)',
    /!window\.confirm\([^;]*\)\)\s*return;/.test(klickText));
  pruef('aufhebenKlick() ruft am Ende trotzdem aufheben() auf (kein toter Pfad)',
    /\baufheben\(\)/.test(klickText));

  const schluesselMatch = klickText.match(/window\.confirm\(\s*t\(\s*'([^']+)'/);
  bestaetigungsSchluessel = schluesselMatch ? schluesselMatch[1] : null;
  pruef('die Rückfrage kommt aus einem Wörterbuchschlüssel, nicht aus festem Text',
    Boolean(bestaetigungsSchluessel));
}

/* Der Knopf mit der Beschriftung t('notzugang.aufheben') — ALLE Treffer
   einsammeln, nicht nur den ersten. Ein zweiter Knopf mit derselben
   Beschriftung, der die Rückfrage umgeht, oder ein zweiter, nach dem ersten
   liegender Treffer, den ein früherer Kurzschluss verdeckt hätte, fällt
   damit auf — nicht nur strukturell "gibt es einen passenden Knopf". */
const panelKnoepfe = [];
const findeKnoepfe = (n) => {
  if (ts.isJsxElement(n)) {
    const tag = n.openingElement.tagName.getText(panelQuelle);
    if (tag === 'button') {
      const kinderText = n.children.map((k) => k.getText(panelQuelle)).join('');
      if (kinderText.includes("t('notzugang.aufheben')")) {
        const attr = n.openingElement.attributes.properties.find(
          (p) => p.name?.getText(panelQuelle) === 'onClick',
        );
        panelKnoepfe.push(attr ? attr.getText(panelQuelle) : '');
      }
    }
  }
  ts.forEachChild(n, findeKnoepfe);
};
findeKnoepfe(panelQuelle);

pruef('genau EIN Knopf „Notzugang aufheben" existiert (nicht null, nicht mehrere)', panelKnoepfe.length, 1);
const panelKnopfOnClick = panelKnoepfe.length === 1 ? panelKnoepfe[0] : null;
if (panelKnopfOnClick !== null) {
  pruef('sein onClick verdrahtet an aufhebenKlick (nicht direkt an aufheben())',
    /\baufhebenKlick\b/.test(panelKnopfOnClick) && !/\baufheben\(\)/.test(panelKnopfOnClick));
}

/* Die Gesamtzahl der bloßen Aufrufe `aufheben()` im ganzen SYNTAXBAUM (nicht
   im Text — Kommentare erwähnen `aufheben()` viele Male, ein Textzähler
   fände dort lauter falsche Treffer): genau einer, und der muss der in
   aufhebenKlick() sein. Ein zweiter Knopf mit ANDERER Beschriftung (fiele
   bei den Knöpfen oben nicht auf, weil dort nur nach der Beschriftung
   „Notzugang aufheben" gesucht wird), der `aufheben()` direkt riefe, triebe
   diese Zahl auf zwei — oder läge, wenn er der einzige Aufrufer wäre,
   außerhalb von aufhebenKlick(). Gesucht wird der bloße Aufruf des LOKALEN,
   verpackten `aufheben` (ein Identifier), nicht `notzugang.aufheben(...)`
   aus lib/notzugang.ts (ein Property-Zugriff, trifft dieses Muster nicht). */
const panelAufhebenAufrufe = [];
const findePanelAufrufe = (n) => {
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'aufheben') {
    panelAufhebenAufrufe.push(n);
  }
  ts.forEachChild(n, findePanelAufrufe);
};
findePanelAufrufe(panelQuelle);
pruef('`aufheben()` wird im ganzen Syntaxbaum genau einmal aufgerufen', panelAufhebenAufrufe.length, 1);
if (klickNode) {
  const innerhalb = panelAufhebenAufrufe.length === 1
    && panelAufhebenAufrufe[0].pos >= klickNode.pos && panelAufhebenAufrufe[0].end <= klickNode.end;
  pruef('… und dieser eine Aufruf steht innerhalb von aufhebenKlick()', innerhalb);
}

prueveEndgueltigkeitsText('NotzugangPanel.tsx', bestaetigungsSchluessel);

/* ── 4: Die Verwaltung (TeamAdmin.tsx) ────────────────────────────────── */

console.log('\ndesktop/components/TeamAdmin.tsx:');
const adminQuelle = parse(adminPfad, ts.ScriptKind.TSX);

let adminKlickText = null;
let adminKlickNode = null;
const findeAdminKlick = (n) => {
  if (adminKlickText) return;
  if (
    ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)
    && n.name.text === 'notzugangAufhebenKlick' && n.initializer
  ) {
    adminKlickNode = n.initializer;
    adminKlickText = n.initializer.getText(adminQuelle);
    return;
  }
  ts.forEachChild(n, findeAdminKlick);
};
findeAdminKlick(adminQuelle);

pruef('notzugangAufhebenKlick() wurde gefunden', Boolean(adminKlickText));

let adminSchluesselSicher = null;
let adminSchluesselVerbrennt = null;
if (adminKlickText) {
  pruef('notzugangAufhebenKlick() ruft window.confirm(...) auf', adminKlickText.includes('window.confirm('));
  pruef('die Rückfrage hängt an notzugangAufhebenVerbrennt (unterscheidet die zwei Zustände)',
    /notzugangAufhebenVerbrennt/.test(adminKlickText));
  pruef('eine Absage der Rückfrage bricht sofort ab (`!window.confirm(...)) return;`)',
    /!window\.confirm\([^;]*\)\)\s*return;/.test(adminKlickText));
  pruef('notzugangAufhebenKlick() ruft am Ende trotzdem api.notzugangAufhebenFuer(...) auf (kein toter Pfad)',
    /api\.notzugangAufhebenFuer\(/.test(adminKlickText));

  const schluessel = [...adminKlickText.matchAll(/t\(\s*'([^']+)'/g)].map((m) => m[1]);
  const eindeutig = [...new Set(schluessel)];
  pruef('für die Rückfrage werden ZWEI VERSCHIEDENE Wörterbuchschlüssel verwendet (nicht derselbe Satz für beide Zustände)',
    eindeutig.filter((s) => s.startsWith('team.notzugangAufheben')).length, 2);

  adminSchluesselVerbrennt = eindeutig.find((s) => /Verbrennt/.test(s)) ?? null;
  adminSchluesselSicher = eindeutig.find((s) => s.startsWith('team.notzugangAufheben') && !/Verbrennt/.test(s)) ?? null;
}

const adminKnoepfe = [];
const findeAdminKnoepfe = (n) => {
  if (ts.isJsxElement(n)) {
    const tag = n.openingElement.tagName.getText(adminQuelle);
    if (tag === 'button') {
      const kinderText = n.children.map((k) => k.getText(adminQuelle)).join('');
      if (kinderText.includes("t('notzugang.aufheben')")) {
        const attr = n.openingElement.attributes.properties.find(
          (p) => p.name?.getText(adminQuelle) === 'onClick',
        );
        adminKnoepfe.push(attr ? attr.getText(adminQuelle) : '');
      }
    }
  }
  ts.forEachChild(n, findeAdminKnoepfe);
};
findeAdminKnoepfe(adminQuelle);

pruef('genau EIN Knopf „Notzugang aufheben" existiert (nicht null, nicht mehrere)', adminKnoepfe.length, 1);
const adminKnopfOnClick = adminKnoepfe.length === 1 ? adminKnoepfe[0] : null;
if (adminKnopfOnClick !== null) {
  pruef('sein onClick verdrahtet an notzugangAufhebenKlick (nicht direkt an api.notzugangAufhebenFuer)',
    /\bnotzugangAufhebenKlick\b/.test(adminKnopfOnClick) && !/api\.notzugangAufhebenFuer\(/.test(adminKnopfOnClick));
}

/* Wie bei aufheben() oben: der SYNTAXBAUM entscheidet, nicht der Text — die
   Dateikopf-Kommentare erwähnen `api.notzugangAufhebenFuer` mehrfach in
   Prosa. */
const adminAufrufe = [];
const findeAdminAufrufe = (n) => {
  if (
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
    && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'api'
    && n.expression.name.text === 'notzugangAufhebenFuer'
  ) {
    adminAufrufe.push(n);
  }
  ts.forEachChild(n, findeAdminAufrufe);
};
findeAdminAufrufe(adminQuelle);
pruef('`api.notzugangAufhebenFuer(` wird im ganzen Syntaxbaum genau einmal aufgerufen', adminAufrufe.length, 1);
if (adminKlickNode) {
  const innerhalb = adminAufrufe.length === 1
    && adminAufrufe[0].pos >= adminKlickNode.pos && adminAufrufe[0].end <= adminKlickNode.end;
  pruef('… und dieser eine Aufruf steht innerhalb von notzugangAufhebenKlick()', innerhalb);
}

prueveEndgueltigkeitsText('TeamAdmin.tsx', adminSchluesselVerbrennt);

console.log(`\nTeamAdmin.tsx, deutscher Text (${adminSchluesselSicher ?? '—'}), der Zustand OHNE Vernichtung:`);
if (!adminSchluesselSicher) {
  console.log('  \x1b[31m✗\x1b[0m übersprungen — kein zweiter Schlüssel gefunden');
  fehler++;
} else {
  const wert = deWert(adminSchluesselSicher);
  pruef(`Schlüssel ${adminSchluesselSicher} existiert im deutschen Wörterbuch`, Boolean(wert));
  pruef('… und ist ein ANDERER Satz als der für den brennenden Zustand',
    Boolean(wert) && wert !== deWert(adminSchluesselVerbrennt ?? ''));
}

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDie Rückfrage vor „Notzugang aufheben" steht in beiden Tafeln, hängt am richtigen Zustand und lässt sich nicht mit einem Klick umgehen.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
