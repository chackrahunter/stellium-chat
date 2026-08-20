/**
 * Das Serverherz: Zugang, Grenzen, Buchführung.
 *
 * Diese Prüfung entstand aus einem Durchgang durch Gateway, Routen, Dienste
 * und Datenbank. Jede Zeile hier hat einen Fund belegt, bevor er behoben
 * wurde — sie ist also einmal rot gewesen, und zwar aus dem Grund, den ihr
 * Name nennt.
 *
 * DREI ARTEN VON PRÜFUNG STEHEN HIER NEBENEINANDER
 *
 *   Zugang    Eine Person, die nirgends Mitglied ist, versucht an Inhalte zu
 *             kommen, die ihr nicht gehören. Gemessen wird die Kennung der
 *             Abweisung, nicht bloß dass irgendetwas schiefging: ein Fehler
 *             aus der KI-Schicht bedeutet, dass die Prüfung vorher gar nicht
 *             stattgefunden hat.
 *
 *   Grenzen   Was beim Anlegen begrenzt ist, muss beim Ändern genauso begrenzt
 *             sein. Ein Feld mit Obergrenze im einen Weg und ohne im anderen
 *             ist keine Obergrenze.
 *
 *   Zustand   Was nach einem Vorgang in der Datenbank steht. Dafür wird die
 *             Datei des Probeservers direkt gelesen — was der Server über sich
 *             selbst erzählt, ist hier kein Beleg.
 */
import { readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { probeserver } from './probeserver.mjs';

const probe = await probeserver();
const S = probe.S;

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

const anmelden = async (login, passwort) =>
  (await (await fetch(`${S}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: passwort }),
  })).json());

const marke = Date.now().toString(36).slice(-5);
const ich = await anmelden(probe.login, probe.passwort);
if (!ich.token) { console.error('Anmeldung fehlgeschlagen.'); process.exit(1); }
const meinKopf = { authorization: `Bearer ${ich.token}` };
const meineId = ich.user.id;

/** Eine zweite Person mit gewöhnlichen Rechten, die in nichts drin ist. */
const neu = await (await fetch(`${S}/api/admin/users`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...meinKopf },
  body: JSON.stringify({ displayName: `Fremde ${marke}`, handle: `fremde${marke}`, role: 'member', language: 'de' }),
})).json();
const erst = await anmelden(neu.credential.handle, neu.credential.oneTimePassword);
await fetch(`${S}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${erst.token}` },
  body: JSON.stringify({ newPassword: `Fremdes-Passwort-${marke}` }),
});
const fremde = await anmelden(neu.credential.handle, `Fremdes-Passwort-${marke}`);
const fremderKopf = { authorization: `Bearer ${fremde.token}` };
const fremdeId = neu.credential.userId;

/** Noch ein Konto anlegen und gleich einrichten. */
async function zusatzkonto(handle) {
  const angelegt = await (await fetch(`${S}/api/admin/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...meinKopf },
    body: JSON.stringify({ displayName: handle, handle, role: 'member', language: 'de' }),
  })).json();
  const einmal = await anmelden(angelegt.credential.handle, angelegt.credential.oneTimePassword);
  await fetch(`${S}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${einmal.token}` },
    body: JSON.stringify({ newPassword: `Passwort-fuer-${handle}` }),
  });
  return anmelden(angelegt.credential.handle, `Passwort-fuer-${handle}`);
}

/**
 * Eine Verbindung, die offen bleibt.
 *
 * Die älteren Prüfungen öffnen für jedes Ereignis eine neue — hier wird
 * geprüft, was bei *anderen* ankommt, und dafür muss die andere Seite schon
 * horchen, bevor das Ereignis losgeht.
 */
function sitzung(token) {
  const ws = new WebSocket(`${S.replace(/^http/, 'ws')}/ws`);
  const horcher = new Set();
  const bereit = new Promise((fertig, schief) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token, protocol: 1 }));
    ws.onerror = () => schief(new Error('Verbindungsfehler'));
    ws.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.t === 'ready') fertig(ev);
      for (const h of [...horcher]) h(ev);
    };
  });
  return {
    bereit,
    send: (o) => ws.send(JSON.stringify(o)),
    /** Auf das erste Ereignis warten, auf das die Bedingung passt. */
    warte: (passt, frist = 10_000) => new Promise((fertig, schief) => {
      const uhr = setTimeout(() => { horcher.delete(h); schief(new Error(`nichts in ${frist} ms`)); }, frist);
      const h = (ev) => { if (passt(ev)) { clearTimeout(uhr); horcher.delete(h); fertig(ev); } };
      horcher.add(h);
    }),
    /**
     * Ereignis schicken und die Antwort abholen — Fehler zählen als Antwort.
     *
     * `passt` grenzt die Erfolgsantwort ein. Ohne diese Möglichkeit nahm die
     * Prüfung die Systemnachricht, die beim Vertraulichstellen entsteht, für
     * die Antwort auf ihre eigene Nachricht — und war zufrieden.
     */
    frage: async (ereignis, antwortTyp, passt = null, frist = 10_000) => {
      const warten = new Promise((fertig, schief) => {
        const uhr = setTimeout(() => { horcher.delete(h); schief(new Error(`keine Antwort in ${frist} ms`)); }, frist);
        const h = (ev) => {
          if (ev.t === 'error' || (ev.t === antwortTyp && (!passt || passt(ev)))) {
            clearTimeout(uhr); horcher.delete(h); fertig(ev);
          }
        };
        horcher.add(h);
      });
      ws.send(JSON.stringify(ereignis));
      return warten;
    },
    /** Eine Weile lauschen und alles einsammeln, was passt. */
    sammle: (passt, dauer) => new Promise((fertig) => {
      const treffer = [];
      const h = (ev) => { if (passt(ev)) treffer.push(ev); };
      horcher.add(h);
      setTimeout(() => { horcher.delete(h); fertig(treffer); }, dauer);
    }),
    zu: () => ws.close(),
  };
}

