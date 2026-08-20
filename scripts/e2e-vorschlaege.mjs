/**
 * Der Eingang für KI-Vorschläge — geprüft an der Buchhaltung selbst.
 *
 * WARUM NICHT ÜBER DIE OBERFLÄCHE
 *
 * Weil die Frage hier nicht ist, ob ein Knopf funktioniert, sondern ob die
 * Zusagen halten: dass nichts doppelt kommt, dass ein Nein ein Nein bleibt,
 * dass in einem vertraulichen Kanal nichts entsteht. Das sind Aussagen über
 * den Dienst, und die prüft man am Dienst. Ein Lauf durch den Browser käme
 * obendrein nur bis zum Modell — und eine Prüfung, die von der Tagesform
 * eines Sprachmodells abhängt, prüft nichts.
 *
 * Deshalb wird `kandidatenEintragen()` mit erfundenen Kandidaten gefüttert.
 * Was das Modell liefert, ist hier egal; was der Dienst daraus macht, nicht.
 *
 * WARUM `vertraulich` HIER PER SQL GESETZT WIRD
 *
 * Der echte Weg — Schlüssel aushandeln, für jedes Mitglied verpacken,
 * `vertraulich:einschalten` — steht vollständig in e2e-vertraulich.mjs, und
 * die Prüfung „aus einem echten vertraulichen Kanal entsteht kein Vorschlag"
 * gehört dorthin und steht dort auch. Hier geht es um die Sperren im Dienst,
 * und für die zählt nur, was `istVertraulich()` sagt.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

/* Ohne Masterpasswort legt der Server alles im Klartext ab — dann ließe sich
   nicht prüfen, ob der Titel eines Vorschlags verschlüsselt in der Datei
   steht. Vor dem Start setzen, damit Server und Prüfung denselben nehmen. */
process.env.STELLIUM_MASTER_PASSPHRASE ||= 'Probe-Vorschlaege-4711';

const probe = await probeserver();
const S = probe.S;
const marke = Date.now().toString(36).slice(-5);
const GEHEIM = `Quartalsbonus-${marke}`;

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

const ich = await anmelden(probe.login, probe.passwort);
if (!ich.token) { console.error('Anmeldung fehlgeschlagen.'); process.exit(1); }
const meinKopf = { 'content-type': 'application/json', authorization: `Bearer ${ich.token}` };

/** Ein zweites Konto — für „wem gehört der Vorschlag". */
async function kontoAnlegen(name) {
  const neu = await (await fetch(`${S}/api/admin/users`, {
    method: 'POST', headers: meinKopf,
    body: JSON.stringify({ displayName: `${name} ${marke}`, handle: `${name.toLowerCase()}${marke}`, role: 'member', language: 'de' }),
  })).json();
  const erst = await anmelden(neu.credential.handle, neu.credential.oneTimePassword);
  const pw = `Probe-${name}-${marke}`;
  await fetch(`${S}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${erst.token}` },
    body: JSON.stringify({ newPassword: pw }),
  });
  const fertig = await anmelden(neu.credential.handle, pw);
  return { token: fertig.token, handle: neu.credential.handle };
}

const kollege = await kontoAnlegen('Kollege');
const fremde = await kontoAnlegen('Fremde');

/* ── Ein Draht, der offen bleibt ──────────────────────────────── */

class Draht {
  constructor(token) { this.token = token; this.ereignisse = []; }

