/**
 * Wie lange steht der Server still, während jemand eine Datei hochlädt?
 *
 * Don sagt: „es hängt manchmal". Das *manchmal* ist der entscheidende Teil.
 * Ein Hintergrund, der immer läuft, hinge immer. Was nur manchmal hängt, hängt
 * an etwas, das nur manchmal passiert — und das Auffälligste dieser Art ist
 * eine hochgeladene Datei: sie wird in Blöcke zerlegt und jeder Block gepackt,
 * alles im selben Faden, in dem auch die WebSockets bedient werden.
 *
 * Deshalb wird hier nicht gemessen, wie lange das Packen dauert (das
 * interessiert niemanden), sondern was ein ANDERER Benutzer davon merkt: ein
 * zweiter Draht schickt im festen Takt ein `ping` und wartet auf `pong`.
 * Die größte Lücke zwischen zwei Antworten ist genau die Zeit, in der seine
 * App eingefroren war — keine neue Nachricht, kein Tippen-Hinweis, nichts.
 *
 * Gemessen wird mit drei Inhalten, weil der Inhalt alles entscheidet:
 *   · Text        packt gut, also rechnet der Packer lange  → schlimmster Fall
 *   · Rauschen    packt gar nicht, die Stichprobe winkt durch → bester Fall
 *   · Gemischt    wie eine echte Datei aussieht
 *
 * Aufruf:  node scripts/server-stillstand-messen.mjs
 *          node scripts/server-stillstand-messen.mjs --pruefen   # mit Schranke
 */
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { probeserver } from './probeserver.mjs';

const PRUEFEN = process.argv.includes('--pruefen');
/* Was ein Mensch noch nicht bemerkt. Vor der Umstellung auf asynchrones Packen
   standen hier 2,40 s; danach 0,13 s. Die Schranke liegt dazwischen, näher am
   Erreichten — sie soll den Rückfall auf synchrones Packen fangen, ohne bei
   einer belegten Maschine grundlos rot zu werden. */
const ERLAUBT_MS = 600;

const TAKT = 50;          // alle 50 ms ein ping
const MB = 1024 * 1024;

/**
 * Wirklichkeitsnaher Text — und zwar bewusst NICHT trivial packbar.
 *
 * Der erste Anlauf hier wiederholte einen einzigen Satz. Das Ergebnis war
 * wertlos: solcher Inhalt packt sich in einem Wimpernschlag, die Messung
 * meldete Ruhe, und die Blöcke waren obendrein zwischen den Fällen identisch —
 * der Blockspeicher erkannte sie wieder und rechnete gar nicht mehr. Gemessen
 * wurde damit nichts als die Wiedererkennung.
 *
 * Also: Wörter aus einem großen Vorrat in zufälliger Folge. Das packt etwa
 * 2,5:1, wie Protokolle, CSV-Ausfuhren und Textdokumente es tun — und es
 * kostet den Packer genau die Rechenzeit, um die es hier geht. Der Vorsatz
 * sorgt dafür, dass kein Block aus einem früheren Fall wiederverwendet wird.
 */
function textArtig(bytes, saat) {
  const silben = ['ver', 'be', 'ge', 'ent', 'er', 'zu', 'ab', 'an', 'auf', 'aus', 'ein', 'mit', 'nach', 'vor', 'um'];
  const stamm = ['lieferung', 'rechnung', 'termin', 'kunde', 'auftrag', 'lager', 'preis', 'menge',
    'bestell', 'zahlung', 'versand', 'artikel', 'muster', 'pruefung', 'freigabe', 'meldung',
    'planung', 'wartung', 'schulung', 'bericht', 'anfrage', 'angebot', 'vertrag', 'mahnung'];
  const endung = ['en', 'ung', 'er', 'e', 'sliste', 'sdatum', 'snummer', 'sschein', 'swesen'];
  let zufall = saat >>> 0;
  const wuerfel = (n) => { zufall = (zufall * 1664525 + 1013904223) >>> 0; return zufall % n; };
  const stuecke = [`# Ausfuhr ${saat}\n`];
  let laenge = stuecke[0].length;
  while (laenge < bytes) {
    const wort = silben[wuerfel(silben.length)] + stamm[wuerfel(stamm.length)] + endung[wuerfel(endung.length)];
    const zusatz = wuerfel(9) === 0 ? `;${wuerfel(999999)};${wuerfel(99)}.${wuerfel(99)}\n` : ' ';
    stuecke.push(wort + zusatz);
    laenge += wort.length + zusatz.length;
  }
  return Buffer.from(stuecke.join('')).subarray(0, bytes);
}

