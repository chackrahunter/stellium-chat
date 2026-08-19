/**
 * Sprachnachrichten werden abgetippt — und zwar hier, nicht anderswo.
 *
 * Diese Prüfung deckt den Weg ab, der lange still kaputt war: es gab eine
 * Transkription, sie hing an einem Groq-Schlüssel, und als die KI auf ein
 * lokales Modell umgestellt wurde, blieb sie an diesem Schlüssel hängen. Nach
 * außen sah nichts falsch aus — die Sprachnachricht kam an, sie ließ sich
 * abspielen, und nur der Text fehlte. Genau solche Fehler findet niemand von
 * selbst.
 *
 * Geprüft wird deshalb nicht „läuft ein Dienst", sondern die ganze Kette:
 * Aufnahme hoch, Abschrift zurück, Abschrift ist der Nachrichtentext, die
 * Suche findet sie, die Sprache stimmt, und im vertraulichen Kanal entsteht
 * nichts davon.
 *
 * Vorbild: scripts/e2e-sicherheit.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const PROBEN = path.join(HIER, 'proben');

/* Ist eine Adresse ausdrücklich gesetzt, muss dort auch jemand antworten —
   auf dem Pi steht sie in /etc/stellium.env, und ein stiller Ausfall ist dann
   genau das, was diese Prüfung finden soll. Ohne gesetzte Adresse (Dons Mac,
   ein frisch geklontes Arbeitsverzeichnis) werden die Abschrift-Prüfungen
   übersprungen statt fälschlich rot gemeldet. */
const ADRESSE = (process.env.STIMME_URL ?? '').trim();
const GEFORDERT = Boolean(ADRESSE);
const URL_STIMME = (ADRESSE || 'http://127.0.0.1:8788').replace(/\/+$/, '');

const ergebnisse = [];
const uebersprungen = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const ueberspringe = (n, grund) => {
  uebersprungen.push(n);
  console.log(`  – ${n} — ${grund}`);
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/* ── Ist der Sprachdienst da? ─────────────────────────────────── */

async function dienstDa() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`${URL_STIMME}/health`, { signal: ctrl.signal });
      return res.ok;
    } finally { clearTimeout(timer); }
  } catch { return false; }
}

const DA = await dienstDa();

console.log(`\nSprachdienst   ${URL_STIMME} — ${DA ? 'antwortet' : 'antwortet nicht'}`
  + `${GEFORDERT ? ' (gefordert: STIMME_URL ist gesetzt)' : ' (nicht gefordert)'}`);

if (GEFORDERT && !DA) {
  console.log('\n  ✗ Der Sprachdienst ist eingetragen, antwortet aber nicht.');
  console.log('    systemctl status stellium-stimme');
  console.log('    journalctl -u stellium-stimme -n 50 --no-pager\n');
  process.exit(1);
}

/* ── Probeserver ──────────────────────────────────────────────── */

const probe = await probeserver();
const S = probe.S;

/** Eine Verbindung, die man fragen kann. */
async function verbindung(token) {
  const ws = new WebSocket(S.replace(/^http/, 'ws') + '/ws');
  const eingang = [];
  const horcher = new Set();
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    eingang.push(ev);
    for (const h of [...horcher]) if (h.passt(ev)) { horcher.delete(h); h.fertig(ev); }
  };
  const bereit = new Promise((f, r) => {
    const timer = setTimeout(() => r(new Error('keine Verbindung')), 15000);
    horcher.add({ passt: (ev) => ev.t === 'ready', fertig: (ev) => { clearTimeout(timer); f(ev); } });
  });
  ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token, protocol: 1 }));
  const start = await bereit;

  return {
    start,
    senden: (ev) => ws.send(JSON.stringify(ev)),
    warteAuf(passt, ms = 180_000) {
      const schon = eingang.find(passt);
      if (schon) return Promise.resolve(schon);
      return new Promise((f, r) => {
        const timer = setTimeout(() => r(new Error(`Zeitüberschreitung (${ms} ms)`)), ms);
        horcher.add({ passt, fertig: (ev) => { clearTimeout(timer); f(ev); } });
      });
    },
    zu: () => ws.close(),
  };
}