  async auf() {
    this.ws = new WebSocket(`${S.replace(/^http/, 'ws')}/ws`);
    this.ws.onmessage = (e) => this.ereignisse.push(JSON.parse(e.data));
    await new Promise((f, s) => {
      const frist = setTimeout(() => s(new Error('WebSocket kam nicht zustande')), 10000);
      this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'auth', token: this.token, protocol: 1 }));
      const sehen = setInterval(() => {
        const bereit = this.ereignisse.find((e) => e.t === 'ready');
        if (!bereit) return;
        clearInterval(sehen); clearTimeout(frist);
        this.ich = bereit.self?.id ?? bereit.user?.id ?? null;
        f();
      }, 30);
    });
    return this;
  }

  senden(ev) { this.ws.send(JSON.stringify(ev)); }

  warteAuf(passt, ms = 8000) {
    return new Promise((f, s) => {
      const frist = setTimeout(() => { clearInterval(u); s(new Error('Zeitüberschreitung')); }, ms);
      const u = setInterval(() => {
        const treffer = this.ereignisse.find(passt);
        if (!treffer) return;
        clearInterval(u); clearTimeout(frist); f(treffer);
      }, 30);
    });
  }

  zu() { try { this.ws.close(); } catch { /* schon zu */ } }
}

const chefin = await new Draht(ich.token).auf();
const zweiter = await new Draht(kollege.token).auf();

/** Ein öffentlicher Kanal mit ein paar Nachrichten darin. */
async function kanalMitVerlauf(name, texte) {
  chefin.senden({ t: 'channel:create', kind: 'public', name, memberIds: [] });
  const ev = await chefin.warteAuf((e) => e.t === 'channel:upsert' && e.channel.name === name);
  const id = ev.channel.id;
  // Der Kollege soll auch drin sein — sonst kann er nichts zugeteilt bekommen.
  zweiter.senden({ t: 'channel:join', channelId: id });
  await new Promise((f) => setTimeout(f, 300));

  const ids = [];
  for (const [i, text] of texte.entries()) {
    const wer = i % 2 === 0 ? chefin : zweiter;
    wer.senden({ t: 'message:send', clientId: `c${i}${marke}`, channelId: id, text });
    const neu = await wer.warteAuf((e) => e.t === 'message:new' && e.message.text === text);
    ids.push(neu.message.id);
  }
  return { id, nachrichten: ids };
}

const offen = await kanalMitVerlauf(`vorschlag-${marke}`, [
  `Wir sollten das Angebot für Meier bis Freitag rausschicken (${marke}).`,
  `Und die Preisliste braucht ein Update (${marke}).`,
]);
const heikel = await kanalMitVerlauf(`heikel-${marke}`, [
  `Der ${GEHEIM} wird neu gerechnet.`,
]);

/* Erst jetzt den Dienst laden: DATA_DIR muss stehen, bevor config.ts gelesen
   wird. Der Server läuft weiter — SQLite arbeitet hier im WAL-Modus, mehrere
   Leser und ein Schreiber stören einander nicht. */
process.env.DATA_DIR = probe.datenordner;
const V = await import('../packages/server/dist/services/vorschlaege.js');
const { db } = await import('../packages/server/dist/db/index.js');
const fenster = await import('../packages/server/dist/translation/fenster.js');

/** Kennungen der beiden Konten aus der Datenbank — der Draht liefert sie nicht immer mit. */
const kontoIds = (() => {
  const roh = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeilen = roh.prepare('SELECT id, display_name FROM users').all();
  roh.close();
  const finde = (teil) => zeilen.find((z) => String(z.display_name).includes(teil))?.id;
  return {
    chefin: finde('Probe-Leitung'),
    kollege: finde(`Kollege ${marke}`),
    fremde: finde(`Fremde ${marke}`),
  };
})();

const kandidat = (ueber) => ({
  art: 'aufgabe', titel: `Angebot an Meier schicken ${ueber}`,
  quelleMessageId: offen.nachrichten[0], genanntUserId: null, faelligAm: null,
});

console.log('\nAus einem Kandidaten wird ein Vorschlag');

let ersterId = null;

await pruefe('Ein Kandidat wird zu einem offenen Vorschlag', async () => {
  const bericht = V.kandidatenEintragen(offen.id, [kandidat('A')]);
  muss(bericht.angelegt.length === 1, `${bericht.angelegt.length} angelegt statt einem (${bericht.grund ?? '—'})`);
  const v = bericht.angelegt[0];
  ersterId = v.id;
  muss(v.zustand === 'offen', `Zustand ${v.zustand}`);
  muss(v.channelId === offen.id, 'falscher Kanal');
  return v.titel;
});

