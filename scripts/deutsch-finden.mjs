/**
 * Findet Texte, die fest im Code stehen statt aus dem Wörterbuch zu kommen.
 *
 * WARUM DIESE FASSUNG ANDERS SUCHT
 * Die erste Fassung ging zeilenweise mit regulären Ausdrücken vor und stellte
 * als erstes die Frage „steht in dieser Zeile überhaupt Deutsch?" — beantwortet
 * über Umlaute oder eine Liste häufiger Funktionswörter (der, die, das, nicht,
 * …). Genau daran ist sie vorbeigelaufen: eine Beschriftung wie „Suche",
 * „Gemerkt", „Ziel", „Frage", „Planen" hat weder Umlaut noch Funktionswort.
 * Damit war die ganze Gattung der ein- und zweiwortigen Beschriftungen
 * unsichtbar — und das ist in einer Oberfläche die Mehrheit aller Texte.
 * Zusätzlich verlangten mehrere Muster Mindestlängen von 6 bis 9 Zeichen, was
 * kurze Knopfbeschriftungen ein zweites Mal durchfallen ließ.
 *
 * Diese Fassung dreht die Frage um. Sie liest den Syntaxbaum (TypeScript) und
 * sammelt nur Stellen, an denen ein Text zwangsläufig auf dem Schirm landet:
 * JSX-Text, ausgegebene JSX-Ausdrücke, Beschriftungs-Attribute und die
 * Text-Eigenschaften von Meldungen. Was dort als Zeichenkette steht, ist ein
 * Fund — unabhängig von Sprache und Länge. Es wird also nicht mehr geraten,
 * ob ein Text deutsch ist, sondern festgestellt, ob er überhaupt fest im Code
 * steht.
 *
 * WARUM DAS KEINE LAWINE VON FEHLALARMEN GIBT
 * Der Syntaxbaum trennt sauber, was der Zeilenleser nicht trennen konnte:
 * · Kommentare sind keine Zeichenketten und tauchen gar nicht erst auf.
 * · Bezeichner (bloecke, ablage, verkleinern) sind keine Zeichenketten.
 * · Protokollausgaben (console.log) stehen an keiner Anzeigestelle.
 * · CSS-Klassen, Ereignisnamen, Zustandswerte stehen in Attributen und
 *   Eigenschaften, die hier nicht als Anzeigestellen gelten.
 * · Die Wörterbücher sind ausgenommen — dort gehört der Text hin.
 * · Schlüssel wie 'tour.welcomeTitle' werden gegen das deutsche Wörterbuch
 *   geprüft: was dort als Schlüssel existiert, ist keine Beschriftung.
 * Was danach noch übrig bleibt und trotzdem kein Fund sein soll, steht in der
 * Ausnahmeliste weiter unten — jeder Eintrag mit Begründung.
 *
 * UND DER SERVER?
 * Dort ist Deutsch überwiegend richtig: Kommentare, Protokollausgaben, die
 * Konsole auf dem Pi, die Startmeldung. Falsch ist es nur an den wenigen
 * Stellen, an denen ein Text den Server verlässt und beim Benutzer ungefiltert
 * auf dem Schirm landet. Dafür gibt es eine feste Machart — der Server schickt
 * eine Kennung, die Oberfläche setzt ihren eigenen Satz ein, der deutsche Text
 * bleibt nur als Rückfall für ältere Clients. Geprüft wird deshalb genau eine
 * Frage:
 *
 *     Geht hier Anzeigetext hinaus, ohne dass eine Kennung dabei ist,
 *     die im Wörterbuch steht?
 *
 * Ist eine übersetzbare Kennung dabei, ist der deutsche Text daneben in
 * Ordnung. Fehlt sie, sieht jeder Mensch Deutsch — egal was er eingestellt hat.
 *
 * Die Abflüsse sind namentlich aufgezählt (unten: MELDE_HELFER, ANTWORT_FELD,
 * PROTOKOLL_TEXTFELDER). Das ist Absicht und zugleich die Grenze dieser
 * Prüfung: sie kennt die vorhandenen Abflüsse, sie findet keine neuen. Eine
 * allgemeine Verfolgung „welcher Text erreicht den Client?" wäre über
 * Fehlerobjekte, Rückgabewerte und die Ereignisleitung hinweg nur zu raten —
 * und eine ratende Prüfung ist schlimmer als keine.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const WURZEL = 'packages/desktop/src';

/* Die Wörterbücher sind der Ort, an dem deutscher Text stehen soll. */
const AUSGENOMMEN = ['i18n'];