const ich = await verbindung(probe.token);
const marke = Date.now().toString(36).slice(-5);

const kanalAnlegen = async (art, name) => {
  ich.senden({ t: 'channel:create', kind: art, name, memberIds: [] });
  return (await ich.warteAuf((e) => e.t === 'channel:upsert' && e.channel.name === name, 15000)).channel.id;
};

/** Eine Aufnahme hochladen und die Anhang-Kennung zurückgeben. */
async function hochladen(datei) {
  const bytes = fs.readFileSync(path.join(PROBEN, datei));
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/webm' }), datei);
  const res = await fetch(`${S}/api/uploads`, {
    method: 'POST', headers: { authorization: `Bearer ${probe.token}` }, body: form,
  });
  const body = await res.json();
  muss(body.attachment?.id, `Upload fehlgeschlagen: ${JSON.stringify(body).slice(0, 160)}`);
  return body.attachment.id;
}

/**
 * Eine Sprachnachricht schicken und auf die Abschrift warten.
 * Gibt zurück, wie lange es gedauert hat — die Zahl steht im Bericht.
 */
async function sprachnachricht(kanalId, datei) {
  const anhang = await hochladen(datei);
  const begonnen = Date.now();
  ich.senden({
    t: 'voice:send', clientId: `probe-${datei}-${marke}`,
    channelId: kanalId, attachmentId: anhang, durationMs: 4000,
  });
  const neu = await ich.warteAuf(
    (e) => e.t === 'message:new' && e.clientId === `probe-${datei}-${marke}`, 20000,
  );
  const abschrift = await ich.warteAuf(
    (e) => e.t === 'voice:transcript' && e.messageId === neu.message.id,
  );
  return {
    anhang, messageId: neu.message.id, voice: abschrift.voice,
    dauerMs: Date.now() - begonnen,
  };
}

/** In die Datenbank sehen — für das, was die Schnittstelle nicht zeigt. */
function inDerDatenbank(fn) {
  const db = new DatabaseSync(probe.datenbank);
  try { return fn(db); } finally { db.close(); }
}

const zeiten = [];

/* ── Die Kette ────────────────────────────────────────────────── */

console.log('\nAbschrift');

const offen = await kanalAnlegen('public', `stimme-${marke}`);
let deutsch = null;

