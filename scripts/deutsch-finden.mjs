#!/usr/bin/env node
/**
 * Findet Texte, die fest im Code stehen statt aus dem Wörterbuch zu kommen —
 * und Schlüssel, die im Code stehen, aber in keinem Wörterbuch existieren.
 *
 * FASSUNG 3 — WARUM ES DIESE ÜBERARBEITUNG BRAUCHTE
 * Fassung 2 (siehe Git-Verlauf) las bereits den Syntaxbaum statt Zeile für
 * Zeile zu raten, ob irgendwo Deutsch steht — ein echter Fortschritt
 * gegenüber Fassung 1. Trotzdem meldete sie zuletzt nur 4 Funde, obwohl allein
 * eine einzige Datei (electron/main.ts) rund 35 deutsche Menüzeilen enthält.
 * Der Grund war nicht die Grundidee, sondern wie eng sie gezogen war:
 *
 *   · WURZEL zeigte nur auf packages/desktop/src — der komplette Ordner
 *     packages/desktop/electron (main.ts, fernsteuerung.ts, updater.ts,
 *     zusammen rund 1800 Zeilen) wurde nie durchlaufen. Das ist der einzelne
 *     größte Grund für die Untererfassung.
 *   · TEXT_EIGENSCHAFTEN kannte nur deutsche Feldnamen (titel, hinweis, …).
 *     Electrons eigene APIs verlangen aber die englischen Feldnamen ihrer
 *     Optionsobjekte — `message`, `detail`, `buttons`, `subject`. Ohne diese
 *     Namen in der Liste wäre selbst ein durchlaufener electron/-Ordner an
 *     dialog.showMessageBox({ message, detail, buttons }) vorbeigelaufen.
 *   · `buttons: ['Abbrechen', 'Verbinden']` ist ein Array — werte() gab
 *     Arrays nie einzeln aus, nur einzelne Ausdrücke.
 *   · Serverseitig prüfte MELDE_HELFER['fehler'] mit kennung:1, text:2 —
 *     das war die Argumentreihenfolge von fail(session, code, message)
 *     (3 Argumente), nicht von fehler(reply, status, code, text, werte?)
 *     (5 Argumente, Kennung an Index 2). Weil arguments[1] bei fehler() eine
 *     Zahl ist (der HTTP-Status), traf uebersetzbareKennung() für JEDEN
 *     fehler()-Aufruf den "kann ich nicht entscheiden"-Zweig (liefert
 *     `null`, nicht `false`) — und `if (gut === false)` feuerte nie. Jeder
 *     fehler()-Aufruf im ganzen Server war dadurch blind, unabhängig vom
 *     Text. Belegt: die vier vom Auftraggeber genannten fehlenden Schlüssel
 *     (rolleZuHoch, avatarLaeuft, teilLaeuft, uploadLaeuft, dazu systemwerte,
 *     unbekannteGruppe, zuKurz) laufen alle über fehler() und wurden alle
 *     nicht gemeldet — genau wie durch diesen Fehler zu erwarten.
 *   · Der Fund einer fehlenden Kennung hing an einem GLEICHZEITIG
 *     literalen Text daneben. fail(session, 'fehler.projektName',
 *     (err as Error).message) hat aber einen dynamischen Text — kein Fund
 *     möglich, selbst mit korrekten Indizes, weil werte() an einer
 *     PropertyAccessExpression nichts extrahiert. Die fehlende KENNUNG ist
 *     aber unabhängig vom Text prüfbar. Fassung 3 trennt beides: eine
 *     Kennung wird jetzt geprüft, sobald sie ein Zeichenkettenliteral ist —
 *     ganz gleich, was daneben steht (siehe fehlendeSchluessel unten).
 *   · push.sendenAn(...) — der einzige Weg, wie Push-Benachrichtigungen
 *     verschickt werden, und genau das, was auf Sperrbildschirmen landet —
 *     war in keiner der vier Fallunterscheidungen von pruefeServerdatei()
 *     als Abfluss bekannt. Sechs Aufrufstellen mit festem deutschem Titel
 *     liefen an der Prüfung vollständig vorbei.
 *   · Der Systemtext "@name ist dem Kanal beigetreten" (ws/gateway.ts) wird
 *     direkt in die Datenbank geschrieben und später roh angezeigt — weder
 *     eine HTTP-Antwort noch ein WS-Fehlerereignis, also von keiner der
 *     vorhandenen Regeln erfasst.
 *   · Der Ausnahme-Eintrag für die Betreiberkonsole verwies noch auf
 *     'http/konsole.ts' — die Datei liegt inzwischen unter
 *     'http/konsole/seite.ts'. Die Ausnahme griff dadurch nie mehr, und der
 *     Mechanismus, der genau das gemeldet hätte (verwaisteServer), wurde
 *     zwar berechnet, aber nirgends ausgegeben. Eine Prüfung, die ihre
 *     eigenen toten Ausnahmen nicht meldet, ist doppelt blind.
 *
 * Fassung 3 behebt diese Lücken strukturell, nicht mit Sonderfällen für
 * einzelne Zeilen: mehr Anzeigestellen, mehr Abflüsse, eine unabhängige
 * Schlüsselprüfung, und für Stellen, an denen sich "erreicht das einen
 * Menschen?" nicht automatisch entscheiden lässt, einen dritten Eimer
 * (UNGEKLÄRT) statt eine Vermutung in die eine oder andere Richtung.
 *
 * WAS WEITERHIN GILT (aus Fassung 2 übernommen)
 * · Kommentare sind keine Zeichenketten und tauchen im Baum gar nicht auf.
 * · console.*, Protokollzeilen, die Betreiberkonsole und die Wörterbücher
 *   selbst sind ausdrücklich keine Anzeigestellen.
 * · Es gibt bewusst keine Liste ausgenommener DATEIEN — nur ausgenommener
 *   TEXTE und STELLEN, mit Begründung, in scripts/deutsch-ausnahmen.mjs.
 *   Eine Prüfung, die eine ganze Datei überspringt, weil dort gerade
 *   jemand arbeitet, meldet dauerhaft grün, und niemand merkt es.
 *
 * WOHER DIE WÖRTERBÜCHER KOMMEN
 * Diese Prüfung geht NICHT von packages/desktop/src/i18n aus. Sie sucht
 * unter packages/*'/src (und notfalls direkt unter der Projektwurzel) nach
 * einem Ordner mit vielen zweibuchstabigen Dateien (de.ts, en.ts, fr.ts, …)
 * — siehe findeWoerterbuchOrdner(). Der Server kann heute nicht auf
 * packages/desktop/src/i18n zugreifen (anderes Anwendungspaket) — das ist
 * der eigentliche Grund, warum es dort keinen deutschfreien Pfad gibt. Zieht
 * das Wörterbuch nach packages/shared um, braucht diese Datei keine
 * Änderung: sie findet es dort genauso.
 *
 * NACHTRAG — ECHTER EXIT-CODE, SCHWELLE, UND EIN DRITTER GEFUNDENER FEHLER
 * Bis hierher lief diese Prüfung — trotz "harte Funde" im Bericht — IMMER
 * mit Exit-Code 0 durch. Der Exit-Code entscheidet jetzt wirklich, aber
 * nicht per "irgendein Fund → Abbruch": mit 259 zum Zeitpunkt dieser Änderung
 * bereits bestehenden Funden hätte das sofort jede Auslieferung blockiert,
 * ohne dass in der Zwischenzeit auch nur einer davon behoben werden konnte.
 * Stattdessen ein Ratchet über eine Schwelle je Datei — Begründung, Aufbau
 * und alle Regeln dazu stehen bei der SCHWELLE-Sektion weiter unten, nicht
 * hier, damit sie neben dem Code steht, den sie erklärt.
 *
 * Beim Nachprüfen der beiden oben protokollierten Fehler (Argumentindex bei
 * fehler(), verwaiste Ausnahme nach dem Umzug von http/konsole.ts) kam ein
 * DRITTER ans Licht, derselben Familie: ausgenommeneStelle() schnitt bei
 * einer "ordner/**"-Ausnahme drei Zeichen ab ("/**") statt zwei ("**") und
 * verlor damit den abschließenden Schrägstrich vor dem Präfix-Vergleich.
 * 'http/konsole/**' deckte dadurch per startsWith() auch 'http/konsole.ts'
 * ab — eine gleichnamige DATEI direkt NEBEN dem Ordner, kein Ordnerinhalt.
 * Das traf hier durch Zufall das Richtige (die Datei sollte ohnehin
 * ausgenommen sein), war als Mechanismus aber falsch und wäre bei jeder
 * künftigen "ordner/**"-Ausnahme mit gleichnamigem Datei-Nachbarn erneut
 * falsch gewesen. Behoben in ausgenommeneStelle(); die jetzt wieder nötige
 * Ausnahme für die Datei selbst steht als eigener Eintrag in
 * deutsch-ausnahmen.mjs. Der Fund kam nicht aus Testen, sondern aus dem
 * Nachvollziehen von "warum genau matcht dieser Präfix hier" — derselbe
 * Blick, den auch das Nachtragen der SCHWELLE erzwungen hat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { TEXTE as AUSNAHME_TEXTE, STELLEN as AUSNAHME_STELLEN, pruefeAusnahmen } from './deutsch-ausnahmen.mjs';

pruefeAusnahmen();

const REPO_WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(REPO_WURZEL, p).split(path.sep).join('/');

/* ── Wörterbuch lokalisieren ──────────────────────────────────────
   Kein fester Pfad — siehe Dateikopf. Wer die Wörterbücher verschiebt,
   muss hier nichts ändern. */
