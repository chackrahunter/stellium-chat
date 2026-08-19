/**
 * Eine Thread-Antwort gehört in den Thread — und sonst nirgendwohin.
 *
 * Der Fehler, den dieser Lauf festhält: eine Antwort in einem Thread stand
 * zusätzlich als eigene neue Nachricht in der Hauptliste des Kanals. Einmal
 * richtig rechts im Thread, einmal falsch mittendrin im Verlauf.
 *
 * Geprüft wird an drei Stellen, damit im Fehlerfall sofort klar ist, welche
 * davon es war — Vermuten hat an dieser Stelle schon einmal einen halben Tag
 * gekostet:
 *
 *   Datenbank   Steht die Antwort genau einmal in `messages`?
 *   Leitung     Kommt genau ein `message:new` beim Client an, und liefert
 *               `channel:open` die Antwort richtigerweise nicht mit?
 *   Anzeige     Steht sie im Thread-Bereich und *nicht* in der Hauptliste?
 *
 * Der Lauf bringt seinen eigenen Server mit (frische Datenbank), braucht aber
 * die Oberfläche unter http://localhost:5173 — also `npm run dev:desktop`
 * in einem zweiten Fenster.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const ZIEL = process.env.STELLIUM_BILDER ?? 'schirmbilder';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const WURZELTEXT = 'Ich habe den Entwurf angehängt und bitte um eure Rückmeldung.';
const ANTWORTTEXT = 'Was meinst du?';

const probe = await probeserver();
let browser = null;

try {
  /* ── Leitung: anmelden, Kanal anlegen, Thread schreiben ──────── */

  const leitung = await verbinden(probe.S, probe.token);

  /* Auf den Namen warten, nicht auf das erste `channel:upsert`: gleich nach dem
     Verbinden schickt der Server die vorhandenen Kanäle, und der Lauf prüfte
     sonst an #allgemein statt am eigens angelegten Kanal. */
  const kanalName = `probe-${Date.now().toString(36).slice(-5)}`;
  const kanal = await leitung.frage(
    { t: 'channel:create', kind: 'public', name: kanalName, topic: 'Thread-Prüfung' },
    (ev) => ev.t === 'channel:upsert' && ev.channel.name === kanalName,
  );
  const kanalId = kanal.channel.id;

  const wurzel = await leitung.frage(
    { t: 'message:send', clientId: 'w1', channelId: kanalId, text: WURZELTEXT },
    (ev) => ev.t === 'message:new' && ev.message.channelId === kanalId,
  );
  const wurzelId = wurzel.message.id;

  // Ab hier alles mitschreiben, was hereinkommt — gezählt wird danach.
  leitung.mitschreiben();
  leitung.senden({
    t: 'message:send', clientId: 'a1', channelId: kanalId, text: ANTWORTTEXT, parentId: wurzelId,
  });
  await warte(2500);

  const neue = leitung.gesammelt().filter((ev) => ev.t === 'message:new');
  const antworten = neue.filter((ev) => ev.message.parentId === wurzelId);
  const antwortId = antworten[0]?.message.id;

  console.log('\nDatenbank');

  await pruefe('Die Antwort steht genau einmal in `messages`', () => {
    const db = new DatabaseSync(probe.datenbank, { readOnly: true });
    const zeilen = db.prepare('SELECT id, parent_id FROM messages WHERE channel_id = ?').all(kanalId);
    db.close();
    const kinder = zeilen.filter((z) => z.parent_id === wurzelId);
    muss(kinder.length === 1, `${kinder.length} Zeilen mit parent_id = Wurzel (erwartet 1)`);
    const wurzeln = zeilen.filter((z) => z.parent_id === null);
    muss(wurzeln.length === 1, `${wurzeln.length} Nachrichten ohne parent_id (erwartet 1)`);
    return `${zeilen.length} Zeilen im Kanal, davon 1 Antwort`;
  });

  await pruefe('Die Antwort trägt die Wurzel als `parent_id`', () => {
    muss(antwortId, 'gar keine Antwort angekommen');
    const db = new DatabaseSync(probe.datenbank, { readOnly: true });
    const z = db.prepare('SELECT parent_id FROM messages WHERE id = ?').get(antwortId);
    db.close();
    muss(z?.parent_id === wurzelId, `parent_id = ${z?.parent_id ?? 'null'}`);
  });

  console.log('\nLeitung');

  await pruefe('Der Server schickt genau ein `message:new` für die Antwort', () => {
    muss(antworten.length === 1, `${antworten.length} Ereignisse (erwartet 1)`);
    return `1 Ereignis, id ${antwortId}`;
  });

  await pruefe('Kein zweites Ereignis mit demselben Text', () => {
    const gleich = neue.filter((ev) => ev.message.text === ANTWORTTEXT);
    muss(gleich.length === 1, `${gleich.length} Ereignisse mit dem Text "${ANTWORTTEXT}"`);
  });

  await pruefe('`channel:open` liefert die Antwort nicht mit', async () => {
    const verlauf = await leitung.frage(
      { t: 'channel:open', channelId: kanalId, limit: 50 },
      (ev) => ev.t === 'channel:history' && ev.channelId === kanalId,
    );
    const drin = verlauf.messages.filter((m) => m.id === antwortId);
    muss(drin.length === 0, 'die Antwort steht im Kanalverlauf');
    muss(verlauf.messages.length === 1, `${verlauf.messages.length} Nachrichten im Verlauf (erwartet 1)`);
    return `${verlauf.messages.length} Nachricht im Verlauf`;
  });

  await pruefe('`thread:open` liefert die Antwort mit', async () => {
    const thread = await leitung.frage(
      { t: 'thread:open', messageId: wurzelId },
      (ev) => ev.t === 'thread:history' && ev.parentId === wurzelId,
    );
    muss(thread.messages.some((m) => m.id === antwortId), 'die Antwort fehlt im Thread');
    muss(thread.messages.length === 2, `${thread.messages.length} Nachrichten im Thread (erwartet 2: Wurzel + Antwort)`);
    return 'Wurzel + 1 Antwort';
  });

  console.log('\nSprache');

  await pruefe('Die kurze deutsche Antwort wird nicht als Englisch geführt', () => {
    const s = antworten[0]?.message.sourceLang;
    muss(s === 'de' || s === null,
      `sourceLang = ${JSON.stringify(s)} für einen deutschen Satz`);
    return `sourceLang = ${JSON.stringify(s)}`;
  });

  await pruefe('Auch der längere deutsche Satz wird nicht als Englisch geführt', () => {
    const s = wurzel.message.sourceLang;
    muss(s === 'de' || s === null, `sourceLang = ${JSON.stringify(s)}`);
    return `sourceLang = ${JSON.stringify(s)}`;
  });

  /* Kurze deutsche Sätze ohne Umlaut und ohne großgeschriebenes Substantiv
     waren die Lücke: sie enthielten kein einziges deutsches Stoppwort und
     fielen deshalb auf Englisch oder Spanisch. */
  const saetze = ['Wie sieht es aus?', 'Passt das so?', 'Alles klar bei dir?', 'Wo finde ich das?'];
  for (const [i, satz] of saetze.entries()) {
    await pruefe(`„${satz}" gilt nicht als fremde Sprache`, async () => {
      // Fortlaufend nummeriert: zwei Nachrichten mit derselben `clientId` hält
      // die Oberfläche für dieselbe und ersetzt die eine durch die andere.
      const ev = await leitung.frage(
        { t: 'message:send', clientId: `sprache-${i}`, channelId: kanalId, text: satz },
        (x) => x.t === 'message:new' && x.message.text === satz,
      );
      const s = ev.message.sourceLang;
      muss(s === 'de' || s === null, `sourceLang = ${JSON.stringify(s)}`);
      return `sourceLang = ${JSON.stringify(s)}`;
    });
  }

  /* ── Anzeige: was steht wirklich auf dem Schirm? ─────────────── */

  console.log('\nAnzeige');

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
  const p = await ctx.newPage();
  // Ein Absturz in der Oberfläche sieht von außen aus wie „Element nicht da".
  // Damit dieser Lauf nicht wieder zum Rätselraten wird, steht er im Klartext.
  const seitenfehler = [];
  p.on('pageerror', (e) => seitenfehler.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') seitenfehler.push(m.text()); });
  await p.goto(APP);
  await p.evaluate(([s, t]) => {
    localStorage.setItem('stellium.serverUrl', s);
    localStorage.setItem('stellium.token', t);
    localStorage.setItem('stellium.tourGesehen', 'ja');
  }, [probe.S, probe.token]);
  await p.reload();
  await p.waitForSelector('.app', { timeout: 20000 });
  await p.waitForTimeout(1500);

  // In den Prüfkanal wechseln und den Thread aufmachen.
  await p.evaluate((id) => window.__stelliumStore.getState().openChannel(id), kanalId);
  await p.waitForTimeout(1200);
  await p.evaluate((id) => window.__stelliumStore.getState().openThread(id), wurzelId);
  await p.waitForSelector('.thread', { timeout: 8000 });
  await p.waitForTimeout(900);

  const gezaehlt = await p.evaluate((id) => {
    const zaehle = (wurzel) => wurzel
      ? wurzel.querySelectorAll(`[data-message-id="${id}"]`).length : -1;
    return {
      hauptliste: zaehle(document.querySelector('.stream')),
      thread: zaehle(document.querySelector('.thread')),
      imSpeicher: (window.__stelliumStore.getState().messages[
        window.__stelliumStore.getState().activeChannelId] ?? []
      ).filter((m) => m.id === id).length,
    };
  }, antwortId);

  await pruefe('Die Antwort steht im Thread-Bereich', () => {
    muss(gezaehlt.thread === 1, `${gezaehlt.thread} mal im Thread (erwartet 1)`);
  });

  await pruefe('Die Antwort steht NICHT in der Hauptliste des Kanals', () => {
    muss(gezaehlt.hauptliste === 0,
      `${gezaehlt.hauptliste} mal in der Hauptliste — genau das ist der doppelte Eintrag`);
  });

  await pruefe('Die Kanalliste im Zustandsspeicher führt die Antwort nicht', () => {
    muss(gezaehlt.imSpeicher === 0,
      `${gezaehlt.imSpeicher} mal in messages[Kanal] — von dort speist sich die Hauptliste`);
  });

  // Eine Antwort, die aus der eigenen Oberfläche kommt, muss sich genauso
  // verhalten wie eine, die über die Leitung hereinkommt: der optimistische
  // Eintrag darf ebenso wenig in der Hauptliste landen.
  const zweiterText = 'Und noch eine Antwort im selben Thread.';
  await p.evaluate(([kanal, wurzelMsg, text]) => {
    window.__stelliumStore.getState().sendMessage({ channelId: kanal, text, parentId: wurzelMsg });
  }, [kanalId, wurzelId, zweiterText]);
  await p.waitForTimeout(1800);

  const zweite = await p.evaluate((text) => {
    const s = window.__stelliumStore.getState();
    const treffer = (s.threads[Object.keys(s.threads)[0]] ?? []).find((m) => m.text === text);
    const id = treffer?.id;
    const zaehle = (wurzel) => wurzel && id
      ? wurzel.querySelectorAll(`[data-message-id="${id}"]`).length : -1;
    return {
      id,
      hauptliste: zaehle(document.querySelector('.stream')),
      thread: zaehle(document.querySelector('.thread')),
      imSpeicher: (s.messages[s.activeChannelId] ?? []).filter((m) => m.id === id).length,
    };
  }, zweiterText);

  await pruefe('Selbst geschriebene Antwort steht im Thread', () => {
    muss(zweite.thread === 1, `${zweite.thread} mal im Thread (erwartet 1)`);
  });

  await pruefe('Selbst geschriebene Antwort steht NICHT in der Hauptliste', () => {
    muss(zweite.hauptliste === 0,
      `${zweite.hauptliste} mal in der Hauptliste — der optimistische Eintrag bleibt hängen`);
    muss(zweite.imSpeicher === 0, `${zweite.imSpeicher} mal in messages[Kanal]`);
  });

  /* Der Weg, den Don gesehen hat: die Antwort kommt herein, während der Kanal
     offen ist. Vorher lief sie über `message:new` in die Kanalliste und stand
     damit sofort im Verlauf — bis zum nächsten Neuladen. */
  const dritterText = 'Diese Antwort kommt von außen herein.';
  const zweiteLeitung = await verbinden(probe.S, probe.token);
  const dritte = await zweiteLeitung.frage(
    { t: 'message:send', clientId: 'a3', channelId: kanalId, text: dritterText, parentId: wurzelId },
    (ev) => ev.t === 'message:new' && ev.message.text === dritterText,
  );
  const dritteId = dritte.message.id;
  await p.waitForTimeout(1200);

  const live = await p.evaluate((id) => {
    const s = window.__stelliumStore.getState();
    const zaehle = (wurzel) => wurzel ? wurzel.querySelectorAll(`[data-message-id="${id}"]`).length : -1;
    return {
      hauptliste: zaehle(document.querySelector('.stream')),
      thread: zaehle(document.querySelector('.thread')),
      imSpeicher: (s.messages[s.activeChannelId] ?? []).filter((m) => m.id === id).length,
    };
  }, dritteId);

  await pruefe('Hereinkommende Antwort landet im Thread', () => {
    muss(live.thread === 1, `${live.thread} mal im Thread (erwartet 1)`);
  });

  await pruefe('Hereinkommende Antwort landet NICHT in der Hauptliste', () => {
    muss(live.hauptliste === 0,
      `${live.hauptliste} mal in der Hauptliste — genau der Doppeleintrag aus dem Bildschirmabzug`);
    muss(live.imSpeicher === 0, `${live.imSpeicher} mal in messages[Kanal]`);
  });

  /* Zweiter Weg in dieselbe Falle: eine bearbeitete Thread-Antwort. Auch
     `message:updated` fügte sie in den Verlauf ein, wenn sie dort fehlte. */
  const geaendert = `${dritterText} (überarbeitet)`;
  await zweiteLeitung.frage(
    { t: 'message:edit', messageId: dritteId, text: geaendert },
    (ev) => ev.t === 'message:updated' && ev.message.id === dritteId,
  );
  await p.waitForTimeout(900);

  const nachAenderung = await p.evaluate((id) => {
    const s = window.__stelliumStore.getState();
    return {
      hauptliste: document.querySelector('.stream')?.querySelectorAll(`[data-message-id="${id}"]`).length ?? -1,
      imSpeicher: (s.messages[s.activeChannelId] ?? []).filter((m) => m.id === id).length,
    };
  }, dritteId);

  await pruefe('Bearbeitete Thread-Antwort rutscht nicht in die Hauptliste', () => {
    muss(nachAenderung.hauptliste === 0, `${nachAenderung.hauptliste} mal in der Hauptliste`);
    muss(nachAenderung.imSpeicher === 0, `${nachAenderung.imSpeicher} mal in messages[Kanal]`);
  });

  // Der Zähler an der Wurzel ist das, was von einem Thread im Verlauf zu sehen
  // sein soll — er darf durch das Aussortieren nicht stehenbleiben.
  const zaehler = await p.evaluate((id) => {
    const s = window.__stelliumStore.getState();
    const wurzelMsg = (s.messages[s.activeChannelId] ?? []).find((m) => m.id === id);
    const imVerlauf = document.querySelector(`.stream [data-message-id="${id}"]`);
    return { replyCount: wurzelMsg?.replyCount ?? -1, text: imVerlauf?.innerText ?? '' };
  }, wurzelId);

  await pruefe('Die Wurzel zählt alle drei Antworten', () => {
    muss(zaehler.replyCount === 3, `replyCount = ${zaehler.replyCount} (erwartet 3)`);
    // Der Zähler ist das, was von einem Thread im Verlauf zu sehen sein soll.
    muss(/3\s+Antworten/.test(zaehler.text),
      `im Verlauf steht "${zaehler.text.replace(/\s+/g, ' ').slice(0, 80)}"`);
    return `${zaehler.replyCount} Antworten an der Wurzel`;
  });

  zweiteLeitung.schliessen();
  leitung.schliessen();

  await pruefe('Die Oberfläche lief ohne Fehler durch', () => {
    muss(seitenfehler.length === 0, seitenfehler.slice(0, 3).join(' | '));
  });

  // Ein Bild vom Ergebnis — Zahlen sagen ob, ein Bild sagt wie.
  fs.mkdirSync(ZIEL, { recursive: true });
  await p.screenshot({ path: `${ZIEL}/thread-doppelt.png` });
  console.log(`\n  Bild: ${ZIEL}/thread-doppelt.png`);

  await ctx.close();
} finally {
  if (browser) await browser.close();
  await probe.stop();
}

