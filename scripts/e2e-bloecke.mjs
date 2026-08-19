/**
 * Der Blockspeicher darf niemals ein Byte verändern.
 *
 * Geprüft wird der ganze Weg: hochladen, im Blockspeicher ablegen, wieder
 * herunterladen, Prüfsumme vergleichen. Dazu die Ersparnis bei zwei Fassungen
 * derselben Datei — und dass das Löschen der einen die andere nicht anfasst.
 *
 * Und der Weg, auf dem eine Datei verschwindet, ohne dass jemand sie löscht:
 * beim Löschen eines Kanals räumt die Datenbank Nachrichten, Anhänge und
 * Dateien selbst ab. Dabei blieben die Blöcke früher für immer liegen — mit
 * Verweisen, die auf nichts mehr zeigten. Dass sie jetzt eingesammelt werden,
 * ist das, was am schwersten zu sehen und am teuersten zu übersehen ist.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };
const summe = (b) => crypto.createHash('sha256').update(b).digest('hex');
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

const probe = await probeserver();
const S = probe.S;
const kopf = { authorization: probe.kopf.authorization };

/** Baut eine Datei, die einer zweiten Fassung ähnelt: gleicher Rumpf, anderer Kopf. */
function bauen(groesse, saat, abweichungAb = null) {
  const daten = Buffer.alloc(groesse);
  // Wiederholbarer Inhalt, damit beide Fassungen dieselbe Grundlage haben.
  let zustand = crypto.createHash('sha256').update(saat).digest();
  for (let i = 0; i < groesse; i += 32) {
    zustand = crypto.createHash('sha256').update(zustand).digest();
    zustand.copy(daten, i, 0, Math.min(32, groesse - i));
  }
  if (abweichungAb !== null) daten.fill(0x42, abweichungAb, abweichungAb + 512 * 1024);
  return daten;
}

/**
 * Baut Inhalt, der sich wirklich packen lässt — und zwar überall anders.
 *
 * `bauen()` liefert Rauschen: der Packer winkt es in Sekundenbruchteilen
 * durch, und damit ließe sich nicht zeigen, dass die Antwort nicht auf die
 * Zerlegung wartet. Text aus wechselnden Wörtern ist das Gegenteil — er
 * kostet den Packer echte Arbeit und schrumpft dabei deutlich.
 */
function packbarBauen(groesse, saat) {
  const woerter = ['Kanal', 'Nachricht', 'Anhang', 'Protokoll', 'Server', 'Sitzung',
    'Bericht', 'Vorgang', 'Datei', 'Ablage', 'Kunde', 'Termin', 'Notiz', 'Hinweis'];
  const teile = [];
  let bisher = 0;
  let zustand = crypto.createHash('sha256').update(saat).digest();
  while (bisher < groesse) {
    zustand = crypto.createHash('sha256').update(zustand).digest();
    let zeile = '';
    for (let i = 0; i < 32; i += 1) zeile += `${woerter[zustand[i] % woerter.length]}-${zustand[i]} `;
    zeile += '\n';
    teile.push(Buffer.from(zeile));
    bisher += zeile.length;
  }
  return Buffer.concat(teile).subarray(0, groesse);
}

/**
 * Hochladen und zurückkehren, sobald der Server geantwortet hat.
 *
 * Was danach kommt — die Zerlegung —, läuft im Hintergrund. Wer nachsehen
 * will, wie die Datei abgelegt ist, muss also warten; dafür gibt es
 * `hochladen()` gleich darunter. Diese Fassung hier ist für die eine Prüfung,
 * der es gerade darauf ankommt, dass die Antwort **nicht** wartet.
 */
async function hochladenOhneWarten(inhalt, name) {
  const form = new FormData();
  form.append('file', new Blob([inhalt], { type: 'application/octet-stream' }), name);
  const antwort = await (await fetch(`${S}/api/uploads`, { method: 'POST', headers: kopf, body: form })).json();
  return antwort.attachment ?? antwort;
}

/**
 * Hochladen und warten, bis die Übernahme in den Blockspeicher durch ist.
 *
 * Seit auch die kleinen Wege im Hintergrund übernehmen, sagt ein Blick in die
 * Datenbank unmittelbar nach der Antwort noch nichts: dort steht dann
 * `uebernahme` und nicht das Ergebnis. Fast jede Prüfung hier will aber das
 * Ergebnis sehen — deshalb ist Warten der Normalfall und nicht die Ausnahme.
 * Nebenbei hält das die Warteschlange leer, was die Prüfungen weiter unten
 * brauchen: sie legen den Blockspeicher kurz lahm, und ein noch laufender
 * fremder Auftrag ginge dabei mit unter.
 */
async function hochladen(inhalt, name) {
  const anhang = await hochladenOhneWarten(inhalt, name);
  if (anhang?.id) await warteAufUebernahme(anhang.id);
  return anhang;
}

const herunterladen = async (pfad) =>
  Buffer.from(await (await fetch(`${S}${pfad}`, { headers: kopf })).arrayBuffer());

