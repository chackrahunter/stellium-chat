#!/usr/bin/env node
/**
 * Fund 3 (Auftrag): Sagt `aiCapabilities().translation` die Wahrheit, WÄHREND
 * eine Vertretung erfolgreich übersetzt?
 *
 * DER FEHLER
 *
 * aiCapabilities() (translation/index.ts) setzte bisher:
 *
 *   const lokalAntwortet = !lage || lage.zustand === 'erreichbar';
 *   translation: provider.name !== 'demo' && lokalAntwortet,
 *
 * `lokalAntwortet` prüft NUR, ob das EIGENE Modell antwortet — nicht, ob
 * Übersetzen gerade FUNKTIONIERT. Springt eine Vertretung ein (der eigene
 * Rechner ist aus, ein Groq-Schlüssel liegt vor, siehe ersatzUebernimmt()),
 * steht `lage.zustand` weiterhin auf "antwortet-nicht" — nicht, weil
 * Übersetzen nicht ginge, sondern weil das EIGENE Modell nicht antwortet.
 * `translation` fiel damit auf `false`, obwohl in genau diesem Moment jede
 * Nachricht erfolgreich über die Vertretung übersetzt wird. Sichtbare Folge
 * (Composer.tsx:175, `needsPreview = ... && ai?.translation && ...`): die
 * Vorschau im Compose-Fenster verschwindet, während Übersetzen nachweislich
 * läuft.
 *
 * WAS GEPRÜFT WIRD
 *
 * Derselbe Aufbau wie in scripts/modell-ausfall-pruefen.mjs (pruefenErsatz):
 * der eigene Rechner ist aus, ein Groq-Schlüssel liegt vor, die Vertretung
 * übernimmt. Zusätzlich zur dortigen Prüfung (die den Übersetzungsweg selbst
 * abdeckt, nicht die Auskunft) hier: bleibt `translation` während einer
 * ERFOLGREICH übersetzenden Vertretung `true`, und bleibt `vertretung`
 * weiterhin ehrlich benannt (WER übersetzt, unverändert durch diese
 * Behebung)?
 *
 *   node scripts/uebersetzung-faehigkeit-pruefen.mjs
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

if (!process.env.STELLIUM_FAEHIGKEIT_KIND) {
  const tsx = path.join(WURZEL, 'node_modules', '.bin', 'tsx');
  if (!fs.existsSync(tsx)) {
    console.error('tsx fehlt — einmal "npm install" laufen lassen.');
    process.exit(1);
  }
  const kind = spawn(tsx, [HIER], {
    stdio: 'inherit',
    env: { ...process.env, STELLIUM_FAEHIGKEIT_KIND: '1' },
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

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-faehigkeit-'));
  process.env.DATA_DIR = path.join(ordner, 'daten');
  process.env.AI_PROVIDER = 'local';
  process.env.AI_TIMEOUT_MS = '2000';
  process.env.JWT_SECRET = 'pruefunglaeuftmitfestemgeheimnis';

  const freierPort = () => new Promise((fertig) => {
    const sucher = net.createServer();
    sucher.listen(0, '127.0.0.1', () => {
      const p = sucher.address().port;
      sucher.close(() => fertig(p));
    });
  });
  const lokalerPort = await freierPort();
  const groqPort = await freierPort();

  process.env.LOCAL_BASE_URL = `http://127.0.0.1:${lokalerPort}/v1`;
  process.env.LOCAL_MODEL = 'pruefmodell';
  process.env.GROQ_API_KEY = 'pruef-schluessel-kein-echter';
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${groqPort}/v1`;
  process.env.GROQ_MODEL = 'pruefmodell-groq';
  process.env.GROQ_FAST_MODEL = 'pruefmodell-groq';

  // Der eigene Rechner ist aus: jede Verbindung wird abgelehnt.
  const lokalerDienst = http.createServer((req, res) => res.destroy());
  await new Promise((r) => lokalerDienst.listen(lokalerPort, '127.0.0.1', r));

  const groqDienst = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      translation: 'Ich bin auf dem Weg zur Besprechung',
      detected_source_language: 'en', confidence: 0.95,
    }) } }] }));
  });
  await new Promise((r) => groqDienst.listen(groqPort, '127.0.0.1', r));

  try {
    const { initDb } = await import('../packages/server/src/db/index.ts');
    const { migrate } = await import('../packages/server/src/db/migrate.ts');
    initDb(); migrate();
    const { translate, aiCapabilities } = await import('../packages/server/src/translation/index.ts');

    console.log('\nVor jeder Übersetzung: kein bekannter Zustand — aiCapabilities().translation darf nichts behaupten, was noch nicht geprüft ist');
    // lokalerZustand ist hier noch null (nichts geprüft) — lokalAntwortet
    // wäre in diesem Moment `true` (per Definition „noch nichts geprüft"),
    // unabhängig von der Behebung. Das ist bewusst nicht Teil dieser
    // Prüfung; es geht ausschließlich um den Zustand WÄHREND die
    // Vertretung übersetzt (unten).

    console.log('\nEigener Rechner aus, Groq-Schlüssel liegt vor — Übersetzung anstoßen');
    const ergebnis = await translate({ text: 'on my way to the meeting room', targetLang: 'de', sourceLang: 'en' });
    pruefe('übersetzt trotzdem — die Vertretung übernimmt', !ergebnis.unuebersetzt && ergebnis.provider === 'groq',
      `unuebersetzt=${ergebnis.unuebersetzt}, provider="${ergebnis.provider}"`);

    const caps = aiCapabilities();
    pruefe('das eigene Modell gilt (zurecht) als "antwortet nicht"', caps.lokalerZustand === 'antwortet-nicht',
      `lokalerZustand="${caps.lokalerZustand}"`);
    pruefe('die Auskunft nennt die Vertretung beim Namen', caps.vertretung === 'groq', `vertretung="${caps.vertretung}"`);

    console.log('\nDIE KERNFRAGE: sagt "translation" die Wahrheit, während die Vertretung erfolgreich übersetzt?');
    pruefe(
      'translation ist true — Übersetzen funktioniert nachweislich, auch wenn das EIGENE Modell schweigt',
      caps.translation === true,
      `translation=${caps.translation} — mit lokalerZustand="antwortet-nicht" allein wäre das fälschlich false, obwohl gerade eben erfolgreich über "${ergebnis.provider}" übersetzt wurde`,
    );

    console.log('\nZweite Übersetzung — dieselbe Auskunft muss stabil bleiben');
    const zweite = await translate({ text: 'the deploy is green', targetLang: 'de', sourceLang: 'en' });
    pruefe('übersetzt weiterhin über die Vertretung', !zweite.unuebersetzt && zweite.provider === 'groq');
    pruefe('translation bleibt true', aiCapabilities().translation === true, `translation=${aiCapabilities().translation}`);
  } finally {
    groqDienst.close();
    lokalerDienst.close();
    fs.rmSync(ordner, { recursive: true, force: true });
  }

  const gut = ergebnisse.filter(Boolean).length;
  if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
  console.log(`\n${gut === ergebnisse.length ? '✓' : '✗'} ${gut}/${ergebnisse.length} bestanden`);
  process.exit(gut === ergebnisse.length ? 0 : 1);
}
