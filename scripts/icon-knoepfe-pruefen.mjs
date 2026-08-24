#!/usr/bin/env node
/**
 * Zählt Icon-only-Knöpfe (<button>/<motion.button> ohne sichtbaren
 * Text-Inhalt) ohne aria-label/aria-labelledby — je Datei, mit Ratchet
 * über scripts/icon-knoepfe-schwelle.json. Baut auf demselben Muster wie
 * scripts/deutsch-finden.mjs + scripts/deutsch-schwelle.json (siehe dort
 * für die ausführliche Begründung: je Datei statt einer Gesamtzahl, JSON
 * statt handgeschriebener Prosa, --schwelle-aktualisieren schreibt nie
 * einen Anstieg fest).
 *
 * WARUM ZWEI FELDER JE DATEI, NICHT EINS
 * Ein Barrierefreiheits-Review fand Icon-only-Knöpfe, die zwar `title`
 * trugen, aber kein `aria-label` — und behauptete dabei fälschlich,
 * Sprachausgaben bekämen davon GAR NICHTS zu hören. Das stimmt nicht: fehlt
 * jeder andere zugängliche Name, greift die Namensberechnung des
 * Zugänglichkeitsbaums auf `title` zurück, und Sprachausgaben lesen das
 * durchaus vor. Das macht die Migration auf `aria-label` zu einer echten
 * Verbesserung (title erscheint nicht bei Tastaturfokus, ist auf
 * Touch-Geräten unsichtbar, und wird nicht in jedem Sprachausgabe-Modus
 * vorgelesen) — aber es wäre falsch, in DIESER Prüfung denselben Fehler zu
 * wiederholen und `title`-tragende Knöpfe als "ganz ohne Namen" zu meldenden.
 * Deshalb zwei getrennte Felder:
 *
 *   · mitTitleOhneAria — hat `title` (also technisch einen Namen über den
 *     Rückgriff), aber noch nicht die im Haus etablierte, robustere
 *     Konvention (`aria-label` steht bereits an 68+ anderen Stellen). Eine
 *     Konsistenz-Lücke, keine Dringlichkeit.
 *   · ohneJedeBenennung — hat WEDER `title` NOCH `aria-label`: hier gibt es
 *     wirklich keinen zugänglichen Namen, auch nicht über den Rückgriff.
 *     Das ist der einzige Fall, auf den "lacking an accessible name"
 *     wörtlich zutrifft. Diese Stellen lagen außerhalb des heutigen
 *     Auftrags (kein vorhandener title-Text zum Wiederverwenden, und neue
 *     i18n-Schlüssel sollten für die Migration nicht entstehen) — sie
 *     bleiben unverändert, aber diese Prüfung verschweigt sie nicht: eine
 *     Schwelle bei einer beschönigten Null wäre keine Schwelle mehr.
 *
 * Wie bei deutsch-schwelle.json gilt je Feld und je Datei: schlechter als
 * die hinterlegte Zahl ist ein Hardstop, egal wie viel Altbestand anderswo
 * gerade abgearbeitet wird.
 *
 * ICON-ONLY VS. BESCHRIFTET — WARUM DAS SCHWERER IST, ALS ES KLINGT
 * Ein Knopf gilt hier nur dann als "ohne sichtbaren Text", wenn WIRKLICH
 * kein Kind-Ausdruck Text erzeugen könnte — siehe ausdruckIstText(). Im
 * Zweifel entscheidet die Funktion für "hat Text", nicht für "icon-only":
 * ein Vergleichsknopf, der fälschlich als icon-only gilt, bekäme sonst ein
 * `aria-label`, das dem sichtbaren Text widerspricht — genau die Falle, vor
 * der der Auftrag warnt ("Klick auf Senden" funktioniert nicht mehr, wenn
 * der zugängliche Name etwas anderes sagt). Umgekehrt gilt: verpasst diese
 * Prüfung dadurch einen echten Fund, ist das der sicherere Fehler — eine
 * Prüfung, die beschriftete Knöpfe meldet, wird von der nächsten Person
 * abgeschaltet statt befolgt.
 *
 * Ausdrücklich NICHT als "icon-only" gezählt: ein selbstschließender
 * <button className="switch" role="switch" .../> — der trägt gar kein
 * Icon, sein Zustand kommt rein aus CSS. Das ist eine andere Baustelle
 * (Namensvergabe für Kippschalter über ein sichtbares Nachbarelement, nicht
 * über title/aria-label an genau diesem Knopf) und gehört nicht in diese
 * Zählung — sie würde sonst Fälle mit hineinziehen, für die "title
 * wiederverwenden" gar keinen Sinn ergibt.
 *
 * GRENZEN DIESER PRÜFUNG — EHRLICH BENANNT STATT VERSCHWIEGEN
 * Drei Lücken, keine davon versteckt:
 *
 *   · LEERER STRING ZÄHLT NICHT MEHR ALS BENENNUNG. `aria-label=""` (oder
 *     `aria-label={''}`, oder eine reine Whitespace-Zeichenkette) sieht für
 *     einen Namens-Scan aus wie ein vorhandenes `aria-label`, ist für eine
 *     Sprachausgabe aber nichts wert — istLeererStringAusdruck() unten fängt
 *     genau das ab. NUR statische String-Literale sind damit erkennbar: ein
 *     Ausdruck (`aria-label={variable}`, `aria-label={t('key')}`, ein
 *     Template mit Interpolation) kann zur Laufzeit leer sein, ohne dass
 *     eine AST-Prüfung ohne echte Typanalyse das sehen könnte — im Zweifel
 *     gilt so ein Ausdruck als "hat einen Wert", aus demselben Grund wie bei
 *     ausdruckIstText() oben (ein übersehener Fund ist der sicherere
 *     Fehler als ein zu Unrecht gemeldeter).
 *   · SPREAD-ATTRIBUTE WERDEN IGNORIERT, IN BEIDE RICHTUNGEN. `<button
 *     {...rest} />` könnte ein `aria-label` aus `rest` mitbringen, das
 *     diese Prüfung nicht sieht (falscher Fund), oder ein zuvor gesetztes
 *     `aria-label` durch ein späteres `{...rest}` wieder überschreiben
 *     (verpasster Fund) — `attribut()` durchsucht nur benannte
 *     `JsxAttribute`-Knoten, keine `JsxSpreadAttribute`-Knoten, und prüft
 *     auch keine Reihenfolge. Das absichtlich ungelöst: welchen Wert ein
 *     Spread zur Laufzeit tatsächlich mitbringt, ist ohne echte Typanalyse
 *     (Kenntnis der Props-Herkunft) nicht zu entscheiden — kein AST-Trick
 *     schließt diese Lücke billig.
 *   · NUR `.tsx` UNTER packages/desktop/src. Kein `.jsx`, kein anderes
 *     Paket, kein Server-gerenderter Code. Für dieses Repository ist das
 *     der einzige Ort, an dem JSX-Knöpfe überhaupt entstehen (siehe
 *     dateiListe() unten) — aber falls das je nicht mehr stimmt, prüft
 *     dieser Lauf den Rest still gar nicht, ohne das anzuzeigen.
 *
 * BLINDE SUCHE MUSS LAUT SCHEITERN
 * Findet der Parser insgesamt nur eine Handvoll <button>-Elemente, ist das
 * kein sauberes Repository, sondern ein kaputter Parser (falscher
 * Wurzelordner, falsche Dateiendung, AST-Läufer bricht früh ab). Deshalb
 * MINDEST_KNOEPFE_GESAMT unten — eine Mindestzahl gescannter Knöpfe, die
 * unabhängig vom eigentlichen Befund garantiert, dass wirklich durchsucht
 * wurde. Genau dasselbe Muster wie MINDESTENS_AUFRUFE in
 * scripts/message-send-clientid-verkabelung-pruefen.mjs.
 *
 * Aufruf:  node scripts/icon-knoepfe-pruefen.mjs
 *          node scripts/icon-knoepfe-pruefen.mjs --schwelle-aktualisieren
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(REPO_WURZEL, p).split(path.sep).join('/');
const WURZEL = path.join(REPO_WURZEL, 'packages/desktop/src');

/* ── Dateien einsammeln ──────────────────────────────────────────────── */