/** Fragen, ob der Server die Datei schon kennt — ohne ein einziges Byte zu schicken. */
async function nachfragen(inhalt, name) {
  const antwort = await fetch(`${S}/api/uploads/bekannt`, {
    method: 'POST',
    headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({
      sha256: summe(inhalt), size: inhalt.length, name, mime: 'application/octet-stream',
    }),
  });
  return antwort.json();
}

/**
 * Eine Datei in Teilen hochladen.
 *
 * Der Weg, für den große Dateien überhaupt zerlegt werden — und der ihn
 * lange am Blockspeicher vorbeiführte: das Zusammensetzen trug die Zeile ein
 * und war fertig. Seitdem er übernimmt, ist er hier nicht mehr der Weg zu
 * einer ganzen Datei, sondern der Fall, den es zu prüfen gilt.
 */
async function inTeilenHochladen(inhalt, name) {
  const begonnen = await (await fetch(`${S}/api/uploads/start`, {
    method: 'POST',
    headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({
      name, mime: 'application/octet-stream', size: inhalt.length, parts: 1,
    }),
  })).json();
  if (!begonnen.uploadId) throw new Error(`Kein Auftrag: ${JSON.stringify(begonnen).slice(0, 160)}`);

  await fetch(`${S}/api/uploads/${begonnen.uploadId}/part/0`, {
    method: 'PUT', headers: { ...kopf, 'content-type': 'application/octet-stream' }, body: inhalt,
  });

  const fertig = await (await fetch(`${S}/api/uploads/${begonnen.uploadId}/finish`, {
    method: 'POST', headers: { ...kopf, 'content-type': 'application/json' }, body: '{}',
  })).json();
  if (!fertig.attachment) throw new Error(`Kein Anhang: ${JSON.stringify(fertig).slice(0, 160)}`);
  return fertig.attachment;
}

/** Ablegen und zurückkehren, sobald der Server geantwortet hat. */
async function ablegenOhneWarten(inhalt, name, channelId = null) {
  const form = new FormData();
  form.append('file', new Blob([inhalt], { type: 'application/octet-stream' }), name);
  if (channelId) form.append('channelId', channelId);
  const antwort = await (await fetch(`${S}/api/files`, { method: 'POST', headers: kopf, body: form })).json();
  if (!antwort.file) throw new Error(`Ablegen fehlgeschlagen: ${JSON.stringify(antwort).slice(0, 160)}`);
  return antwort.file;
}

/**
 * Eine Datei in die Ablage legen — anders als ein Anhang hängt sie am Kanal.
 *
 * Wartet wie `hochladen()` auf die Übernahme; der Grund steht dort.
 */
async function ablegen(inhalt, name, channelId = null) {
  const datei = await ablegenOhneWarten(inhalt, name, channelId);
  await warteAufUebernahme(datei.id, 'files');
  return datei;
}

/* ── Ein Blick in die Datenbank ───────────────────────────────── */

/* Manches lässt sich von außen gar nicht sehen: ob ein Block noch da ist,
   steht in keiner Antwort. Deshalb wird für jede Frage kurz aufgemacht und
   wieder zu — eine offene Zweitverbindung würde dem Server im Weg stehen. */
