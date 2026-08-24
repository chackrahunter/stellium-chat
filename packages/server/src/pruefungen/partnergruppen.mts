/**
 * Prüft gegen eine frische Datenbank, ob "die KI schlägt nur EINMAL je
 * Adresse eine Gruppe vor" wirklich hält — der Kern der Aufgabe.
 *
 * UND (Abschnitte 7b/8/11): dass "intern" auf einem BELEG beruht, nicht auf
 * dem, was der Absender in seinen "From:"-Kopf geschrieben hat. Das ist
 * keine Feinheit: ohne diese Trennung genügte eine einzige gefälschte Zeile,
 * um in der Gruppe "intern" neben echten Kolleginnen zu stehen — als
 * Tatsache, ohne dass je ein Mensch gefragt worden wäre. Abschnitt 11 fährt
 * genau diesen Angriff durch den echten Weg (mail_nachrichten -> lauf() ->
 * mail_partner) und daneben denselben Weg mit einer ordentlich belegten
 * Mail: die beiden dürfen nicht gleich enden. Angenommen und gespeichert
 * werden aber BEIDE — die Prüfung ist ein Signal, keine Sperre.
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
import { zugangSetzen } from '../services/mailzugang.js';
import { belegFuerEingang } from '../util/absenderbeleg.js';
import { verschluesseln, istChiffrat } from '../crypto/nachrichten.js';
import { blindIndex } from '../crypto/pii.js';

initDb();

// gruppeErstellen() unten braucht einen echten `created_by` -- post_partnergruppen.created_by
// trägt REFERENCES users(id), und schema.sql setzt PRAGMA foreign_keys = ON.
// Dasselbe Muster wie pruefungen/post-aufbewahrung.mts.
db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('pruefer', 'pruefer', 'Prüfer', 'x', 0)`);

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
  bericht, { gesichtet: 0, vorschlaege: 0, internVorschlaege: 0 });
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

/* ── 7) Intern: Domänenvergleich statt KI ────────────────────────── */
console.log('\n7) Intern: Domänenvergleich statt KI');

/* Einmal benannt statt überall wiederholt — die folgenden Abschnitte bauen
   ihre Probe-Adressen und ihre Probe-Prüfergebnisse daraus. */
const EIGENE_DOMAENE = 'stellium.club';
/* So sieht eine Kopfzeile aus, die Cloudflare voranstellt. `header.from`
   nennt die Domäne, für die DMARC tatsächlich geprüft wurde — genau darauf
   kommt es an, siehe util/absenderbeleg.ts. */
const BELEG_GUT = `mx.cloudflare.net; dkim=pass header.d=${EIGENE_DOMAENE}; spf=pass; dmarc=pass header.from=${EIGENE_DOMAENE}`;
const BELEG_SCHLECHT = `mx.cloudflare.net; dkim=none; spf=fail; dmarc=fail header.from=${EIGENE_DOMAENE}`;

pruef('Ohne eingerichtete Domäne ist NIEMAND intern', pg.istInterneAdresse(`irgendwer@${EIGENE_DOMAENE}`), false);

zugangSetzen({ domaene: EIGENE_DOMAENE }, 'pruefer');

pruef('Adresse an der eigenen Domäne gilt als intern', pg.istInterneAdresse('kollegin@stellium.club'), true);
pruef('Groß-/Kleinschreibung spielt keine Rolle', pg.istInterneAdresse('Kollegin@STELLIUM.CLUB'), true);
pruef('Plus-Adressierung ändert nichts an der Domäne', pg.istInterneAdresse('kollegin+urlaub@stellium.club'), true);
pruef('Eine Subdomäne zählt NICHT automatisch mit', pg.istInterneAdresse('support@mail.stellium.club'), false);
pruef('Eine nur ähnlich aussehende fremde Domäne zählt nicht (kein Suffix-Vergleich)',
  pg.istInterneAdresse('kunde@boesestellium.club'), false);
pruef('Eine völlig fremde Adresse ist nicht intern', pg.istInterneAdresse('kunde@beispiel.test'), false);