function findeWoerterbuchOrdner(wurzel) {
  const ZWEI_BUCHSTABEN = /^[a-z]{2}\.ts$/;
  const UEBERSPRINGEN = new Set(['node_modules', 'dist', 'build', 'dist-electron', '.git']);
  const kandidatenWurzeln = [];
  const paketeOrdner = path.join(wurzel, 'packages');
  if (fs.existsSync(paketeOrdner)) {
    for (const eintrag of fs.readdirSync(paketeOrdner, { withFileTypes: true })) {
      if (eintrag.isDirectory()) kandidatenWurzeln.push(path.join(paketeOrdner, eintrag.name, 'src'));
    }
  }
  kandidatenWurzeln.push(wurzel);

  /* Mehrere Kandidatenwurzeln überlappen (jedes packages/*'/src UND, als
     Rückfall, die ganze Projektwurzel) — ohne Entdopplung nach aufgelöstem
     Pfad taucht derselbe Ordner zweimal in `gefunden` auf. */
  const gefundenNachPfad = new Map(); // aufgelöster Pfad -> Anzahl Sprachdateien
  const durchsuchen = (ordner, tiefe) => {
    if (tiefe > 4 || !fs.existsSync(ordner)) return;
    let eintraege;
    try { eintraege = fs.readdirSync(ordner, { withFileTypes: true }); } catch { return; }
    const dateiNamen = eintraege.filter((e) => e.isFile()).map((e) => e.name);
    const spracheDateien = dateiNamen.filter((n) => ZWEI_BUCHSTABEN.test(n));
    if (spracheDateien.length >= 15 && dateiNamen.includes('de.ts')) {
      gefundenNachPfad.set(path.resolve(ordner), spracheDateien.length);
      return;
    }
    for (const e of eintraege) {
      if (!e.isDirectory() || UEBERSPRINGEN.has(e.name)) continue;
      durchsuchen(path.join(ordner, e.name), tiefe + 1);
    }
  };
  for (const k of kandidatenWurzeln) durchsuchen(k, 0);

  const gefunden = [...gefundenNachPfad.keys()];
  if (!gefunden.length) {
    throw new Error(
      'Wörterbuch-Ordner nicht gefunden — erwartet einen Ordner mit vielen zweibuchstabigen '
      + 'Dateien wie de.ts, en.ts, fr.ts unter packages/*/src (oder direkt unter der Projektwurzel).',
    );
  }
  if (gefunden.length === 1) return gefunden[0];

  /* Mehr als ein Ordner erfüllt die Form (z. B. auch ein Ordner mit
     Emoji-Namen je Sprache) — bevorzugt wird ein Ordner namens "i18n", sonst
     der mit den meisten Sprachdateien (das eigentliche Wörterbuch bedient
     alle 22 Sprachen, ein Nebendatensatz meist weniger). Beides ist ein
     Vorrang unter mehreren strukturell passenden Kandidaten, kein fester
     Pfad — nach dem geplanten Umzug nach packages/shared trifft dieselbe
     Regel wieder zu, sofern der Ordner weiterhin "i18n" heißt. */
  const mitI18nNamen = gefunden.filter((g) => path.basename(g) === 'i18n');
  const rangliste = (mitI18nNamen.length ? mitI18nNamen : gefunden)
    .sort((a, b) => gefundenNachPfad.get(b) - gefundenNachPfad.get(a));
  console.warn(`Warnung: mehrere Wörterbuch-artige Ordner gefunden — nehme ${rel(rangliste[0])} `
    + `(alle: ${gefunden.map((g) => `${rel(g)} [${gefundenNachPfad.get(g)} Sprachdateien]`).join(', ')})`);
  return rangliste[0];
}

const WOERTERBUCH_ORDNER = findeWoerterbuchOrdner(REPO_WURZEL);
const DE_DATEI = path.join(WOERTERBUCH_ORDNER, 'de.ts');

/** Entfernt Klammern und `as X` / `satisfies X` um einen Ausdruck herum —
 *  `{ … } as const` ist im Baum eine AsExpression, KEIN ObjectLiteralExpression
 *  direkt. Ohne dieses Entpacken sah ladeSchluesselMenge() de.ts (das genau so
 *  endet: "} as const;") als objektlos an und lud null Schlüssel — mit der
 *  Folge, dass jede Kennungsprüfung im ganzen Lauf "fehlt im Wörterbuch"
 *  meldete, auch für Kennungen, die längst existieren. */
function entpacke(knoten) {
  while (knoten && (ts.isParenthesizedExpression(knoten) || ts.isAsExpression(knoten) || ts.isSatisfiesExpression?.(knoten))) {
    knoten = knoten.expression;
  }
  return knoten;
}

/** Alle Schlüssel der Ausgangssprache — per Syntaxbaum, nicht per Zeilen-Regex,
 *  damit Formatierungsänderungen in de.ts diese Prüfung nicht stillschweigend
 *  blind machen. */
function ladeSchluesselMenge(deDatei) {
  const quelle = ts.createSourceFile(deDatei, fs.readFileSync(deDatei, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const schluessel = new Set();
  for (const stmt of quelle.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer && entpacke(decl.initializer);
      if (!init || !ts.isObjectLiteralExpression(init)) continue;
      for (const prop of init.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        if (ts.isStringLiteral(prop.name)) schluessel.add(prop.name.text);
        else if (ts.isIdentifier(prop.name)) schluessel.add(prop.name.text);
      }
    }
  }
  if (!schluessel.size) throw new Error(`Keine Schlüssel in ${rel(deDatei)} gefunden — Format geändert? ladeSchluesselMenge() prüfen.`);
  return schluessel;
}

const SCHLUESSEL = ladeSchluesselMenge(DE_DATEI);
const SCHLUESSEL_MUSTER = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/;

/* ── Ausnahmen: Abgleich + Nutzungs-Tracking ──────────────────────
   Jede Ausnahme, die im Lauf greift, wird vermerkt — am Ende meldet der
   Bericht, welche NIE gegriffen haben (siehe Dateikopf von
   deutsch-ausnahmen.mjs). Anders als in Fassung 2 wird das auch wirklich
   ausgegeben. */
const textAusnahmeGenutzt = new Set();
const stelleAusnahmeGenutzt = new Set();

function ausgenommenText(text) {
  const eintrag = AUSNAHME_TEXTE.find((e) => e.text === text);
  if (!eintrag) return false;
  textAusnahmeGenutzt.add(eintrag.text);
  return true;
}

function ausgenommeneStelle(dateiRel, zeile) {
  for (const e of AUSNAHME_STELLEN) {
    const ordnerWeit = e.datei.endsWith('/**');
    /* slice(0, -2) — nur "**" abschneiden, der Schrägstrich davor bleibt
       stehen. Stand hier einmal -3 (schnitt "/**" komplett weg): dann matchte
       z. B. 'http/konsole/**' per startsWith() auch 'http/konsole.ts' — ein
       gleichnamiger DATEI-Nachbar des Ordners, kein Ordnerinhalt. Traf durch
       Zufall das Richtige (die Datei sollte ohnehin ausgenommen sein, siehe
       deutsch-ausnahmen.mjs), war aber als Mechanismus falsch: jede künftige
       "ordner/**"-Ausnahme hätte auch einen bloß gleich benannten Nachbarn
       ohne Schrägstrich mitgedeckt, unabhängig davon, ob das gewollt ist. */
    const praefix = ordnerWeit ? e.datei.slice(0, -2) : e.datei;
    const dateiPasst = ordnerWeit ? dateiRel.startsWith(praefix) : dateiRel === e.datei;
    if (!dateiPasst) continue;
    if (e.zeile !== undefined && e.zeile !== zeile) continue;
    stelleAusnahmeGenutzt.add(`${e.datei}${e.zeile ? `:${e.zeile}` : ''}`);
    return true;
  }
  return false;
}

/* ── Textbeurteilung ──────────────────────────────────────────────
   Rein formale Filter — nichts hier weiß, ob ein Text deutsch ist. Was
   durchkommt, ist ein FUND, unabhängig von Sprache und Länge. */
function istFund(roh) {
  const text = roh.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  /* Erst ab zwei zusammenhängenden Buchstaben wird aus Satzzeichen/Zahlen/
     Emoji/Einzelbuchstaben ein Wort. */
  if (!/\p{L}{2,}/u.test(text)) return null;
  if (/^https?:\/\//.test(text)) return null;
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(text)) return null;
  if (/^\.[A-Za-z0-9.]+( \/ \.[A-Za-z0-9.]+)*$/.test(text)) return null;
  if (/^var\(--/.test(text)) return null;
  return text;
}

/** Sieht der Text nach einer SQL-Anweisung oder einer Spaltenliste aus
 *  ("id, art, thema, inhalt, …" / "v.*, c.name AS channel_name, …")? Top-Level-
 *  Konstanten mit genau dieser Form gibt es in packages/server/src mehrfach
 *  (SPALTEN-Konstanten für `SELECT ${SPALTEN} FROM …`) — jedes Komma trennt
 *  dort ein einzelnes Wort, und ein simpler Wortzähler liest das wie eine
 *  Aufzählung aus drei Wörtern. Ein echter Satz hat fast nie bei JEDEM
 *  einzelnen Wort ein Komma dazwischen. */
function siehtNachDatenAus(text) {
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|PRAGMA|DROP)\s/i.test(text)) return true;
  const teile = text.split(',').map((t) => t.trim()).filter(Boolean);
  return teile.length >= 3 && teile.every((t) => /^[A-Za-z_][A-Za-z0-9_.*]*(\s+AS\s+[A-Za-z_][A-Za-z0-9_]*)?$/i.test(t));
}

/** Sieht der Text nach einem Satz aus (mindestens drei Wörter mit Buchstaben,
 *  und keine SQL-/Spaltenliste)? Dient als Torwächter für Regeln, die sonst
 *  zu leicht auf technischen Werten (Einheiten, Codes, Bezeichnerlisten)
 *  anschlagen würden. */
