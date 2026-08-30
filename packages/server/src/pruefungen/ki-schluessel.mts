/**
 * Der Groq-Schlüssel aus den Einstellungen: wer ihn ändern darf, welcher der
 * beiden Werte gilt, ob eine Änderung OHNE Neustart greift — und ob ein
 * leeres Feld ihn wirklich löscht.
 *
 * DIE FRAGE, DIE DIESER LAUF BEANTWORTET
 * Bis zum 30.08.2026 ließ sich der Schlüssel nur über `GROQ_API_KEY` in der
 * .env oder über `npm run secret` setzen, und beides wirkte erst beim nächsten
 * Start. Seit er über `POST /api/ki/zugang` änderbar ist, hängen vier Zusagen
 * daran, die man alle vier nur MESSEN kann:
 *
 *   1 RECHT       Ein gewöhnliches Mitglied darf ihn nicht anfassen.
 *   2 VORRANG     Steht `GROQ_API_KEY` in der Umgebung, schlägt sie den
 *                 Tresor — und die Auskunft muss das zugeben, statt ein
 *                 wirkungsloses Speichern als Erfolg auszugeben.
 *   3 SOFORT      Die nächste Anfrage an Groq trägt den neuen Schlüssel,
 *                 ohne dass jemand den Server neu startet.
 *   4 LEER LÖSCHT Ein leerer Wert entfernt den Eintrag, statt einen leeren
 *                 Text abzulegen — und der Server fällt sauber auf „keine KI"
 *                 zurück.
 *
 * WARUM EIN DOPPELGÄNGER UND NICHT DIE ECHTE SCHNITTSTELLE
 * Punkt 2 und 3 sind Aussagen darüber, WELCHEN Schlüssel der Server
 * hinausschickt. Am Zustand im Speicher lässt sich das nicht ehrlich
 * beantworten: der Anbieter nimmt den Schlüssel beim BAUEN mit
 * (providers/openai-compatible.ts), und ein Blick auf `config.ai.groq.apiKey`
 * würde genau diese Lücke übersehen — dieselbe Lücke, wegen der die Aufgabe
 * überhaupt entstand. Also läuft hier ein winziger HTTP-Dienst auf
 * 127.0.0.1, `GROQ_BASE_URL` zeigt auf ihn, und er schreibt mit, welche
 * `Authorization`-Kopfzeile ankommt. Es geht dabei KEINE Anfrage ins Netz,
 * und es wird KEIN echter Schlüssel verwendet — die Proben sind bei jedem
 * Lauf frisch gewürfelt und tragen ein sichtbares `gsk_test_`.
 *
 * WARUM DIE IMPORTE UNTEN DYNAMISCH SIND
 * `config.ts` liest `GROQ_BASE_URL`, `AI_PROVIDER` und das Masterpasswort
 * EINMAL beim Laden. Ein gewöhnlicher `import` oben wird vor dem Dateirumpf
 * ausgeführt — der Doppelgänger hätte seinen Port dann noch gar nicht, und
 * der Lauf hinge an einem Port, den zufällig jemand anders belegt. Deshalb
 * erst die Umgebung setzen, dann laden.
 *
 * KEIN GEHEIMNIS IN DER AUSGABE
 * Gedruckt werden nur Wahrheitswerte, Zahlen und Namen. Die Proben sind
 * erfunden, aber sie stehen für Werte, die es im Ernstfall nicht sind — und
 * ein Muster, das sie druckt, würde eines Tages den echten drucken. Jeder
 * Vergleich mit einem Klartext wird VORHER zu `true`/`false` gerechnet.
 *
 * Aufruf:  node scripts/ki-schluessel-pruefen.mjs
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/* ── Proben: frisch gewürfelt, offensichtlich unecht ──────────────── */
const P = (was: string) => `gsk_test_${was}_${crypto.randomBytes(16).toString('hex')}`;
const PROBEN = {
  tresorAlt: P('tresor-alt'),
  tresorNeu: P('tresor-neu'),
  umgebung: P('umgebung'),
  trotzUmgebung: P('trotz-umgebung'),
  /* Der Wert, den ein Mitglied vergeblich zu setzen versucht. Er darf nach
     dem Lauf nirgends stehen — weder im Tresor noch in einer Kopfzeile. */
  verboten: P('verboten'),
};

