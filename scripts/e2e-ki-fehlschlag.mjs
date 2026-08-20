/**
 * Was zeigt die Oberfläche, wenn eine KI-Anfrage scheitert?
 *
 * Der Vorfall: Don öffnet „Protokoll" in einem gut gefüllten Kanal. Das
 * Fenster zeigt einen Kreisel und „StelliumAI schreibt mit…" — und bleibt so
 * stehen. Gleichzeitig geht rechts unten ein Meldungsfenster auf:
 *
 *     Serverfehler
 *     ollama 400: {"error":{"code":400,"message":"request (10340 tokens)
 *     exceeds the available context size (8192 tokens)…
 *
 * Der Fehler war also angekommen — das Fenster hat ihn nur nicht bemerkt.
 * `ai:protocol` trägt im Protokoll kein `requestId`-Feld, der Fehler kam
 * deshalb ohne Kennung herein und lief ins Leere. Ein Kreisel, der nie
 * aufhört, ist die unehrlichste Anzeige, die es gibt: man wartet.
 *
 * Geprüft werden drei Wege, auf denen dieselbe Anzeige hängenbleiben konnte:
 *
 *   1. Der Server antwortet mit einem Fehler (Protokoll).
 *   2. Der Server antwortet mit einem Fehler (Aufgabenerkennung) — dort ging
 *      die Kennung zwar hinaus, aber niemand wartete auf sie.
 *   3. Es kommt gar nichts, weil die Leitung mitten in der Anfrage abreißt.
 *
 * Und zusätzlich, weil es derselbe Vorfall ist: die rohe Ausgabe des fremden
 * Dienstes darf nicht als Satz in der Meldung stehen.
 *
 * Der Gegenüber ist ein erfundener Modelldienst, der jede Anfrage mit genau
 * jener 400 beantwortet. Gemessen wird gegen den GEBAUTEN Stand, nicht gegen
 * den Entwicklungsserver:
 *
 *     npx vite build packages/desktop
 *     STELLIUM_APP=http://127.0.0.1:4173 node scripts/e2e-ki-fehlschlag.mjs
 *
 * Ohne STELLIUM_APP wird der Entwicklungsserver auf 5173 erwartet.
 */
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/* Genau die Antwort aus dem Vorfall — Wort für Wort, damit dieser Lauf den
   Fall festhält und nicht eine Näherung davon. */
const OLLAMA_400 = {
  error: {
    code: 400,
    message: 'request (10340 tokens) exceeds the available context size (8192 tokens), '
      + 'try increasing it',
    type: 'invalid_request_error',
  },
};

const freierPort = () => new Promise((fertig) => {
  const sucher = net.createServer();
  sucher.listen(0, '127.0.0.1', () => {
    const p = sucher.address().port;
    sucher.close(() => fertig(p));
  });
});

/* ── Der erfundene Modelldienst ───────────────────────────────── */

const modellPort = await freierPort();
/** 'fehler' antwortet mit der 400, 'stumm' lässt die Anfrage hängen. */
let modellModus = 'fehler';
const haengende = new Set();
const modell = http.createServer((req, res) => {
  if (req.url?.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'pruefmodell' }] }));
  }
  if (modellModus === 'stumm') { haengende.add(res); res.on('close', () => haengende.delete(res)); return; }
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify(OLLAMA_400));
});
await new Promise((f) => modell.listen(modellPort, '127.0.0.1', f));

/* Der Probeserver erbt die Umgebung — deshalb muss das hier vor seinem Start
   stehen, nicht danach. */
process.env.AI_PROVIDER = 'local';
process.env.LOCAL_BASE_URL = `http://127.0.0.1:${modellPort}/v1`;
process.env.LOCAL_MODEL = 'pruefmodell';
process.env.LOCAL_FAST_MODEL = 'pruefmodell';
process.env.AI_TIMEOUT_MS = process.env.AI_TIMEOUT_MS ?? '4000';

const { probeserver } = await import('./probeserver.mjs');
const { verlaufSaeen } = await import('./verlauf-saeen.mjs');