await pruefe('Die Herkunft steht dabei — Nachricht und Wortlaut', async () => {
  const v = V.getVorschlag(ersterId);
  muss(v.quelleMessageId === offen.nachrichten[0], 'die Herkunftsnachricht fehlt');
  muss(v.quelleText && v.quelleText.includes('Meier'), `Wortlaut fehlt: ${v.quelleText}`);
  return v.quelleText.slice(0, 40);
});

await pruefe('Ohne genannte Person gehört er dem, der die Nachricht schrieb', async () => {
  const v = V.getVorschlag(ersterId);
  muss(v.fuerUserId === kontoIds.chefin,
    `liegt bei ${v.fuerUserId}, nicht beim Schreiber ${kontoIds.chefin}`);
  muss(v.genanntUserId === null, 'genannt, obwohl niemand genannt wurde');
  return 'beim Schreiber';
});

await pruefe('Nennt die KI jemanden, gehört er dieser Person', async () => {
  const bericht = V.kandidatenEintragen(offen.id, [{
    ...kandidat('B'), genanntUserId: kontoIds.kollege,
  }]);
  muss(bericht.angelegt.length === 1, `${bericht.angelegt.length} angelegt (${bericht.grund ?? '—'})`);
  muss(bericht.angelegt[0].fuerUserId === kontoIds.kollege, 'liegt nicht beim Genannten');
  return 'beim Genannten';
});

await pruefe('Er steht im Eingang genau einer Person', async () => {
  const meine = V.listeFuer(kontoIds.chefin).map((v) => v.id);
  const seine = V.listeFuer(kontoIds.kollege).map((v) => v.id);
  muss(meine.includes(ersterId), 'fehlt im eigenen Eingang');
  muss(!seine.includes(ersterId), 'liegt auch bei jemand anderem');
  muss(!V.listeFuer(kontoIds.fremde).length, 'eine Fremde sieht Vorschläge');
  return `${meine.length} bei mir, ${seine.length} beim Kollegen`;
});

console.log('\nDubletten');

await pruefe('Derselbe Kandidat zweimal ergibt einen Vorschlag', async () => {
  const bericht = V.kandidatenEintragen(offen.id, [kandidat('A')]);
  muss(bericht.angelegt.length === 0, 'ein zweiter ist entstanden');
  muss(bericht.dubletten === 1, `${bericht.dubletten} als Dublette erkannt`);
  return 'abgewiesen';
});

await pruefe('Anders geschrieben, gleich gemeint — auch nur einer', async () => {
  const bericht = V.kandidatenEintragen(offen.id, [{
    ...kandidat('A'), titel: `  ANGEBOT an Meier, schicken!  A ` ,
  }]);
  muss(bericht.angelegt.length === 0, 'Groß-/Kleinschreibung erzeugt einen zweiten');
  return 'abgewiesen';
});

await pruefe('Die Sperre steht in der Datenbank, nicht im Arbeitsspeicher', async () => {
  const roh = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeile = roh.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_vorschlaege_dublette'",
  ).get();
  roh.close();
  muss(zeile, 'der eindeutige Index fehlt — nach einem Neustart käme alles wieder');
  muss(/UNIQUE/i.test(zeile.sql), 'der Index ist nicht eindeutig');
  return 'UNIQUE(channel_id, art, abdruck)';
});

await pruefe('Was schon als offene Aufgabe im Kanal steht, kommt nicht als Vorschlag', async () => {
  const aufgaben = await import('../packages/server/dist/services/tasks.js');
  aufgaben.createTask({
    title: `Preisliste aktualisieren ${marke}`, channelId: offen.id, createdBy: kontoIds.chefin,
  });
  const bericht = V.kandidatenEintragen(offen.id, [{
    art: 'aufgabe', titel: `Preisliste aktualisieren ${marke}`,
    quelleMessageId: offen.nachrichten[1], genanntUserId: null, faelligAm: null,
  }]);
  muss(bericht.angelegt.length === 0, 'die Aufgabe wurde ein zweites Mal vorgeschlagen');
  return 'abgewiesen';
});

