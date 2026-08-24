/**
 * Eine lange Nachricht auf einem Modell mit kleinem Kontextfenster (8k, wie
 * auf dem Windows-Rechner über Tailscale) — reicht das Antwort-Budget noch
 * neben Anweisung und Anfrage ins Fenster?
 *
 * DER FEHLER, DEN DAS PRÜFT
 *
 * translationBudget() (translation/prompt.ts) rechnete das Antwort-Budget
 * bisher OHNE Bezug zum tatsächlichen Kontextfenster des Modells — ein fester
 * Deckel von 8192, egal ob das Modell 8k oder 128k verkraftet, und ohne
 * Rücksicht darauf, dass Anweisung und Anfrage selbst auch noch Platz im
 * selben Fenster brauchen. Ab etwa 4300 Zeichen reservierte die Formel mehr
 * Antwort-Marken, als nach Abzug von System-Anweisung und Anfrage im Fenster
 * überhaupt noch frei war — die Anfrage schlug fehl, JEDE längere Nachricht,
 * unabhängig vom Anbieter (siehe Auftrag).
 *
 * Geprüft wird gegen den echten translate()-Weg. Der erfundene Dienst
 * verhält sich wie ein echtes 8k-Modell: er lehnt ab, wenn Anfrage + Antwort-
 * Budget zusammen das Fenster sprengen — genau die Bedingung, an der die
 * alte Formel gescheitert ist.
 *
 *   node scripts/uebersetzung-fenster-pruefen.mjs
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

if (!process.env.STELLIUM_FENSTER_KIND) {
  const tsx = path.join(WURZEL, 'node_modules', '.bin', 'tsx');
  if (!fs.existsSync(tsx)) {
    console.error('tsx fehlt — einmal "npm install" laufen lassen.');
    process.exit(1);
  }
  const kind = spawn(tsx, [HIER], {
    stdio: 'inherit',
    env: { ...process.env, STELLIUM_FENSTER_KIND: '1' },
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

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-fenster-'));
  process.env.DATA_DIR = path.join(ordner, 'daten');
  process.env.AI_PROVIDER = 'local';
  process.env.AI_TIMEOUT_MS = '5000';
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

  /* Das Modell verkraftet 8192 Marken, Anfrage und Antwort zusammen — wie
     ein reales llama.cpp/ollama auf dem Windows-Rechner (siehe Auftrag).
     kontextfenster() in openai-compatible.ts fällt ohne einen laufenden
     registry.refresh() (den kein translate()-Aufruf auslöst) ohnehin auf
     genau diesen Wert zurück (MIN_CONTEXT, model-registry.ts) — der
     erfundene Dienst muss dieselbe Zahl also gar nicht extra ausweisen,
     er muss sie nur beim Ablehnen einhalten. */
  const FENSTER = 8192;
  let anfragenGezaehlt = 0;
  const maxTokensGesehen = [];

  const dienst = http.createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'pruefmodell' }] }));
    }
    const brocken = [];
    req.on('data', (b) => brocken.push(b));
    req.on('end', () => {
      anfragenGezaehlt += 1;
      const body = JSON.parse(Buffer.concat(brocken).toString('utf8'));
      const promptZeichen = (body.messages ?? []).reduce((n, m) => n + String(m.content ?? '').length, 0);
      // Dieselbe Faustregel wie translation/fenster.ts: lateinische Schrift
      // kostet rund 3 Zeichen je Marke. Der erfundene Dienst bewertet damit
      // dieselbe Anfrage, die der Client mit markenSchaetzung() selbst
      // budgetiert hat — reiner ASCII-Text in dieser Prüfung, keine
      // Verzerrung durch CJK/Emoji.
      const promptMarken = Math.ceil(promptZeichen / 3);
      const maxTokens = Number(body.max_completion_tokens) || 0;
      maxTokensGesehen.push(maxTokens);
      const gesamt = promptMarken + maxTokens;

      if (gesamt > FENSTER) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          error: {
            message: `request (${gesamt} tokens) exceeds the available context size (${FENSTER} tokens)`,
          },
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        translation: 'Ich bin auf dem Weg zum Besprechungsraum, bin gleich da.',
        detected_source_language: 'en', confidence: 0.9,
      }) } }] }));
    });
  });
  await new Promise((r) => dienst.listen(port, '127.0.0.1', r));

  try {
    const { initDb } = await import('../packages/server/src/db/index.ts');
    const { migrate } = await import('../packages/server/src/db/migrate.ts');
    initDb(); migrate();
    const { translate } = await import('../packages/server/src/translation/index.ts');

    // Eine Zeichenkette, real genug (kein CJK, keine Ziffern-Suppe), damit
    // eine Zeichen/Marke-Schätzung wie im Betrieb trägt.
    const phrase = 'on my way to the meeting room right now, see you there in a few minutes. ';
    let lang = '';
    while (lang.length < 4500) lang += phrase;
    lang = lang.slice(0, 4500);

    console.log(`\nNachricht mit ${lang.length} Zeichen auf einem 8k-Fenster (Auftrag: ab rund 4300 Zeichen scheiterte das bisher IMMER)`);
    const ergebnis = await translate({ text: lang, targetLang: 'de' });
    pruefe(
      'wird übersetzt statt stillschweigend als unübersetzt zu gelten',
      !ergebnis.unuebersetzt,
      `unuebersetzt=${ergebnis.unuebersetzt}, text (erste 60 Zeichen)="${ergebnis.text.slice(0, 60)}"`,
    );
    pruefe('der erfundene Dienst wurde wirklich gefragt', anfragenGezaehlt >= 1);
    pruefe(
      'das angefragte Antwort-Budget lässt neben der Anfrage noch Platz im Fenster',
      maxTokensGesehen.every((m) => m > 0) && maxTokensGesehen[maxTokensGesehen.length - 1] < FENSTER,
      `zuletzt angefragt: ${maxTokensGesehen[maxTokensGesehen.length - 1]} von ${FENSTER} Marken`,
    );

    console.log('\nEine winzige Nachricht bleibt unbeeinflusst (Verhalten unterhalb der Schwelle unverändert)');
    const kurz = await translate({ text: 'good morning everyone', targetLang: 'de' });
    pruefe('wird übersetzt', !kurz.unuebersetzt && kurz.text !== 'good morning everyone');
  } finally {
    dienst.close();
    fs.rmSync(ordner, { recursive: true, force: true });
  }

  const gut = ergebnisse.filter(Boolean).length;
  if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
  console.log(`\n${gut === ergebnisse.length ? '✓' : '✗'} ${gut}/${ergebnisse.length} bestanden`);
  process.exit(gut === ergebnisse.length ? 0 : 1);
}
