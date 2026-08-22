#!/usr/bin/env node
/**
 * Anhänge im Postfach — der Sicherheitsnachweis.
 *
 * Ein Anhang aus fremder Post ist die gefährlichste Datei im ganzen System:
 * er kommt von jemandem, den niemand kennt, und landet auf dem Rechner eines
 * Kollegen. Dieser Prüflauf simuliert genau diesen Weg — über die echte
 * Route, mit der sich der Cloudflare-Worker ausweist (`/api/post/eingang`,
 * dasselbe geteilte Geheimnis, derselbe Rumpf wie in
 * server-setup/postfach/worker/src/index.ts) — und weist danach über die
 * echte Auslieferungsroute (`/api/post/anhang/:id`) drei Zusagen nach:
 *
 *   1. Ein als "bild.png" getarnter HTML-Anhang geht nie als HTML oder Bild
 *      hinaus — immer `application/octet-stream` mit erzwungenem Download,
 *      unabhängig davon, was der Absender behauptet.
 *   2. Ein Dateiname mit `../` (oder mit einer Rechts-nach-links-Kennung, die
 *      eine Endung umkehren würde) bricht nirgends aus dem Ablageordner aus —
 *      weder auf der Platte noch im ausgelieferten Namen.
 *   3. Wer die Mail nicht lesen darf, bekommt den Anhang auch mit der
 *      direkten Adresse nicht — weder mit Kopfzeile noch mit `?token=`.
 *
 * WARUM ÜBER DIE ECHTE EINGANGSROUTE, NICHT NUR eingangAufnehmen()
 *
 * e2e-postfach.mjs prüft den Dienst direkt und begründet das dort ausführlich
 * (kein Netzzugriff nötig für die reine Ablauflogik). Hier geht es aber genau
 * um das Zusammenspiel aus Türsteher (posteingang.ts: Geheimnis, Feldgrößen,
 * Typen) und Dienst (post.ts: unabhängige Größenprüfung, Ablage, saubere
 * Namen) UND um die tatsächlich ausgelieferten HTTP-Kopfzeilen — das lässt
 * sich nur über den echten Weg zeigen, den auch der Worker nimmt.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

const probe = await probeserver();
const marke = Date.now().toString(36).slice(-6);

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

function rohLesen(sql, ...params) {
  const d = new DatabaseSync(probe.datenbank, { readOnly: true });
  try { return d.prepare(sql).get(...params); } finally { d.close(); }
}

/* ── Vorbereitung: einen Eingangszugang einrichten ──────────────────
   Ohne `mail.eingang` weist die Route mit 503 ab (siehe posteingang.ts,
   "fail closed") — das ist selbst schon eine kleine, aber nicht diese
   Prüfung. Also erst regulär über die API einrichten, wie es die
   Postfach-Einstellungen auch täten. */

const GEHEIMNIS = `probe-eingang-geheimnis-${marke}-${crypto.randomBytes(8).toString('hex')}`;

await pruefe('Eingangsgeheimnis lässt sich einrichten', async () => {
  const r = await fetch(`${probe.S}/api/post/zugang`, {
    method: 'POST', headers: probe.kopf, body: JSON.stringify({ eingangGeheimnis: GEHEIMNIS }),
  });
  muss(r.status === 200, `Status ${r.status}`);
  const stand = await r.json();
  muss(stand.eingangBereit === true, 'eingangBereit steht nicht auf true');
});

/** Eine Mail über die echte Route einliefern — wie der Cloudflare-Worker es täte. */
async function alsWorkerEinliefern(rumpf) {
  const antwort = await fetch(`${probe.S}/api/post/eingang`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-stellium-eingang': GEHEIMNIS,
      'x-stellium-schluessel': `zs-${marke}-${crypto.randomBytes(6).toString('hex')}`,
    },
    body: JSON.stringify(rumpf),
  });
  const daten = await antwort.json().catch(() => ({}));
  return { status: antwort.status, ...daten };
}

/* ── Die Mail mit drei bösartig benannten/typisierten Anhängen ────── */

