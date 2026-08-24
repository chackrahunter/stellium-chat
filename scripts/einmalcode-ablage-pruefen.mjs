/**
 * Liegt das Geheimnis richtig — und kommt es wirklich nirgends wieder heraus?
 *
 *     node scripts/einmalcode-ablage-pruefen.mjs
 *
 * Braucht keinen laufenden Server: der Lauf legt eine Wegwerf-Datenbank an,
 * spielt das vollständige Schema ein, hängt die beiden Tabellen dieser
 * Funktion daran und lässt dann den echten Dienst darauf arbeiten.
 *
 * WOZU
 *
 * Zwei Behauptungen stehen im Dateikopf von services/einmalcode.ts, und beide
 * sind wertlos, solange sie nur Prosa sind:
 *
 *   1. Das Geheimnis liegt VERSCHLÜSSELT in der Datenbank. Nachgeprüft wird
 *      das hier nicht am Code, sondern an der Datei: die Spalte wird roh
 *      ausgelesen und muss etwas anderes enthalten als das, was hineinging.
 *   2. Es kommt durch KEINEN Weg wieder heraus. Nachgeprüft wird das, indem
 *      jede Rückgabe des Dienstes vollständig nach dem Geheimnis durchsucht
 *      wird — nicht nur die Felder, an die man denkt.
 *
 * DAS SCHEMA STEHT UNTEN WÖRTLICH
 *
 * `db/schema.sql` und `db/migrate.ts` liegen bei jemand anderem. Der Text der
 * beiden Tabellen steht deshalb hier — und wird hier auch ausgeführt. Wer ihn
 * in die beiden Dateien überträgt, überträgt damit etwas, das nachweislich
 * läuft, statt etwas Abgetipptes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/* ── Der Schalter, den dieser Lauf braucht ─────────────────────────
   `secrets.ts` schreibt `constructor(private readonly file: string)` — eine
   TypeScript-Eigenart, die Node im bloßen Abstreif-Betrieb nicht auflösen
   kann (es müsste Code ERZEUGEN, nicht nur weglassen). Mit
   `--experimental-transform-types` kann es das.

   Statt den Schalter in die Anleitung zu schreiben, wo ihn jeder Zweite
   vergisst, startet sich der Lauf einmal selbst neu. Ein Aufruf, kein
   Merkzettel. */
if (!process.execArgv.some((a) => a.includes('transform-types'))) {
  const erneut = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(erneut.status ?? 1);
}

/* ── ".js" im Quelltext, ".ts" auf der Platte ──────────────────────
   Der Serverquelltext importiert nach ESM-Art mit der Endung des ERGEBNISSES
   (`./config.js`), nicht der Quelle — so verlangt es TypeScript für Module,
   und im Betrieb läuft ohnehin das gebaute `dist/`. Node kann Typen inzwischen
   selbst abstreifen, sucht aber genau die Datei, die dasteht: `config.js`
   gibt es im Quellordner nicht.

   Diese Weiche schiebt solche Verweise auf die `.ts`-Datei daneben — und nur
   dann, wenn die `.js` wirklich fehlt. Damit läuft der Prüflauf gegen den
   QUELLTEXT, ohne vorher zu bauen. Ein Bau würde dasselbe prüfen, aber
   Minuten kosten und ein `dist/` hinterlassen, während nebenan andere
   arbeiten. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const relativ = specifier.startsWith('./') || specifier.startsWith('../');
    if (relativ && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      const alsJs = new URL(specifier, context.parentURL);
      if (!fs.existsSync(fileURLToPath(alsJs))) {
        const alsTs = `${specifier.slice(0, -3)}.ts`;
        if (fs.existsSync(fileURLToPath(new URL(alsTs, context.parentURL)))) {
          return nextResolve(alsTs, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});

/* ── Der Teillauf ohne Masterpasswort ──────────────────────────────
   `pii.ts` (ensureKeys()) hält den einmal aufgelösten Schlüssel in einer
   Modul-Variable fest: "if (keys) return keys;" — VOR jedem erneuten Blick
   auf `STELLIUM_MASTER_PASSPHRASE`. In einem einzigen Prozess, der weiter
   unten schon ein Konto mit gesetztem Masterpasswort anlegt, ließe sich das
   Passwort später also gar nicht mehr "abbauen": der Schlüssel bliebe im
   Speicher, egal was mit der Umgebungsvariable passiert. Der einzige
   ehrliche Weg zurück zu "kein Masterpasswort" ist ein Prozess, der es nie
   gesetzt hatte. Das ist genau dieser Schalter: gesetzt bewirkt er, dass
   dieser Lauf NICHT die volle Prüfliste ausführt, sondern nur die paar
   Prüfungen, für die es ihn gibt — siehe weiter unten, kurz nach dem Anlegen
   der Tabellen. Den Kindprozess dafür startet der Normallauf selbst, siehe
   Abschnitt "Ohne Masterpasswort" weiter unten. */