/** Nicht packbar — hier soll die Stichprobe abwinken. */
const rauschen = (bytes) => crypto.randomBytes(bytes);

/** Halb und halb, wie eine echte Datei aus dem Alltag. */
function gemischt(bytes, saat) {
  const b = Buffer.alloc(bytes);
  textArtig(Math.floor(bytes / 2), saat).copy(b, 0);
  crypto.randomBytes(bytes - Math.floor(bytes / 2)).copy(b, Math.floor(bytes / 2));
  return b;
}

const FAELLE = [
  { name: 'Text, 2 MB', bauen: () => textArtig(2 * MB, 11), mime: 'text/plain', endung: 'txt' },
  { name: 'Text, 4 MB', bauen: () => textArtig(4 * MB, 22), mime: 'text/plain', endung: 'txt' },
  { name: 'Text, 12 MB', bauen: () => textArtig(12 * MB, 33), mime: 'text/plain', endung: 'txt' },
  { name: 'gemischt, 8 MB', bauen: () => gemischt(8 * MB, 44), mime: 'application/octet-stream', endung: 'bin' },
  { name: 'Rauschen, 12 MB', bauen: () => rauschen(12 * MB), mime: 'application/octet-stream', endung: 'bin' },
];

/**
 * Ein zweiter Benutzer, der nur horcht.
 *
 * Er tut nichts weiter als im Takt zu fragen „bist du noch da?". Die Lücken in
 * seinen Antworten sind das Maß — sie sind das, was ein Mensch als „hängt"
 * beschreibt.
 */
async function horcher(S, token, protokoll) {
  const ws = new WebSocket(`${S.replace('http', 'ws')}/ws`);
  await new Promise((fertig, schief) => {
    ws.once('open', fertig);
    ws.once('error', schief);
  });
  const antworten = [];
  /* Der Draht meldet sich mit einer eigenen Nachricht an, nicht über die
     Adresse — genau wie die App es tut. Erst nach `ready` zählt gemessene
     Zeit, vorher wäre es die Anmeldung. */
  ws.send(JSON.stringify({ t: 'auth', token, protocol: protokoll }));
  let bereit = false;
  ws.on('message', (roh) => {
    try {
      const ev = JSON.parse(roh.toString());
      if (ev.t === 'ready') bereit = true;
      if (ev.t === 'pong') antworten.push({ ab: ev.ts, an: Date.now() });
    } catch { /* anderes Ereignis */ }
  });
  const frist = Date.now() + 10000;
  while (!bereit && Date.now() < frist) await new Promise((f) => setTimeout(f, 50));
  if (!bereit) throw new Error('Der Horcher wurde nicht angemeldet — kein ready vom Server.');
  const takt = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
  }, TAKT);
  return {
    antworten,
    stop() { clearInterval(takt); ws.close(); },
    /** Die größte Zeitspanne, in der KEINE Antwort kam. */
    groessteLuecke(von, bis) {
      const zeiten = [von, ...antworten.filter((a) => a.an >= von && a.an <= bis).map((a) => a.an), bis];
      let groesste = 0;
      for (let i = 1; i < zeiten.length; i += 1) groesste = Math.max(groesste, zeiten[i] - zeiten[i - 1]);
      return groesste;
    },
    /** Wie lange eine Antwort im Mittel unterwegs war. */
    schlimmsteAntwort(von, bis) {
      const d = antworten.filter((a) => a.an >= von && a.an <= bis).map((a) => a.an - a.ab);
      return d.length ? Math.max(...d) : 0;
    },
  };
}

const probe = await probeserver();
const { WS_PROTOCOL_VERSION } = await import('../packages/shared/dist/index.js');
const h = await horcher(probe.S, probe.token, WS_PROTOCOL_VERSION);
await new Promise((f) => setTimeout(f, 600));

