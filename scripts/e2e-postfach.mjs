/**
 * Das Unternehmenspostfach — geprüft am Dienst selbst.
 *
 * WARUM NICHT ÜBER DIE OBERFLÄCHE ODER ÜBER `/api/post/eingang`
 *
 * Der Dienst (`services/post.ts`) enthält die ganze Prüflogik: Fächer,
 * Dublettensperre, die Abwehr gegen eingeschleuste Kopfzeilen, die Regeln
 * fürs Beitreten zu einem Verlauf, das Lernen der Briefpartnersprache, die
 * Zeitklemme und die Deckelung von `liste()`. Der Webhook-Weg käme nur mit
 * dem Geheimnis des Cloudflare-Workers hinein und würde denselben Code am
 * Ende ohnehin nur über eine zusätzliche Schicht aufrufen. Geprüft wird
 * deshalb `eingangAufnehmen()` & Co. direkt — wie schon in e2e-vorschlaege.mjs.
 *
 * WARUM KEIN NETZZUGRIFF
 *
 * `senden()` ruft den externen Versanddienst (Resend) auf. Dieser Prüflauf
 * rührt `senden()` deshalb nicht an — geprüft wird nur, was ohne ihn geht:
 * der Eingang, die Ablage, das Lesen.
 *
 * WARUM DAS MASTERPASSWORT VOR `probeserver()` GESETZT WIRD
 *
 * Ohne Masterpasswort ist `verschluesseln()` ein No-Op, und die Prüfung
 * „liegt verschlüsselt in der Datei" wäre gegenstandslos. Vor dem Start
 * gesetzt, damit Server (Kindprozess) und dieses Skript (der spätere
 * `import` von `dist/services/post.js`) denselben Schlüssel ableiten.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

process.env.STELLIUM_MASTER_PASSPHRASE ||= 'Probe-Postfach-4711';

const probe = await probeserver();
const marke = Date.now().toString(36).slice(-5);

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/** Eine einzelne Zeile roh aus der Datenbank lesen — für Prüfungen, die den
    Dienst umgehen und nachsehen müssen, was WIRKLICH auf der Platte steht. */
function rohLesen(sql, ...params) {
  const d = new DatabaseSync(probe.datenbank, { readOnly: true });
  try { return d.prepare(sql).get(...params); } finally { d.close(); }
}
function rohZaehlen(sql, ...params) {
  const d = new DatabaseSync(probe.datenbank, { readOnly: true });
  try { return d.prepare(sql).get(...params).n; } finally { d.close(); }
}

/* Erst jetzt den Dienst laden: DATA_DIR muss stehen, bevor config.ts gelesen
   wird. Der Server läuft weiter — SQLite arbeitet hier im WAL-Modus, mehrere
   Leser und ein Schreiber stören einander nicht (siehe e2e-vorschlaege.mjs). */
process.env.DATA_DIR = probe.datenordner;
const P = await import('../packages/server/dist/services/post.js');

/* ── 1) Eingang und Ablage ────────────────────────────────────── */

console.log('\nEingang und Ablage');

const MARKER1 = `Zwiebelkuchen${marke}`;
let ersteId = null;

