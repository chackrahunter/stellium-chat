/**
 * Trägt JEDE Antwort, in der ein Geheimnis steckt, `Cache-Control: no-store`?
 *
 * DIE FRAGE, DIE DIESER LAUF BEANTWORTET
 * Fastify setzt für JSON von sich aus KEINE Kopfzeile zur Frische. Eine
 * 200er-Antwort ohne Angabe darf ein Browser nach eigenem Ermessen auf die
 * Platte legen (RFC 9111 nennt das heuristisches Zwischenspeichern; Chrome tut
 * es). Bei einer Kanalliste ist das gleichgültig. Bei Adresse und Passwort des
 * Pi, bei einem verschlossenen Kontoschlüssel oder bei Notzugangsanteilen
 * heißt es: der Wert überlebt die Sitzung, in einem Profilordner, den niemand
 * nach Geheimnissen absucht. Auf einem geteilten Rechner ist genau das der
 * Schaden.
 *
 * WARUM ALS LISTE UND NICHT ALS PRÜFUNG JE ROUTE
 * Die Kopfzeile stand an zwei Wegen und fehlte an sechs weiteren, die genauso
 * Geheimnisse tragen. Das ist der Normalfall bei einer Vorsichtsmaßnahme, die
 * man abtippen muss: sie wird beim ersten Mal geschrieben und beim zweiten
 * vergessen. Deshalb steht hier EINE Tabelle mit allen Wegen, die je geprüft
 * wurden — samt denen, die die Kopfzeile ausdrücklich NICHT brauchen. Wer
 * einen neuen Weg mit einem Geheimnis baut, trägt ihn hier ein; wer einen
 * bestehenden ändert, sieht an dieser Liste, was schon einmal abgewogen wurde.
 *
 * DIE GEGENPROBE IST TEIL DER PRÜFUNG
 * Nur „diese acht tragen no-store" wäre auch dann grün, wenn irgendetwas
 * Vorgeschaltetes die Kopfzeile ALLEN Antworten anhängte — dann prüfte dieser
 * Lauf gar nichts mehr. Die Spalte `nein` unten ist der Gegenbeleg: fünf
 * Wege, die nachweislich OHNE Kopfzeile antworten. Sie sind zugleich das
 * Ergebnis der Durchsicht — jeder von ihnen sieht aus wie ein Zugangsweg
 * („zugang" im Namen) und gibt in Wahrheit nur Wahrheitswerte zurück.
 *
 * KEIN GEHEIMNIS IN DER AUSGABE
 * Gedruckt werden ausschließlich Pfade, Statuscodes und Wahrheitswerte. Kein
 * Rumpf, kein Wert, auch nicht gekürzt und auch nicht im Fehlerfall.
 *
 * Aufruf:  node scripts/geheimnis-kopfzeilen-pruefen.mjs
 */
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { db, initDb } from '../db/index.js';
import { registerRoutes } from '../http/routes.js';
import { registerEinmalcode } from '../http/einmalcode.js';
import { registerPasswoerter } from '../http/passwoerter.js';
import { signToken } from '../auth.js';
import * as users from '../services/users.js';
import * as fernzugang from '../services/fernzugang.js';
import * as verkaufzugang from '../services/verkaufzugang.js';
import * as mailzugang from '../services/mailzugang.js';
import * as einmalcode from '../services/einmalcode.js';
import { paypalZugangSetzen, paypalZugangStand } from '../services/paypal.js';
import * as kizugang from '../services/kizugang.js';
import { tresorSetzen } from '../config.js';

initDb();

