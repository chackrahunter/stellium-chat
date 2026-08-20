/**
 * Was passiert, wenn der Rechner mit dem lokalen Modell nicht antwortet?
 *
 * Auf dem Pi läuft die Übersetzung über ein Modell auf Aryans Windows-Rechner,
 * erreichbar über Tailscale. Der Rechner ist nachts aus. Zwei Dinge müssen
 * dann stimmen, und beide stimmten einmal nicht:
 *
 *   1. Es darf nichts Falsches entstehen. Der Eingabetext als „Übersetzung"
 *      zu speichern wäre schlimmer als gar keine Übersetzung — die Oberfläche
 *      behauptete dann „Übersetzt aus English" an englischem Text.
 *   2. Es darf nicht dauern. Drei Versuche à 25 Sekunden, je Nachricht und je
 *      Zielsprache, nacheinander abgearbeitet: damit steht der Betrieb.
 *
 * Geprüft wird gegen den echten translate()-Weg, nicht gegen einen Nachbau.
 * Der Gegenüber ist ein erfundener OpenAI-Dienst, der auf Zuruf ausfällt.
 *
 *   node scripts/modell-ausfall-pruefen.mjs
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

/* Der Server-Quelltext ist TypeScript und importiert einander als ".js".
   Node allein löst das nicht auf, tsx schon — also einmal durch tsx
   hindurchstarten, damit der Aufruf für alle Prüfläufe derselbe bleibt. */