console.log('\nEntscheiden');

let ideeVorschlagId = null;

await pruefe('Annehmen legt eine Aufgabe an — mit Kanal und Herkunft', async () => {
  const { aufgabe } = V.annehmen(ersterId, kontoIds.chefin);
  muss(aufgabe, 'keine Aufgabe entstanden');
  muss(aufgabe.channelId === offen.id, 'die Aufgabe kennt ihren Kanal nicht');
  muss(aufgabe.messageId === offen.nachrichten[0], 'die Aufgabe kennt ihre Herkunft nicht');
  muss(!V.listeFuer(kontoIds.chefin).some((v) => v.id === ersterId), 'steht weiter im Eingang');
  return aufgabe.title;
});

await pruefe('Rückgängig nimmt die Aufgabe weg und öffnet den Vorschlag wieder', async () => {
  const aufgaben = await import('../packages/server/dist/services/tasks.js');
  const vorher = V.getVorschlag(ersterId);
  const zurueck = V.zuruecknehmen(ersterId, kontoIds.chefin);
  muss(zurueck.zustand === 'offen', `Zustand ${zurueck.zustand}`);
  muss(!aufgaben.getTask(vorher.ergebnisId), 'die Aufgabe steht noch');
  muss(V.listeFuer(kontoIds.chefin).some((v) => v.id === ersterId), 'fehlt im Eingang');
  return 'wieder offen';
});

await pruefe('Beim Annehmen lassen sich Titel, Zuständigkeit und Frist ändern', async () => {
  const frist = Date.now() + 3 * 86_400_000;
  const { aufgabe } = V.annehmen(ersterId, kontoIds.chefin, {
    titel: `Angebot an Meier — mit Rabatt ${marke}`,
    zustaendigId: kontoIds.kollege,
    faelligAm: frist,
  });
  muss(aufgabe.title.includes('Rabatt'), `Titel blieb "${aufgabe.title}"`);
  muss(aufgabe.assigneeId === kontoIds.kollege, 'die Zuständigkeit wurde nicht übernommen');
  muss(aufgabe.dueAt === frist, 'die Frist wurde nicht übernommen');
  return aufgabe.title;
});

await pruefe('Aus einer Idee wird eine Idee, keine Aufgabe', async () => {
  const bericht = V.kandidatenEintragen(offen.id, [{
    art: 'idee', titel: `Kundenfrühstück einführen ${marke}`,
    quelleMessageId: offen.nachrichten[1], genanntUserId: null, faelligAm: null,
  }]);
  muss(bericht.angelegt.length === 1, `${bericht.angelegt.length} angelegt (${bericht.grund ?? '—'})`);
  ideeVorschlagId = bericht.angelegt[0].id;
  const { idee, aufgabe } = V.annehmen(ideeVorschlagId, kontoIds.kollege);
  muss(idee, 'keine Idee entstanden');
  muss(!aufgabe, 'es entstand zusätzlich eine Aufgabe');
  muss(idee.channelId === offen.id, 'die Idee kennt ihren Kanal nicht');
  return idee.title;
});

await pruefe('Die Art lässt sich beim Annehmen umstellen', async () => {
  const bericht = V.kandidatenEintragen(offen.id, [{
    art: 'aufgabe', titel: `Vielleicht ein Newsletter ${marke}`,
    quelleMessageId: offen.nachrichten[0], genanntUserId: null, faelligAm: null,
  }]);
  const { idee, aufgabe } = V.annehmen(bericht.angelegt[0].id, kontoIds.chefin, { art: 'idee' });
  muss(idee && !aufgabe, 'die Umstellung auf "Idee" wurde übergangen');
  return 'als Idee angenommen';
});

