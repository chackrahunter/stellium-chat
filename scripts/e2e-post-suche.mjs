#!/usr/bin/env node
/**
 * Die Volltextsuche über das Postfach — der bleibende Prüflauf.
 *
 * Belegt fünf Zusagen, nicht nur behauptet sie:
 *
 *   1. Eine Mail wird über ein Wort im BETREFF gefunden.
 *   2. Eine Mail wird über ein Wort im TEXT gefunden.
 *   3. Eine Mail, die das gesuchte Wort nirgends enthält, wird NICHT gefunden.
 *   4. Nach dem ENDGÜLTIGEN Löschen findet die Suche nichts mehr — und in der
 *      rohen Datenbankdatei steht das gesuchte Wort an keiner Stelle im
 *      Klartext (der Index trägt von Anfang an nur Fingerabdrücke, siehe
 *      unten, Punkt 3a).
 *   5. Eine Person ohne `mail.lesen` bekommt keine Treffer.
 *
 * Zusätzlich (nicht vom Auftrag verlangt, aber Teil derselben Entscheidung
 * und deshalb hier mitbewiesen, siehe services/post-suche.ts Dateikopf):
 * Suche über den ABSENDER, über das FACH und über einen ANHANGNAMEN.
 *
 * WARUM ÜBER DEN LAUFENDEN SERVER (probeserver), NICHT NUR über den Dienst
 *
 * Zusage 5 ist eine Frage der RECHTEPRÜFUNG — die sitzt in http/routes.ts
 * (`requirePermission(..., 'mail.lesen')`), nicht in services/post-suche.ts
 * selbst (siehe dort, Dateikopf: „prüft keine Rechte"). Ein Prüflauf, der nur
 * den Dienst direkt aufriefe, könnte diese Zusage gar nicht einlösen — er
 * liefe an der Stelle vorbei, an der die Berechtigung tatsächlich entschieden
 * wird. Deshalb läuft dieser gesamte Lauf über die echte Route
 * (`GET /api/post/suche`) gegen einen echten, laufenden Server, mit einem
 * echten zweiten Konto ohne das Recht — dieselbe Bauart wie Abschnitt 3 in
 * e2e-post-anhaenge.mjs (dort ebenfalls: „member"-Konto, `mail.lesen` fehlt
 * von Haus aus, siehe packages/shared/src/permissions.ts, MITGLIED).
 *
 * Gesät wird die Post trotzdem direkt über services/post.ts
 * (`eingangAufnehmen()`), nicht über `/api/post/eingang`: das Zusammenspiel
 * mit dem Cloudflare-Worker-Geheimnis prüft schon e2e-post-anhaenge.mjs,
 * hier geht es um die SUCHE über bereits angekommene Post. Server (Kind-
 * prozess) und dieser Lauf (der spätere `import` von `dist/services/post.js`)
 * teilen sich dieselbe Datenbank im WAL-Modus — mehrere Leser und ein
 * Schreiber stören einander nicht (siehe e2e-postfach.mjs für dieselbe
 * Begründung).
 *
 * Aufruf:  node scripts/e2e-post-suche.mjs
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { probeserver } from './probeserver.mjs';

process.env.STELLIUM_MASTER_PASSPHRASE ||= 'Probe-Postsuche-4711';

const probe = await probeserver();
const marke = Date.now().toString(36).slice(-6);

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/** Eine einzelne Zeile roh aus der Datenbank lesen — für die Prüfung, was
    WIRKLICH auf der Platte steht (dieselbe Bauart wie in e2e-postfach.mjs). */
function rohLesen(sql, ...params) {
  const d = new DatabaseSync(probe.datenbank, { readOnly: true });
  try { return d.prepare(sql).get(...params); } finally { d.close(); }
}

/* Erst jetzt den Dienst laden: DATA_DIR muss stehen, bevor config.ts gelesen
   wird. Der Server läuft weiter, siehe Dateikopf. */
process.env.DATA_DIR = probe.datenordner;
const { initDb } = await import('../packages/server/dist/db/index.js');
const P = await import('../packages/server/dist/services/post.js');