if (!process.env.STELLIUM_AUSFALL_KIND) {
  const tsx = path.join(WURZEL, 'node_modules', '.bin', 'tsx');
  if (!fs.existsSync(tsx)) {
    console.error('tsx fehlt — einmal "npm install" laufen lassen.');
    process.exit(1);
  }
  const kind = spawn(tsx, [HIER], {
    stdio: 'inherit',
    env: { ...process.env, STELLIUM_AUSFALL_KIND: '1' },
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

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-ausfall-'));

  /* Kurze Frist, damit der Lauf nicht selbst eine Minute braucht. Im Betrieb
     stehen 25 s — die Ersparnis unten skaliert entsprechend mit. */
  const FRIST = 2000;
  process.env.DATA_DIR = path.join(ordner, 'daten');
  process.env.AI_PROVIDER = 'local';
  process.env.AI_TIMEOUT_MS = String(FRIST);
  process.env.JWT_SECRET = 'pruefunglaeuftmitfestemgeheimnis';

  // Port vom Betriebssystem, damit parallele Läufe sich nicht ins Gehege kommen.
  const port = await new Promise((fertig) => {
    const sucher = net.createServer();
    sucher.listen(0, '127.0.0.1', () => {
      const p = sucher.address().port;
      sucher.close(() => fertig(p));
    });
  });
  const ADRESSE = `http://127.0.0.1:${port}/v1`;
  process.env.LOCAL_BASE_URL = ADRESSE;
  process.env.LOCAL_MODEL = 'pruefmodell';

  /** 'an' antwortet, 'aus' lehnt ab, 'stumm' lässt die Anfrage hängen. */
  let modus = 'an';
  const offen = new Set();
  const dienst = http.createServer((req, res) => {
    offen.add(res);
    res.on('close', () => offen.delete(res));
    if (modus === 'aus') return res.destroy();
    if (modus === 'stumm') return;
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'pruefmodell' }] }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      translation: 'Ich bin auf dem Weg zur Besprechung',
      detected_source_language: 'en', confidence: 0.95,
    }) } }] }));
  });
  await new Promise((r) => dienst.listen(port, '127.0.0.1', r));

  /* Ab hier kann alles schiefgehen, und dann muss trotzdem der erfundene
     Dienst zugehen und der Arbeitsordner weg sein. Ohne das blieb bei jedem
     Fehlschlag ein lauschender Server im Prozess — der hält die
     Ereignisschleife am Leben, `process.exit` unten wird nie erreicht, und der
     Aufruf hängt bis zum Abbruch von Hand. */
  try {
  const { initDb } = await import('../packages/server/src/db/index.ts');
  const { migrate } = await import('../packages/server/src/db/migrate.ts');
  initDb(); migrate();
  const { translate, aiCapabilities } = await import('../packages/server/src/translation/index.ts');

  const TEXT = 'on my way to the meeting room';

  console.log('\nRechner an');
  const gut = await translate({ text: TEXT, targetLang: 'de' });
  pruefe('übersetzt', !gut.unuebersetzt && gut.text !== TEXT, `kam zurück: "${gut.text}"`);
  pruefe('meldet sich als erreichbar', aiCapabilities().lokalerZustand === 'erreichbar');
  pruefe('translation ist an', aiCapabilities().translation === true);

  console.log('\nRechner aus (Verbindung abgelehnt)');
  modus = 'aus';
  const t0 = Date.now();
  const erste = await translate({ text: 'can you check the logs please', targetLang: 'de' });
  const ersteDauer = Date.now() - t0;
  pruefe('gibt das Original zurück statt zu raten', erste.text === 'can you check the logs please');
  pruefe('kennzeichnet es als unübersetzt', erste.unuebersetzt === true);
  pruefe('gilt nicht als Übersetzung', erste.noop === true);

  const t1 = Date.now();
  for (const s of ['the deploy is green', 'lets talk after lunch', 'i pushed the fix already']) {
    const r = await translate({ text: s, targetLang: 'de' });
    if (r.text !== s || !r.unuebersetzt) pruefe(`Folge-Nachricht „${s}"`, false, 'wurde nicht sauber abgewiesen');
  }
  const folgeDauer = Date.now() - t1;
  pruefe('weitere Nachrichten warten nicht noch einmal', folgeDauer < 500,
    `${folgeDauer} ms für drei Nachrichten`);
  pruefe('meldet sich als "antwortet nicht"', aiCapabilities().lokalerZustand === 'antwortet-nicht');
  pruefe('translation ist aus', aiCapabilities().translation === false);
  pruefe('nennt einen Grund', Boolean(aiCapabilities().lokalerFehler));

  console.log('\nBereits Übersetztes muss trotzdem ankommen');
  const ausSpeicher = await translate({ text: TEXT, targetLang: 'de' });
  pruefe('kommt aus dem Zwischenspeicher, obwohl niemand antwortet',
    ausSpeicher.cached === true && !ausSpeicher.unuebersetzt);

  console.log('\nRechner hängt (antwortet nie)');
  modus = 'stumm';
  const { lageVergessen } = await import('../packages/server/src/translation/erreichbarkeit.ts');
  lageVergessen();
  const t2 = Date.now();
  const stumm = await translate({ text: 'is anyone there right now', targetLang: 'de' });
  const stummDauer = Date.now() - t2;
  for (const r of offen) r.destroy();
  pruefe('gibt auf, statt drei Versuche abzuwarten', stummDauer < FRIST * 2,
    `${stummDauer} ms bei einer Frist von ${FRIST} ms`);
  pruefe('auch hier das Original, als unübersetzt gekennzeichnet',
    stumm.unuebersetzt === true && stumm.text === 'is anyone there right now');

  console.log(`\n  erste Nachricht nach dem Ausfall: ${ersteDauer} ms`);
  console.log(`  drei weitere zusammen:            ${folgeDauer} ms`);
  console.log(`  hängender Rechner:                ${stummDauer} ms`
    + `  (ohne Test: 3 Versuche à ${FRIST} ms, im Betrieb à 25 s)`);

  } finally {
    dienst.close();
    for (const r of offen) { try { r.destroy(); } catch { /* schon zu */ } }
    fs.rmSync(ordner, { recursive: true, force: true });
  }

  const gut2 = ergebnisse.filter(Boolean).length;
  if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
  console.log(`\n${gut2 === ergebnisse.length ? '✓' : '✗'} ${gut2}/${ergebnisse.length} bestanden`);
  process.exit(gut2 === ergebnisse.length ? 0 : 1);
}
