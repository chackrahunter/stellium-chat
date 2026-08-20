/**
 * Antwortet der Assistent — privat, im Team-Kanal, und in der Sprache der Frage?
 *
 * WAS HIER FRÜHER STAND
 * Dieselben drei Fragen, aber ohne eine einzige Zusicherung. Jede Beobachtung
 * ging als `console.log` hinaus, „KEINE ANTWORT nach 45s" eingeschlossen, und
 * am Ende stand ein unbedingtes `process.exit(0)`. Der Lauf konnte nicht
 * durchfallen — auch dann nicht, wenn die KI auf keine der drei Fragen
 * antwortete. Dazu ein fest eingetragenes fremdes Konto (`pruefr79z`), das
 * kein Lauf hier anlegt, und ein Passwort als Aufrufargument.
 *
 * Jetzt: eigener Probeserver, echte Zusicherungen, Rückgabewert. Ist gar keine
 * KI eingerichtet, fällt der Lauf mit einem klaren Satz durch statt still
 * grün zu melden — „nicht geprüft" ist kein bestandener Lauf.
 *
 *   node scripts/ki-test.mjs
 */
import { WebSocket } from 'ws';
import { probeserver } from './probeserver.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };
/** Die Absage, die der Gateway bei einem Fehlschlag in den Kanal schreibt. */
const keineAntwort = (text) => /^Ich konnte gerade nicht antworten/.test(text.trim());

/** Wie lange auf eine Antwort der KI gewartet wird. */
const FRIST = 60_000;

// Mit Schlüssel: ohne ihn gibt es keinen Assistenten, und dann prüft der Lauf nichts.
const probe = await probeserver({ mitSchluessel: true });
const ws = new WebSocket(`${probe.S.replace('http', 'ws')}/ws`);
const horcher = new Map();
const uhren = new Set();

const on = (t, f) => horcher.set(t, [...(horcher.get(t) ?? []), f]);
const einmal = (t) => new Promise((r) => on(t, r));
/** Ein Versprechen mit Frist — und der Wecker wird hinterher wieder abgestellt. */
const mitFrist = (versprechen, ms = FRIST) => {
  let uhr;
  const frist = new Promise((r) => { uhr = setTimeout(() => r(null), ms); uhren.add(uhr); });
  return Promise.race([versprechen, frist]).finally(() => { clearTimeout(uhr); uhren.delete(uhr); });
};

const fehler = [];
ws.on('message', (roh) => {
  const ev = JSON.parse(roh.toString());
  (horcher.get(ev.t) ?? []).forEach((f) => f(ev));
  if (ev.t === 'error') fehler.push(`${ev.code ?? ''} ${ev.message ?? ''}`.trim());
});