const OHNE_MASTERPASSWORT = process.env.EINMALCODE_PRUEFEN_OHNE_MP === '1';

/* Muss VOR dem Laden von config.ts/db gesetzt sein — beide lesen die Umgebung
   beim Laden des Moduls, nicht beim ersten Aufruf. */
const spielwiese = fs.mkdtempSync(path.join(os.tmpdir(), 'einmalcode-'));
/* Auch dann wegräumen, wenn mitten im Lauf etwas wirft — sonst bleibt bei
   jedem Fehlschlag eine Wegwerf-Datenbank im Temp-Ordner liegen, und in der
   steht (verschlüsselt, aber immerhin) ein Geheimnis. */
process.on('exit', () => { try { fs.rmSync(spielwiese, { recursive: true, force: true }); } catch { /* egal */ } });
process.env.DATA_DIR = spielwiese;
/* Im Teillauf ohne Masterpasswort wird die Variable erst gar nicht gesetzt —
   ein nachträgliches Löschen käme, wie oben begründet, ohnehin zu spät. */
if (!OHNE_MASTERPASSWORT) process.env.STELLIUM_MASTER_PASSPHRASE = 'nur-fuer-diesen-prueflauf-nicht-echt';
process.env.LOG_LEVEL = 'silent';

const { db, initDb } = await import('../packages/server/src/db/index.ts');
const einmalcode = await import('../packages/server/src/services/einmalcode.ts');
const { encryptionActive } = await import('../packages/server/src/crypto/pii.ts');

const F = {
  aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m',
  gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m',
};
let gelaufen = 0;
let gefallen = 0;

function pruefe(name, bedingung, zusatz = '') {
  gelaufen += 1;
  if (!bedingung) gefallen += 1;
  const marke = bedingung ? `${F.gruen}✓${F.aus}` : `${F.rot}✗${F.aus}`;
  console.log(`  ${marke} ${name.padEnd(60)} ${F.grau}${zusatz}${F.aus}`);
}
function abschnitt(titel) { console.log(`\n${F.fett}${titel}${F.aus}`); }

/* ══ DAS SCHEMA — wörtlich so nach db/schema.sql und db/migrate.ts ══ */