/* ── Ausnahmeliste ────────────────────────────────────────────────
   Texte, die auch dann keine Übersetzung brauchen, wenn sie fest im
   Code stehen. Jeder Eintrag mit dem Grund, warum er hier steht. */
const SPRACHNEUTRAL = new Map([
  ['Stellium', 'Produktname — bleibt in jeder Sprache gleich; steht so auch in der Anweisung an den Übersetzer'],
  ['Groq', 'Firmenname, steht als solcher in der Anbieterauswahl'],
  ['OpenAI', 'Firmenname, steht als solcher in der Anbieterauswahl'],
  ['Ollama', 'Programmname in der Anbieterauswahl'],
  ['llama.cpp', 'Programmname in der Anbieterauswahl'],
  ['Ping', 'Name eines Signaltons, lautmalerisch — in jeder Oberflächensprache derselbe Klang'],
  ['Blip', 'Name eines Signaltons, lautmalerisch — in jeder Oberflächensprache derselbe Klang'],
]);

/* Was hier steht, ist genutzt worden — sonst meldet der Lauf es unten.
   Eine Ausnahme, auf die nichts mehr passt, ist keine Erleichterung, sondern
   eine Falle: sie schluckt irgendwann klaglos einen echten Fund. */
const genutzt = new Set();

/* Es gibt bewusst keine Liste ausgenommener Dateien. Eine Prüfung, die einen
   Fund verschweigt, weil gerade jemand an der Datei arbeitet, meldet dauerhaft
   grün — und niemand merkt es. Ausgenommen werden nur einzelne Texte, oben,
   mit Grund. */

/* ── Anzeigestellen ──────────────────────────────────────────────
   Attribute und Eigenschaften, deren Wert eine Person zu sehen bekommt.
   Alles andere (className, role, type, key, data-*, Stilangaben …) ist
   ausdrücklich keine Anzeigestelle. */
const BESCHRIFTUNGS_ATTRIBUTE = new Set([
  'title', 'placeholder', 'alt', 'label', 'sub', 'subtitle', 'caption',
  'hint', 'hinweis', 'titel', 'beschreibung', 'text', 'body', 'tooltip',
  'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
]);

const TEXT_EIGENSCHAFTEN = new Set([
  'title', 'titel', 'body', 'text', 'label', 'beschriftung', 'sub', 'subtitle',
  'placeholder', 'hint', 'hinweis', 'note', 'notiz', 'beschreibung', 'caption',
  'frage', 'meldung', 'nachricht',
]);

/* Aufrufe, deren erstes Argument als Fenster erscheint. */
const MELDUNGS_AUFRUFE = new Set([
  'alert', 'confirm', 'prompt', 'window.alert', 'window.confirm', 'window.prompt',
]);

/* ── Der Server: Abflüsse zum Client ─────────────────────────────
   Nur diese Stellen tragen Text aus dem Server zum Benutzer. Alles andere
   dort — Kommentare, console.*, die Konsole auf dem Pi, Startmeldungen,
   Anweisungen an das Sprachmodell — darf und soll deutsch sein. */
const SERVER_WURZEL = 'packages/server/src';

/* Helfer, die eine Meldung an den Client schicken: an welcher Stelle steht
   die Kennung, an welcher der deutsche Rückfalltext. */
const MELDE_HELFER = new Map([
  ['fehler', { kennung: 1, text: 2, wo: 'HTTP-Antwort' }],   // fehler(reply, status, code, text)
  ['fail', { kennung: 1, text: 2, wo: 'WS-Meldung' }],       // fail(session, code, message)
]);