const ADRESSE_INTERN = `kollegin@${EIGENE_DOMAENE}`;
pruef('Erste Zuweisung MIT Beleg: "zugewiesen"', pg.internZuweisen(ADRESSE_INTERN, 'dmarc'), 'zugewiesen');

const nachZuweisung = pg.gruppeFuer(ADRESSE_INTERN);
pruef('Gruppe steht auf "intern"', nachZuweisung?.gruppe, 'intern');
pruef('Gilt SOFORT als Tatsache, nicht als Vorschlag (gruppeVonKi = false)', nachZuweisung?.gruppeVonKi, false);
pruef('Die eine Gelegenheit der KI ist damit ebenfalls verbraucht', nachZuweisung?.gruppeVorschlagAm !== null, true);
pruef('Keine Begründung -- ein Domänentreffer braucht keine KI-Erklärung', nachZuweisung?.begruendung, null);
pruef('Der Beleg steht dabei -- die Antwort sagt, WARUM die Zeile gilt', nachZuweisung?.gruppeBeleg, 'dmarc');

pruef('Zweite Zuweisung an dieselbe Adresse: übersprungen (nur einmal, wie bei der KI)',
  pg.internZuweisen(ADRESSE_INTERN, 'dmarc'), 'uebersprungen');

// Auch von Hand jederzeit änderbar -- "intern" ist keine Sonderrolle, die
// eine menschliche Entscheidung sperrte.
const vonHandGeaendert = pg.gruppeSetzen(ADRESSE_INTERN, 'kunden');
pruef('Ein Mensch kann eine automatische "intern"-Zuordnung jederzeit ändern', vonHandGeaendert.gruppe, 'kunden');
pruef('Danach trägt die Entscheidung ein Mensch, kein Beleg -- gruppeBeleg ist abgeräumt',
  vonHandGeaendert.gruppeBeleg, null);

/* ── 7b) Der Beleg: ein "From:"-Kopf ist eine Behauptung ──────────
 *
 * Der Domänenvergleich oben liest `mail_nachrichten.von` — und das ist der
 * "From:"-Kopf, den der Absender selbst schreibt. Ohne einen Beleg dahinter
 * genügte eine einzige gefälschte Zeile, um sich zum Kollegen zu erklären.
 * Hier wird die Trennung geprüft, die das verhindert: reiner Textvergleich,
 * ohne Datenbank, ohne Netz (util/absenderbeleg.ts). */
console.log('\n7b) Der Beleg hinter dem Domänentreffer');

const ADRESSE_PRUEFUNG = `belegprobe@${EIGENE_DOMAENE}`;

pruef('Bestandenes DMARC für genau diese Domäne: belegt',
  belegFuerEingang(ADRESSE_PRUEFUNG, BELEG_GUT), 'dmarc');
pruef('Durchgefallenes DMARC: unbelegt -- der "From:"-Kopf zählt allein nicht',
  belegFuerEingang(ADRESSE_PRUEFUNG, BELEG_SCHLECHT), 'ungeprueft');
pruef('Gar kein Prüfergebnis (alte Mail, eigener Einlieferungsweg): unbelegt, nicht "gefälscht"',
  belegFuerEingang(ADRESSE_PRUEFUNG, null), 'ungeprueft');
pruef('Leeres Prüfergebnis: unbelegt', belegFuerEingang(ADRESSE_PRUEFUNG, ''), 'ungeprueft');
pruef('"dmarc=none" ist kein Bestehen', belegFuerEingang(ADRESSE_PRUEFUNG, 'mx; dmarc=none'), 'ungeprueft');
pruef('SPF allein genügt nicht -- es prüft den Umschlag, nicht den "From:"-Kopf',
  belegFuerEingang(ADRESSE_PRUEFUNG, 'mx; spf=pass'), 'ungeprueft');
pruef('Ein selbst erfundener Schlüsselname trägt nicht ("x-mein-dmarc=pass")',
  belegFuerEingang(ADRESSE_PRUEFUNG, 'mx; x-mein-dmarc=pass'), 'ungeprueft');