export const SCHEMA = `
/* Konten, für die Einmalcodes gerechnet werden — meist genau eins: das
   Firmenkonto bei Google. Was hier steht, ist der ZWEITE FAKTOR des
   Unternehmens; wer die Zeile lesen könnte, käme mit dem Passwort ins Konto.
   Deshalb liegt \`geheimnis\` verschlüsselt (crypto/pii.ts, encryptField) und
   wird durch keinen Weg je wieder herausgegeben — siehe
   services/einmalcode.ts. Auch Etikett, Aussteller und Kontoname sind
   verschlüsselt: der Kontoname ist in aller Regel eine Mailadresse, und die
   sind im Haus personenbezogen.
   Algorithmus, Stellenzahl und Periode bleiben im Klartext — sie sind
   Kennzahlen aus RFC 6238, kein Geheimnis, und ohne das Geheimnis nützt
   niemandem, sie zu kennen. */
CREATE TABLE IF NOT EXISTS einmalcode_konten (
  id            TEXT PRIMARY KEY,
  bezeichnung   TEXT NOT NULL,
  aussteller    TEXT,
  konto         TEXT,
  geheimnis     TEXT NOT NULL,
  algorithmus   TEXT NOT NULL DEFAULT 'SHA1',
  stellen       INTEGER NOT NULL DEFAULT 6,
  periode       INTEGER NOT NULL DEFAULT 30,
  angelegt_von  TEXT NOT NULL REFERENCES users(id),
  angelegt_am   INTEGER NOT NULL,
  geaendert_von TEXT REFERENCES users(id),
  geaendert_am  INTEGER
);

/* Wer wann einen Code geholt hat. WELCHER Code es war, steht bewusst nicht
   dabei — er wäre nach dreißig Sekunden wertlos und vorher ein Nachschlüssel
   im Klartext.
   \`bezeichnung\` ist eine verschlüsselte KOPIE des Etiketts, kein Verweis:
   der Nachweis muss lesbar bleiben, wenn jemand das Konto löscht. Aus
   demselben Grund trägt \`konto_id\` KEIN "REFERENCES … ON DELETE CASCADE" —
   gerade das Löschen wäre der Griff, mit dem jemand Spuren verwischen
   würde. */
CREATE TABLE IF NOT EXISTS einmalcode_abrufe (
  id          TEXT PRIMARY KEY,
  konto_id    TEXT NOT NULL,
  bezeichnung TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  am          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_einmalcode_abrufe_am ON einmalcode_abrufe(am DESC);
CREATE INDEX IF NOT EXISTS idx_einmalcode_abrufe_konto ON einmalcode_abrufe(konto_id);
`;

/* ══ Aufbau ══ */

initDb();
db.exec(SCHEMA);

const ICH = 'u_pruefer';
db.run(
  `INSERT INTO users (id, handle, email, display_name, password_hash, role, created_at)
   VALUES (?,?,?,?,?,?,?)`,
  ICH, 'pruefer', '', 'Prüfer', 'x', 'owner', Date.now(),
);

/* Ein erfundenes Geheimnis — nirgends echt, nirgends gültig. Es ist die
   Base32-Form von "Hello!\xDE\xAD\xBE\xEF" aus dem Key-Uri-Format. */