await pruefe('Eine eingehende Mail wird aufgenommen und mit Klartext wiedergefunden', async () => {
  const ergebnis = P.eingangAufnehmen({
    an: 'support@stellium.club',
    von: `Kundin Meier <kundin-${marke}@kunde.example>`,
    betreff: `Frage zur Rechnung ${MARKER1}`,
    text: `Guten Tag, bitte prüfen Sie die Rechnung. ${MARKER1}`,
    html: `<p>Guten Tag, bitte prüfen Sie die Rechnung. ${MARKER1}</p>`,
    messageId: `<eingang-${marke}@kunde.example>`,
    pruefung: 'dmarc=pass',
    anhaenge: [{ name: 'Rechnung.pdf', typ: 'application/pdf', groesse: 12345, geheim: 'sollte verschwinden' }],
  });
  muss(!ergebnis.doppelt, 'als Dublette erkannt, obwohl neu');
  muss(typeof ergebnis.id === 'string' && ergebnis.id.length > 0, `unerwartete id "${ergebnis.id}"`);
  ersteId = ergebnis.id;

  const n = P.nachricht(ersteId);
  muss(n, 'die Mail lässt sich nicht wiederfinden');
  muss(n.richtung === 'ein', `Richtung "${n.richtung}"`);
  muss(n.von === `kundin-${marke}@kunde.example`, `von: "${n.von}" — die Vorname-Nachname-Form wurde nicht auf die nackte Adresse reduziert`);
  muss(n.an === 'support@stellium.club', `an: "${n.an}"`);
  muss(n.betreff === `Frage zur Rechnung ${MARKER1}`, `Betreff kam verändert zurück: "${n.betreff}"`);
  muss(n.text.includes(MARKER1), `Text kam verändert zurück: "${n.text}"`);
  muss(n.html && n.html.includes(MARKER1), `HTML kam verändert zurück: "${n.html}"`);
  muss(n.gelesen === false, 'eine frische Mail gilt schon als gelesen');
  muss(n.anhaenge.length === 1 && n.anhaenge[0].name === 'Rechnung.pdf', 'der Anhang fehlt oder ist falsch');
  muss(n.anhaenge[0].geheim === undefined, 'ein nicht vorgesehenes Feld ist am Anhang durchgerutscht — die Übernahme sollte nur Name/Typ/Größe kopieren');
  return n.betreff;
});

await pruefe('Der Klartext steht nirgends in der Datenbankdatei — nur das Chiffrat', async () => {
  const zeile = rohLesen('SELECT betreff, text, von FROM mail_nachrichten WHERE id = ?', ersteId);
  muss(String(zeile.betreff).startsWith('m1:'), `Betreff steht als "${String(zeile.betreff).slice(0, 20)}…" in der Spalte — kein Chiffrat`);
  muss(!String(zeile.text).includes(MARKER1), 'der Text steht im Klartext in der Spalte');
  muss(!String(zeile.von).includes(`kundin-${marke}`), 'der Absender steht im Klartext in der Spalte');
  const datei = fs.readFileSync(probe.datenbank);
  muss(!datei.includes(Buffer.from(MARKER1, 'utf8')), 'das Kennwort steht lesbar irgendwo in der Datenbankdatei');
  return 'nur Chiffrat in der Datei';
});

/* ── 2) Dubletten ──────────────────────────────────────────────
 *
 * Die Sperre hängt am Zustellschlüssel des Workers, nicht an der
 * Message-ID des Absenders (die ist vorhersagbar). Geprüft wird deshalb
 * auch der Gegenfall: gleicher Inhalt, andere Zustellschlüssel — das MUSS
 * zwei Zeilen ergeben, sonst hinge die Sperre am falschen Merkmal. */

console.log('\nDubletten');

await pruefe('Derselbe Zustellschlüssel ergibt beim zweiten Mal doppelt:true und keine zweite Zeile', async () => {
  const schluessel = `zs-${marke}-eins`;
  const roh = {
    an: 'support@stellium.club', von: `dup-${marke}@dup.example`,
    betreff: 'Dublettentest', text: 'Text einer eingehenden Mail.',
    messageId: `<dup-${marke}@dup.example>`, pruefung: 'dmarc=pass',
  };
  const erster = P.eingangAufnehmen(roh, schluessel);
  muss(erster.doppelt === false, 'die erste Zustellung galt schon als Dublette');
  const zweiter = P.eingangAufnehmen(roh, schluessel);
  muss(zweiter.doppelt === true, 'die zweite Zustellung mit demselben Schlüssel wurde als neu behandelt');
  muss(zweiter.id === erster.id, `andere id zurückgegeben: ${zweiter.id} statt ${erster.id}`);

  const anzahl = rohZaehlen('SELECT COUNT(*) AS n FROM mail_nachrichten WHERE zustell_schluessel = ?', schluessel);
  muss(anzahl === 1, `${anzahl} Zeilen mit diesem Zustellschlüssel statt einer`);
  return 'keine zweite Zeile';
});

