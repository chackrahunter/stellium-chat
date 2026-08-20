/**
 * Passt der Server in das Kontextfenster des Modells?
 *
 * DER FEHLER, DEN DIESER LAUF FESTHÄLT
 *
 *   ollama 400: {"error":{"code":400,"message":"request (10340 tokens)
 *   exceeds the available context size (8192 tokens), try increasing it",
 *   "type":"exceed_context_size_error","n_prompt_tokens":10340}}
 *
 * Ausgelöst hat ihn die Funktion „Protokoll" in einem gut gefüllten Kanal:
 * 400 Nachrichten gingen ungefragt an ein Modell mit 8k Fenster. Zwei Dinge
 * waren daran falsch — die Anfrage wurde nie begrenzt, und der rohe Text des
 * Anbieters landete anschließend in einem Meldungsfenster beim Benutzer.
 *
 * WAS HIER GEMESSEN WIRD, UND WARUM SO
 *
 * Der Gegenüber ist ein erfundenes Modell, das sich wie llama.cpp verhält: es
 * nennt sein Fenster in `/v1/models` und **weist jede Anfrage ab, die darüber
 * liegt** — mit genau dem Wortlaut von oben. Damit ist die Zusage nicht
 * „irgendwo steht eine Rechnung", sondern „der Server hält sie ein". Ein
 * Prüfling, der nur die Schätzfunktion aufriefe, wäre grün, während im Betrieb
 * weiter zu viel hinausginge.
 *
 * Gezählt wird beim erfundenen Modell mit `Zeichen / 3,5` — großzügiger als
 * die Schätzung im Server (`Zeichen / 3` für lateinische Schrift). Das ist
 * Absicht und entspricht der Wirklichkeit: ein echter Tokenizer liegt bei
 * deutschem Text eher bei 4 Zeichen je Marke. Wäre der Prüfling strenger als
 * die Wirklichkeit, prüfte er eine Zusage, die niemand gegeben hat.
 *
 *   node scripts/e2e-kontextfenster.mjs
 */
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/** Das Fenster, das das erfundene Modell anbietet — dieselbe Zahl wie im Fehler. */
const FENSTER = 8192;
/** So zählt der Gegenüber. Großzügiger als der Server schätzt; siehe oben. */
const marken = (text) => Math.ceil(text.length / 3.5);

/* ── Das erfundene Modell ─────────────────────────────────────── */

let groessteAnfrage = 0;
let anfragen = 0;
/** 'normal' antwortet im Rahmen, 'immerZuLang' weist alles ab. */
let modus = 'normal';

const port = await new Promise((fertig) => {
  const sucher = net.createServer();
  sucher.listen(0, '127.0.0.1', () => {
    const p = sucher.address().port;
    sucher.close(() => fertig(p));
  });
});

const dienst = http.createServer((req, res) => {
  const stuecke = [];
  req.on('data', (d) => stuecke.push(d));
  req.on('end', () => {
    const antworte = (status, koerper) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(koerper));
    };

    if (req.url?.endsWith('/models')) {
      /* Wie llama.cpp: das Fenster steht in der Modell-Liste. Genau daran soll
         der Server ablesen, wie viel er schicken darf. */
      return antworte(200, { data: [{ id: 'pruefmodell', context_window: FENSTER, owned_by: 'probe' }] });
    }

    const roh = Buffer.concat(stuecke).toString('utf8');
    let koerper;
    try { koerper = JSON.parse(roh); } catch { return antworte(400, { error: { message: 'kein JSON' } }); }
    const inhalt = (koerper.messages ?? []).map((m) => String(m.content ?? '')).join('\n');
    const gezaehlt = marken(inhalt);
    anfragen += 1;
    groessteAnfrage = Math.max(groessteAnfrage, gezaehlt);

    if (modus === 'immerZuLang' || gezaehlt > FENSTER) {
      return antworte(400, {
        error: {
          code: 400,
          message: `request (${gezaehlt} tokens) exceeds the available context size (${FENSTER} tokens), try increasing it`,
          type: 'exceed_context_size_error',
          n_prompt_tokens: gezaehlt,
        },
      });
    }

    /* Eine Antwort, die zu jeder der geprüften Anfragen passt: das Protokoll
       will ein Objekt mit `title`/`topics`, der Teil-Auszug nur Text. Beides
       zugleich zu liefern geht, weil der Auszug den JSON-Text als solchen
       weiterverarbeitet — ihn interessiert nur, dass Zeilen zurückkommen. */
    return antworte(200, {
      choices: [{ message: { content: JSON.stringify({
        title: 'Probeprotokoll',
        topics: [{ heading: 'Lieferung', points: ['Termin bleibt Dienstag'] }],
        decisions: ['Der Termin bleibt'],
        open_questions: ['Wer fährt?'],
        action_items: [{ text: 'Lieferanten anrufen', assignee_id: null }],
      }) } }],
    });
  });
});
await new Promise((f) => dienst.listen(port, '127.0.0.1', f));