const GEHEIMNIS = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Beispiel%20GmbH:team@beispiel.de?secret=${GEHEIMNIS}&issuer=Beispiel%20GmbH&digits=6&period=30`;

/* ══ Der Teillauf ohne Masterpasswort — läuft NUR in einem eigenen
   Kindprozess, der EINMALCODE_PRUEFEN_OHNE_MP=1 gesetzt bekommt und darum
   STELLIUM_MASTER_PASSPHRASE von Anfang an nie gesehen hat (siehe Begründung
   oben). Er bricht danach sofort ab, statt in die reguläre Prüfliste weiter
   unten zu laufen — die setzt ein gesetztes Masterpasswort voraus. ══ */
if (OHNE_MASTERPASSWORT) {
  abschnitt('Ohne Masterpasswort wird ehrlich gemeldet, dass nicht verschlüsselt wird');
  /* Die eigentliche Voraussetzung dieses Teillaufs: kein Schlüssel aus
     IRGENDEINER Quelle. Auf einem Rechner mit einem echten Eintrag im
     Schlüsselbund (macOS, KEYCHAIN_SERVICE 'stellium-master' in secrets.ts)
     wäre `encryptionActive()` trotz fehlender Umgebungsvariable wahr — dann
     sagt diese Zeile das ehrlich, statt dass die beiden Prüfungen danach
     stillschweigend etwas anderes testen, als der Abschnittstitel behauptet. */
  pruefe('kein Schlüssel aktiv — weder Umgebung noch Schlüsselbund', !encryptionActive());
  const kontoOhne = einmalcode.kontoAnlegen({ geheimnis: GEHEIMNIS }, ICH);
  pruefe('verschluesselt-Merkmal meldet `false`', kontoOhne.verschluesselt === false, String(kontoOhne.verschluesselt));
  const rohOhne = db.get('SELECT geheimnis FROM einmalcode_konten WHERE id = ?', kontoOhne.id);
  pruefe('liegt darum ehrlich im Klartext (keine "v1:"-Fassungsmarke)',
    !String(rohOhne.geheimnis).startsWith('v1:'), String(rohOhne.geheimnis).slice(0, 3));
  pruefe('Klartext im Feld stimmt mit dem Geheimnis überein', rohOhne.geheimnis === GEHEIMNIS);

  db.close();
  console.log('');
  if (gefallen) {
    console.log(`${F.rot}${F.fett}${gefallen} von ${gelaufen} Prüfungen (ohne Masterpasswort) gefallen.${F.aus}`);
    process.exit(1);
  }
  console.log(`${F.gruen}${F.fett}Alle ${gelaufen} Prüfungen (ohne Masterpasswort) bestanden.${F.aus}`);
  process.exit(0);
}

/* ══ Anlegen ══ */

abschnitt('Ein Konto aus einer otpauth-Adresse anlegen');

const konto = einmalcode.kontoAnlegen({ geheimnis: URI }, ICH);
pruefe('Aussteller aus der Adresse', konto.aussteller === 'Beispiel GmbH', konto.aussteller);
pruefe('Kontoname aus der Adresse', konto.konto === 'team@beispiel.de', konto.konto);
pruefe('Etikett von selbst gebaut', konto.bezeichnung === 'Beispiel GmbH — team@beispiel.de', konto.bezeichnung);
pruefe('Kennzahlen übernommen', konto.algorithmus === 'SHA1' && konto.stellen === 6 && konto.periode === 30);
pruefe('als verschlüsselt gemeldet', konto.verschluesselt === true);

/* ══ Liegt es verschlüsselt? — an der Datei geprüft, nicht am Code ══ */

abschnitt('In der Datenbank steht kein Klartext');

const roh = db.get('SELECT * FROM einmalcode_konten WHERE id = ?', konto.id);
pruefe('Spalte geheimnis ist NICHT der Klartext', roh.geheimnis !== GEHEIMNIS);
pruefe('Spalte geheimnis trägt die Fassungsmarke "v1:"', String(roh.geheimnis).startsWith('v1:'), String(roh.geheimnis).slice(0, 3));
pruefe('Kontoname liegt ebenfalls verschlüsselt', roh.konto !== 'team@beispiel.de');
pruefe('Aussteller liegt ebenfalls verschlüsselt', roh.aussteller !== 'Beispiel GmbH');
pruefe('Etikett liegt ebenfalls verschlüsselt', !String(roh.bezeichnung).includes('Beispiel'));
pruefe('Kennzahlen liegen im Klartext (kein Geheimnis)', roh.algorithmus === 'SHA1' && roh.periode === 30);

/* Der harte Test: die GANZE Datei nach dem Geheimnis durchsuchen. */
const datei = fs.readFileSync(path.join(spielwiese, 'stellium.db'));
pruefe('Das Geheimnis steht nirgends in der Datenbankdatei',
  !datei.includes(Buffer.from(GEHEIMNIS, 'utf8')));
pruefe('Auch nicht in Kleinbuchstaben',
  !datei.toString('latin1').toLowerCase().includes(GEHEIMNIS.toLowerCase()));

/* ══ Kommt es irgendwo wieder heraus? ══ */

abschnitt('Kein Weg gibt das Geheimnis zurück');

/* Jede Rückgabe vollständig zu JSON machen und darin suchen — so fällt auch
   ein Feld auf, an das beim Schreiben dieses Laufs niemand gedacht hat. */
function verraet(name, wert) {
  const text = JSON.stringify(wert ?? null);
  const treffer = text.includes(GEHEIMNIS)
    || text.toLowerCase().includes(GEHEIMNIS.toLowerCase())
    /* auch Bruchstücke: die halbe Zeichenkette wäre schon zu viel */
    || text.includes(GEHEIMNIS.slice(0, 8))
    || text.includes(GEHEIMNIS.slice(-8));
  pruefe(name, !treffer, treffer ? 'VERRÄT DAS GEHEIMNIS' : `${text.length} Zeichen geprüft`);
}

verraet('kontenListe()', einmalcode.kontenListe());
verraet('kontoLesen()', einmalcode.kontoLesen(konto.id));
verraet('zeitstand()', einmalcode.zeitstand());
const antwort = einmalcode.codesHolen(konto.id, ICH);
verraet('codesHolen()', antwort);
verraet('abrufeListe()', einmalcode.abrufeListe());

pruefe('Der Dienst hat überhaupt einen Modul-Export "geheimnisLesen"? (soll NEIN sein)',
  !('geheimnisLesen' in einmalcode) && !('vorgabeLesen' in einmalcode),
  Object.keys(einmalcode).join(', ').slice(0, 90));

/* ══ Die Codes selbst ══ */

abschnitt('Die Codes stimmen mit der Rechnung überein');

const { totp } = await import('../packages/server/src/services/einmalcode-kern.ts');
const jetzt = Math.floor(antwort.serverMs / 1000);
const erwartet = totp({ geheimnisBase32: GEHEIMNIS, algorithmus: 'SHA1', stellen: 6, periode: 30 }, jetzt);
pruefe('Der laufende Code stimmt', antwort.codes[0].code === erwartet, erwartet);
pruefe('Ein Vorrat kommt mit', antwort.codes.length === einmalcode.VORRAT_FENSTER, `${antwort.codes.length} Fenster`);
pruefe('Die Fenster hängen lückenlos aneinander',
  antwort.codes.every((c, i) => i === 0 || c.gueltigAbMs === antwort.codes[i - 1].gueltigBisMs));
pruefe('Restzeit liegt zwischen 1 und 30 s', antwort.restSekunden >= 1 && antwort.restSekunden <= 30, `${antwort.restSekunden} s`);
pruefe('Alle Codes sind sechsstellig', antwort.codes.every((c) => /^\d{6}$/.test(c.code)));

/* ══ Nachweis ══ */

abschnitt('Der Nachweis hält fest, wer geholt hat');

const abrufe = einmalcode.abrufeListe();
pruefe('ein Abruf steht drin', abrufe.length === 1);
pruefe('mit der richtigen Person', abrufe[0]?.userId === ICH);
pruefe('mit lesbarem Etikett', abrufe[0]?.bezeichnung === konto.bezeichnung, abrufe[0]?.bezeichnung);
/* Nicht „irgendwo sechs Ziffern" — ein Zeitstempel hat dreizehn und enthält
   damit zwangsläufig sechs am Stück. Geprüft wird das, worauf es ankommt:
   der tatsächlich ausgegebene Code steht nirgends, und es gibt kein Feld
   mehr, als abgemacht ist. */
pruefe('der ausgegebene Code steht nicht darin',
  !JSON.stringify(abrufe).includes(antwort.codes[0].code));
pruefe('keiner der Vorratscodes steht darin',
  antwort.codes.every((c) => !JSON.stringify(abrufe).includes(c.code)));
pruefe('genau die verabredeten Felder, kein weiteres',
  JSON.stringify(Object.keys(abrufe[0]).sort()) === JSON.stringify(['am', 'bezeichnung', 'id', 'kontoId', 'userId']),
  Object.keys(abrufe[0]).join(', '));
/* Auch in der Tabelle selbst, nicht nur in der Rückgabe. */
pruefe('auch die Tabellenspalten kennen keinen Code',
  JSON.stringify(Object.keys(db.get('SELECT * FROM einmalcode_abrufe LIMIT 1')).sort())
    === JSON.stringify(['am', 'bezeichnung', 'id', 'konto_id', 'user_id']));

/* ══ Ändern ══ */

abschnitt('Umbenennen lässt das Geheimnis stehen');

const umbenannt = einmalcode.kontoAendern(konto.id, { bezeichnung: 'Google — Firmenkonto' }, ICH);
pruefe('neuer Name', umbenannt.bezeichnung === 'Google — Firmenkonto', umbenannt.bezeichnung);
const nachher = einmalcode.codesHolen(konto.id, ICH);
pruefe('derselbe Code wie vorher (Geheimnis unangetastet)',
  nachher.codes[0].code === totp({ geheimnisBase32: GEHEIMNIS, algorithmus: 'SHA1', stellen: 6, periode: 30 },
    Math.floor(nachher.serverMs / 1000)));

abschnitt('Ein anderes Geheimnis tauscht auch die Kennzahlen aus');
einmalcode.kontoAendern(konto.id, {
  geheimnis: 'otpauth://totp/Anders:x@y.de?secret=MZXW6YTBOI======&algorithm=SHA256&digits=8&period=60',
}, ICH);
const neu = einmalcode.kontoLesen(konto.id);
pruefe('Verfahren übernommen', neu.algorithmus === 'SHA256', neu.algorithmus);
pruefe('Stellen übernommen', neu.stellen === 8, String(neu.stellen));
pruefe('Periode übernommen', neu.periode === 60, String(neu.periode));
pruefe('Etikett blieb, wie es war', neu.bezeichnung === 'Google — Firmenkonto', neu.bezeichnung);
pruefe('Füllzeichen im Geheimnis stören nicht',
  /^\d{8}$/.test(einmalcode.codesHolen(konto.id, ICH).codes[0].code));

/* ══ Fehlerfälle ══ */

abschnitt('Kaputte Eingaben — und was die Meldung NICHT verrät');

function wirft(name, fn, code) {
  gelaufen += 1;
  try {
    fn();
    gefallen += 1;
    console.log(`  ${F.rot}✗${F.aus} ${name.padEnd(60)} ${F.rot}kein Fehler${F.aus}`);
  } catch (e) {
    const passt = !code || e.code === code;
    const sauber = !`${e.message}${e.stack ?? ''}`.includes('MZXW');
    if (!passt || !sauber) gefallen += 1;
    const marke = passt && sauber ? `${F.gruen}✓${F.aus}` : `${F.rot}✗${F.aus}`;
    console.log(`  ${marke} ${name.padEnd(60)} ${F.grau}${e.code ?? '—'}${F.aus}`);
  }
}

wirft('ohne Geheimnis', () => einmalcode.kontoAnlegen({}, ICH), 'fehler.einmalcodeOhneGeheimnis');
wirft('unlesbares Geheimnis', () => einmalcode.kontoAnlegen({ geheimnis: 'MZXW0!!!' }, ICH), 'fehler.einmalcodeGeheimnis');
wirft('kaputte Adresse', () => einmalcode.kontoAnlegen({ geheimnis: 'otpauth://hotp/X?secret=MZXW6YTB&counter=1' }, ICH), 'fehler.einmalcodeUri');
wirft('unbekanntes Konto', () => einmalcode.codesHolen('gibtesnicht', ICH), 'fehler.einmalcodeKonto');
wirft('unbekanntes Konto löschen', () => einmalcode.kontoLoeschen('gibtesnicht'), 'fehler.einmalcodeKonto');

/* ══ Löschen ══ */

abschnitt('Löschen räumt das Geheimnis weg, nicht den Nachweis');

const vorher = einmalcode.abrufeListe().length;
einmalcode.kontoLoeschen(konto.id);
pruefe('Konto ist weg', einmalcode.kontenListe().length === 0);
pruefe('Nachweis steht noch', einmalcode.abrufeListe().length === vorher, `${vorher} Einträge`);
pruefe('Nachweis ist noch lesbar', einmalcode.abrufeListe()[0]?.bezeichnung.length > 0);

/* ══ Ohne Masterpasswort ══ */

abschnitt('Ohne Masterpasswort wird ehrlich gemeldet, dass nicht verschlüsselt wird');
pruefe('… und meldet hier `true`, solange eines gesetzt ist',
  einmalcode.kontoAnlegen({ geheimnis: GEHEIMNIS }, ICH).verschluesselt === true);
/* Der eigentliche Beweis für den Abschnittstitel braucht einen Prozess, der
   STELLIUM_MASTER_PASSPHRASE nie gesetzt hatte (Begründung ganz oben bei
   OHNE_MASTERPASSWORT) — dieser hier hat es längst getan. Also ein
   Kindprozess mit EINMALCODE_PRUEFEN_OHNE_MP=1, derselbe Wiedereinstieg wie
   beim --experimental-transform-types-Neustart oben, nur mit eigenem
   Schalter statt eigenem Flag. Seine eigenen ✓/✗-Zeilen erscheinen hier
   unverändert im Protokoll; nur sein Endstand fließt in DIESEN Lauf mit
   ein, damit ein Fehlschlag dort auch den Gesamtlauf rot macht. */
/* Ausdrücklich per Objekt-Destrukturierung entfernt, nicht auf `undefined`
   gesetzt: ein Schlüssel mit dem Wert `undefined` bliebe im Objekt stehen,
   und je nach Node-Fassung ist nicht garantiert, dass spawnSync() so einen
   Schlüssel beim Aufbau der Kindumgebung tatsächlich wegließe. */
const { STELLIUM_MASTER_PASSPHRASE: _weglassen, ...kindUmgebung } = process.env;
const kind = spawnSync(
  process.execPath,
  ['--experimental-transform-types', '--no-warnings', fileURLToPath(import.meta.url)],
  {
    env: {
      ...kindUmgebung,
      EINMALCODE_PRUEFEN_OHNE_MP: '1',
      /* Ohne Umgebungspasswort fragt resolvePassphrase() (secrets.ts) als
         Zweites den macOS-Schlüsselbund — und auf einem Arbeitsplatz, der
         schon einmal `npm run secret … setzen` liefen ließ, steht dort ein
         ECHTER Eintrag ("stellium-master"/"stellium"). Diesen Eintrag zu
         LÖSCHEN, nur damit dieser Prüflauf grün wird, wäre der falsche
         Griff — er gehört diesem Rechner, nicht diesem Prüflauf, und ein
         Prüflauf darf kein echtes Geheimnis anfassen. readKeychain() ruft
         intern nur das Programm `security` auf und behandelt JEDEN
         Fehlschlag (auch "Programm nicht gefunden") gleich: kein Schlüssel.
         Ein PATH ohne das Programm `security` erreicht darum genau das
         Gewünschte — der Kindprozess sieht keinen Schlüsselbund-Eintrag,
         egal ob einer existiert —, ohne die Keychain selbst zu berühren. */
      PATH: '',
    },
    encoding: 'utf8',
  },
);
if (kind.stdout) process.stdout.write(kind.stdout);
if (kind.stderr) process.stderr.write(kind.stderr);
gelaufen += 1;
if (kind.status !== 0) gefallen += 1;

/* ══ Aufräumen ══ */

db.close();
/* Das Wegräumen erledigt der exit-Haken ganz oben — auch im Fehlerfall. */

console.log('');
if (gefallen) {
  console.log(`${F.rot}${F.fett}${gefallen} von ${gelaufen} Prüfungen gefallen.${F.aus}`);
  process.exit(1);
}
console.log(`${F.gruen}${F.fett}Alle ${gelaufen} Prüfungen bestanden.${F.aus}`);
