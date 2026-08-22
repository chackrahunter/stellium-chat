/**
 * Prüft gegen eine frische Datenbank, ob "die KI schlägt nur EINMAL je
 * Adresse eine Gruppe vor" wirklich hält — der Kern der Aufgabe.
 *
 * Geprüft wird an `vorschlagEintragen()` und `gruppeSetzen()` direkt, nicht
 * am vollen Hintergrundtakt (`lauf()`/`startPartnerGruppenJob()`): DIESE
 * beiden Funktionen sind die Stelle, an der die Regel tatsächlich
 * durchgesetzt wird — der Takt drumherum ist nur Modellaufruf plus
 * Wasserstand über `mail_nachrichten` und würde einen echten
 * Sprachmodell-Zugang brauchen, um etwas zu beweisen, das an dieser Stelle
 * nicht zur Debatte steht (siehe unten, Abschnitt 5, für den einen Fall, der
 * OHNE Modell prüfbar ist: dass ohne eingerichtete KI nichts verloren geht).
 *
 * Aufruf:  node scripts/partnergruppen-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import * as pg from '../services/post-partnergruppen.js';
import { verschluesseln, istChiffrat } from '../crypto/nachrichten.js';
import { blindIndex } from '../crypto/pii.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/* ── 1) Erster Kontakt: EIN Vorschlag entsteht ───────────────────── */
console.log('\n1) Erster Kontakt');

const ADRESSE_1 = 'kundin@beispiel.test';

const ersterVersuch = pg.vorschlagEintragen(ADRESSE_1, { gruppe: 'kunden', begruendung: 'Fragt zur Rechnung.' });
pruef('Erster Kontakt: ein Vorschlag entsteht', ersterVersuch, 'eingetragen');

const nachErstemVersuch = pg.gruppeFuer(ADRESSE_1);
pruef('Die Gruppe steht als VORSCHLAG da, nicht als Tatsache', nachErstemVersuch?.gruppeVonKi, true);
pruef('Die vorgeschlagene Gruppe stimmt', nachErstemVersuch?.gruppe, 'kunden');
pruef('Die Begründung der KI steht dabei', nachErstemVersuch?.begruendung, 'Fragt zur Rechnung.');
const ersterZeitpunkt = nachErstemVersuch?.gruppeVorschlagAm ?? null;
pruef('Ein Zeitpunkt für die EINE Gelegenheit ist vermerkt', typeof ersterZeitpunkt === 'number' && ersterZeitpunkt > 0, true);

/* ── 2) Zweite bis zehnte Mail derselben Adresse: KEIN weiterer Vorschlag ─
 * — auch dann nicht, wenn der erste nie bestätigt wurde. Genau der Fall, den
 * der Auftraggeber ausdrücklich nannte: ein vielschreibender Absender darf
 * keinen Modellaufruf nach dem anderen auslösen. */
console.log('\n2) Zweite bis zehnte Mail derselben, noch unbestätigten Adresse');

const wiederholteVersuche: string[] = [];
for (let mail = 2; mail <= 10; mail++) {
  wiederholteVersuche.push(pg.vorschlagEintragen(ADRESSE_1, { gruppe: 'lieferanten', begruendung: `Versuch Nr. ${mail}` }));
}
pruef('9 weitere "Mails" (2. bis 10.): jedes Mal übersprungen, kein neuer Vorschlag',
  wiederholteVersuche, Array(9).fill('uebersprungen'));

const nachWiederholung = pg.gruppeFuer(ADRESSE_1);
pruef('Die Gruppe bleibt beim ERSTEN Vorschlag stehen ("kunden", nicht "lieferanten")',
  nachWiederholung?.gruppe, 'kunden');
pruef('Der Vorschlagszeitpunkt bleibt der ursprüngliche — kein neuer Versuch hat ihn verschoben',
  nachWiederholung?.gruppeVorschlagAm, ersterZeitpunkt);
pruef('Bleibt weiterhin als unbestätigter Vorschlag markiert — niemand hat je entschieden',
  nachWiederholung?.gruppeVonKi, true);

/* ── 3) Von Hand gesetzt ist endgültig — die KI rührt es nie wieder an ─── */
console.log('\n3) Von Hand gesetzt ist endgültig');

