#!/usr/bin/env node
/**
 * Prüft, dass ein vom Server abgewiesenes `message:send` die RICHTIGE
 * optimistische Zeile trifft — und nur die.
 *
 * VORGESCHICHTE
 * Ein Anhang, der ewig spinnt, war der ursprüngliche Fehlerbericht. Ein
 * erster Fix führte eine Merkliste `nachrichtenOhneEcho: Map<clientId,
 * channelId>` ein und ordnete einen kennungslosen `error` der EINEN Sache zu,
 * die gerade als einzige aussteht. Eine Prüfung danach fand drei eigene
 * Fehler in diesem Fix, alle unten mit je einem Szenario nachgestellt:
 *
 *   A) FEHLZUORDNUNG + ÜBERSPRUNGENER PROTOKOLL-ABBRUCH — `fail()` in
 *      packages/server/src/ws/gateway.ts trägt bei den allermeisten Aufrufen
 *      KEINE `requestId`. Lief zufällig genau EINE Nachricht und zugleich ein
 *      Protokoll-Abruf (`ai:protocol`, der ebenfalls keine eigene Kennung
 *      trägt), landete ein Protokoll-Fehler auf der Nachricht — sie wurde
 *      fälschlich als gescheitert markiert, IHRE Anhänge verschwanden, UND
 *      der `break` sprang am `protokollBeenden()`-Aufruf vorbei: das
 *      Protokoll blieb bis zur vollen `KI_FRIST_MS` (90 s) hängen.
 *      Siehe Szenario 'protokoll-nicht-misattribuiert'.
 *
 *   B) THREAD-ANTWORT SPINNT FÜR IMMER — `sendMessage()` legt die
 *      optimistische Zeile für eine Thread-Antwort AUSSCHLIESSLICH in
 *      `s.threads[parentId]` ab, nie in `s.messages[channelId]` (siehe
 *      `imKanalverlauf()`, packages/desktop/src/state/store.ts). Der alte Fix
 *      durchsuchte nur `s.messages` — für eine Thread-Antwort fand er nichts,
 *      sie blieb für immer "wird gesendet". Derselbe Fehler stand ein
 *      zweites Mal an der Stelle, an der eine unverschlüsselbare Nachricht
 *      (vertraulicher Kanal) als gescheitert markiert wird — kopiert, nicht
 *      behoben. Siehe Szenarien 'thread-antwort' und
 *      'thread-antwort-nicht-verschluesselbar'.
 *
 *   C) DIE MERKLISTE LECKT UND VERGIFTET SICH SELBST — nichts räumte einen
 *      Eintrag auf, wenn mehr als eine Nachricht gleichzeitig ausstand, wenn
 *      eine gepufferte Nachricht am 200er-Deckel der Warteschlange
 *      herausfiel (net/socket.ts), oder bei der Abmeldung. Weil die
 *      Heuristik an `size === 1` hing, legte EIN liegen gebliebener Eintrag
 *      die Zuordnung für JEDE künftige Nachricht lahm — aus einem
 *      gelegentlichen Fehler wurde ein dauerhafter. Siehe Szenario
 *      'mehrere-ausstehend': zwei Nachrichten gleichzeitig aus, nur EINE
 *      davon (per `clientId`) abgewiesen — die alte Heuristik hätte hier
 *      GAR NICHTS zuordnen können (size === 2).
 *
 * DER ECHTE FIX (nicht mehr in diesem Repo, siehe Git-Verlauf für den alten
 * Stand): der Server kennt die `clientId` von `message:send` längst — er
 * sagt jetzt beim Abweisen, welche er meint (`error`-Ereignis, optionales
 * Feld `clientId`, packages/shared/src/protocol.ts). Der Client sucht bei
 * einer solchen Kennung über ALLE Kanäle und Threads (`markMessageFailed()`,
 * state/store.ts) statt eine Merkliste zu führen — es gibt nichts mehr, das
 * lecken könnte.
 *
 *   D) DER WURF-PFAD TRUG KEINE clientId — dieser Fix deckte anfangs nur die
 *      `fail()`-Aufrufe INNERHALB von case 'message:send' (und, bei genauerem
 *      Hinsehen, auch 'poll:create', 'message:forward' und 'voice:send') ab.
 *      Die weitaus häufigeren Abweisungen — leerer Text, zu lang, Anhang aus
 *      fremdem Kanal, unverschlüsselter Anhang, falscher Empfängerkreis,
 *      Thread-Wurzel fehlt — verlassen `messages.createMessage()` per WURF
 *      (`abweisung(...)`, packages/server/src/services/messages.ts) und
 *      wurden erst ~400 Zeilen weiter vom generischen Fänger in
 *      `handleConnection()` aufgefangen — ohne `clientId`. Genau DAS war der
 *      wieder aufgetretene Ursprungsfehler: ein Anhang, der eine ganz
 *      gewöhnliche Prüfung nicht besteht (zu lang, falscher Kanal, …), ließ
 *      seinen Kreisel für immer drehen, weil `markMessageFailed()` gar nicht
 *      erst aufgerufen wurde. Behoben, indem der Fänger die `clientId` der
 *      auslösenden Ereignisvariante typsicher mitgibt (`clientIdVon()`,
 *      gateway.ts). Siehe Szenario 'wurf-pfad-mit-clientid'.
 *
 * ALTER SERVER OHNE `clientId` (Interop, kein Bug) — bleibt eine `error`
 * trotzdem ohne `clientId`, kann das jetzt nur noch zwei Ursachen haben: ein
 * Fehler, der mit keiner Nachricht zu tun hat (KI-Protokoll, Übersetzung, …
 * — die tragen von jeher keine `clientId`, siehe Szenario
 * 'protokoll-nicht-misattribuiert'), oder ein wirklich veraltetes
 * Server-Gegenstück, das das Feld überhaupt nicht kennt. Der Client kann
 * diese zwei Fälle NICHT unterscheiden — beide sehen als `{ t: 'error' }`
 * ohne `clientId` identisch aus, und `WS_PROTOCOL_VERSION`
 * (packages/shared/src/protocol.ts) wurde bei Einführung des Felds nicht
 * angehoben, fängt einen so veralteten Server also nicht schon beim `auth`
 * ab. Zu raten, WELCHE der wartenden Nachrichten gemeint sein könnte, ist
 * exakt die Heuristik aus Fehlerklasse A/C oben — deshalb bewusst nicht
 * wieder eingeführt. Ein stiller Zeitgeber, der eine Zeile nach N Sekunden
 * ohne Echo einfach als gescheitert umflaggt, verschöbe das Problem nur: ein
 * ECHTER, verbleibender Serverfehler würde dann irgendwann leise "heilen",
 * statt aufzufallen. Die Zeile bleibt darum in diesem einen, seltenen
 * Rand­fall stehen — kein Rätselraten, keine versteckte Frist — und es geht
 * zum alten Weg über die Zeit (Protokoll abbrechen, falls eins wartet). Wer
 * das nicht erträgt, muss den Server aktualisieren; das ist ohnehin dieselbe
 * Kur, die `fehler.protokollVeraltet` in der Gegenrichtung schon verlangt.
 * Siehe Szenario 'alter-server-kein-clientid'.
 *
 * WIE DAS MODUL OHNE BUNDLER LÄDT
 * state/store.ts lädt echt, ungemockt — nur seine vier Geschwisterdateien mit
 * echten Seiteneffekten (lib/benachrichtigung.ts, lib/vertraulich.ts,
 * i18n/kern.ts, state/verkaufMeldungen.ts) werden über einen
 * Node-ESM-Loader-Hook auf Leerlauf-Stubs umgeleitet — dieselbe Bauart wie
 * scripts/benachrichtigung-lib-pruefen.mjs. `.ts`-Spezifizierer mit `.js`-
 * Endung (state/store.ts importiert `../net/socket.js` usw.) löst erst `tsx`
 * auf; reines Node-ESM kennt diese Umschreibung nicht — deshalb `--import
 * tsx` neben dem eigenen Hook.
 *
 * Jedes Szenario läuft in einem EIGENEN Node-Prozess: `useStore` ist
 * veränderlicher Modulzustand, ein zweiter Import über denselben ESM-Cache
 * gäbe dieselbe Instanz zurück und ließe ein Szenario im Zustand des vorigen
 * weiterlaufen.
 *
 * Aufruf:  node scripts/nachricht-fehler-zuordnung-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopPaket = path.join(wurzel, 'packages/desktop');
const storePfad = path.join(desktopPaket, 'src/state/store.ts');

if (!fs.existsSync(storePfad)) {
  console.error(`Nicht gefunden: ${storePfad}`);
  process.exit(1);
}

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-nachricht-fehler-'));
let fehlerGesamt = 0;

try {
  /* Leerlauf-Ersatz für die vier Geschwisterdateien mit echten
     Seiteneffekten (Push-Berechtigung, Ende-zu-Ende-Verschlüsselung,
     Sprachwörterbuch, eigener Abruf-Takt) — state/store.ts SELBST (das Modul
     unter Prüfung) läuft unverändert. `nachrichtVerschluesseln` ist
     absichtlich steuerbar: `globalThis.__VERSCHLUESSELN_SCHEITERT__` schaltet
     den Fehlschlag für die Szenarien, die den `hinausText() === null`-Zweig
     in `sendMessage()` brauchen (siehe Fehlerklasse B, zweite Stelle). */
  fs.writeFileSync(
    path.join(ordner, 'benachrichtigung-stub.mjs'),
    `export const erlaubnisStand = () => 'default';
export function pushAbonnieren() {}
export function titelZaehler() {}
export function vapidSchluesselSetzen() {}
export function zeigen() {}
`,
  );
  fs.writeFileSync(
    path.join(ordner, 'vertraulich-stub.mjs'),
    `export function dateiVerschluesseln() {}
export function istE2EChiffrat() { return false; }
export function kanalSchluesselWechseln() {}
export function kontoHuelle() {}
export async function nachrichtVerschluesseln(_channelId, text) {
  if (globalThis.__VERSCHLUESSELN_SCHEITERT__) throw new Error('verschlüsseln fehlgeschlagen (Stub)');
  return text;
}
`,
  );
  fs.writeFileSync(
    path.join(ordner, 'kern-stub.mjs'),
    `export function translate(_l, key) { return key; }
export function spracheDesSystems() { return 'de'; }
export function dokumentSpracheSetzen() {}
`,
  );
  fs.writeFileSync(
    path.join(ordner, 'verkauf-stub.mjs'),
    `export const useVerkaufMeldungenUi = { getState: () => ({ zuruecksetzen() {} }), setState() {} };
`,
  );

  fs.writeFileSync(
    path.join(ordner, 'loader-hook.mjs'),
    `const KARTE = {
  '/packages/desktop/src/lib/benachrichtigung.ts': new URL('./benachrichtigung-stub.mjs', import.meta.url).href,
  '/packages/desktop/src/lib/vertraulich.ts': new URL('./vertraulich-stub.mjs', import.meta.url).href,
  '/packages/desktop/src/i18n/kern.ts': new URL('./kern-stub.mjs', import.meta.url).href,
  '/packages/desktop/src/state/verkaufMeldungen.ts': new URL('./verkauf-stub.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  for (const [leiden, ziel] of Object.entries(KARTE)) {
    if (specifier.endsWith(leiden)) return { url: ziel, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  // Vite-only Global (import.meta.env), das Node nicht kennt — store.ts
  // fragt es beim Laden einmal ab (DEV-Logging). globalThis.DEV wird von
  // der Probedatei gesetzt.
  if (url.endsWith('/packages/desktop/src/state/store.ts')) {
    const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    return { ...result, source: src.replace('import.meta.env', 'globalThis') };
  }
  return result;
}
`,
  );
  fs.writeFileSync(
    path.join(ordner, 'register-hook.mjs'),
    `import { register } from 'node:module';
register('./loader-hook.mjs', import.meta.url);
`,
  );

  /* Eine Probedatei für alle Szenarien — SZENARIO steuert per Umgebungsvariable,
     welcher Ablauf läuft, damit kein Szenario eine andere Prüfung als die
     anderen bekommt. */
  fs.writeFileSync(
    path.join(ordner, 'probe.mts'),
    `const szenario = process.env.SZENARIO;

globalThis.localStorage = {
  getItem: (k) => (k === 'stellium.token' ? 'faketoken' : null), setItem() {}, removeItem() {},
};
globalThis.window = globalThis;
globalThis.stellium = { setTheme() {}, setLanguage() {} };
globalThis.DEV = false;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.document = { addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {} } };

class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = FakeWS.CONNECTING;
  sent = [];
  constructor() { FakeWS.last = this; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
}
globalThis.WebSocket = FakeWS;

const { useStore } = await import(${JSON.stringify(pathToFileUrlLiteral(storePfad))});
const { socket } = await import(${JSON.stringify(pathToFileUrlLiteral(path.join(desktopPaket, 'src/net/socket.ts')))});

function verbinden(ai) {
  socket.connect();
  const ws = FakeWS.last;
  ws.readyState = FakeWS.OPEN;
  ws.onopen?.();
  ws.onmessage({
    data: JSON.stringify({
      t: 'ready',
      self: { id: 'u1', displayName: 'Test', theme: 'dark', density: 'normal', uiLanguage: 'de' },
      ai: ai ?? {},
      serverVersion: '0', serverUpdate: null,
      users: [], channels: [], states: [], scheduled: [], reminders: [], drafts: [],
    }),
  });
  return ws;
}

let fehler = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(\`  \${ok ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\${ok ? '' : \`  ist=\${JSON.stringify(ist)} soll=\${JSON.stringify(soll)}\`}\`);
};

const warten = () => new Promise((r) => setTimeout(r, 0));

if (szenario === 'mehrere-ausstehend') {
  // Defekt A + C: zwei Nachrichten stehen gleichzeitig aus. Der Server weist
  // NUR die zweite ab, per clientId. Die alte size===1-Heuristik hätte hier
  // gar nichts zuordnen können.
  const ws = verbinden();
  const c1 = useStore.getState().sendMessage({ channelId: 'ch1', text: 'erste', parentId: null, attachmentIds: [] });
  const c2 = useStore.getState().sendMessage({ channelId: 'ch1', text: 'zweite', parentId: null, attachmentIds: [] });
  await warten(); await warten();

  ws.onmessage({ data: JSON.stringify({ t: 'error', code: 'fehler.kanalNichtGefunden', message: 'Kanal nicht gefunden', clientId: c2 }) });

  const m1 = useStore.getState().messages['ch1']?.find((m) => m.clientId === c1);
  const m2 = useStore.getState().messages['ch1']?.find((m) => m.clientId === c2);
  pruef('erste Nachricht bleibt unberührt (pending)', m1?.pending, true);
  pruef('erste Nachricht NICHT fälschlich als gescheitert markiert', m1?.failed, undefined);
  pruef('zweite Nachricht ist gescheitert', m2?.failed, true);
  pruef('zweite Nachricht nicht mehr pending', m2?.pending, false);
  pruef('pendingAttachments der zweiten geleert', m2?.pendingAttachments, undefined);
} else if (szenario === 'protokoll-nicht-misattribuiert') {
  // Defekt A: ein Protokoll-Abruf läuft, EINE Nachricht steht aus, der
  // Server bricht das Protokoll ab (kein requestId, keine clientId auf
  // diesem Fehler). Die alte Heuristik hätte die gesunde Nachricht
  // fälschlich als gescheitert markiert UND protokollBeenden() übersprungen.
  const ws = verbinden({ assistant: true });
  useStore.getState().loadProtocol('ch1');
  const c1 = useStore.getState().sendMessage({ channelId: 'ch1', text: 'unbeteiligt', parentId: null, attachmentIds: [] });
  await warten(); await warten();
  pruef('Protokoll lädt', useStore.getState().protocolLoading, true);

  ws.onmessage({ data: JSON.stringify({ t: 'error', code: 'fehler.kiUeberlastet', message: 'Zu viele KI-Anfragen' }) });

  const m1 = useStore.getState().messages['ch1']?.find((m) => m.clientId === c1);
  pruef('die unbeteiligte Nachricht bleibt pending', m1?.pending, true);
  pruef('die unbeteiligte Nachricht wird NICHT fälschlich als gescheitert markiert', m1?.failed, undefined);
  pruef('das Protokoll wird abgebrochen (protocolLoading false)', useStore.getState().protocolLoading, false);
  pruef('protocolFehler ist gesetzt, NICHT übersprungen', typeof useStore.getState().protocolFehler, 'string');
} else if (szenario === 'thread-antwort') {
  // Defekt B: die optimistische Zeile einer Thread-Antwort steht NUR in
  // s.threads[parentId], nie in s.messages[channelId] (imKanalverlauf()).
  const ws = verbinden();
  useStore.setState({ threads: { p1: [] } });
  const c1 = useStore.getState().sendMessage({
    channelId: 'ch1', text: 'antwort', parentId: 'p1', attachmentIds: [],
    pendingAttachments: [{ tempId: 'tmp1', name: 'bild.png', mime: 'image/png' }],
  });
  await warten(); await warten();

  const vorher = useStore.getState().threads['p1']?.find((m) => m.clientId === c1);
  pruef('Thread-Antwort steht optimistisch im Thread', vorher?.pending, true);
  pruef('NICHT im Kanalverlauf', (useStore.getState().messages['ch1'] ?? []).some((m) => m.clientId === c1), false);

  ws.onmessage({ data: JSON.stringify({ t: 'error', code: 'fehler.kanalNichtGefunden', message: 'Kanal nicht gefunden', clientId: c1 }) });

  const nachher = useStore.getState().threads['p1']?.find((m) => m.clientId === c1);
  pruef('Thread-Antwort ist gescheitert', nachher?.failed, true);
  pruef('Thread-Antwort nicht mehr pending', nachher?.pending, false);
  pruef('pendingAttachments geleert (sonst dreht der Kreisel in ThreadPanel für immer)', nachher?.pendingAttachments, undefined);
} else if (szenario === 'thread-antwort-nicht-verschluesselbar') {
  // Defekt B, ZWEITE Stelle: derselbe Fehler war an den hinausText()===null-
  // Zweig in sendMessage() kopiert, nicht behoben.
  globalThis.__VERSCHLUESSELN_SCHEITERT__ = true;
  verbinden();
  useStore.setState({
    channels: { ch1: { id: 'ch1', vertraulich: true } },
    threads: { p1: [] },
  });
  const c1 = useStore.getState().sendMessage({
    channelId: 'ch1', text: 'geheime antwort', parentId: 'p1', attachmentIds: [],
    pendingAttachments: [{ tempId: 'tmp1', name: 'bild.png', mime: 'image/png' }],
  });
  await warten(); await warten(); await warten();

  const nachher = useStore.getState().threads['p1']?.find((m) => m.clientId === c1);
  pruef('Thread-Antwort (nicht verschlüsselbar) ist gescheitert', nachher?.failed, true);
  pruef('nicht mehr pending', nachher?.pending, false);
  pruef('pendingAttachments geleert', nachher?.pendingAttachments, undefined);
} else if (szenario === 'wurf-pfad-mit-clientid') {
  // Defekt D: der eigentliche Fehlerbericht — ein Anhang scheitert an einer
  // GEWÖHNLICHEN Prüfung (hier stellvertretend 'fehler.nachrichtZuLang'), die
  // messages.createMessage() nicht über eines der frühen fail()-Returns
  // abweist, sondern per WURF verlässt. Der generische Fänger in
  // gateway.ts (~400 Zeilen von case 'message:send' entfernt) fängt ihn auf
  // und trägt seit dem Fix die clientId der auslösenden Ereignisvariante
  // weiter — ohne requestId, denn 'message:send' hat nie eine. Bleibt das
  // aus, dreht sich der Anhang-Kreisel für immer (siehe genau diese
  // Assertions ohne clientId weiter oben in dieser Datei, Szenario
  // 'alter-server-kein-clientid' — der Unterschied zwischen beiden Szenarien
  // IST der Fix).
  const ws = verbinden();
  const c1 = useStore.getState().sendMessage({
    channelId: 'ch1', text: 'x'.repeat(20000), parentId: null, attachmentIds: [],
    pendingAttachments: [{ tempId: 'tmp1', name: 'bild.png', mime: 'image/png' }],
  });
  await warten(); await warten();

  ws.onmessage({ data: JSON.stringify({
    t: 'error', code: 'fehler.nachrichtZuLang', message: 'Nachricht ist zu lang', clientId: c1,
  }) });

  const m1 = useStore.getState().messages['ch1']?.find((m) => m.clientId === c1);
  pruef('Nachricht vom Wurf-Pfad ist gescheitert', m1?.failed, true);
  pruef('nicht mehr pending — der Kreisel hört auf zu drehen', m1?.pending, false);
  pruef('pendingAttachments geleert', m1?.pendingAttachments, undefined);
} else if (szenario === 'alter-server-kein-clientid') {
  /* Interop-Randfall, kein Erfolgsfall: der Client kann eine \`error\` ohne
     \`clientId\` nicht von einem völlig unbeteiligten Fehler unterscheiden
     (siehe 'protokoll-nicht-misattribuiert' oben) — zu raten, welche der
     wartenden Nachrichten gemeint sein könnte, ist exakt die Heuristik aus
     den Defekten A/C und bleibt darum aus. Ein stiller Zeitgeber, der die
     Zeile nach einer Frist einfach umflaggt, würde einen echten, fortdauernden
     Serverfehler nur unsichtbar machen. Die Zeile bleibt also stehen — das
     ist eine bewusst in Kauf genommene Grenze für einen inzwischen sehr
     seltenen Fall (siehe ALTER SERVER OHNE \`clientId\` oben im Dateikopf),
     nicht ein Zustand, den man anstreben würde. */
  const ws = verbinden();
  const c1 = useStore.getState().sendMessage({ channelId: 'ch1', text: 'x', parentId: null, attachmentIds: [] });
  await warten(); await warten();

  ws.onmessage({ data: JSON.stringify({ t: 'error', code: 'fehler.kanalNichtGefunden', message: 'Kanal nicht gefunden' }) });

  const m1 = useStore.getState().messages['ch1']?.find((m) => m.clientId === c1);
  pruef('ohne clientId bleibt die Nachricht pending (kein Raten, keine Frist — bewusste Grenze, kein Idealzustand)', m1?.pending, true);
  pruef('kein failed', m1?.failed, undefined);
} else {
  throw new Error(\`unbekanntes Szenario: \${szenario}\`);
}

console.log(fehler ? \`\\x1b[31m\${fehler} fehlgeschlagen\\x1b[0m\` : '\\x1b[32mok\\x1b[0m');
process.exit(fehler ? 1 : 0);
`,
  );

  const SZENARIEN = [
    'mehrere-ausstehend',
    'protokoll-nicht-misattribuiert',
    'thread-antwort',
    'thread-antwort-nicht-verschluesselbar',
    'wurf-pfad-mit-clientid',
    'alter-server-kein-clientid',
  ];

  for (const szenario of SZENARIEN) {
    console.log(`\nSzenario "${szenario}":`);
    try {
      execFileSync(
        'node',
        ['--import', path.join(ordner, 'register-hook.mjs'), '--import', 'tsx', path.join(ordner, 'probe.mts')],
        { cwd: desktopPaket, env: { ...process.env, SZENARIO: szenario }, stdio: 'inherit' },
      );
    } catch {
      fehlerGesamt += 1;
    }
  }
} finally {
  // WICHTIG: process.exit() steht bewusst NICHT hier im try — siehe
  // scripts/benachrichtigung-lib-pruefen.mjs, derselbe Grund.
  fs.rmSync(ordner, { recursive: true, force: true });
}

console.log(fehlerGesamt
  ? `\n\x1b[31m${fehlerGesamt} Szenario(en) fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mJede abgewiesene message:send trifft genau die richtige Zeile — im Kanal, im Thread, mit clientId aus einem frühen fail()-Return UND mit clientId vom generischen Wurf-Fänger; bleibt clientId ganz aus (unbeteiligter Fehler oder wirklich alter Server), rührt der Client keine Zeile an, statt zu raten.\x1b[0m\n');
process.exit(fehlerGesamt ? 1 : 0);

/** file://-URL als Literal für die generierte Probedatei — Windows-Backslashes eingeschlossen. */
function pathToFileUrlLiteral(p) {
  return `file://${p.replace(/\\/g, '/')}`;
}