await pruefe('Zwei verschiedene Zustellschlüssel legen zwei Zeilen an, selbst bei identischem Inhalt', async () => {
  const inhalt = {
    an: 'support@stellium.club', von: `dup2-${marke}@dup.example`,
    betreff: 'Gleicher Inhalt', text: 'Immer derselbe Text.',
    messageId: `<dup2-${marke}@dup.example>`, // absichtlich dieselbe Message-ID wie unten
    pruefung: 'dmarc=pass',
  };
  const a = P.eingangAufnehmen(inhalt, `zs-${marke}-a`);
  const b = P.eingangAufnehmen(inhalt, `zs-${marke}-b`);
  muss(a.id !== b.id, 'trotz unterschiedlicher Zustellschlüssel entstand nur eine Zeile');
  muss(b.doppelt === false, 'die zweite Zeile wurde als Dublette gemeldet — die Sperre hängt offenbar an der Message-ID statt am Zustellschlüssel');
  return 'zwei Zeilen, wie es der Zustellschlüssel vorgibt';
});

/* ── 3) Fächer ─────────────────────────────────────────────────── */

console.log('\nFächer');

await pruefe('Eine Mail an support@ landet im Fach support und zählt dort mit', async () => {
  const vorher = P.faecher().find((f) => f.fach === 'support') ?? { gesamt: 0, ungelesen: 0 };
  const { id } = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `fach1-${marke}@fach.example`,
    betreff: 'Supportanfrage', text: 'Ich brauche Hilfe.', pruefung: 'dmarc=pass',
    messageId: `<fach1-${marke}@fach.example>`,
  });
  const n = P.nachricht(id);
  muss(n.fach === 'support', `landete in "${n.fach}"`);
  const nachher = P.faecher().find((f) => f.fach === 'support');
  muss(nachher, 'das Fach "support" fehlt jetzt in der Liste');
  muss(nachher.gesamt === vorher.gesamt + 1, `gesamt: ${nachher.gesamt} statt ${vorher.gesamt + 1}`);
  muss(nachher.ungelesen === vorher.ungelesen + 1, `ungelesen: ${nachher.ungelesen} statt ${vorher.ungelesen + 1}`);
  return `${nachher.gesamt} insgesamt, ${nachher.ungelesen} ungelesen`;
});

await pruefe('Eine Mail an eine erfundene Adresse landet in sonstiges', async () => {
  const vorher = P.faecher().find((f) => f.fach === 'sonstiges')?.gesamt ?? 0;
  const { id } = P.eingangAufnehmen({
    an: `nicht-vorgesehen-${marke}@fach.example`, von: `fach2-${marke}@fach.example`,
    betreff: 'Irgendwas', text: 'Ein Text ohne bekanntes Fach.', pruefung: 'dmarc=pass',
    messageId: `<fach2-${marke}@fach.example>`,
  });
  const n = P.nachricht(id);
  muss(n.fach === 'sonstiges', `landete in "${n.fach}" statt in sonstiges`);
  const nachher = P.faecher().find((f) => f.fach === 'sonstiges')?.gesamt ?? 0;
  muss(nachher === vorher + 1, `gesamt: ${nachher} statt ${vorher + 1}`);
  return 'sonstiges';
});

await pruefe('Gelesen markieren senkt nur die Ungelesenen, nicht die Gesamtzahl', async () => {
  const { id } = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `fach3-${marke}@fach.example`,
    betreff: 'Noch eine Anfrage', text: 'Text.', pruefung: 'dmarc=pass',
    messageId: `<fach3-${marke}@fach.example>`,
  });
  const vorher = P.faecher().find((f) => f.fach === 'support');
  P.gelesenSetzen(id, true);
  const nachher = P.faecher().find((f) => f.fach === 'support');
  muss(nachher.gesamt === vorher.gesamt, `gesamt änderte sich auf ${nachher.gesamt}`);
  muss(nachher.ungelesen === vorher.ungelesen - 1, `ungelesen: ${nachher.ungelesen} statt ${vorher.ungelesen - 1}`);
  return 'gesamt unverändert, ungelesen um eins gesunken';
});