/* ── Der Doppelgänger ─────────────────────────────────────────────── */
const gesehen: string[] = [];
const doppelgaenger = http.createServer((req, res) => {
  gesehen.push(String(req.headers.authorization ?? '(keine)'));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: [
    { id: 'llama-3.3-70b-versatile', context_window: 131072, owned_by: 'Meta' },
    { id: 'llama-3.1-8b-instant', context_window: 131072, owned_by: 'Meta' },
  ] }));
});
await new Promise<void>((fertig) => doppelgaenger.listen(0, '127.0.0.1', fertig));
const port = (doppelgaenger.address() as AddressInfo).port;

/** Welchen Schlüssel trug die JÜNGSTE Anfrage an „Groq"? Nur als Vergleich. */
const zuletztGeschickt = (wert: string): boolean =>
  gesehen.length > 0 && gesehen[gesehen.length - 1] === `Bearer ${wert}`;

/* ── Die Umgebung, bevor irgendetwas sie liest ────────────────────── */
/* Ein eigenes Masterpasswort statt der Keychain: der Lauf soll auf jedem
   Rechner gleich ausgehen — auf dem Pi, auf dem es keine Keychain gibt,
   genauso wie auf einem Mac, auf dem eine mit ganz anderem Inhalt liegt. */
process.env.STELLIUM_MASTER_PASSPHRASE = `pruef-${crypto.randomBytes(24).toString('hex')}`;
delete process.env.GROQ_API_KEY;
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.GROQ_MODEL = '';
process.env.GROQ_FAST_MODEL = '';

const { aiConfigured, geheimStand } = await import('../config.js');
const { db, initDb } = await import('../db/index.js');
const { assistant, provider, providerNeuAufbauen, aiCapabilities } = await import('../translation/index.js');
const kizugang = await import('../services/kizugang.js');
const { registerRoutes } = await import('../http/routes.js');
const { signToken } = await import('../auth.js');
const users = await import('../services/users.js');
const { Vault } = await import('../secrets.js');
const path = await import('node:path');

initDb();

function konto(rolle: string, id: string): string {
  db.run(
    'INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)',
    id, id, id, 'x', rolle, Date.now(),
  );
  return id;
}
const inhaber = konto('owner', 'u_inhaber');
const verwalter = konto('admin', 'u_verwalter');
const mitglied = konto('member', 'u_mitglied');

const app = Fastify({ logger: false });
await registerRoutes(app);

const hole = (pfad: string, wer: string) => app.inject({
  method: 'GET', url: pfad, headers: { authorization: `Bearer ${signToken(wer)}` },
});
const schicke = (pfad: string, wer: string, rumpf: unknown) => app.inject({
  method: 'POST', url: pfad, headers: { authorization: `Bearer ${signToken(wer)}` }, payload: rumpf as object,
});

/** Der rohe Tresorinhalt — nur für die Gegenprobe, nie gedruckt. */
const tresorRoh = (): string => {
  const datei = path.join(process.env.DATA_DIR ?? 'data', 'secrets.enc');
  const v = new Vault(path.resolve(datei));
  return v.exists() ? JSON.stringify(v.load(process.env.STELLIUM_MASTER_PASSPHRASE as string)) : '{}';
};

/* ── 0) Ausgangslage ──────────────────────────────────────────────── */
console.log('\n0) Ausgangslage');
pruef('Die Proben sind alle verschieden', new Set(Object.values(PROBEN)).size, Object.keys(PROBEN).length);
pruef('Keine der Proben ist leer', Object.values(PROBEN).every((w) => w.length > 20), true);
pruef('GROQ_API_KEY steht NICHT in der Umgebung (der Lauf setzt sie selbst)',
  Boolean(process.env.GROQ_API_KEY), false);
pruef('Der Tresor ist beschreibbar (Masterpasswort vorhanden)',
  geheimStand('GROQ_API_KEY', 'groq').schreibbar, true);
