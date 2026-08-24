/**
 * Prüft, dass die Link-Vorschau ihre eigene Zusage einhält: das Ziel darf
 * nicht im internen Netz liegen — auch nicht nach einer Umleitung.
 *
 * DER BEFUND
 *
 * services/links.ts prüfte mit targetIsSafe() nur die URL, die jemand in den
 * Chat gestellt hat, und rief sie dann mit `redirect: 'follow'` ab. Jeden
 * weiteren Sprung erledigte Node — ungeprüft. Eine öffentlich erreichbare
 * Seite, die mit `302 -> http://127.0.0.1:8787/` oder
 * `302 -> http://192.168.1.1/` antwortet, führte den Server damit direkt auf
 * seine eigenen Dienste und ins Heimnetz des Pi. Der Kopfkommentar der Datei
 * versprach genau den Schutz, den der Code nicht lieferte.
 *
 * WIE HIER GEPRÜFT WIRD — ohne einen einzigen Zugriff nach draußen
 *
 * Zwei Attrappenserver auf 127.0.0.1 mit vom System vergebenen Ports:
 *
 *   · ATTRAPPE ÖFFENTLICH — steht für „eine Seite im Internet". Ihr Ursprung
 *     ist die EINZIGE Ausnahme, die die Prüfvariante von targetIsSafe()
 *     durchlässt; über jedes andere Ziel entscheidet die echte Prüfung. Damit
 *     wird hier nicht die Attrappe getestet, sondern targetIsSafe() selbst.
 *   · ATTRAPPE INTERN — steht für den internen Dienst, den niemand erreichen
 *     können soll (Router-Oberfläche, Serverport). Sie merkt sich jeden
 *     Zugriff. Diese Zählung ist der eigentliche Beweis: kommt sie über null,
 *     ist der Server als Sprungbrett benutzt worden.
 *
 * Ein echtes Ziel im LAN (192.168.x) wird bewusst NICHT angesprochen — mit
 * dem Fehler drin würde daraus ein echter Verbindungsversuch ins fremde Netz.
 * 127.0.0.1 läuft durch dieselbe Zeile in isPrivateAddress() und bleibt im
 * Rechner.
 *
 * Aufruf:  node scripts/link-vorschau-umleitung-pruefen.mjs
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from '../db/index.js';
import { fetchPreview, holeMitUmleitungspruefung, targetIsSafe } from '../services/links.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};
const pruefWahr = (name: string, bedingung: boolean, hinweis = '') => {
  if (bedingung) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); return; }
  fehler++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${hinweis ? `  — ${hinweis}` : ''}`);
};

const SEITE = (titel: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${titel}</title></head><body>x</body></html>`;

/* ── Attrappe INTERN ─────────────────────────────────────────────
   Der Dienst, den der Server nicht anfassen darf. Jeder Zugriff wird gezählt. */
let internGetroffen = 0;
const intern = http.createServer((_req, res) => {
  internGetroffen++;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(SEITE('Router-Verwaltung'));
});

/* ── Attrappe ÖFFENTLICH ─────────────────────────────────────────
   Spielt die Seite, die jemand in den Chat stellt. Alle Umleitungsformen,
   die der Schutz aushalten muss, liegen hier als Pfade. */
const oeffentlich = http.createServer((req, res) => {
  const pfad = (req.url ?? '/').split('?')[0];
  const um = (ziel: string) => { res.writeHead(302, { location: ziel }); res.end(); };
  const seite = (titel: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SEITE(titel));
  };

  // Kette: /kette/3 -> /kette/2 -> ... -> /kette/0, dort erst die Seite.
  const kette = /^\/kette\/(\d+)$/.exec(pfad);
  if (kette) {
    const n = Number(kette[1]);
    return n === 0 ? seite('Kettenende') : um(`/kette/${n - 1}`);
  }

  switch (pfad) {
    case '/ok':            return seite('Oeffentliche Seite');
    case '/um-nach-ok':    return um('/ok');
    // Relative Location, die eine Ebene hochgeht — nur richtig aufgelöst
    // landet sie auf /tief/ziel und nicht auf /tief/a/ziel oder /ziel.
    case '/tief/a/start':  return um('../ziel');
    case '/tief/ziel':     return seite('Relativ aufgeloest');
    case '/zu-intern':     return um(`http://127.0.0.1:${internPort}/geheim`);
    case '/zu-datei':      return um('file:///etc/passwd');
    default:               res.writeHead(404); return res.end();
  }
});

await new Promise<void>((fertig) => intern.listen(0, '127.0.0.1', fertig));
await new Promise<void>((fertig) => oeffentlich.listen(0, '127.0.0.1', fertig));
const internPort = (intern.address() as AddressInfo).port;
const oeffentlichPort = (oeffentlich.address() as AddressInfo).port;
const OEFFENTLICH = `http://127.0.0.1:${oeffentlichPort}`;