const HTML_ALS_BILD = `<!doctype html><html><body><script>window.__ANGRIFF_${marke}__=1;</script>PRUEFMARKE-${marke}</body></html>`;
const AUSBRUCH_TEXT = `Wenn das hier irgendwo außerhalb der Ablage läge, wäre das ein Fund. ${marke}`;
const RTLO_TEXT = `Inhalt einer Datei mit umgekehrter Endung. ${marke}`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/* U+202E dreht die folgenden Zeichen von rechts nach links — "rechnung txt.exe"
   erschiene ohne Bereinigung als "rechnung exe.txt", die Endung ".exe" also
   versteckt hinter einer vorgetäuschten ".txt". */
const RTLO = '‮';
const NAME_BILD = 'bild.png';
const NAME_AUSBRUCH = '../../../../../../../../tmp/ausgebrochen.txt';
const NAME_RTLO = `rechnung${RTLO}txt.exe`;

let mailId = null;
let anhaenge = null;

await pruefe('Die Mail mit den drei Anhängen kommt über die echte Route an', async () => {
  const r = await alsWorkerEinliefern({
    an: 'support@stellium.club',
    von: `angreifer-${marke}@fremd.example`,
    betreff: `Anhangprüfung ${marke}`,
    text: `Testmail für den Sicherheitsnachweis. ${marke}`,
    messageId: `<anhang-${marke}@fremd.example>`,
    pruefung: 'dmarc=pass',
    anhaenge: [
      {
        name: NAME_BILD, typ: 'image/png', groesse: Buffer.byteLength(HTML_ALS_BILD), uebergross: false,
        inhalt: b64(HTML_ALS_BILD),
      },
      {
        name: NAME_AUSBRUCH, typ: 'text/plain', groesse: Buffer.byteLength(AUSBRUCH_TEXT), uebergross: false,
        inhalt: b64(AUSBRUCH_TEXT),
      },
      {
        name: NAME_RTLO, typ: 'application/octet-stream', groesse: Buffer.byteLength(RTLO_TEXT), uebergross: false,
        inhalt: b64(RTLO_TEXT),
      },
    ],
  });
  muss(r.status === 200, `Status ${r.status}: ${JSON.stringify(r).slice(0, 200)}`);
  muss(typeof r.id === 'string' && r.id, 'keine Mail-Kennung in der Antwort');
  mailId = r.id;
});

await pruefe('Die Mail zeigt drei Anhänge mit Downloadkennung', async () => {
  const r = await fetch(`${probe.S}/api/post/nachricht/${mailId}`, { headers: probe.kopf });
  muss(r.status === 200, `Status ${r.status}`);
  const { nachricht } = await r.json();
  anhaenge = nachricht.anhaenge;
  muss(Array.isArray(anhaenge) && anhaenge.length === 3, `${anhaenge?.length} Anhänge statt 3`);
  muss(anhaenge.every((a) => typeof a.id === 'string' && a.id), 'mindestens ein Anhang ohne Kennung — Bytes kamen nicht an');
  return anhaenge.map((a) => a.name).join(', ');
});

// Über den bereits BEREINIGTEN Namen gesucht, nicht über die Größe: das
// prüft nebenbei mit, dass die Übersicht aus GET /api/post/nachricht/:id
// denselben sauberen Namen zeigt wie die Datenbankzeile weiter unten.
const anhangBild = anhaenge?.find((a) => a.name === 'bild.png');
const anhangAusbruch = anhaenge?.find((a) => a.name === 'ausgebrochen.txt');
const anhangRtlo = anhaenge?.find((a) => a.name === 'rechnung_txt.exe');

/* ── 1) Ein als bild.png getarnter HTML-Anhang geht nie als HTML hinaus ── */

console.log('\n1) Nie als HTML oder Bild ausgeliefert, immer erzwungener Download');

await pruefe('Content-Type ist application/octet-stream, nicht text/html oder image/png', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangBild.id}`, { headers: probe.kopf });
  muss(r.status === 200, `Status ${r.status}`);
  const typ = r.headers.get('content-type') ?? '';
  muss(typ.startsWith('application/octet-stream'), `Content-Type ist "${typ}"`);
  muss(!typ.includes('html'), `Content-Type verrät HTML: "${typ}"`);
  muss(!typ.includes('image'), `Content-Type verrät ein Bild: "${typ}"`);
  return typ;
});

await pruefe('Content-Disposition erzwingt "attachment", nie "inline"', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangBild.id}`, { headers: probe.kopf });
  const disp = r.headers.get('content-disposition') ?? '';
  muss(disp.startsWith('attachment'), `Content-Disposition ist "${disp}"`);
  muss(!disp.includes('inline'), `Content-Disposition erlaubt inline: "${disp}"`);
  muss(disp.includes(encodeURIComponent(NAME_BILD)), `Dateiname fehlt in "${disp}"`);
  return disp;
});