pruef('Ein bestandenes DMARC für eine FREMDE Domäne beglaubigt diese Adresse nicht',
  belegFuerEingang(ADRESSE_PRUEFUNG, 'mx; dmarc=pass header.from=fremde-firma.test'), 'ungeprueft');
pruef('...und umgekehrt: eine fremde Adresse wird von unserem Beleg nicht beglaubigt',
  belegFuerEingang('fremder@fremde-firma.test', BELEG_GUT), 'ungeprueft');
pruef('Widersprüchliche Belege in EINEM Wert zählen als kein Beleg (angehängte eigene Kopfzeile)',
  belegFuerEingang(ADRESSE_PRUEFUNG, `${BELEG_SCHLECHT}, mx.eigenbau; dmarc=pass header.from=${EIGENE_DOMAENE}`),
  'ungeprueft');
pruef('Groß-/Kleinschreibung im Prüfergebnis spielt keine Rolle',
  belegFuerEingang(ADRESSE_PRUEFUNG, `MX; DMARC=PASS header.from=${EIGENE_DOMAENE.toUpperCase()}`), 'dmarc');
pruef('Ohne "header.from"-Angabe wird keine erfunden -- das bestandene DMARC trägt',
  belegFuerEingang(ADRESSE_PRUEFUNG, 'mx; spf=pass; dkim=pass; dmarc=pass'), 'dmarc');

/* Und dieselbe Trennung dort, wo sie zählt: beim Eintragen. */
const ADRESSE_GEFAELSCHT = `chef@${EIGENE_DOMAENE}`;
pruef('Ohne Beleg wird VORGESCHLAGEN, nicht zugewiesen',
  pg.internZuweisen(ADRESSE_GEFAELSCHT, 'ungeprueft'), 'vorgeschlagen');

const nachVerdacht = pg.gruppeFuer(ADRESSE_GEFAELSCHT);
pruef('Die Gruppe steht auf "intern" -- aber als Vorschlag', nachVerdacht?.gruppe, 'intern');
pruef('NICHT als Tatsache (gruppeVonKi = true)', nachVerdacht?.gruppeVonKi, true);
pruef('Der Grund steht dabei: "ungeprueft"', nachVerdacht?.gruppeBeleg, 'ungeprueft');
pruef('Die EINE Gelegenheit ist NICHT verbrannt -- gruppeVorschlagAm bleibt leer',
  nachVerdacht?.gruppeVorschlagAm, null);
pruef('Der Verdacht liegt in der Durchsicht, wo ein Mensch ihn sieht',
  pg.listePartner({ nurVorschlaege: true }).some((x) => x.adresse === ADRESSE_GEFAELSCHT), true);
pruef('...und zählt in der Zahl an der Leiste mit',
  pg.offeneVorschlaegeAnzahl() >= 1, true);

/* Der Punkt aus dem Auftrag: eine spätere, ordentlich belegte Mail derselben
   Adresse darf die Sache doch noch klären. Genau dafür bleibt
   gruppeVorschlagAm oben leer. */
pruef('Eine spätere BELEGTE Mail derselben Adresse klärt die Sache doch noch',
  pg.internZuweisen(ADRESSE_GEFAELSCHT, 'dmarc'), 'zugewiesen');
const nachKlaerung = pg.gruppeFuer(ADRESSE_GEFAELSCHT);
pruef('Jetzt Tatsache statt Vorschlag', nachKlaerung?.gruppeVonKi, false);
pruef('Jetzt mit Beleg', nachKlaerung?.gruppeBeleg, 'dmarc');
pruef('Und JETZT ist die eine Gelegenheit verbraucht', nachKlaerung?.gruppeVorschlagAm !== null, true);
pruef('Ab hier ändert auch eine weitere unbelegte Mail nichts mehr',
  pg.internZuweisen(ADRESSE_GEFAELSCHT, 'ungeprueft'), 'uebersprungen');