function* dateiListe(ordner) {
  for (const eintrag of fs.readdirSync(ordner, { withFileTypes: true })) {
    const voll = path.join(ordner, eintrag.name);
    if (eintrag.isDirectory()) {
      if (eintrag.name === 'node_modules') continue;
      yield* dateiListe(voll);
    } else if (eintrag.isFile() && eintrag.name.endsWith('.tsx')) {
      yield voll;
    }
  }
}

/* ── JSX-Hilfsfunktionen ─────────────────────────────────────────────── */

function tagName(node) {
  return node.tagName.getText();
}

function attribut(opening, name) {
  for (const attr of opening.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText() === name) return attr;
  }
  return null;
}

/** Ein statisch erkennbares leeres (oder reines Whitespace-)String-Literal —
 *  siehe Dateikopf, GRENZEN DIESER PRÜFUNG. Nur String-Literale, kein
 *  Ausdruck: eine Variable oder ein Funktionsaufruf kann zur Laufzeit leer
 *  sein, das ist ohne echte Typanalyse nicht zu sehen. */
function istLeererStringAusdruck(node) {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.trim() === '';
  }
  return false;
}

/** Trägt dieses Attribut einen Wert, der NICHT als leerer String erkennbar
 *  ist? `aria-label=""` zählt damit nicht mehr als Benennung — siehe
 *  Dateikopf. Ein bares Attribut (`aria-label` ohne `=`) ist technisch
 *  `{true}`, kein leerer String, und zählt deshalb weiter als vorhanden. */