pruef('Noch liegt kein Schlüssel vor', geheimStand('GROQ_API_KEY', 'groq').hinterlegt, false);
pruef('Der Inhaber trägt ki.verwalten', users.may(inhaber, 'ki.verwalten'), true);
/* Bewusst so entschieden, nicht durchgerutscht: ADMIN ist ALLE minus drei
   (permissions.ts). Diese Zeile hält die Entscheidung fest — ändert sie
   jemand, fällt sie hier auf und nicht erst im Betrieb. */
pruef('Der Administrator ebenfalls', users.may(verwalter, 'ki.verwalten'), true);
pruef('Ein gewöhnliches Mitglied NICHT', users.may(mitglied, 'ki.verwalten'), false);

/* ── 1) Wer darf ──────────────────────────────────────────────────── */
console.log('\n1) Recht — nur wer den Zugang einrichten darf');
pruef('GET  /api/ki/zugang — Inhaber: 200', (await hole('/api/ki/zugang', inhaber)).statusCode, 200);
pruef('GET  /api/ki/zugang — Administrator: 200', (await hole('/api/ki/zugang', verwalter)).statusCode, 200);
pruef('GET  /api/ki/zugang — Mitglied: 403', (await hole('/api/ki/zugang', mitglied)).statusCode, 403);
pruef('POST /api/ki/zugang — Mitglied: 403',
  (await schicke('/api/ki/zugang', mitglied, { schluessel: PROBEN.verboten })).statusCode, 403);
pruef('...und der abgewiesene Wert steht danach nirgends im Tresor',
  tresorRoh().includes(PROBEN.verboten), false);
pruef('GET  /api/ki/zugang — ohne Anmeldung: 401',
  (await app.inject({ method: 'GET', url: '/api/ki/zugang' })).statusCode, 401);

/* ── 2) Sofort wirksam ────────────────────────────────────────────── */
console.log('\n2) Ohne Neustart wirksam — gemessen am Doppelgänger');
const gesetzt = await schicke('/api/ki/zugang', inhaber, { schluessel: PROBEN.tresorAlt });
pruef('POST /api/ki/zugang — Inhaber: 200', gesetzt.statusCode, 200);
pruef('Der Server meldet: hinterlegt, Quelle Tresor',
  JSON.parse(gesetzt.body).quelle, 'tresor');
pruef('Und schickt den neuen Schlüssel SOFORT hinaus — derselbe Prozess',
  zuletztGeschickt(PROBEN.tresorAlt), true);

const gewechselt = await schicke('/api/ki/zugang', inhaber, { schluessel: PROBEN.tresorNeu });
pruef('Ein zweiter Wechsel wirkt genauso', gewechselt.statusCode, 200);
pruef('...und der Doppelgänger sieht den zweiten Schlüssel',
  zuletztGeschickt(PROBEN.tresorNeu), true);
pruef('...den ersten also nicht mehr', zuletztGeschickt(PROBEN.tresorAlt), false);

/* ── 3) Kein Schlüssel in der Antwort ─────────────────────────────── */
console.log('\n3) Der Wert selbst kommt nie zurück');
const stand = await hole('/api/ki/zugang', inhaber);
const alleProben = Object.values(PROBEN);
pruef('Keine der Proben steht im Rumpf von GET',
  alleProben.filter((w) => stand.body.includes(w)).length, 0);
pruef('Keine der Proben steht im Rumpf von POST',
  alleProben.filter((w) => gewechselt.body.includes(w)).length, 0);
pruef('Auch nicht in den Kopfzeilen',
  alleProben.filter((w) => JSON.stringify(stand.headers).includes(w)).length, 0);
/* Die Gegenprobe: der Wert IST da — nur eben im Tresor und nicht in der
   Antwort. Ohne diese Zeile wären die drei darüber von einer kaputten Suche
   nicht zu unterscheiden. */
pruef('Gegenprobe: dieselbe Suche findet den Schlüssel sehr wohl im Tresor',
  tresorRoh().includes(PROBEN.tresorNeu), true);
