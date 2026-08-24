#!/usr/bin/env node
/**
 * Statische Verkabelungsprüfung: verlässt JEDE Abweisung eines Ereignisses
 * mit `clientId` (`message:send`, `poll:create`, `message:forward`,
 * `voice:send` — siehe packages/shared/src/protocol.ts) in
 * packages/server/src/ws/gateway.ts das Haus mit dieser `clientId`?
 *
 * WARUM STATISCH UND NICHT AM LAUFENDEN GATEWAY
 * gateway.ts hängt an einer echten SQLite-Datenbank, Sitzungen, Rechten und
 * einem Dutzend Diensten — es ohne Server hochzufahren wäre entweder ein
 * echter Netzwerk-/Prozessstart (hier ausdrücklich nicht erlaubt) oder ein so
 * großer Mock, dass er die eigentliche Prüfung selbst verdeckt. Was hier
 * zählt, ist eine reine Verkabelungsfrage — "wird die clientId an dieser
 * Aufrufstelle weitergereicht, UND an der richtigen Stelle in der
 * Argumentliste?" — und die beantwortet der Syntaxbaum zuverlässiger als
 * jeder Mock: `scripts/nachricht-fehler-zuordnung-pruefen.mjs` daneben prüft
 * die andere Hälfte der Zusage (der Client wertet die `clientId` richtig
 * aus), diese Datei prüft die Serverhälfte.
 *
 * WAS GEPRÜFT WIRD
 * ZWEI Arten von Fundstellen, weil eine Abweisung von 'message:send' das Haus
 * auf zwei ganz verschiedenen Wegen verlässt:
 *
 *   1. FRÜHE fail()/darf()/chiffratNoetig()-RÜCKGABEN — innerhalb der
 *      jeweiligen `case '…':`-Verzweigung selbst (Kanal nicht gefunden, kein
 *      Zugriff, kein Recht, vertraulicher Kanal, …). Geprüft für alle vier
 *      Ereignisarten mit `clientId`, nicht nur 'message:send' — dieselbe
 *      Zusage gilt für 'poll:create', 'message:forward' und 'voice:send'
 *      genauso, und ein Fix, der nur eine der vier Verzweigungen abdeckt,
 *      lässt die anderen drei mit demselben für-immer-spinnenden Anhang
 *      zurück.
 *
 *   2. DER GENERISCHE WURF-FÄNGER — die weitaus häufigeren Abweisungen aus
 *      messages.createMessage() (leerer Text, zu lang, falscher Kanal für
 *      den Anhang, unverschlüsselter Anhang, …) verlassen ihre `case`-
 *      Verzweigung nicht über eines der frühen fail()-Returns, sondern per
 *      WURF (`abweisung(...)`, packages/server/src/services/messages.ts).
 *      Der `.catch()` an `handleEvent(session, ev)` in `handleConnection()`
 *      fängt sie ~400 Zeilen von jeder `case`-Verzweigung entfernt auf und
 *      ist strukturell UNSICHTBAR für eine Suche, die nur innerhalb der
 *      `case`-Klauseln sucht — genau das war die Lücke, die Fehlerklasse D
 *      unentdeckt ließ (siehe Kopfkommentar von
 *      scripts/nachricht-fehler-zuordnung-pruefen.mjs). Diese Datei sucht
 *      ihn darum eigens: strukturell über `handleEvent(session, ev).catch(…)`
 *      erkannt, nicht über eine Zeilennummer, die beim nächsten Umbau nicht
 *      mehr stimmt.
 *
 * Jeder gefundene Aufruf muss die clientId an der RICHTIGEN Position der
 * Argumentliste tragen, nicht irgendwo darin — ein `argListe.includes(…)`
 * hätte eine vertauschte Position (z. B. clientId im requestId-Schlitz, was
 * beim Client den `settle()`-Zweig statt eines Toasts auslöst, siehe
 * case 'error' in packages/desktop/src/state/store.ts) unbemerkt gelassen.
 * `CLIENTID_POSITION` legt die erwartete Position je Funktionsname fest.
 *
 * Eine Mindestzahl an Fundstellen (`MINDESTENS_AUFRUFE`) ist je Fall eine
 * Gegenprobe: fällt sie auf 0, hat sich entweder die Fallverzweigung selbst
 * geändert (umbenannt, verschoben) oder die Suche ist blind geworden — beides
 * soll auffallen, nicht stillschweigend als "keine Funde, also nichts
 * falsch" durchgehen. Derselbe Schutz gilt jetzt auch für den generischen
 * Fänger: wird er nicht gefunden, schlägt die Prüfung an, statt stillschweigend
 * nichts zu prüfen.
 *
 * Aufruf:  node scripts/message-send-clientid-verkabelung-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayPfad = path.join(wurzel, 'packages/server/src/ws/gateway.ts');
const protokollPfad = path.join(wurzel, 'packages/shared/src/protocol.ts');

let fehler = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ist=${JSON.stringify(ist)} soll=${JSON.stringify(soll)}`}`);
};

/* ── 1: das Protokoll trägt das Feld ─────────────────────────── */