function hatErkennbarNichtleerenWert(attr) {
  if (!attr) return false;
  const init = attr.initializer;
  if (!init) return true;
  if (ts.isStringLiteral(init)) return !istLeererStringAusdruck(init);
  if (ts.isJsxExpression(init) && init.expression) return !istLeererStringAusdruck(init.expression);
  return true;
}

/* Erzeugt dieser Ausdruck sichtbaren Text (im Unterschied zu einem
 * Icon-Element oder zu "nichts")? Im Zweifel TRUE — Begründung im Dateikopf,
 * Abschnitt "ICON-ONLY VS. BESCHRIFTET". */
function ausdruckIstText(ausdruck) {
  if (!ausdruck) return false;
  if (ausdruck.kind === ts.SyntaxKind.NullKeyword || ausdruck.kind === ts.SyntaxKind.TrueKeyword
    || ausdruck.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(ausdruck) && ausdruck.text === 'undefined') return false;
  if (ts.isJsxElement(ausdruck) || ts.isJsxSelfClosingElement(ausdruck) || ts.isJsxFragment(ausdruck)) return false;
  if (ts.isParenthesizedExpression(ausdruck)) return ausdruckIstText(ausdruck.expression);
  if (ts.isConditionalExpression(ausdruck)) {
    return ausdruckIstText(ausdruck.whenTrue) || ausdruckIstText(ausdruck.whenFalse);
  }
  if (ts.isBinaryExpression(ausdruck)) {
    const op = ausdruck.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) return true; // String-Verkettung
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken
      || op === ts.SyntaxKind.QuestionQuestionToken) {
      return ausdruckIstText(ausdruck.left) || ausdruckIstText(ausdruck.right);
    }
    return false; // Vergleiche (===, <, …) liefern boolean, keinen Text
  }
  // Alles andere (Literale, Template-Strings, t(...)-Aufrufe, Variablen,
  // r.emoji, Arrays aus .map() …) im Zweifel als Text werten.
  return true;
}

function kindHatSichtbarenText(children) {
  for (const kind of children) {
    if (ts.isJsxText(kind)) {
      if (kind.getText().trim().length > 0) return true;
    } else if (ts.isJsxExpression(kind)) {
      if (kind.expression && ausdruckIstText(kind.expression)) return true;
    } else if (ts.isJsxElement(kind)) {
      if (kindHatSichtbarenText(kind.children)) return true;
    }
    // Ein JsxSelfClosingElement (Icon-Komponente) trägt nie eigenen Text.
  }
  return false;
}

/* ── Repository durchlaufen ──────────────────────────────────────────── */