let fehler = 0;
const pruef = (name: string, ist: boolean | number | string | undefined, soll: boolean | number | string | undefined) => {
  const ok = ist === soll;
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/* Ein Inhaber reicht: er trägt jedes Recht, und dieser Lauf fragt nicht nach
   Rechten, sondern nach Kopfzeilen. Wer prüfen will, WER durch diese Türen
   darf, findet das in fern-passwort-anzeigen.mts, passwort-tresor.mts und
   rechte-eskalation.mts — hier ginge es unter. */
function konto(rolle: string, id: string): string {
  db.run(
    `INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
    id, id, id, 'x', rolle, Date.now(),
  );
  return id;
}
const inhaber = konto('owner', 'u_inhaber');
const gast = konto('guest', 'u_gast');

/* ── Echte Geheimnisse hinterlegen, frisch gewürfelt, nie gedruckt ────
 *
 * ZWEI GRÜNDE, WARUM DAS NICHT BLOSS AUSSCHMÜCKUNG IST.
 *
 * Erstens liefern /api/fern/zugang und /api/fern/zugang-ansehen sonst 404
 * statt 200, und ein 404 trüge die Kopfzeile womöglich aus einem ganz anderen
 * Grund.
 *
 * Zweitens — und das ist der wichtigere — kann Abschnitt 2 damit nachweisen,
 * dass die Wege ohne Kopfzeile ihre Kopfzeile auch wirklich nicht BRAUCHEN.
 * „Da steht schon nichts drin" ist eine Behauptung; „dieser Wert liegt in der
 * Datenbank und kommt in dieser Antwort nachweislich nicht vor" ist eine
 * Prüfung. Ohne sie wäre die Gegenprobe eine Meinung mit Häkchen davor. */
const P = () => crypto.randomBytes(24).toString('hex');
const PROBEN: Record<string, string> = {
  fernAdresse: `ws://pruefer-${P()}.invalid:9999`,
  fernPasswort: P(),
  fernKennung: crypto.randomBytes(6).toString('hex'),
  gumroad: P(),
  paypalSecret: P(),
  mailSchluessel: P(),
  /* Gültiges Base32, sonst weist eingabePruefen() es ab. Ein bekannter
     Prüfwert und trotzdem nirgends gedruckt — die Regel gilt ohne Ausnahme,
     sonst wird sie beim nächsten Mal für den echten Wert gebogen. */
  otp: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  /* Patreon trennt vier Werte. Die Client-ID ist ausdrücklich KEIN Geheimnis
     und geht mit — genau deshalb steht sie hier: an ihr zeigt Abschnitt 2,
     dass die Probensuche einen Wert, der wirklich in der Antwort steht, auch
     wirklich findet. Ohne diesen einen Treffer wären alle „keine Probe
     drin"-Zeilen von einer kaputten Suche nicht zu unterscheiden. */
  patreonClientId: P(),
  patreonSecret: P(),
  patreonAccess: P(),
  patreonRefresh: P(),
  /* Der Groq-Schlüssel liegt als einziges Geheimnis des Hauses nicht in der
     Datenbank, sondern im verschlüsselten Tresor (services/kizugang.ts) —
     für diese Frage macht das keinen Unterschied: er darf in der Antwort
     genauso wenig vorkommen wie die anderen. */
  kiSchluessel: `gsk_test_${P()}`,
};

fernzugang.zugangSetzen(
  { adresse: PROBEN.fernAdresse, passwort: PROBEN.fernPasswort, kennung: PROBEN.fernKennung },
  'pruefer',
);
verkaufzugang.tokenSetzen(PROBEN.gumroad, 'pruefer');
verkaufzugang.patreonSetzen({
  clientId: PROBEN.patreonClientId, clientSecret: PROBEN.patreonSecret,
  accessToken: PROBEN.patreonAccess, refreshToken: PROBEN.patreonRefresh,
}, 'pruefer');
paypalZugangSetzen({ clientId: `id-${PROBEN.paypalSecret}`, clientSecret: PROBEN.paypalSecret }, 'pruefer');
mailzugang.zugangSetzen({ domaene: 'pruefer.invalid', name: 'Prüfer', versandSchluessel: PROBEN.mailSchluessel }, 'pruefer');
/* Mit einem echten Konto als Urheber: einmalcode_konten hat einen
   Fremdschlüssel auf users, anders als die Einstellungstabelle darüber. */
einmalcode.kontoAnlegen({ bezeichnung: 'Prüfkonto', geheimnis: PROBEN.otp }, inhaber);
/* Bewusst über die Ablage und nicht über kizugang.schluesselSetzen(): dessen
   Aufgabe ist es, danach den Anbieter neu zu bauen, und das hieße eine
   Anfrage nach draußen. Diese Prüfung will nur, dass ein Wert DA ist —
   welchen Weg er genommen hat, ist die Frage von ki-schluessel.mts. */
tresorSetzen('groq', PROBEN.kiSchluessel);

const app = Fastify({ logger: false });
await registerRoutes(app);
registerEinmalcode(app);
registerPasswoerter(app);

interface Fall {
  pfad: string;
  methode: 'GET' | 'POST';
  wer: string;
  /** Trägt der Rumpf ein Geheimnis? Dann MUSS `no-store` mit. */
  geheim: boolean;
  /** Was in dieser Antwort steht — und warum das die Spalte rechtfertigt. */
  warum: string;
  /** Der Name EINER Probe, die hier absichtlich mitkommt. Nur für Werte, die
   *  nachweislich kein Geheimnis sind — sie belegt, dass die Suche greift. */
  erlaubteProbe?: keyof typeof PROBEN;
}

/* ── Die Liste. Links das Urteil, rechts die Begründung dafür. ──────── */
const FAELLE: Fall[] = [
  /* Klartext über die Leitung. */
  { pfad: '/api/fern/zugang', methode: 'GET', wer: inhaber, geheim: true,
    warum: 'Adresse UND Passwort des Pi im Klartext — der Weg zum Verbinden' },
  { pfad: '/api/fern/zugang-ansehen', methode: 'GET', wer: inhaber, geheim: true,
    warum: 'dieselben zwei Werte zum Ablesen und Weitergeben' },

  /* Verschlossen, und trotzdem no-store: eine Hülle auf einer fremden Platte
     ist Angriffsfläche für einen Rateangriff, den es sonst gar nicht gäbe. */
  { pfad: '/api/konto/schluessel', methode: 'GET', wer: inhaber, geheim: true,
    warum: 'die passwortverschlossene Hülle des Kontoschlüssels' },
  { pfad: '/api/konto/notzugang', methode: 'GET', wer: inhaber, geheim: true,
    warum: 'die Notzugangshülle — der zweite Weg zum Kontoschlüssel' },
  { pfad: '/api/konto/notzugang/aufgaben', methode: 'GET', wer: inhaber, geheim: true,
    warum: 'der eigene verschlossene Anteil an einem fremden Kontoschlüssel' },
  { pfad: '/api/konto/notzugang/beitraege/gibtsnicht', methode: 'GET', wer: inhaber, geheim: true,
    warum: 'ab der Schwelle genug Anteile für einen ganzen Kontoschlüssel' },
  { pfad: '/api/passwoerter', methode: 'GET', wer: inhaber, geheim: true,
    warum: 'Chiffrate samt der verschlossenen Schlüsselpakete dazu' },
  { pfad: '/api/passwoerter/gibtsnicht/geheimnis', methode: 'POST', wer: inhaber, geheim: true,
    warum: 'die verschlossene Hülle eines Tresoreintrags' },
  { pfad: '/api/einmalcode/konten/gibtsnicht/codes', methode: 'POST', wer: inhaber, geheim: true,
    warum: 'gültige zweite Faktoren, dreißig Sekunden lang' },

  /* Die Gegenprobe. Alle fünf sahen bei der Durchsicht nach einem Geheimnis
     aus und tragen keines: sie geben Wahrheitswerte zurück („ist etwas
     hinterlegt?"), keine Werte. */
  { pfad: '/api/permissions', methode: 'GET', wer: gast, geheim: false,
    warum: 'der Rechtekatalog — keine Werte, nur Namen' },
  { pfad: '/api/fern/stand', methode: 'GET', wer: gast, geheim: false,
    warum: 'ob eingerichtet ist; die Kennung nur mit fern.zugriff' },
  { pfad: '/api/einmalcode', methode: 'GET', wer: inhaber, geheim: false,
    warum: 'die Kontenliste — hier entsteht ausdrücklich kein Code' },
  { pfad: '/api/verkauf/zugang', methode: 'GET', wer: inhaber, geheim: false,
    warum: 'nur hinterlegt/verschlüsselt — der Gumroad-Schlüssel nie' },
  { pfad: '/api/ki/zugang', methode: 'GET', wer: inhaber, geheim: false,
    warum: 'nur hinterlegt/Quelle/schreibbar — der Groq-Schlüssel nie' },
  { pfad: '/api/post/zugang', methode: 'GET', wer: inhaber, geheim: false,
    warum: 'nur versandBereit/eingangBereit, Domäne und Name' },
  { pfad: '/api/bank/paypal/zugang', methode: 'GET', wer: inhaber, geheim: false,
    warum: 'nur hinterlegt-Flaggen und die Umgebung, nie Secret oder Token' },
  { pfad: '/api/verkauf/patreon', methode: 'GET', wer: inhaber, geheim: false,
    warum: 'die Client-ID kommt mit (kein Geheimnis), Secret und beide Token nie',
    erlaubteProbe: 'patreonClientId' },
];

/* ── Zuerst die Ausgangslage: ohne sie sagt die Tabelle nichts aus ──── */
console.log('\n0) Ausgangslage');
pruef('Der Inhaber trägt wirklich jedes benötigte Recht',
  users.may(inhaber, 'fern.zugriff') && users.may(inhaber, 'fern.verwalten')
  && users.may(inhaber, 'passwort.nutzen') && users.may(inhaber, 'einmalcode.nutzen')
  && users.may(inhaber, 'verkauf.verwalten') && users.may(inhaber, 'mail.verwalten')
  && users.may(inhaber, 'bank.verwalten'), true);
pruef('Der Fernzugang ist hinterlegt (sonst 404 statt 200)',
  fernzugang.zugangStand().hinterlegt, true);
/* Ohne diese vier Zeilen könnte Abschnitt 2 grün sein, weil gar nichts
   hinterlegt ist — „der Wert kommt nicht vor" ist trivial wahr für einen
   Wert, den es nirgends gibt. */
pruef('Der Gumroad-Schlüssel liegt wirklich in der Datenbank',
  verkaufzugang.tokenStand().hinterlegt, true);
pruef('Der PayPal-Zugang ebenfalls', paypalZugangStand().hinterlegt, true);
pruef('Und der Patreon-Zugang, mit allen vier Werten',
  verkaufzugang.patreonStand().hinterlegt
  && verkaufzugang.patreonStand().clientSecretHinterlegt
  && verkaufzugang.patreonStand().refreshTokenHinterlegt, true);
pruef('Der Versandschlüssel der Post ebenfalls', mailzugang.zugangStand().versandBereit, true);
pruef('Und der Groq-Schlüssel liegt wirklich im Tresor',
  kizugang.schluesselStand().tresor, true);
pruef('Und es gibt ein Einmalcode-Konto', einmalcode.kontenListe().length > 0, true);
/* Und die Proben sind untereinander verschieden — sonst prüfte eine Zeile
   unten in Wahrheit mehrere Male denselben Wert. */
pruef('Die Proben sind alle verschieden',
  new Set(Object.values(PROBEN)).size, Object.keys(PROBEN).length);
/* Die Liste muss BEIDE Urteile enthalten. Bestünde sie nur aus `geheim: true`,
   wäre sie von einer global gesetzten Kopfzeile nicht zu unterscheiden. */
pruef('Die Liste enthält Wege mit Geheimnis', FAELLE.some((f) => f.geheim), true);
pruef('...und Wege ohne', FAELLE.some((f) => !f.geheim), true);

/* ── Die Tabelle ────────────────────────────────────────────────────── */
console.log('\n1) Wege MIT Geheimnis — no-store ist Pflicht');
for (const f of FAELLE.filter((x) => x.geheim)) {
  const a = await app.inject({
    method: f.methode, url: f.pfad,
    headers: { authorization: `Bearer ${signToken(f.wer)}` },
  });
  /* Der Statuscode steht bewusst NICHT in der Erwartung: einige dieser Wege
     antworten hier mit 400 oder 404, weil der Lauf keinen echten Eintrag
     anlegt. Das ist in Ordnung und sogar aussagekräftig — die Kopfzeile wird
     gesetzt, BEVOR irgendetwas schiefgehen kann, und muss deshalb auch auf
     dem Abweisungsweg dastehen. Was er NICHT sein darf, ist 401 oder 403:
     dann hätte der Lauf die Route gar nicht erreicht und prüfte nichts. */
  pruef(`${f.methode} ${f.pfad} — erreicht (nicht 401/403)`,
    a.statusCode !== 401 && a.statusCode !== 403, true);
  pruef(`  no-store — ${f.warum}`,
    String(a.headers['cache-control'] ?? '').includes('no-store'), true);
}

console.log('\n2) Wege OHNE Geheimnis — der Gegenbeleg');
for (const f of FAELLE.filter((x) => !x.geheim)) {
  const a = await app.inject({
    method: f.methode, url: f.pfad,
    headers: { authorization: `Bearer ${signToken(f.wer)}` },
  });
  pruef(`${f.methode} ${f.pfad} — 200`, a.statusCode, 200);
  pruef(`  ohne Cache-Control — ${f.warum}`,
    a.headers['cache-control'] === undefined, true);
  /* Die Begründung dafür, dass sie ohne auskommen — und zwar geprüft, nicht
     behauptet: KEINE der oben hinterlegten Proben steht in diesem Rumpf.
     Gegen ALLE Proben und nicht nur gegen die naheliegende, damit auch ein
     Wert auffällt, der über eine ganz andere Ecke hereingerät. Gedruckt wird
     nur der Name der Probe, nie ihr Inhalt. */
  const roh = a.body ?? '';
  const drin = Object.keys(PROBEN).filter((k) => roh.includes(PROBEN[k]));
  const unerlaubt = drin.filter((k) => k !== f.erlaubteProbe);
  pruef(`  ...und trägt keine der hinterlegten Proben${unerlaubt.length ? ` (${unerlaubt.join(', ')})` : ''}`,
    unerlaubt.length, 0);
  /* Die andere Richtung, und nur da, wo sie hingehört: hier steht ein Wert
     drin, von dem der Lauf WEISS, dass er drinsteht. Fällt diese Zeile, sucht
     die Suche ins Leere — und dann sagen alle Zeilen darüber nichts mehr. */
  if (f.erlaubteProbe) {
    pruef(`  Gegenprobe: die Suche findet ${String(f.erlaubteProbe)} tatsächlich`,
      drin.includes(f.erlaubteProbe as string), true);
  }
}

await app.close();

console.log(fehler
  ? `\n\x1b[31m${fehler} Fehler.\x1b[0m\n`
  : '\n\x1b[32mJeder Weg, der ein Geheimnis herausgibt, verbietet den Zwischenspeicher — und die harmlosen tun es nachweislich nicht.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