function mehrereWorte(text) {
  const worte = text.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w));
  if (worte.length < 3) return false;
  return !siehtNachDatenAus(text);
}

function ausHtmlText(text) {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-zA-Z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function eigenschaftsName(node, quelle) {
  if (!node) return '';
  return node.getText(quelle).replace(/^['"]|['"]$/g, '');
}

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
  if (ts.isAsExpression(knoten) || ts.isTypeAssertionExpression?.(knoten)) return werte(knoten.expression, aus);
  if (ts.isArrayLiteralExpression(knoten)) {
    for (const el of knoten.elements) werte(el, aus);
    return;
  }
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

/* ── Ergebnis-Sammlung ─────────────────────────────────────────── */
const treffer = [];          // harte Funde — zählen für den Exit-Code
const unklar = [];            // UNGEKLÄRT — wird gemeldet, zählt aber nicht als Fund
const fehlendeSchluessel = []; // im Code verwendet, in SCHLUESSEL nicht vorhanden

function merke(ziel, paket, dateiRel, zeileNr, stelle, rohText) {
  const fund = istFund(rohText);
  if (!fund) return;
  if (SCHLUESSEL.has(fund)) return;        // 'tour.welcomeTitle' & co: ein Schlüssel, kein Text
  if (ausgenommenText(fund)) return;
  if (ausgenommeneStelle(dateiRel, zeileNr)) return;
  ziel.push({ paket, datei: dateiRel, zeile: zeileNr, stelle, text: fund });
}

function merkeSchluessel(dateiRel, zeileNr, schluessel, wo) {
  if (!SCHLUESSEL_MUSTER.test(schluessel)) return;
  if (SCHLUESSEL.has(schluessel)) return;
  fehlendeSchluessel.push({ datei: dateiRel, zeile: zeileNr, schluessel, wo });
}

function zeileVon(quelle, knoten) {
  return quelle.getLineAndCharacterOfPosition(knoten.getStart(quelle)).line + 1;
}

/** Eine Zeichenkette/ein Vorlagenliteral ohne Ersetzung als möglicher
 *  Übersetzungsschlüssel — prüft KEY_SHAPE und Wörterbuch, unabhängig davon,
 *  ob daneben ein literaler Text steht.
 *
 *  ERST ENTPACKEN, DANN PRÜFEN — vierte gefundene blinde Stelle dieses Gates.
 *  `t('verkaufMeldung.nav' as TranslationKey)` ist im Syntaxbaum eine
 *  AsExpression, KEIN StringLiteral. Ohne entpacke() fiel jeder solche Aufruf
 *  hier stumm heraus: die Kennung wurde nie gegen das Wörterbuch gehalten.
 *  Das ist keine Randform — die Umschreibung auf `as TranslationKey` ist im
 *  Haus die übliche Brücke, solange ein Schlüssel im Wörterbuch noch fehlt,
 *  also genau der Fall, den diese Prüfung finden soll. werte() (der
 *  Textsucher nebenan) entpackt AsExpression längst; dass die Kennungsprüfung
 *  es nicht tat, war der Unterschied zwischen beiden. */
function pruefeSchluesselArgument(knoten, quelle, dateiRel, wo) {
  const kern = entpacke(knoten);
  if (!kern || !ts.isStringLiteral(kern)) return;
  merkeSchluessel(dateiRel, zeileVon(quelle, kern), kern.text, wo);
}

/** Ist dieser Ausdruck eine Zeichenkette, die im Wörterbuch steht? `null`
 *  heißt "kein Literal, nicht entscheidbar" — bewusst NICHT `false`, damit
 *  eine Variable oder ein Aufruf hier nicht wie eine fehlende Kennung
 *  behandelt wird. */
function uebersetzbareKennung(knoten) {
  if (!knoten) return false;
  if (ts.isStringLiteral(knoten) || ts.isNoSubstitutionTemplateLiteral(knoten)) return SCHLUESSEL.has(knoten.text);
  return null;
}

/** Ein HTML-Dokument, das als Vorlagenliteral im Code steht (Download-Seite,
 *  Konsolen-Seite, …). Wird an der Stelle des Vorlagenliterals selbst erkannt
 *  — kein Aufruf-/Eigenschaftskontext nötig, im Gegensatz zu den übrigen
 *  Regeln. Jeder Textabschnitt zwischen zwei `${}`-Einsetzungen wird für sich
 *  geprüft, damit die Zeilenangabe stimmt und Markup/CSS vorher entfernt
 *  werden kann. */
function pruefeHtmlVorlage(knoten, quelle, paket, dateiRel) {
  let ganzerText;
  let teile;
  if (ts.isNoSubstitutionTemplateLiteral(knoten)) {
    ganzerText = knoten.text;
    teile = [{ text: knoten.text, knoten }];
  } else if (ts.isTemplateExpression(knoten)) {
    ganzerText = knoten.head.text + knoten.templateSpans.map((s) => s.literal.text).join('');
    teile = [{ text: knoten.head.text, knoten: knoten.head },
      ...knoten.templateSpans.map((s) => ({ text: s.literal.text, knoten: s.literal }))];
  } else {
    return false;
  }
  if (!/<!doctype\s+html/i.test(ganzerText) && !/<html[\s>]/i.test(ganzerText)) return false;

  for (const { text, knoten: n } of teile) {
    const bereinigt = ausHtmlText(text);
    if (!mehrereWorte(bereinigt)) continue;
    merke(treffer, paket, dateiRel, zeileVon(quelle, n), 'HTML-Text', bereinigt.slice(0, 100));
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════
   OBERFLÄCHE — packages/desktop/src, packages/desktop/electron,
   packages/shared/src
   ═══════════════════════════════════════════════════════════════ */

/* Attribute und Eigenschaften, deren Wert eine Person zu sehen bekommt.
   Alles andere (className, role, type, key, data-*, Stilangaben …) ist
   ausdrücklich keine Anzeigestelle. */
const BESCHRIFTUNGS_ATTRIBUTE = new Set([
  'title', 'placeholder', 'alt', 'label', 'sub', 'subtitle', 'caption',
  'hint', 'hinweis', 'titel', 'beschreibung', 'text', 'body', 'tooltip',
  'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext',
]);

/* Eigenschaftsnamen von Objektliteralen, die Anzeigetext tragen — deutsche
   Namen, wie sie die App selbst benutzt (titel, hinweis, meldung, …), UND
   die englischen Namen, die Electrons eigene APIs verlangen (message,
   detail, buttons, subject, …). Ohne Letztere liefe selbst ein durchlaufener
   electron/-Ordner an dialog.showMessageBox({ message, detail, buttons })
   vorbei — das war die zweite Ursache der Untererfassung, siehe Dateikopf. */
const TEXT_EIGENSCHAFTEN = new Set([
  'title', 'titel', 'body', 'text', 'label', 'beschriftung', 'sub', 'subtitle',
  'placeholder', 'hint', 'hinweis', 'note', 'notiz', 'beschreibung', 'caption',
  'frage', 'meldung', 'nachricht',
  /* Electron- / Web-API-Feldnamen (englisch, siehe Begründung oben): */
  'message', 'detail', 'subject', 'buttons', 'checkboxLabel', 'buttonLabel',
]);

/* Aufrufe, deren erstes Argument als Fenster erscheint. */
const MELDUNGS_AUFRUFE = new Set([
  'alert', 'confirm', 'prompt', 'window.alert', 'window.confirm', 'window.prompt',
]);

/* Übersetzungsfunktionen — für die Rückwärtsprüfung "Schlüssel im Code, aber
   nicht im Wörterbuch". `translate(sprache, schluessel, werte?)` hat den
   Schlüssel an Index 1, `t`/`tStatisch(schluessel, werte?)` an Index 0. Der
   Name allein wäre ein zu schwaches Signal (irgendeine lokale Variable
   könnte zufällig `t` heißen) — deshalb prüft pruefeSchluesselArgument()
   zusätzlich SCHLUESSEL_MUSTER (verlangt einen Punkt: "kategorie.name"),
   bevor überhaupt etwas gemeldet wird. */
const SCHLUESSEL_AUFRUFE_INDEX_0 = new Set(['t', 'tStatisch']);
const SCHLUESSEL_AUFRUFE_INDEX_1 = new Set(['translate']);

/* throw new Error(...) wird nur dort gewertet, wo ein Wurf plausibel bei
   einem Menschen landet, statt geraten zu werden: im Electron-Hauptprozess
   (uncaught → Systemdialog, oder von Hand in dialog.showMessageBox
   gefangen — siehe updater.ts) und, serverseitig weiter unten, in
   services/** (siehe dortige Begründung). Für packages/desktop/src wird es
   bewusst NICHT geprüft: ob ein React-Wurf einen Menschen erreicht, hängt
   vom jeweiligen catch/Error-Boundary ab — das wäre Raten, siehe Dateikopf
   von Fassung 2. */
function pruefeThrowNewError(knoten, quelle, paket, dateiRel) {
  if (!ts.isThrowStatement(knoten) || !knoten.expression || !ts.isNewExpression(knoten.expression)) return;
  const name = knoten.expression.expression.getText(quelle);
  if (!['Error', 'TypeError', 'RangeError', 'SyntaxError'].includes(name)) return;
  const arg0 = knoten.expression.arguments?.[0];
  const aus = [];
  werte(arg0, aus);
  for (const { text, knoten: n } of aus) merke(treffer, paket, dateiRel, zeileVon(quelle, n), 'throw new Error', text);
}

function pruefeClientArtigeDatei(pfad, paket, art) {
  const dateiRel = rel(pfad);
  const quelle = ts.createSourceFile(
    pfad, fs.readFileSync(pfad, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );

  const gehe = (knoten) => {
    /* HTML-Vorlage (z. B. eine per Vorlagenliteral gebaute Seite) — erkannt
       am Vorlagenliteral selbst, unabhängig vom umgebenden Kontext. Trifft
       das zu, wird der Knoten hier vollständig behandelt; die übrigen Regeln
       unten interpretieren dieselbe Zeichenkette dann nicht zusätzlich. */
    if ((ts.isTemplateExpression(knoten) || ts.isNoSubstitutionTemplateLiteral(knoten))
        && pruefeHtmlVorlage(knoten, quelle, paket, dateiRel)) {
      ts.forEachChild(knoten, gehe);
      return;
    }

    if (ts.isJsxText(knoten)) {
      merke(treffer, paket, dateiRel, zeileVon(quelle, knoten), 'Text', knoten.text);
    } else if (ts.isJsxExpression(knoten) && knoten.parent
               && (ts.isJsxElement(knoten.parent) || ts.isJsxFragment(knoten.parent))) {
      /* {wert ?? 'Unbekannt'} — was hier herausfällt, steht auf dem Schirm. */
      const aus = [];
      werte(knoten.expression, aus);
      for (const { text, knoten: n } of aus) merke(treffer, paket, dateiRel, zeileVon(quelle, n), 'Ausdruck', text);
    } else if (ts.isJsxAttribute(knoten) && knoten.initializer
               && BESCHRIFTUNGS_ATTRIBUTE.has(eigenschaftsName(knoten.name, quelle))) {
      const aus = [];
      werte(knoten.initializer, aus);
      const attrName = eigenschaftsName(knoten.name, quelle);
      for (const { text, knoten: n } of aus) merke(treffer, paket, dateiRel, zeileVon(quelle, n), `${attrName}=`, text);
    } else if ((ts.isPropertyAssignment(knoten) || ts.isShorthandPropertyAssignment(knoten))
               && TEXT_EIGENSCHAFTEN.has(eigenschaftsName(knoten.name, quelle))) {
      const propName = eigenschaftsName(knoten.name, quelle);
      const init = ts.isPropertyAssignment(knoten) ? knoten.initializer : knoten.name;
      const aus = [];
      werte(init, aus);
      for (const { text, knoten: n } of aus) merke(treffer, paket, dateiRel, zeileVon(quelle, n), `${propName}:`, text);
    } else if (ts.isCallExpression(knoten) && MELDUNGS_AUFRUFE.has(knoten.expression.getText(quelle))) {
      const aus = [];
      werte(knoten.arguments[0], aus);
      for (const { text, knoten: n } of aus) merke(treffer, paket, dateiRel, zeileVon(quelle, n), 'Meldung', text);
    } else if (ts.isCallExpression(knoten)) {
      /* Rückwärtsprüfung: ein Schlüssel im Code, den es im Wörterbuch nicht
         gibt. Unabhängig von den Regeln oben — ein Aufruf kann zugleich
         "kein Fund" (weil er ja gerade einen Schlüssel benutzt, keinen
         Text) und trotzdem eine fehlende Kennung sein. */
      const name = knoten.expression.getText(quelle);
      if (SCHLUESSEL_AUFRUFE_INDEX_0.has(name)) {
        pruefeSchluesselArgument(knoten.arguments[0], quelle, dateiRel, `${name}(…)`);
      } else if (SCHLUESSEL_AUFRUFE_INDEX_1.has(name)) {
        pruefeSchluesselArgument(knoten.arguments[1], quelle, dateiRel, `${name}(…)`);
      }
    }

    if (art === 'electron') pruefeThrowNewError(knoten, quelle, paket, dateiRel);

    ts.forEachChild(knoten, gehe);
  };

  gehe(quelle);
}

/* ═══════════════════════════════════════════════════════════════
   SERVER — packages/server/src
   ═══════════════════════════════════════════════════════════════
   Dort ist Deutsch überwiegend richtig: Kommentare, Protokollausgaben, die
   Konsole auf dem Pi, Anweisungen an das Sprachmodell. Falsch ist es nur an
   den Stellen, an denen Text den Server verlässt und ungefiltert beim
   Benutzer landet. Die Abflüsse sind unten namentlich aufgezählt — das ist
   Absicht und zugleich die Grenze dieser Prüfung: sie kennt die
   vorhandenen Abflüsse, sie errät keine neuen (siehe Dateikopf, "eine
   ratende Prüfung ist schlimmer als keine"). */

const PAKET_SERVER = 'Server';

/** Helfer, die eine Meldung an den Client schicken: an welcher
 *  Argumentstelle steht die Kennung, an welcher der deutsche Rückfalltext.
 *  fehler(reply, status, code, text, werte?) → Kennung an Index 2 (NICHT 1
 *  — 1 ist der HTTP-Status, eine Zahl; das war der Fehler in Fassung 2,
 *  siehe Dateikopf). fail(session, code, message) → Kennung an Index 1. */
const MELDE_HELFER = new Map([
  ['fehler', { kennung: 2, text: 3, wo: 'HTTP-Antwort' }],
  ['fail', { kennung: 1, text: 2, wo: 'WS-Meldung' }],
]);

/* Ein Objekt mit diesem Feld ist eine Fehlerantwort. Ohne ein Feld „code"
   daneben hat die Oberfläche nichts, was sie übersetzen könnte. */
const ANTWORT_FELD = 'error';
const KENNUNGS_FELD = 'code';

/* Ein von Hand gebautes Fehlerereignis über die Ereignisleitung, erkannt an
   seiner Bauform: t: 'error' mit einem Textfeld. */
const EREIGNIS_ART = 'error';
const EREIGNIS_TEXTFELD = 'message';

/* Felder des Protokolls, die ausdrücklich Anzeigetext tragen, und das Feld
   daneben, in dem die Kennung dazu steht. */
const PROTOKOLL_TEXTFELDER = new Map([
  ['note', { kennungsFeld: 'noteCode', wo: 'AiCapabilities.note — Einstellungen, „Übersetzungs-Dienst"' }],
]);

/* push.sendenAn(userId, { titel, text, … }) — der einzige Weg, wie
   Push-Titel und -Texte verschickt werden (services/push.ts). Fehlte in
   Fassung 2 komplett; sechs Aufrufstellen mit festem deutschem Titel liefen
   dadurch an jeder Prüfung vorbei, siehe Dateikopf. */
const PUSH_SENKEN = new Set(['push.sendenAn']);
const SENDE_TEXT_FELDER = new Set(['titel', 'title', 'text', 'message', 'body']);

/* Objektliterale mit einem dieser Felder legen eine Systemnachricht in der
   Datenbank ab (messages.text), die später roh angezeigt wird — erkannt an
   der Bauform, nicht an einer bestimmten Aufrufstelle: {…, text: `@${…}
   ist dem Kanal beigetreten`, systemKind: 'join'} in ws/gateway.ts ist das
   Beispiel, das diese Regel nötig machte. */
const SYSTEM_NACHRICHT_MARKER = new Set(['systemKind', 'system_kind']);

/* SQL-Spalten, deren Wert eine Person zu sehen bekommt — dieselbe Liste wie
   TEXT_EIGENSCHAFTEN, ergänzt um die tatsächlichen Spaltennamen aus dem
   Schema (topic, purpose, betreff). Trifft auf zwei Bauformen zu:
     · UPDATE … SET spalte = 'literal'           (Wert direkt im SQL-Text)
     · INSERT INTO t (a, spalte, …) VALUES (?, ?, …)  (Wert im gebundenen
       Argument an derselben Position wie das ?, das für „spalte" steht) */
const SQL_TEXT_SPALTEN = new Set([...TEXT_EIGENSCHAFTEN, 'topic', 'purpose', 'betreff', 'name']);

function sqlStatischerText(knoten) {
  if (ts.isNoSubstitutionTemplateLiteral(knoten) || ts.isStringLiteral(knoten)) return knoten.text;
  if (ts.isTemplateExpression(knoten)) return knoten.head.text + knoten.templateSpans.map((s) => s.literal.text).join(' ');
  return null;
}

function pruefeSqlAufruf(knoten, quelle, dateiRel) {
  if (!ts.isCallExpression(knoten)) return;
  const aufrufName = knoten.expression.getText(quelle);
  if (!/\.(run|get|all)$/.test(aufrufName)) return;
  const sqlKnoten = knoten.arguments[0];
  const sqlText = sqlKnoten && sqlStatischerText(sqlKnoten);
  if (!sqlText || !/INSERT\s+INTO|UPDATE\s+\w+\s+SET/i.test(sqlText)) return;

  /* Bauform 1: spalte = 'literal' — deckt UPDATE ab, und jedes INSERT, das
     ausnahmsweise mit benannten Zuweisungen statt VALUES(...) schreibt. */
  for (const treffer2 of sqlText.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*'((?:[^'\\]|\\.)*)'/g)) {
    const [, spalte, wert] = treffer2;
    if (!SQL_TEXT_SPALTEN.has(spalte)) continue;
    merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, sqlKnoten), `SQL-Text (Spalte „${spalte}")`, wert);
  }

  /* Bauform 2: INSERT INTO t (a, spalte, b) VALUES (?, ?, ?) — der Wert
     steht nicht im SQL-Text, sondern im gebundenen Argument an derselben
     Position, in Auftrittsreihenfolge der Fragezeichen. */
  const einfuegen = sqlText.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if (einfuegen) {
    const spalten = einfuegen[1].split(',').map((s) => s.trim());
    const werteListe = einfuegen[2].split(',').map((s) => s.trim());
    let platzhalterIndex = 0;
    for (let i = 0; i < werteListe.length; i++) {
      if (werteListe[i] !== '?') continue;
      const spalte = spalten[i];
      if (SQL_TEXT_SPALTEN.has(spalte)) {
        const argKnoten = knoten.arguments[1 + platzhalterIndex];
        const aus = [];
        werte(argKnoten, aus);
        for (const { text, knoten: n } of aus) {
          merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n), `SQL-Wert (Spalte „${spalte}")`, text);
        }
      }
      platzhalterIndex++;
    }
  }
}

