/**
 * Prüft die Schwelle vor `GET /api/fern/zugang-ansehen` — der einen Route,
 * die den hinterlegten Pi-Zugang (Adresse UND Passwort) zum ANSEHEN
 * herausgibt, damit man ihn einem Kollegen weiterreichen kann, der nicht über
 * Stellium hereinkommt.
 *
 * DIE FRAGE, DIE DIESER LAUF BEANTWORTET
 * Sieht wirklich nur `fern.verwalten` den Zugang — und bleibt
 * `/api/fern/zugang` dabei für `fern.zugriff` unverändert offen? Die zweite
 * Hälfte ist die wichtigere: `/api/fern/zugang` ist der Weg, über den die
 * Teamleitung den Pi überhaupt erreicht. Eine Rechteänderung, die die Anzeige
 * richtig einengt und dabei still das Verbinden mitzieht, wäre der teurere
 * Fehler von beiden, und ein Lauf, der nur die neue Route betrachtet, würde
 * ihn nicht sehen.
 *
 * DIE DRITTE HÄLFTE (Abschnitte 3c und 3d)
 * `GET /api/fern/stand` gab die KENNUNG des Pi an jedes angemeldete Konto
 * heraus, bis hinunter zum Gast — die Route prüft für den Grundstock ihrer
 * Antwort absichtlich kein Recht, und die Kennung fuhr einfach mit. Seit sie
 * an `fern.zugriff` hängt, prüft Abschnitt 3c beide Richtungen: dass sie beim
 * Gast FEHLT (und auch nicht unter einem anderen Feldnamen mitkommt) und dass
 * sie bei jedem ankommt, der verbinden darf. Abschnitt 3d prüft die Kopfzeile
 * gegen Zwischenspeicher auf `/api/fern/zugang` — dem Weg mit Adresse und
 * Passwort im Klartext, der sie als einziger nicht hatte — und zeigt an einer
 * harmlosen Route, dass Fastify sie von sich aus NICHT setzt. Ohne diesen
 * Gegenbeleg wäre „steht drin" von „steht überall drin" nicht zu
 * unterscheiden.
 *
 * DIE ZWEITE HÄLFTE, DIE HIER DAZUKAM
 * Die Route hieß einmal `/api/fern/passwort` und gab nur das Passwort heraus.
 * Seit sie auch die Adresse liefert, prüft dieser Lauf drei Dinge mehr:
 * dass der alte Weg WIRKLICH weg ist (und nicht als zweite, vergessene Tür
 * weiterlebt), dass die Antwort NUR die beiden Hälften enthält und keine
 * Kennung, und dass `GET /api/fern/stand` — die Auskunft OHNE jede
 * Rechteprüfung — die Adresse weiterhin NICHT mitschickt. Der letzte Punkt
 * ist der, an dem eine gut gemeinte Angleichung („die Adresse ist doch kein
 * Geheimnis") den Netzweg zum Pi an jeden Gast verteilen würde.
 *
 * ÜBER HTTP, NICHT AM DIENST VORBEI
 * Die Schwelle sitzt in `http/routes.ts`, nicht in `services/fernzugang.ts` —
 * `zugangLesen()` kennt gar kein Konto. Ein Lauf direkt gegen den Dienst
 * könnte die Frage also gar nicht stellen. Dieselbe Machart wie
 * partnergruppen-routen.mts: `registerRoutes()` auf eine nackte
 * Fastify-Instanz, `app.inject()` statt `app.listen()` — kein Port, kein
 * Konflikt mit einem laufenden Entwicklungsserver.
 *
 * KEIN GEHEIMNIS IN DER AUSGABE
 * Das Probe-Passwort wird bei jedem Lauf frisch gewürfelt und NIRGENDS
 * ausgegeben — auch nicht gekürzt, auch nicht im Fehlerfall. Dasselbe gilt
 * für die Probe-Adresse: sie ist zwar erfunden, aber sie steht für einen
 * Wert, der es im Ernstfall nicht ist, und ein Muster, das sie druckt, würde
 * eines Tages die echte drucken. `pruef()` unten nimmt darum ausschließlich
 * Wahrheitswerte und Zahlen; jeder Vergleich mit einem Klartext wird VORHER
 * zu `true`/`false` gerechnet. Ein Lauf, der bei einem Fehlschlag
 * „erwartet X, bekam Y" druckt, hätte das Geheimnis in jedes Prüfprotokoll
 * geschrieben.
 *
 * GEGENPROBEN GEGEN EINEN LAUF, DER SICH SELBST GRÜN MACHT
 * Ein Vergleich, der immer `true` sagt, wäre von einem echten Treffer nicht zu
 * unterscheiden. Abschnitt 0 prüft deshalb zuerst die Ausgangslage selbst:
 * dass das Probe-Passwort nicht leer ist, dass `stimmt()` einen falschen Wert
 * wirklich ablehnt, und dass die drei Testkonten die Rechte tragen bzw. nicht
 * tragen, um die es hier geht.
 *
 * Aufruf:  node scripts/fern-passwort-anzeigen-pruefen.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { ROLE_DEFAULTS, type MemberRoleName, type PermissionKey } from '@stellium/shared';
import { db, initDb } from '../db/index.js';
import { registerRoutes } from '../http/routes.js';
import { signToken } from '../auth.js';
import * as users from '../services/users.js';
import * as fernzugang from '../services/fernzugang.js';

initDb();

let fehler = 0;
/** Nimmt NUR Wahrheitswerte, Zahlen und Kennungen — nie einen Klartext.
 *  Siehe „KEIN GEHEIMNIS IN DER AUSGABE" im Dateikopf. */