/* ── 4) Kopfzeilen-Prüfung ─────────────────────────────────────── */

console.log('\nKopfzeilen-Prüfung (Message-ID)');

let kopfZaehler = 0;
async function nurMessageId(messageId) {
  kopfZaehler += 1;
  const { id } = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `kopf${kopfZaehler}-${marke}@kopf.example`,
    betreff: 'Kopfzeilen-Probe', text: 'Text.', pruefung: 'dmarc=pass',
    messageId,
  });
  return P.nachricht(id).messageId;
}

await pruefe('Eine gültige Message-ID wird unverändert übernommen', async () => {
  const r = await nurMessageId('<a@b.tld>');
  muss(r === '<a@b.tld>', `wurde zu "${r}"`);
  return r;
});

await pruefe('Eingeschleuste Kopfzeilen in der Message-ID werden zu null — der wichtigste Fall', async () => {
  const r = await nurMessageId('<a@b.tld>\r\nBcc: boese@x.tld');
  muss(r === null, `wurde übernommen als "${r}" — eine ausgehende Antwort bekäme dadurch einen fremden Bcc-Empfänger`);
  return 'verworfen';
});

await pruefe('Ein Text ohne Message-ID-Form wird zu null', async () => {
  const r = await nurMessageId('kein-format');
  muss(r === null, `wurde übernommen als "${r}"`);
  return 'verworfen';
});

await pruefe('An der Längengrenze: 120 Zeichen gehen noch durch, 121 nicht mehr', async () => {
  const genau = `<${'a'.repeat(120)}@b.tld>`;
  const einZuViel = `<${'a'.repeat(121)}@b.tld>`;
  const r1 = await nurMessageId(genau);
  const r2 = await nurMessageId(einZuViel);
  muss(r1 === genau, `120 Zeichen wurden abgelehnt: "${r1}"`);
  muss(r2 === null, `121 Zeichen wurden trotzdem übernommen: "${r2}"`);
  return 'Grenze liegt bei 120';
});

/* ── 5) Verlauf ────────────────────────────────────────────────
 *
 * Beitreten darf nur, wer bestätigt ist UND dessen Domäne zu einem
 * Teilnehmer passt. Geprüft wird die Zusage in beide Richtungen: eine
 * berechtigte Antwort tritt bei, eine unbestätigte bleibt draußen, und
 * eine bestätigte aber domänenfremde Absenderin (der eigentliche
 * Angriffsfall aus der Doku von verlaufErlaubt) ebenfalls. */

console.log('\nVerlauf');

const domA = `firma-${marke}.de`;
const wurzelMsgId = `<wurzel-${marke}@${domA}>`;

await pruefe('Die erste Mail eines Verlaufs beginnt ihren eigenen Strang', async () => {
  const { id } = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `kunde@${domA}`,
    betreff: 'Anfrage zum Vertrag', text: 'Bitte um Rückmeldung.',
    messageId: wurzelMsgId, pruefung: 'dmarc=pass',
  });
  const n = P.nachricht(id);
  muss(n.threadId === wurzelMsgId, `threadId ist "${n.threadId}" statt der eigenen Message-ID`);
  return n.threadId;
});

await pruefe('Ein bestätigter Absender derselben Domäne tritt dem Verlauf bei', async () => {
  const antwort = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `kollege@${domA}`,
    betreff: 'Re: Anfrage zum Vertrag', text: 'Ich kümmere mich darum.',
    messageId: `<antwort-${marke}@${domA}>`, referenzen: wurzelMsgId,
    pruefung: 'dmarc=pass',
  });
  const n = P.nachricht(antwort.id);
  muss(n.threadId === wurzelMsgId, `eigener Strang "${n.threadId}" statt Beitritt zum Verlauf`);
  const strang = P.verlauf(wurzelMsgId);
  muss(strang.length === 2, `${strang.length} Nachrichten im Verlauf statt 2`);
  muss(strang.some((m) => m.id === antwort.id), 'die Antwort steht nicht im Verlauf');
  return `${strang.length} Nachrichten im Verlauf`;
});