const protokollText = fs.readFileSync(protokollPfad, 'utf8');
console.log('\nprotocol.ts:');
pruef(
  "'error'-Ereignis hat ein optionales Feld clientId",
  /'error'[\s\S]{0,600}?clientId\?:\s*string/.test(protokollText),
  true,
);

/* ── 2: gateway.ts ────────────────────────────────────────────── */

const quelle = ts.createSourceFile(
  gatewayPfad, fs.readFileSync(gatewayPfad, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
);

/** Findet die CaseClause `case '<name>':` im großen switch — egal wie tief sie
 *  im Baum liegt, damit ein Umbau der umgebenden Funktion die Suche nicht
 *  bricht. */
function findeFall(knoten, name) {
  let treffer = null;
  const gehe = (n) => {
    if (treffer) return;
    if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && n.expression.text === name) {
      treffer = n;
      return;
    }
    ts.forEachChild(n, gehe);
  };
  gehe(knoten);
  return treffer;
}

/**
 * Findet den generischen Wurf-Fänger `handleEvent(session, ev).catch(…)` in
 * handleConnection(). Strukturell erkannt (Aufruf von `.catch` auf einem
 * Aufruf von `handleEvent`), nicht über eine Zeilennummer — die verschiebt
 * sich bei jedem Umbau der ~400 Zeilen dazwischen.
 */
function findeGenerischenFaenger(knoten) {
  let treffer = null;
  const gehe = (n) => {
    if (treffer) return;
    if (
      ts.isCallExpression(n)
      && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === 'catch'
      && ts.isCallExpression(n.expression.expression)
      && ts.isIdentifier(n.expression.expression.expression)
      && n.expression.expression.expression.text === 'handleEvent'
    ) {
      treffer = n;
      return;
    }
    ts.forEachChild(n, gehe);
  };
  gehe(knoten);
  return treffer;
}

/** Positionsindex (0-basiert), an der die clientId je Funktion stehen muss —
 *  siehe deren Signaturen in gateway.ts. Ein Treffer an irgendeiner anderen
 *  Stelle der Argumentliste zählt NICHT, siehe Kopfkommentar. */
const CLIENTID_POSITION = { fail: 5, darf: 2, chiffratNoetig: 5 };
const ABWEISENDE_AUFRUFE = new Set(Object.keys(CLIENTID_POSITION));

/** Sammelt alle fail()/darf()/chiffratNoetig()-Aufrufe unter `wurzelKnoten`
 *  und prüft je Fund, ob das clientId-tragende Argument (welches genau, hängt
 *  vom Funktionsnamen ab — s. o.) an der erwarteten Position steht. */