await pruefe('X-Content-Type-Options: nosniff ist gesetzt', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangBild.id}`, { headers: probe.kopf });
  const wert = r.headers.get('x-content-type-options');
  muss(wert === 'nosniff', `Kopfzeile ist "${wert}"`);
});

await pruefe('Die Bytes selbst kommen unverändert an — kein stilles Beschädigen statt Absichern', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangBild.id}`, { headers: probe.kopf });
  const text = await r.text();
  muss(text === HTML_ALS_BILD, 'Inhalt weicht vom Original ab');
  return `${text.length} Byte, bytegleich`;
});

/* ── 2) Kein Ausbruch aus dem Ablageordner ──────────────────────────── */

console.log('\n2) Kein Ausbruch aus dem Ablageordner, keine Rechts-nach-links-Täuschung');

await pruefe('Der ausgelieferte Name enthält kein "../" mehr — path.basename() hat es entfernt', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangAusbruch.id}`, { headers: probe.kopf });
  const disp = r.headers.get('content-disposition') ?? '';
  muss(!disp.includes('..'), `Content-Disposition enthält noch ".." — "${disp}"`);
  muss(!disp.includes('%2F') && !disp.includes('/'), `Content-Disposition enthält noch einen Pfadtrenner — "${disp}"`);
  muss(disp.includes('ausgebrochen.txt'), `Erwarteter Rumpfname fehlt in "${disp}"`);
  return disp;
});

await pruefe('Auf der Platte liegt die Datei NUR unter dem eigenen Zwischenordner, nirgends sonst', async () => {
  const zeile = rohLesen('SELECT path, name FROM mail_anhaenge WHERE id = ?', anhangAusbruch.id);
  muss(Boolean(zeile), 'keine Zeile in mail_anhaenge — der Anhang wurde gar nicht abgelegt');
  const aufgeloest = path.resolve(zeile.path);
  const uploadOrdner = path.resolve(probe.datenordner, 'uploads');
  muss(path.dirname(aufgeloest) === uploadOrdner,
    `Pfad liegt bei "${aufgeloest}", erwartet direkt unter "${uploadOrdner}"`);
  muss(!zeile.path.includes('..'), `Der gespeicherte Pfad selbst enthält noch ".." — "${zeile.path}"`);
  // Der Name in der Datenbank ist NICHT der Dateisystempfad -- er dient nur
  // der Anzeige und ist trotzdem bereinigt (saubererDateiname()).
  muss(!zeile.name.includes('..') && !zeile.name.includes('/'),
    `Der gespeicherte Anzeigename ist nicht bereinigt: "${zeile.name}"`);

  // Die Gegenprobe: liegt irgendwo AUSSERHALB der Ablage eine Datei mit
  // unserer Kennmarke? Eine naive `path.join(ordner, name)`-Verkettung ohne
  // path.basename() hätte genau das erzeugt.
  const kandidaten = [
    path.resolve(probe.datenordner, '..', '..', '..', '..', '..', '..', 'tmp', 'ausgebrochen.txt'),
    path.join(os.tmpdir(), 'ausgebrochen.txt'),
  ];
  for (const kandidat of kandidaten) {
    if (!fs.existsSync(kandidat)) continue;
    const inhalt = fs.readFileSync(kandidat, 'utf8');
    muss(!inhalt.includes(marke), `Datei mit unserer Kennmarke liegt AUSSERHALB der Ablage: ${kandidat}`);
  }
  return `liegt korrekt unter ${uploadOrdner}`;
});

await pruefe('Der Download unter der bereinigten Kennung liefert trotzdem den richtigen Inhalt', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangAusbruch.id}`, { headers: probe.kopf });
  muss(r.status === 200, `Status ${r.status}`);
  const text = await r.text();
  muss(text === AUSBRUCH_TEXT, 'Inhalt weicht vom Original ab — bereinigt heißt nicht kaputt');
});