pruef('...die Zeile bleibt die belegte Tatsache', pg.gruppeFuer(ADRESSE_GEFAELSCHT)?.gruppeVonKi, false);

/* Andersherum: ein Mensch, der einen unbelegten Verdacht durchsieht und ihn
   bestätigt, macht daraus eine Tatsache -- und dann trägt seine
   Entscheidung, nicht der fehlende Beleg. */
const ADRESSE_VERDACHT_2 = `buchhaltung@${EIGENE_DOMAENE}`;
pg.internZuweisen(ADRESSE_VERDACHT_2, 'ungeprueft');
const vomMenschenBestaetigt = pg.gruppeSetzen(ADRESSE_VERDACHT_2, 'intern');
pruef('Ein Mensch bestätigt den Verdacht: ab jetzt Tatsache', vomMenschenBestaetigt.gruppeVonKi, false);
pruef('Der Beleg wird dabei abgeräumt -- es entscheidet der Mensch', vomMenschenBestaetigt.gruppeBeleg, null);
pruef('Und die eine Gelegenheit ist damit verbraucht', vomMenschenBestaetigt.gruppeVorschlagAm !== null, true);

/* ── 8) Nachtrag für Altfälle (Backfill) ─────────────────────────── */
console.log('\n8) Nachtrag für Altfälle (Backfill)');

// Eine Adresse, die VOR "intern" schon einen offenen, nie bestätigten
// KI-Vorschlag hatte -- genau der Fall, den der Nachtrag korrigieren soll.
const ADRESSE_ALTFALL = `alter.kollege@${EIGENE_DOMAENE}`;
pg.vorschlagEintragen(ADRESSE_ALTFALL, { gruppe: 'sonstige', begruendung: 'Nicht eindeutig zuzuordnen.' });
pruef('Altfall stand vor dem Nachtrag auf "sonstige", unbestätigt', pg.gruppeFuer(ADRESSE_ALTFALL)?.gruppe, 'sonstige');
pruef('...und war ein offener Vorschlag (gruppeVonKi = true)', pg.gruppeFuer(ADRESSE_ALTFALL)?.gruppeVonKi, true);

// Eine Adresse an DERSELBEN Domäne, die aber schon ein MENSCH entschieden
// hat -- darf der Nachtrag unter KEINEN Umständen anfassen.
const ADRESSE_MENSCHLICH = `entschieden.lieferant@${EIGENE_DOMAENE}`;
pg.gruppeSetzen(ADRESSE_MENSCHLICH, 'lieferanten');

/* Zwei Zeilen sind fällig: der unbestätigte Altfall und -- absichtlich --
   ADRESSE_VERDACHT_2 aus 7b, eine "intern"-Zeile OHNE Beleg. Genau die Form,
   die die vorige, fehlerhafte Fassung dieses Nachtrags erzeugt hat, und die
   sich von einer echten menschlichen Entscheidung nicht unterscheiden lässt
   (siehe internBackfillEinmalig() für die Abwägung: einmal nachfragen ist
   der kleinere Schaden). */
pruef('Der Nachtrag legt zwei Zeilen erneut vor (Altfall + unbelegte "intern"-Zeile)',
  pg.internBackfillEinmalig(), 2);
pruef('Der Altfall steht jetzt auf "intern"', pg.gruppeFuer(ADRESSE_ALTFALL)?.gruppe, 'intern');
pruef('...aber als VORSCHLAG, nicht als Tatsache -- der Beleg ist nicht mehr feststellbar',
  pg.gruppeFuer(ADRESSE_ALTFALL)?.gruppeVonKi, true);
pruef('...und sagt das auch: "altbestand", nicht "ungeprueft" -- unbekannt ist nicht durchgefallen',
  pg.gruppeFuer(ADRESSE_ALTFALL)?.gruppeBeleg, 'altbestand');
pruef('Der Altfall wartet damit in der Durchsicht auf einen Menschen',
  pg.listePartner({ nurVorschlaege: true }).some((x) => x.adresse === ADRESSE_ALTFALL), true);