const wir = sitzung(ich.token);
await wir.bereit;
const sie = sitzung(fremde.token);
await sie.bereit;

/* Ein privater Kanal, in dem die Fremde nichts verloren hat. */
wir.send({ t: 'channel:create', kind: 'private', name: `herz-${marke}` });
const kanal = (await wir.warte((e) => e.t === 'channel:upsert' && e.channel?.name === `herz-${marke}`)).channel;
wir.send({ t: 'message:send', clientId: 'h1', channelId: kanal.id, text: `Verschlusssache ${marke}: Umsatz Q3` });
const geheim = (await wir.warte((e) => e.t === 'message:new' && e.message?.channelId === kanal.id)).message;
wir.send({ t: 'message:pin', messageId: geheim.id, pinned: true });
await wir.warte((e) => e.t === 'message:updated' && e.message?.id === geheim.id);

/* ── Zugang ───────────────────────────────────────────────────── */

console.log('\nZugang zu fremden Kanälen');

await pruefe('Angeheftetes aus einem fremden Kanal bleibt zu', async () => {
  const antwort = await (await fetch(`${S}/api/channels/${kanal.id}/pins`, { headers: fremderKopf })).json();
  const texte = (antwort.messages ?? []).map((m) => m.text).join(' ');
  muss(!texte.includes(`Verschlusssache ${marke}`),
    `die angeheftete Nachricht kam heraus: „${texte.slice(0, 60)}"`);
  return `${(antwort.messages ?? []).length} Nachrichten`;
});

/**
 * Bei den KI-Wegen zählt die Kennung und nicht, dass überhaupt ein Fehler kam.
 *
 * Der Probeserver hat keinen KI-Schlüssel. Wer den Zugang nicht prüft, kommt
 * bis in die KI-Schicht und bekommt von dort „KI ist nicht konfiguriert" —
 * ohne Kennung. Genau daran hing dieser Fund: fünf Wege sahen aus, als
 * wiesen sie ab, und in Wahrheit hatte nur das fehlende Modell sie gebremst.
 * Mit einem eingerichteten Modell wäre der Kanalinhalt herausgegangen.
 */
const abgewiesen = (name, ereignis, antwortTyp) => pruefe(name, async () => {
  const a = await sie.frage(ereignis, antwortTyp);
  muss(a.t === 'error', `bekam ${a.t} statt einer Abweisung`);
  muss(a.code === 'fehler.keinKanalZugriff',
    `Kennung „${a.code ?? 'keine'}" — die Abweisung kam nicht aus der Zugangsprüfung, sondern aus „${a.message}"`);
  return a.code;
});

await abgewiesen('Verpasstes zusammenfassen geht nur im eigenen Kanal',
  { t: 'ai:catchup', requestId: 'k1', channelId: kanal.id }, 'ai:catchup');
await abgewiesen('Den Kanal befragen geht nur im eigenen Kanal',
  { t: 'ai:ask', requestId: 'k2', channelId: kanal.id, question: 'Worum geht es?' }, 'ai:ask');
await abgewiesen('Ein Protokoll gibt es nur zum eigenen Kanal',
  { t: 'ai:protocol', channelId: kanal.id }, 'ai:protocol');
await abgewiesen('Antwortvorschläge gibt es nur zum eigenen Kanal',
  { t: 'ai:smart-replies', requestId: 'k3', channelId: kanal.id }, 'ai:smart-replies');
await abgewiesen('Aufgabenerkennung läuft nur im eigenen Kanal',
  { t: 'ai:extract-tasks', requestId: 'k4', channelId: kanal.id }, 'ai:extract-tasks');

await pruefe('Eine Erinnerung auf eine fremde Nachricht wird abgewiesen', async () => {
  /* Der Zeitgeber schickt beim Auslösen die ganze Nachricht mit. Ohne diese
     Prüfung genügte eine bekannte Kennung, um sich den Text einer fremden
     Nachricht zustellen zu lassen — mit sechs Sekunden Verzögerung. */
  const a = await sie.frage(
    { t: 'reminder:create', channelId: kanal.id, messageId: geheim.id, note: 'abgreifen', remindAt: Date.now() + 6000 },
    'reminder:upsert');
  muss(a.t === 'error', `bekam ${a.t} statt einer Abweisung`);
  return a.code ?? a.message;
});