await pruefe('Ohne DMARC-Bestätigung bleibt es beim eigenen Verlauf', async () => {
  const unbestaetigt = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `kollege2@${domA}`,
    betreff: 'Re: Anfrage zum Vertrag', text: 'Auch von mir dazu.',
    messageId: `<unbestaetigt-${marke}@${domA}>`, referenzen: wurzelMsgId,
    pruefung: 'dmarc=fail; spf=fail',
  });
  const n = P.nachricht(unbestaetigt.id);
  muss(n.threadId !== wurzelMsgId, 'ist trotz fehlender Bestätigung dem Verlauf beigetreten');
  muss(n.threadId === `<unbestaetigt-${marke}@${domA}>`, `landete stattdessen bei "${n.threadId}"`);
  const strang = P.verlauf(wurzelMsgId);
  muss(strang.length === 2, `der Verlauf wuchs auf ${strang.length} — die unbestätigte Mail ist doch drin`);
  return 'eigener Verlauf';
});

await pruefe('Eine bestätigte, aber domänenfremde Absenderin kann sich nicht in den Verlauf hängen', async () => {
  const fremdeDomain = `fremde-${marke}.tld`;
  const eingeschleust = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `angreifer@${fremdeDomain}`,
    betreff: 'Re: Anfrage zum Vertrag', text: 'Ich klinke mich mal ein.',
    messageId: `<eingeschleust-${marke}@${fremdeDomain}>`, referenzen: wurzelMsgId,
    pruefung: 'dmarc=pass',
  });
  const n = P.nachricht(eingeschleust.id);
  muss(n.threadId !== wurzelMsgId, 'eine domänenfremde Absenderin wurde trotzdem in den Verlauf aufgenommen');
  const strang = P.verlauf(wurzelMsgId);
  muss(strang.length === 2, `der Verlauf wuchs auf ${strang.length} — die fremde Domäne ist doch drin`);
  return 'abgewiesen';
});

/* ── 6) Sprache am Briefpartner ──────────────────────────────────── */

console.log('\nSprache am Briefpartner');

await pruefe('Eine neue Adresse beginnt bei Englisch', async () => {
  const adresse = `neu-${marke}@sprache.example`;
  const s = P.spracheFuer(adresse);
  muss(s === 'en', `war "${s}"`);
  return 'en';
});

const deAdresse = `de-${marke}@sprache.example`;
const deText = 'Guten Tag, könnten Sie uns bitte kurz Rückmeldung geben? Wir würden uns '
  + 'über eine schnelle Antwort sehr freuen und bedanken uns herzlich für Ihre Mühe.';

await pruefe('Eine deutsche Mail mit genug Text setzt die Sprache dauerhaft auf Deutsch', async () => {
  P.eingangAufnehmen({
    an: 'support@stellium.club', von: deAdresse, betreff: 'Rückfrage', text: deText,
    messageId: `<de1-${marke}@sprache.example>`, pruefung: 'dmarc=pass',
  });
  const s = P.spracheFuer(deAdresse);
  muss(s === 'de', `war "${s}"`);
  return 'de';
});

await pruefe('Ein kurzes "ok" danach kippt die Sprache nicht zurück', async () => {
  P.eingangAufnehmen({
    an: 'support@stellium.club', von: deAdresse, betreff: 'Re: Rückfrage', text: 'ok',
    messageId: `<de2-${marke}@sprache.example>`, pruefung: 'dmarc=pass',
  });
  const s = P.spracheFuer(deAdresse);
  muss(s === 'de', `kippte auf "${s}"`);
  return 'weiter de';
});

/* ── 7) Zeitklemme ────────────────────────────────────────────── */

console.log('\nZeitklemme');