await pruefe('Ein fremder Vorschlag lässt sich nicht annehmen', async () => {
  const bericht = V.kandidatenEintragen(offen.id, [{
    art: 'aufgabe', titel: `Nur für den Kollegen ${marke}`,
    quelleMessageId: offen.nachrichten[0], genanntUserId: kontoIds.kollege, faelligAm: null,
  }]);
  const id = bericht.angelegt[0].id;
  let kennung = null;
  try { V.annehmen(id, kontoIds.chefin); } catch (e) { kennung = e.kennung; }
  muss(kennung === 'fehler.vorschlagFremd', `bekam ${kennung ?? 'gar keine Abweisung'}`);
  return kennung;
});

await pruefe('Ein zweites Mal entscheiden geht nicht', async () => {
  let kennung = null;
  try { V.annehmen(ideeVorschlagId, kontoIds.kollege); } catch (e) { kennung = e.kennung; }
  muss(kennung === 'fehler.vorschlagEntschieden', `bekam ${kennung ?? 'gar keine Abweisung'}`);
  return kennung;
});

console.log('\nEin Nein bleibt ein Nein');

await pruefe('Abgelehnt verschwindet aus dem Eingang', async () => {
  const bericht = V.kandidatenEintragen(offen.id, [{
    art: 'aufgabe', titel: `Kaffeemaschine entkalken ${marke}`,
    quelleMessageId: offen.nachrichten[1], genanntUserId: null, faelligAm: null,
  }]);
  const id = bericht.angelegt[0].id;
  V.ablehnen(id, kontoIds.kollege);
  muss(!V.listeFuer(kontoIds.kollege).some((v) => v.id === id), 'steht weiter im Eingang');
  return 'weg';
});

await pruefe('Derselbe Vorschlag kommt nach dem Ablehnen nicht wieder', async () => {
  const nochmal = V.kandidatenEintragen(offen.id, [{
    art: 'aufgabe', titel: `Kaffeemaschine entkalken ${marke}`,
    quelleMessageId: offen.nachrichten[0], genanntUserId: null, faelligAm: null,
  }]);
  muss(nochmal.angelegt.length === 0, 'der abgelehnte Vorschlag ist wiedergekommen');
  muss(nochmal.dubletten === 1, 'er wurde nicht als bekannt erkannt');
  return 'abgewiesen — auch aus einer anderen Nachricht';
});

await pruefe('Die abgelehnte Zeile bleibt stehen — sie ist das Gedächtnis', async () => {
  const roh = new DatabaseSync(probe.datenbank, { readOnly: true });
  const n = roh.prepare("SELECT COUNT(*) AS n FROM vorschlaege WHERE zustand = 'abgelehnt'").get().n;
  roh.close();
  muss(n >= 1, 'die Ablehnung wurde gelöscht statt gemerkt');
  return `${n} gemerkt`;
});

console.log('\nVertrauliche Kanäle');

/* Der echte Weg über Schlüsselaustausch steht in e2e-vertraulich.mjs. Hier
   zählt allein, was istVertraulich() sagt — das ist der Schalter, an dem
   jede der sechs Sperren im Dienst hängt. */
db.run('UPDATE channels SET vertraulich = 1, schluessel_fassung = 1 WHERE id = ?', heikel.id);

await pruefe('In einem vertraulichen Kanal entsteht kein Vorschlag', async () => {
  const bericht = V.kandidatenEintragen(heikel.id, [{
    art: 'aufgabe', titel: `${GEHEIM} neu rechnen`,
    quelleMessageId: heikel.nachrichten[0], genanntUserId: null, faelligAm: null,
  }]);
  muss(bericht.angelegt.length === 0, `${bericht.angelegt.length} Vorschläge entstanden`);
  muss(bericht.grund === 'vertraulich', `Grund "${bericht.grund}" statt "vertraulich"`);
  muss(V.zaehlenImKanal(heikel.id) === 0, 'in der Tabelle steht doch etwas');
  return bericht.grund;
});

await pruefe('Der Lauf liest dort gar nicht erst', async () => {
  const bericht = await V.laufFuerKanal(heikel.id);
  muss(bericht.grund === 'vertraulich', `Grund "${bericht.grund}" statt "vertraulich"`);
  muss(bericht.angelegt.length === 0, 'es ist etwas entstanden');
  return bericht.grund;
});