pruef('Die von Hand auf eine ANDERE Gruppe gesetzte Adresse bleibt UNANGETASTET -- "lieferanten", nicht "intern"',
  pg.gruppeFuer(ADRESSE_MENSCHLICH)?.gruppe, 'lieferanten');
pruef('...und bleibt eine Tatsache', pg.gruppeFuer(ADRESSE_MENSCHLICH)?.gruppeVonKi, false);
pruef('Eine BELEGTE "intern"-Zuweisung dreht der Nachtrag NICHT zurück',
  pg.gruppeFuer(ADRESSE_GEFAELSCHT)?.gruppeVonKi, false);
pruef('...sie behält ihren Beleg', pg.gruppeFuer(ADRESSE_GEFAELSCHT)?.gruppeBeleg, 'dmarc');

pruef('Ein zweiter Aufruf tut nichts mehr -- der Nachtrag läuft höchstens einmal', pg.internBackfillEinmalig(), 0);

/* ── 9) Benutzerdefinierte Gruppen ───────────────────────────────── */
console.log('\n9) Benutzerdefinierte Gruppen');

pruef('Eine erfundene Gruppe ist ungültig', pg.gruppeIstGueltig('does-not-exist'), false);
pruef('"intern" ist eine gültige, eingebaute Gruppe', pg.gruppeIstGueltig('intern'), true);

const neueGruppe = pg.gruppeErstellen('Nachbarschaftsverein', 'pruefer');
pruef('Anlegen liefert eine benutzerdefinierte Gruppe zurück', neueGruppe.eingebaut, false);
pruef('...mit dem eingegebenen Namen', neueGruppe.name, 'Nachbarschaftsverein');
pruef('gruppeIstGueltig() erkennt die neue Gruppe', pg.gruppeIstGueltig(neueGruppe.id), true);

let duplikatAbgewiesen = false;
try { pg.gruppeErstellen('  nachbarschaftsverein  ', 'pruefer'); } catch { duplikatAbgewiesen = true; }
pruef('Derselbe Name (Groß-/Kleinschreibung, Leerraum) wird abgewiesen', duplikatAbgewiesen, true);

let eingebauterNameAbgewiesen = false;
try { pg.gruppeErstellen('Kunden', 'pruefer'); } catch { eingebauterNameAbgewiesen = true; }
pruef('Ein Name wie eine eingebaute Gruppe wird abgewiesen', eingebauterNameAbgewiesen, true);

let zuLangAbgewiesen = false;
try { pg.gruppeErstellen('x'.repeat(31), 'pruefer'); } catch { zuLangAbgewiesen = true; }
pruef('Ein zu langer Name wird abgewiesen', zuLangAbgewiesen, true);

let leerAbgewiesen = false;
try { pg.gruppeErstellen('   ', 'pruefer'); } catch { leerAbgewiesen = true; }
pruef('Ein leerer Name wird abgewiesen', leerAbgewiesen, true);

let eingebauteUmbenennenAbgewiesen = false;
try { pg.gruppeUmbenennen('kunden', 'Käufer'); } catch { eingebauteUmbenennenAbgewiesen = true; }
pruef('Eine eingebaute Gruppe lässt sich nicht umbenennen', eingebauteUmbenennenAbgewiesen, true);

let eingebauteLoeschenAbgewiesen = false;
try { pg.gruppeLoeschen('intern'); } catch { eingebauteLoeschenAbgewiesen = true; }
pruef('Eine eingebaute Gruppe lässt sich nicht löschen', eingebauteLoeschenAbgewiesen, true);

const umbenannt = pg.gruppeUmbenennen(neueGruppe.id, 'Nachbarschaftsverein Süd');
pruef('Umbenennen übernimmt den neuen Namen', umbenannt.name, 'Nachbarschaftsverein Süd');