const gut = ergebnisse.filter(Boolean).length;
console.log(`\n${gut}/${ergebnisse.length} bestanden\n`);
process.exit(gut === ergebnisse.length ? 0 : 1);

/* ── Werkzeug ─────────────────────────────────────────────────── */

function warte(ms) { return new Promise((f) => setTimeout(f, ms)); }

/**
 * Eine offene Leitung, die sich fragen lässt und auf Wunsch alles mitschreibt.
 *
 * Bewusst eine dauerhafte Verbindung statt einer je Frage: der Fehler zeigt
 * sich erst, wenn Kanal und Thread in derselben Sitzung offen sind — mit einer
 * frischen Verbindung je Schritt wäre er nie aufgefallen.
 */
async function verbinden(server, token) {
  const ws = new WebSocket(`${server.replace(/^http/, 'ws')}/ws`);
  const warteschlange = [];
  let protokoll = null;

  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (protokoll) protokoll.push(ev);
    for (let i = warteschlange.length - 1; i >= 0; i--) {
      if (warteschlange[i].passt(ev)) { warteschlange.splice(i, 1)[0].fertig(ev); }
    }
  };

  await new Promise((fertig, fehler) => {
    const timer = setTimeout(() => fehler(new Error('Zeitüberschreitung beim Anmelden')), 12000);
    warteschlange.push({ passt: (ev) => ev.t === 'ready', fertig: () => { clearTimeout(timer); fertig(); } });
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token, protocol: 1 }));
    ws.onerror = () => { clearTimeout(timer); fehler(new Error('Verbindungsfehler')); };
  });

  return {
    senden: (ev) => ws.send(JSON.stringify(ev)),
    frage(ev, passt) {
      return new Promise((fertig, fehler) => {
        const timer = setTimeout(() => fehler(new Error(`Zeitüberschreitung: ${ev.t}`)), 12000);
        warteschlange.push({ passt, fertig: (x) => { clearTimeout(timer); fertig(x); } });
        ws.send(JSON.stringify(ev));
      });
    },
    mitschreiben() { protokoll = []; },
    gesammelt() { return protokoll ?? []; },
    schliessen() { try { ws.close(); } catch { /* schon zu */ } },
  };
}
