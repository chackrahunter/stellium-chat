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
   hindurchstarten, damit der Aufruf für alle Prüfläufe derselbe bleibt.

   Drei Kinder statt eines: pruefen() (kein Ersatz eingerichtet — die
   Ausgangslage von je her), pruefenErsatz() (ein Groq-Schlüssel liegt vor)
   und pruefenErholung() (der Ersatz tritt ab, sobald der eigene Rechner
   wirklich wieder erreichbar ist — Fund 1, Auftrag) brauchen alle drei ein
   frisches config.ts, das GROQ_API_KEY erst beim Laden des Moduls liest. Im
   selben Prozess nacheinander gestartet, sähe der zweite/dritte Lauf noch
   den vorherigen, bereits geladenen Stand. */
if (!process.env.STELLIUM_AUSFALL_KIND) {
  const tsx = path.join(WURZEL, 'node_modules', '.bin', 'tsx');
  if (!fs.existsSync(tsx)) {
    console.error('tsx fehlt — einmal "npm install" laufen lassen.');
    process.exit(1);
  }
  let alleGut = true;
  for (const kind of ['1', '2', '3']) {
    const code = await new Promise((fertig) => {
      const kindProzess = spawn(tsx, [HIER], {
        stdio: 'inherit',
        env: { ...process.env, STELLIUM_AUSFALL_KIND: kind },
      });
      kindProzess.on('exit', (c) => fertig(c ?? 1));
    });
    if (code !== 0) alleGut = false;
  }
  process.exit(alleGut ? 0 : 1);
} else if (process.env.STELLIUM_AUSFALL_KIND === '1') {
  await pruefen();
} else if (process.env.STELLIUM_AUSFALL_KIND === '2') {
  await pruefenErsatz();
} else {
  await pruefenErholung();
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

/**
 * Derselbe ausgeschaltete Rechner wie oben — aber diesmal steht ein Groq-
 * Schlüssel im Tresor (hier: in der Umgebung, das genügt secret() in
 * config.ts). Ein Ersatz kann also einspringen, und genau das muss dann
 * auch geschehen: pruefen() oben deckt nur den Fall "kein Ersatz da" ab
 * (kein GROQ_API_KEY in seiner Umgebung) — das war schon immer der Fall,
 * für den die schnelle Absage richtig ist, und blieb es nach dem Fund auch.
 * Den Fall "ein Ersatz WÄRE da" prüfte bisher nichts: `translate()` gab
 * bis zur Behebung `unuebersetzt: true` zurück, obwohl `ersatzUebernimmt()`
 * / der Proxy `provider` einen laufenden Groq-Schlüssel längst hätten
 * nutzen können — der Test dafür fehlte, nicht nur die Behebung.
 *
 * Zweite Prüfung hier: eine geglückte Übersetzung über die Vertretung darf
 * NICHT als "das eigene Modell antwortet wieder" durchgehen — sonst träte
 * die Vertretung mit ihrem allerersten Erfolg sofort wieder ab.
 */
async function pruefenErsatz() {
  const ergebnisse = [];
  const pruefe = (name, bedingung, hinweis = '') => {
    if (bedingung) { ergebnisse.push(1); console.log(`  ✓ ${name}`); }
    else { ergebnisse.push(0); console.log(`  ✗ ${name}${hinweis ? ` — ${hinweis}` : ''}`); }
  };

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-ausfall-ersatz-'));

  process.env.DATA_DIR = path.join(ordner, 'daten');
  process.env.AI_PROVIDER = 'local';
  process.env.AI_TIMEOUT_MS = String(2000);
  process.env.JWT_SECRET = 'pruefunglaeuftmitfestemgeheimnis';

  // Zwei erfundene Dienste auf zwei Ports vom Betriebssystem: der eigene
  // (lokale), der nie antwortet, und Groq, der es einspringend tut.
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
  // Fest verdrahtet (pinned): dann fragt die ModelRegistry nie die
  // Modell-Liste ab (siehe fullyPinned, model-registry.ts) — der erfundene
  // Groq-Dienst muss darum nur /chat/completions beantworten, kein
  // /models. Realistischer bräuchte der echte Dienst nur den Schlüssel.
  process.env.GROQ_MODEL = 'pruefmodell-groq';
  process.env.GROQ_FAST_MODEL = 'pruefmodell-groq';

  // Der eigene Rechner ist aus: jede Verbindung wird abgelehnt.
  const lokalerDienst = http.createServer((req, res) => res.destroy());
  await new Promise((r) => lokalerDienst.listen(lokalerPort, '127.0.0.1', r));

  let groqAnfragen = 0;
  const groqDienst = http.createServer((req, res) => {
    groqAnfragen += 1;
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

    console.log('\nEigener Rechner aus, Groq-Schlüssel liegt vor');
    const erste = await translate({ text: 'on my way to the meeting room', targetLang: 'de' });
    pruefe('übersetzt trotzdem — die Vertretung übernimmt',
      !erste.unuebersetzt && erste.text !== 'on my way to the meeting room',
      `unuebersetzt=${erste.unuebersetzt}, text="${erste.text}"`);
    pruefe('die Übersetzung kam von Groq', erste.provider === 'groq', `provider="${erste.provider}"`);
    pruefe('Groq wurde wirklich gefragt (kein Zufallstreffer)', groqAnfragen >= 1);
    pruefe('die Auskunft nennt die Vertretung', aiCapabilities().vertretung === 'groq');
    pruefe(
      'das eigene Modell gilt weiter als "antwortet nicht" — die Vertretung darf das nicht überschreiben',
      aiCapabilities().lokalerZustand === 'antwortet-nicht',
      `lokalerZustand="${aiCapabilities().lokalerZustand}"`,
    );

    console.log('\nZweite Nachricht — die Vertretung bleibt im Amt');
    const zweite = await translate({ text: 'the deploy is green', targetLang: 'de' });
    pruefe('übersetzt weiterhin über Groq', zweite.provider === 'groq' && !zweite.unuebersetzt);
    pruefe('ist immer noch als Vertretung erkennbar', aiCapabilities().vertretung === 'groq');
  } finally {
    lokalerDienst.close();
    groqDienst.close();
    fs.rmSync(ordner, { recursive: true, force: true });
  }

  const gut = ergebnisse.filter(Boolean).length;
  if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
  console.log(`\n${gut === ergebnisse.length ? '✓' : '✗'} ${gut}/${ergebnisse.length} bestanden`);
  process.exit(gut === ergebnisse.length ? 0 : 1);
}

/**
 * Fund 1 (Auftrag): ersatzTrittAb() hatte genau einen Aufrufer —
 * erfolgMelden(), und die wurde nur gerufen, wenn `antwortendeStelle ===
 * aktiv` (translation/index.ts). Solange eine Vertretung lief, lieferte
 * derzeit() aber immer die Vertretung, nie `aktiv` — der Aufruf war damit
 * TOT, sobald er einmal gebraucht wurde: ein einziger vorübergehender
 * Ausfall installierte die Vertretung für immer, bis zum Neustart oder
 * einer von Hand geänderten Einstellung.
 *
 * Diese Prüfung deckt genau das ab, mit zwei Behauptungen, die sich
 * unterscheiden müssen:
 *
 *   A. Eine geglückte Übersetzung ÜBER DIE VERTRETUNG lässt sie NICHT
 *      abtreten — das war schon vorher richtig (siehe pruefenErsatz oben)
 *      und darf es bleiben.
 *   B. Wird der eigene Rechner wirklich wieder erreichbar — nachgewiesen
 *      durch eine direkte, erfolgreiche Prüfung SEINER eigenen Adresse,
 *      nicht durch irgendeine Übersetzung —, tritt die Vertretung ab. Ohne
 *      Neustart, ohne Einstellungsänderung.
 *
 * Der eigene Rechner startet hier als "aus" (jede Verbindung abgelehnt),
 * genau wie in pruefenErsatz — nur dass er hier später "an" geht, per
 * `lokalModus`.
 */
async function pruefenErholung() {
  const ergebnisse = [];
  const pruefe = (name, bedingung, hinweis = '') => {
    if (bedingung) { ergebnisse.push(1); console.log(`  ✓ ${name}`); }
    else { ergebnisse.push(0); console.log(`  ✗ ${name}${hinweis ? ` — ${hinweis}` : ''}`); }
  };

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-ausfall-erholung-'));

  process.env.DATA_DIR = path.join(ordner, 'daten');
  process.env.AI_PROVIDER = 'local';
  process.env.AI_TIMEOUT_MS = String(2000);
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

  // 'aus': jede Verbindung wird abgelehnt. 'an': antwortet wie ein echtes
  // OpenAI-kompatibles Modell — dieselbe Umschaltung wie in pruefen() oben,
  // hier aber für den lokalen statt den Groq-Dienst.
  let lokalModus = 'aus';
  const lokalerDienst = http.createServer((req, res) => {
    if (lokalModus === 'aus') return res.destroy();
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
  await new Promise((r) => lokalerDienst.listen(lokalerPort, '127.0.0.1', r));

  let groqAnfragen = 0;
  const groqDienst = http.createServer((req, res) => {
    groqAnfragen += 1;
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
    const { translate, aiCapabilities, ersatzLaeuft } = await import('../packages/server/src/translation/index.ts');
    const { lageVergessen, lokaleLageJetzt } = await import('../packages/server/src/translation/erreichbarkeit.ts');

    console.log('\nEigener Rechner aus, Groq-Schlüssel liegt vor');
    const erste = await translate({ text: 'on my way to the meeting room', targetLang: 'de' });
    pruefe('übersetzt trotzdem — die Vertretung übernimmt',
      !erste.unuebersetzt && erste.provider === 'groq', `provider="${erste.provider}"`);
    pruefe('die Auskunft nennt die Vertretung', ersatzLaeuft() === 'groq', `ersatzLaeuft()="${ersatzLaeuft()}"`);

    console.log('\nA: eine zweite geglückte Übersetzung ÜBER DIE VERTRETUNG lässt sie NICHT abtreten');
    const zweite = await translate({ text: 'the deploy is green', targetLang: 'de' });
    pruefe('übersetzt weiterhin über Groq', zweite.provider === 'groq' && !zweite.unuebersetzt);
    pruefe(
      'die Vertretung ist NACH ihrem eigenen Erfolg immer noch im Amt (Diskriminierung: kein Rücktritt aus Eigenerfolg)',
      ersatzLaeuft() === 'groq', `ersatzLaeuft()="${ersatzLaeuft()}"`,
    );

    console.log('\nB: der eigene Rechner geht "an" — nur eine direkte Prüfung SEINER Adresse darf das melden');
    lokalModus = 'an';
    // Den zwischengespeicherten Stand verwerfen, statt auf den Ablauf der
    // Frist zu warten: sonst bräuchte diese Prüfung selbst bis zu 30 s.
    lageVergessen();
    const lage = await lokaleLageJetzt();
    pruefe('die direkte Prüfung sieht den eigenen Rechner jetzt als erreichbar',
      lage?.zustand === 'erreichbar', `zustand="${lage?.zustand}"`);

    // ersatzTrittAb() hängt am Übergang in festhalten() an einem spät
    // geladenen dynamischen import() (siehe erreichbarkeit.ts) — der läuft
    // nicht mehr synchron mit await lokaleLageJetzt() durch. Eine Anfrage,
    // die sonst ohnehin auch nur eine Modell-Liste holt (also kein neuer
    // Übersetzungsaufruf, keine neue "Fassung" der Vertretung), genügt, um
    // der Ereignisschleife die Gelegenheit zu geben.
    await new Promise((r) => setTimeout(r, 50));

    pruefe(
      'die Vertretung ist abgetreten — OHNE Neustart, OHNE Einstellungsänderung, '
        + 'und OHNE dass sie selbst noch einmal übersetzt hätte',
      ersatzLaeuft() === null, `ersatzLaeuft()="${ersatzLaeuft()}"`,
    );
    pruefe('die Auskunft in den Einstellungen zeigt denselben Rücktritt',
      aiCapabilities().vertretung === null, `vertretung="${aiCapabilities().vertretung}"`);

    console.log('\nEine weitere Übersetzung läuft jetzt wieder über das eigene Modell, nicht mehr über Groq');
    const groqVorher = groqAnfragen;
    const dritte = await translate({ text: 'lets talk after lunch', targetLang: 'de' });
    pruefe('kam vom eigenen Modell', dritte.provider === 'local', `provider="${dritte.provider}"`);
    pruefe('Groq wurde dafür nicht mehr gefragt', groqAnfragen === groqVorher);
  } finally {
    lokalerDienst.close();
    groqDienst.close();
    fs.rmSync(ordner, { recursive: true, force: true });
  }

  const gut = ergebnisse.filter(Boolean).length;
  if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
  console.log(`\n${gut === ergebnisse.length ? '✓' : '✗'} ${gut}/${ergebnisse.length} bestanden`);
  process.exit(gut === ergebnisse.length ? 0 : 1);
}