function sammleAufrufe(wurzelKnoten, erwarteterAusdruck) {
  const gefunden = [];
  const gehe = (n) => {
    if (ts.isCallExpression(n)) {
      const name = n.expression.getText(quelle);
      if (ABWEISENDE_AUFRUFE.has(name)) {
        const argListe = n.arguments.map((a) => a.getText(quelle));
        const zeile = quelle.getLineAndCharacterOfPosition(n.getStart(quelle)).line + 1;
        const position = CLIENTID_POSITION[name];
        gefunden.push({
          name, argListe, zeile,
          traegtClientId: argListe[position] === erwarteterAusdruck,
        });
      }
    }
    ts.forEachChild(n, gehe);
  };
  gehe(wurzelKnoten);
  return gefunden;
}

/* Innerhalb einer `case '…':`-Verzweigung heißt die Kennung schlicht
   `ev.clientId`; im generischen Fänger — wo `ev` nur als `ClientEvent`
   typisiert ist, nicht als die enge Ereignisvariante — steht dafür die
   typsichere Hilfsfunktion `clientIdVon(ev)` (siehe gateway.ts). `sammleAufrufe`
   bekommt darum mitgegeben, welcher der beiden Ausdrücke hier erwartet wird. */

/* ── 2a: frühe Rückgaben je Ereignisart mit clientId ─────────────────── */

const FAELLE = [
  { name: 'message:send', mindestens: 6 },
  { name: 'poll:create', mindestens: 4 },
  { name: 'message:forward', mindestens: 6 },
  { name: 'voice:send', mindestens: 4 },
];

for (const { name, mindestens } of FAELLE) {
  const fall = findeFall(quelle, name);
  console.log(`\ngateway.ts, case '${name}':`);
  pruef('die Verzweigung wurde gefunden', Boolean(fall), true);
  if (!fall) continue;

  const gefunden = sammleAufrufe(fall, 'ev.clientId');
  pruef(`mindestens ${mindestens} abweisende Aufrufe gefunden (Gegenprobe gegen eine blinde Suche)`,
    gefunden.length >= mindestens, true);

  for (const f of gefunden) {
    pruef(`Zeile ${f.zeile}: ${f.name}(…) trägt ev.clientId an Position ${CLIENTID_POSITION[f.name]}`,
      f.traegtClientId, true);
  }
}

/* ── 2b: der generische Wurf-Fänger ──────────────────────────────────── */

console.log('\ngateway.ts, generischer Wurf-Fänger (handleEvent(...).catch(...)):');
const faenger = findeGenerischenFaenger(quelle);
pruef('der Fänger wurde gefunden', Boolean(faenger), true);

if (faenger) {
  const rueckruf = faenger.arguments[0];
  pruef('der Fänger hat eine Rückruffunktion als Argument',
    Boolean(rueckruf) && (ts.isArrowFunction(rueckruf) || ts.isFunctionExpression(rueckruf)), true);

  const gefunden = rueckruf ? sammleAufrufe(rueckruf, 'clientIdVon(ev)') : [];
  const MINDESTENS_FAENGER_AUFRUFE = 1; // fail(session, code, message, requestIdVon(ev), werte, clientIdVon(ev))
  pruef(`mindestens ${MINDESTENS_FAENGER_AUFRUFE} abweisenden Aufruf im Fänger gefunden (Gegenprobe gegen eine blinde Suche)`,
    gefunden.length >= MINDESTENS_FAENGER_AUFRUFE, true);

  for (const f of gefunden) {
    pruef(`Zeile ${f.zeile}: ${f.name}(…) trägt clientIdVon(ev) an Position ${CLIENTID_POSITION[f.name]}`,
      f.traegtClientId, true);
  }
}

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mJede Abweisung von message:send, poll:create, message:forward und voice:send trägt ihre clientId weiter — an der richtigen Stelle, ob über ein frühes fail()-Return oder über den generischen Wurf-Fänger.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