await pruefe('Eine Rechts-nach-links-Kennung, die die Endung umkehren würde, wird entfernt', async () => {
  const zeile = rohLesen('SELECT name FROM mail_anhaenge WHERE id = ?', anhangRtlo.id);
  muss(Boolean(zeile), 'keine Zeile in mail_anhaenge');
  muss(!zeile.name.includes(RTLO), `U+202E steht noch im gespeicherten Namen: "${zeile.name}"`);
  muss(zeile.name === 'rechnung_txt.exe', `Name wurde zu "${zeile.name}" bereinigt, erwartet "rechnung_txt.exe"`);

  const r = await fetch(`${probe.S}/api/post/anhang/${anhangRtlo.id}`, { headers: probe.kopf });
  const disp = r.headers.get('content-disposition') ?? '';
  muss(!disp.includes('%E2%80%AE') && !disp.toLowerCase().includes('e2 80 ae'),
    `Die ausgelieferte Kopfzeile enthält noch die Override-Kennung: "${disp}"`);
  return zeile.name;
});

/* ── 3) Rechteprüfung — auch mit der direkten Adresse ───────────────── */

console.log('\n3) Wer die Mail nicht lesen darf, bekommt den Anhang auch mit direkter Adresse nicht');

const kollege = await (async () => {
  const neu = await (await fetch(`${probe.S}/api/admin/users`, {
    method: 'POST', headers: probe.kopf,
    body: JSON.stringify({
      displayName: `Ohne Postrecht ${marke}`, handle: `ohnepost${marke}`, role: 'member', language: 'de',
    }),
  })).json();
  const erste = await (await fetch(`${probe.S}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: neu.credential.handle, password: neu.credential.oneTimePassword }),
  })).json();
  const passwort = `Kollege-${marke}-${crypto.randomBytes(6).toString('hex')}`;
  await fetch(`${probe.S}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${erste.token}` },
    body: JSON.stringify({ newPassword: passwort }),
  });
  const sitzung = await (await fetch(`${probe.S}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: neu.credential.handle, password: passwort }),
  })).json();
  return { token: sitzung.token, handle: neu.credential.handle };
})();

await pruefe('Ein "member"-Konto hat von Haus aus kein mail.lesen', async () => {
  const r = await fetch(`${probe.S}/api/post/faecher`, { headers: { authorization: `Bearer ${kollege.token}` } });
  muss(r.status === 403, `Status ${r.status} — die Vorbedingung für diese Prüfung stimmt nicht mehr`);
});

await pruefe('Mit Bearer-Kopfzeile: 403, kein Anhang', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangBild.id}`, {
    headers: { authorization: `Bearer ${kollege.token}` },
  });
  muss(r.status === 403, `Status ${r.status} statt 403`);
  const rumpf = await r.text();
  muss(!rumpf.includes(marke), 'der Rumpf einer 403-Antwort trägt trotzdem den Anhangsinhalt');
});

await pruefe('Mit dem Nachweis in der Adresse (?token=), wie ein Downloadlink ihn nutzt: ebenfalls 403', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangBild.id}?token=${encodeURIComponent(kollege.token)}`);
  muss(r.status === 403, `Status ${r.status} statt 403`);
});

await pruefe('Ganz ohne Anmeldung: 401, kein Ratespiel über einen Anhang', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangBild.id}`);
  muss(r.status === 401, `Status ${r.status} statt 401`);
});

await pruefe('Zum Vergleich: mit echtem mail.lesen (Inhaber) geht derselbe Anhang durch', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${anhangBild.id}`, { headers: probe.kopf });
  muss(r.status === 200, `Status ${r.status} — die Route selbst ist kaputt, nicht nur die Rechteprüfung`);
});

