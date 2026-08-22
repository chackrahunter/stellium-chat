/**
 * Prüft Archivieren, Entfernen/Wiederherstellen, endgültiges Löschen und die
 * Aufbewahrungsfrist je Fach der Firmenpost — gegen eine WEGWERFBARE
 * Datenbank.
 *
 * Fünf Zusagen werden hier eingelöst, nicht nur behauptet:
 *
 *   1. Archivierte Post verschwindet aus liste(), bleibt aber vollständig
 *      lesbar und ist in der Archiv-Ansicht wieder da.
 *   2. Entfernte ("aus dem Weg geräumte") Post lässt sich zurückholen —
 *      ohne Zeitfenster, jederzeit.
 *   3. Endgültig gelöschte Post hinterlässt in der rohen Datenbankdatei
 *      keinen lesbaren Rest — byteweise geprüft, genau wie es
 *      notizen-verschluesselung.mts für Notizen vormacht (siehe dort für
 *      dasselbe Muster) — und reißt mail_sichtung/mail_entwuerfe mit, lässt
 *      aber mail_partner stehen, solange noch eine ANDERE Mail an derselben
 *      Adresse hängt.
 *   4. Eine abgelaufene Aufbewahrungsfrist räumt GENAU das ab, was ihr Fach
 *      betrifft und alt genug ist — nichts daneben.
 *   5. Ohne gesetzte Frist passiert in einem Fach gar nichts, egal wie alt
 *      die Post dort ist.
 *
 * Aufruf:  node scripts/post-aufbewahrung-pruefen.mjs
 */
import fs from 'node:fs';
import { config } from '../config.js';
import { db, initDb } from '../db/index.js';
import { blindIndex } from '../crypto/pii.js';
import { verschluesselungAktiv } from '../crypto/nachrichten.js';
import * as post from '../services/post.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};
const pruefWahr = (name: string, ist: boolean) => pruef(name, ist, true);
const gibtEsNicht = (sql: string, ...params: unknown[]) => db.get(sql, ...params) === undefined;
const gibtEs = (sql: string, ...params: unknown[]) => db.get(sql, ...params) !== undefined;

const marke = Date.now().toString(36).slice(-6);
const TAG = 24 * 60 * 60 * 1000;

/* post_fristen.gesetzt_von zeigt per Fremdschlüssel auf users(id)
   (REFERENCES users(id) ON DELETE SET NULL) — ohne eine echte Zeile lehnt
   SQLite (PRAGMA foreign_keys = ON, schema.sql) das INSERT ab. Derselbe
   Handgriff wie in konto-loeschen.mts/notizen-verschluesselung.mts. */