console.log('\n  Was ein ANDERER Benutzer merkt, während jemand eine Datei hochlädt.');
console.log('  („Lücke" = so lange kam gar nichts vom Server — genau das fühlt sich an wie eingefroren.)\n');
console.log('  Fall                 Hochladen   größte Lücke   langsamste Antwort   Zerlegung');
console.log('  ' + '─'.repeat(82));

const befunde = [];
for (const fall of FAELLE) {
  const daten = fall.bauen();
  const grenze = `----probe${crypto.randomBytes(8).toString('hex')}`;
  const kopf = Buffer.from(
    `--${grenze}\r\nContent-Disposition: form-data; name="file"; filename="probe.${fall.endung}"\r\n`
    + `Content-Type: ${fall.mime}\r\n\r\n`,
  );
  const fuss = Buffer.from(`\r\n--${grenze}--\r\n`);

  const von = Date.now();
  const antwort = await fetch(`${probe.S}/api/files`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${probe.token}`,
      'content-type': `multipart/form-data; boundary=${grenze}`,
    },
    body: Buffer.concat([kopf, daten, fuss]),
  });
  const hochgeladen = Date.now();
  if (!antwort.ok) {
    console.log(`  ${fall.name.padEnd(20)} — Hochladen abgewiesen (${antwort.status})`);
    continue;
  }

  /* Nach der Antwort läuft die Zerlegung im Hintergrund weiter. Genau dort
     liegt der Stillstand — also muss hier weiter gehorcht werden, bis nichts
     mehr passiert. „Nichts mehr" heißt: eine Weile lang keine Lücke mehr. */
  let ruhigSeit = Date.now();
  let letzteZahl = h.antworten.length;
  const frist = Date.now() + 120_000;
  while (Date.now() < frist) {
    await new Promise((f) => setTimeout(f, 250));
    const jetzt = h.antworten.length;
    const erwartet = 250 / TAKT;
    if (jetzt - letzteZahl >= erwartet - 1) {
      if (Date.now() - ruhigSeit > 2500) break;
    } else {
      ruhigSeit = Date.now();
    }
    letzteZahl = jetzt;
  }
  const fertig = Date.now();

  const luecke = h.groessteLuecke(von, fertig);
  const schlimmste = h.schlimmsteAntwort(von, fertig);
  const gezaehlt = h.antworten.filter((a) => a.an >= von && a.an <= fertig).length;
  const erwartetGesamt = Math.round((fertig - von) / TAKT);
  befunde.push({ fall: fall.name, luecke, gezaehlt, erwartetGesamt });
  console.log(`  ${fall.name.padEnd(20)} ${String(((hochgeladen - von) / 1000).toFixed(1) + ' s').padStart(9)}`
    + `   ${String((luecke / 1000).toFixed(2) + ' s').padStart(12)}`
    + `   ${String((schlimmste / 1000).toFixed(2) + ' s').padStart(18)}`
    + `   ${((fertig - hochgeladen) / 1000).toFixed(1)} s`
    + `   (${gezaehlt} von ${erwartetGesamt} Antworten kamen an)`);
}

h.stop();
await probe.stop();

const schlimmste = Math.max(0, ...befunde.map((b) => b.luecke));
console.log(`\n  Schlimmster Stillstand: ${(schlimmste / 1000).toFixed(2)} s`);
console.log('  Zum Vergleich: alles über 0,1 s merkt man, über 0,5 s hält man die App für kaputt.');
console.log('  Dieser Mac ist deutlich schneller als der Raspberry Pi, auf dem der Server läuft —');
console.log('  dort ist derselbe Stillstand um ein Vielfaches länger.\n');

if (PRUEFEN) {
  const schlimm = befunde.filter((b) => b.luecke > ERLAUBT_MS);
  for (const b of schlimm) console.log(`  ✗ ${b.fall}: ${(b.luecke / 1000).toFixed(2)} s Stillstand (erlaubt ${(ERLAUBT_MS / 1000).toFixed(2)} s)`);
  console.log(schlimm.length
    ? `\n✗ Der Server hält beim Hochladen wieder an — packt wieder jemand synchron?\n`
    : `\n✓ Der Server bleibt beim Hochladen ansprechbar.\n`);
  process.exit(schlimm.length ? 1 : 0);
}