await pruefe('Neu abschreiben geht nur mit Zugang zur Nachricht', async () => {
  const a = await sie.frage({ t: 'voice:retranscribe', messageId: geheim.id }, 'voice:transcript');
  muss(a.t === 'error', `bekam ${a.t} statt einer Abweisung`);
  muss(a.code === 'fehler.keinNachrichtZugang',
    `Kennung „${a.code ?? 'keine'}" — der Server hat erst nach der Aufnahme gesucht und den Zugang gar nicht geprüft`);
  return a.code;
});

await pruefe('Tippen dringt nicht in einen fremden Kanal', async () => {
  const gesammelt = wir.sammle((e) => e.t === 'typing' && e.channelId === kanal.id, 1500);
  sie.send({ t: 'typing', channelId: kanal.id });
  const treffer = await gesammelt;
  muss(treffer.length === 0, `${treffer.length} Tippmeldungen einer Nichtmitglieds kamen im Kanal an`);
});

await pruefe('Gelesen-Meldungen dringen nicht in einen fremden Kanal', async () => {
  const gesammelt = wir.sammle((e) => e.t === 'read' && e.channelId === kanal.id, 1500);
  sie.send({ t: 'read', channelId: kanal.id, lastMessageId: geheim.id });
  const treffer = await gesammelt;
  muss(treffer.length === 0, `${treffer.length} Gelesen-Meldungen eines Nichtmitglieds kamen im Kanal an`);
});

/* ── Aufgaben, Termine, Ideen am Kanal ────────────────────────── */

console.log('\nWas aus einem Kanal entsteht, bleibt im Kanal');

/** Eine Weile horchen und sammeln — für „darf gar nicht ankommen". */
const stillGeblieben = async (passt, ausloesen, dauer = 1500) => {
  const gesammelt = sie.sammle(passt, dauer);
  await ausloesen();
  return gesammelt;
};

await pruefe('Eine Aufgabe aus einem privaten Kanal erreicht kein Nichtmitglied', async () => {
  /* Der Rundruf ging an jede offene Verbindung, und `task:list` gab sie ein
     zweites Mal heraus. Seit die Aufgabenerkennung aus Nachrichten Titel
     macht, liegt damit der Inhalt eines privaten Kanals im ganzen Haus. */
  const titel = `Kündigung ${marke} vorbereiten`;
  const gehoert = await stillGeblieben(
    (e) => e.t === 'task:upsert' && e.task?.title === titel,
    () => wir.send({ t: 'task:create', title: titel, channelId: kanal.id }),
  );
  muss(gehoert.length === 0, `der Titel „${titel}" ging per Rundruf an ein Nichtmitglied`);

  const liste = await sie.frage({ t: 'task:list' }, 'task:list');
  const titelInListe = (liste.tasks ?? []).map((t) => t.title);
  muss(!titelInListe.includes(titel), `task:list gab ihn heraus: ${JSON.stringify(titelInListe)}`);
  return `${titelInListe.length} Aufgaben sichtbar, der Titel nicht dabei`;
});

await pruefe('… auch ihr Verlauf nicht', async () => {
  const titel = `Verlauf ${marke}`;
  wir.send({ t: 'task:create', title: titel, channelId: kanal.id, description: `GEHEIM-${marke}` });
  const angelegt = (await wir.warte((e) => e.t === 'task:upsert' && e.task?.title === titel)).task;
  const a = await sie.frage({ t: 'task:history', taskId: angelegt.id }, 'task:history');
  muss(a.t === 'error', `bekam den Verlauf: ${JSON.stringify(a.events ?? []).slice(0, 120)}`);
  return a.code ?? a.message;
});

await pruefe('Ein Termin aus einem privaten Kanal ebenso wenig', async () => {
  const titel = `Krisensitzung ${marke}`;
  const gehoert = await stillGeblieben(
    (e) => e.t === 'event:upsert' && e.event?.title === titel,
    () => wir.send({
      t: 'event:create', title: titel, channelId: kanal.id,
      startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000,
    }),
  );
  muss(gehoert.length === 0, 'der Termin ging per Rundruf an ein Nichtmitglied');

  const liste = await sie.frage(
    { t: 'event:list', from: Date.now() - 86_400_000, to: Date.now() + 30 * 86_400_000 }, 'event:list');
  muss(!(liste.events ?? []).some((e) => e.title === titel), 'event:list gab ihn heraus');
  return `${(liste.events ?? []).length} Termine sichtbar`;
});