if (!DA) {
  ueberspringe('Deutsche Aufnahme wird abgetippt', 'kein Sprachdienst');
  ueberspringe('Die Abschrift wird zum Nachrichtentext', 'kein Sprachdienst');
  ueberspringe('Die Suche findet die Abschrift', 'kein Sprachdienst');
  ueberspringe('Die Abschrift steht lokal erzeugt in der Datenbank', 'kein Sprachdienst');
  ueberspringe('Englische Aufnahme wird als Englisch erkannt', 'kein Sprachdienst');
  ueberspringe('Spanische Aufnahme wird als Spanisch erkannt', 'kein Sprachdienst');
} else {
  await pruefe('Deutsche Aufnahme wird abgetippt', async () => {
    deutsch = await sprachnachricht(offen, 'stimme-de.webm');
    zeiten.push(['deutsch (3,7 s)', deutsch.dauerMs]);
    muss(deutsch.voice.transcript, 'keine Abschrift zurückgekommen');
    muss(deutsch.voice.transcriptLang === 'de',
      `Sprache "${deutsch.voice.transcriptLang}" statt "de"`);
    const t = deutsch.voice.transcript.toLowerCase();
    muss(/besprechung|montag|neun/.test(t), `nichts Erwartetes im Text: "${deutsch.voice.transcript}"`);
    muss(deutsch.voice.durationMs > 2000 && deutsch.voice.durationMs < 8000,
      `unglaubwürdige Länge: ${deutsch.voice.durationMs} ms`);
    return `${(deutsch.dauerMs / 1000).toFixed(1)} s · "${deutsch.voice.transcript.trim().slice(0, 46)}"`;
  });

  await pruefe('Die Abschrift wird zum Nachrichtentext', async () => {
    muss(deutsch, 'die Aufnahme davor ist nicht durchgekommen');
    /* Daran hängt alles Weitere: Übersetzung, Suche, Zusammenfassung,
       Aufgabenerkennung und der Assistent lesen den Nachrichtentext. Bleibt
       dort "🎙️ Sprachnachricht" stehen, versteht die KI die Sprachnachricht
       nicht — und genau darum hatte Don gebeten. */
    const aktualisiert = await ich.warteAuf(
      (e) => e.t === 'message:updated' && e.message.id === deutsch.messageId, 20000,
    );
    muss(!aktualisiert.message.text.includes('🎙️'),
      `der Platzhalter steht noch da: "${aktualisiert.message.text}"`);
    muss(aktualisiert.message.text.trim() === deutsch.voice.transcript.trim(),
      'Nachrichtentext und Abschrift gehen auseinander');
    muss(aktualisiert.message.sourceLang === 'de',
      `Quellsprache "${aktualisiert.message.sourceLang}" statt "de"`);
    return 'Text, Quellsprache und Abschrift stimmen überein';
  });

  await pruefe('Die Suche findet die Abschrift', async () => {
    muss(deutsch, 'die Aufnahme davor ist nicht durchgekommen');
    const wort = (deutsch.voice.transcript.match(/\p{L}{6,}/u) ?? ['Besprechung'])[0];
    const res = await fetch(`${S}/api/search?q=${encodeURIComponent(wort)}`, { headers: probe.kopf });
    const { hits = [] } = await res.json();
    muss(hits.some((h) => h.message?.id === deutsch.messageId),
      `"${wort}" führt nicht zur Sprachnachricht (${hits.length} Treffer)`);
    return `gefunden über "${wort}"`;
  });

  await pruefe('Die Abschrift steht lokal erzeugt in der Datenbank', async () => {
    muss(deutsch, 'die Aufnahme davor ist nicht durchgekommen');
    const zeile = inDerDatenbank((db) => db.prepare(
      'SELECT provider, model, lang, duration_ms FROM voice_transcripts WHERE attachment_id = ?',
    ).get(deutsch.anhang));
    muss(zeile, 'kein Eintrag in voice_transcripts');
    /* Das ist die eigentliche Zusage: nicht „es gibt eine Abschrift", sondern
       „sie ist hier entstanden". Steht hier "groq", ist die Aufnahme trotz
       lokalem Modell aus dem Haus gegangen. */
    muss(zeile.provider === 'lokal',
      `abgetippt bei "${zeile.provider}" statt auf diesem Rechner`);
    return `${zeile.provider} · ${zeile.model} · ${zeile.lang}`;
  });

  await pruefe('Englische Aufnahme wird als Englisch erkannt', async () => {
    const en = await sprachnachricht(offen, 'stimme-en.webm');
    zeiten.push(['englisch (3,9 s)', en.dauerMs]);
    muss(en.voice.transcript, 'keine Abschrift zurückgekommen');
    muss(en.voice.transcriptLang === 'en', `Sprache "${en.voice.transcriptLang}" statt "en"`);
    muss(/report|finished|tomorrow|morning/i.test(en.voice.transcript),
      `nichts Erwartetes im Text: "${en.voice.transcript}"`);
    return `${(en.dauerMs / 1000).toFixed(1)} s · "${en.voice.transcript.trim().slice(0, 46)}"`;
  });

  await pruefe('Spanische Aufnahme wird als Spanisch erkannt', async () => {
    const es = await sprachnachricht(offen, 'stimme-es.webm');
    zeiten.push(['spanisch (4,2 s)', es.dauerMs]);
    muss(es.voice.transcript, 'keine Abschrift zurückgekommen');
    muss(es.voice.transcriptLang === 'es', `Sprache "${es.voice.transcriptLang}" statt "es"`);
    return `${(es.dauerMs / 1000).toFixed(1)} s · "${es.voice.transcript.trim().slice(0, 46)}"`;
  });
}