// Löschen einer Gruppe, die noch Mitglieder hat: macht sie gruppenlos, statt
// die Löschung zu verweigern oder sie stillschweigend zu verschieben (siehe
// Dateikopf von post-partnergruppen.ts, "Löschen nimmt die Schublade weg").
pg.gruppeSetzen('nachbar1@beispiel.test', umbenannt.id);
pg.gruppeSetzen('nachbar2@beispiel.test', umbenannt.id);
pruef('alleGruppen() zählt die zwei Mitglieder korrekt',
  pg.alleGruppen().find((g) => g.id === umbenannt.id)?.anzahl, 2);

const loeschErgebnis = pg.gruppeLoeschen(umbenannt.id);
pruef('Löschen meldet die genaue Zahl betroffener Briefpartner', loeschErgebnis.betroffenePartner, 2);
pruef('Gruppe ist danach ungültig', pg.gruppeIstGueltig(umbenannt.id), false);
pruef('Ehemaliges Mitglied 1 ist jetzt gruppenlos, NICHT verschoben', pg.gruppeFuer('nachbar1@beispiel.test')?.gruppe, null);
pruef('Ehemaliges Mitglied 2 ist jetzt gruppenlos, NICHT verschoben', pg.gruppeFuer('nachbar2@beispiel.test')?.gruppe, null);

let geloeschteNochmalLoeschen = false;
try { pg.gruppeLoeschen(umbenannt.id); } catch { geloeschteNochmalLoeschen = true; }
pruef('Eine bereits gelöschte Gruppe lässt sich nicht noch einmal löschen', geloeschteNochmalLoeschen, true);

const gruppeZwei = pg.gruppeErstellen('Presse', 'pruefer');
const gruppenliste = pg.alleGruppen();
pruef('Erste Gruppe ist "intern"', gruppenliste[0]?.id, 'intern');
pruef('Die sieben eingebauten Gruppen stehen vor den benutzerdefinierten',
  gruppenliste.slice(0, 7).every((g) => g.eingebaut), true);
pruef('"Presse" steht als benutzerdefinierte Gruppe in der Liste',
  gruppenliste.some((g) => g.id === gruppeZwei.id && !g.eingebaut), true);

// Obergrenze: höchstens 20 benutzerdefinierte Gruppen gleichzeitig.
const vorhandeneBenutzerGruppen = pg.alleGruppen().filter((g) => !g.eingebaut).length;
for (let i = vorhandeneBenutzerGruppen; i < 20; i++) pg.gruppeErstellen(`Testgruppe ${i}`, 'pruefer');
let obergrenzeAbgewiesen = false;
try { pg.gruppeErstellen('Eine zu viel', 'pruefer'); } catch { obergrenzeAbgewiesen = true; }
pruef('Bei 20 benutzerdefinierten Gruppen wird eine 21. abgewiesen', obergrenzeAbgewiesen, true);

/* ── 10) lauf() ohne KI, aber MIT Domäne: intern kommt trotzdem durch ─── */
console.log('\n10) lauf() ohne KI, aber mit eingerichteter Domäne');

// Die Sonde aus Abschnitt 5 hat ihren Zweck erfüllt (sie bewies, dass OHNE
// jede Konfiguration nichts passiert) und stünde jetzt, wo eine Domäne
// eingerichtet ist, als älteste Zeile im Weg -- lauf() bricht an der ERSTEN
// nicht-internen, nicht entschiedenen Zeile ohne KI ab (siehe dort), und
// diese Sonde ist genau das. Aufgeräumt, damit dieser Abschnitt zeigt, was
// er zeigen soll: eine interne Adresse kommt OHNE KI durch, eine externe
// wartet weiterhin.
db.run("DELETE FROM mail_nachrichten WHERE id = 'pg-probe-msg-1'");