await pruefe('Ein vertraulicher Kanal steht nicht auf der Liste der fälligen', async () => {
  muss(!V.faelligeKanaele(Date.now() + 86_400_000).includes(heikel.id),
    'der vertrauliche Kanal wurde zum Lesen ausgewählt');
  return 'nicht ausgewählt';
});

await pruefe('Der Klartext des vertraulichen Kanals steht nirgends in der Tabelle', async () => {
  muss(!V.klartextGefunden(GEHEIM), `"${GEHEIM}" steht in der Vorschlagstabelle`);
  const roh = fs.readFileSync(probe.datenbank);
  const treffer = roh.includes(Buffer.from(GEHEIM, 'utf8'));
  // Die Nachricht selbst liegt verschlüsselt; findet sich der Text trotzdem,
  // hat ihn irgendwer offen abgelegt — und der Vorschlagsdienst ist der
  // jüngste Verdächtige.
  muss(!treffer, 'der Klartext steht in der Datenbankdatei');
  return 'nichts Lesbares';
});

await pruefe('Wird ein Kanal vertraulich, verschwinden seine Vorschläge', async () => {
  const zweiterKanal = await kanalMitVerlauf(`spaeter-${marke}`, [`Noch offen (${marke}).`]);
  V.kandidatenEintragen(zweiterKanal.id, [{
    art: 'aufgabe', titel: `Etwas aus einem offenen Kanal ${marke}`,
    quelleMessageId: zweiterKanal.nachrichten[0], genanntUserId: null, faelligAm: null,
  }]);
  muss(V.zaehlenImKanal(zweiterKanal.id) === 1, 'der Vorschlag entstand gar nicht erst');

  db.run('UPDATE channels SET vertraulich = 1, schluessel_fassung = 1 WHERE id = ?', zweiterKanal.id);
  const weg = V.kanalGeschlossen(zweiterKanal.id);
  muss(weg === 1, `${weg} weggeräumt statt einem`);
  muss(V.zaehlenImKanal(zweiterKanal.id) === 0, 'es steht noch etwas da');
  return 'weggeräumt';
});

await pruefe('Ein Vorschlag aus einem inzwischen vertraulichen Kanal lässt sich nicht annehmen', async () => {
  const dritter = await kanalMitVerlauf(`kippt-${marke}`, [`Wird gleich heikel (${marke}).`]);
  const bericht = V.kandidatenEintragen(dritter.id, [{
    art: 'aufgabe', titel: `Vor dem Umschalten entstanden ${marke}`,
    quelleMessageId: dritter.nachrichten[0], genanntUserId: null, faelligAm: null,
  }]);
  const id = bericht.angelegt[0].id;

  db.run('UPDATE channels SET vertraulich = 1, schluessel_fassung = 1 WHERE id = ?', dritter.id);
  let kennung = null;
  try { V.annehmen(id, kontoIds.chefin); } catch (e) { kennung = e.kennung; }
  muss(kennung === 'fehler.vertraulich', `bekam ${kennung ?? 'gar keine Abweisung'}`);
  muss(V.zaehlenImKanal(dritter.id) === 0, 'der Vorschlag steht noch in der Tabelle');
  return `${kennung} — und weggeräumt`;
});