/* ── Vertrauliche Kanäle ──────────────────────────────────────── */

console.log('\nVertrauliche Kanäle');

/* Der Kanal wird hier über die Datenbank auf vertraulich gestellt statt über
   die Schlüsselzeremonie der App. Für diese Prüfung zählt allein, was der
   Server sieht, wenn er den Kanal für vertraulich hält — und istVertraulich()
   liest genau diese Spalte, ohne Zwischenspeicher. */
const geheim = await kanalAnlegen('private', `stimme-geheim-${marke}`);
inDerDatenbank((db) => db.prepare('UPDATE channels SET vertraulich = 1 WHERE id = ?').run(geheim));

await pruefe('In einem vertraulichen Kanal gibt es keine Sprachnachricht', async () => {
  const anhang = await hochladen('stimme-de.webm');
  ich.senden({
    t: 'voice:send', clientId: `geheim-${marke}`,
    channelId: geheim, attachmentId: anhang, durationMs: 4000,
  });
  const antwort = await ich.warteAuf(
    (e) => (e.t === 'error') || (e.t === 'message:new' && e.clientId === `geheim-${marke}`),
    15000,
  );
  muss(antwort.t === 'error', 'die Sprachnachricht ist durchgegangen');
  const nichts = inDerDatenbank((db) => db.prepare(
    'SELECT count(*) AS n FROM voice_transcripts WHERE attachment_id = ?',
  ).get(anhang));
  muss(nichts.n === 0, 'es ist trotzdem eine Abschrift entstanden');
  return antwort.code ?? antwort.message?.slice(0, 40) ?? 'abgewiesen';
});

await pruefe('Auch nachträglich wird dort nicht abgetippt', async () => {
  /* Der schärfere Fall: die Nachricht entstand, als der Kanal noch offen war,
     und wird erst danach vertraulich. Ein "nochmal versuchen" darf die
     Aufnahme dann nicht mehr abtippen — die Sperre sitzt nicht nur im
     Gateway, sondern auch in transcribe() selbst. */
  const offen2 = await kanalAnlegen('private', `stimme-spaet-${marke}`);
  const anhang = await hochladen('stimme-de.webm');
  ich.senden({
    t: 'voice:send', clientId: `spaet-${marke}`,
    channelId: offen2, attachmentId: anhang, durationMs: 4000,
  });
  const neu = await ich.warteAuf(
    (e) => e.t === 'message:new' && e.clientId === `spaet-${marke}`, 20000,
  );
  // Erst warten, bis der erste Durchgang durch ist, dann zumachen.
  await ich.warteAuf((e) => e.t === 'voice:transcript' && e.messageId === neu.message.id);
  inDerDatenbank((db) => {
    db.prepare('UPDATE channels SET vertraulich = 1 WHERE id = ?').run(offen2);
    db.prepare('DELETE FROM voice_transcripts WHERE attachment_id = ?').run(anhang);
  });

  ich.senden({ t: 'voice:retranscribe', messageId: neu.message.id });
  await new Promise((f) => setTimeout(f, DA ? 12000 : 3000));
  const nichts = inDerDatenbank((db) => db.prepare(
    'SELECT count(*) AS n FROM voice_transcripts WHERE attachment_id = ?',
  ).get(anhang));
  muss(nichts.n === 0, 'die Aufnahme wurde trotzdem abgetippt');
  return 'transcribe() weist den vertraulichen Kanal selbst ab';
});

/* ── Bericht ──────────────────────────────────────────────────── */

if (zeiten.length) {
  console.log('\nGemessen');
  for (const [was, ms] of zeiten) {
    console.log(`  ${was.padEnd(18)} ${(ms / 1000).toFixed(1)} s`);
  }
}

ich.zu();
await probe.stop();

const gut = ergebnisse.filter(Boolean).length;
console.log(`\n${gut}/${ergebnisse.length} bestanden`
  + (uebersprungen.length ? `, ${uebersprungen.length} übersprungen (kein Sprachdienst)` : ''));
process.exit(gut === ergebnisse.length ? 0 : 1);