const proDatei = new Map(); // rel-Pfad -> { mitTitleOhneAria, ohneJedeBenennung }
const funde = []; // fürs Protokoll
let gesamtKnoepfeGescannt = 0;

function zaehle(dateiRel, feld, zeile, hinweis) {
  if (!proDatei.has(dateiRel)) proDatei.set(dateiRel, { mitTitleOhneAria: 0, ohneJedeBenennung: 0 });
  proDatei.get(dateiRel)[feld] += 1;
  funde.push({ datei: dateiRel, feld, zeile, hinweis });
}

for (const datei of dateiListe(WURZEL)) {
  const quelle = fs.readFileSync(datei, 'utf8');
  const sf = ts.createSourceFile(datei, quelle, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const dateiRel = rel(datei);

  function besuch(node) {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      const tn = tagName(opening);
      if (tn === 'button' || tn === 'motion.button') {
        gesamtKnoepfeGescannt++;
        // Ein leeres `aria-label=""` zählt hier NICHT als Benennung — siehe
        // Dateikopf, GRENZEN DIESER PRÜFUNG.
        const ariaLabelAttr = attribut(opening, 'aria-label');
        const ariaLabelledbyAttr = attribut(opening, 'aria-labelledby');
        const ariaAttr = (ariaLabelAttr && hatErkennbarNichtleerenWert(ariaLabelAttr) && ariaLabelAttr)
          || (ariaLabelledbyAttr && hatErkennbarNichtleerenWert(ariaLabelledbyAttr) && ariaLabelledbyAttr);
        if (!ariaAttr) {
          const hatText = kindHatSichtbarenText(node.children);
          if (!hatText) {
            const titleAttr = attribut(opening, 'title');
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            if (titleAttr) {
              zaehle(dateiRel, 'mitTitleOhneAria', line + 1, `<${tn}> title vorhanden, aria-label fehlt`);
            } else {
              zaehle(dateiRel, 'ohneJedeBenennung', line + 1, `<${tn}> weder title noch aria-label`);
            }
          }
        }
      }
    } else if (ts.isJsxSelfClosingElement(node)) {
      // Selbstschließend (z.B. <button className="switch" .../>) trägt nie
      // ein Icon — bewusst nicht Teil dieser Zählung, siehe Dateikopf.
      const tn = tagName(node);
      if (tn === 'button' || tn === 'motion.button') gesamtKnoepfeGescannt++;
    }
    ts.forEachChild(node, besuch);
  }
  besuch(sf);
}

/* ── Gegenprobe gegen eine blinde Suche ──────────────────────────────── */

const MINDEST_KNOEPFE_GESAMT = 300; // zum Zeitpunkt dieser Prüfung: 389 (384 <button> + 5 <motion.button>)
if (gesamtKnoepfeGescannt < MINDEST_KNOEPFE_GESAMT) {
  console.log(`\n✗ Nur ${gesamtKnoepfeGescannt} <button>/<motion.button>-Elemente insgesamt gefunden — erwartet`);
  console.log(`  mindestens ${MINDEST_KNOEPFE_GESAMT}. Das ist kein sauberes Repository, das ist ein kaputter`);
  console.log('  Parser (falscher Wurzelordner, falsche Dateiendung, AST-Lauf bricht früh ab). Prüfung');
  console.log('  selbst reparieren, bevor irgendeinem Befund hier vertraut wird.');
  process.exitCode = 1;
  process.exit();
}

/* ── SCHWELLE — derselbe Ratchet-Mechanismus wie deutsch-finden.mjs ─── */

const SCHWELLE_DATEI = path.join(REPO_WURZEL, 'scripts/icon-knoepfe-schwelle.json');
const AKTUALISIEREN_FLAGGE = '--schwelle-aktualisieren';
const sollAktualisieren = process.argv.includes(AKTUALISIEREN_FLAGGE);

