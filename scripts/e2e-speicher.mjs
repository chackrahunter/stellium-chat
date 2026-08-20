/**
 * Wächst der Speicher unbegrenzt mit dem Verlauf?
 *
 * Gemessen wird der JS-Haufen und die Zahl der Knoten im Dokument, während
 * viele Nachrichten eintreffen. Beides muss sich einpendeln — sonst trägt
 * die App nach einem Arbeitstag alles mit, was jemals geschrieben wurde.
 */
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';
import { verlaufSaeen } from './verlauf-saeen.mjs';

/* Eigener Server statt der Entwicklungsdatenbank: die braucht persönliche
   Zugangsdaten und ein Masterpasswort aus der Keychain — ein Prüflauf, der
   davon abhängt, läuft auf keinem zweiten Rechner. */
const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const probe = await probeserver();
const S = probe.S;

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const b = await chromium.launch({ headless: true, args: ['--js-flags=--expose-gc'] });
const p = await (await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'de-DE' })).newPage();
await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [S, probe.token]);
await p.reload(); await p.waitForTimeout(1200);
await p.waitForSelector('.app', { timeout: 20000 });
await p.waitForTimeout(2500);

const messe = async () => {
  await p.evaluate(() => { if (window.gc) window.gc(); });
  await p.waitForTimeout(400);
  return p.evaluate(() => ({
    haufen: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    knoten: document.querySelectorAll('*').length,
    nachrichtenImDom: document.querySelectorAll('.msg').length,
    imSpeicher: window.__stelliumStore
      ? Object.values(window.__stelliumStore.getState().messages).reduce((n, l) => n + l.length, 0)
      : null,
  }));
};

const anfang = await messe();
console.log(`  Start: ${anfang.haufen ?? '?'} MB · ${anfang.knoten} Knoten · ${anfang.nachrichtenImDom} Nachrichten im Dokument`);

/* Viele Nachrichten hereinbekommen — über den Zustand, damit es schnell geht
   und die Prüfdatenbank nicht mit tausend Zeilen zugemüllt wird. */
await p.evaluate(() => {
  const store = window.__stelliumStore;
  const s = store.getState();
  const kanal = s.activeChannelId;
  /* Eine Vorlage selbst bauen statt eine vorhandene zu kopieren: auf einem
     frischen Server steht noch nichts im Kanal, und der Lauf soll nicht davon
     abhängen, dass vorher jemand geschrieben hat. */
  const vorlage = (s.messages[kanal] ?? [])[0] ?? {
    id: 'vorlage', channelId: kanal, userId: s.self.id, parentId: null,
    text: '', sourceLang: 'de', createdAt: Date.now(), editedAt: null, deletedAt: null,
    systemKind: null, attachments: [], reactions: [], replyCount: 0, lastReplyAt: null,
    threadParticipantIds: [], mentionUserIds: [], links: [], poll: null, voice: null,
    pinned: false, saved: false, translation: null,
  };
  for (let i = 0; i < 1200; i++) {
    store.setState((alt) => {
      const liste = alt.messages[kanal] ?? [];
      const neu = {
        ...vorlage,
        id: `probe_${i}`,
        text: `Lastprobe ${i} — ${'x'.repeat(80)}`,
        createdAt: Date.now() + i,
        reactions: [], attachments: [], links: [], poll: null, voice: null,
      };
      return { messages: { ...alt.messages, [kanal]: [...liste, neu] } };
    });
  }
});
await p.waitForTimeout(2500);

const nachher = await messe();
console.log(`  Nach 1200: ${nachher.haufen ?? '?'} MB · ${nachher.knoten} Knoten · ${nachher.nachrichtenImDom} im Dokument · ${nachher.imSpeicher} im Speicher`);

/* Die 1200 oben werden am Handler vorbei eingespeist — das belastet
   absichtlich das Dokument. Ob der echte Weg begrenzt, zeigt sich, sobald
   der Server den Verlauf schickt. */
await pruefe('Der echte Weg begrenzt den Verlauf', async () => {
  /* Diese Prüfung maß auf einem frischen Probeserver nichts: der Kanal war
     leer, `wieviele` war 0, und `0 <= 400` ist immer wahr. Begrenzen kann sich
     nur zeigen, wenn es mehr zu begrenzen gibt als die Grenze — deshalb erst
     säen, dann öffnen, und beide Seiten prüfen. */
  const kanal = await p.evaluate(() => window.__stelliumStore.getState().activeChannelId);
  await verlaufSaeen(probe, 450);
  await p.evaluate((k) => window.__stelliumStore.getState().openChannel(k), kanal);
  await p.waitForTimeout(3000);
  const wieviele = await p.evaluate((k) => (window.__stelliumStore.getState().messages[k] ?? []).length, kanal);
  muss(wieviele > 0, 'gar keine Nachricht im Speicher — dann sagt die Prüfung nichts');
  muss(wieviele <= 400, `${wieviele} Nachrichten im Speicher`);
  return `${wieviele} von 450 gesäten`;
});