/* ── Der Server, der dagegen redet ───────────────────────────── */

process.env.AI_PROVIDER = 'local';
process.env.LOCAL_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.LOCAL_MODEL = 'pruefmodell';
process.env.AI_TIMEOUT_MS = '30000';

const { probeserver } = await import('./probeserver.mjs');
const { verlaufSaeen } = await import('./verlauf-saeen.mjs');

const probe = await probeserver();

try {
  /* Genug Nachrichten, dass der Verlauf das Fenster sprengt. 220 Zeilen à gut
     100 Zeichen sind rund 25.000 Zeichen — beim Zählwerk oben etwa 7.000
     Marken allein für den Verlauf, dazu Anweisung und Antwortbudget. Ohne
     Begrenzung landet das über der Grenze; mit Begrenzung darf es das nicht. */
  const { kanalId } = await verlaufSaeen(probe, 220);

  const draht = new WebSocket(`${probe.S.replace('http', 'ws')}/ws`);
  const eingang = [];
  draht.on('message', (roh) => eingang.push(JSON.parse(roh.toString())));
  await new Promise((fertig, schief) => { draht.once('open', fertig); draht.once('error', schief); });
  draht.send(JSON.stringify({ t: 'auth', token: probe.token, protocol: 1 }));

  const warteAuf = async (arten, sekunden = 180) => {
    const bis = Date.now() + sekunden * 1000;
    for (;;) {
      const treffer = eingang.find((ev) => arten.includes(ev.t));
      if (treffer) return treffer;
      if (Date.now() > bis) throw new Error(`Auf ${arten.join('/')} kam nichts zurück`);
      await new Promise((f) => setTimeout(f, 150));
    }
  };
  await warteAuf(['ready']);

  /* Ollama nennt in `/v1/models` kein Fenster. Dann darf nicht geraten
     werden, sondern es gilt der kleinste Wert, mit dem der Server überhaupt
     rechnet — sonst schickt er einem schweigsamen Dienst gegenüber wieder zu
     viel. Genau dieser Fall ist bei Don eingetreten. */
  console.log('\nWenn der Dienst sein Fenster gar nicht nennt');
  await pruefe('Ohne Angabe gilt der kleinste Wert statt einer Vermutung', async () => {
    const { ModelRegistry } = await import('../packages/server/dist/translation/providers/model-registry.js');
    const { KLEINSTES_FENSTER } = await import('../packages/server/dist/translation/fenster.js');
    const r = new ModelRegistry({
      name: 'stumm', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', ohneSchluessel: true,
      unbewertet: true, fallbackQuality: 'gemma3:4b', fallbackFast: 'gemma3:4b',
    });
    muss(r.kontextfenster('gibtsnicht') === KLEINSTES_FENSTER,
      `${r.kontextfenster('gibtsnicht')} statt ${KLEINSTES_FENSTER}`);
    return `${KLEINSTES_FENSTER} Marken`;
  });

  console.log(`\nModell mit ${FENSTER} Marken Fenster · Kanal mit 220 Nachrichten`);

  await pruefe('Das Protokoll kommt zustande, statt am Fenster zu scheitern', async () => {
    eingang.length = 0;
    groessteAnfrage = 0;
    anfragen = 0;
    draht.send(JSON.stringify({ t: 'ai:protocol', channelId: kanalId, requestId: 'p1' }));
    const ev = await warteAuf(['ai:protocol', 'error']);
    muss(ev.t !== 'error', `der Server meldet „${ev.code ?? ''} ${ev.message ?? ''}"`);
    muss(ev.protocol, 'kein Protokoll im Ereignis');
    muss(ev.protocol.title, 'das Protokoll hat keinen Titel');
    return `${anfragen} Anfragen ans Modell, größte ${groessteAnfrage} Marken`;
  });

  await pruefe('Keine einzige Anfrage war größer als das Fenster', async () => {
    muss(anfragen > 0, 'das Modell wurde gar nicht gefragt — dann sagt die Prüfung nichts');
    muss(groessteAnfrage <= FENSTER,
      `größte Anfrage ${groessteAnfrage} Marken bei einem Fenster von ${FENSTER}`);
    return `${groessteAnfrage}/${FENSTER} Marken`;
  });

  await pruefe('Der lange Verlauf wurde verdichtet und nicht abgeschnitten', async () => {
    const ev = eingang.find((e) => e.t === 'ai:protocol');
    muss(ev, 'kein Protokoll da');
    /* Zwei Zusagen in einer: gelesen wurde alles (`messageCount`), und
       hineingepasst hat es nur, weil in Abschnitten verdichtet wurde — daran
       zu erkennen, dass das Modell mehrfach gefragt wurde. Eine einzige
       Anfrage hieße, der Verlauf hätte ohnehin gepasst; dann prüft dieser
       Lauf nichts und muss das sagen. */
    muss(ev.protocol.messageCount >= 200,
      `nur ${ev.protocol.messageCount} Nachrichten gelesen — da wurde vorher abgeschnitten`);
    muss(anfragen >= 2,
      `nur ${anfragen} Anfrage ans Modell — dann hat der Verlauf gepasst und die Prüfung sagt nichts`);
    return `${ev.protocol.messageCount} Nachrichten über ${anfragen - 1} Abschnitte`;
  });

  await pruefe('Auch ein doppelt so langer Verlauf passt noch hinein', async () => {
    await verlaufSaeen(probe, 220);
    eingang.length = 0;
    groessteAnfrage = 0;
    anfragen = 0;
    draht.send(JSON.stringify({ t: 'ai:protocol', channelId: kanalId, requestId: 'p2' }));
    const ev = await warteAuf(['ai:protocol', 'error']);
    muss(ev.t !== 'error', `der Server meldet „${ev.code ?? ''} ${ev.message ?? ''}"`);
    muss(anfragen > 0, 'das Modell wurde gar nicht gefragt — dann sagt die Prüfung nichts');
    muss(groessteAnfrage <= FENSTER,
      `größte Anfrage ${groessteAnfrage} Marken bei einem Fenster von ${FENSTER}`);
    return `${ev.protocol.messageCount} Nachrichten, größte Anfrage ${groessteAnfrage} Marken`;
  });

  /* Dieselbe Zusage für die übrigen Wege, die einen Verlauf mitgeben. Das
     `anfragen > 0` steht hier nicht aus Ordnungsliebe: beim ersten Anlauf
     stand hier „Was habe ich verpasst", und die Prüfung meldete „größte
     Anfrage 0 Marken" — der Weg lässt die eigenen Nachrichten weg, und in
     einem frisch gesäten Kanal stammen alle von einem selbst. Es blieb nichts
     übrig, das Modell wurde nie gefragt, und die Prüfung war grün, ohne etwas
     gemessen zu haben. Genau die Gattung Prüfung, um die es hier geht. */
  for (const [name, ereignis] of [
    ['Aufgabenerkennung', { t: 'ai:extract-tasks', channelId: kanalId, requestId: 't1' }],
    ['Frage an den Kanal', { t: 'ai:ask', channelId: kanalId, question: 'Wann ist der Termin?', requestId: 'f1' }],
  ]) {
    await pruefe(`${name} hält das Fenster ebenfalls ein`, async () => {
      eingang.length = 0;
      groessteAnfrage = 0;
      anfragen = 0;
      draht.send(JSON.stringify(ereignis));
      const ev = await warteAuf([ereignis.t, 'error']);
      muss(ev.t !== 'error', `der Server meldet „${ev.code ?? ''} ${ev.message ?? ''}"`);
      muss(anfragen > 0, 'das Modell wurde gar nicht gefragt — dann sagt die Prüfung nichts');
      muss(groessteAnfrage <= FENSTER, `größte Anfrage ${groessteAnfrage} Marken`);
      return `${anfragen} Anfragen, größte ${groessteAnfrage} Marken`;
    });
  }

  /* ── Und wenn es doch schiefgeht ───────────────────────────── */

  console.log('\nDas Modell weist alles ab');

  await pruefe('Der Fehlschlag kommt überhaupt beim Client an', async () => {
    modus = 'immerZuLang';
    eingang.length = 0;
    draht.send(JSON.stringify({ t: 'ai:protocol', channelId: kanalId, requestId: 'p3' }));
    const ev = await warteAuf(['ai:protocol', 'error'], 90);
    muss(ev.t === 'error', 'der Server tut, als wäre alles gut');
    return ev.code ?? '(ohne Kennung)';
  });

  await pruefe('Er trägt eine Kennung aus dem Wörterbuch', async () => {
    const ev = eingang.find((e) => e.t === 'error');
    muss(ev, 'keine Meldung da');
    muss(ev.code === 'fehler.verlaufZuLang', `Kennung ist „${ev.code ?? 'keine'}"`);
  });

  await pruefe('Der rohe Text des Anbieters steht nicht darin', async () => {
    const ev = eingang.find((e) => e.t === 'error');
    const text = `${ev.message ?? ''}`;
    for (const verraeter of ['exceed', 'tokens', 'context size', 'n_prompt_tokens', '{"error"', 'try increasing']) {
      muss(!text.toLowerCase().includes(verraeter.toLowerCase()),
        `„${verraeter}" steht in der Meldung: ${text.slice(0, 160)}`);
    }
    return `„${text}"`;
  });

  draht.close();
} finally {
  await probe.stop();
  dienst.close();
}

const schlecht = ergebnisse.filter((x) => !x).length;
if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