/* initDb() NOCH EINMAL, jetzt in DIESEM Prozess — nicht überflüssig.
   `db/index.ts` hält `db.fts` (ob FTS5 verfügbar ist) als Zustand DIESER
   Verbindung, gesetzt einzig in setupFts(), aufgerufen einzig aus initDb().
   Der Probeserver hat das in SEINEM (Kind-)Prozess längst erledigt — diesem
   Prozess hier, der post.js direkt importiert, um Post zu säen, fehlt dieser
   Schritt aber, und ohne ihn bräche reindexMail() (aufgerufen aus
   eingangAufnehmen()) sofort an der eigenen Wächterzeile `if (!db.fts) return;`
   ab: gesät wäre die Mail, im Suchindex stünde sie nie. initDb() ist genau
   für wiederholte Aufrufe gegen dieselbe, schon bestehende Datenbank gebaut
   (siehe migrate.ts, Dateikopf) — nichts hier führt zu doppelter Arbeit oder
   widersprüchlichem Zustand, nur `db.fts` wird jetzt auch in DIESEM Prozess
   wahr. */
initDb();

async function suche(q, kopf = probe.kopf) {
  const antwort = await fetch(`${probe.S}/api/post/suche?q=${encodeURIComponent(q)}`, { headers: kopf });
  return antwort;
}
async function sucheTreffer(q) {
  const r = await suche(q);
  muss(r.status === 200, `Suche nach "${q}" antwortete mit ${r.status} statt 200`);
  return (await r.json()).treffer;
}

/* ── 1) Betreff, Text, Absender, Fach, Anhangname ─────────────────── */

console.log('\nGefunden werden über …');

const BETREFFWORT = `Betreffwort${marke}`;
const TEXTWORT = `Textwort${marke}`;
const ABSENDERWORT = `absenderwort${marke}`;
const ANHANGWORT = `Anhangwort${marke}`;
const NICHT_ENTHALTEN = `Niemalsdrin${marke}`;

const mailBetreff = P.eingangAufnehmen({
  an: 'support@stellium.club', von: `kunde-${marke}@kunde.example`,
  betreff: `Frage — ${BETREFFWORT}`, text: 'Ein ganz gewöhnlicher Text ohne Auffälligkeiten.',
  messageId: `<betreff-${marke}@kunde.example>`, pruefung: 'dmarc=pass',
});

const mailText = P.eingangAufnehmen({
  an: 'support@stellium.club', von: `kunde2-${marke}@kunde.example`,
  betreff: 'Eine andere Anfrage', text: `Mitten im Text steht ${TEXTWORT}, sonst nichts Besonderes.`,
  messageId: `<text-${marke}@kunde.example>`, pruefung: 'dmarc=pass',
});

const mailAbsender = P.eingangAufnehmen({
  an: 'sales@stellium.club', von: `${ABSENDERWORT}@kunde.example`,
  betreff: 'Angebot gewünscht', text: 'Bitte ein Angebot zusenden.',
  messageId: `<absender-${marke}@kunde.example>`, pruefung: 'dmarc=pass',
});

const mailFach = P.eingangAufnehmen({
  an: 'billing@stellium.club', von: `rechnung-${marke}@kunde.example`,
  betreff: 'Zahlungseingang', text: 'Vielen Dank für die Zahlung.',
  messageId: `<fach-${marke}@kunde.example>`, pruefung: 'dmarc=pass',
});

const mailAnhang = P.eingangAufnehmen({
  an: 'jobs@stellium.club', von: `bewerbung-${marke}@kunde.example`,
  betreff: 'Bewerbung', text: 'Anbei meine Unterlagen.',
  messageId: `<anhang-${marke}@kunde.example>`, pruefung: 'dmarc=pass',
  anhaenge: [{
    name: `${ANHANGWORT}.pdf`, typ: 'application/pdf', groesse: 4096,
    inhalt: Buffer.from('%PDF-1.4 Platzhalter').toString('base64'),
  }],
});