await pruefe('Eine Idee aus einem privaten Kanal ebenso wenig', async () => {
  const titel = `Standort schließen ${marke}`;
  const gehoert = await stillGeblieben(
    (e) => e.t === 'idea:upsert' && e.idea?.title === titel,
    () => wir.send({ t: 'idea:create', title: titel, channelId: kanal.id, body: 'nur intern' }),
  );
  muss(gehoert.length === 0, 'die Idee ging per Rundruf an ein Nichtmitglied');

  const liste = await sie.frage({ t: 'idea:list' }, 'idea:list');
  const idee = (liste.ideas ?? []).find((i) => i.title === titel);
  muss(!idee, 'idea:list gab sie heraus');

  // Und auch nicht über den Umweg der Kommentare.
  const meine = (await wir.frage({ t: 'idea:list' }, 'idea:list')).ideas.find((i) => i.title === titel);
  muss(meine, 'die Idee wurde gar nicht angelegt — die Prüfung misst nichts');
  const a = await sie.frage({ t: 'idea:comments', ideaId: meine.id }, 'idea:comments');
  muss(a.t === 'error', 'die Kommentare kamen trotzdem heraus');
  return a.code ?? a.message;
});

await pruefe('Ohne Kanal geht weiterhin alles an alle', async () => {
  /* Die Gegenprobe. Ohne sie wäre dieser ganze Abschnitt auch dann grün,
     wenn der Server gar nichts mehr verteilte — und das Aufgabenbrett wäre
     still leer. */
  const titel = `Teamweit ${marke}`;
  const kommt = sie.warte((e) => e.t === 'task:upsert' && e.task?.title === titel, 6000).catch(() => null);
  wir.send({ t: 'task:create', title: titel });
  muss(await kommt, 'eine Aufgabe ohne Kanal kam beim Team nicht an');

  const liste = await sie.frage({ t: 'task:list' }, 'task:list');
  muss((liste.tasks ?? []).some((t) => t.title === titel), 'task:list zeigt sie nicht');
  return 'kommt an und steht in der Liste';
});

await pruefe('Zieht eine Aufgabe in einen privaten Kanal, verschwindet sie beim Rest', async () => {
  /* Der Client hält sein Brett als Zuordnung und räumt einen Eintrag erst auf
     ein `task:removed` hin weg. Ohne diese Meldung stünde die Aufgabe dort
     weiter — bei Leuten, die sie gerade verloren haben. */
  const titel = `Wandert ${marke}`;
  const kommt = sie.warte((e) => e.t === 'task:upsert' && e.task?.title === titel, 6000).catch(() => null);
  wir.send({ t: 'task:create', title: titel });
  const angelegt = await kommt;
  muss(angelegt, 'die Aufgabe kam gar nicht erst an');

  const weg = sie.warte((e) => e.t === 'task:removed' && e.taskId === angelegt.task.id, 6000).catch(() => null);
  wir.send({ t: 'task:update', taskId: angelegt.task.id, patch: { channelId: kanal.id } });
  muss(await weg, 'sie blieb auf dem Brett des Nichtmitglieds stehen');
  return 'task:removed kam an';
});

await pruefe('Wer den Kanal verliert, verliert auch, was daraus entstand', async () => {
  const eigenerKanal = `abschied-${marke}`;
  wir.send({ t: 'channel:create', kind: 'private', name: eigenerKanal });
  const k = (await wir.warte((e) => e.t === 'channel:upsert' && e.channel?.name === eigenerKanal)).channel;
  wir.send({ t: 'channel:members', channelId: k.id, add: [fremdeId] });
  await wir.warte((e) => e.t === 'channel:upsert' && e.channel?.id === k.id && e.channel.memberIds.includes(fremdeId));

  const titel = `Bleibt drin ${marke}`;
  const kommt = sie.warte((e) => e.t === 'task:upsert' && e.task?.title === titel, 6000).catch(() => null);
  wir.send({ t: 'task:create', title: titel, channelId: k.id });
  const angelegt = await kommt;
  muss(angelegt, 'das Mitglied bekam die Aufgabe seines eigenen Kanals nicht');

  const weg = sie.warte((e) => e.t === 'task:removed' && e.taskId === angelegt.task.id, 6000).catch(() => null);
  wir.send({ t: 'channel:members', channelId: k.id, remove: [fremdeId] });
  muss(await weg, 'nach dem Entfernen blieb die Aufgabe auf ihrem Brett stehen');
  return 'Brett wird mit aufgeräumt';
});

/* ── Vertrauliche Kanäle ──────────────────────────────────────── */

console.log('\nVertrauliche Kanäle');