function pruefeSchwelle(daten, quelle) {
  if (!daten || typeof daten !== 'object' || typeof daten.dateien !== 'object' || daten.dateien === null) {
    throw new Error(`${quelle}: erwarte ein Objekt mit einem Feld "dateien".`);
  }
  for (const [datei, zahlen] of Object.entries(daten.dateien)) {
    for (const feld of ['mitTitleOhneAria', 'ohneJedeBenennung']) {
      const wert = zahlen?.[feld];
      if (!Number.isInteger(wert) || wert < 0) {
        throw new Error(`${quelle}: "${datei}".${feld} ist keine gültige Zahl (${JSON.stringify(wert)}).`);
      }
    }
  }
}

function ladeSchwelleSicher() {
  if (!fs.existsSync(SCHWELLE_DATEI)) return { daten: null, fehler: null };
  try {
    const daten = JSON.parse(fs.readFileSync(SCHWELLE_DATEI, 'utf8'));
    pruefeSchwelle(daten, rel(SCHWELLE_DATEI));
    return { daten, fehler: null };
  } catch (err) {
    return { daten: null, fehler: err };
  }
}

const gesamtVonEintraegen = (eintraege) => eintraege.reduce((s, z) => s + z.mitTitleOhneAria + z.ohneJedeBenennung, 0);
const gesamtVonMap = (m) => gesamtVonEintraegen([...m.values()]);
const gesamtVonObjekt = (dateien) => gesamtVonEintraegen(Object.values(dateien));

