#!/usr/bin/env node
/**
 * Fund 2 (Auftrag): Deckt `skipWrite` wirklich JEDEN geteilten Speicher ab,
 * den es abdecken soll — oder nur translation_memory?
 *
 * DER FEHLER
 *
 * translate() (translation/index.ts) prüft in dieser Reihenfolge:
 *
 *   if (istEcho(masked, out)) { echoMerken(key); return fertig(...); }
 *   if (opts.skipWrite) { return fertig(...); }
 *
 * `key` (tmKey) ist KONTEXTFREI — Anbieter/Sprachen/maskierter Text, ohne
 * den Gesprächsverlauf, mit dem ein `skipWrite: true`-Aufruf gerade lief
 * (siehe TranslateOptions.skipWrite, translateMessage()s mitWache-Zweig).
 * Weil der Echo-Zweig VOR der skipWrite-Prüfung lag, merkte ein
 * kontextreicher, NICHT teilbarer Aufruf sein Echo trotzdem im GETEILTEN
 * `echoNotiz` — für die nächsten 15 Minuten (ECHO_FRIST_MS) galt dieselbe
 * kurze Wortfolge dann auch in jedem ANDEREN Gespräch, ganz ohne Kontext und
 * OHNE dass das Modell dafür noch einmal gefragt wurde, als unübersetzbar.
 * Genau die Garantie, die `skipWrite` für translation_memory schon gab,
 * fehlte hier für den zweiten geteilten Speicher.
 *
 * WIE HIER GEPRÜFT WIRD
 *
 * Ein erfundener lokaler Dienst zählt jede Anfrage und gibt IMMER denselben
 * Eingabetext als „Übersetzung" zurück — ein garantiertes, reproduzierbares
 * Echo, ganz ohne auf ein bestimmtes Modellverhalten angewiesen zu sein.
 *
 *   1. Aufruf A: derselbe Text, MIT Kontext, `skipWrite: true` — genau der
 *      mitWache-Fall aus translateMessage(). Ein Echo, das (richtig) NICHT
 *      geschrieben werden darf.
 *   2. Aufruf B, UNMITTELBAR danach: DERSELBE Text, DIESELBEN Sprachen,
 *      aber OHNE Kontext und OHNE skipWrite — eine andere, kontextfreie
 *      Unterhaltung, die zufällig densselben tmKey trifft.
 *
 * Schrieb Aufruf A fälschlich in `echoNotiz`, wird Aufruf B NIE beim
 * erfundenen Dienst nachgefragt (echoGemerkt() kürzt sofort ab) — der
 * Zähler bleibt bei 1. Ist `echoNotiz` für den skipWrite-Aufruf geschützt,
 * fragt Aufruf B den Dienst ein zweites Mal — der Zähler steht bei 2. Das
 * ist die Unterscheidung, an der diese Prüfung hängt; alles andere
 * (Anfragetext, Fehlerfreiheit, Zustand) ist in beiden Fassungen gleich und
 * dient nur der Absicherung, dass der Aufbau selbst stimmt.
 *
 *   node scripts/geteiltes-echo-skipwrite-pruefen.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HIER = fileURLToPath(import.meta.url);
const WURZEL = path.resolve(path.dirname(HIER), '..');

if (!process.env.STELLIUM_ECHO_TEILUNG_KIND) {
  const tsx = path.join(WURZEL, 'node_modules', '.bin', 'tsx');
  if (!fs.existsSync(tsx)) {
    console.error('tsx fehlt — einmal "npm install" laufen lassen.');
    process.exit(1);
  }
  const kind = spawn(tsx, [HIER], {
    stdio: 'inherit',
    env: { ...process.env, STELLIUM_ECHO_TEILUNG_KIND: '1' },
  });
  kind.on('exit', (code) => process.exit(code ?? 1));
} else {
  await pruefen();
}

async function pruefen() {
  const ergebnisse = [];
  const pruefe = (name, bedingung, hinweis = '') => {
    if (bedingung) { ergebnisse.push(1); console.log(`  ✓ ${name}`); }
    else { ergebnisse.push(0); console.log(`  ✗ ${name}${hinweis ? ` — ${hinweis}` : ''}`); }
  };

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-echo-teilung-'));
  process.env.DATA_DIR = path.join(ordner, 'daten');
  process.env.AI_PROVIDER = 'local';
  process.env.AI_TIMEOUT_MS = '2000';
  process.env.JWT_SECRET = 'pruefunglaeuftmitfestemgeheimnis';

  const port = await new Promise((fertig) => {
    const sucher = net.createServer();
    sucher.listen(0, '127.0.0.1', () => {
      const p = sucher.address().port;
      sucher.close(() => fertig(p));
    });
  });
  process.env.LOCAL_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LOCAL_MODEL = 'pruefmodell';

  // Der Text kommt IMMER unverändert zurück — ein garantiertes Echo,
  // unabhängig davon, was im Anfragetext steht (Kontext eingeschlossen).
  const TEXT = 'the quick brown fox jumps over the lazy dog';
  let anfragen = 0;
  const dienst = http.createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'pruefmodell' }] }));
    }
    anfragen += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      translation: TEXT, detected_source_language: 'en', confidence: 0.9,
    }) } }] }));
  });
  await new Promise((r) => dienst.listen(port, '127.0.0.1', r));

  try {
    const { initDb } = await import('../packages/server/src/db/index.ts');
    const { migrate } = await import('../packages/server/src/db/migrate.ts');
    initDb(); migrate();
    const { translate } = await import('../packages/server/src/translation/index.ts');

    console.log('\nAufruf A — MIT Gesprächskontext, skipWrite: true (mitWache-Fall)');
    const a = await translate({
      text: TEXT, targetLang: 'de', sourceLang: 'en',
      context: 'Kanalkontext: Feature-Besprechung von gestern', skipWrite: true,
    });
    pruefe('wird als Echo erkannt (unübersetzt)', a.unuebersetzt === true && a.noop === true,
      `unuebersetzt=${a.unuebersetzt}, noop=${a.noop}, text="${a.text}"`);
    // translate() fasst bei einem Echo einmal nach (deutlichere Anweisung,
    // siehe index.ts) — auch der erfundene Dienst antwortet dabei wieder
    // mit einem Echo, macht also zwei Anfragen für einen einzigen
    // translate()-Aufruf. Das ist erwartetes, unverändertes Verhalten und
    // nur die Ausgangsbasis für die eigentliche Prüfung unten.
    pruefe('der erfundene Dienst wurde dafür zweimal gefragt (Anlauf + Nachfassen)', anfragen === 2, `anfragen=${anfragen}`);

    console.log('\nAufruf B — direkt danach, DERSELBE Text/Sprachen, aber OHNE Kontext, OHNE skipWrite');
    console.log('(eine andere, kontextfreie Unterhaltung, die zufällig denselben geteilten Schlüssel trifft)');
    const b = await translate({ text: TEXT, targetLang: 'de', sourceLang: 'en' });
    pruefe('wird ebenfalls als Echo erkannt (unübersetzt)', b.unuebersetzt === true && b.noop === true,
      `unuebersetzt=${b.unuebersetzt}, noop=${b.noop}, text="${b.text}"`);

    console.log('\nDIE KERNFRAGE: wurde für B wirklich noch einmal gefragt, oder kam die Absage aus dem GETEILTEN Merker von A?');
    pruefe(
      'der erfundene Dienst wurde für B noch einmal gefragt (Anlauf + Nachfassen) — '
        + 'A\'s Echo-Merker (skipWrite) darf B nicht stillschweigend abkürzen',
      anfragen === 4,
      `anfragen=${anfragen} — stünde bei 2, hätte A\'s kontextreicher, geteilter Merker B\'s eigene, kontextfreie Anfrage abgefangen`,
    );
  } finally {
    dienst.close();
    fs.rmSync(ordner, { recursive: true, force: true });
  }

  const gut = ergebnisse.filter(Boolean).length;
  if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
  console.log(`\n${gut === ergebnisse.length ? '✓' : '✗'} ${gut}/${ergebnisse.length} bestanden`);
  process.exit(gut === ergebnisse.length ? 0 : 1);
}