await pruefe('Eine Mail weit aus der Zukunft wird auf "jetzt + 5 Minuten" gezogen', async () => {
  const vor = Date.now();
  const { id } = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `zeit1-${marke}@zeit.example`,
    betreff: 'Zukunft', text: 'Text.', messageId: `<zeit1-${marke}@zeit.example>`,
    pruefung: 'dmarc=pass', am: Number.MAX_SAFE_INTEGER,
  });
  const nach = Date.now();
  const { am } = P.nachricht(id);
  muss(am >= vor + 5 * 60_000 - 1000 && am <= nach + 5 * 60_000 + 1000,
    `am liegt bei ${new Date(am).toISOString()}, erwartet nahe "jetzt + 5 Minuten"`);
  return new Date(am).toISOString();
});

await pruefe('Eine Mail weit aus der Vergangenheit wird auf "jetzt − 30 Tage" gezogen', async () => {
  const vor = Date.now();
  const { id } = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `zeit2-${marke}@zeit.example`,
    betreff: 'Vergangenheit', text: 'Text.', messageId: `<zeit2-${marke}@zeit.example>`,
    pruefung: 'dmarc=pass', am: -8_640_000_000_000_000,
  });
  const nach = Date.now();
  const { am } = P.nachricht(id);
  muss(am >= vor - 30 * 86400_000 - 1000 && am <= nach - 30 * 86400_000 + 1000,
    `am liegt bei ${new Date(am).toISOString()}, erwartet nahe "jetzt − 30 Tage"`);
  return new Date(am).toISOString();
});

await pruefe('Ein normaler Zeitstempel bleibt unangetastet', async () => {
  const eigen = Date.now() - 2 * 3600_000;
  const { id } = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `zeit3-${marke}@zeit.example`,
    betreff: 'Normal', text: 'Text.', messageId: `<zeit3-${marke}@zeit.example>`,
    pruefung: 'dmarc=pass', am: eigen,
  });
  const { am } = P.nachricht(id);
  muss(am === eigen, `wurde zu ${am} statt ${eigen} verändert`);
  return 'unverändert';
});

await pruefe('Fehlt der Zeitstempel ganz, gilt jetzt', async () => {
  const vor = Date.now();
  const { id } = P.eingangAufnehmen({
    an: 'support@stellium.club', von: `zeit4-${marke}@zeit.example`,
    betreff: 'Ohne Zeit', text: 'Text.', messageId: `<zeit4-${marke}@zeit.example>`,
    pruefung: 'dmarc=pass',
  });
  const nach = Date.now();
  const { am } = P.nachricht(id);
  muss(am >= vor && am <= nach, `am liegt bei ${am}, erwartet zwischen ${vor} und ${nach}`);
  return 'jetzt';
});

/* ── 8) Listenlänge ──────────────────────────────────────────────
 *
 * Eigenes Fach ("jobs"), das sonst in diesem Lauf nicht benutzt wird —
 * damit die Zählung hier exakt ist und nicht von anderen Abschnitten
 * mitgeprägt wird. */

console.log('\nListenlänge');

await pruefe('liste() gibt nie mehr als 200 zurück, selbst wenn mehr existiert und mehr verlangt wird', async () => {
  const ANZAHL = 205;
  for (let i = 0; i < ANZAHL; i++) {
    P.eingangAufnehmen({
      an: 'jobs@stellium.club', von: `flut-${marke}-${i}@flut.example`,
      betreff: `Bewerbung ${i}`, text: `Kurzer Text ${i}.`,
      messageId: `<flut-${marke}-${i}@flut.example>`, pruefung: 'dmarc=pass',
    });
  }
  const gefiltert = P.liste('jobs', 5000);
  muss(gefiltert.length === 200, `${gefiltert.length} statt 200 mit Fach-Filter, obwohl ${ANZAHL} Zeilen vorliegen`);
  return `${gefiltert.length} von ${ANZAHL} eingegangenen`;
});

await pruefe('Auch ohne Fach-Filter (über alle Fächer) bleibt die Liste bei 200', async () => {
  const alle = P.liste(null, 100000);
  muss(alle.length === 200, `${alle.length} statt 200 über alle Fächer`);
  return `${alle.length}`;
});

await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