// 3a: ein Mensch entscheidet, NACHDEM die KI schon einen Vorschlag gemacht hat.
const nachMenschenEntscheidung = pg.gruppeSetzen(ADRESSE_1, 'behoerden');
pruef('Ein Mensch ändert die vorgeschlagene Gruppe', nachMenschenEntscheidung.gruppe, 'behoerden');
pruef('Gilt ab jetzt als Tatsache, nicht mehr als Vorschlag', nachMenschenEntscheidung.gruppeVonKi, false);
pruef('Die alte Begründung der KI verschwindet — sie erklärte eine Gruppe, die nicht mehr gilt',
  nachMenschenEntscheidung.begruendung, null);

const kiVersuchNachMenschenEntscheidung = pg.vorschlagEintragen(ADRESSE_1, { gruppe: 'sonstige', begruendung: 'Die KI würde jetzt anders entscheiden.' });
pruef('Die KI überschreibt eine von Hand gesetzte Gruppe NIE',
  kiVersuchNachMenschenEntscheidung, 'uebersprungen');
pruef('Die Gruppe bleibt bei der menschlichen Entscheidung',
  pg.gruppeFuer(ADRESSE_1)?.gruppe, 'behoerden');

// 3b: ein Mensch entscheidet, BEVOR die KI je gefragt wurde — der Fall, den
// der Auftrag ausdrücklich nennt: "Auch wenn niemand entschieden hat" gilt
// hier andersherum genauso: auch wenn die KI NIE gefragt wurde, gilt danach
// nie wieder ein Vorschlag.
const ADRESSE_2 = 'admin@firma.test';
pruef('Adresse 2 ist noch komplett unbekannt', pg.gruppeFuer(ADRESSE_2), null);

const vonHandVorab = pg.gruppeSetzen(ADRESSE_2, 'firmen');
pruef('Von Hand gesetzt, bevor die KI je gefragt wurde', vonHandVorab.gruppe, 'firmen');
pruef('Die eine Gelegenheit der KI gilt damit ebenfalls als verbraucht',
  vonHandVorab.gruppeVorschlagAm !== null, true);

const kiVersuchAdresse2 = pg.vorschlagEintragen(ADRESSE_2, { gruppe: 'kunden', begruendung: 'Zu spät.' });
pruef('Die KI bekommt für Adresse 2 nie eine Gelegenheit', kiVersuchAdresse2, 'uebersprungen');
pruef('Gruppe von Adresse 2 bleibt die von Hand gesetzte', pg.gruppeFuer(ADRESSE_2)?.gruppe, 'firmen');

// 3c: Bestätigen (derselbe Wert) ist etwas anderes als Ändern — die
// Begründung der KI bleibt stehen, weil sie weiterhin erklärt, warum die
// Zeile so steht.
const ADRESSE_3 = 'bewerber@post.test';
pg.vorschlagEintragen(ADRESSE_3, { gruppe: 'bewerber', begruendung: 'Schreibt eine Bewerbung.' });
const bestaetigt = pg.gruppeSetzen(ADRESSE_3, 'bewerber');
pruef('Bestätigen (derselbe Wert) behält die Begründung der KI',
  bestaetigt.begruendung, 'Schreibt eine Bewerbung.');
pruef('Gilt nach dem Bestätigen als Tatsache, nicht mehr als Vorschlag', bestaetigt.gruppeVonKi, false);

// Eine unbekannte Gruppe wird abgewiesen, nicht stillschweigend übernommen.
let ungueltigAbgewiesen = false;
try { pg.gruppeSetzen('irgendwer@nirgendwo.test', 'vip' as never); } catch { ungueltigAbgewiesen = true; }
pruef('Eine unbekannte Gruppe wird abgewiesen', ungueltigAbgewiesen, true);

/* ── 4) Die Adresse steht auch in dieser Tabelle nicht im Klartext ──────
 * Dieselbe Machart wie umfrage-anonym.mts: nicht über den Dienst gelesen
 * (der könnte selbst beschönigen), sondern mit eigenem SQL gegen dieselbe
 * Tabelle, die auch ein Betreiber mit Dateizugriff sähe. */
console.log('\n4) Verschlüsselung — rohe Datenbank');