await pruefe('… ein Wort im BETREFF', async () => {
  const treffer = await sucheTreffer(BETREFFWORT);
  muss(treffer.some((t) => t.id === mailBetreff.id), `Mail mit "${BETREFFWORT}" im Betreff nicht gefunden`);
  return `${treffer.length} Treffer`;
});

await pruefe('… ein Wort im TEXT', async () => {
  const treffer = await sucheTreffer(TEXTWORT);
  muss(treffer.some((t) => t.id === mailText.id), `Mail mit "${TEXTWORT}" im Text nicht gefunden`);
  return `${treffer.length} Treffer`;
});

await pruefe('… den ABSENDER (nicht in Betreff oder Text erwähnt)', async () => {
  const treffer = await sucheTreffer(ABSENDERWORT);
  muss(treffer.some((t) => t.id === mailAbsender.id), `Mail von "${ABSENDERWORT}@…" nicht über den Absender gefunden`);
  return `${treffer.length} Treffer`;
});

await pruefe('… das FACH (z. B. "billing", ohne dass das Wort im Text steht)', async () => {
  const treffer = await sucheTreffer('billing');
  muss(treffer.some((t) => t.id === mailFach.id), 'Mail im Fach "billing" nicht über das Fach gefunden');
  return `${treffer.length} Treffer`;
});

await pruefe('… den Namen eines ANHANGS', async () => {
  const treffer = await sucheTreffer(ANHANGWORT);
  muss(treffer.some((t) => t.id === mailAnhang.id), `Mail mit Anhang "${ANHANGWORT}.pdf" nicht über den Namen gefunden`);
  return `${treffer.length} Treffer`;
});

/* ── 2) Nicht gefunden, wenn das Wort nirgends steht ──────────────── */

console.log('\nNicht gefunden');

await pruefe('Eine Mail ohne das gesuchte Wort taucht nicht auf', async () => {
  const treffer = await sucheTreffer(NICHT_ENTHALTEN);
  muss(treffer.length === 0, `${treffer.length} Treffer für ein Wort, das in keiner gesäten Mail vorkommt`);
});

await pruefe('Umgekehrt: dieselbe Mail wird über kein FREMDES Wort gefunden', async () => {
  const treffer = await sucheTreffer(TEXTWORT);
  muss(!treffer.some((t) => t.id === mailBetreff.id), 'die Betreff-Mail tauchte bei einer Suche nach dem Textwort der ANDEREN Mail auf');
});

/* ── 3) Endgültig gelöscht: weder Treffer noch Klartext ───────────── */

console.log('\nEndgültig gelöscht: weder Treffer noch Klartext in der Datenbankdatei');

await pruefe('3a) VOR dem Löschen: im Suchindex selbst steht kein Klartext, nur ein Fingerabdruck', async () => {
  const zeile = rohLesen('SELECT body FROM mail_fts WHERE mail_id = ?', mailBetreff.id);
  muss(Boolean(zeile), 'die Mail hat noch gar keine Zeile im Suchindex — die Prüfung darunter wäre gegenstandslos');
  muss(!zeile.body.includes(BETREFFWORT),
    `der Suchindex enthält "${BETREFFWORT}" im Klartext: "${zeile.body.slice(0, 80)}…"`);
  return 'nur Fingerabdrücke im Index';
});

await pruefe('3b) Die Suche findet die Mail (Vorbedingung für die Prüfung danach)', async () => {
  const treffer = await sucheTreffer(BETREFFWORT);
  muss(treffer.some((t) => t.id === mailBetreff.id), 'Vorbedingung verletzt — die Mail war schon vor dem Löschen nicht auffindbar');
});

