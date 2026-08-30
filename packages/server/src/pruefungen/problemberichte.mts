/**
 * Prüft die Problemberichte über die echte HTTP-Schicht — kein
 * app.listen(), Fastifys eigenes inject() reicht (dieselbe Bauart wie
 * partnergruppen-routen.mts, Begründung dort). Gegen eine wegwerfbare
 * Datenbank.
 *
 * WAS DIESER LAUF BEWEIST, UND WARUM GENAU DAS
 *   1) Ein Bericht kommt mit seinem automatisch erfassten Kontext zurück
 *      (Fassung, Plattform, erkannter Bereich, Sprache) — ohne dass die
 *      Anfrage sie mitgeschickt hätte: sie stehen vorher auf dem Testkonto,
 *      nicht im Anfragerumpf.
 *   2) Der Lebenslauf verhindert doppelte Auslieferung an eine abfragende
 *      Stelle: ein übernommener Bericht taucht bei ?status=neu nicht mehr
 *      auf.
 *   3) Wer `report.submit` bzw. `report.review` nicht hat, bekommt vom
 *      SERVER eine Abweisung — nicht nur eine ausgeblendete Schaltfläche.
 *      Eine fremde Kennung, die man nicht sehen darf, sieht so aus wie eine,
 *      die es nicht gibt.
 *   4) Der Freitext-Teil der Antwort trägt seine Warnung sichtbar mit sich.
 *   5) Das 'bot'-Konto — der vorgesehene Weg für n8n — kommt mit genau
 *      diesem einen zusätzlichen Recht genauso weit wie ein Mensch mit
 *      `report.review`, und NICHT weiter ohne es.
 *   6) Die Migration legt die Tabelle auf einer Datenbank an, die sie noch
 *      nicht hat — nicht nur schema.sql für die frische Installation.
 *
 * Aufruf:  node scripts/problemberichte-pruefen.mjs
 */
import Fastify from 'fastify';
import { db, initDb } from '../db/index.js';
import { registerRoutes } from '../http/routes.js';
import { signToken } from '../auth.js';
import type { MemberRoleName, PermissionKey } from '@stellium/shared';

initDb();

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n     ist:  ${JSON.stringify(ist)}\n     soll: ${JSON.stringify(soll)}`}`);
};

/* ── Testkonten — roh per SQL, wie im ganzen Haus üblich ─────────────── */
let zaehler = 0;
function neueId(praefix: string): string { zaehler += 1; return `${praefix}${zaehler}`; }

function kontoRoh(rolle: MemberRoleName, name: string): string {
  const id = neueId('u_');
  // E-Mail bewusst je Konto EINDEUTIG, nicht leer: problemberichte-migration.mts
  // startet `initDb()` als zweiten, frischen Prozess auf DERSELBEN Datenbank
  // — und der ruft migrate() → encryptExistingUsers() genau einmal auf allen
  // Konten auf, die dann schon stehen. Mehrere Konten mit LEERER E-Mail
  // erzeugen dabei denselben blinden Index (leer bleibt leer, siehe
  // crypto/pii.ts blindIndex()) und stolpern über dessen eindeutigen Index
  // — ein Zustand, der in einer echten Datenbank nie vorkommt (jedes
  // eingeladene Konto bekommt eine eigene Adresse).
  db.run(
    `INSERT INTO users (id, handle, email, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)`,
    id, id, `${id}@test.invalid`, name, 'x', rolle, Date.now(),
  );
  return id;
}

function rechtGeben(userId: string, recht: PermissionKey): void {
  db.run(
    `INSERT INTO user_permissions (user_id, permission, allowed, set_by, set_at) VALUES (?,?,1,'test',?)`,
    userId, recht, Date.now(),
  );
}

// Ein Konto, das genau die Fassung/Plattform trägt, die ws/gateway.ts bei
// einer echten Anmeldung eintragen würde (siehe store.clientMeldung) — hier
// von Hand gesetzt, weil dieser Lauf ohne WebSocket auskommt.
const reporter = kontoRoh('member', 'Reporterin'); // 'member' bringt report.submit über die Rollenvorlage mit
db.run(`UPDATE users SET client_version = ?, client_platform = ? WHERE id = ?`, '1.1.1', 'darwin', reporter);
const reporterToken = signToken(reporter);

const reviewer = kontoRoh('guest', 'Sichterin');   // 'guest' trägt NICHTS außer report.submit von Haus aus
rechtGeben(reviewer, 'report.review');
const reviewerToken = signToken(reviewer);

const aussenstehend = kontoRoh('guest', 'Außenstehender'); // weder submit-fremd noch review — nur die eigene Rollenvorlage
const aussenstehendToken = signToken(aussenstehend);