db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('pruefer', 'pruefer', 'Prüfer', 'x', 0)`);

console.log(verschluesselungAktiv()
  ? '\n(Masterpasswort aktiv — der Betreff liegt als Chiffrat vor; der Byte-Test prüft das '
    + 'Verschwinden GENAU des gespeicherten Werts, ob Klartext oder nicht.)'
  : '\n(Kein Masterpasswort aktiv — der Betreff liegt im Klartext vor; der Byte-Test ist damit '
    + 'die schärfste mögliche Form der Prüfung.)');

/* ── 1) Archivieren ──────────────────────────────────────────────── */

console.log('\nArchivieren:');

const archivMail = post.eingangAufnehmen({
  an: 'support@stellium.club', von: `archiv-${marke}@kunde.example`,
  betreff: `Archiv-Test-${marke}`, text: 'Kurzer Text.', pruefung: 'dmarc=pass',
  messageId: `<archiv-${marke}@kunde.example>`,
});

pruefWahr('Frisch angekommen: steht in der aktiven Liste',
  post.liste('support', 200).some((n) => n.id === archivMail.id));

pruefWahr('archiviertSetzen(true) meldet Erfolg', post.archiviertSetzen(archivMail.id, true));

pruefWahr('Archiviert: verschwindet aus der aktiven Liste',
  !post.liste('support', 200).some((n) => n.id === archivMail.id));
pruefWahr('Archiviert: taucht in der Archiv-Ansicht auf',
  post.liste('support', 200, undefined, 'archiviert').some((n) => n.id === archivMail.id));

const archivGelesen = post.nachricht(archivMail.id);
pruefWahr('Archiviert, aber weiterhin vollständig lesbar — nur aus dem Blick, nicht weg',
  archivGelesen !== null && archivGelesen.betreff === `Archiv-Test-${marke}`);
pruefWahr('archiviertAm trägt jetzt einen Zeitpunkt, nicht mehr null',
  typeof archivGelesen?.archiviertAm === 'number');

pruefWahr('archiviertSetzen(false) holt sie zurück', post.archiviertSetzen(archivMail.id, false));
pruefWahr('Wieder in der aktiven Liste', post.liste('support', 200).some((n) => n.id === archivMail.id));
pruefWahr('...und nicht mehr im Archiv',
  !post.liste('support', 200, undefined, 'archiviert').some((n) => n.id === archivMail.id));

/* ── 2) Aus dem Weg räumen — und zurückholen ─────────────────────── */

console.log('\nAus dem Weg räumen und wiederherstellen:');

const entferntMail = post.eingangAufnehmen({
  an: 'support@stellium.club', von: `entfernen-${marke}@kunde.example`,
  betreff: `Entfernen-Test-${marke}`, text: 'Kurzer Text.', pruefung: 'dmarc=pass',
  messageId: `<entfernen-${marke}@kunde.example>`,
});

pruefWahr('entferntSetzen(true) meldet Erfolg', post.entferntSetzen(entferntMail.id, true));
pruefWahr('Entfernt: verschwindet aus der aktiven Liste',
  !post.liste('support', 200).some((n) => n.id === entferntMail.id));
pruefWahr('Entfernt: liegt im Papierkorb',
  post.liste('support', 200, undefined, 'papierkorb').some((n) => n.id === entferntMail.id));
pruefWahr('Entfernt, aber der Inhalt steht noch unverändert da — umkehrbar, nicht gelöscht',
  post.nachricht(entferntMail.id)?.betreff === `Entfernen-Test-${marke}`);

pruefWahr('entferntSetzen(false) holt sie aus dem Papierkorb zurück',
  post.entferntSetzen(entferntMail.id, false));
pruefWahr('Wieder in der aktiven Liste', post.liste('support', 200).some((n) => n.id === entferntMail.id));
pruefWahr('...und nicht mehr im Papierkorb',
  !post.liste('support', 200, undefined, 'papierkorb').some((n) => n.id === entferntMail.id));

/* ── 3) Endgültig löschen (Art. 17 DSGVO) ─────────────────────────
 *
 * DE_TEXT: derselbe Satz wie in e2e-postfach.mjs, dort schon als
 * zuverlässig auf Deutsch erkennbar geprüft — nötig, damit spracheLernen()
 * wirklich eine Zeile in mail_partner anlegt und dieser Test etwas zu
 * prüfen hat.
 */

console.log('\nEndgültig löschen (Art. 17 DSGVO):');

const DE_TEXT = 'Guten Tag, könnten Sie uns bitte kurz Rückmeldung geben? Wir würden uns '
  + 'über eine schnelle Antwort sehr freuen und bedanken uns herzlich für Ihre Mühe.';

const alleinigerPartner = `einzel-${marke}@kunde.example`;
const hartMail = post.eingangAufnehmen({
  an: 'privacy@stellium.club', von: alleinigerPartner,
  betreff: `Loeschen-Test-${marke}`, text: DE_TEXT, pruefung: 'dmarc=pass',
  messageId: `<hart-${marke}@kunde.example>`,
});

pruefWahr('spracheLernen hat für die alleinige Adresse einen mail_partner-Eintrag angelegt',
  gibtEs('SELECT 1 FROM mail_partner WHERE adresse_bidx = ?', blindIndex(alleinigerPartner)));

/* Eine Sichtung und einen Entwurf simulieren, wie post-sichtung.ts sie
   anlegen würde — ohne echten KI-Aufruf, der hier nichts zu suchen hat
   (siehe e2e-postfach.mjs, Abschnitt "WARUM KEIN NETZZUGRIFF"). */
db.run(
  `INSERT INTO mail_sichtung (mail_id, thread_id, gesichtet_am, einordnung, zustand)
   VALUES (?,?,?,?,?)`,
  hartMail.id, `thread-${marke}`, Date.now(), '{"anliegen":"Testfall"}', 'gemeldet',
);
db.run(
  `INSERT INTO mail_entwuerfe (id, mail_id, thread_id, an, betreff, text, zustand, erstellt_am)
   VALUES (?,?,?,?,?,?,?,?)`,
  `me_test_${marke}`, hartMail.id, `thread-${marke}`, alleinigerPartner,
  `Re: Loeschen-Test-${marke}`, 'Antworttext.', 'offen', Date.now(),
);
pruefWahr('Sichtung und Entwurf stehen vor dem Löschen wirklich in der Datenbank',
  gibtEs('SELECT 1 FROM mail_sichtung WHERE mail_id = ?', hartMail.id)
  && gibtEs('SELECT 1 FROM mail_entwuerfe WHERE mail_id = ?', hartMail.id));

/* Der genaue, roh gespeicherte Wert — Klartext oder Chiffrat, je nachdem, ob
   ein Masterpasswort aktiv ist. GENAU dieser Wert muss nach dem Löschen aus
   jeder Datei verschwunden sein, in der die Datenbank je etwas ablegt. */
const roheZeileVorher = db.get<{ betreff: string }>(
  'SELECT betreff FROM mail_nachrichten WHERE id = ?', hartMail.id,
)!;

/* TRUNCATE, nicht FULL wie im Notizen-Prüflauf: FULL setzt nur die
   Leseposition zurück, lässt die Datei aber so groß, wie sie war — ältere,
   längst überschriebene Seitenversionen bleiben dann als Datenmüll am Ende
   der `-wal`-Datei liegen, und ein Byte-Suchlauf fände sie dort trotzdem
   noch. Bei einer Notiz mit ihren zwei, drei Schreibvorgängen fiel das nie
   auf; dieser Lauf legt vorher deutlich mehr Zeilen an und macht den
   Unterschied sichtbar. TRUNCATE schneidet die Datei wirklich auf null
   zurück (siehe auch mailsHartLoeschen() in services/post.ts, das aus
   demselben Grund TRUNCATE verwendet). */
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const vorDemLoeschen = fs.readFileSync(config.dbFile);
pruefWahr(
  'Vor dem Löschen: der gespeicherte Betreff-Wert steht wirklich in der Datei '
  + '(sonst wäre die Prüfung unten gegenstandslos)',
  vorDemLoeschen.indexOf(Buffer.from(roheZeileVorher.betreff, 'utf8')) !== -1,
);
if (!verschluesselungAktiv()) {
  // Ohne Masterpasswort steht sogar der für Menschen lesbare Text selbst da
  // — die schärfste, wörtlichste Lesart von "such byteweise nach dem Betreff".
  pruefWahr('Ohne Masterpasswort: auch der klar lesbare Betreff-Text steht vor dem Löschen in der Datei',
    vorDemLoeschen.indexOf(Buffer.from(`Loeschen-Test-${marke}`, 'utf8')) !== -1);
}

pruefWahr('endgueltigLoeschen() meldet Erfolg', post.endgueltigLoeschen(hartMail.id));
pruef('Ein zweiter Aufruf auf dieselbe id meldet false — es gibt sie nicht mehr',
  post.endgueltigLoeschen(hartMail.id), false);

pruefWahr('Die Zeile in mail_nachrichten ist wirklich weg (SELECT, nicht nur die Oberfläche)',
  gibtEsNicht('SELECT 1 FROM mail_nachrichten WHERE id = ?', hartMail.id));
pruefWahr('Die Sichtung zu dieser Mail ist mitgelöscht',
  gibtEsNicht('SELECT 1 FROM mail_sichtung WHERE mail_id = ?', hartMail.id));
pruefWahr('Der Entwurf zu dieser Mail ist mitgelöscht',
  gibtEsNicht('SELECT 1 FROM mail_entwuerfe WHERE mail_id = ?', hartMail.id));
pruefWahr(
  'mail_partner für die (jetzt einzige gelöschte) Adresse ist mitgelöscht — '
  + 'keine gelernte Sprache überlebt ihre einzige Mail',
  gibtEsNicht('SELECT 1 FROM mail_partner WHERE adresse_bidx = ?', blindIndex(alleinigerPartner)),
);

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const nachDemLoeschen = fs.readFileSync(config.dbFile);
pruefWahr(
  'Nach dem Löschen: der (vormals) gespeicherte Wert steht an KEINER Stelle mehr in der Hauptdatei',
  nachDemLoeschen.indexOf(Buffer.from(roheZeileVorher.betreff, 'utf8')) === -1,
);
for (const nebendatei of [`${config.dbFile}-wal`, `${config.dbFile}-journal`]) {
  if (!fs.existsSync(nebendatei)) continue;
  const inhalt = fs.readFileSync(nebendatei);
  pruefWahr(`${nebendatei.split('/').pop()} enthält den gelöschten Wert an KEINER Stelle`,
    inhalt.indexOf(Buffer.from(roheZeileVorher.betreff, 'utf8')) === -1);
}

/* ── 3b) mail_partner bleibt stehen, solange eine andere Mail an derselben
        Adresse noch besteht — die Gegenprobe zu oben. ─────────────────── */

console.log('\nmail_partner überlebt, solange noch eine Mail dranhängt:');

const geteilterPartner = `geteilt-${marke}@kunde.example`;
const ersteVonZweien = post.eingangAufnehmen({
  an: 'privacy@stellium.club', von: geteilterPartner,
  betreff: `Geteilt-1-${marke}`, text: DE_TEXT, pruefung: 'dmarc=pass',
  messageId: `<geteilt1-${marke}@kunde.example>`,
});
const zweiteVonZweien = post.eingangAufnehmen({
  an: 'privacy@stellium.club', von: geteilterPartner,
  betreff: `Geteilt-2-${marke}`, text: DE_TEXT, pruefung: 'dmarc=pass',
  messageId: `<geteilt2-${marke}@kunde.example>`,
});
pruefWahr('mail_partner existiert für die geteilte Adresse',
  gibtEs('SELECT 1 FROM mail_partner WHERE adresse_bidx = ?', blindIndex(geteilterPartner)));

post.endgueltigLoeschen(ersteVonZweien.id);
pruefWahr(
  'Nach dem Löschen der ERSTEN von zwei Mails: mail_partner steht noch — die zweite hängt noch dran',
  gibtEs('SELECT 1 FROM mail_partner WHERE adresse_bidx = ?', blindIndex(geteilterPartner)),
);

post.endgueltigLoeschen(zweiteVonZweien.id);
pruefWahr('Nach dem Löschen auch der LETZTEN Mail: mail_partner ist jetzt weg',
  gibtEsNicht('SELECT 1 FROM mail_partner WHERE adresse_bidx = ?', blindIndex(geteilterPartner)));

/* ── 4) Aufbewahrungsfrist ────────────────────────────────────────── */

console.log('\nAufbewahrungsfrist:');

/* Ganz am Anfang -- vor JEDEM fristSetzen() in diesem Lauf -- steht
   post_fristen leer da, wie auf jeder frischen Datenbank. Genau das prüft
   dieser Abschnitt zuerst, denn danach gilt es für den Rest des Laufs nicht
   mehr. */
const ungeschuetzteAlteMail = post.eingangAufnehmen({
  an: 'abuse@stellium.club', von: `frist0-${marke}@kunde.example`,
  betreff: `Ohne-Frist-${marke}`, text: 'Text.', pruefung: 'dmarc=pass',
  messageId: `<frist0-${marke}@kunde.example>`, am: Date.now() - 29 * TAG,
});
pruef('Ohne IRGENDEINE gesetzte Frist räumt fristenAnwenden() nichts weg (0 zurückgegeben)',
  post.fristenAnwenden(), 0);
pruefWahr('...und die alte Mail steht tatsächlich noch',
  gibtEs('SELECT 1 FROM mail_nachrichten WHERE id = ?', ungeschuetzteAlteMail.id));

const stand0 = post.fristenStand();
pruefWahr('fristenStand() listet JEDES Fach — auch das Auffangbecken "sonstiges"',
  stand0.some((f) => f.fach === 'sonstiges'));
pruef('fristenStand() listet genau so viele Fächer wie es gibt',
  stand0.length, post.ALLE_FAECHER.length);
pruefWahr('Für jedes Fach: tage ist null, solange nichts gesetzt ist (der sichtbare Hinweis "keine Frist")',
  stand0.every((f) => f.tage === null));

post.fristSetzen('billing', 1, 'pruefer');

const standNachSetzen = post.fristenStand();
pruef('fristenStand() zeigt die gesetzte Frist für billing',
  standNachSetzen.find((f) => f.fach === 'billing')?.tage, 1);
pruefWahr('Alle ANDEREN Fächer bleiben bei "keine Frist gesetzt"',
  standNachSetzen.filter((f) => f.fach !== 'billing').every((f) => f.tage === null));

const billingAlt = post.eingangAufnehmen({
  an: 'billing@stellium.club', von: `frist1-${marke}@kunde.example`,
  betreff: `Billing-Alt-${marke}`, text: 'Text.', pruefung: 'dmarc=pass',
  messageId: `<frist1-${marke}@kunde.example>`, am: Date.now() - 3 * TAG,
});
const billingNeu = post.eingangAufnehmen({
  an: 'billing@stellium.club', von: `frist2-${marke}@kunde.example`,
  betreff: `Billing-Neu-${marke}`, text: 'Text.', pruefung: 'dmarc=pass',
  messageId: `<frist2-${marke}@kunde.example>`, am: Date.now() - 60 * 60 * 1000,
});
const salesAlt = post.eingangAufnehmen({
  an: 'sales@stellium.club', von: `frist3-${marke}@kunde.example`,
  betreff: `Sales-Alt-Ohne-Frist-${marke}`, text: 'Text.', pruefung: 'dmarc=pass',
  messageId: `<frist3-${marke}@kunde.example>`, am: Date.now() - 3 * TAG,
});

const weg = post.fristenAnwenden();
pruefWahr('fristenAnwenden() meldet mindestens die eine abgelaufene Billing-Mail', weg >= 1);

pruefWahr('Die abgelaufene Billing-Mail (3 Tage alt, Frist 1 Tag) ist weg',
  gibtEsNicht('SELECT 1 FROM mail_nachrichten WHERE id = ?', billingAlt.id));
pruefWahr('Die frische Billing-Mail (1 Stunde alt) steht noch — dieselbe Frist hat sie nicht getroffen',
  gibtEs('SELECT 1 FROM mail_nachrichten WHERE id = ?', billingNeu.id));
pruefWahr('Die gleich alte Mail in "sales" (KEINE Frist gesetzt) steht noch — nichts daneben geräumt',
  gibtEs('SELECT 1 FROM mail_nachrichten WHERE id = ?', salesAlt.id));

post.fristLoeschen('billing');
pruef('fristLoeschen() schaltet die Frist wieder ab',
  post.fristenStand().find((f) => f.fach === 'billing')?.tage, null);

/* ── Ergebnis ─────────────────────────────────────────────────────── */

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mArchivieren, Entfernen/Wiederherstellen, endgültiges Löschen ohne lesbaren Rest und die '
    + 'Aufbewahrungsfrist je Fach verhalten sich wie zugesagt.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