/** Ist irgendein Vorfahre dieses Knotens eine Funktion? Für die
 *  Rückgabewert-Heuristik unten — nur die UNTERSTE Funktionsebene zählt als
 *  "gehört zu dieser Funktion", nicht verschachtelte innere Funktionen. */
function istServicesPfad(dateiRel) {
  return dateiRel.startsWith('packages/server/src/services/');
}
function istServicesOderGatewayPfad(dateiRel) {
  return istServicesPfad(dateiRel) || dateiRel === 'packages/server/src/ws/gateway.ts';
}

/** Top-level Konstanten mit Prosa-Text — ein einzelner Satz (KENNZEICHNUNG_DE
 *  in post-ki.ts) oder eine Tabelle fester Sätze (VORSCHLAG_TITEL in
 *  gateway.ts, Record<Art, string>). Bewusst nur auf MODULEBENE, nicht
 *  rekursiv — eine lokale Variable mit demselben Muster ist zu oft
 *  Zwischenergebnis einer Berechnung, keine Textkonstante. Der
 *  Prosa-Filter (mehrereWorte) hält technische Konstanten (Handles,
 *  Kanal-IDs, einzelne Codewörter) fern.
 *
 *  Liefert Kandidaten zurück, MELDET SIE ABER NOCH NICHT — pruefeServerDatei()
 *  entscheidet danach, welche davon an anderer Stelle in derselben Datei
 *  bereits neben einer gültigen Kennung stehen (siehe dortige Begründung zu
 *  VERTRAULICH_NOETIG in ws/gateway.ts: ein Satz, der laut eigenem
 *  Kommentar "die Oberfläche übersetzt anhand der Kennung", ist kein Fund,
 *  wenn genau das an der Verwendungsstelle auch zutrifft). */
