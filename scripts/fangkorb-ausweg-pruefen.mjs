#!/usr/bin/env node
/**
 * Statische Prüfung der beiden Fangkorb-Lücken aus dem Auftrag:
 *
 *   1) `fangkorbSchluessel` (App.tsx) muss `activeChannelId` enthalten —
 *      sonst bleibt die Fehlerkarte für ChannelSettings/PollDialog/
 *      VorfallDialog/FreigabenDialog stehen, wenn nur der Kanal wechselt und
 *      `overlay` gleich bleibt (siehe Kopfkommentar an `fangkorbSchluessel`
 *      selbst für das ausführliche Szenario).
 *   1b) — und die eigentliche Lehre aus beiden: JEDE laden-gestützte Tafel
 *      (`const xOffen = useXUi((s) => s.offen)` in App.tsx) muss in BEIDEN
 *      Listen stehen, im `fangkorbSchluessel` UND in `fangkorbEscape`. Die
 *      Liste wird dazu aus App.tsx abgeleitet statt hier abgeschrieben —
 *      sonst wäre diese Datei die dritte Stelle, die jemand vergessen kann.
 *      Gefunden wurde damit `usePasswortUi` (Passwort-Tresor): im Schlüssel
 *      vorhanden, im Ausweg nicht, Fehlerkarte als Sackgasse über Rail und
 *      Sidebar.
 *   2) Der eingebettete Fangkorb muss einen Ausweg für die
 *      laden-gestützten Tafeln bekommen (`partnerGruppenOffen` und Co.):
 *      `onEscape` an `<Fangkorb eingebettet …>` in App.tsx, UND Fangkorb.tsx
 *      muss diese Eigenschaft tatsächlich als zweiten Knopf rendern — sonst
 *      wäre die Eigenschaft nur angenommen, aber nie ausgewertet.
 *
 * Kein DOM/React-Rendern nötig: beide Fragen sind rein strukturell ("steht
 * das Feld in der Liste?", "gibt es das Attribut und wird es gelesen?") und
 * der Syntaxbaum beantwortet sie ohne die React-Laufzeit anzuwerfen.
 *
 * Aufruf:  node scripts/fangkorb-ausweg-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPfad = path.join(wurzel, 'packages/desktop/src/App.tsx');
const fangkorbPfad = path.join(wurzel, 'packages/desktop/src/components/Fangkorb.tsx');

let fehler = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ist=${JSON.stringify(ist)} soll=${JSON.stringify(soll)}`}`);
};

function parse(pfad, art) {
  return ts.createSourceFile(pfad, fs.readFileSync(pfad, 'utf8'), ts.ScriptTarget.Latest, true, art);
}

/* ── 1: fangkorbSchluessel enthält activeChannelId ───────────────────── */

console.log('\nApp.tsx:');
const appQuelle = parse(appPfad, ts.ScriptKind.TSX);

let schluesselElemente = null;
const findeSchluessel = (n) => {
  if (schluesselElemente) return;
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'fangkorbSchluessel' && n.initializer) {
    // JSON.stringify([ ... ]) — das Array-Literal ist das erste Argument.
    let init = n.initializer;
    if (ts.isCallExpression(init) && init.arguments[0] && ts.isArrayLiteralExpression(init.arguments[0])) {
      schluesselElemente = init.arguments[0].elements.map((e) => e.getText(appQuelle));
    }
    return;
  }
  ts.forEachChild(n, findeSchluessel);
};
findeSchluessel(appQuelle);

pruef('fangkorbSchluessel wurde gefunden', Boolean(schluesselElemente), true);
if (schluesselElemente) {
  pruef('fangkorbSchluessel enthält activeChannelId (sonst überlebt die Fehlerkarte einen Kanalwechsel)',
    schluesselElemente.includes('activeChannelId'), true);
}

/* ── 1b: JEDE laden-gestützte Tafel steht in BEIDEN Listen ───────────────
 *
 * Das ist die Prüfung, die die beiden bisherigen Löcher überhaupt erst
 * unmöglich macht. `fangkorbSchluessel` und `fangkorbEscape` sind zwei von
 * Hand gepflegte Listen über DENSELBEN Sachverhalt, und zweimal ist derselbe
 * Fehler passiert: eine Tafel stand in der einen und nicht in der anderen
 * (`activeChannelId` fehlte im Schlüssel, `usePasswortUi` im Ausweg). Beide
 * Male blieb die Fehlerkarte als Sackgasse über Rail und Sidebar stehen.
 *
 * Statt die Liste noch einmal abzuschreiben (dann wäre DIESE Datei die
 * dritte Stelle, die man vergessen kann), wird sie hier abgeleitet: jede
 * Anmeldung der Form `const xOffen = useXUi((s) => s.offen)` in App.tsx IST
 * eine laden-gestützte Tafel — anders kommt eine solche gar nicht an ihren
 * Zustand. Für jede davon muss die Variable im Schlüssel stehen UND der
 * zugehörige Laden im Ausweg geschlossen werden. Ein achtes Panel schlägt
 * hier fehl, sobald jemand es anmeldet, ohne beide Listen zu ergänzen. */