await pruefe('Das Dokument bleibt schlank', async () => {
  muss(nachher.nachrichtenImDom <= 200, `${nachher.nachrichtenImDom} Nachrichten im Dokument`);
  return `${nachher.nachrichtenImDom} Nachrichten gezeichnet`;
});

await pruefe('Die Knotenzahl bleibt beherrschbar', async () => {
  muss(nachher.knoten < 6000, `${nachher.knoten} Knoten`);
  return `${nachher.knoten} Knoten`;
});

/* Das `if` stand um diese Prüfung herum: ohne `performance.memory` fiel sie
   still aus, und der Lauf meldete trotzdem „alle bestanden". Ein Übersprung
   gehört sichtbar gemacht — sonst weiß niemand, dass die Zahl nie gemessen
   wurde. */
await pruefe('Der Haufen wächst nicht ins Uferlose', async () => {
  muss(anfang.haufen && nachher.haufen,
    'performance.memory gibt nichts her — der Haufen wurde gar nicht gemessen '
    + '(chromium mit --enable-precise-memory-info starten)');
  const zuwachs = nachher.haufen - anfang.haufen;
  muss(zuwachs < 60, `+${zuwachs} MB`);
  return `+${zuwachs} MB (von ${anfang.haufen} auf ${nachher.haufen})`;
});

/* Genug Kanäle anlegen, dass „vergessen" überhaupt etwas heißen kann.
   Ein frischer Probeserver hat einen einzigen offenen Kanal; die Prüfung
   darunter war damit von vornherein erfüllt, ohne dass je ein Kanal aus dem
   Speicher fiel. Angelegt wird über die Ereignisleitung — eine Adresse dafür
   gibt es nicht. */
{
  const { WebSocket } = await import('ws');
  const draht = new WebSocket(`${S.replace('http', 'ws')}/ws`);
  const eingang = [];
  draht.on('message', (roh) => eingang.push(JSON.parse(roh.toString())));
  await new Promise((f, x) => { draht.once('open', f); draht.once('error', x); });
  draht.send(JSON.stringify({ t: 'auth', token: probe.token, protocol: 1 }));
  const warteAuf = async (art, sek = 20) => {
    const bis = Date.now() + sek * 1000;
    for (;;) {
      const treffer = eingang.find((ev) => ev.t === art);
      if (treffer) return treffer;
      if (Date.now() > bis) throw new Error(`Auf "${art}" kam nichts zurück`);
      await new Promise((f) => setTimeout(f, 100));
    }
  };
  await warteAuf('ready');
  for (let i = 0; i < 11; i += 1) {
    eingang.length = 0;
    draht.send(JSON.stringify({ t: 'channel:create', kind: 'public', name: `speicherprobe-${i}` }));
    await warteAuf('channel:upsert');
  }
  draht.close();
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(2500);
}

// Kanalwechsel: alte Kanäle sollen vergessen werden.
await pruefe('Nicht besuchte Kanäle werden vergessen', async () => {
  const kanaele = await p.evaluate(() => {
    const s = window.__stelliumStore.getState();
    return Object.values(s.channels).filter((c) => c.kind === 'public').slice(0, 12).map((c) => c.id);
  });
  for (const id of kanaele) {
    await p.evaluate((k) => window.__stelliumStore.getState().openChannel(k), id);
    await p.waitForTimeout(220);
  }
  await p.waitForTimeout(1200);
  const gehalten = await p.evaluate(() => Object.keys(window.__stelliumStore.getState().messages).length);
  /* Ohne diese Zeile prüfte die Zusage nichts: ein frischer Probeserver hat
     wenige offene Kanäle, und `gehalten <= 7` ist dann von vornherein wahr.
     Vergessen kann nur, wer vorher mehr besucht hat als er behalten darf. */
  muss(kanaele.length > 7,
    `nur ${kanaele.length} offene Kanäle besucht — unter acht kann gar nichts vergessen werden`);
  muss(gehalten <= 7, `${gehalten} Kanäle im Speicher`);
  return `${gehalten} von ${kanaele.length} behalten`;
});

await b.close();
await probe.stop();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