try {
  await new Promise((fertig, schief) => { ws.once('open', fertig); ws.once('error', schief); });
  ws.send(JSON.stringify({ t: 'auth', token: probe.token, protocol: 1 }));
  const bereit = await mitFrist(einmal('ready'), 20_000);
  muss(bereit, 'die Leitung kam nicht zustande');

  console.log(`\nKI: ${bereit.ai?.provider ?? '—'} · ${bereit.ai?.model ?? '—'}`);

  await pruefe('Es ist überhaupt eine KI eingerichtet', async () => {
    muss(bereit.ai?.assistant,
      'kein Assistent eingerichtet — ohne Schlüssel prüft dieser Lauf nichts '
      + '(packages/server/data/secrets.enc anlegen oder GROQ_API_KEY setzen)');
    return `${bereit.ai.provider} · ${bereit.ai.model}`;
  });

  /* Ohne Assistenten hat alles Weitere keinen Gegenstand. Abbrechen ist hier
     richtig — weiterlaufen hieße, sechs Fehlschläge zu melden, die alle
     dieselbe eine Ursache haben. */
  if (!bereit.ai?.assistant) throw new Error('ohne Assistenten geht es nicht weiter');

  /* ── Privater Chat ─────────────────────────────────────────── */

  const dmVersprechen = einmal('channel:upsert');
  ws.send(JSON.stringify({ t: 'ai:open-chat' }));
  const dmEreignis = await mitFrist(dmVersprechen, 20_000);
  muss(dmEreignis, 'der private KI-Chat wurde nicht angelegt');
  const dm = dmEreignis.channel.id;

  const antwortAuf = (kanal) => new Promise((r) => on('message:new', (ev) => {
    if (ev.message.channelId === kanal && ev.message.userId !== bereit.self.id) r(ev.message);
  }));

  await pruefe('Der Assistent antwortet im privaten Chat', async () => {
    const kommt = antwortAuf(dm);
    const t0 = Date.now();
    ws.send(JSON.stringify({
      t: 'message:send', clientId: 'k1', channelId: dm,
      text: 'Antworte in einem kurzen Satz: wofür ist dieser Chat da?',
    }));
    const antwort = await mitFrist(kommt);
    muss(antwort, `keine Antwort in ${FRIST / 1000} s${fehler.length ? ` (${fehler[fehler.length - 1]})` : ''}`);
    /* Eine Absage IST eine Nachricht: der Gateway schreibt Fehlschläge als
       Nachricht in den Kanal. Ohne diese Zeile bestand die Prüfung auch dann,
       wenn dort „Ich konnte gerade nicht antworten: groq: fetch failed" stand
       — beim Verbiegen dieses Laufs genau so gemessen. */
    muss(!keineAntwort(antwort.text), `die KI sagt ab: „${antwort.text.slice(0, 90)}"`);
    muss(antwort.text.trim().length > 10, `die Antwort ist zu kurz: „${antwort.text}"`);
    return `${Date.now() - t0} ms · „${antwort.text.replace(/\n/g, ' ').slice(0, 70)}…"`;
  });

  /* ── Gemeinsamer Kanal ─────────────────────────────────────── */

  await pruefe('Der Assistent antwortet im Team-Kanal', async () => {
    const kanalVersprechen = einmal('channel:history');
    ws.send(JSON.stringify({ t: 'ai:open-team-channel' }));
    const team = await mitFrist(kanalVersprechen, 20_000);
    muss(team, 'der Team-Kanal kam nicht zustande');
    const kommt = antwortAuf(team.channelId);
    ws.send(JSON.stringify({
      t: 'message:send', clientId: 'k2', channelId: team.channelId,
      text: 'Fasse in einem Satz zusammen, wofür dieser Kanal da ist.',
    }));
    const antwort = await mitFrist(kommt);
    muss(antwort, `keine Antwort in ${FRIST / 1000} s${fehler.length ? ` (${fehler[fehler.length - 1]})` : ''}`);
    muss(!keineAntwort(antwort.text), `die KI sagt ab: „${antwort.text.slice(0, 90)}"`);
    muss(antwort.text.trim().length > 10, `die Antwort ist zu kurz: „${antwort.text}"`);
    return `„${antwort.text.replace(/\n/g, ' ').slice(0, 70)}…"`;
  });

  /* ── Die Sprache folgt der Frage ───────────────────────────── */

  await pruefe('Auf eine englische Frage kommt eine englische Antwort', async () => {
    const kommt = antwortAuf(dm);
    ws.send(JSON.stringify({
      t: 'message:send', clientId: 'k3', channelId: dm,
      text: 'Please answer in one short sentence: what is the capital of Japan?',
    }));
    const antwort = await mitFrist(kommt);
    muss(antwort, `keine Antwort in ${FRIST / 1000} s`);
    muss(!keineAntwort(antwort.text), `die KI sagt ab: „${antwort.text.slice(0, 90)}"`);
    /* Nicht am Sprachfeld gemessen, sondern am Text: das Feld setzt der Server
       selbst, und wenn er sich irrt, soll genau das auffallen. „Tokyo" steht
       in beiden Sprachen; deutsche Funktionswörter stehen nur in einer. */
    const deutsch = /\b(ist|die|der|das|Hauptstadt|von)\b/.test(antwort.text);
    muss(!deutsch, `die Antwort ist deutsch: „${antwort.text.slice(0, 90)}"`);
    return `${antwort.sourceLang ?? '?'} · „${antwort.text.replace(/\n/g, ' ').slice(0, 70)}"`;
  });
} catch (f) {
  ergebnisse.push(0);
  console.log(`  ✗ ${f.message.split('\n')[0]}`);
} finally {
  for (const uhr of uhren) clearTimeout(uhr);
  ws.close();
  await probe.stop();
}

const schlecht = ergebnisse.filter((x) => !x).length;
if (!ergebnisse.length) { console.log('\n✗ keine einzige Prüfung gelaufen'); process.exit(1); }
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