async function probeserverMitAnlaeufen(versuche = 6) {
  let letzter;
  for (let n = 0; n < versuche; n += 1) {
    try { return await probeserver(); } catch (f) { letzter = f; await new Promise((r) => setTimeout(r, 500)); }
  }
  throw letzter;
}

const probe = await probeserverMitAnlaeufen();
let browser = null;

try {
  const { kanalId } = await verlaufSaeen(probe, 25);

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
  const p = await ctx.newPage();
  const seitenfehler = [];
  p.on('pageerror', (e) => seitenfehler.push(String(e)));

  /* Die Leitung greifbar machen, um sie später wirklich zu kappen. Playwright
     schaltet mit setOffline nur die Netzemulation um — eine bereits offene
     WebSocket-Leitung bleibt dabei stehen, und eine Messung darüber sagt
     nichts über das Wiederverbinden. Hier ist das nachgemessen worden. */
  await p.addInitScript(() => {
    const Echt = window.WebSocket;
    window.__leitungen = [];
    window.WebSocket = function (...a) { const s = new Echt(...a); window.__leitungen.push(s); return s; };
    window.WebSocket.prototype = Echt.prototype;
    Object.assign(window.WebSocket, Echt);
  });

  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.stream [data-message-id]', { timeout: 30000 });
  await p.waitForTimeout(1500);
  await p.evaluate((id) => {
    const knopf = [...document.querySelectorAll('.stream [data-message-id]')].pop();
    knopf?.scrollIntoView();
    return id;
  }, kanalId);

  const protokollKnopf = 'button[title="Protokoll schreiben"]';
  const extractKnopf = 'button[title="Aufgaben aus dem Verlauf ziehen"]';

  console.log('\nDie KI ist eingerichtet');

  await pruefe('Der Knopf „Protokoll schreiben" ist da', async () => {
    muss(await p.$(protokollKnopf), 'kein Protokoll-Knopf — die KI gilt als nicht eingerichtet');
  });

  /* ── 1. Der Server antwortet mit einem Fehler ──────────────── */

  console.log('\nProtokoll: der Server antwortet mit einem Fehler');

  await p.click(protokollKnopf);
  await p.waitForSelector('.panel', { timeout: 10000 });

  await pruefe('Das Fenster hört auf, sich zu drehen', async () => {
    await p.waitForSelector('[data-zustand="fehler"]', { timeout: 25000 }).catch(() => {});
    const dreht = await p.$$eval('[data-zustand="laeuft"]', (e) => e.length);
    const gemeldet = await p.$$eval('.toast', (e) => e.length);
    muss(dreht === 0,
      `der Kreisel läuft weiter, obwohl der Fehler schon da ist (${gemeldet} Meldung(en) am Rand)`);
    muss(await p.$('[data-zustand="fehler"]'), 'das Fenster steht leer da statt den Fehlschlag zu nennen');
  });

  /* Nicht abbrechen, wenn die Fehleranzeige fehlt: die übrigen Fragen sind
     dann erst recht interessant, und ein Lauf, der beim ersten Fehlschlag
     stirbt, verschweigt den Rest des Befunds. */
  const anzeige = await p.$eval('[data-zustand="fehler"]', (el) => el.innerText).catch(() => '');

  await pruefe('Es steht dort, dass es nicht geklappt hat', () => {
    muss(anzeige, 'gar keine Fehleranzeige im Fenster');
    muss(/nicht zustande gekommen/i.test(anzeige), `es steht: „${anzeige.replace(/\s+/g, ' ').slice(0, 120)}"`);
  });

  await pruefe('Es gibt einen Weg zurück (noch einmal versuchen)', async () => {
    const knoepfe = await p.$$eval('[data-zustand="fehler"] button', (b) => b.map((x) => x.innerText.trim()));
    muss(knoepfe.some((k) => /versuchen/i.test(k)), `Knöpfe: ${JSON.stringify(knoepfe)}`);
  });

  await pruefe('Der Grund steht in der eingestellten Sprache, nicht als roher Anbietertext', () => {
    muss(anzeige, 'gar keine Fehleranzeige im Fenster');
    muss(!/\{"error"|exceeds the available context size/.test(anzeige),
      'die rohe Ausgabe des Modelldienstes steht als Satz in der Anzeige');
    muss(/zu lang|zu wenig Text|Modell|KI/i.test(anzeige),
      `kein deutscher Satz zur Ursache: „${anzeige.replace(/\s+/g, ' ').slice(0, 160)}"`);
    return anzeige.replace(/\s+/g, ' ').slice(0, 90);
  });

  await pruefe('Auch die Meldung am Rand ist ein Satz, kein JSON-Block', async () => {
    const toasts = await p.$$eval('.toast', (e) => e.map((x) => x.innerText));
    if (!toasts.length) return 'keine Meldung — der Fehler steht nur im Fenster';
    const roh = toasts.find((x) => /\{"error"/.test(x));
    muss(!roh, `eine Meldung trägt rohes JSON: „${(roh ?? '').replace(/\s+/g, ' ').slice(0, 120)}"`);
    return `${toasts.length} Meldung(en), keine mit rohem JSON`;
  });

  // Fenster wieder zu.
  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);

  /* ── 2. Aufgabenerkennung ─────────────────────────────────── */

  console.log('\nAufgabenerkennung: der Server antwortet mit einem Fehler');

  await pruefe('Die Rückmeldung hört auf, sich zu drehen, und nennt den Fehlschlag', async () => {
    await p.click(extractKnopf);
    await p.waitForSelector('.extract-pop', { timeout: 10000 });
    // Sonst räumt sie sich nach 3,2 s selbst weg, bevor jemand hinsieht.
    await p.waitForTimeout(200);
    await p.waitForSelector('.extract-pop [data-zustand="fehler"]', { timeout: 25000 }).catch(() => {});
    const dreht = await p.$$eval('.extract-pop [data-zustand="laeuft"]', (e) => e.length);
    muss(dreht === 0, 'der Kreisel läuft weiter');
    const txt = await p.$eval('.extract-pop [data-zustand="fehler"]', (el) => el.innerText).catch(() => '');
    muss(txt, 'die Rückmeldung nennt den Fehlschlag nicht');
    muss(/nicht durchgelaufen/i.test(txt), `es steht: „${txt.replace(/\s+/g, ' ').slice(0, 120)}"`);
    return txt.replace(/\s+/g, ' ').slice(0, 90);
  });

  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);

  /* ── 3. Es kommt gar nichts, weil die Leitung abreißt ──────── */

  console.log('\nProtokoll: die Leitung reißt mitten in der Anfrage ab');

  modellModus = 'stumm';
  await pruefe('Das Fenster gibt auf, statt bis in alle Ewigkeit zu warten', async () => {
    await p.click(protokollKnopf);
    await p.waitForSelector('[data-zustand="laeuft"]', { timeout: 10000 });
    // Jetzt wirklich kappen — nicht die Netzemulation, die Leitung selbst.
    await p.evaluate(() => { window.__leitungen.at(-1).close(); });
    await p.waitForSelector('[data-zustand="fehler"]', { timeout: 15000 }).catch(() => {});
    const txt = await p.$eval('[data-zustand="fehler"]', (el) => el.innerText).catch(() => '');
    muss(txt, 'das Fenster dreht sich weiter, obwohl die Leitung weg ist');
    muss(/Verbindung/i.test(txt), `es steht: „${txt.replace(/\s+/g, ' ').slice(0, 120)}"`);
    return txt.replace(/\s+/g, ' ').slice(0, 90);
  });

  for (const r of haengende) r.destroy();

  await pruefe('Die Oberfläche lief dabei ohne Fehler durch', () => {
    muss(seitenfehler.length === 0, seitenfehler.slice(0, 3).join(' | '));
  });

  await ctx.close();
} finally {
  if (browser) await browser.close();
  await new Promise((f) => modell.close(f));
  await probe.stop();
}

const gut = ergebnisse.filter(Boolean).length;
console.log(`\n${gut}/${ergebnisse.length} bestanden\n`);
process.exit(gut === ergebnisse.length ? 0 : 1);