function sammleTopLevelTextKonstanten(quelle, dateiRel) {
  const kandidaten = [];
  for (const stmt of quelle.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
      const init = entpacke(decl.initializer);
      const name = decl.name.text;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) || ts.isTemplateExpression(init)) {
        const aus = [];
        werte(init, aus);
        const eintraege = aus.filter(({ text }) => mehrereWorte(text.replace(/\s+/g, ' ').trim()));
        if (eintraege.length) kandidaten.push({ name, stelle: 'Text-Konstante', eintraege });
      } else if (ts.isObjectLiteralExpression(init)) {
        const alleWerteSindText = init.properties.length > 0 && init.properties.every(
          (p) => ts.isPropertyAssignment(p)
            && (ts.isStringLiteral(entpacke(p.initializer)) || ts.isNoSubstitutionTemplateLiteral(entpacke(p.initializer))
                || ts.isTemplateExpression(entpacke(p.initializer))),
        );
        if (!alleWerteSindText) continue;
        const eintraege = [];
        for (const p of init.properties) {
          const aus = [];
          werte(entpacke(p.initializer), aus);
          eintraege.push(...aus.filter(({ text }) => mehrereWorte(text.replace(/\s+/g, ' ').trim())));
        }
        if (eintraege.length) kandidaten.push({ name, stelle: 'Text-Tabelle', eintraege });
      }
    }
  }
  return kandidaten;
}