/** Ein Paket, das nur Platz hält — der Server sieht ohnehin nur Zeichen. */
const platzhalterPaket = { alg: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', daten: 'BBBBBBBBBBBB' };

async function vertraulicherKanalZuZweit(name) {
  wir.send({ t: 'channel:create', kind: 'private', name });
  const k = (await wir.warte((e) => e.t === 'channel:upsert' && e.channel?.name === name)).channel;
  wir.send({ t: 'channel:members', channelId: k.id, add: [fremdeId] });
  await wir.warte((e) => e.t === 'channel:upsert' && e.channel?.id === k.id && e.channel.memberIds.includes(fremdeId));
  wir.send({
    t: 'vertraulich:einschalten', channelId: k.id,
    pakete: [{ userId: meineId, paket: platzhalterPaket }, { userId: fremdeId, paket: platzhalterPaket }],
  });
  await wir.warte((e) => e.t === 'channel:upsert' && e.channel?.id === k.id && e.channel.vertraulich);
  return k;
}

await pruefe('Ausblenden verlangt denselben Schlüsselwechsel wie Verlassen', async () => {
  /* Ausblenden und Verlassen tun bei einem gewöhnlichen Kanal dasselbe: die
     Mitgliedschaft fällt weg. Nur beim Verlassen wurde der Schlüssel
     gewechselt — wer stattdessen ausblendete, ging mit dem Kanalschlüssel in
     der Hand hinaus, und im Kanal merkte es niemand. */
  const k = await vertraulicherKanalZuZweit(`ausblenden-${marke}`);
  const wechsel = wir.warte((e) => e.t === 'vertraulich:wechsel-noetig' && e.channelId === k.id, 5000)
    .catch(() => null);
  sie.send({ t: 'channel:hide', channelId: k.id });
  await sie.warte((e) => e.t === 'channel:removed' && e.channelId === k.id);
  muss(await wechsel, 'kein Schlüsselwechsel verlangt — der Kanalschlüssel ging ungewechselt mit hinaus');
});

await pruefe('Verlassen verlangt ihn weiterhin', async () => {
  const k = await vertraulicherKanalZuZweit(`verlassen-${marke}`);
  const wechsel = wir.warte((e) => e.t === 'vertraulich:wechsel-noetig' && e.channelId === k.id, 5000)
    .catch(() => null);
  sie.send({ t: 'channel:leave', channelId: k.id });
  await sie.warte((e) => e.t === 'channel:removed' && e.channelId === k.id);
  muss(await wechsel, 'kein Schlüsselwechsel verlangt');
});

await pruefe('Eine zu lange verschlüsselte Nachricht nennt ihre eigene Grenze', async () => {
  /* Für Chiffrat gilt eine höhere Grenze, weil Base64 ein Drittel kostet.
     Der Text daneben nannte trotzdem die Grenze für offenen Text — in einem
     vertraulichen Kanal las man also, man dürfe 12.000 Zeichen schreiben,
     während bei 20.000 abgewiesen wurde. */
  const k = await vertraulicherKanalZuZweit(`grenze-${marke}`);
  const a = await wir.frage(
    { t: 'message:send', clientId: 'g', channelId: k.id, text: `e1:1:AAAA:${'B'.repeat(20_001)}` },
    'message:new', (e) => e.clientId === 'g');
  muss(a.t === 'error', `bekam ${a.t} statt einer Abweisung`);
  muss(/20/.test(a.message), `der Text nennt die falsche Grenze: „${a.message}"`);
  return a.message;
});

/* ── Grenzen ──────────────────────────────────────────────────── */

console.log('\nGrenzen beim Ändern');

await pruefe('Eine Aufgabenbeschreibung bleibt auch beim Ändern begrenzt', async () => {
  sie.send({ t: 'task:create', title: `Aufgabe ${marke}`, description: 'kurz' });
  const tk = (await sie.warte((e) => e.t === 'task:upsert' && e.task?.title === `Aufgabe ${marke}`)).task;
  sie.send({ t: 'task:update', taskId: tk.id, patch: { description: 'Y'.repeat(50_000) } });
  const nach = (await sie.warte((e) => e.t === 'task:upsert' && e.task?.id === tk.id
    && (e.task.description ?? '').length !== 4)).task;
  muss(nach.description.length <= 8000,
    `${nach.description.length} Zeichen gespeichert — beim Anlegen sind 8000 die Grenze`);
  return `${nach.description.length} Zeichen`;
});

await pruefe('Ein Termin bleibt auch beim Ändern begrenzt', async () => {
  sie.send({
    t: 'event:create', title: `Termin ${marke}`,
    startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000,
    description: 'kurz', location: 'hier',
  });
  const ev = (await sie.warte((e) => e.t === 'event:upsert' && e.event?.title === `Termin ${marke}`)).event;
  sie.send({
    t: 'event:update', eventId: ev.id,
    patch: { description: 'Y'.repeat(50_000), title: 'T'.repeat(1000), location: 'O'.repeat(1000) },
  });
  const nach = (await sie.warte((e) => e.t === 'event:upsert' && e.event?.id === ev.id
    && (e.event.description ?? '').length !== 4)).event;
  muss(nach.description.length <= 8000, `Beschreibung: ${nach.description.length} statt höchstens 8000`);
  muss(nach.title.length <= 300, `Titel: ${nach.title.length} statt höchstens 300`);
  muss(nach.location.length <= 300, `Ort: ${nach.location.length} statt höchstens 300`);
  return `${nach.description.length}/${nach.title.length}/${nach.location.length}`;
});

await pruefe('Eine erfundene Terminantwort wird nicht gespeichert', async () => {
  sie.send({
    t: 'event:create', title: `Antwort ${marke}`,
    startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000,
  });
  const ev = (await sie.warte((e) => e.t === 'event:upsert' && e.event?.title === `Antwort ${marke}`)).event;
  sie.send({ t: 'event:respond', eventId: ev.id, response: 'voellig-erfunden' });
  const nach = await sie.warte((e) => e.t === 'event:upsert' && e.event?.id === ev.id, 4000).catch(() => null);
  const antworten = nach ? nach.event.attendees.map((t) => t.response) : [];
  muss(!antworten.includes('voellig-erfunden'),
    `„voellig-erfunden" steht jetzt in der Teilnehmerliste: ${JSON.stringify(antworten)}`);
  return antworten.join(', ') || 'abgewiesen';
});

await pruefe('Der Text einer Idee bleibt begrenzt', async () => {
  sie.send({ t: 'idea:create', title: `Idee ${marke}`, body: 'Y'.repeat(50_000) });
  const idee = (await sie.warte((e) => e.t === 'idea:upsert' && e.idea?.title === `Idee ${marke}`)).idea;
  muss((idee.body ?? '').length <= 8000, `${idee.body.length} Zeichen gespeichert`);
  return `${(idee.body ?? '').length} Zeichen`;
});

await pruefe('Einstellungen nehmen keine erfundenen Werte an', async () => {
  /* Der Anzeigename ist bei der Ersteinrichtung auf 80 Zeichen begrenzt.
     Über diesen Weg ging er ohne jede Grenze durch — und von hier aus an
     jede offene Verbindung im Haus. */
  const a = await sie.frage({
    t: 'prefs:update',
    patch: { displayName: 'X'.repeat(60_000), language: 'kein-sprachcode', theme: 'lila', notifyOn: 'irgendwas' },
  }, 'self:updated');
  muss(a.t === 'self:updated', `bekam ${a.t}: ${a.message ?? ''}`);
  const mich = (await (await fetch(`${S}/api/me`, { headers: fremderKopf })).json()).user;
  muss(mich.displayName.length <= 80, `Anzeigename: ${mich.displayName.length} Zeichen`);
  muss(mich.language !== 'kein-sprachcode', `Sprache steht auf „${mich.language}"`);
  muss(mich.theme !== 'lila', `Aussehen steht auf „${mich.theme}"`);
  return `${mich.displayName.length} Zeichen, Sprache ${mich.language}, Aussehen ${mich.theme}`;
});

await pruefe('… und lassen die richtigen weiterhin durch', async () => {
  /* Die Gegenprobe, und sie gehört dazu: eine Prüfung, die nur das Abweisen
     misst, wäre auch dann grün, wenn der Server gar nichts mehr annähme —
     und die Einstellungen wären still kaputt. */
  const a = await sie.frage({
    t: 'prefs:update',
    patch: {
      displayName: `Fremde ${marke}`, language: 'fr', uiLanguage: 'ja', theme: 'light',
      density: 'compact', notifyOn: 'mentions', notificationSound: 'chime',
      translationSpeed: 'accurate', timezone: 'Europe/Paris',
      quietHoursStart: 1320, quietHoursEnd: 420, autoTranslate: false,
      composeTargetPreview: false, title: 'Werkstudentin',
    },
  }, 'self:updated');
  muss(a.t === 'self:updated', `bekam ${a.t}: ${a.message ?? ''}`);
  const mich = (await (await fetch(`${S}/api/me`, { headers: fremderKopf })).json()).user;
  const soll = {
    language: 'fr', uiLanguage: 'ja', theme: 'light', density: 'compact',
    notifyOn: 'mentions', notificationSound: 'chime', translationSpeed: 'accurate',
    timezone: 'Europe/Paris', quietHoursStart: 1320, quietHoursEnd: 420,
    autoTranslate: false, composeTargetPreview: false, title: 'Werkstudentin',
  };
  const schief = Object.entries(soll).filter(([k, v]) => mich[k] !== v)
    .map(([k, v]) => `${k}: ${JSON.stringify(mich[k])} statt ${JSON.stringify(v)}`);
  muss(schief.length === 0, schief.join('; '));
  // Und das Zurücksetzen der Ruhezeit muss ebenfalls ankommen.
  await sie.frage({ t: 'prefs:update', patch: { quietHoursStart: null, quietHoursEnd: null } }, 'self:updated');
  const danach = (await (await fetch(`${S}/api/me`, { headers: fremderKopf })).json()).user;
  muss(danach.quietHoursStart === null && danach.quietHoursEnd === null,
    `Ruhezeit ließ sich nicht aufheben: ${danach.quietHoursStart}/${danach.quietHoursEnd}`);
  return `${Object.keys(soll).length} Felder übernommen`;
});

await pruefe('Reaktionen an einer Nachricht sind der Zahl nach begrenzt', async () => {
  wir.send({ t: 'message:send', clientId: 'r', channelId: kanal.id, text: `Reaktionen ${marke}` });
  const ziel = (await wir.warte((e) => e.t === 'message:new' && e.message?.text?.includes(`Reaktionen ${marke}`))).message;
  for (let i = 0; i < 80; i += 1) wir.send({ t: 'message:react', messageId: ziel.id, emoji: `e${i}` });
  await new Promise((f) => setTimeout(f, 1500));
  const a = await wir.frage({ t: 'channel:open', channelId: kanal.id, limit: 20 }, 'channel:history',
    (e) => e.channelId === kanal.id);
  const arten = a.messages.find((m) => m.id === ziel.id)?.reactions.length ?? 0;
  muss(arten <= 50, `${arten} verschiedene Reaktionen an einer Nachricht`);
  return `${arten} Arten`;
});

await pruefe('Ein Teil-Upload bleibt bei der angemeldeten Größe', async () => {
  /* Fastify erzwingt seine bodyLimit nicht, wenn ein eigener Parser den Strom
     durchreicht — und für application/octet-stream gibt es genau so einen.
     Der Teil landete also ungeprüft auf der Platte, und die Prüfung beim
     Zusammenlegen kam zu spät: da lag er schon da. Bei zweitausend erlaubten
     Teilen ist das die Speicherkarte des Pi. */
  const start = await (await fetch(`${S}/api/uploads/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...meinKopf },
    body: JSON.stringify({ name: 'klein.bin', mime: 'application/octet-stream', size: 1024, parts: 2 }),
  })).json();
  muss(start.uploadId, `kein Upload angemeldet: ${JSON.stringify(start)}`);

  const zuGross = 40 * 1024 * 1024;
  const antwort = await fetch(`${S}/api/uploads/${start.uploadId}/part/0`, {
    method: 'PUT',
    headers: { ...meinKopf, 'content-type': 'application/octet-stream' },
    body: new Uint8Array(zuGross),
  });
  muss(antwort.status !== 200,
    `${zuGross / 1024 / 1024} MB wurden für einen Upload von 1024 Byte angenommen`);

  const liegt = readdirSync(`${probe.datenordner}/uploads`)
    .filter((n) => n.startsWith(`${start.uploadId}.teil`))
    .reduce((summe, n) => summe + statSync(`${probe.datenordner}/uploads/${n}`).size, 0);
  muss(liegt <= 1024, `${liegt} Byte liegen trotzdem auf der Platte`);
  return `${antwort.status}, ${liegt} Byte auf der Platte`;
});

await pruefe('Eine negative Suchgrenze holt nicht alles und nicht nichts', async () => {
  /* Math.min(-1, 100) ist -1, und LIMIT -2 heißt in SQLite „ohne Grenze".
     Der Server holte also jede passende Zeile aus dem Index, baute sie
     vollständig auf — und gab dann genau einen Treffer heraus, weil die
     Abbruchbedingung sofort zutraf. */
  for (let i = 0; i < 5; i += 1) {
    wir.send({ t: 'message:send', clientId: `s${i}`, channelId: kanal.id, text: `Suchwort${marke} Nummer ${i}` });
    await wir.warte((e) => e.t === 'message:new' && e.message?.text?.includes(`Suchwort${marke}`));
  }
  const antwort = await (await fetch(`${S}/api/search?q=Suchwort${marke}&limit=-1`, { headers: meinKopf })).json();
  muss((antwort.hits ?? []).length >= 5,
    `nur ${(antwort.hits ?? []).length} Treffer — die Grenze wurde nicht auf den Vorgabewert zurückgeholt`);
  return `${antwort.hits.length} Treffer`;
});

/* ── Hintergrundläufe ─────────────────────────────────────────── */

console.log('\nWas die Zeitgeber hinterlassen');

await pruefe('Eine Erinnerung überlebt es, wenn niemand verbunden ist', async () => {
  /* Der Zeitgeber hakte jede fällige Erinnerung ab und schickte sie danach
     los. War die Person gerade nicht verbunden, ging sie ins Leere — und
     stand trotzdem auf erledigt. „Erinnere mich morgen um neun" verschwand
     also genau dann, wenn der Rechner um neun noch zu war. */
  /* Ein eigenes Konto: die beiden oben halten ihre Verbindung offen, und
     „offline" muss hier wirklich offline heißen. Genau daran ist diese
     Prüfung beim ersten Versuch grün geworden, obwohl nichts behoben war. */
  const abwesend = await zusatzkonto(`abwesend${marke}`);
  const eigene = sitzung(abwesend.token);
  const bereit = await eigene.bereit;
  const offenerKanal = (bereit.channels ?? []).find((k) => k.kind === 'public') ?? (bereit.channels ?? [])[0];
  muss(offenerKanal, 'kein Kanal, an den sich etwas hängen ließe');

  eigene.send({ t: 'reminder:create', channelId: offenerKanal.id, note: 'nicht verlieren', remindAt: Date.now() + 6000 });
  const erzeugt = (await eigene.warte((e) => e.t === 'reminder:upsert')).reminder;
  muss(erzeugt?.id, 'keine Erinnerung angelegt');

  // Jetzt weg sein, während sie fällig wird.
  eigene.zu();
  await new Promise((f) => setTimeout(f, 25_000));

  const zurueck = sitzung(abwesend.token);
  const wieder = await zurueck.bereit;
  const offen = (wieder.reminders ?? []).map((r) => r.id);
  zurueck.zu();
  muss(offen.includes(erzeugt.id),
    'sie war beim Wiederkommen abgehakt — zugestellt hat sie niemand bekommen');
  return 'wartet auf die Rückkehr';
});

/* ── Zustand in der Datenbank ─────────────────────────────────── */

console.log('\nWas hinterher in der Datenbank steht');

await pruefe('Ein gelöschter Kanal lässt nichts im Volltextindex zurück', async () => {
  wir.send({ t: 'channel:create', kind: 'private', name: `indexrest-${marke}` });
  const k = (await wir.warte((e) => e.t === 'channel:upsert' && e.channel?.name === `indexrest-${marke}`)).channel;
  wir.send({ t: 'message:send', clientId: 'i', channelId: k.id, text: `Indexrest ${marke} soll verschwinden` });
  await wir.warte((e) => e.t === 'message:new' && e.message?.channelId === k.id);
  await new Promise((f) => setTimeout(f, 300));

  const vorher = mitDatenbank((db) =>
    db.prepare('SELECT COUNT(*) AS n FROM message_fts WHERE channel_id = ?').get(k.id).n);
  muss(vorher > 0, 'die Nachricht stand gar nicht erst im Index — die Prüfung misst nichts');

  wir.send({ t: 'channel:delete', channelId: k.id });
  await wir.warte((e) => e.t === 'channel:removed' && e.channelId === k.id);
  await new Promise((f) => setTimeout(f, 400));

  const nachher = mitDatenbank((db) =>
    db.prepare('SELECT COUNT(*) AS n FROM message_fts WHERE channel_id = ?').get(k.id).n);
  muss(nachher === 0, `${nachher} Indexzeilen ohne Nachricht dahinter (vorher ${vorher})`);
  return `${vorher} → 0`;
});

await pruefe('Die Ungelesen-Zählung sucht, statt den Kanal zu durchlaufen', async () => {
  /* Diese Abfrage läuft zweimal je Empfänger und Nachricht. Ohne passenden
     Index las SQLite jede Zeile des Kanals; gemessen an 200.000 Zeilen waren
     das 19,8 ms je Aufruf statt 0,008 ms. Auf dem Pi ist der Unterschied
     größer, und er wächst mit jedem Gespräch. */
  const plan = mitDatenbank((db) => db.prepare(
    `EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM messages
     WHERE channel_id = ? AND deleted_at IS NULL AND user_id <> ? AND id > ?`,
  ).all('ch_x', 'u_x', 'm_x').map((r) => r.detail).join(' | '));
  muss(/id>\?/.test(plan.replace(/\s+/g, '')),
    `der Plan nutzt die Grenze nicht als Suchschlüssel: ${plan}`);
  return plan;
});

await pruefe('Ein Serverpaket wandert nicht am Stück in den Speicher', async () => {
  /* publish() las die hochgeladene Datei mit readFileSync ein, um ihre
     Prüfsumme zu bilden. Für ein App-Paket sind das mehrere hundert Megabyte
     auf einmal — auf einem Raspberry Pi ist das kein Ausreißer im Diagramm,
     sondern das Ende des Prozesses. */
  const pid = serverPid();
  muss(pid, 'die Kennung des Probeservers ließ sich nicht bestimmen — nicht gemessen');
  const vorher = rssMb(pid);

  /* Achtundvierzig Megabyte, nicht die sechshundert, die die Route zuließe:
     die Prüfung soll die Platte nicht füllen, auf der sie läuft. Sie misst
     ohnehin nicht die Größe, sondern die Unabhängigkeit davon — die alte
     Fassung holte die Datei am Stück, ihr Bedarf war also die Dateigröße.
     Alles deutlich darunter kann nur streckenweise gelesen worden sein. */
  const mb = 48;
  const form = new FormData();
  form.append('version', '99.0.0');
  form.append('file', new Blob([new Uint8Array(mb * 1024 * 1024)]), 'stellium-probe.bin');
  const antwort = await fetch(`${S}/api/releases/linux`, { method: 'POST', headers: meinKopf, body: form });
  muss(antwort.status === 200, `Hochladen scheiterte mit ${antwort.status}`);

  const nachher = rssMb(pid);
  const zuwachs = nachher - vorher;
  /* Die Grenze ist die Dateigröße selbst, und sie sitzt in der Mitte
     zwischen zwei gemessenen Werten: mit `readFileSync` wuchs der Speicher um
     74 MB, mit der abschnittsweisen Prüfsumme um 25 MB — beides bei 48 MB
     Datei. Der Rest ist der Aufwand, den das Entgegennehmen ohnehin kostet. */
  muss(zuwachs < mb,
    `der Speicher wuchs um ${Math.round(zuwachs)} MB bei einer Datei von ${mb} MB`);
  return `${Math.round(vorher)} → ${Math.round(nachher)} MB bei ${mb} MB Datei`;
});

/** Die Datenbank des Probeservers lesen — ohne sie offen liegen zu lassen. */
function mitDatenbank(fn) {
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

/** Welcher Prozess auf dem Port des Probeservers horcht. */
function serverPid() {
  const port = new URL(S).port;
  try {
    const aus = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    return Number(aus.trim().split('\n')[0]) || null;
  } catch { return null; }
}

function rssMb(pid) {
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
}

wir.zu();
sie.zu();
await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