console.log('\nApp.tsx — jede laden-gestützte Tafel in Schlüssel UND Ausweg:');

/** [{ variable, laden }] für jedes `const x = useY((s) => s.offen)`. */
const tafeln = [];
const findeTafeln = (n) => {
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)
      && /^use[A-Z]/.test(n.initializer.expression.text)) {
    const arg = n.initializer.arguments[0];
    // Nur der Wähler `(s) => s.offen` — `useStore((s) => s.overlay)` und
    // Freunde hängen nicht an einem eigenen Laden und haben ihren Ausweg
    // schon über setOverlay(null).
    if (arg && /^\(\s*\w+\s*\)\s*=>\s*\w+\.offen$/.test(arg.getText(appQuelle).replace(/\s+/g, ' '))) {
      tafeln.push({ variable: n.name.text, laden: n.initializer.expression.text });
    }
  }
  ts.forEachChild(n, findeTafeln);
};
findeTafeln(appQuelle);

// Die Prüfung selbst wäre wertlos, wenn sie gar nichts fände: eine
// umbenannte Anmeldeform ließe `tafeln` leer und alles darunter grün.
pruef('es wurden überhaupt laden-gestützte Tafeln gefunden (sonst prüft der Rest nichts)',
  tafeln.length >= 7, true);

/** Der Rumpf von `fangkorbEscape` als Text — nicht die ganze Datei: ein
 *  `schliessen()` irgendwo sonst in App.tsx wäre kein Ausweg. */
let escapeText = '';
const findeEscape = (n) => {
  if (escapeText) return;
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'fangkorbEscape' && n.initializer) {
    escapeText = n.initializer.getText(appQuelle);
    return;
  }
  ts.forEachChild(n, findeEscape);
};
findeEscape(appQuelle);
pruef('fangkorbEscape wurde gefunden', Boolean(escapeText), true);

for (const { variable, laden } of tafeln) {
  pruef(`${variable} steht im Rücksetz-Schlüssel`,
    Boolean(schluesselElemente?.includes(variable)), true);
  pruef(`${laden} wird im Ausweg geschlossen`,
    escapeText.includes(`${laden}.getState().schliessen()`), true);
}

/* ── 2a: <Fangkorb eingebettet …> bekommt onEscape ───────────────────── */

let fangkorbElement = null;
const findeFangkorbElement = (n) => {
  if (fangkorbElement) return;
  if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(appQuelle) === 'Fangkorb') {
    const hatEingebettet = n.attributes.properties.some((p) => p.name?.getText(appQuelle) === 'eingebettet');
    if (hatEingebettet) { fangkorbElement = n; return; }
  }
  ts.forEachChild(n, findeFangkorbElement);
};
findeFangkorbElement(appQuelle);

pruef('das eingebettete <Fangkorb> wurde gefunden', Boolean(fangkorbElement), true);
if (fangkorbElement) {
  const hatOnEscape = fangkorbElement.attributes.properties.some((p) => p.name?.getText(appQuelle) === 'onEscape');
  pruef('<Fangkorb eingebettet …> bekommt onEscape (Ausweg für die laden-gestützten Tafeln)', hatOnEscape, true);
}

/* ── 2b: Fangkorb.tsx nimmt onEscape an UND wertet es beim Zeichnen aus ── */

console.log('\nFangkorb.tsx:');
const fkText = fs.readFileSync(fangkorbPfad, 'utf8');
const fkQuelle = parse(fangkorbPfad, ts.ScriptKind.TSX);

let hatPropsFeld = false;
const findePropsFeld = (n) => {
  if (hatPropsFeld) return;
  if (ts.isInterfaceDeclaration(n) && n.name.text === 'Props') {
    hatPropsFeld = n.members.some((m) => m.name?.getText(fkQuelle) === 'onEscape');
    return;
  }
  ts.forEachChild(n, findePropsFeld);
};
findePropsFeld(fkQuelle);
pruef('Props kennt onEscape', hatPropsFeld, true);

// Ausgewertet, nicht nur angenommen: render() muss this.props.onEscape lesen
// UND aufrufen — sonst wäre die Eigenschaft ein Attrappe.
pruef('render() liest this.props.onEscape', /this\.props\.onEscape/.test(fkText), true);
pruef('render() ruft onEscape tatsächlich auf (nicht nur eine Bedingung)', /onEscape\?\.\(\)|onEscape\(\)/.test(fkText), true);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDie Fehlerkarte überlebt weder einen Kanalwechsel noch bleibt sie für die laden-gestützten Tafeln eine Sackgasse.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