await pruefe('Die Sperren stehen einzeln und sind alle im Quelltext zu finden', async () => {
  const quelle = fs.readFileSync('packages/server/src/services/vorschlaege.ts', 'utf8');
  muss(V.NIE_IN_VERTRAULICHEN_KANAELEN.length >= 6,
    `nur ${V.NIE_IN_VERTRAULICHEN_KANAELEN.length} Sperren aufgeführt`);
  const treffer = (quelle.match(/istVertraulich\(/g) ?? []).length;
  muss(treffer >= 3, `istVertraulich() steht nur ${treffer}-mal im Dienst`);
  return `${V.NIE_IN_VERTRAULICHEN_KANAELEN.length} benannt, ${treffer} Prüfungen im Code`;
});

console.log('\nWas in der Datenbank steht');

await pruefe('Der Titel eines Vorschlags liegt verschlüsselt in der Datei', async () => {
  const eigen = `Ein sehr eigener Titel ${marke} Zwiebelkuchen`;
  V.kandidatenEintragen(offen.id, [{
    art: 'aufgabe', titel: eigen,
    quelleMessageId: offen.nachrichten[0], genanntUserId: null, faelligAm: null,
  }]);
  const roh = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeile = roh.prepare('SELECT titel, abdruck FROM vorschlaege ORDER BY erstellt_am DESC LIMIT 1').get();
  roh.close();
  muss(String(zeile.titel).startsWith('m1:'), `steht als "${String(zeile.titel).slice(0, 30)}…" da`);
  muss(!String(zeile.abdruck).toLowerCase().includes('zwiebelkuchen'), 'der Abdruck verrät den Titel');
  muss(!fs.readFileSync(probe.datenbank).includes(Buffer.from('Zwiebelkuchen', 'utf8')),
    'ein Wort des Titels steht lesbar in der Datei');
  return `gespeichert als ${String(zeile.titel).slice(0, 3)}…`;
});

console.log('\nDas Kontextfenster');

await pruefe('Die Anweisung passt in das kleinste Fenster', async () => {
  const ki = await import('../packages/server/dist/services/ai.js');
  const probeWerte = ki.budgetProbe({
    sprache: 'de', personen: 'Probe-Leitung = u_1; Kollege = u_2',
    channelName: 'allgemein', fenster: fenster.KLEINSTES_FENSTER,
  });
  muss(probeWerte.budget > 500,
    `nur ${probeWerte.budget} Marken für den Verlauf übrig (Anweisung: ${probeWerte.anweisungMarken})`);
  return `${probeWerte.anweisungMarken} Marken Anweisung, ${probeWerte.budget} für den Verlauf`;
});

await pruefe('Ein langer Verlauf wird auf das Budget zugeschnitten', async () => {
  const zeilen = Array.from({ length: 400 }, (_, i) => `[m_${i}] 09:0${i % 10} Jemand (@x): ${'Ein Satz mit Inhalt. '.repeat(6)}`);
  const roh = fenster.markenSchaetzung(zeilen.join('\n'));
  const budget = fenster.verlaufsBudget({ fenster: fenster.KLEINSTES_FENSTER, fest: 'x'.repeat(300), antwort: 900 });
  const zu = fenster.juengsteZeilen(zeilen, budget);
  const kosten = fenster.markenSchaetzung(zu.zeilen.join('\n'));
  muss(roh > fenster.KLEINSTES_FENSTER, `der Probeverlauf ist mit ${roh} Marken zu klein zum Prüfen`);
  muss(kosten <= budget, `${kosten} Marken bei einem Budget von ${budget}`);
  muss(zu.weggelassen > 0, 'nichts wurde weggelassen, obwohl der Verlauf zu lang ist');
  return `${roh} → ${kosten} Marken, ${zu.weggelassen} Zeilen weggelassen`;
});

console.log('\nÜber den Draht');

await pruefe('vorschlag:list liefert die eigenen Vorschläge', async () => {
  const antwort = chefin.warteAuf((e) => e.t === 'vorschlag:list');
  chefin.senden({ t: 'vorschlag:list' });
  const ev = await Promise.race([
    antwort,
    new Promise((_, aus) => setTimeout(() => aus(new Error('keine Antwort in 5 s')), 5000)),
  ]);
  muss(Array.isArray(ev.vorschlaege), 'die Antwort trägt keine Liste');
  return `${ev.vorschlaege.length} Vorschläge über den Draht`;
});

console.log('\nWer den Kanal verliert, verliert den Vorschlag');

/* Adressat zu sein heißt nicht, dabei zu sein.
   Ein Filter nur in der Liste wäre Theater: man müsste bloß die Kennung
   kennen und den Einzelweg fragen. Deshalb wird hier beides geprüft — die
   Liste und `vorschlag:accept`. */
const privat = await (async () => {
  const name = `privat-${marke}`;
  chefin.senden({ t: 'channel:create', kind: 'private', name, memberIds: [kontoIds.kollege] });
  const ev = await chefin.warteAuf((e) => e.t === 'channel:upsert' && e.channel.name === name);
  const id = ev.channel.id;
  chefin.senden({ t: 'message:send', clientId: `p${marke}`, channelId: id, text: `Interner Punkt ${marke}.` });
  const neu = await chefin.warteAuf((e) => e.t === 'message:new' && e.message.channelId === id);
  return { id, nachricht: neu.message.id };
})();

let privatVorschlagId = null;

await pruefe('Im privaten Kanal entsteht ein Vorschlag für das Mitglied', async () => {
  const bericht = V.kandidatenEintragen(privat.id, [{
    art: 'aufgabe', titel: `Internen Punkt klären ${marke}`,
    quelleMessageId: privat.nachricht, genanntUserId: kontoIds.kollege, faelligAm: null,
  }]);
  muss(bericht.angelegt.length === 1, `${bericht.angelegt.length} angelegt (${bericht.grund ?? '—'})`);
  privatVorschlagId = bericht.angelegt[0].id;
  const seine = V.listeFuer(kontoIds.kollege);
  muss(seine.some((v) => v.id === privatVorschlagId), 'steht nicht in seinem Eingang');
  return `Vorschlag ${privatVorschlagId.slice(0, 8)} liegt bei ihm`;
});

await pruefe('Nach dem Verlassen ist er aus seinem Eingang verschwunden', async () => {
  const weg = zweiter.warteAuf((e) => e.t === 'vorschlag:removed' && e.vorschlagId === privatVorschlagId);
  zweiter.senden({ t: 'channel:leave', channelId: privat.id });
  await weg;
  const seine = V.listeFuer(kontoIds.kollege);
  muss(!seine.some((v) => v.id === privatVorschlagId), 'steht immer noch in seinem Eingang');
  return 'die Liste zeigt ihn nicht mehr, und der Client hat es erfahren';
});

await pruefe('Und der Einzelweg gibt ihn auch nicht mehr her', async () => {
  /* Die eigentliche Prüfung: die Kennung ist bekannt, der Vorschlag gehört
     ihm weiterhin laut fuer_user_id — trotzdem darf er ihn nicht annehmen.
     Sonst entstünde eine Aufgabe, deren Titel aus einer Nachricht stammt,
     die er nicht mehr lesen darf. */
  const requestId = `r-${marke}-1`;
  const absage = zweiter.warteAuf((e) => e.t === 'error' && e.requestId === requestId);
  zweiter.senden({ t: 'vorschlag:accept', requestId, vorschlagId: privatVorschlagId });
  const ev = await absage;
  muss(ev.code === 'fehler.vorschlagWeg', `abgewiesen mit ${ev.code}`);
  const danach = V.getVorschlag(privatVorschlagId);
  muss(danach.zustand === 'offen', `Zustand ist ${danach.zustand} — es wurde doch etwas angenommen`);
  muss(!danach.ergebnisId, 'es ist eine Aufgabe daraus entstanden');
  return `abgewiesen mit ${ev.code}, nichts entstanden`;
});

await pruefe('Ablehnen ist ihm ebenso verwehrt', async () => {
  const requestId = `r-${marke}-2`;
  const absage = zweiter.warteAuf((e) => e.t === 'error' && e.requestId === requestId);
  zweiter.senden({ t: 'vorschlag:reject', requestId, vorschlagId: privatVorschlagId });
  const ev = await absage;
  muss(ev.code === 'fehler.vorschlagWeg', `abgewiesen mit ${ev.code}`);
  muss(V.getVorschlag(privatVorschlagId).zustand === 'offen', 'der Zustand hat sich geändert');
  return `abgewiesen mit ${ev.code}`;
});

chefin.zu();
zweiter.zu();
await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