await pruefe('Eine erfundene Anhangskennung meldet 404, nicht 500 oder eine Ausnahme', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/ma_erfunden_${marke}`, { headers: probe.kopf });
  muss(r.status === 404, `Status ${r.status} statt 404`);
});

/* ── 4) Ausgehende Anhänge: hochladen, Eigentum, verwerfen ─────────
 *
 * senden() selbst bleibt unangetastet (ruft den echten Resend-Dienst auf —
 * dieselbe Zurückhaltung wie in e2e-postfach.mjs begründet), aber der Weg
 * DAHIN — hochladen, bevor die Mail existiert, und wieder verwerfen, wenn
 * das Schreibfenster ohne zu senden schließt — läuft vollständig ohne
 * Netzzugriff und wird hier geprüft.
 */

console.log('\n4) Ausgehende Anhänge — hochladen, Eigentum, verwerfen');

let ausgehenderId = null;

await pruefe('Ein Anhang lässt sich für eine noch nicht gesendete Mail hochladen', async () => {
  const form = new FormData();
  form.append('file', new Blob([`Entwurfsanhang ${marke}`], { type: 'text/plain' }), 'entwurf.txt');
  const r = await fetch(`${probe.S}/api/post/anhang`, {
    method: 'POST', headers: { authorization: `Bearer ${probe.token}` }, body: form,
  });
  muss(r.status === 200, `Status ${r.status}`);
  const { anhang } = await r.json();
  muss(typeof anhang?.id === 'string' && anhang.id, 'keine Kennung in der Antwort');
  ausgehenderId = anhang.id;
  return anhang.id;
});

await pruefe('Er hängt noch an KEINER Mail (mail_id NULL), bis wirklich gesendet wird', () => {
  const zeile = rohLesen('SELECT mail_id, uploaded_by FROM mail_anhaenge WHERE id = ?', ausgehenderId);
  muss(Boolean(zeile), 'keine Zeile');
  muss(zeile.mail_id === null, `mail_id ist bereits "${zeile.mail_id}" — vor dem Senden verknüpft?`);
});

await pruefe('Vor dem Verschicken ist er über die normale Route noch nicht abrufbar (404)', async () => {
  const r = await fetch(`${probe.S}/api/post/anhang/${ausgehenderId}`, { headers: probe.kopf });
  muss(r.status === 404, `Status ${r.status} statt 404 — ein unverschickter Entwurfsanhang wäre sonst öffentlich lesbar`);
});

await pruefe('Ein fremdes Konto kann einen nicht selbst hochgeladenen Anhang nicht verwerfen', async () => {
  // "kollege" hat zwar kein mail.senden, aber genau DAS ist hier der Punkt:
  // Eigentum wird zusätzlich zur Berechtigung geprüft, nicht ersatzweise.
  const r = await fetch(`${probe.S}/api/post/anhang/${ausgehenderId}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${kollege.token}` },
  });
  muss(r.status === 403 || r.status === 404, `Status ${r.status} — ein fremdes Konto kam durch`);
  const zeile = rohLesen('SELECT id FROM mail_anhaenge WHERE id = ?', ausgehenderId);
  muss(Boolean(zeile), 'die Zeile ist weg — ein fremdes Konto konnte sie doch löschen');
});

await pruefe('Der Hochlader selbst kann ihn verwerfen — Zeile UND Datei sind danach weg', async () => {
  const zeileVorher = rohLesen('SELECT path FROM mail_anhaenge WHERE id = ?', ausgehenderId);
  // NICHT probe.kopf: das trägt "content-type: application/json" mit, und
  // ein DELETE ganz ohne Rumpf weist Fastify damit schon mit 400 ab, bevor
  // die Route überhaupt drankommt (derselbe Fallstrick, den net/api.ts an
  // seinem eigenen request() dokumentiert).
  const r = await fetch(`${probe.S}/api/post/anhang/${ausgehenderId}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${probe.token}` },
  });
  muss(r.status === 200, `Status ${r.status}`);
  const zeileNachher = rohLesen('SELECT id FROM mail_anhaenge WHERE id = ?', ausgehenderId);
  muss(!zeileNachher, 'die Datenbankzeile besteht noch');
  /* Das Wegräumen der DATEI ist absichtlich "fire and forget"
     (fs.promises.rm(...).catch(() => {}), ohne await — genau wie bei
     files.ts::deleteFile(), siehe dort) und läuft deshalb nicht zwingend vor
     der HTTP-Antwort ab. Deshalb kurz nachfassen statt sofort zu urteilen. */
  const bis = Date.now() + 2000;
  while (fs.existsSync(zeileVorher.path) && Date.now() < bis) {
    await new Promise((f) => setTimeout(f, 100));
  }
  if (fs.existsSync(zeileVorher.path)) {
    throw new Error(`Die Datei liegt auch nach 2 s noch auf der Platte: ${zeileVorher.path}`);
  }
});

/* ── Aufräumen ──────────────────────────────────────────────────── */

await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