/* Die Prüfvariante von targetIsSafe(): genau der Ursprung der öffentlichen
   Attrappe gilt als „öffentlich" — über ALLES andere (auch die interne
   Attrappe, auch file:) entscheidet die echte Funktion. Es gibt keine Adresse,
   auf die ein lokaler Server hören könnte und die targetIsSafe() durchließe;
   ohne diese eine Ausnahme wäre der Gutfall nicht prüfbar. Geprüft wird
   dadurch weiterhin die echte Logik — die Ausnahme ist genau ein Ursprung. */
const istSicherFuerPruefung = async (url: URL): Promise<boolean> =>
  url.origin === OEFFENTLICH ? true : await targetIsSafe(url);

const timeout = setTimeout(() => { console.log('  \x1b[31m✗\x1b[0m Prüflauf hängt'); process.exit(1); }, 30_000);
timeout.unref();

/** Ruft ab und liefert entweder den Status oder 'abgelehnt'. Ein geworfener
 *  Fehler zählt als abgelehnt — fetchPreview() macht daraus ebenfalls „keine
 *  Vorschau" (dort der äußere catch). */
async function hole(pfad: string): Promise<number | 'abgelehnt'> {
  const ctrl = new AbortController();
  const uhr = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const ergebnis = await holeMitUmleitungspruefung(
      new URL(OEFFENTLICH + pfad),
      { signal: ctrl.signal },
      istSicherFuerPruefung,
    );
    if (!ergebnis) return 'abgelehnt';
    const status = ergebnis.antwort.status;
    await ergebnis.antwort.text().catch(() => '');
    return status;
  } catch {
    return 'abgelehnt';
  } finally {
    clearTimeout(uhr);
  }
}

/** Wie hole(), gibt aber den Titel der erreichten Seite zurück. */
async function holeTitel(pfad: string): Promise<string | 'abgelehnt'> {
  const ctrl = new AbortController();
  const uhr = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const ergebnis = await holeMitUmleitungspruefung(
      new URL(OEFFENTLICH + pfad),
      { signal: ctrl.signal },
      istSicherFuerPruefung,
    );
    if (!ergebnis) return 'abgelehnt';
    const html = await ergebnis.antwort.text();
    return /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '(kein Titel)';
  } catch {
    return 'abgelehnt';
  } finally {
    clearTimeout(uhr);
  }
}

console.log('Umleitung ins interne Netz');
pruef('302 auf 127.0.0.1 wird abgelehnt', await hole('/zu-intern'), 'abgelehnt');
pruef('der interne Dienst wurde kein einziges Mal angesprochen', internGetroffen, 0);

console.log('\nGrenze der Umleitungskette (MAX_UMLEITUNGEN = 5)');
pruef('5 Sprünge gehen noch durch', await hole('/kette/5'), 200);
pruef('6 Sprünge werden abgelehnt', await hole('/kette/6'), 'abgelehnt');

console.log('\nRelative Location');
pruef(
  '"../ziel" ab /tief/a/start wird gegen die aktuelle URL aufgelöst',
  await holeTitel('/tief/a/start'),
  'Relativ aufgeloest',
);

console.log('\nSchemawechsel');
pruef('302 auf file:// wird abgelehnt', await hole('/zu-datei'), 'abgelehnt');

console.log('\nGewöhnliche Umleitung bleibt möglich');
pruef('302 auf eine andere Seite desselben Hosts folgt weiter', await hole('/um-nach-ok'), 200);
pruef('ohne Umleitung unverändert', await hole('/ok'), 200);

console.log('\nfetchPreview() als Ganzes');
/* Ohne Ausnahmeregel: die echte targetIsSafe() muss ein Ziel auf 127.0.0.1
   schon vor dem ersten Abruf ablehnen. */
const vorher = internGetroffen;
pruef('ein Link direkt auf 127.0.0.1 ergibt keine Vorschau',
  await fetchPreview(`http://127.0.0.1:${internPort}/geheim`), null);
pruef('und wurde auch nicht abgerufen', internGetroffen - vorher, 0);

/* Quelltextprüfung: die Verhaltensprüfungen oben hängen daran, dass
   fetchPreview() den geprüften Weg überhaupt benutzt. Kehrt jemand dort zu
   `redirect: 'follow'` zurück, liefe alles andes weiter grün. */
const quelle = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../services/links.ts'), 'utf8');
/* Kommentare raus — der Kopfkommentar von links.ts erklärt ausdrücklich,
   warum dort kein redirect: 'follow' mehr steht, und darf nicht selbst als
   Fund gelten. Beim Zeilenkommentar schützt das [^:] vor "http://". */
const quelltextOhneKommentare = quelle
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
pruefWahr("kein redirect: 'follow' mehr in links.ts",
  !/redirect:\s*['"]follow['"]/.test(quelltextOhneKommentare));
pruefWahr('fetchPreview() geht über holeMitUmleitungspruefung()',
  /const geholt = await holeMitUmleitungspruefung\(/.test(quelle));

console.log(`\n${fehler === 0 ? '✓ alle Prüfungen bestanden' : `✗ ${fehler} Prüfung(en) fehlgeschlagen`}`);
intern.close();
oeffentlich.close();
process.exit(fehler === 0 ? 0 : 1);