const botOhneRecht = kontoRoh('bot', 'Technisches Konto ohne Recht'); // 'bot' bringt report.submit NICHT mit
const botOhneRechtToken = signToken(botOhneRecht);

const botMitRecht = kontoRoh('bot', 'n8n'); // dasselbe Konto-Muster, wie es der Inhaber für n8n anlegen würde
rechtGeben(botMitRecht, 'report.review');
const botMitRechtToken = signToken(botMitRecht);

/* ── Die echten Routen, ohne app.listen() ─────────────────────────── */
const app = Fastify({ logger: false });
await registerRoutes(app);

interface Antwort { statusCode: number; body: any; }
async function anfrage(method: string, pfad: string, token: string, payload?: unknown): Promise<Antwort> {
  const antwort = await app.inject({
    method: method as 'GET' | 'POST',
    url: pfad,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: unknown;
  try { body = antwort.json(); } catch { body = undefined; }
  return { statusCode: antwort.statusCode, body };
}

/* ── 1) Anlegen — Kontext kommt vom Server, nicht aus der Anfrage ────── */
console.log('\n1) POST /api/problemberichte — automatisch erfasster Kontext');

const neuerBericht = {
  bereich: 'dateien', schwere: 'stoert',
  erwartet: 'Der Upload soll sofort erscheinen.',
  passiert: 'Die Datei taucht erst nach einem Neuladen auf.',
  schritte: 'Datei in die Ablage ziehen, Liste ansehen.',
  panel: 'dateien', sprache: 'de',
};
const angelegt = await anfrage('POST', '/api/problemberichte', reporterToken, neuerBericht);
pruef('POST /api/problemberichte: 201', angelegt.statusCode, 201);
const bericht1 = angelegt.body?.bericht;
pruef('Fassung kommt vom Konto, nicht aus der Anfrage (die schickte keine)', bericht1?.kontext?.clientVersion, '1.1.1');
pruef('Plattform ebenso vom Konto', bericht1?.kontext?.clientPlatform, 'darwin');
pruef('status startet bei neu', bericht1?.status, 'neu');
pruef('erwartet steht unter unvertrauterInhalt', bericht1?.unvertrauterInhalt?.erwartet, neuerBericht.erwartet);
pruef('passiert steht unter unvertrauterInhalt', bericht1?.unvertrauterInhalt?.passiert, neuerBericht.passiert);
pruef('der Hinweis reist mit jeder Antwort mit (nicht leer)', typeof bericht1?.unvertrauterInhalt?.hinweis === 'string' && bericht1.unvertrauterInhalt.hinweis.length > 20, true);
pruef('bereich/schwere stehen strukturiert AUSSERHALB des Freitext-Blocks', typeof bericht1?.bereich, 'string');
pruef('erwartet/passiert stehen NICHT auf der obersten Ebene (nur strukturiert im Block)', bericht1?.erwartet, undefined);

/* ── 2) Wer nicht darf, wird SERVERSEITIG abgewiesen ─────────────────── */
console.log('\n2) Rechteprüfung server-seitig, nicht nur an der Oberfläche');

const botOhneVersuch = await anfrage('POST', '/api/problemberichte', botOhneRechtToken, neuerBericht);
pruef('POST als bot ohne report.submit: 403', botOhneVersuch.statusCode, 403);
pruef('…mit der Kennung des fehlenden Rechts', botOhneVersuch.body?.code, 'perm.report.submit.label');

const fremderZugriff = await anfrage('GET', `/api/problemberichte/${bericht1.id}`, aussenstehendToken, undefined);
pruef('GET auf fremden Bericht ohne report.review: 404 (nicht 403 — verrät nichts)', fremderZugriff.statusCode, 404);

const fremdeUebernahme = await anfrage('POST', `/api/problemberichte/${bericht1.id}/uebernehmen`, aussenstehendToken, {});
pruef('POST .../uebernehmen ohne report.review: 403', fremdeUebernahme.statusCode, 403);
pruef('…mit der Kennung des fehlenden Rechts', fremdeUebernahme.body?.code, 'perm.report.review.label');

const fremdeListe = await anfrage('GET', '/api/problemberichte', aussenstehendToken, undefined);
pruef('GET /api/problemberichte ohne report.review: 200, aber leer (fremde Berichte NICHT sichtbar)', fremdeListe.body?.berichte, []);

const eigeneListe = await anfrage('GET', '/api/problemberichte', reporterToken, undefined);
pruef('GET /api/problemberichte für die meldende Person: die eigene Meldung ist dabei', (eigeneListe.body?.berichte ?? []).some((b: any) => b.id === bericht1.id), true);

/* ── 3) Lebenslauf: keine doppelte Auslieferung an eine Abfrage ──────── */
console.log('\n3) Lebenslauf neu → in_arbeit → erledigt, Warteschlange ohne Dubletten');

const vorUebernahme = await anfrage('GET', '/api/problemberichte?status=neu', reviewerToken, undefined);
pruef('?status=neu enthält den frischen Bericht', (vorUebernahme.body?.berichte ?? []).some((b: any) => b.id === bericht1.id), true);

const uebernommen = await anfrage('POST', `/api/problemberichte/${bericht1.id}/uebernehmen`, reviewerToken, {});
pruef('POST .../uebernehmen mit report.review: 200', uebernommen.statusCode, 200);
pruef('status danach: in_arbeit', uebernommen.body?.bericht?.status, 'in_arbeit');
pruef('takenBy trägt die übernehmende Person', uebernommen.body?.bericht?.takenBy, reviewer);

const nachUebernahme = await anfrage('GET', '/api/problemberichte?status=neu', reviewerToken, undefined);
pruef('DERSELBE Bericht taucht bei ?status=neu NICHT mehr auf (keine Dublette für eine abfragende Stelle)',
  (nachUebernahme.body?.berichte ?? []).some((b: any) => b.id === bericht1.id), false);

const inArbeit = await anfrage('GET', '/api/problemberichte?status=in_arbeit', reviewerToken, undefined);
pruef('…steht stattdessen bei ?status=in_arbeit', (inArbeit.body?.berichte ?? []).some((b: any) => b.id === bericht1.id), true);

const abgeschlossen = await anfrage('POST', `/api/problemberichte/${bericht1.id}/abschliessen`, reviewerToken, { ergebnis: 'Behoben: Liste aktualisiert sich jetzt sofort.' });
pruef('POST .../abschliessen: 200', abgeschlossen.statusCode, 200);
pruef('status danach: erledigt', abgeschlossen.body?.bericht?.status, 'erledigt');
pruef('Ergebnis steht im Freitext-Block', abgeschlossen.body?.bericht?.unvertrauterInhalt?.ergebnis, 'Behoben: Liste aktualisiert sich jetzt sofort.');

const zweiteUebernahme = await anfrage('POST', `/api/problemberichte/${bericht1.id}/uebernehmen`, reviewerToken, {});
pruef('Ein erledigter Bericht lässt sich nicht erneut übernehmen: 400', zweiteUebernahme.statusCode, 400);
pruef('…mit eigener Kennung', zweiteUebernahme.body?.code, 'fehler.problemberichtErledigt');

/* ── 4) Der Weg für n8n: das bot-Konto mit genau dem einen Recht ────── */
console.log('\n4) Das bot-Konto (n8n) kommt mit report.review genauso weit wie eine Person');

const zweiterBericht = await anfrage('POST', '/api/problemberichte', reporterToken, {
  ...neuerBericht, bereich: 'chat', erwartet: 'Nachricht soll sofort ankommen.', passiert: 'Sie erscheint erst nach einem Neuladen.',
});
pruef('zweiter Bericht angelegt: 201', zweiterBericht.statusCode, 201);
const bericht2Id = zweiterBericht.body?.bericht?.id;

const botListe = await anfrage('GET', '/api/problemberichte?status=neu', botMitRechtToken, undefined);
pruef('bot mit report.review sieht die volle Warteschlange (nicht nur eigene Berichte)', (botListe.body?.berichte ?? []).some((b: any) => b.id === bericht2Id), true);

const botUebernimmt = await anfrage('POST', `/api/problemberichte/${bericht2Id}/uebernehmen`, botMitRechtToken, {});
pruef('bot mit report.review darf übernehmen: 200', botUebernimmt.statusCode, 200);

const botOhneRechtListe = await anfrage('GET', '/api/problemberichte', botOhneRechtToken, undefined);
pruef('bot OHNE report.review sieht (mangels eigener Berichte) gar nichts — insbesondere nicht die Liste oben', botOhneRechtListe.body?.berichte, []);

/* Die Migrations-Probe (Abschnitt 5 der Kopfbegründung) läuft NICHT hier:
   migrate() ein zweites Mal im selben Prozess aufzurufen ist kein
   Neustart — encryptExistingUsers() und Co. sind auf GENAU EINEN Lauf je
   Prozess ausgelegt, ein zweiter stolpert über eigene, längst verschlüsselte
   Werte. Ein echter Neustart ist ein neuer PROZESS, und genau das simuliert
   problemberichte-migration.mts: derselbe DATA_DIR, aber ein frischer
   `initDb()`-Aufruf. Diese Datei bereitet den Boden dafür nur vor — DROP,
   kein CREATE — und der Wrapper (scripts/problemberichte-pruefen.mjs) startet
   die zweite Datei danach als eigenen Prozess. */
db.exec('DROP TABLE problemberichte');

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mProblemberichte: Kontext, Rechteschwellen, Lebenslauf und Freitext-Kennzeichnung sind wie erwartet.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