const rohZeile1 = db.get<{ adresse: string }>(
  'SELECT adresse FROM mail_partner WHERE adresse_bidx = ?', blindIndex(ADRESSE_1),
);
pruef('Die Adresse liegt als Chiffrat vor (nicht als Klartext)', istChiffrat(rohZeile1?.adresse ?? ''), true);
pruef('Das Chiffrat enthält die Adresse nicht wortwörtlich',
  (rohZeile1?.adresse ?? '').includes(ADRESSE_1), false);
pruef('Trotzdem über den Blindindex wiederfindbar', pg.gruppeFuer(ADRESSE_1)?.adresse, ADRESSE_1);

const alleAdressen = db.all<{ adresse: string }>('SELECT adresse FROM mail_partner');
pruef('Mindestens die drei angelegten Probe-Adressen liegen in der Tabelle',
  alleAdressen.length >= 3, true);
pruef('KEINE einzige Zeile in mail_partner liegt im Klartext',
  alleAdressen.some((z) => !istChiffrat(z.adresse)), false);

/* ── 5) Ohne eingerichtete KI geht nichts verloren ───────────────────────
 * Der einzige Teil von lauf(), der sich ohne echtes Modell ehrlich prüfen
 * lässt — und ein wichtiger: ein Server ohne KI-Anbindung (kein
 * AI_PROVIDER/Schlüssel, der Normalfall in DIESER Prüfumgebung) darf weder
 * abstürzen noch stillschweigend eine Mail als "gesichtet" verbuchen, die
 * nie wirklich gesehen wurde — sonst holte ein später eingerichtetes Modell
 * sie nie mehr nach. */
console.log('\n5) Ohne eingerichtete KI (Normalfall dieser Prüfumgebung)');

const wasserstandVorLauf = db.get<{ value: string }>(
  "SELECT value FROM app_settings WHERE key = 'partnergruppen_ab'",
)?.value ?? null;

db.run(
  `INSERT INTO mail_nachrichten (id, fach, richtung, von, an, betreff, text, am, gelesen, anhaenge)
   VALUES ('pg-probe-msg-1', 'sales', 'ein', ?, ?, ?, ?, ?, 0, '[]')`,
  verschluesseln('neu@nie-gesehen.test'), verschluesseln('sales@stellium.club'),
  verschluesseln('Interesse'), verschluesseln('Ich interessiere mich für Stellium.'), Date.now(),
);

const bericht = await pg.lauf();
pruef('lauf() ohne KI: 0 gesichtet, 0 Vorschläge — kein Absturz, keine Behauptung',
  bericht, { gesichtet: 0, vorschlaege: 0 });
pruef('Der Wasserstand bleibt unverändert — ein später eingerichtetes Modell holt alles nach',
  db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'partnergruppen_ab'")?.value ?? null,
  wasserstandVorLauf);
pruef('Für die neue Adresse entstand kein Eintrag', pg.gruppeFuer('neu@nie-gesehen.test'), null);

/* ── 6) Lesen und filtern — was die Oberfläche braucht ──────────────── */
console.log('\n6) Lesen und filtern');

const nurBehoerden = pg.listePartner({ gruppe: 'behoerden' });
pruef('Filter nach Gruppe liefert ausschließlich diese Gruppe',
  nurBehoerden.every((p) => p.gruppe === 'behoerden'), true);
pruef('Adresse 1 erscheint darin (sie steht jetzt bei "behoerden")',
  nurBehoerden.some((p) => p.adresse === ADRESSE_1), true);

const nurVorschlaege = pg.listePartner({ nurVorschlaege: true });
pruef('Filter "nur Vorschläge" enthält ausschließlich unbestätigte',
  nurVorschlaege.every((p) => p.gruppeVonKi === true), true);
pruef('Adresse 1 (von Hand entschieden) steht NICHT mehr unter "nur Vorschläge"',
  nurVorschlaege.some((p) => p.adresse === ADRESSE_1), false);
pruef('Adresse 2 (von Hand VORAB gesetzt) stand nie unter "nur Vorschläge"',
  nurVorschlaege.some((p) => p.adresse === ADRESSE_2), false);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mNur einmal heißt hier wirklich nur einmal — auch in der Datenbank.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