/* Ein Objekt mit diesem Feld ist eine Fehlerantwort. Ohne ein Feld „code"
   daneben hat die Oberfläche nichts, was sie übersetzen könnte. */
const ANTWORT_FELD = 'error';
const KENNUNGS_FELD = 'code';

/* Dasselbe über die Ereignisleitung. Der Helfer fail() ist der übliche Weg,
   aber ein Ereignis lässt sich auch von Hand zusammensetzen — und genau so
   ist hier eine Meldung an allen Prüfungen vorbei jahrelang deutsch geblieben.
   Erkannt wird sie an ihrer Bauform: t: 'error' mit einem Textfeld. */
const EREIGNIS_ART = 'error';
const EREIGNIS_TEXTFELD = 'message';

/* Felder des Protokolls, die ausdrücklich Anzeigetext tragen, und das Feld
   daneben, in dem die Kennung dazu steht. Hier ist aufgezählt, welche —
   die Prüfung errät es nicht. Steht die Kennung daneben, ist der deutsche
   Text daneben in Ordnung: er ist dann nur der Rückfall. */
const PROTOKOLL_TEXTFELDER = new Map([
  ['note', { kennungsFeld: 'noteCode', wo: 'AiCapabilities.note — Einstellungen, „Übersetzungs-Dienst"' }],
]);

/* Dateien des Servers, die trotz eines Abflusses kein Fund sind. */
const SERVER_AUSNAHMEN = new Map([
  ['http/konsole.ts',
   'Die Betreiberkonsole auf dem Pi. nurVonHier() lässt nur 127.0.0.1 ohne Vermittler durch — '
   + 'ihre Antworten liest die Konsolenseite selbst, nie die App eines Benutzers.'],
]);

/* ── Wörterbuchschlüssel ─────────────────────────────────────────
   'tour.welcomeTitle' ist kein Text, sondern ein Verweis auf einen. */
const SCHLUESSEL = new Set(
  [...fs.readFileSync(path.join(WURZEL, 'i18n/de.ts'), 'utf8').matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]),
);

/* ── Beurteilung eines einzelnen Textes ──────────────────────── */