/* Und die andere Richtung — auch kein Anfangs- oder Endstück. Vier Zeichen
   nennen bei den meisten Anbietern schon Dienst und Art des Schlüssels. */
pruef('Auch kein Anfangsstück des Schlüssels',
  stand.body.includes(PROBEN.tresorNeu.slice(0, 12)), false);
pruef('Auch kein Endstück', stand.body.includes(PROBEN.tresorNeu.slice(-6)), false);

/* ── 4) Vorrang: Umgebung schlägt Tresor ──────────────────────────── */
console.log('\n4) Vorrang — die Umgebung schlägt den Tresor, und die Maske erfährt es');
process.env.GROQ_API_KEY = PROBEN.umgebung;
await providerNeuAufbauen();
const beiUmgebung = JSON.parse((await hole('/api/ki/zugang', inhaber)).body);
pruef('Der Server nennt die Umgebung als Quelle', beiUmgebung.quelle, 'umgebung');
pruef('...sagt aber weiterhin, dass im Tresor einer liegt', beiUmgebung.tresor, true);
pruef('...und schickt den Wert aus der Umgebung hinaus',
  zuletztGeschickt(PROBEN.umgebung), true);

const trotzdem = await schicke('/api/ki/zugang', inhaber, { schluessel: PROBEN.trotzUmgebung });
pruef('Speichern gelingt trotzdem — der Wert liegt danach im Tresor',
  tresorRoh().includes(PROBEN.trotzUmgebung), true);
/* DER EIGENTLICHE PUNKT DIESES ABSCHNITTS: die Antwort auf genau dieses
   Speichern sagt „Umgebung". Stünde hier 'tresor', hielte die Maske ein
   wirkungsloses Speichern für ein wirksames — der Fehler, um den es geht. */
pruef('Die Antwort auf DIESES Speichern nennt weiter die Umgebung',
  JSON.parse(trotzdem.body).quelle, 'umgebung');
pruef('Und hinausgeschickt wird weiter der Wert aus der Umgebung',
  zuletztGeschickt(PROBEN.umgebung), true);

delete process.env.GROQ_API_KEY;
await providerNeuAufbauen();
pruef('Ohne die Umgebung greift wieder der Tresor',
  JSON.parse((await hole('/api/ki/zugang', inhaber)).body).quelle, 'tresor');
pruef('...und zwar mit dem zuletzt gespeicherten Wert',
  zuletztGeschickt(PROBEN.trotzUmgebung), true);

/* ── 5) Leeres Feld löscht ────────────────────────────────────────── */
console.log('\n5) Leerer Wert löscht — und der Server fällt sauber zurück');
const geloescht = await schicke('/api/ki/zugang', inhaber, { schluessel: '   ' });
pruef('POST mit leerem Wert: 200', geloescht.statusCode, 200);
pruef('Danach ist nichts mehr hinterlegt', JSON.parse(geloescht.body).hinterlegt, false);
/* Nicht „leerer Text abgelegt", sondern wirklich weg: ein leerer Eintrag
   stünde in der Tresorliste als vorhanden und wäre trotzdem nichts. */
pruef('Der Name „groq" ist aus dem Tresor verschwunden, nicht bloß geleert',
  JSON.parse(tresorRoh()).groq === undefined, true);
pruef('aiConfigured() sagt jetzt nein', aiConfigured(), false);
pruef('Der Anbieter ist der Demo-Anbieter', provider.name, 'demo');
pruef('Es gibt keinen Assistenten mehr', assistant(), null);
pruef('Die Einstellungen melden „kein Schlüssel"', aiCapabilities().noteCode, 'hinweis.keinSchluessel');
pruef('...und der Stand des Dienstes stimmt damit überein',
  kizugang.schluesselStand().hinterlegt, false);

await app.close();
doppelgaenger.close();

console.log(fehler
  ? `\n\x1b[31m${fehler} Fehler.\x1b[0m\n`
  : '\n\x1b[32mDer KI-Schlüssel: nur mit Recht änderbar, nie sichtbar, sofort wirksam — und die Umgebung schlägt den Tresor, sichtbar für alle.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