function nachsehen(fn) {
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

const speicherOrdner = path.join(path.dirname(probe.datenbank), 'storage');
const anhangOrdner = path.join(path.dirname(probe.datenbank), 'uploads');
const blockPfad = (summe) =>
  path.join(speicherOrdner, 'bloecke', summe.slice(0, 2), summe.slice(2, 4), summe);

const zeileVon = (tabelle, id) => nachsehen((db) =>
  db.prepare(`SELECT * FROM ${tabelle} WHERE id = ?`).get(id));

const bloeckeVon = (id, art) => nachsehen((db) => db
  .prepare('SELECT summe FROM datei_bloecke WHERE art = ? AND datei_id = ? ORDER BY nummer')
  .all(art, id).map((r) => r.summe));

const kenntBlock = (summe) => nachsehen((db) =>
  Boolean(db.prepare('SELECT 1 FROM bloecke WHERE summe = ?').get(summe)));

/**
 * Warten, bis eine Übernahme im Hintergrund durch ist.
 *
 * Der Weg in Teilen antwortet, sobald die Datei zusammengesetzt und
 * eingetragen ist — zerlegt wird sie danach. Solange das läuft, trägt die
 * Zeile `uebernahme`. Wer hier nachsieht, muss also warten, bis der Vermerk
 * einem Ergebnis gewichen ist: `bloecke`, wenn es gelungen ist, sonst wieder
 * nichts. Genau dieses Ende ist die Zusage — ein Vermerk, der stehenbleibt,
 * wäre ein hängengebliebener Vorgang und muss auffallen.
 */
async function warteAufUebernahme(id, tabelle = 'attachments', sekunden = 120) {
  const bis = Date.now() + sekunden * 1000;
  for (;;) {
    const zeile = zeileVon(tabelle, id);
    if (!zeile) throw new Error(`Die Zeile ${id} ist verschwunden`);
    if (zeile.encoding !== 'uebernahme') return zeile;
    if (Date.now() > bis) throw new Error(`Die Übernahme von ${id} kam in ${sekunden} s nicht zum Ende`);
    await new Promise((f) => setTimeout(f, 100));
  }
}

/**
 * Eine Datei hochladen, die als Ganzes liegenbleibt.
 *
 * Seit auch der Weg in Teilen übernimmt, hinterlässt kein Upload mehr von
 * sich aus eine ganze Datei — die beiden Prüfungen weiter unten hätten dann
 * nichts mehr zu prüfen und wären still grün geworden. Was es weiterhin gibt,
 * ist die gescheiterte Übernahme: sie ist ausdrücklich vorgesehen und lässt
 * die Datei unangetastet auf der Platte liegen. Genau die wird hier
 * herbeigeführt, indem der Blockspeicher für einen Augenblick kein Ordner
 * mehr ist — der erste Versuch, dort einen Block anzulegen, endet an ENOTDIR.
 *
 * Der Griff ist grob, sitzt aber an der richtigen Stelle: er wirkt erst im
 * Blockspeicher, also nachdem die Zeile steht, und wird sofort zurückgenommen.
 * Dass die Datei danach wirklich als Ganzes daliegt, wird nachgesehen und
 * nicht angenommen.
 *
 * Der Blockspeicher bleibt dabei so lange lahmgelegt, bis die Übernahme
 * wirklich gelaufen **und** wirklich gescheitert ist. Früher genügte hier ein
 * Upload, weil der kleine Weg im Ablauf zerlegte; seit auch er das im
 * Hintergrund tut, wäre der Ordner sonst längst wieder da, bevor der Versuch
 * überhaupt begonnen hat — und die Übernahme gelänge. Genau darauf wartet
 * `hochladen()`, und genau deshalb steht die Rücknahme hinter dem Warten.
 */
async function alsGanzeDateiHochladen(inhalt, name) {
  const ordner = path.join(speicherOrdner, 'bloecke');
  const beiseite = `${ordner}.beiseite`;
  fs.mkdirSync(ordner, { recursive: true });
  fs.renameSync(ordner, beiseite);

  let anhang;
  try {
    fs.writeFileSync(ordner, 'absichtlich kein Ordner');
    anhang = await hochladen(inhalt, name);
  } finally {
    fs.rmSync(ordner, { force: true });
    fs.renameSync(beiseite, ordner);
  }

  const zeile = zeileVon('attachments', anhang.id);
  muss(zeile, 'der Upload hat gar keine Zeile hinterlassen');
  muss(zeile.encoding !== 'bloecke', 'die Übernahme ist wider Erwarten gelungen');
  /* Der Vermerk muss weg sein, nicht bloß nicht `bloecke`: bliebe er stehen,
     hielte der nächste Start diesen Vorgang für unterbrochen und versuchte es
     endlos weiter. */
  muss(zeile.encoding === null, `nach dem Fehlschlag steht noch "${zeile.encoding}" in der Zeile`);
  muss(fs.existsSync(zeile.path), 'die ganze Datei liegt nicht auf der Platte');
  return anhang;
}

/**
 * Dasselbe über den Weg in Teilen — mit dem Unterschied, der zählt.
 *
 * Dort läuft die Übernahme nach der Antwort, die Zeile trägt bis dahin
 * `uebernahme`. Der Blockspeicher bleibt deshalb so lange blockiert, bis der
 * Vermerk gewichen ist: erst dann steht fest, dass der Versuch wirklich
 * gelaufen und wirklich gescheitert ist, und nicht bloß noch nicht begonnen
 * hat.
 */
async function alsGanzeDateiInTeilen(inhalt, name) {
  const ordner = path.join(speicherOrdner, 'bloecke');
  const beiseite = `${ordner}.beiseite`;
  fs.mkdirSync(ordner, { recursive: true });
  fs.renameSync(ordner, beiseite);

  let anhang;
  let zeile;
  try {
    fs.writeFileSync(ordner, 'absichtlich kein Ordner');
    anhang = await inTeilenHochladen(inhalt, name);
    zeile = await warteAufUebernahme(anhang.id);
  } finally {
    fs.rmSync(ordner, { force: true });
    fs.renameSync(beiseite, ordner);
  }

  /* Der Vermerk muss weg sein, nicht bloß nicht `bloecke`: bliebe er stehen,
     hielte der nächste Start diesen Vorgang für unterbrochen und versuchte es
     endlos weiter. */
  muss(zeile.encoding === null, `nach dem Fehlschlag steht noch "${zeile.encoding}" in der Zeile`);
  muss(fs.existsSync(zeile.path), 'die ganze Datei liegt nicht auf der Platte');
  return anhang;
}

/* ── Die Ereignisleitung ──────────────────────────────────────── */

/**
 * Kanäle anzulegen und zu löschen geht nur über die Ereignisleitung — es gibt
 * dafür keine Adresse zum Anrufen. Für diesen Prüflauf genügt eine sehr kleine
 * Fassung davon: anmelden, etwas hinschicken, auf eine Antwort warten.
 */
async function leitung() {
  const socket = new WebSocket(`${S.replace('http', 'ws')}/ws`);
  const eingang = [];
  const wartende = [];
  socket.addEventListener('message', (e) => {
    const ev = JSON.parse(e.data);
    eingang.push(ev);
    for (const w of wartende.splice(0)) w();
  });
  await new Promise((fertig, schief) => {
    socket.addEventListener('open', fertig, { once: true });
    socket.addEventListener('error', () => schief(new Error('Die Leitung kam nicht zustande')), { once: true });
  });

  const warteAuf = async (art, sekunden = 15) => {
    const bis = Date.now() + sekunden * 1000;
    for (;;) {
      const treffer = eingang.find((ev) => ev.t === art);
      if (treffer) return treffer;
      const fehler = eingang.find((ev) => ev.t === 'error');
      if (fehler) throw new Error(`Der Server sagt: ${fehler.message}`);
      if (Date.now() > bis) throw new Error(`Auf "${art}" kam nichts zurück`);
      await new Promise((f) => { wartende.push(f); setTimeout(f, 200); });
    }
  };
  const senden = (ev) => socket.send(JSON.stringify(ev));

  senden({ t: 'auth', token: probe.token, protocol: 1 });
  await warteAuf('ready');
  // Was vor dem Auftrag hereinkam, soll die Antwort darauf nicht vortäuschen.
  const leeren = () => { eingang.length = 0; };

  return { senden, warteAuf, leeren, schliessen: () => socket.close() };
}

console.log('\nBlockspeicher');

const eins = bauen(6 * 1024 * 1024, 'fassung-eins');
const zwei = bauen(6 * 1024 * 1024, 'fassung-eins', 1024 * 1024);   // dieselbe Datei, 512 KB anders

let a; let b;

await pruefe('Eine Datei kommt unverändert zurück', async () => {
  a = await hochladen(eins, 'programm-1.0.bin');
  muss(a.id, 'kein Anhang angelegt');
  const zurueck = await herunterladen(a.url);
  muss(summe(zurueck) === summe(eins), 'die Bytes haben sich verändert');
  return `${mb(eins.length)} unversehrt`;
});

await pruefe('Zweite Fassung wird ebenfalls unverändert zurückgegeben', async () => {
  b = await hochladen(zwei, 'programm-1.1.bin');
  const zurueck = await herunterladen(b.url);
  muss(summe(zurueck) === summe(zwei), 'die Bytes haben sich verändert');
});

await pruefe('Die zweite Fassung teilt sich Blöcke mit der ersten', async () => {
  // In der Datenbank nachsehen statt zu vermuten: wie viel liegt wirklich da?
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const { belegt } = db.prepare('SELECT COALESCE(SUM(belegt), 0) belegt FROM bloecke').get();
  const { geteilt } = db.prepare('SELECT COUNT(*) geteilt FROM bloecke WHERE verweise > 1').get();
  db.close();

  const hochgeladen = eins.length + zwei.length;
  muss(geteilt > 0, 'kein einziger Block wird geteilt');
  muss(belegt < hochgeladen * 0.75,
    `belegt ${mb(belegt)} von ${mb(hochgeladen)} — zu wenig gespart`);
  const gespart = 100 - (100 * belegt) / hochgeladen;
  return `${mb(hochgeladen)} hochgeladen, ${mb(belegt)} gespeichert (${gespart.toFixed(0)} % gespart, ${geteilt} Blöcke geteilt)`;
});

await pruefe('Dieselbe Datei ein zweites Mal kostet fast nichts', async () => {
  const nochmal = await hochladen(eins, 'programm-1.0-kopie.bin');
  const zurueck = await herunterladen(nochmal.url);
  muss(summe(zurueck) === summe(eins), 'die Kopie kam verändert zurück');
});

await pruefe('Eine in Teilen hochgeladene Datei landet ebenfalls im Blockspeicher', async () => {
  /* Der Weg in Teilen ist für die großen Dateien gebaut — und ausgerechnet
     die gingen am Blockspeicher vorbei: das Zusammensetzen trug die Zeile ein
     und rief nicht weiter. Zwei Fassungen desselben Programms teilten sich so
     keinen einzigen Block, obwohl der Speicher genau dafür da ist.
     Geprüft wird mit denselben Bytes wie oben: kommt dieselbe Blockliste
     heraus, ist die Zerlegung unabhängig davon, in wie vielen Stücken die
     Datei hereinkam. */
  const inTeilen = await inTeilenHochladen(eins, 'programm-1.0-in-teilen.bin');
  const zeile = await warteAufUebernahme(inTeilen.id);
  muss(zeile.encoding === 'bloecke', `die Datei liegt nicht in Blöcken (${zeile.encoding})`);
  muss(!fs.existsSync(zeile.path), 'die ganze Datei liegt weiterhin daneben');
  muss(
    bloeckeVon(inTeilen.id, 'attachment').join() === bloeckeVon(a.id, 'attachment').join(),
    'dieselben Bytes ergeben in Teilen eine andere Blockliste',
  );
  muss(zeile.stored_size === 0, `der Weg in Teilen legt neu ab statt zu teilen (${zeile.stored_size})`);

  const zurueck = await herunterladen(inTeilen.url);
  muss(summe(zurueck) === summe(eins), 'die Bytes haben sich verändert');
  return `${mb(eins.length)} in Teilen, kein neuer Block`;
});

await pruefe('Die Antwort wartet nicht auf die Zerlegung', async () => {
  /* Warum die Übernahme hier hinter der Antwort liegt und nicht davor: wie
     lange eine Zerlegung dauert, entscheidet der Inhalt. Schon Gepacktes
     rauscht durch, gut Packbares kostet Sekunden je Block — jeder wird
     einzeln gepackt. Läge das im Ablauf, hinge der Client daran, und bei
     ungünstigem Inhalt hielte er den Upload für gescheitert.

     Belegt wird das ohne Stoppuhr-Schwelle: unmittelbar nach der Antwort
     trägt die Zeile noch `uebernahme`. Damit steht fest, dass die Antwort
     nicht auf die Zerlegung gewartet hat. */
  const packbar = packbarBauen(2 * 1024 * 1024, 'antwort-wartet-nicht');
  const begonnen = performance.now();
  const anhang = await inTeilenHochladen(packbar, 'packbar.txt');
  const antwortNach = performance.now() - begonnen;

  const sofort = zeileVon('attachments', anhang.id);
  muss(sofort.encoding === 'uebernahme',
    `die Antwort kam erst nach der Zerlegung (${sofort.encoding})`);

  const fertig = await warteAufUebernahme(anhang.id);
  const zerlegtNach = performance.now() - begonnen;
  muss(fertig.encoding === 'bloecke', `die Übernahme scheiterte (${fertig.encoding})`);

  // Und was hinten herauskommt, muss Byte für Byte dasselbe sein.
  const zurueck = await herunterladen(anhang.url);
  muss(summe(zurueck) === summe(packbar), 'die Bytes haben sich verändert');
  muss(fertig.stored_size < packbar.length,
    `gepackt sollte kleiner sein: ${fertig.stored_size} von ${packbar.length}`);

  return `Antwort nach ${antwortNach.toFixed(0)} ms, zerlegt nach ${zerlegtNach.toFixed(0)} ms, `
    + `${mb(packbar.length)} → ${mb(fertig.stored_size)}`;
});

await pruefe('Auch der Upload am Stück wartet nicht auf die Zerlegung', async () => {
  /* Dieselbe Zusage für die beiden kleinen Wege, und aus demselben Grund.
     Sie zerlegten lange im Ablauf der Anfrage, weil eine kleine Datei ja
     "schnell durch" sei — das gilt aber nur für Inhalt, den der Packer
     durchwinkt. Packbarer Inhalt kostet Sekunden je Block, und weil die
     Zerlegung durchweg synchron läuft, hielt sie nicht nur diese eine Antwort
     auf, sondern die ganze Ereignisschleife: kein Ping, keine Nachricht,
     keine zweite Anfrage. Auf einem Raspberry Pi gemessen: 4 MB packbarer
     CSV-Abzug 18 Sekunden Stillstand, hochgerechnet auf die 50 MB, die
     `MAX_UPLOAD_MB` erlaubt, über drei Minuten.

     Belegt wird das wie beim Weg in Teilen ohne Stoppuhr-Schwelle: direkt
     nach der Antwort trägt die Zeile noch `uebernahme`. */
  const packbar = packbarBauen(2 * 1024 * 1024, 'am-stueck-wartet-nicht');

  const anhang = await hochladenOhneWarten(packbar, 'packbar-am-stueck.txt');
  muss(zeileVon('attachments', anhang.id)?.encoding === 'uebernahme',
    'der Anhang-Upload hat auf die Zerlegung gewartet');
  const fertigerAnhang = await warteAufUebernahme(anhang.id);
  muss(fertigerAnhang.encoding === 'bloecke', `die Übernahme scheiterte (${fertigerAnhang.encoding})`);

  const datei = await ablegenOhneWarten(packbar, 'packbar-in-der-ablage.txt');
  muss(zeileVon('files', datei.id)?.encoding === 'uebernahme',
    'der Ablage-Upload hat auf die Zerlegung gewartet');
  /* Solange die Übernahme aussteht, ist `stored_size` leer — und genau so
     soll das Kontingent rechnen: die ganze Datei liegt noch da und kostet
     auch so viel. */
  muss(zeileVon('files', datei.id)?.stored_size === null,
    'während der Übernahme wird schon der gepackte Platz angerechnet');
  const fertigeDatei = await warteAufUebernahme(datei.id, 'files');
  muss(fertigeDatei.encoding === 'bloecke', `die Übernahme scheiterte (${fertigeDatei.encoding})`);

  // Und beide Wege müssen dieselben Bytes zurückgeben.
  for (const [wer, pfad] of [['Anhang', anhang.url], ['Ablage', datei.url]]) {
    const zurueck = await herunterladen(pfad);
    muss(summe(zurueck) === summe(packbar), `der Weg über ${wer} kam verändert zurück`);
  }
  return `${mb(packbar.length)} über beide kleinen Wege, Antwort jeweils vor der Zerlegung`;
});

await pruefe('Dieselbe große Datei ein zweites Mal kostet keinen neuen Block', async () => {
  /* Der eigentliche Zweck der ganzen Übung: derselbe Inhalt darf nur einmal
     auf der Platte liegen. Gemessen wird nicht an der Antwort, sondern am
     Blockspeicher selbst — was er vor und nach jedem der beiden Uploads
     wirklich belegt. */
  const gross = bauen(8 * 1024 * 1024, 'grosse-fassung');
  const belegtJetzt = () => nachsehen((db) =>
    db.prepare('SELECT COALESCE(SUM(belegt), 0) belegt FROM bloecke').get().belegt);

  const vorErstem = belegtJetzt();
  const erster = await inTeilenHochladen(gross, 'gross-1.bin');
  const zeileEins = await warteAufUebernahme(erster.id);
  const nachErstem = belegtJetzt();

  const zweiter = await inTeilenHochladen(gross, 'gross-2.bin');
  const zeileZwei = await warteAufUebernahme(zweiter.id);
  const nachZweitem = belegtJetzt();

  muss(zeileEins.encoding === 'bloecke', 'der erste Upload liegt nicht in Blöcken');
  muss(zeileZwei.encoding === 'bloecke', 'der zweite Upload liegt nicht in Blöcken');
  muss(
    bloeckeVon(zweiter.id, 'attachment').join() === bloeckeVon(erster.id, 'attachment').join(),
    'die beiden Uploads ergeben verschiedene Blocklisten',
  );
  muss(zeileZwei.stored_size === 0,
    `der zweite Upload rechnet ${zeileZwei.stored_size} Byte an statt nichts`);
  muss(nachZweitem === nachErstem,
    `der zweite Upload hat den Blockspeicher um ${nachZweitem - nachErstem} Byte wachsen lassen`);

  // Beide müssen dieselben Bytes zurückgeben.
  for (const [wer, anhang] of [['erster', erster], ['zweiter', zweiter]]) {
    const zurueck = await herunterladen(anhang.url);
    muss(summe(zurueck) === summe(gross), `der ${wer} Upload kam verändert zurück`);
  }

  return `1. Upload +${mb(nachErstem - vorErstem)}, 2. Upload +${nachZweitem - nachErstem} Byte`;
});

await pruefe('Eine gescheiterte Übernahme im Hintergrund lässt einen sauberen Zustand', async () => {
  /* Der Hintergrund braucht einen Zwischenstand, und ein Zwischenstand, der
     hängenbleibt, ist schlimmer als keiner: der nächste Start hielte den
     Vorgang für unterbrochen und liefe ihm ewig hinterher. Deshalb hier
     ausdrücklich der Fehlschlag — die Datei bleibt ganz liegen, benutzbar,
     und der Vermerk ist weg. */
  const inhalt = bauen(1024 * 1024, 'hintergrund-scheitert');
  const anhang = await alsGanzeDateiInTeilen(inhalt, 'gescheitert.bin');

  const zeile = zeileVon('attachments', anhang.id);
  muss(zeile.stored_size === null, `es wird schon etwas angerechnet: ${zeile.stored_size}`);
  muss(bloeckeVon(anhang.id, 'attachment').length === 0, 'es stehen Blockverweise ohne Blöcke');

  const zurueck = await herunterladen(anhang.url);
  muss(summe(zurueck) === summe(inhalt), 'die liegengebliebene Datei liefert andere Bytes');
  return `${mb(inhalt.length)} bleiben ganz und benutzbar`;
});

await pruefe('Eine Datei im Blockspeicher gilt als bekannt — ohne ein Byte zu übertragen', async () => {
  /* Der Client fragt vor dem Hochladen nach. Solange die Route auf den Pfad
     der gefundenen Zeile sah, war die Antwort für alles im Blockspeicher
     „kenne ich nicht": diesen Pfad gibt es dort nicht mehr. Gespart wurde
     danach zwar trotzdem, aber erst nachdem die Leitung umsonst gelaufen war. */
  const vorlage = zeileVon('attachments', a.id);
  muss(vorlage.encoding === 'bloecke', `die Vorlage liegt gar nicht in Blöcken (${vorlage.encoding})`);
  muss(!fs.existsSync(vorlage.path), 'die ganze Datei liegt noch da — dann sagt die Prüfung nichts');

  const antwort = await nachfragen(eins, 'ohne-uebertragung.bin');
  muss(antwort.bekannt === true, 'der Server hält die Datei für unbekannt');

  const neu = zeileVon('attachments', antwort.attachment.id);
  muss(neu.encoding === 'bloecke', 'der neue Eintrag zeigt nicht in den Blockspeicher');
  muss(neu.stored_size === 0, `der zweite Eintrag soll nichts kosten, gerechnet werden ${neu.stored_size}`);
  muss(
    bloeckeVon(antwort.attachment.id, 'attachment').join() === bloeckeVon(a.id, 'attachment').join(),
    'die Blockliste weicht von der Vorlage ab',
  );

  // Und der Verweis muss wirklich dieselben Bytes liefern.
  const zurueck = await herunterladen(antwort.attachment.url);
  muss(summe(zurueck) === summe(eins), 'der Verweis liefert andere Bytes');
  return `${mb(eins.length)} nicht übertragen`;
});

await pruefe('Eine unbekannte Datei bleibt unbekannt', async () => {
  // Die Gegenprobe: die Route darf nicht einfach alles bejahen.
  const fremd = bauen(1024 * 1024, 'nie-gesehen');
  const antwort = await nachfragen(fremd, 'fremd.bin');
  muss(antwort.bekannt === false, 'der Server behauptet, eine fremde Datei zu kennen');

  // Und die richtige Prüfsumme mit falscher Größe ist kein Nachweis.
  const schief = await (await fetch(`${S}/api/uploads/bekannt`, {
    method: 'POST',
    headers: { ...kopf, 'content-type': 'application/json' },
    body: JSON.stringify({ sha256: summe(eins), size: eins.length - 1, name: 'schief.bin' }),
  })).json();
  muss(schief.bekannt === false, 'eine falsche Größe genügt als Nachweis');
});

/* ── Löschen ──────────────────────────────────────────────────── */

const draht = await leitung();

const drei = bauen(6 * 1024 * 1024, 'fassung-drei');
const vier = bauen(6 * 1024 * 1024, 'fassung-drei', 2 * 1024 * 1024);

let geteilteBloecke = [];

await pruefe('Eine gelöschte Datei nimmt nur ihre eigenen Blöcke mit', async () => {
  const x = await ablegen(drei, 'werkzeug-1.0.bin');
  const y = await ablegen(vier, 'werkzeug-1.1.bin');

  const beiX = bloeckeVon(x.id, 'file');
  const beiY = new Set(bloeckeVon(y.id, 'file'));
  muss(beiX.length > 0, 'die erste Datei hat gar keine Blöcke');

  geteilteBloecke = beiX.filter((s) => beiY.has(s));
  const nurBeiX = beiX.filter((s) => !beiY.has(s));
  muss(geteilteBloecke.length > 0, 'die beiden Fassungen teilen sich keinen einzigen Block');
  muss(nurBeiX.length > 0, 'die erste Datei hat keinen eigenen Block — dann sagt die Prüfung nichts');

  draht.leeren();
  draht.senden({ t: 'file:delete', fileId: x.id });
  await draht.warteAuf('file:removed');

  muss(bloeckeVon(x.id, 'file').length === 0, 'die Verweise der gelöschten Datei stehen noch');
  for (const s of nurBeiX) {
    muss(!kenntBlock(s), `Block ${s.slice(0, 12)}… steht noch in der Tabelle`);
    muss(!fs.existsSync(blockPfad(s)), `Block ${s.slice(0, 12)}… liegt noch auf der Platte`);
  }
  for (const s of geteilteBloecke) {
    muss(kenntBlock(s), `ein geteilter Block wurde mitgerissen: ${s.slice(0, 12)}…`);
  }

  const zurueck = await herunterladen(y.url);
  muss(summe(zurueck) === summe(vier), 'die zweite Fassung ist beschädigt');
  return `${nurBeiX.length} eigene Blöcke frei, ${geteilteBloecke.length} geteilte unangetastet`;
});

await pruefe('Ein gelöschter Kanal lässt keine Blöcke zurück', async () => {
  /* Der heikle Weg: hier löscht niemand eine Datei. Der Kanal geht, und die
     Datenbank räumt Nachrichten, Anhänge und Dateien von sich aus hinterher —
     ohne dass ein einziger Aufruf im Blockspeicher ankommt. */
  draht.leeren();
  draht.senden({ t: 'channel:create', kind: 'public', name: 'blockprobe' });
  const angelegt = await draht.warteAuf('channel:upsert');
  const kanal = angelegt.channel.id;

  const imKanal = bauen(5 * 1024 * 1024, 'fassung-kanal');
  const z = await ablegen(imKanal, 'nur-hier.bin', kanal);
  const beiZ = bloeckeVon(z.id, 'file');
  muss(beiZ.length > 0, 'die Datei im Kanal hat keine Blöcke');
  for (const s of beiZ) muss(fs.existsSync(blockPfad(s)), 'ein Block fehlt schon vor dem Löschen');

  draht.leeren();
  draht.senden({ t: 'channel:delete', channelId: kanal });
  await draht.warteAuf('channel:removed');
  muss(
    nachsehen((db) => !db.prepare('SELECT 1 FROM files WHERE id = ?').get(z.id)),
    'die Datei hängt noch in der Tabelle',
  );

  /* Aufgeräumt wird, sobald sich am Bestand wieder etwas tut — hier durch
     einen belanglosen Upload. Ein eigener Zeitgeber dafür wäre eine zweite
     Sache, die schiefgehen kann; so hängt es an dem, was ohnehin passiert. */
  await hochladen(Buffer.from('nur ein Anstoß'), 'anstoss.txt');

  muss(bloeckeVon(z.id, 'file').length === 0, 'die Verweise der Datei aus dem Kanal stehen noch');
  for (const s of beiZ) {
    muss(!kenntBlock(s), `Block ${s.slice(0, 12)}… steht noch in der Tabelle`);
    muss(!fs.existsSync(blockPfad(s)), `Block ${s.slice(0, 12)}… liegt noch auf der Platte`);
  }
  return `${beiZ.length} Blöcke eingesammelt`;
});

await pruefe('Ein gelöschter Kanal lässt auch keine ganze Datei zurück', async () => {
  /* Nicht alles landet im Blockspeicher: scheitert die Übernahme, bleibt die
     Datei am Stück liegen — so ist es gewollt, denn benutzbar bleibt sie
     dabei. Für die tat beim Löschen eines Kanals niemand etwas — der
     Kommentar an der Stelle verwies auf einen Aufräumlauf, den es nie gab. So
     sind auf dem Server hundert Megabyte ohne Zeile in der Datenbank
     entstanden. Blöcke einzusammeln genügt hier ausdrücklich nicht. */
  draht.leeren();
  draht.senden({ t: 'channel:create', kind: 'public', name: 'ganzdateiprobe' });
  const angelegt = await draht.warteAuf('channel:upsert');
  const kanal = angelegt.channel.id;

  const amStueck = bauen(3 * 1024 * 1024, 'ganze-datei');
  const anhang = await alsGanzeDateiHochladen(amStueck, 'am-stueck.bin');
  const zeile = zeileVon('attachments', anhang.id);
  muss(path.dirname(zeile.path) === anhangOrdner, `unerwarteter Ort: ${zeile.path}`);

  draht.leeren();
  draht.senden({
    t: 'message:send', clientId: 'probe-ganzdatei', channelId: kanal,
    text: 'mit Anhang', attachmentIds: [anhang.id],
  });
  await draht.warteAuf('message:new');
  muss(zeileVon('attachments', anhang.id).message_id, 'der Anhang hängt an keiner Nachricht');

  draht.leeren();
  draht.senden({ t: 'channel:delete', channelId: kanal });
  await draht.warteAuf('channel:removed');

  muss(!zeileVon('attachments', anhang.id), 'der Anhang steht noch in der Tabelle');
  muss(!fs.existsSync(zeile.path), 'die Datei liegt noch auf der Platte');
  return `${mb(amStueck.length)} abgeräumt`;
});

await pruefe('Eine geteilte Datei überlebt das Löschen des Kanals nebenan', async () => {
  /* Der gefährliche Nachbar der vorigen Prüfung: zeigt eine zweite Zeile auf
     dieselben Bytes, darf das Löschen des einen Kanals dem anderen nicht den
     Inhalt wegnehmen. Genau dafür wird vor dem Entfernen noch einmal
     nachgesehen, ob jemand die Datei braucht. */
  const geteilt = bauen(2 * 1024 * 1024, 'geteilte-datei');
  const erster = await alsGanzeDateiHochladen(geteilt, 'geteilt.bin');
  const zweiter = await nachfragen(geteilt, 'geteilt-kopie.bin');
  muss(zweiter.bekannt === true, 'die zweite Zeile kam nicht zustande');

  const pfad = zeileVon('attachments', erster.id).path;
  muss(zeileVon('attachments', zweiter.attachment.id).path === pfad, 'die Zeilen teilen sich den Pfad nicht');

  draht.leeren();
  draht.senden({ t: 'channel:create', kind: 'public', name: 'nachbarprobe' });
  const kanal = (await draht.warteAuf('channel:upsert')).channel.id;

  draht.leeren();
  draht.senden({
    t: 'message:send', clientId: 'probe-nachbar', channelId: kanal,
    text: 'nur die erste', attachmentIds: [erster.id],
  });
  await draht.warteAuf('message:new');

  draht.leeren();
  draht.senden({ t: 'channel:delete', channelId: kanal });
  await draht.warteAuf('channel:removed');

  muss(!zeileVon('attachments', erster.id), 'die erste Zeile steht noch in der Tabelle');
  muss(fs.existsSync(pfad), 'die Datei wurde weggeräumt, obwohl eine zweite Zeile darauf zeigt');
  const zurueck = await herunterladen(zweiter.attachment.url);
  muss(summe(zurueck) === summe(geteilt), 'die verbliebene Zeile liefert andere Bytes');
});

await pruefe('Kein Verweis zeigt am Ende ins Leere', async () => {
  const uebrig = nachsehen((db) => db.prepare(
    `SELECT COUNT(*) n FROM datei_bloecke
      WHERE (art = 'file'       AND datei_id NOT IN (SELECT id FROM files))
         OR (art = 'attachment' AND datei_id NOT IN (SELECT id FROM attachments))
         OR summe NOT IN (SELECT summe FROM bloecke)`,
  ).get().n);
  muss(uebrig === 0, `${uebrig} Verweis(e) ohne Gegenstück`);

  const schief = nachsehen((db) => db.prepare(
    `SELECT COUNT(*) n FROM bloecke
      WHERE verweise <> (SELECT COUNT(*) FROM datei_bloecke d WHERE d.summe = bloecke.summe)`,
  ).get().n);
  muss(schief === 0, `${schief} Verweiszähler stimmen nicht mit den Zeilen überein`);
});

draht.schliessen();
await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