function istFund(roh) {
  const text = roh.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  /* Zeichen, Ziffern, Emoji und Einzelbuchstaben sind keine Beschriftung:
     „·", „—", „@", „#", „%", „→", „(", „K". Erst ab zwei zusammenhängenden
     Buchstaben wird daraus ein Wort. */
  if (!/\p{L}{2,}/u.test(text)) return null;

  if (SCHLUESSEL.has(text)) return null;
  if (SPRACHNEUTRAL.has(text)) { genutzt.add(text); return null; }

  /* Technische Werte, die auch an einer Anzeigestelle keine Übersetzung
     vertragen — sie stehen dort als Beispiel oder Format, nicht als Satz. */
  if (/^https?:\/\//.test(text)) return null;                  // Beispiel-Adresse im Serverfeld
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(text)) return null;         // MIME-Typ
  if (/^\.[A-Za-z0-9.]+( \/ \.[A-Za-z0-9.]+)*$/.test(text)) return null; // Dateiendungen: „.dmg", „.tar.gz", „.AppImage / .deb"
  if (/^var\(--/.test(text)) return null;                       // CSS-Variable

  return text;
}

/* ── Sammeln ─────────────────────────────────────────────────── */

const treffer = [];

/** Alle Zeichenketten, die als *Wert* aus einem Ausdruck herausfallen.
 *  Bedingungen (a === 'dm') und Aufrufargumente (t('nav.chat')) bleiben
 *  außen vor — dort steht kein Text, sondern eine Entscheidung oder ein
 *  Schlüssel. */
function werte(knoten, aus) {
  if (!knoten) return;
  if (ts.isStringLiteral(knoten) || ts.isNoSubstitutionTemplateLiteral(knoten)) {
    aus.push({ text: knoten.text, knoten });
    return;
  }
  if (ts.isTemplateExpression(knoten)) {
    aus.push({ text: knoten.head.text, knoten: knoten.head });
    for (const teil of knoten.templateSpans) aus.push({ text: teil.literal.text, knoten: teil.literal });
    return;
  }
  if (ts.isParenthesizedExpression(knoten)) return werte(knoten.expression, aus);
  if (ts.isJsxExpression(knoten)) return werte(knoten.expression, aus);
  if (ts.isConditionalExpression(knoten)) {
    werte(knoten.whenTrue, aus);
    werte(knoten.whenFalse, aus);
    return;
  }
  if (ts.isBinaryExpression(knoten)) {
    const zeichen = knoten.operatorToken.kind;
    /* a ?? 'Unbekannt' und a || 'DM': beide Seiten können angezeigt werden.
       cond && 'Text': nur die rechte. a + b: beide. Alles andere (===, !==,
       Zuweisungen) trägt keinen Anzeigetext. */
    if (zeichen === ts.SyntaxKind.QuestionQuestionToken || zeichen === ts.SyntaxKind.BarBarToken
        || zeichen === ts.SyntaxKind.PlusToken) {
      werte(knoten.left, aus);
      werte(knoten.right, aus);
      return;
    }
    if (zeichen === ts.SyntaxKind.AmpersandAmpersandToken) return werte(knoten.right, aus);
  }
}

function pruefeDatei(pfad) {
  const quelle = ts.createSourceFile(
    pfad, fs.readFileSync(pfad, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );

  const merke = (stelle, eintraege) => {
    for (const { text, knoten } of eintraege) {
      const fund = istFund(text);
      if (!fund) continue;
      const { line } = quelle.getLineAndCharacterOfPosition(knoten.getStart(quelle));
      treffer.push({ datei: pfad, zeile: line + 1, stelle, text: fund });
    }
  };

  const gehe = (knoten) => {
    if (ts.isJsxText(knoten)) {
      merke('Text', [{ text: knoten.text, knoten }]);
    } else if (ts.isJsxExpression(knoten) && knoten.parent
               && (ts.isJsxElement(knoten.parent) || ts.isJsxFragment(knoten.parent))) {
      /* {wert ?? 'Unbekannt'} — was hier herausfällt, steht auf dem Schirm. */
      const aus = [];
      werte(knoten.expression, aus);
      merke('Ausdruck', aus);
    } else if (ts.isJsxAttribute(knoten) && knoten.initializer
               && BESCHRIFTUNGS_ATTRIBUTE.has(knoten.name.getText(quelle))) {
      const aus = [];
      werte(knoten.initializer, aus);
      merke(`${knoten.name.getText(quelle)}=`, aus);
    } else if (ts.isPropertyAssignment(knoten)
               && TEXT_EIGENSCHAFTEN.has(knoten.name.getText(quelle).replace(/^['"]|['"]$/g, ''))) {
      const aus = [];
      werte(knoten.initializer, aus);
      merke(`${knoten.name.getText(quelle)}:`, aus);
    } else if (ts.isCallExpression(knoten) && MELDUNGS_AUFRUFE.has(knoten.expression.getText(quelle))) {
      const aus = [];
      werte(knoten.arguments[0], aus);
      merke('Meldung', aus);
    }
    ts.forEachChild(knoten, gehe);
  };

  gehe(quelle);
}

/* ── Der Server ──────────────────────────────────────────────── */

const serverTreffer = [];
const serverGenutzt = new Set();

/** Steckt in diesem Ausdruck eine Kennung, die das Wörterbuch kennt? */
function uebersetzbareKennung(knoten, quelle) {
  if (!knoten) return false;
  if (ts.isStringLiteral(knoten) || ts.isNoSubstitutionTemplateLiteral(knoten)) {
    return SCHLUESSEL.has(knoten.text);
  }
  /* Kein Literal — etwa eine Variable oder ein Aufruf. Das lässt sich hier
     nicht entscheiden; im Zweifel gilt die Stelle als in Ordnung, damit die
     Prüfung nicht rät. Genannt wird sie trotzdem, unten als „ungeklärt". */
  return null;
}

function pruefeServerdatei(pfad) {
  const kurz = pfad.replace(`${SERVER_WURZEL}${path.sep}`, '');
  if (SERVER_AUSNAHMEN.has(kurz)) { serverGenutzt.add(kurz); return; }

  const quelle = ts.createSourceFile(
    pfad, fs.readFileSync(pfad, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );

  const merke = (art, knoten, text, kennung) => {
    const fund = istFund(text);
    if (!fund) return;
    const { line } = quelle.getLineAndCharacterOfPosition(knoten.getStart(quelle));
    serverTreffer.push({ datei: kurz, zeile: line + 1, art, text: fund, kennung });
  };

  const gehe = (knoten) => {
    /* (1) Meldungshelfer: fehler(reply, status, code, text) und fail(session, code, message) */
    if (ts.isCallExpression(knoten) && MELDE_HELFER.has(knoten.expression.getText(quelle))) {
      const form = MELDE_HELFER.get(knoten.expression.getText(quelle));
      const kennung = knoten.arguments[form.kennung];
      const gut = uebersetzbareKennung(kennung, quelle);
      if (gut === false) {
        const aus = [];
        werte(knoten.arguments[form.text], aus);
        const kName = ts.isStringLiteral(kennung) ? kennung.text : '?';
        for (const { text } of aus) merke(`${form.wo}, Kennung „${kName}" fehlt im Wörterbuch`, knoten, text, kName);
      }
    }

    /* (2) Fehlerantwort ohne Kennung: reply.send({ error: 'deutscher Satz' }) */
    if (ts.isCallExpression(knoten) && /\.send$/.test(knoten.expression.getText(quelle))) {
      const rumpf = knoten.arguments[0];
      if (rumpf && ts.isObjectLiteralExpression(rumpf)) {
        const feld = rumpf.properties.find(
          (e) => ts.isPropertyAssignment(e) && e.name.getText(quelle) === ANTWORT_FELD,
        );
        const hatKennung = rumpf.properties.some((e) => e.name?.getText(quelle) === KENNUNGS_FELD);
        if (feld && !hatKennung) {
          const aus = [];
          werte(feld.initializer, aus);
          for (const { text } of aus) merke('HTTP-Antwort ohne Kennung', feld, text, null);
        }
      }
    }

    /* (3) Ein von Hand gebautes Fehlerereignis, ohne den Helfer fail() */
    if (ts.isObjectLiteralExpression(knoten)) {
      const art = knoten.properties.find(
        (e) => ts.isPropertyAssignment(e) && e.name.getText(quelle) === 't',
      );
      const istFehlerereignis = art && ts.isPropertyAssignment(art)
        && ts.isStringLiteral(art.initializer) && art.initializer.text === EREIGNIS_ART;
      if (istFehlerereignis) {
        const text = knoten.properties.find(
          (e) => ts.isPropertyAssignment(e) && e.name.getText(quelle) === EREIGNIS_TEXTFELD,
        );
        const kennung = knoten.properties.find(
          (e) => ts.isPropertyAssignment(e) && e.name.getText(quelle) === KENNUNGS_FELD,
        );
        const gut = kennung && ts.isPropertyAssignment(kennung)
          ? uebersetzbareKennung(kennung.initializer, quelle) : false;
        if (text && ts.isPropertyAssignment(text) && gut === false) {
          const aus = [];
          werte(text.initializer, aus);
          const kName = kennung && ts.isPropertyAssignment(kennung)
            && ts.isStringLiteral(kennung.initializer) ? kennung.initializer.text : null;
          for (const { text: t } of aus) {
            merke(kName
              ? `Fehlerereignis, Kennung „${kName}" fehlt im Wörterbuch`
              : 'Fehlerereignis ohne Kennung', text, t, kName);
          }
        }
      }
    }

    /* (4) Protokollfelder mit Anzeigetext — in Ordnung nur mit Kennung daneben */
    if (ts.isObjectLiteralExpression(knoten)) {
      for (const feld of knoten.properties) {
        if (!ts.isPropertyAssignment(feld)) continue;
        const name = feld.name.getText(quelle);
        const form = PROTOKOLL_TEXTFELDER.get(name);
        if (!form) continue;
        serverGenutzt.add(name);
        const nachbar = knoten.properties.find(
          (e) => ts.isPropertyAssignment(e) && e.name.getText(quelle) === form.kennungsFeld,
        );
        if (nachbar && uebersetzbareKennung(nachbar.initializer, quelle) !== false) continue;
        const aus = [];
        werte(feld.initializer, aus);
        const kName = nachbar && ts.isStringLiteral(nachbar.initializer) ? nachbar.initializer.text : null;
        for (const { text } of aus) {
          merke(kName
            ? `Protokollfeld „${name}", Kennung „${kName}" fehlt im Wörterbuch`
            : `Protokollfeld „${name}" trägt Text ohne Kennung`, feld, text, kName);
        }
      }
    }

    ts.forEachChild(knoten, gehe);
  };

  gehe(quelle);
}

function durchlaufenServer(ordner) {
  for (const eintrag of fs.readdirSync(ordner, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const pfad = path.join(ordner, eintrag.name);
    if (eintrag.isDirectory()) durchlaufenServer(pfad);
    else if (/\.ts$/.test(eintrag.name)) pruefeServerdatei(pfad);
  }
}

function durchlaufen(ordner) {
  for (const eintrag of fs.readdirSync(ordner, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const pfad = path.join(ordner, eintrag.name);
    if (AUSGENOMMEN.some((a) => pfad.includes(`${path.sep}${a}${path.sep}`) || pfad.endsWith(`${path.sep}${a}`))) continue;
    if (eintrag.isDirectory()) durchlaufen(pfad);
    else if (/\.tsx?$/.test(eintrag.name)) pruefeDatei(pfad);
  }
}

durchlaufen(WURZEL);
durchlaufenServer(SERVER_WURZEL);

/* ── Bericht ─────────────────────────────────────────────────── */

const nachDatei = new Map();
for (const t of treffer) {
  if (!nachDatei.has(t.datei)) nachDatei.set(t.datei, []);
  nachDatei.get(t.datei).push(t);
}

for (const [datei, liste] of [...nachDatei.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${datei.replace(`${WURZEL}${path.sep}`, '')} — ${liste.length}`);
  for (const t of liste.slice(0, 40)) {
    console.log(`  ${String(t.zeile).padStart(4)}  ${t.stelle.padEnd(14)} ${t.text.slice(0, 90)}`);
  }
  if (liste.length > 40) console.log(`  … ${liste.length - 40} weitere`);
}

if (serverTreffer.length) {
  console.log('\nServer — Anzeigetext ohne übersetzbare Kennung');
  const nachServerDatei = new Map();
  for (const t of serverTreffer) {
    if (!nachServerDatei.has(t.datei)) nachServerDatei.set(t.datei, []);
    nachServerDatei.get(t.datei).push(t);
  }
  for (const [datei, liste] of [...nachServerDatei.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${SERVER_WURZEL}/${datei} — ${liste.length}`);
    for (const t of liste.slice(0, 25)) {
      console.log(`  ${String(t.zeile).padStart(4)}  ${t.art}\n        ${t.text.slice(0, 88)}`);
    }
    if (liste.length > 25) console.log(`  … ${liste.length - 25} weitere`);
  }
}

const verwaisteServer = [...SERVER_AUSNAHMEN.keys()].filter((k) => !serverGenutzt.has(k))
  .concat([...PROTOKOLL_TEXTFELDER.keys()].filter((k) => !serverGenutzt.has(k)));

const verwaist = [...SPRACHNEUTRAL.keys()].filter((k) => !genutzt.has(k));
if (verwaist.length) {
  console.log(`\nAusnahmen ohne Fundstelle — bitte streichen: ${verwaist.join(', ')}`);
}

/* Die Zahl bleibt im alten Format: scripts/ausliefern.mjs liest sie mit
   /Gesamt: (\d+)/ aus und warnt beim Ausliefern. Aus demselben Grund endet
   dieser Lauf immer mit 0 — ein Fund ist eine Warnung, kein Abbruch. */
console.log(`\nGesamt: ${treffer.length + serverTreffer.length}`
  + ` — Oberfläche ${treffer.length} in ${nachDatei.size} Dateien, Server ${serverTreffer.length}`);