const ADRESSE_NEUER_KOLLEGE = `neuer.kollege@${EIGENE_DOMAENE}`;
db.run(
  `INSERT INTO mail_nachrichten (id, fach, richtung, von, an, betreff, text, pruefung, am, gelesen, anhaenge)
   VALUES ('pg-probe-msg-2', 'sales', 'ein', ?, ?, ?, ?, ?, ?, 0, '[]')`,
  verschluesseln(ADRESSE_NEUER_KOLLEGE), verschluesseln(`sales@${EIGENE_DOMAENE}`),
  verschluesseln('Hallo'), verschluesseln('Kurze Frage zum Projekt.'), BELEG_GUT, Date.now(),
);
db.run(
  `INSERT INTO mail_nachrichten (id, fach, richtung, von, an, betreff, text, am, gelesen, anhaenge)
   VALUES ('pg-probe-msg-3', 'sales', 'ein', ?, ?, ?, ?, ?, 0, '[]')`,
  verschluesseln('aussenstehend@beispiel.test'), verschluesseln(`sales@${EIGENE_DOMAENE}`),
  verschluesseln('Angebot'), verschluesseln('Wir hätten Interesse an einer Zusammenarbeit.'), Date.now(),
);

const berichtMitDomaene = await pg.lauf();
pruef('Genau eine Zeile gesichtet (die interne -- die externe wartet ohne KI)', berichtMitDomaene.gesichtet, 1);
pruef('Keine "Vorschläge" entstanden -- eine belegte Zuweisung ist keiner', berichtMitDomaene.vorschlaege, 0);
pruef('...auch kein unbelegter: die Mail trug ein bestandenes DMARC', berichtMitDomaene.internVorschlaege, 0);
pruef('Die interne Adresse wurde sofort eingeordnet -- keine KI nötig',
  pg.gruppeFuer(ADRESSE_NEUER_KOLLEGE)?.gruppe, 'intern');
pruef('...als Tatsache, weil die Mail den Beleg mitbrachte',
  pg.gruppeFuer(ADRESSE_NEUER_KOLLEGE)?.gruppeVonKi, false);
pruef('...und der Beleg steht in der Zeile', pg.gruppeFuer(ADRESSE_NEUER_KOLLEGE)?.gruppeBeleg, 'dmarc');
pruef('Die externe Adresse bekam KEINEN Eintrag -- ohne KI wartet sie auf den nächsten Durchlauf',
  pg.gruppeFuer('aussenstehend@beispiel.test'), null);

/* ── 11) Der gefälschte "From:"-Kopf, durch den ganzen Lauf ──────────
 *
 * Der Fall, der diese Prüfung nötig gemacht hat: ein Fremder schreibt an die
 * Firmenadresse und trägt `From: <irgendwer>@<eigene-domaene>` ein. Die Mail
 * wird angenommen und gespeichert -- das soll so bleiben, "Signal, nie
 * Sperre". Aber sie darf ihren Absender nicht zum Kollegen machen.
 *
 * Anders als 7b (Funktionen einzeln) läuft hier der echte Weg: Zeile in
 * `mail_nachrichten`, `lauf()`, Ergebnis in `mail_partner`. */
console.log('\n11) Gefälschter "From:"-Kopf durch den ganzen Lauf');

/* Die externe Sonde aus 10 hat ihren Zweck erfüllt und stünde jetzt als
   älteste unbearbeitete Zeile im Weg -- lauf() bricht ohne KI an der ersten
   nicht-internen, unentschiedenen Adresse ab (siehe dort). */
db.run("DELETE FROM mail_nachrichten WHERE id = 'pg-probe-msg-3'");

const ADRESSE_FAELSCHUNG = `geschaeftsfuehrung@${EIGENE_DOMAENE}`;
const ADRESSE_ECHT = `echte.kollegin@${EIGENE_DOMAENE}`;
const ADRESSE_OHNE_PRUEFUNG = `alter.verteiler@${EIGENE_DOMAENE}`;

const eingang = (id: string, von: string, pruefung: string | null) => db.run(
  `INSERT INTO mail_nachrichten (id, fach, richtung, von, an, betreff, text, pruefung, am, gelesen, anhaenge)
   VALUES (?, 'sales', 'ein', ?, ?, ?, ?, ?, ?, 0, '[]')`,
  id, verschluesseln(von), verschluesseln(`sales@${EIGENE_DOMAENE}`),
  verschluesseln('Dringend'), verschluesseln('Bitte kurz erledigen.'), pruefung, Date.now(),
);