await pruefe('3c) DELETE /api/post/nachricht/:id (mail.verwalten) löscht endgültig', async () => {
  // Nur die Bearer-Kopfzeile, kein "content-type: application/json" ohne
  // Rumpf -- Fastifys JSON-Parser lehnt einen LEEREN Rumpf bei gesetztem
  // JSON-Content-Type ab (400). Derselbe Grund, aus dem postFetch() in
  // PostPanel.tsx den Kopf nur setzt, wenn wirklich ein Rumpf mitgeht, und
  // e2e-post-anhaenge.mjs seine DELETE-Aufrufe ebenso ohne content-type schickt.
  const r = await fetch(`${probe.S}/api/post/nachricht/${mailBetreff.id}`, {
    method: 'DELETE', headers: { authorization: probe.kopf.authorization },
  });
  muss(r.status === 200, `Status ${r.status} statt 200`);
  const ok = (await r.json()).ok;
  muss(ok === true, 'die Antwort meldet nicht ok:true');
});

await pruefe('3d) NACH dem Löschen: die Suche nach demselben Wort findet nichts mehr', async () => {
  const treffer = await sucheTreffer(BETREFFWORT);
  muss(treffer.length === 0, `${treffer.length} Treffer, obwohl die Mail endgültig gelöscht ist`);
});

await pruefe('3e) NACH dem Löschen: der Suchindex hat keine Zeile mehr für diese Mail', async () => {
  const zeile = rohLesen('SELECT 1 AS x FROM mail_fts WHERE mail_id = ?', mailBetreff.id);
  muss(!zeile, 'mail_fts trägt noch eine Zeile für eine endgültig gelöschte Mail');
});

await pruefe('3f) NACH dem Löschen: das Wort steht an KEINER Stelle mehr im Klartext in der Datenbankdatei', async () => {
  // post.mailsHartLoeschen() checkpointet selbst (PRAGMA wal_checkpoint(TRUNCATE))
  // — die Hauptdatei ist damit maßgeblich, siehe services/post.ts.
  const inhalt = fs.readFileSync(probe.datenbank);
  muss(inhalt.indexOf(Buffer.from(BETREFFWORT, 'utf8')) === -1,
    `"${BETREFFWORT}" steht noch lesbar in der Datenbankdatei`);
  for (const nebendatei of [`${probe.datenbank}-wal`, `${probe.datenbank}-journal`]) {
    if (!fs.existsSync(nebendatei)) continue;
    const n = fs.readFileSync(nebendatei);
    muss(n.indexOf(Buffer.from(BETREFFWORT, 'utf8')) === -1, `"${BETREFFWORT}" steht noch in ${nebendatei.split('/').pop()}`);
  }
  return 'kein Klartext mehr in der Datei';
});

/* ── 4) Ohne mail.lesen keine Treffer ─────────────────────────────── */

console.log('\nOhne mail.lesen keine Treffer');

/* Dieselbe Bauart wie in e2e-post-anhaenge.mjs, Abschnitt 3: ein frisches
   Konto mit der Vorgaberolle "member" — die kennt `mail.lesen` von Haus aus
   nicht (packages/shared/src/permissions.ts, MITGLIED). */
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
  return { token: sitzung.token };
})();

await pruefe('Ein "member"-Konto hat von Haus aus kein mail.lesen', async () => {
  const r = await fetch(`${probe.S}/api/post/faecher`, { headers: { authorization: `Bearer ${kollege.token}` } });
  muss(r.status === 403, `Status ${r.status} — die Vorbedingung für diese Prüfung stimmt nicht mehr`);
});

await pruefe('Dieselbe Suche, mit dem Konto ohne mail.lesen: 403, keine Treffer', async () => {
  const r = await suche(TEXTWORT, { authorization: `Bearer ${kollege.token}` });
  muss(r.status === 403, `Status ${r.status} statt 403 — die Suche lieferte Treffer an jemanden ohne mail.lesen`);
  const rumpf = await r.text();
  muss(!rumpf.includes(TEXTWORT), 'der Rumpf einer 403-Antwort verrät trotzdem den Inhalt einer Mail');
});

await pruefe('Ganz ohne Anmeldung: 401, kein Ratespiel über die Suche', async () => {
  const r = await suche(TEXTWORT, {});
  muss(r.status === 401, `Status ${r.status} statt 401`);
});

/* ── Ergebnis ──────────────────────────────────────────────────────── */

await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