function schwelleSchreiben(m) {
  const dateien = {};
  for (const [datei, zahlen] of [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (zahlen.mitTitleOhneAria === 0 && zahlen.ohneJedeBenennung === 0) continue;
    dateien[datei] = zahlen;
  }
  const inhalt = {
    __hinweis: [
      'Wird von scripts/icon-knoepfe-pruefen.mjs gelesen und mit --schwelle-aktualisieren geschrieben.',
      'Zaehlt Icon-only-Knoepfe ohne aria-label je Datei, nicht global — ein neuer Fund in Datei A',
      'darf sich nicht hinter einer Reparatur in Datei B verstecken. Darf je Datei nur sinken; ein',
      'Anstieg ist im Gate ein Hardstop. Erhoehungen gehen nur per Hand-Edit dieser Datei (sichtbar',
      'im Diff), nicht per Kommandozeile — siehe Kopf von scripts/icon-knoepfe-pruefen.mjs.',
      'mitTitleOhneAria: hat title, aber (noch) kein aria-label — Konsistenz-Luecke, kein Notfall.',
      'ohneJedeBenennung: hat WEDER title NOCH aria-label — dort fehlt wirklich jeder Name.',
    ],
    erzeugtAm: new Date().toISOString().slice(0, 10),
    dateien,
  };
  fs.writeFileSync(SCHWELLE_DATEI, `${JSON.stringify(inhalt, null, 2)}\n`);
}

const { daten: schwelle, fehler: schwelleFehler } = ladeSchwelleSicher();

function bericht() {
  const nachDatei = new Map();
  for (const f of funde) {
    if (!nachDatei.has(f.datei)) nachDatei.set(f.datei, []);
    nachDatei.get(f.datei).push(f);
  }
  for (const [datei, liste] of [...nachDatei.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`\n${datei}  (${liste.length})`);
    for (const f of liste.sort((a, b) => a.zeile - b.zeile)) {
      console.log(`  Zeile ${f.zeile}  [${f.feld}]  ${f.hinweis}`);
    }
  }
}

if (sollAktualisieren) {
  bericht();
  const neuGesamt = gesamtVonMap(proDatei);
  const altGesamt = schwelle ? gesamtVonObjekt(schwelle.dateien) : 0;
  if (schwelleFehler) {
    console.log(`\n! Bisherige ${rel(SCHWELLE_DATEI)} ließ sich nicht lesen (${schwelleFehler.message}) — wird ersetzt.`);
  }
  if (schwelle && !schwelleFehler && neuGesamt > altGesamt) {
    console.log(`\n✗ ${AKTUALISIEREN_FLAGGE} lehnt ab: die Gesamtzahl stiege von ${altGesamt} auf ${neuGesamt}.`);
    console.log('  Dieser Befehl schreibt nur Verbesserungen fest, nie einen Anstieg.');
    process.exitCode = 1;
  } else {
    schwelleSchreiben(proDatei);
    if (!schwelle) {
      console.log(`\n✓ Erstmalig angelegt: ${rel(SCHWELLE_DATEI)} mit ${neuGesamt} Altfällen.`);
    } else {
      const teil = neuGesamt - altGesamt;
      console.log(`\n✓ Schwelle aktualisiert: ${altGesamt} → ${neuGesamt} (${teil > 0 ? '+' : ''}${teil}).`);
    }
    process.exitCode = 0;
  }
} else if (schwelleFehler) {
  console.log(`\n✗ ${rel(SCHWELLE_DATEI)} lässt sich nicht lesen: ${schwelleFehler.message}`);
  console.log(`  Entweder von Hand reparieren, oder neu erzeugen: node scripts/icon-knoepfe-pruefen.mjs ${AKTUALISIEREN_FLAGGE}`);
  process.exitCode = 1;
} else if (!schwelle) {
  console.log(`\n✗ Keine Schwelle hinterlegt (${rel(SCHWELLE_DATEI)} fehlt).`);
  console.log('  Einmalig anlegen:');
  console.log(`    node scripts/icon-knoepfe-pruefen.mjs ${AKTUALISIEREN_FLAGGE}`);
  process.exitCode = 1;
} else {
  const alleDateien = new Set([...Object.keys(schwelle.dateien), ...proDatei.keys()]);
  const verschlechtert = [];
  const verbessert = [];
  for (const datei of [...alleDateien].sort()) {
    const alt = schwelle.dateien[datei] ?? { mitTitleOhneAria: 0, ohneJedeBenennung: 0 };
    const neu = proDatei.get(datei) ?? { mitTitleOhneAria: 0, ohneJedeBenennung: 0 };
    for (const feld of ['mitTitleOhneAria', 'ohneJedeBenennung']) {
      if (neu[feld] > alt[feld]) verschlechtert.push({ datei, feld, alt: alt[feld], neu: neu[feld] });
      else if (neu[feld] < alt[feld]) verbessert.push({ datei, feld, alt: alt[feld], neu: neu[feld] });
    }
  }

  const altGesamt = gesamtVonObjekt(schwelle.dateien);
  const neuGesamt = gesamtVonMap(proDatei);
  const teil = neuGesamt - altGesamt;

  if (verschlechtert.length) bericht();

  if (verschlechtert.length || verbessert.length) {
    console.log('\nVerändert gegenüber der Schwelle:');
    for (const v of verschlechtert) {
      console.log(`  ✗ ${v.datei}  ${v.feld} ${v.alt} → ${v.neu}  (+${v.neu - v.alt}, neu über der Schwelle)`);
    }
    for (const v of verbessert) {
      console.log(`  ✓ ${v.datei}  ${v.feld} ${v.alt} → ${v.neu}  (${v.neu - v.alt})`);
    }
  }
  console.log(`\nGesamt erlaubt: ${altGesamt}   Gesamt jetzt: ${neuGesamt}${teil ? `  (${teil > 0 ? '+' : ''}${teil})` : ''}`);

  if (verschlechtert.length) {
    console.log(`\n✗ SCHWELLE ÜBERSCHRITTEN — ${verschlechtert.length} Stelle(n) über dem hinterlegten Stand.`);
    console.log('  Ein neuer Icon-only-Knopf ohne aria-label ist ein Hardstop: title-Ausdruck (falls');
    console.log('  vorhanden) als aria-label wiederholen — keinen neuen i18n-Schlüssel dafür anlegen.');
    process.exitCode = 1;
  } else if (verbessert.length) {
    console.log(`\n✓ Innerhalb der Schwelle — ${neuGesamt} Fälle stehen noch aus, die Zahl darf ab hier nur`);
    console.log('  sinken, nie steigen.');
    console.log(`\n  ${verbessert.length} Stelle(n) sind besser als in der Schwelle hinterlegt. Festschreiben:`);
    console.log(`    node scripts/icon-knoepfe-pruefen.mjs ${AKTUALISIEREN_FLAGGE}`);
    process.exitCode = 0;
  } else {
    console.log(`\n✓ Innerhalb der Schwelle — ${neuGesamt} von ${altGesamt} erlaubten Altfällen, unverändert.`);
    process.exitCode = 0;
  }
}
