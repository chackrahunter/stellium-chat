/**
 * Prüft die Fußzeile einer KI-beteiligten ausgehenden Mail — gegen eine
 * WEGWERFBARE Datenbank und OHNE echten Netzzugriff: `global.fetch` wird
 * durch einen eigenen Ersatz ersetzt, der den JSON-Rumpf aufzeichnet, den
 * `post.senden()` an den Versanddienst geschickt hätte, und selbst eine
 * erfundene Resend-Antwort zurückgibt. Dieselbe Haltung wie beim
 * `Modellfrage`-Parameter von post-lernen.ts (scripts/e2e-postgedaechtnis.mjs):
 * ein austauschbarer Rand, kein echter Dienst im Prüflauf.
 *
 * FÜNF ZUSAGEN, GEGEN DEN ECHTEN CODE GEPRÜFT
 *
 *   1. Die drei Fälle aus dem Auftrag — KI allein, KI+Mensch, Mensch
 *      allein — enden in genau der richtigen Fußzeile (oder gar keiner),
 *      und zwar sowohl im Text- als auch im HTML-Teil der tatsächlich
 *      verschickten Mail UND in der Zeile, die im eigenen Postfach landet.
 *   2. Eine rein whitespace-verändernde Bearbeitung zählt weiterhin als
 *      "KI allein" — nicht als "bearbeitet". Der Auftrag verlangt das
 *      ausdrücklich ("im Zweifel gilt eine Antwort als von der KI erstellt").
 *   3. Die HTML-Fußzeile ist klein und blass, aber LESBAR — kein
 *      `display:none`, kein `visibility:hidden`, keine Schriftgröße 0.
 *   4. `post-lernen.ts::quellen()` lernt aus rein menschlicher Post, aber
 *      NIE aus einer Mail, an der die KI mitgeschrieben hat — unverändert
 *      wie bearbeitet, über beide Wege (mail_entwuerfe.text_ki UND
 *      mail_nachrichten.ki_art ohne Entwurfszeile).
 *   5. DER FALL, DER AUF DEM PI TATSÄCHLICH LIEGT, nicht nur der, den die
 *      aktuelle Ausgabe selbst erzeugt: eine bereits VOR diesem Release
 *      gesendete, KI-beteiligte Mail, deren `mail_entwuerfe.text_ki` UND
 *      deren `mail_nachrichten.ki_art` beide NULL sind, weil es diese
 *      Spalten damals noch nicht gab — nicht, weil keine KI beteiligt war.
 *      Muss beim allerersten Lauf übersprungen werden, nicht klassifiziert.
 *
 * Aufruf:  node scripts/post-fussnote-pruefen.mjs
 */
import { db, initDb } from '../db/index.js';
import { entschluesseln, verschluesseln } from '../crypto/nachrichten.js';
import { blindIndex } from '../crypto/pii.js';
import { zugangSetzen } from '../services/mailzugang.js';
import * as post from '../services/post.js';
import * as postLernen from '../services/post-lernen.js';
import { getSetting } from '../services/settings.js';
import {
  KENNZEICHNUNG_DE, KENNZEICHNUNG_EN, KENNZEICHNUNG_BEARBEITET_DE, KENNZEICHNUNG_BEARBEITET_EN,
} from '../services/post-ki.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};
const pruefWahr = (name: string, ist: boolean) => pruef(name, ist, true);

// post_settings.changed_by / mail_partner brauchen keinen echten Nutzer,
// zugangSetzen()s Aufrufer schon (settings.changed_by REFERENCES users(id)) —
// dasselbe Muster wie pruefungen/post-aufbewahrung.mts, partnergruppen.mts.
db.run(`INSERT INTO users (id, handle, display_name, password_hash, created_at)
        VALUES ('pruefer', 'pruefer', 'Prüfer', 'x', 0)`);
zugangSetzen({ domaene: 'test.example', versandSchluessel: 'sk_test_dummy' }, 'pruefer');

/* ── Der Netz-Ersatz ─────────────────────────────────────────────
   Zeichnet den letzten JSON-Rumpf auf, den senden() an Resend geschickt
   hätte, und antwortet ohne jede Netzverbindung. */