function pruefeServerDatei(pfad) {
  const dateiRel = rel(pfad);
  const quelle = ts.createSourceFile(pfad, fs.readFileSync(pfad, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const textKonstanten = sammleTopLevelTextKonstanten(quelle, dateiRel);
  const konstantenNamen = new Set(textKonstanten.map((k) => k.name));
  const gedeckteKonstanten = new Set();
  /** Wird der Textteil eines Meldungshelfers von einer bekannten
   *  Top-Level-Konstante gespeist UND steht daneben eine gültige Kennung,
   *  ist die Konstante an dieser Stelle korrekt eingebunden — kein Fund. */
  const pruefeKonstantenDeckung = (kennungKnoten, textKnoten) => {
    if (uebersetzbareKennung(kennungKnoten) !== true) return;
    const t = entpacke(textKnoten);
    if (t && ts.isIdentifier(t) && konstantenNamen.has(t.text)) gedeckteKonstanten.add(t.text);
  };

  /* Letzte lokale Zuweisung je Bezeichner, zurückgesetzt an jeder
     Funktionsgrenze — für Kurzformen wie push.sendenAn(uid, { titel, text }),
     wo titel/text ein paar Zeilen weiter oben mit `const titel = …`
     entstanden sind. Bewusst grob: kein Zugriff über Funktionsgrenzen
     hinweg (auf äußere consts einer umschließenden Funktion), das wäre
     schon eher Raten. */
  let ortsMap = new Map();

  const gehe = (knoten) => {
    if (ts.isFunctionLike(knoten) && knoten.body) {
      const aeussere = ortsMap;
      ortsMap = new Map();
      ts.forEachChild(knoten, gehe);
      ortsMap = aeussere;
      return;
    }
    if (ts.isVariableDeclaration(knoten) && ts.isIdentifier(knoten.name) && knoten.initializer) {
      ortsMap.set(knoten.name.text, knoten.initializer);
    }

    /* HTML-Vorlage — Download-Seite, Betreiberkonsole. */
    if ((ts.isTemplateExpression(knoten) || ts.isNoSubstitutionTemplateLiteral(knoten))
        && pruefeHtmlVorlage(knoten, quelle, PAKET_SERVER, dateiRel)) {
      ts.forEachChild(knoten, gehe);
      return;
    }

    if (ts.isCallExpression(knoten)) {
      const aufrufName = knoten.expression.getText(quelle);

      /* (1) Meldungshelfer: fehler(reply, status, code, text) und
             fail(session, code, message) */
      if (MELDE_HELFER.has(aufrufName)) {
        const form = MELDE_HELFER.get(aufrufName);
        const kennungKnoten = knoten.arguments[form.kennung];
        pruefeSchluesselArgument(kennungKnoten, quelle, dateiRel, `${form.wo} (${aufrufName})`);
        pruefeKonstantenDeckung(kennungKnoten, knoten.arguments[form.text]);
        const gut = uebersetzbareKennung(kennungKnoten);
        if (gut === false) {
          const aus = [];
          werte(knoten.arguments[form.text], aus);
          const kName = ts.isStringLiteral(kennungKnoten) ? kennungKnoten.text : '?';
          for (const { text, knoten: n } of aus) {
            merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n), `${form.wo}, Kennung „${kName}" fehlt im Wörterbuch`, text);
          }
        }
      }

      /* (2) abweisung(code, message, werte?, cause?) — dieselbe Bauform wie
             fehler()/fail(), aber ohne reply/session als erstes Argument. */
      if (aufrufName === 'abweisung') {
        pruefeSchluesselArgument(knoten.arguments[0], quelle, dateiRel, 'Abweisung (abweisung(…))');
        pruefeKonstantenDeckung(knoten.arguments[0], knoten.arguments[1]);
        if (uebersetzbareKennung(knoten.arguments[0]) === false) {
          const aus = [];
          werte(knoten.arguments[1], aus);
          const kName = ts.isStringLiteral(knoten.arguments[0]) ? knoten.arguments[0].text : '?';
          for (const { text, knoten: n } of aus) {
            merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n), `Abweisung, Kennung „${kName}" fehlt im Wörterbuch`, text);
          }
        }
      }

      /* (3) reply.send({ error: 'deutscher Satz' }) ohne Kennung daneben */
      if (/\.send$/.test(aufrufName)) {
        const rumpf = knoten.arguments[0];
        if (rumpf && ts.isObjectLiteralExpression(rumpf)) {
          const feld = rumpf.properties.find((e) => ts.isPropertyAssignment(e) && eigenschaftsName(e.name, quelle) === ANTWORT_FELD);
          const hatKennung = rumpf.properties.some((e) => e.name && eigenschaftsName(e.name, quelle) === KENNUNGS_FELD);
          if (feld && !hatKennung) {
            const aus = [];
            werte(feld.initializer, aus);
            for (const { text, knoten: n } of aus) merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n), 'HTTP-Antwort ohne Kennung', text);
          }
        }
      }

      /* (4) push.sendenAn(userId, { titel, text, … }) */
      if (PUSH_SENKEN.has(aufrufName)) {
        const objArg = knoten.arguments.find((a) => ts.isObjectLiteralExpression(a));
        if (objArg) {
          for (const prop of objArg.properties) {
            if (!prop.name) continue;
            const propName = eigenschaftsName(prop.name, quelle);
            if (!SENDE_TEXT_FELDER.has(propName)) continue;
            let wertKnoten = null;
            if (ts.isPropertyAssignment(prop)) wertKnoten = prop.initializer;
            else if (ts.isShorthandPropertyAssignment(prop)) wertKnoten = ortsMap.get(propName) ?? null;
            if (!wertKnoten) continue;
            const aus = [];
            werte(wertKnoten, aus);
            for (const { text, knoten: n } of aus) merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n), 'Push-Benachrichtigung', text);
          }
        }
      }

      pruefeSqlAufruf(knoten, quelle, dateiRel);
    }

    /* (5) new Abweisung(code, message, …) — dieselbe Bauform wie oben, aber
           per Konstruktor statt über den Helfer abweisung() aufgerufen. */
    if (ts.isNewExpression(knoten) && knoten.expression.getText(quelle) === 'Abweisung') {
      pruefeSchluesselArgument(knoten.arguments?.[0], quelle, dateiRel, 'Abweisung (new Abweisung(…))');
      pruefeKonstantenDeckung(knoten.arguments?.[0], knoten.arguments?.[1]);
      if (uebersetzbareKennung(knoten.arguments?.[0]) === false) {
        const aus = [];
        werte(knoten.arguments?.[1], aus);
        const kName = ts.isStringLiteral(knoten.arguments?.[0]) ? knoten.arguments[0].text : '?';
        for (const { text, knoten: n } of aus) {
          merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n), `Abweisung, Kennung „${kName}" fehlt im Wörterbuch`, text);
        }
      }
    }

    if (ts.isObjectLiteralExpression(knoten)) {
      const art = knoten.properties.find((e) => ts.isPropertyAssignment(e) && eigenschaftsName(e.name, quelle) === 't');
      const istFehlerereignis = art && ts.isPropertyAssignment(art)
        && ts.isStringLiteral(art.initializer) && art.initializer.text === EREIGNIS_ART;
      if (istFehlerereignis) {
        const textFeld = knoten.properties.find((e) => ts.isPropertyAssignment(e) && eigenschaftsName(e.name, quelle) === EREIGNIS_TEXTFELD);
        const kennungFeld = knoten.properties.find((e) => ts.isPropertyAssignment(e) && eigenschaftsName(e.name, quelle) === KENNUNGS_FELD);
        if (kennungFeld && ts.isPropertyAssignment(kennungFeld)) {
          pruefeSchluesselArgument(kennungFeld.initializer, quelle, dateiRel, 'Fehlerereignis (t: "error")');
        }
        const gut = kennungFeld && ts.isPropertyAssignment(kennungFeld) ? uebersetzbareKennung(kennungFeld.initializer) : false;
        if (textFeld && ts.isPropertyAssignment(textFeld) && gut === false) {
          const aus = [];
          werte(textFeld.initializer, aus);
          const kName = kennungFeld && ts.isPropertyAssignment(kennungFeld) && ts.isStringLiteral(kennungFeld.initializer)
            ? kennungFeld.initializer.text : null;
          for (const { text, knoten: n } of aus) {
            merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n),
              kName ? `Fehlerereignis, Kennung „${kName}" fehlt im Wörterbuch` : 'Fehlerereignis ohne Kennung', text);
          }
        }
      }

      /* (6) Protokollfelder mit Anzeigetext — in Ordnung nur mit Kennung daneben */
      for (const feld of knoten.properties) {
        if (!ts.isPropertyAssignment(feld)) continue;
        const name = eigenschaftsName(feld.name, quelle);
        const form = PROTOKOLL_TEXTFELDER.get(name);
        if (!form) continue;
        const nachbar = knoten.properties.find((e) => ts.isPropertyAssignment(e) && eigenschaftsName(e.name, quelle) === form.kennungsFeld);
        if (nachbar) pruefeSchluesselArgument(nachbar.initializer, quelle, dateiRel, `Protokollfeld „${name}"`);
        if (nachbar && uebersetzbareKennung(nachbar.initializer) !== false) continue;
        const aus = [];
        werte(feld.initializer, aus);
        const kName = nachbar && ts.isStringLiteral(nachbar.initializer) ? nachbar.initializer.text : null;
        for (const { text, knoten: n } of aus) {
          merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n),
            kName ? `Protokollfeld „${name}", Kennung „${kName}" fehlt im Wörterbuch` : `Protokollfeld „${name}" trägt Text ohne Kennung`, text);
        }
      }

      /* (7) Systemnachricht, direkt in die Datenbank geschrieben:
             {…, text: `…`, systemKind: 'join'} */
      const hatSystemMarker = knoten.properties.some((p) => p.name && SYSTEM_NACHRICHT_MARKER.has(eigenschaftsName(p.name, quelle)));
      if (hatSystemMarker) {
        const textFeld = knoten.properties.find((e) => ts.isPropertyAssignment(e) && eigenschaftsName(e.name, quelle) === 'text');
        if (textFeld) {
          const aus = [];
          werte(textFeld.initializer, aus);
          for (const { text, knoten: n } of aus) {
            merke(treffer, PAKET_SERVER, dateiRel, zeileVon(quelle, n), 'Systemnachricht (in Datenbank abgelegt)', text);
          }
        }
      }
    }

    /* (8) throw new Error(...) in services/** — siehe Dateikopf: die
           Abweisung-Klasse dokumentiert selbst, dass ein gewöhnlicher Error
           "nur einen deutschen Satz trägt — und der dann in jeder Sprache
           auf dem Schirm stand". */
    if (istServicesPfad(dateiRel)) pruefeThrowNewError(knoten, quelle, PAKET_SERVER, dateiRel);

    /* (9) UNGEKLÄRT: ein zurückgegebener Satz in services/** oder
           ws/gateway.ts. Ob er einen Menschen erreicht, hängt vom Aufrufer
           ab — nicht automatisch entscheidbar, siehe Anforderung "lieber
           UNGEKLÄRT als geraten". mehrereWorte() hält Rückgaben wie
           `return 'de'` oder `return 'darwin'` fern. */
    if (ts.isReturnStatement(knoten) && knoten.expression && istServicesOderGatewayPfad(dateiRel)) {
      const aus = [];
      werte(knoten.expression, aus);
      for (const { text, knoten: n } of aus) {
        const bereinigt = text.replace(/\s+/g, ' ').trim();
        if (!mehrereWorte(bereinigt) || SCHLUESSEL.has(bereinigt) || ausgenommenText(bereinigt)) continue;
        if (ausgenommeneStelle(dateiRel, zeileVon(quelle, n))) continue;
        unklar.push({
          paket: PAKET_SERVER, datei: dateiRel, zeile: zeileVon(quelle, n),
          stelle: 'return — könnte eine Chat-/Mail-Nachricht werden, evtl. nur intern', text: bereinigt,
        });
      }
    }

    ts.forEachChild(knoten, gehe);
  };

  gehe(quelle);

  /* Erst jetzt, nachdem der ganze Baum besucht ist, steht fest, welche
     Top-Level-Textkonstanten irgendwo in derselben Datei korrekt neben einer
     gültigen Kennung stehen (siehe pruefeKonstantenDeckung oben) — die sind
     kein Fund. Die übrigen sind UNGEKLÄRT statt ein harter Fund: dieselbe
     Bauform (ein Record<Enum, string> mit lauter Prosa-Werten) trägt hier
     auch TONE_PROMPT in services/ai.ts — Anweisungen ANS Sprachmodell, die
     kein Mensch zu sehen bekommt, genau wie VORSCHLAG_TITEL in dieser Datei
     eine Anzeigestelle ist. Von der Erklärstelle allein ist das nicht zu
     unterscheiden, ohne zu verfolgen, wohin der Wert anschließend fließt —
     und genau das will diese Prüfung nicht raten (siehe Dateikopf). */
  for (const kandidat of textKonstanten) {
    if (gedeckteKonstanten.has(kandidat.name)) continue;
    for (const { text, knoten: n } of kandidat.eintraege) {
      const bereinigt = text.replace(/\s+/g, ' ').trim();
      if (!bereinigt || SCHLUESSEL.has(bereinigt) || ausgenommenText(bereinigt)) continue;
      if (ausgenommeneStelle(dateiRel, zeileVon(quelle, n))) continue;
      unklar.push({
        paket: PAKET_SERVER, datei: dateiRel, zeile: zeileVon(quelle, n),
        stelle: `${kandidat.stelle} „${kandidat.name}" — UI-Text oder Anweisung ans Sprachmodell?`, text: bereinigt,
      });
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   DURCHLAUF
   ═══════════════════════════════════════════════════════════════ */

const UEBERSPRINGEN_ORDNER = new Set(['node_modules', 'dist', 'build', 'dist-electron', '.git', '.turbo']);

function* dateiListe(ordner, muster) {
  if (!fs.existsSync(ordner)) return;
  const eintraege = fs.readdirSync(ordner, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const eintrag of eintraege) {
    const pfad = path.join(ordner, eintrag.name);
    if (eintrag.isDirectory()) {
      if (UEBERSPRINGEN_ORDNER.has(eintrag.name)) continue;
      if (path.resolve(pfad) === path.resolve(WOERTERBUCH_ORDNER)) continue; // das Wörterbuch selbst — dort gehört der Text hin
      yield* dateiListe(pfad, muster);
    } else if (muster.test(eintrag.name)) {
      yield pfad;
    }
  }
}

const PAKETE = [
  { name: 'Desktop (Oberfläche)', wurzel: path.join(REPO_WURZEL, 'packages/desktop/src'), art: 'client' },
  { name: 'Desktop (Electron)', wurzel: path.join(REPO_WURZEL, 'packages/desktop/electron'), art: 'electron' },
  { name: 'Shared', wurzel: path.join(REPO_WURZEL, 'packages/shared/src'), art: 'client' },
];

for (const paket of PAKETE) {
  for (const datei of dateiListe(paket.wurzel, /\.tsx?$/)) {
    pruefeClientArtigeDatei(datei, paket.name, paket.art);
  }
}

const SERVER_WURZEL = path.join(REPO_WURZEL, 'packages/server/src');
for (const datei of dateiListe(SERVER_WURZEL, /\.tsx?$/)) {
  pruefeServerDatei(datei);
}

/* ═══════════════════════════════════════════════════════════════
   BERICHT
   ═══════════════════════════════════════════════════════════════ */

function nachPaketUndDatei(liste) {
  const nachPaket = new Map();
  for (const t of liste) {
    if (!nachPaket.has(t.paket)) nachPaket.set(t.paket, new Map());
    const nachDatei = nachPaket.get(t.paket);
    if (!nachDatei.has(t.datei)) nachDatei.set(t.datei, []);
    nachDatei.get(t.datei).push(t);
  }
  return nachPaket;
}

function berichteFunde(liste, ueberschrift, zeilenProDatei) {
  if (!liste.length) return;
  console.log(`\n${'═'.repeat(ueberschrift.length)}\n${ueberschrift}\n${'═'.repeat(ueberschrift.length)}`);
  const nachPaket = nachPaketUndDatei(liste);
  for (const [paket, nachDatei] of [...nachPaket.entries()].sort((a, b) => b[1].size - a[1].size)) {
    const summe = [...nachDatei.values()].reduce((s, l) => s + l.length, 0);
    console.log(`\n${paket} — ${summe} in ${nachDatei.size} Dateien`);
    for (const [datei, eintraege] of [...nachDatei.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${datei} — ${eintraege.length}`);
      for (const t of eintraege.slice(0, zeilenProDatei)) {
        console.log(`    ${String(t.zeile).padStart(5)}  ${t.stelle.padEnd(60)} ${t.text.slice(0, 90)}`);
      }
      if (eintraege.length > zeilenProDatei) console.log(`    … ${eintraege.length - zeilenProDatei} weitere`);
    }
  }
}

berichteFunde(treffer, 'FUNDE — fest im Code stehender Anzeigetext', 40);

if (fehlendeSchluessel.length) {
  console.log(`\n${'═'.repeat(60)}\nSCHLÜSSEL IM CODE, ABER IN KEINEM WÖRTERBUCH\n${'═'.repeat(60)}`);
  const nachDatei = new Map();
  for (const f of fehlendeSchluessel) {
    if (!nachDatei.has(f.datei)) nachDatei.set(f.datei, []);
    nachDatei.get(f.datei).push(f);
  }
  for (const [datei, liste] of [...nachDatei.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${datei} — ${liste.length}`);
    for (const f of liste) console.log(`  ${String(f.zeile).padStart(5)}  ${f.schluessel}  (${f.wo})`);
  }
}

berichteFunde(unklar, 'UNGEKLÄRT — nicht automatisch entscheidbar, bitte von Hand prüfen', 25);

/* ── Ausnahmen: Nutzung ────────────────────────────────────────── */
const verwaisteTexte = AUSNAHME_TEXTE.filter((e) => !textAusnahmeGenutzt.has(e.text));
const verwaisteStellen = AUSNAHME_STELLEN.filter((e) => !stelleAusnahmeGenutzt.has(`${e.datei}${e.zeile ? `:${e.zeile}` : ''}`));
if (verwaisteTexte.length || verwaisteStellen.length) {
  console.log(`\n${'═'.repeat(60)}\nAUSNAHMEN OHNE FUNDSTELLE — bitte prüfen, ob noch nötig\n${'═'.repeat(60)}`);
  for (const e of verwaisteTexte) console.log(`  TEXTE:   "${e.text}"`);
  for (const e of verwaisteStellen) console.log(`  STELLEN: ${e.datei}${e.zeile ? `:${e.zeile}` : ''}`);
}

/* ── Zusammenfassung ──────────────────────────────────────────────
   Die Zeile "Gesamt: <Zahl>" bleibt im bestehenden Format — ausliefern.mjs
   las sie früher mit /Gesamt: (\d+)/ und WARNTE nur, der Lauf selbst gab
   dabei immer Exit-Code 0 zurück. Das ist vorbei: der Exit-Code entscheidet
   jetzt wirklich (siehe SCHWELLE unten), und ausliefern.mjs fängt einen
   Nicht-Null-Code ab, statt ihn ungeprüft zu werfen (siehe dort). Diese Zeile
   bleibt trotzdem stehen — als Kurzfassung für Menschen, die den Lauf von
   Hand starten und nur die Größenordnung sehen wollen, bevor sie zum
   SCHWELLE-Bericht weiterlesen. */
const harteFunde = treffer.length + fehlendeSchluessel.length;
console.log(`\n${'─'.repeat(60)}`);
console.log(`Gesamt: ${harteFunde} — Funde ${treffer.length}, fehlende Schlüssel ${fehlendeSchluessel.length}`
  + `, ungeklärt ${unklar.length} (zählt nicht mit)`);

for (const paket of [...new Set(treffer.map((t) => t.paket))]) {
  const anzahl = treffer.filter((t) => t.paket === paket).length;
  console.log(`  ${paket}: ${anzahl}`);
}

/* ═══════════════════════════════════════════════════════════════
   SCHWELLE — der Ratchet
   ═══════════════════════════════════════════════════════════════
   Diese Prüfung gab bis eben IMMER Exit-Code 0 zurück, unabhängig vom
   Ergebnis — ein Bericht ohne Wächter. Mit einem echten Exit-Code sofort
   und ohne Übergang zu blocken, hätte bei 259 zum Zeitpunkt dieser Änderung
   bereits bestehenden harten Funden jede Auslieferung gestoppt, ohne dass
   in der Zwischenzeit auch nur einer davon behoben werden konnte — das ist
   nicht "die Zahl sinkt Richtung null", das ist ein Werkzeug, das sofort
   wieder abgeschaltet wird. Deshalb ein Ratchet:

     · scripts/deutsch-schwelle.json hält fest, wie viele Funde und wie
       viele fehlende Schlüssel JE DATEI zum Zeitpunkt der letzten
       Festschreibung bestanden.
     · Ist irgendeine Datei SCHLECHTER als dort vermerkt (mehr Funde ODER
       mehr fehlende Schlüssel), ist das ein Hardstop — sofort, ohne
       Kulanz. Ein neuer fest verdrahteter Text ist ein neuer Fund, egal
       wie viel Altbestand anderswo gerade abgearbeitet wird.
     · Ist keine Datei schlechter, aber mindestens eine besser, bleibt der
       Lauf grün — UND sagt laut, dass sich die Schwelle jetzt senken
       lässt, mit dem genauen Befehl dafür.

   WARUM JE DATEI UND NICHT EINE EINZIGE ZAHL
   Eine einzelne Gesamtzahl lässt sich unbemerkt austricksen: eine Reparatur
   in Datei A und ein neuer Fund in Datei B können sich in der Summe genau
   aufheben, und der Lauf bliebe grün — obwohl echter neuer unübersetzter
   Text im Repository liegt. Mit Zählung je Datei UND je Fundart (Funde vs.
   fehlende Schlüssel, damit sich auch DAS nicht innerhalb derselben Datei
   gegenseitig deckt) ist das nicht mehr möglich: jede einzelne Datei muss
   für sich mindestens gleich gut bleiben.

   WARUM NICHT NOCH FEINER (JE ZEILE ODER JE TEXT)
   Erwogen und verworfen: eine Zeilennummer verschiebt sich schon, wenn
   darüber ein Kommentar ergänzt wird — ohne dass sich an der Zahl der Funde
   etwas geändert hätte. Mit mehreren Teams, die gleichzeitig an packages/
   arbeiten, würde eine zeilengenaue Schwelle bei praktisch jedem Lauf
   irgendwo verrutschen, obwohl nichts Neues hinzugekommen ist — sie müsste
   ständig "aktualisiert" werden, nur um mit Formatierung Schritt zu halten.
   Genau das macht einen Ratchet wertlos: wird das Aktualisieren zur
   Gewohnheit, liest niemand mehr nach, was sich dabei wirklich ändert. Je
   Datei ist grob genug, um bei reinen Verschiebungen stabil zu bleiben, und
   fein genug, um eine einzelne Datei mit einem neuen Fund nicht hinter
   Reparaturen anderswo zu verstecken.

   WARUM .json UND NICHT .mjs (anders als deutsch-ausnahmen.mjs)
   deutsch-ausnahmen.mjs ist von Hand geschriebene Prosa — jeder Eintrag
   trägt eine Begründung in ganzen Sätzen, und ein Mensch soll das lesen und
   erweitern. deutsch-schwelle.json ist das Gegenteil: eine maschinell
   erzeugte Momentaufnahme von Zahlen, die praktisch immer per
   --schwelle-aktualisieren neu geschrieben und als Diff gelesen wird, nie
   von Hand mit Fließtext ergänzt. Dieselbe Unterscheidung wie zwischen
   package.json (von Hand kuratiert) und package-lock.json (erzeugt,
   als Diff geprüft) — hier also JSON.

   WARUM EIN UMBENENNEN DIE SCHWELLE TRIFFT
   Wird eine Datei umbenannt oder verschoben, taucht sie unter dem neuen
   Pfad ohne Eintrag auf — implizit erlaubt: 0. Jeder Fund darin ist dann
   formal "neu" und blockiert, obwohl sich inhaltlich nichts geändert hat.
   Das ist gewollte Vorsicht, keine Falle: --schwelle-aktualisieren zeigt in
   diesem Fall eine Datei, die verschwindet, und eine neue, die mit
   denselben Zahlen auftaucht — im Diff von deutsch-schwelle.json steht dann
   klar, dass sich nur der Pfad geändert hat. Genau dieses Muster (eine
   Ausnahme, die nach einem Umzug ins Leere zeigt) war einer der beiden
   Fehler aus dem Kopf dieser Datei — hier wird bewusst dafür gesorgt, dass
   ein Umzug SICHTBAR bleibt, statt still zu funktionieren oder still zu
   brechen.

   DER ZUSTAND NULL BRAUCHT KEINEN SONDERFALL
   Ist scripts/deutsch-schwelle.json irgendwann leer (dateien: {}), gilt für
   jede Datei implizit die erlaubte Zahl 0 — derselbe Vergleich wie immer,
   nur dass jetzt jeder einzelne Fund sofort blockiert. Kein Sonderfall im
   Code, keine Abfrage "sind wir schon bei null" — die Schwelle IST an
   diesem Punkt bereits ein vollständiger Blocker.

   WARUM --schwelle-aktualisieren KEINEN ANSTIEG SCHREIBT
   Der Befehl schreibt nur fest, was mindestens so gut ist wie der
   bisherige Stand (Gesamtzahl gleich oder kleiner) — sonst wäre er ein
   zweiter, bequemerer Weg, genau den Hardstop zu umgehen, den diese Prüfung
   gerade durchsetzen soll: "CI ist rot, ich führe halt den Befehl aus, der
   CI grün macht" wäre dann dasselbe Muster wie ein Passwort, das man beim
   dritten Fehlversuch einfach neu setzt, bis es akzeptiert wird. Eine
   bewusste Anhebung bleibt möglich — von Hand in der Datei, sichtbar im
   Diff, wie jede andere Codeänderung auch. Dafür braucht es keinen
   Kommandozeilen-Fluchtweg: anders als eine laufende Auslieferung (siehe
   den Fluchtweg in ausliefern.mjs) eilt das Anheben einer Schwelle nie —
   es kann immer bis zum nächsten regulären, geprüften Commit warten. */

const SCHWELLE_DATEI = path.join(REPO_WURZEL, 'scripts/deutsch-schwelle.json');
const AKTUALISIEREN_FLAGGE = '--schwelle-aktualisieren';
const sollAktualisieren = process.argv.includes(AKTUALISIEREN_FLAGGE);

/** Prüft die Form einer geladenen Schwelle — wirft laut statt leise falsche
 *  Zahlen zu vergleichen. Dieselbe Haltung wie pruefeAusnahmen() nebenan in
 *  deutsch-ausnahmen.mjs: eine kaputte Grundlage soll den Lauf stoppen,
 *  nicht unbemerkt durchrutschen. */
function pruefeSchwelle(daten, quelle) {
  if (!daten || typeof daten !== 'object' || typeof daten.dateien !== 'object' || daten.dateien === null) {
    throw new Error(`${quelle}: erwarte ein Objekt mit einem Feld "dateien".`);
  }
  for (const [datei, zahlen] of Object.entries(daten.dateien)) {
    for (const feld of ['funde', 'fehlendeSchluessel']) {
      const wert = zahlen?.[feld];
      if (!Number.isInteger(wert) || wert < 0) {
        throw new Error(`${quelle}: "${datei}".${feld} ist keine gültige Zahl (${JSON.stringify(wert)}).`);
      }
    }
  }
}

/** Lädt die Schwelle, ohne bei einer kaputten Datei zu werfen — der
 *  Aufrufer entscheidet, ob das den Lauf stoppt (Normalfall) oder die Datei
 *  ersetzt wird (--schwelle-aktualisieren, siehe dort). */
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

/** Aktuelle Zählung je Datei, in derselben Form wie die Schwelle — aus den
 *  bereits gesammelten Funden dieses Laufs, kein erneuter Durchlauf nötig. */
function aktuelleZaehlung() {
  const proDatei = new Map();
  const zaehle = (datei, feld) => {
    if (!proDatei.has(datei)) proDatei.set(datei, { funde: 0, fehlendeSchluessel: 0 });
    proDatei.get(datei)[feld] += 1;
  };
  for (const t of treffer) zaehle(t.datei, 'funde');
  for (const f of fehlendeSchluessel) zaehle(f.datei, 'fehlendeSchluessel');
  return proDatei;
}

const gesamtVonEintraegen = (eintraege) => eintraege.reduce((s, z) => s + z.funde + z.fehlendeSchluessel, 0);
const gesamtVonMap = (proDatei) => gesamtVonEintraegen([...proDatei.values()]);
const gesamtVonObjekt = (dateien) => gesamtVonEintraegen(Object.values(dateien));

function schwelleSchreiben(proDatei) {
  const dateien = {};
  for (const [datei, zahlen] of [...proDatei.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (zahlen.funde === 0 && zahlen.fehlendeSchluessel === 0) continue; // saubere Dateien tauchen gar nicht erst auf
    dateien[datei] = zahlen;
  }
  const inhalt = {
    __hinweis: [
      'Wird von scripts/deutsch-finden.mjs gelesen und mit --schwelle-aktualisieren geschrieben.',
      'Zaehlt Funde und fehlende Woerterbuch-Schluessel je Datei, nicht global — ein neuer Fund in',
      'Datei A darf sich nicht hinter einer Reparatur in Datei B verstecken. Darf je Datei nur',
      'sinken; ein Anstieg ist im Gate ein Hardstop. Erhoehungen gehen nur per Hand-Edit dieser',
      'Datei (sichtbar im Diff), nicht per Kommandozeile — siehe Kopf von deutsch-finden.mjs,',
      'Abschnitt SCHWELLE.',
    ],
    erzeugtAm: new Date().toISOString().slice(0, 10),
    dateien,
  };
  fs.writeFileSync(SCHWELLE_DATEI, `${JSON.stringify(inhalt, null, 2)}\n`);
}

console.log(`\n${'═'.repeat(60)}\nSCHWELLE (${rel(SCHWELLE_DATEI)}) — Ratchet\n${'═'.repeat(60)}`);

const jetzt = aktuelleZaehlung();
const { daten: schwelle, fehler: schwelleFehler } = ladeSchwelleSicher();

if (sollAktualisieren) {
  if (schwelleFehler) {
    console.log(`\n! Bisherige ${rel(SCHWELLE_DATEI)} ließ sich nicht lesen (${schwelleFehler.message}) — wird ersetzt.`);
  }
  const neuGesamt = gesamtVonMap(jetzt);
  const altGesamt = schwelle ? gesamtVonObjekt(schwelle.dateien) : 0;
  if (schwelle && !schwelleFehler && neuGesamt > altGesamt) {
    console.log(`\n✗ ${AKTUALISIEREN_FLAGGE} lehnt ab: die Gesamtzahl stiege von ${altGesamt} auf ${neuGesamt}.`);
    console.log('  Dieser Befehl schreibt nur Verbesserungen fest, nie einen Anstieg — sonst könnte er');
    console.log('  einen echten neuen Fund unbemerkt zur neuen Normalität machen. Entweder den Fund');
    console.log('  beheben, oder die Schwelle bewusst von Hand in der Datei anheben (sichtbar im Diff).');
    process.exitCode = 1;
  } else {
    schwelleSchreiben(jetzt);
    if (!schwelle) {
      console.log(`\n✓ Erstmalig angelegt: ${rel(SCHWELLE_DATEI)} mit ${neuGesamt} Altfällen.`);
      console.log('  Ab jetzt darf diese Zahl nur noch sinken — jeder neue Fund ist ein Hardstop.');
    } else {
      const teil = neuGesamt - altGesamt;
      console.log(`\n✓ Schwelle aktualisiert: ${altGesamt} → ${neuGesamt} (${teil > 0 ? '+' : ''}${teil}).`);
    }
    process.exitCode = 0;
  }
} else if (schwelleFehler) {
  console.log(`\n✗ ${rel(SCHWELLE_DATEI)} lässt sich nicht lesen: ${schwelleFehler.message}`);
  console.log(`  Entweder von Hand reparieren, oder neu erzeugen: node scripts/deutsch-finden.mjs ${AKTUALISIEREN_FLAGGE}`);
  process.exitCode = 1;
} else if (!schwelle) {
  console.log(`\n✗ Keine Schwelle hinterlegt (${rel(SCHWELLE_DATEI)} fehlt).`);
  console.log('  Einmalig anlegen:');
  console.log(`    node scripts/deutsch-finden.mjs ${AKTUALISIEREN_FLAGGE}`);
  process.exitCode = 1;
} else {
  const alleDateien = new Set([...Object.keys(schwelle.dateien), ...jetzt.keys()]);
  const verschlechtert = [];
  const verbessert = [];
  for (const datei of [...alleDateien].sort()) {
    const alt = schwelle.dateien[datei] ?? { funde: 0, fehlendeSchluessel: 0 };
    const neu = jetzt.get(datei) ?? { funde: 0, fehlendeSchluessel: 0 };
    for (const feld of ['funde', 'fehlendeSchluessel']) {
      if (neu[feld] > alt[feld]) verschlechtert.push({ datei, feld, alt: alt[feld], neu: neu[feld] });
      else if (neu[feld] < alt[feld]) verbessert.push({ datei, feld, alt: alt[feld], neu: neu[feld] });
    }
  }

  const altGesamt = gesamtVonObjekt(schwelle.dateien);
  const neuGesamt = gesamtVonMap(jetzt);
  const teil = neuGesamt - altGesamt;

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
    console.log('  Ein neuer fest verdrahteter Text ist ein Hardstop, sofort: entweder den Text aus dem');
    console.log('  Wörterbuch beziehen (t(...) / tStatisch(...) / translate(...)), oder — nur wenn es');
    console.log('  wirklich keine Anzeigestelle ist — eine begründete Ausnahme in');
    console.log('  scripts/deutsch-ausnahmen.mjs eintragen.');
    process.exitCode = 1;
  } else if (verbessert.length) {
    console.log(`\n✓ Innerhalb der Schwelle — ${neuGesamt} Fälle stehen noch aus, die Zahl darf ab hier nur`);
    console.log('  sinken, nie steigen.');
    console.log(`\n  ${verbessert.length} Stelle(n) sind besser als in der Schwelle hinterlegt. Festschreiben,`);
    console.log('  damit die Verbesserung nicht bei einem künftigen Rückschritt an genau dieser Stelle');
    console.log('  unbemerkt wieder gedeckt wird:');
    console.log(`    node scripts/deutsch-finden.mjs ${AKTUALISIEREN_FLAGGE}`);
    process.exitCode = 0;
  } else {
    console.log(`\n✓ Innerhalb der Schwelle — ${neuGesamt} von ${altGesamt} erlaubten Altfällen, unverändert.`);
    console.log('  Diese Zahl darf ab hier nur sinken, nie steigen — jeder neue Fund ist ein Hardstop.');
    process.exitCode = 0;
  }
}