// Reihenfolge über die Kennung, lauf() geht ORDER BY id ASC.
eingang('pg-probe-msg-4', ADRESSE_FAELSCHUNG, BELEG_SCHLECHT);
eingang('pg-probe-msg-5', ADRESSE_ECHT, BELEG_GUT);
eingang('pg-probe-msg-6', ADRESSE_OHNE_PRUEFUNG, null);

const berichtFaelschung = await pg.lauf();
pruef('Alle drei Mails wurden gesichtet -- keine wurde abgewiesen oder verworfen',
  berichtFaelschung.gesichtet, 3);
pruef('Zwei davon gelten als unbelegt und wurden nur vorgeschlagen',
  berichtFaelschung.internVorschlaege, 2);

// ── Der Kern: die Fälschung wird KEINE Tatsache. ──
const gefaelscht = pg.gruppeFuer(ADRESSE_FAELSCHUNG);
pruef('Die gefälschte Adresse ist bekannt -- die Mail ging nicht verloren', gefaelscht !== null, true);
pruef('Sie wird NICHT als Tatsache geführt (gruppeVonKi = true)', gefaelscht?.gruppeVonKi, true);
pruef('Der Grund steht dabei: der Absenderbeleg fiel durch', gefaelscht?.gruppeBeleg, 'ungeprueft');
pruef('Die eine Gelegenheit wurde NICHT auf diesen Verdacht verbrannt',
  gefaelscht?.gruppeVorschlagAm, null);
pruef('Sie liegt in der Durchsicht -- der Inhaber wird gefragt, statt übergangen',
  pg.listePartner({ nurVorschlaege: true }).some((x) => x.adresse === ADRESSE_FAELSCHUNG), true);

// ── Die echte Kollegin wird sehr wohl eine Tatsache. ──
const echt = pg.gruppeFuer(ADRESSE_ECHT);
pruef('Die belegte Adresse steht auf "intern"', echt?.gruppe, 'intern');
pruef('...als Tatsache, ohne Nachfrage', echt?.gruppeVonKi, false);
pruef('...mit Beleg', echt?.gruppeBeleg, 'dmarc');
pruef('...und sie steht NICHT in der Durchsicht -- da gibt es nichts zu entscheiden',
  pg.listePartner({ nurVorschlaege: true }).some((x) => x.adresse === ADRESSE_ECHT), false);

// ── Fehlender Beleg ist nicht dasselbe wie ein durchgefallener, aber
//    behandelt wird beides gleich vorsichtig: fragen statt annehmen. ──
const ohnePruefung = pg.gruppeFuer(ADRESSE_OHNE_PRUEFUNG);
pruef('Eine Mail ganz ohne Prüfergebnis macht ebenfalls keine Tatsache',
  ohnePruefung?.gruppeVonKi, true);
pruef('...bleibt aber als "intern" vorgeschlagen, statt zu verschwinden',
  ohnePruefung?.gruppe, 'intern');

// ── Und der Nachweis, dass der Verdacht später noch aufzulösen ist. ──
eingang('pg-probe-msg-7', ADRESSE_FAELSCHUNG, BELEG_GUT);
const berichtNachweis = await pg.lauf();
pruef('Die spätere, belegte Mail wurde gesichtet', berichtNachweis.gesichtet, 1);
pruef('Sie ist kein Vorschlag mehr', berichtNachweis.internVorschlaege, 0);
const geklaert = pg.gruppeFuer(ADRESSE_FAELSCHUNG);
pruef('Aus dem Verdacht ist jetzt eine belegte Tatsache geworden', geklaert?.gruppeVonKi, false);
pruef('...mit Beleg', geklaert?.gruppeBeleg, 'dmarc');
pruef('...und die Durchsicht ist um diesen Eintrag leichter',
  pg.listePartner({ nurVorschlaege: true }).some((x) => x.adresse === ADRESSE_FAELSCHUNG), false);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mNur einmal heißt hier wirklich nur einmal — und "intern" nur mit Beleg.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