let letzterRumpf: any = null;
let zaehler = 0;
(globalThis as any).fetch = async (_url: string, init: { body?: string }) => {
  letzterRumpf = init?.body ? JSON.parse(init.body) : null;
  zaehler += 1;
  return new Response(JSON.stringify({ id: `resend_probe_${zaehler}` }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

/** Setzt die gelernte Sprache eines Briefpartners direkt, ohne über
    spracheLernen() (und damit ohne echte Spracherkennung) gehen zu müssen —
    dieselbe Tabelle, die post.spracheFuer() liest. */
function spracheSetzen(adresse: string, sprache: string): void {
  db.run(
    `INSERT INTO mail_partner (adresse_bidx, adresse, sprache, sicher, seit) VALUES (?,?,?,?,?)
       ON CONFLICT(adresse_bidx) DO UPDATE SET sprache = excluded.sprache`,
    blindIndex(adresse), verschluesseln(adresse), sprache, 1, Date.now(),
  );
}

/** Liest die gespeicherte gesendete Zeile roh aus — entschlüsselt, wie sie
    ein Mensch im eigenen Postfach sähe. */
function gesendeteZeile(id: string): { text: string; html: string | null; kiArt: string | null } {
  const z = db.get<{ text: string; html: string | null; ki_art: string | null }>(
    'SELECT text, html, ki_art FROM mail_nachrichten WHERE id = ?', id,
  )!;
  return { text: entschluesseln(z.text), html: z.html ? entschluesseln(z.html) : null, kiArt: z.ki_art };
}

/* Lang genug für MINDEST_ZEICHEN in post-lernen.ts (200) UND damit die
   Fälle unten wirklich an der KI-Prüfung hängenbleiben, nicht schon vorher
   an "zu kurz". */
const ANREDE = 'Hallo Frau Muster,\n\n';
const SCHLUSS = '\n\nStellium Support Team';
const KI_KERN = 'vielen Dank für Ihre Nachricht. Wir kümmern uns umgehend darum und melden uns in '
  + 'Kürze mit weiteren Informationen zu Ihrer Anfrage bei Ihnen. Bitte haben Sie noch etwas Geduld.';
const KI_TEXT = `${ANREDE}${KI_KERN}${SCHLUSS}`;

console.log('\n0) Der Fall, der auf dem Pi tatsächlich liegt — Altbestand ohne text_ki/ki_art:');
{
  // Nachgebaut, GENAU wie post-sichtung.ts es vor dieser Ausgabe hinterlassen
  // hat: eine gesendete, KI-beteiligte Mail (mail_nachrichten, richtung='aus')
  // mit `ki_art` NULL, dazu ein `mail_entwuerfe`-Eintrag mit `gesendet_id`
  // darauf und `text_ki` NULL — beide Spalten gab es damals noch nicht, nicht
  // weil keine KI beteiligt war. Absichtlich direkt in die Tabelle geschrieben
  // statt über post.senden(): DAS erzeugt heutige, korrekt befüllte Spalten
  // und könnte diesen Fall gar nicht nachstellen.
  //
  // Die Kennung sortiert bewusst vor jeder von newId() vergebenen — lauter
  // Nullen nach dem Präfix sind das kleinste Zeichen im Basis-36-Alphabet,
  // siehe util/id.ts — und dieser Block läuft VOR jedem post.senden() in
  // diesem Prüflauf, ist also auch zeitlich der älteste Datensatz.
  const altKennung = 'po_00000000000altbestandvorrelease';
  const altText = `${ANREDE}vielen Dank für Ihre Nachricht von damals, wir kümmern uns bereits ausführlich `
    + `darum und melden uns mit weiteren Details zu Ihrem alten Anliegen bei Ihnen zurück.${SCHLUSS}`;
  db.run(
    `INSERT INTO mail_nachrichten (id, fach, richtung, von, an, betreff, text, am, gelesen, ki_art)
     VALUES (?, 'support', 'aus', ?, ?, ?, ?, ?, 1, NULL)`,
    altKennung, verschluesseln('support@stellium.example'), verschluesseln('kunde-alt@kunde.example'),
    verschluesseln('Ihr altes Anliegen'), verschluesseln(altText), Date.now() - 10 * 86_400_000,
  );
  db.run(
    `INSERT INTO mail_entwuerfe (id, mail_id, thread_id, an, betreff, text, text_ki, zustand, erstellt_am, gesendet_id)
     VALUES ('pe_altbestand', 'po_quelle_alt', 'th_alt', ?, ?, ?, NULL, 'gesendet', ?, ?)`,
    verschluesseln('kunde-alt@kunde.example'), verschluesseln('Ihr altes Anliegen'),
    verschluesseln(altText), Date.now() - 10 * 86_400_000, altKennung,
  );

  pruef('Wasserstand ist vor dem ersten Lauf unbekannt (frische Installation)',
    getSetting('wissen_lernen_ab'), null);

  const geloggt: string[] = [];
  const echtesLog = console.log;
  console.log = (...teile: unknown[]) => { geloggt.push(teile.join(' ')); echtesLog(...teile); };
  const { kandidaten, abgehakt, absagen } = postLernen.quellen(500);
  console.log = echtesLog;

  pruefWahr('Die Altzeile wird NICHT zur Kandidatin (der eigentliche Defekt)',
    !kandidaten.some((k) => k.mailId === altKennung));
  pruef('Die Altzeile taucht auch nicht als klassifiziert-aber-abgelehnt auf '
    + '(sie wird übersprungen, nicht "kaumVeraendert"/"kiText" geraten)',
    altKennung in absagen, false);
  pruef('Die Altzeile steht auch nicht in "abgehakt" -- sie wird vom Wasserstand '
    + 'verschluckt, bevor die Abfrage sie überhaupt sieht', abgehakt.includes(altKennung), false);
  pruef('Kein Kandidat aus dieser ersten Runde -- die einzige vorhandene Zeile ist die Altzeile',
    kandidaten.length, 0);

  pruef('Der Wasserstand ist jetzt gesetzt, nicht mehr null', getSetting('wissen_lernen_ab') !== null, true);
  pruefWahr('Der Wasserstand liegt bei/oberhalb der Altzeile, nicht darunter',
    (getSetting('wissen_lernen_ab') ?? '') >= altKennung);
  pruefWahr('Ein Operator sieht im Log, dass hier ein Bestand übersprungen wurde, nicht nur Stille',
    geloggt.some((z) => z.includes('post-lernen') && z.includes('Erster Lauf')
      && z.includes('NICHT') && z.includes(altKennung)));
}

console.log('\n1) KI allein, unverändert übernommen, Deutsch:');
{
  spracheSetzen('kunde-a@kunde.example', 'de');
  const { id } = await post.senden({
    fach: 'support', an: 'kunde-a@kunde.example', betreff: 'Ihre Anfrage',
    text: KI_TEXT, textKi: KI_TEXT,
  });
  pruef('Fußzeile im gesendeten Text (Resend-Aufruf)',
    letzterRumpf.text.endsWith(`\n\n${KENNZEICHNUNG_DE}`), true);
  pruefWahr('HTML-Teil wurde mitgeschickt', typeof letzterRumpf.html === 'string');
  pruefWahr('HTML enthält die Fußzeile', letzterRumpf.html.includes(KENNZEICHNUNG_DE));
  pruefWahr('HTML-Fußzeile ist NICHT versteckt (kein display:none)', !letzterRumpf.html.includes('display:none') && !letzterRumpf.html.includes('display: none'));
  pruefWahr('HTML-Fußzeile ist NICHT versteckt (kein visibility:hidden)', !letzterRumpf.html.includes('visibility:hidden'));
  pruefWahr('HTML-Fußzeile hat keine Schriftgröße 0', !/font-size:\s*0/.test(letzterRumpf.html));
  pruefWahr('HTML-Fußzeile ist kleiner gesetzt als der Fließtext (12px vs. 14px)',
    letzterRumpf.html.includes('font-size:12px') && letzterRumpf.html.includes('font-size:14px'));
  pruefWahr('HTML-Fußzeile ist blassgrau, nicht Fließtextfarbe', letzterRumpf.html.includes('#767676'));

  const zeile = gesendeteZeile(id);
  pruef('mail_nachrichten.ki_art', zeile.kiArt, 'ki');
  pruefWahr('Gespeicherter Text trägt dieselbe Fußzeile wie der Versand', zeile.text.endsWith(`\n\n${KENNZEICHNUNG_DE}`));
  pruefWahr('Gespeichertes HTML trägt dieselbe Fußzeile wie der Versand', (zeile.html ?? '').includes(KENNZEICHNUNG_DE));
}

console.log('\n2) KI allein, nur Whitespace verändert — zählt weiterhin als "KI allein":');
{
  spracheSetzen('kunde-b@kunde.example', 'de');
  // Nur Leerraum verändert: doppelte statt einfacher Leerzeichen, dazu ein
  // angehängter Zeilenumbruch. Keine Wortmenge ändert sich dadurch.
  const textMitWhitespace = `${KI_TEXT.replace(/ /g, '  ')}\n`;
  const { id } = await post.senden({
    fach: 'support', an: 'kunde-b@kunde.example', betreff: 'Ihre Anfrage',
    text: textMitWhitespace, textKi: KI_TEXT,
  });
  const zeile = gesendeteZeile(id);
  pruef('Whitespace-Änderung bleibt "ki", wird NICHT zu "ki_bearbeitet"', zeile.kiArt, 'ki');
  pruef('Fußzeile ist die UNVERÄNDERT-Fassung, nicht die bearbeitete',
    letzterRumpf.text.endsWith(`\n\n${KENNZEICHNUNG_DE}`), true);
  pruefWahr('NICHT die "bearbeitet"-Fußzeile', !letzterRumpf.text.includes(KENNZEICHNUNG_BEARBEITET_DE));
}

console.log('\n3) KI-Entwurf inhaltlich bearbeitet, Englisch (Sprachrückfall ohne gelernte Sprache):');
{
  const textKi = KI_TEXT;
  const textBearbeitet = `${ANREDE}${KI_KERN} Bitte antworten Sie uns bis Freitag mit einer Rückmeldung.${SCHLUSS}`;
  // Keine spracheSetzen() für diese Adresse -- SPRACHE_VORGABE ('en') muss greifen.
  const { id } = await post.senden({
    fach: 'support', an: 'kunde-c@kunde.example', betreff: 'Ihre Anfrage',
    text: textBearbeitet, textKi,
  });
  const zeile = gesendeteZeile(id);
  pruef('mail_nachrichten.ki_art bei inhaltlicher Bearbeitung', zeile.kiArt, 'ki_bearbeitet');
  pruef('Fußzeile ist die ENGLISCHE "bearbeitet"-Fassung (Sprachrückfall)',
    letzterRumpf.text.endsWith(`\n\n${KENNZEICHNUNG_BEARBEITET_EN}`), true);
  pruefWahr('HTML trägt dieselbe "bearbeitet"-Fußzeile', letzterRumpf.html.includes(KENNZEICHNUNG_BEARBEITET_EN));
  pruefWahr('NICHT die "automatisch erstellt"-Fußzeile', !letzterRumpf.text.endsWith(`\n\n${KENNZEICHNUNG_EN}`));
}

console.log('\n4) Rein von Hand geschrieben — gar keine Fußzeile, kein HTML-Teil:');
{
  const textVonHand = `${ANREDE}vielen Dank für Ihre Geduld — ich habe das eben persönlich geprüft und `
    + `kümmere mich morgen früh als Erstes darum, das verspreche ich Ihnen ganz persönlich.${SCHLUSS}`;
  const { id } = await post.senden({
    fach: 'support', an: 'kunde-d@kunde.example', betreff: 'Ihre Anfrage',
    text: textVonHand,
  });
  pruef('Kein "html" im Resend-Aufruf', 'html' in letzterRumpf, false);
  pruef('Gesendeter Text ist UNVERÄNDERT (keine angehängte Fußzeile)', letzterRumpf.text, textVonHand);
  const zeile = gesendeteZeile(id);
  pruef('mail_nachrichten.ki_art bleibt NULL', zeile.kiArt, null);
  pruef('mail_nachrichten.html bleibt NULL', zeile.html, null);
  pruefWahr('Keiner der vier Fußzeilen-Wortlaute steht im gespeicherten Text',
    ![KENNZEICHNUNG_DE, KENNZEICHNUNG_EN, KENNZEICHNUNG_BEARBEITET_DE, KENNZEICHNUNG_BEARBEITET_EN]
      .some((k) => zeile.text.includes(k)));
}

console.log('\n5) post-lernen.ts lernt aus reinem Menschentext, aber nie aus KI-Beteiligung:');
{
  // 5a) Rein menschlich, lang genug -- MUSS Kandidat werden.
  const textMensch = `${ANREDE}ich habe mir das eben in Ruhe angesehen und wollte Ihnen kurz aus erster `
    + `Hand Bescheid geben, ohne dass Sie lange auf eine Antwort warten müssen von uns hier im Team.${SCHLUSS}`;
  const { id: idMensch } = await post.senden({
    fach: 'support', an: 'kunde-e@kunde.example', betreff: 'Kurze Rückmeldung', text: textMensch,
  });

  // 5b) KI allein, unverändert -- über den "KI schreibt"-Weg (kein
  // mail_entwuerfe-Eintrag, nur ki_art auf der gesendeten Zeile).
  const { id: idKiSchreibt } = await post.senden({
    fach: 'support', an: 'kunde-f@kunde.example', betreff: 'Ihre Anfrage',
    text: KI_TEXT, textKi: KI_TEXT,
  });

  // 5c) KI-Entwurf bearbeitet -- über den "KI schreibt"-Weg.
  const textBearbeitetF = `${ANREDE}${KI_KERN} Wir melden uns bis spätestens Montag verbindlich.${SCHLUSS}`;
  const { id: idKiBearbeitetSchreibt } = await post.senden({
    fach: 'support', an: 'kunde-g@kunde.example', betreff: 'Ihre Anfrage',
    text: textBearbeitetF, textKi: KI_TEXT,
  });

  // 5d) KI-Entwurf unverändert -- über den mail_entwuerfe-Weg (die
  // eigentliche Vergleichsbasis aus dem Auftrag).
  const { id: idEntwurfUnveraendert } = await post.senden({
    fach: 'support', an: 'kunde-h@kunde.example', betreff: 'Ihre Anfrage',
    text: KI_TEXT, textKi: KI_TEXT,
  });
  db.run(
    `INSERT INTO mail_entwuerfe (id, mail_id, thread_id, an, betreff, text, text_ki, zustand, erstellt_am, gesendet_id)
     VALUES (?,?,?,?,?,?,?,'gesendet',?,?)`,
    'pe_unveraendert', 'po_quelle_h', 'th_h', verschluesseln('kunde-h@kunde.example'),
    verschluesseln('Ihre Anfrage'), verschluesseln(KI_TEXT), verschluesseln(KI_TEXT), Date.now(), idEntwurfUnveraendert,
  );

  // 5e) KI-Entwurf bearbeitet -- über den mail_entwuerfe-Weg.
  const textBearbeitetI = `${ANREDE}${KI_KERN} Eine Kollegin meldet sich außerdem noch telefonisch bei Ihnen.${SCHLUSS}`;
  const { id: idEntwurfBearbeitet } = await post.senden({
    fach: 'support', an: 'kunde-i@kunde.example', betreff: 'Ihre Anfrage',
    text: textBearbeitetI, textKi: KI_TEXT,
  });
  db.run(
    `INSERT INTO mail_entwuerfe (id, mail_id, thread_id, an, betreff, text, text_ki, zustand, erstellt_am, gesendet_id)
     VALUES (?,?,?,?,?,?,?,'gesendet',?,?)`,
    'pe_bearbeitet', 'po_quelle_i', 'th_i', verschluesseln('kunde-i@kunde.example'),
    verschluesseln('Ihre Anfrage'), verschluesseln(textBearbeitetI), verschluesseln(KI_TEXT), Date.now(), idEntwurfBearbeitet,
  );

  const { kandidaten, absagen } = postLernen.quellen(500);
  const kandidatIds = new Set(kandidaten.map((k) => k.mailId));

  pruefWahr('(a) Rein menschlich: WIRD Kandidat', kandidatIds.has(idMensch));
  pruefWahr('(b) KI allein, "KI schreibt"-Weg: KEIN Kandidat', !kandidatIds.has(idKiSchreibt));
  pruef('(b) Grund: kiText (ki_art gesetzt, kein Entwurf)', absagen[idKiSchreibt], 'kiText');
  pruefWahr('(c) KI bearbeitet, "KI schreibt"-Weg: KEIN Kandidat', !kandidatIds.has(idKiBearbeitetSchreibt));
  pruef('(c) Grund: kiText', absagen[idKiBearbeitetSchreibt], 'kiText');
  pruefWahr('(d) KI-Entwurf unverändert, mail_entwuerfe-Weg: KEIN Kandidat', !kandidatIds.has(idEntwurfUnveraendert));
  pruef('(d) Grund: kaumVeraendert', absagen[idEntwurfUnveraendert], 'kaumVeraendert');
  pruefWahr('(e) KI-Entwurf bearbeitet, mail_entwuerfe-Weg: KEIN Kandidat', !kandidatIds.has(idEntwurfBearbeitet));
  pruef('(e) Grund: kiBearbeitet (NICHT mehr "die stärkste Lernquelle")', absagen[idEntwurfBearbeitet], 'kiBearbeitet');
}

console.log(fehler
  ? `\n\x1b[31m${fehler} Prüfung(en) fehlgeschlagen.\x1b[0m`
  : '\n\x1b[32mFußzeile, Sprachwahl und Lernsperre verhalten sich wie zugesagt.\x1b[0m');
process.exit(fehler ? 1 : 0);