const pruef = (name: string, ist: boolean | number | string | undefined, soll: boolean | number | string | undefined) => {
  const ok = ist === soll;
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/* ── Ausgangslage: ein hinterlegter Zugang und vier Konten ──────────── */

/* Frisch gewürfelt, nie ausgegeben. Der Wert selbst ist beliebig — es geht
   nur darum, ob genau dieser eine Wert zurückkommt oder nicht. */
const PROBE_PASSWORT = `probe-${crypto.randomBytes(24).toString('hex')}`;
const PROBE_ADRESSE = 'ws://pruefer.invalid:9999';
const PROBE_KENNUNG = '123 456 789';

fernzugang.zugangSetzen(
  { adresse: PROBE_ADRESSE, passwort: PROBE_PASSWORT, kennung: PROBE_KENNUNG },
  'pruefer',
);

let zaehler = 0;
function kontoRoh(rolle: MemberRoleName, name: string): string {
  zaehler += 1;
  const id = `u_${zaehler}`;
  db.run(
    `INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
    id, id, name, 'x', rolle, Date.now(),
  );
  return id;
}

/* Genau ein Recht zusätzlich zu 'guest' — per SQL, wie in
   rechte-eskalation.mts: hier wird die AUSGANGSLAGE hergestellt, nicht das
   Vergeben geprüft. 'guest' bringt weder `fern.zugriff` noch
   `fern.verwalten` von Haus aus mit (Abschnitt 0 belegt das). */
function kontoMit(recht: PermissionKey | null, name: string): string {
  const id = kontoRoh('guest', name);
  if (recht) {
    db.run(
      `INSERT INTO user_permissions (user_id, permission, allowed, set_by, set_at) VALUES (?,?,1,'pruefer',?)`,
      id, recht, Date.now(),
    );
  }
  return id;
}

const nurVerwalten = kontoMit('fern.verwalten', 'Nur fern.verwalten');
const nurZugriff = kontoMit('fern.zugriff', 'Nur fern.zugriff');
const ohneAlles = kontoMit(null, 'Ohne beides');
/* Die Rollen selbst, nicht nur die Einzelrechte: der Inhaber hat nach
   „nur für Admins oder Owner" gefragt, und ob DIESE Rollen wirklich auf der
   richtigen Seite der Schwelle liegen, hängt an ROLE_DEFAULTS und dem
   `ALLE.filter(...)`-Mechanismus, nicht an der Route. */
const echterAdmin = kontoRoh('admin', 'Rolle admin');
const echterOwner = kontoRoh('owner', 'Rolle owner');
const echteLeitung = kontoRoh('teamlead', 'Rolle teamlead');

/* ── Die echten Routen, ohne app.listen() ──────────────────────────── */

const app = Fastify({ logger: false });
await registerRoutes(app);

interface Antwort { statusCode: number; body: unknown; kopf: Record<string, unknown>; }

async function anfrage(pfad: string, userId: string | null): Promise<Antwort> {
  const antwort = await app.inject({
    method: 'GET',
    url: pfad,
    headers: userId ? { authorization: `Bearer ${signToken(userId)}` } : {},
  });
  let body: unknown;
  try { body = antwort.json(); } catch { body = undefined; }
  return { statusCode: antwort.statusCode, body, kopf: antwort.headers as Record<string, unknown> };
}

const ANSEHEN = '/api/fern/zugang-ansehen';
/** Der Weg, den es bis zur Erweiterung um die Adresse gab. Er darf nicht
 *  daneben weiterleben — zwei Türen zu demselben Geheimnis sind eine mehr,
 *  als jemand später beim Nachzählen findet. */
const ANSEHEN_ALT = '/api/fern/passwort';

/** Wahrheitswert statt Klartext — der Rückgabewert darf gedruckt werden. */
function stimmt(wert: unknown, erwartet: string): boolean {
  return typeof wert === 'string' && wert === erwartet;
}

/* ── 0) Die Ausgangslage selbst ─────────────────────────────────────
 * Ohne diesen Abschnitt könnte alles Folgende grün sein, weil die Probe
 * nichts prüft: ein leeres Passwort, ein `stimmt()`, das immer zustimmt,
 * oder Testkonten, die schon von Haus aus alles dürfen. */
console.log('\n0) Ausgangslage — damit der Rest überhaupt etwas aussagt');

pruef('Das Probe-Passwort ist nicht leer', PROBE_PASSWORT.length > 20, true);
pruef('stimmt() erkennt den richtigen Wert', stimmt(PROBE_PASSWORT, PROBE_PASSWORT), true);
pruef('stimmt() lehnt einen falschen Wert ab', stimmt('etwas anderes', PROBE_PASSWORT), false);
pruef('stimmt() lehnt einen leeren Wert ab', stimmt('', PROBE_PASSWORT), false);
pruef('stimmt() lehnt undefined ab', stimmt(undefined, PROBE_PASSWORT), false);

pruef('Der Zugang liegt wirklich hinterlegt', fernzugang.zugangStand().hinterlegt, true);
pruef('...und der Dienst gibt genau das Probe-Passwort zurück',
  stimmt(fernzugang.zugangLesen()?.passwort, PROBE_PASSWORT), true);
pruef('...und genau die Probe-Adresse', stimmt(fernzugang.zugangLesen()?.adresse, PROBE_ADRESSE), true);
/* Sonst könnte Abschnitt 1 grün sein, weil Adresse und Passwort denselben
   Wert tragen und ein einziger Vergleich für beide durchginge. */
pruef('Adresse und Passwort sind verschiedene Werte', PROBE_ADRESSE === PROBE_PASSWORT, false);

pruef('Konto A trägt fern.verwalten', users.may(nurVerwalten, 'fern.verwalten'), true);
pruef('...und NICHT fern.zugriff (sonst prüfte die 403 unten nichts)',
  users.may(nurVerwalten, 'fern.zugriff'), false);
pruef('Konto B trägt fern.zugriff', users.may(nurZugriff, 'fern.zugriff'), true);
pruef('...und NICHT fern.verwalten', users.may(nurZugriff, 'fern.verwalten'), false);
pruef('Konto C trägt keines von beiden',
  users.may(ohneAlles, 'fern.zugriff') || users.may(ohneAlles, 'fern.verwalten'), false);

/* Der Kreis, den der Inhaber gemeint hat („Admins oder Owner"), muss aus den
   Rollenvorgaben selbst folgen — nicht daraus, dass dieser Lauf ihn
   behauptet. Fällt `fern.verwalten` eines Tages aus ADMIN heraus, soll es
   HIER auffallen und nicht erst, wenn ein Administrator vor einem leeren
   Feld steht. */
pruef('ROLE_DEFAULTS: admin trägt fern.verwalten',
  ROLE_DEFAULTS.admin.includes('fern.verwalten'), true);
pruef('ROLE_DEFAULTS: owner trägt fern.verwalten',
  ROLE_DEFAULTS.owner.includes('fern.verwalten'), true);
pruef('ROLE_DEFAULTS: teamlead trägt fern.zugriff, aber NICHT fern.verwalten',
  ROLE_DEFAULTS.teamlead.includes('fern.zugriff') && !ROLE_DEFAULTS.teamlead.includes('fern.verwalten'), true);

/* ── 1) Wer fern.verwalten hat, bekommt den Wert ────────────────────── */
console.log('\n1) GET /api/fern/zugang-ansehen — mit fern.verwalten');

const a = await anfrage(ANSEHEN, nurVerwalten);
pruef('200', a.statusCode, 200);
pruef('...und im Rumpf steht genau das hinterlegte Passwort',
  stimmt((a.body as { passwort?: unknown })?.passwort, PROBE_PASSWORT), true);
/* Die zweite Hälfte der Zugangspaarung. Ohne sie ist das Werkzeug nutzlos:
   wer sich von Hand verbindet, braucht beides, und die Adresse steht in
   keiner anderen Ansicht. */
pruef('...und genau die hinterlegte Adresse',
  stimmt((a.body as { adresse?: unknown })?.adresse, PROBE_ADRESSE), true);
pruef('...und sonst NICHTS — keine Kennung, kein Stand',
  Object.keys((a.body ?? {}) as object).sort().join(','), 'adresse,passwort');
/* Ohne diese Kopfzeile darf ein Browser eine 200er-Antwort ohne
   Frischeangabe nach eigenem Ermessen auf die Platte legen — dort läge dann
   das Klartextpasswort, lange nachdem das Feld wieder verdeckt ist.
   Dieselbe Zeile steht vor den Einmalcodes (http/einmalcode.ts). */
pruef('...und die Antwort verbietet jeden Zwischenspeicher',
  String(a.kopf['cache-control'] ?? '').includes('no-store'), true);

const alsAdmin = await anfrage(ANSEHEN, echterAdmin);
pruef('Rolle admin: 200', alsAdmin.statusCode, 200);
pruef('...mit den richtigen Werten',
  stimmt((alsAdmin.body as { passwort?: unknown })?.passwort, PROBE_PASSWORT)
  && stimmt((alsAdmin.body as { adresse?: unknown })?.adresse, PROBE_ADRESSE), true);

const alsOwner = await anfrage(ANSEHEN, echterOwner);
pruef('Rolle owner: 200', alsOwner.statusCode, 200);
pruef('...mit den richtigen Werten',
  stimmt((alsOwner.body as { passwort?: unknown })?.passwort, PROBE_PASSWORT)
  && stimmt((alsOwner.body as { adresse?: unknown })?.adresse, PROBE_ADRESSE), true);

/* Der alte Weg. Fastifys eigenes „Not Found" trägt kein `code` — daran ist
   es von dem 404 zu unterscheiden, das die Route selbst wirft (Abschnitt 4).
   Bliebe /api/fern/passwort daneben bestehen, hinge an ihm eine zweite Tür,
   die niemand mehr pflegt. */
const altWeg = await anfrage(ANSEHEN_ALT, echterOwner);
pruef('Der alte Weg /api/fern/passwort ist wirklich weg: 404', altWeg.statusCode, 404);
pruef('...und zwar als Fastifys blankes Not Found, ohne Dienstkennung',
  (altWeg.body as { code?: string })?.code, undefined);
pruef('...ohne Passwort im Rumpf',
  Object.keys((altWeg.body ?? {}) as object).includes('passwort'), false);

/* ── 2) fern.zugriff allein reicht NICHT — und darf trotzdem verbinden ─
 * Das ist die eigentliche Zeile dieses Laufs. Die Anzeige ist enger als der
 * Zugriff, absichtlich (siehe Kommentar an der Route). Beide Hälften stehen
 * hier zusammen, damit ein Versuch, die eine zu ändern, die andere nicht
 * unbemerkt mitzieht. */
console.log('\n2) Nur fern.zugriff — abgewiesen bei der Anzeige, unverändert beim Verbinden');

const b = await anfrage(ANSEHEN, nurZugriff);
pruef('GET /api/fern/zugang-ansehen: 403', b.statusCode, 403);
pruef('...mit der Kennung des fehlenden Rechts',
  (b.body as { code?: string })?.code, 'perm.fern.verwalten.label');
pruef('...und ohne Passwort im Rumpf',
  Object.keys((b.body ?? {}) as object).includes('passwort'), false);
pruef('...und ohne Adresse im Rumpf',
  Object.keys((b.body ?? {}) as object).includes('adresse'), false);

const bZugang = await anfrage('/api/fern/zugang', nurZugriff);
pruef('GET /api/fern/zugang: 200 — der Verbindungsweg bleibt offen', bZugang.statusCode, 200);
pruef('...und liefert weiterhin das Passwort zum Verbinden',
  stimmt((bZugang.body as { passwort?: unknown })?.passwort, PROBE_PASSWORT), true);
pruef('...unverändert auch Adresse und Kennung',
  (bZugang.body as { adresse?: string })?.adresse === PROBE_ADRESSE
  && (bZugang.body as { kennung?: string })?.kennung === PROBE_KENNUNG, true);

const leitungAnzeige = await anfrage(ANSEHEN, echteLeitung);
pruef('Rolle teamlead: 403 bei der Anzeige', leitungAnzeige.statusCode, 403);
const leitungZugang = await anfrage('/api/fern/zugang', echteLeitung);
pruef('Rolle teamlead: 200 beim Verbinden', leitungZugang.statusCode, 200);

/* ── 3) Wer keines von beidem hat ───────────────────────────────────── */
console.log('\n3) Ohne beide Rechte — und ohne Anmeldung');

const c = await anfrage(ANSEHEN, ohneAlles);
pruef('GET /api/fern/zugang-ansehen: 403', c.statusCode, 403);
pruef('...ohne Passwort und ohne Adresse im Rumpf',
  Object.keys((c.body ?? {}) as object).some((k) => k === 'passwort' || k === 'adresse'), false);
pruef('GET /api/fern/zugang: ebenfalls 403',
  (await anfrage('/api/fern/zugang', ohneAlles)).statusCode, 403);

const ohneToken = await anfrage(ANSEHEN, null);
pruef('Ohne Anmeldung: 401', ohneToken.statusCode, 401);
pruef('...ohne Passwort und ohne Adresse im Rumpf',
  Object.keys((ohneToken.body ?? {}) as object).some((k) => k === 'passwort' || k === 'adresse'), false);

/* ── 3b) Die Auskunft OHNE Rechteprüfung bleibt geheimnisfrei ───────
 * `GET /api/fern/stand` prüft ABSICHTLICH kein einziges Recht: jeder
 * Angemeldete darf wissen, ob der Fernzugang eingerichtet ist. Genau deshalb
 * darf `zugangStand()` die Adresse nicht mitschicken — sie jetzt „auch noch"
 * dort einzutragen, weil die Anzeige-Route sie ohnehin herausgibt, würde den
 * erreichbaren Netzweg zum Pi an jedes Konto verteilen, bis hinunter zum
 * Gast. Der Kreis ist der Unterschied, nicht der Wert. */
console.log('\n3b) GET /api/fern/stand — ungeschützt, und darum ohne Geheimnisse');

const stand = await anfrage('/api/fern/stand', ohneAlles);
pruef('200 auch ohne jedes Fern-Recht', stand.statusCode, 200);
pruef('Sanity: der Stand sagt überhaupt etwas aus',
  (stand.body as { hinterlegt?: boolean })?.hinterlegt, true);
pruef('...aber ohne Adresse',
  Object.keys((stand.body ?? {}) as object).includes('adresse'), false);
pruef('...und ohne Passwort',
  Object.keys((stand.body ?? {}) as object).includes('passwort'), false);
/* Auch nicht heimlich unter anderem Namen: die Kennung ist ein eigener
   Wert und darf nie die Adresse tragen. */
pruef('...und die Kennung ist nicht in Wahrheit die Adresse',
  stimmt((stand.body as { kennung?: unknown })?.kennung, PROBE_ADRESSE), false);

/* ── 3c) Die Kennung hängt an fern.zugriff ──────────────────────────
 * Bis vor Kurzem stand sie in DIESER Antwort für jeden Angemeldeten. Die
 * Begründung an der Route („jeder darf wissen, OB eingerichtet ist, sonst
 * steht da ein Knopf ohne Erklärung") trägt genau ein Feld: `hinterlegt`.
 * Sie trägt nicht die Auskunft, WELCHE Maschine das ist. Ein Gastkonto, das
 * nie verbinden darf, konnte die Nummer ablesen und an jemanden mit dem
 * Passwort weiterreichen.
 *
 * GEPRÜFT WIRD IN BEIDE RICHTUNGEN. Nur „der Gast bekommt sie nicht" wäre
 * auch dann grün, wenn die Route sie überhaupt niemandem mehr schickt — und
 * damit die Anzeige neben dem Verbinden-Knopf still abgeschaltet hätte.
 * Deshalb steht darunter, dass sie bei jedem ankommt, der verbinden darf. */
console.log('\n3c) Die Kennung — nur für Konten, die verbinden dürfen');

pruef('Sanity: die Probe-Kennung ist gesetzt und keine leere Zeichenkette',
  PROBE_KENNUNG.length > 0, true);
pruef('Sanity: sie ist ein anderer Wert als Adresse und Passwort',
  stimmt(PROBE_KENNUNG, PROBE_ADRESSE) || stimmt(PROBE_KENNUNG, PROBE_PASSWORT), false);

/* WEGGELASSEN, NICHT GELEERT — und darum wird auf den SCHLÜSSEL geprüft und
   nicht auf `=== null`. Ein `kennung: null` sähe aus wie „es ist keine
   hinterlegt"; genau das soll die Antwort hier nicht behaupten. */
pruef('Ohne fern.zugriff: das Feld `kennung` fehlt ganz',
  Object.keys((stand.body ?? {}) as object).includes('kennung'), false);
/* Und auch nicht unter einem anderen Namen. Ohne diese Zeile bliebe der
   Abschnitt grün, wenn jemand sie als `id`, `pi` oder `stand.kennung`
   wieder hereinreichte. */
pruef('...und kein einziges Feld der Antwort trägt ihren Wert',
  Object.values((stand.body ?? {}) as Record<string, unknown>)
    .some((v) => stimmt(v, PROBE_KENNUNG)), false);
/* Die absichtliche Auskunft bleibt: sonst hätte diese Änderung den Knopf
   wieder unerklärt gemacht — der Fehler, den der Kommentar an der Route
   ausdrücklich vermeiden will. */
pruef('...aber `hinterlegt` steht weiterhin drin und ist wahr',
  (stand.body as { hinterlegt?: boolean })?.hinterlegt, true);
pruef('...und `darf` steht drin und ist falsch',
  (stand.body as { darf?: boolean })?.darf, false);

const standZugriff = await anfrage('/api/fern/stand', nurZugriff);
pruef('Mit fern.zugriff: 200', standZugriff.statusCode, 200);
pruef('...und die Kennung kommt mit, im Klartext und vollständig',
  stimmt((standZugriff.body as { kennung?: unknown })?.kennung, PROBE_KENNUNG), true);
pruef('...und `darf` ist wahr', (standZugriff.body as { darf?: boolean })?.darf, true);

/* Die drei Rollen, an denen das im Alltag hängt. Die Leitung ist der
   eigentliche Grund für die Wahl von `fern.zugriff`: für sie ist der
   Verbinden-Knopf gebaut, und die Kennung beantwortet direkt daneben die
   Frage „ist das der richtige Pi?". Inhaber und Administratoren bekommen sie
   nicht über `fern.verwalten`, sondern weil ROLE_DEFAULTS/`ALLE.filter(...)`
   ihnen `fern.zugriff` ohnehin mitgeben — fiele das eines Tages weg, soll es
   HIER auffallen. */
for (const [name, konto] of [
  ['teamlead', echteLeitung], ['admin', echterAdmin], ['owner', echterOwner],
] as const) {
  const a2 = await anfrage('/api/fern/stand', konto);
  pruef(`Rolle ${name}: bekommt die Kennung`,
    stimmt((a2.body as { kennung?: unknown })?.kennung, PROBE_KENNUNG), true);
}

/* Die eine Kombination, die die Rollenvorgabe NICHT hervorbringt: nur
   `fern.verwalten`, ohne `fern.zugriff`. Sie steht hier, damit die
   Entscheidung geschrieben ist statt bloß zufällig — wer den Zugang setzen
   darf, liest die Kennung in der Antwort seines eigenen POST
   /api/fern/zugang zurück und braucht sie an dieser Auskunft nicht. */
const standVerwalten = await anfrage('/api/fern/stand', nurVerwalten);
pruef('Nur fern.verwalten (kommt in keiner Rolle vor): keine Kennung',
  Object.keys((standVerwalten.body ?? {}) as object).includes('kennung'), false);

/* ── 3d) Kein Zwischenspeicher auf dem Weg zum Verbinden ────────────
 * `/api/fern/zugang` gibt Adresse und Passwort im Klartext heraus und war
 * der einzige der drei geheimnistragenden Fern-Wege OHNE diese Kopfzeile.
 * Ohne sie darf ein Browser eine 200er-Antwort ohne Frischeangabe nach
 * eigenem Ermessen auf die Platte legen (RFC 9111, heuristisch) — im Profil
 * eines geteilten Rechners überlebt der Zugang damit die Sitzung.
 *
 * Steht ABSICHTLICH neben dem Gegenbeleg darunter: ohne ihn wäre „enthält
 * no-store" nicht davon zu unterscheiden, dass irgendein Vorgeschaltetes die
 * Kopfzeile allen Antworten anhängt — und die Prüfung wäre grün, ohne dass
 * an der Route etwas stünde. */
console.log('\n3d) Cache-Control auf dem Weg mit Klartext');

pruef('GET /api/fern/zugang verbietet jeden Zwischenspeicher',
  String(bZugang.kopf['cache-control'] ?? '').includes('no-store'), true);
pruef('...und sagt das auch der HTTP/1.0-Zwischenstation',
  String(bZugang.kopf['pragma'] ?? '').includes('no-cache'), true);

/* Der Gegenbeleg. Eine gewöhnliche Auskunft trägt KEIN Cache-Control —
   genau deshalb ist das Fehlen an einer Geheimnisroute ein Fehler und nicht
   bloß eine Stilfrage. Schlägt diese Zeile eines Tages an, weil jemand die
   Kopfzeile global setzt, ist das keine Katastrophe, aber die drei Zeilen
   darüber sagen dann nichts mehr aus, und das soll sichtbar werden. */
const harmlos = await anfrage('/api/permissions', ohneAlles);
pruef('Gegenbeleg: /api/permissions antwortet mit 200', harmlos.statusCode, 200);
pruef('...und trägt von sich aus KEIN Cache-Control',
  harmlos.kopf['cache-control'] === undefined, true);

/* ── 4) Kein Zugang hinterlegt ──────────────────────────────────────
 * Zuletzt, weil es die Ausgangslage zerstört. Ein 200 mit leerem Passwort
 * wäre hier die schlechteste Antwort: die Oberfläche zeigte ein leeres Feld
 * und niemand wüsste, ob das Passwort leer ist oder fehlt. */
console.log('\n4) Nichts hinterlegt — 404 statt leerer Werte');

fernzugang.zugangLoeschen('pruefer');
pruef('Der Zugang ist wirklich weg', fernzugang.zugangStand().hinterlegt, false);
const leer = await anfrage(ANSEHEN, nurVerwalten);
pruef('GET /api/fern/zugang-ansehen: 404', leer.statusCode, 404);
/* Mit Kennung — sonst wäre dieser Abschnitt nicht von einer Route zu
   unterscheiden, die es gar nicht gibt: Fastifys eigenes „Not Found" ist
   ebenfalls ein 404, trägt aber kein `code` (siehe partnergruppen-routen.mts,
   routeUnbekannt()). Ohne diese Zeile bliebe Abschnitt 4 grün, wenn jemand
   die ganze Route entfernte. */
pruef('...mit der Kennung des Dienstes, nicht Fastifys blankem Not Found',
  (leer.body as { code?: string })?.code, 'fern.nichtEingerichtet');
pruef('...ohne Passwort und ohne Adresse im Rumpf',
  Object.keys((leer.body ?? {}) as object).some((k) => k === 'passwort' || k === 'adresse'), false);

/* ── 5) Die Oberfläche stellt den Knopf gar nicht erst hin ───────────
 * KEINE Sicherheitsgrenze — die sitzt oben in den Abschnitten 1 bis 3, auf
 * dem Server. Hier geht es um die Zusage, dass der Aufdeck-Knopf für alle
 * ohne `fern.verwalten` ABWESEND ist und nicht bloß ausgegraut: ein
 * gesperrter Knopf kündigt an, dass es etwas zu holen gibt, und lässt die
 * Teamleitung fragen, warum sie nicht darf.
 *
 * Nur LESEND auf Settings.tsx, per Muster — ein React-Baum ließe sich hier
 * nicht ohne Browser zeichnen. Die Kanarienvogel-Zeile zuerst: findet das
 * Muster den Block gar nicht, ist der Rest wertlos und muss auffallen,
 * statt still grün zu bleiben. */
console.log('\n5) Oberfläche: der Aufdeck-Block hängt an fern.verwalten');

const settingsPfad = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../desktop/src/components/Settings.tsx',
);
const settings = fs.readFileSync(settingsPfad, 'utf8');

const einbau = settings.split('\n').filter((z) => z.includes('<FernZugangAnsehen'));
pruef('Sanity: der Block wird genau einmal eingebaut', einbau.length, 1);
pruef('...und zwar nur unter einer Bedingung, nicht unbedingt',
  einbau[0]?.includes('darfFernVerwalten &&') ?? false, true);
pruef('...und diese Bedingung liest genau permissions[\'fern.verwalten\']',
  /const darfFernVerwalten\s*=[^\n]*permissions\['fern\.verwalten'\]/.test(settings), true);
pruef('...und der Block ist nirgends nur ausgegraut statt weggelassen',
  einbau[0]?.includes('disabled') ?? true, false);
/* Ein Speichern setzt Adresse oder Passwort neu. Steht der Block dann noch
   aufgedeckt da, zeigt er Werte von vorher — und wer sie in dem Moment
   weitergibt, verschickt einen Zugang, den es nicht mehr gibt. Der `key`
   wirft ihn weg. */
pruef('...und ein Speichern wirft den aufgedeckten Stand weg (key)',
  einbau[0]?.includes('key={fernFassung}') ?? false, true);
pruef('...der Zähler dafür wird beim Speichern des Fernzugangs erhöht',
  /setFernFassung\(\(n\) => n \+ 1\)/.test(settings), true);

/* ── 6) Der Block selbst: zwei Hälften, ein Schalter, kein Leck ──────
 * Ebenfalls nur lesend und ebenfalls keine Sicherheitsgrenze. Geprüft wird,
 * was die Entscheidungen im Kopf von FernZugangAnsehen() zusagen — dass
 * BEIDE Werte an derselben Verdeckung hängen, dass es je Wert einen eigenen
 * Kopierknopf gibt, und vor allem: dass keiner der beiden Werte in einer
 * Meldung landet. Eine Toast-Meldung ist der kürzeste Weg von einem
 * Geheimnis auf einen fremden Bildschirm. */
console.log('\n6) Der Aufdeck-Block: beide Hälften, ein Schalter, keine Meldung mit Werten');

const blockAnfang = settings.indexOf('function FernZugangAnsehen() {');
const blockEnde = settings.indexOf('\n}\n', blockAnfang);
pruef('Sanity: der Block ist im Quelltext auffindbar',
  blockAnfang >= 0 && blockEnde > blockAnfang, true);
const block = blockAnfang >= 0 ? settings.slice(blockAnfang, blockEnde) : '';

/* Beide Eingabefelder hängen an DERSELBEN Bedingung. Zwei eigene Schalter
   ergäben einen Zustand, in dem jemand das Passwort verdeckt, den Schirm für
   sauber hält und die Anschrift stehen lässt. */
const maske = block.match(/type=\{zugang === null \? 'password' : 'text'\}/g) ?? [];
pruef('Genau zwei Felder, beide an derselben Verdeckung', maske.length, 2);
pruef('...und der Aufdeck-Schalter steht genau einmal da',
  (block.match(/fern\.zugangAufdecken/g) ?? []).length, 1);
pruef('...Verdecken leert den Zustand wirklich (setZugang(null))',
  /if \(zugang !== null\) \{ setZugang\(null\); return; \}/.test(block), true);

/* Je Wert ein Kopierknopf — und beide über dieselbe selbstlöschende Ablage
   wie im Tresor. */
pruef('Eigener Kopierknopf für die Adresse',
  (block.match(/fern\.adresseKopieren/g) ?? []).length, 1);
pruef('Eigener Kopierknopf für das Passwort',
  (block.match(/fern\.passwortKopieren/g) ?? []).length, 1);
pruef('Kopieren geht über kopierenUndLoeschen(), nicht direkt an die Ablage',
  /kopierenUndLoeschen\(geholt\[welches\]/.test(block), true);
/* Kopieren holt frisch. Wenn dabei etwas Neues zurückkommt, MUSS das
   aufgedeckte Feld nachziehen — sonst steht im Feld der Wert von vorhin,
   während in der Ablage der jetzige liegt, und wer beides nebeneinander
   weitergibt, verschickt zwei verschiedene Zugänge. */
pruef('Ein frisch geholter Wert zieht das aufgedeckte Feld nach',
  /setZugang\(\(bisher\) => \(bisher === null \? null : geholt\)\)/.test(block), true);
/* Und zwar über den Stand von JETZT, nicht über den vom Klick. Ein
   `if (zugang !== null)` läse die Schließung des Klicks: wer während des
   Holens verdeckt, bekäme hinterher wieder aufgedeckt. */
pruef('...und liest dafür den Stand von jetzt, nicht den vom Klick',
  /if \(zugang !== null\) setZugang\(/.test(block), false);
pruef('...und der Block schreibt nirgends selbst in navigator.clipboard',
  /navigator\.clipboard/.test(block), false);

/* Kein Wert in einer Meldung. Die Übersetzungsaufrufe werden vorher
   herausgestrichen — `t('passwort.fehlerGeheimnis')` ist ein Schlüssel, kein
   Wert, und würde sonst jede Prüfung hier von allein auslösen. */
const meldungen = [...block.matchAll(/toast\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
const meldungenOhneSchluessel = meldungen.map((m) => m.replace(/t\('[^']*'(?:, [^)]*)?\)/g, 'T'));
pruef('Sanity: der Block meldet überhaupt etwas', meldungen.length > 0, true);
pruef('Sanity: das Herausstreichen entfernt die Schlüssel wirklich',
  meldungenOhneSchluessel.join('').includes('passwort.'), false);
pruef('Keine Meldung trägt einen der beiden Werte',
  meldungenOhneSchluessel.some((m) => /geholt|zugang|\.adresse|\.passwort/.test(m)), false);
pruef('...und der Block protokolliert nichts in die Konsole',
  /console\./.test(block), false);

/* ── 7) Der Weg, den die App wirklich ruft ──────────────────────────
 * Die Route umzubenennen und den alten Namen in api.ts stehen zu lassen
 * ergäbe eine App, die auf ein 404 läuft — und ein Prüflauf, der nur den
 * Server befragt, sähe davon nichts. */
console.log('\n7) net/api.ts ruft den neuen Weg, und nur den');

const apiPfad = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../desktop/src/net/api.ts',
);
const apiQuelle = fs.readFileSync(apiPfad, 'utf8');
pruef('fernZugangAnsehen() zeigt auf /api/fern/zugang-ansehen',
  new RegExp(`fernZugangAnsehen:[^\\n]*'${ANSEHEN}'`).test(apiQuelle), true);
pruef('...und der alte Weg steht nirgends mehr in api.ts',
  apiQuelle.includes(`'${ANSEHEN_ALT}'`), false);
pruef('...und Settings.tsx ruft genau diese eine Stelle',
  (block.match(/api\.fernZugangAnsehen\(\)/g) ?? []).length, 1);

/* ── 8) Die Meldungen sagen, WAS wirklich passiert ist ──────────────
 * Der Aufdeck-Block kopiert zwei Werte über EINEN gemeinsamen Weg
 * (`kopierenUndLoeschen`) und holt beide über EINEN gemeinsamen Aufruf. Die
 * Texte an diesen Stellen sagten trotzdem „das Passwort".
 *
 * WARUM DAS MEHR IST ALS UNGENAU. Wer die Adresse kopiert und daraufhin liest,
 * das Passwort des Pi liege offen in der Zwischenablage, hat einen Grund zu
 * handeln, den es nicht gibt — und die naheliegende Handlung ist, das
 * Pi-Passwort neu zu setzen. Das trennt jeden, der gerade verbunden ist. Eine
 * falsche Meldung kostet hier eine echte Verbindung.
 *
 * GEPRÜFT WIRD DIE ÜBERSETZUNG, NICHT DER SCHLÜSSEL. Ein Schlüsselname sagt
 * nichts darüber, was auf dem Schirm steht; `passwort.ablageBleibtText` heißt
 * weiterhin so und trägt trotzdem keinen Passwortbegriff mehr. Deshalb liest
 * dieser Abschnitt die 22 Wörterbücher und sucht in jedem nach dem
 * PASSWORTWORT DIESER SPRACHE.
 *
 * UND DIE SUCHE BEWEIST SICH SELBST. Zu jeder Sprache steht darunter, dass
 * dasselbe Wort in `passwort.fehlerGeheimnis` sehr wohl gefunden wird — dort
 * gehört es hin (der Tresor, wo der Wert immer ein Passwort ist). Ohne diese
 * Gegenprobe wäre „nicht gefunden" von „falsches Wort in der Tabelle" nicht zu
 * unterscheiden, und der ganze Abschnitt wäre grün, ohne etwas zu prüfen. */
console.log('\n8) Die Meldungen des Aufdeck-Blocks — und was sie behaupten');

pruef('Der Fehler beim Holen nennt den Zugang, nicht das Passwort',
  (block.match(/fern\.zugangFehler/g) ?? []).length, 1);
/* Gesucht wird der AUFRUF, nicht der Name: der Kommentar im Block nennt den
   alten Schlüssel ausdrücklich, damit niemand ihn versehentlich wieder
   einsetzt — das ist erwünscht und darf nicht anschlagen. */
pruef('...und der Tresor-Schlüssel wird im Fern-Block nicht mehr gerufen',
  block.includes("t('passwort.fehlerGeheimnis')"), false);
/* Sonst wäre die Zeile darüber auch dann grün, wenn dieser Lauf den Block gar
   nicht gefunden hätte: `''.includes(...)` ist ebenfalls false. */
pruef('Sanity: der Block ruft überhaupt Übersetzungen', block.includes("t('"), true);

const tresorPfad = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../desktop/src/components/PasswortPanel.tsx',
);
/* Der Schlüssel wurde nicht abgeschafft, sondern zurückgegeben: im Tresor ist
   „Passwort konnte nicht geholt werden" die richtige Überschrift. Fiele diese
   Zeile, hätte jemand ihn aus Versehen überall ersetzt. */
pruef('...und im Tresor steht er weiterhin',
  fs.readFileSync(tresorPfad, 'utf8').includes("t('passwort.fehlerGeheimnis')"), true);

/* Das Passwortwort je Sprache, als Stamm — Beugungen der Wörterbücher
   („Adgangskoden", „hasła", „Lösenordet") sollen mitgefunden werden.
   Kleingeschrieben verglichen; bei den Schriften ohne Groß/Klein ist das
   wirkungslos und schadet nicht. */
const PASSWORTWORT: Record<string, string> = {
  ar: 'كلمة المرور', cs: 'hesl', da: 'adgangskod', de: 'passwort', en: 'password',
  es: 'contraseñ', fi: 'salasan', fr: 'mot de passe', hi: 'पासवर्ड', it: 'password',
  ja: 'パスワード', ko: '비밀번호', nl: 'wachtwoord', no: 'passord', pl: 'hasł',
  pt: 'senha', ro: 'parol', ru: 'парол', sv: 'lösenord', tr: 'parol',
  uk: 'парол', zh: '密码',
};

/* Diese drei laufen an BEIDEN Stellen — im Tresor (immer ein Passwort) und
   beim Pi-Zugang (Adresse ODER Passwort). Sie dürfen deshalb keinen von
   beiden Werten benennen. */
const NEUTRAL = ['passwort.ablageBleibtText', 'passwort.ablageNichtGeleertText', 'fern.zugangFehler'];
/* Der läuft nur im Tresor und MUSS das Wort tragen — die Gegenprobe. */
const MIT_WORT = 'passwort.fehlerGeheimnis';

const i18nOrdner = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../../desktop/src/i18n',
);
function zeile(quelle: string, schluessel: string): string {
  const t = quelle.match(new RegExp(`^  '${schluessel.replace('.', '\\.')}': (.*),$`, 'm'));
  return (t?.[1] ?? '').toLowerCase();
}

let neutralGeprueft = 0;
let gegenprobenGefunden = 0;
for (const [code, wort] of Object.entries(PASSWORTWORT)) {
  const quelle = fs.readFileSync(path.join(i18nOrdner, `${code}.ts`), 'utf8');
  const treffer = NEUTRAL.filter((k) => {
    const wert = zeile(quelle, k);
    /* Ein leerer Wert hieße: der Schlüssel fehlt in dieser Sprache. Dann
       nichts zu melden wäre die schlechteste Antwort — die Zeile sähe grün
       aus, weil nichts da war. */
    if (!wert) return true;
    neutralGeprueft += 1;
    return wert.includes(wort.toLowerCase());
  });
  pruef(`${code}: die drei geteilten Texte nennen kein Passwort${treffer.length ? ` (${treffer.join(', ')})` : ''}`,
    treffer.length, 0);
  if (zeile(quelle, MIT_WORT).includes(wort.toLowerCase())) gegenprobenGefunden += 1;
}
/* Die Suche greift wirklich — in allen 22 Sprachen, an dem einen Schlüssel,
   an dem das Wort hingehört. */
pruef('Gegenprobe: das Passwortwort wird in jeder Sprache gefunden, wo es hingehört',
  gegenprobenGefunden, Object.keys(PASSWORTWORT).length);
pruef('Sanity: es wurden wirklich 22 × 3 Texte gelesen, nicht 22 × 0',
  neutralGeprueft, Object.keys(PASSWORTWORT).length * NEUTRAL.length);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mDie Anzeige des Pi-Zugangs (Adresse und Passwort) hängt an fern.verwalten — /api/fern/zugang bleibt für fern.zugriff unverändert und verbietet den Zwischenspeicher, /api/fern/stand gibt die Kennung nur an Konten mit fern.zugriff, und keine Meldung des Blocks behauptet ein Passwort, wo eine Adresse kopiert wurde.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
