/**
 * Prüft die HTTP-SCHICHT der Briefpartner-Gruppen — ob `registerRoutes()`
 * wirklich jede Adresse kennt, die PartnerGruppenPanel.tsx aufruft. Ergänzt
 * partnergruppen.mts, ersetzt es nicht: dort werden `gruppeErstellen()` &
 * Co. direkt geprüft (siehe dort, Abschnitt 9, und der ausgeschriebene Grund
 * im Dateikopf von rechte-eskalation.mts, warum ein Lauf gegen den Dienst
 * bewusst KEIN Ersatz für einen Lauf gegen die Route ist) — aber ein Aufruf
 * direkt an den Dienst geht an `http/routes.ts` vorbei und hätte den Fund
 * unten nie gemacht.
 *
 * DER FUND, DER DIESEN LAUF AUSGELÖST HAT (2026-08-23)
 * `gruppeErstellen()`, `gruppeUmbenennen()`, `gruppeLoeschen()` und
 * `alleGruppen()` hatten null Aufrufer außerhalb von partnergruppen.mts — die
 * vier Adressen, die PartnerGruppenPanel.tsx aufruft (GET/POST
 * `/api/post/partnergruppen`, PATCH/DELETE `/api/post/partnergruppen/:id`),
 * waren in `http/routes.ts` nie registriert. Jeder Versuch, eine Gruppe
 * anzulegen, umzubenennen oder zu löschen, endete in einem 404 — verdeckt,
 * weil die Tafel bei jedem Fehler still auf die sieben eingebauten Chips
 * zurückfällt (`EINGEBAUTE_ALS_FALLBACK`, `anzahl: 0`). `partnergruppen.mts`
 * blieb dabei grün, weil es `gruppeErstellen()` & Co. immer schon direkt
 * aufrief, nie über `/api/...`.
 *
 * KEIN `app.listen()`, ABSICHTLICH
 * `e2e-nachruesten.mjs` (scripts/, das andere Beispiel für „Server im
 * Prüflauf") startet dafür einen echten Prozess auf einem FESTEN Port
 * (5211) — das prüft zusätzlich, ob der Prozess selbst hochkommt, kostet
 * dafür aber einen echten Netzwerkport plus den Start des kompletten
 * Servers (Übersetzungsdienst, Hintergrundtakte, Websocket, Startseite).
 * Für die Frage hier — „kennt der Router diese sechs Wege?" — reicht
 * Fastifys eigenes `inject()`: es durchläuft dieselbe Methode-/Weg-Zuordnung
 * wie ein echter Aufruf (`app.routing`), ohne je einen Port zu öffnen. Kein
 * Konflikt mit einem parallel laufenden Entwicklungsserver, kein fester
 * Port, den ein anderer Prüflauf gerade belegt — genau die Vorgabe, unter
 * der dieser Lauf entstand.
 *
 * `registerRoutes()` ist dieselbe Funktion, die `index.ts` beim echten
 * Start aufruft (importiert, nicht nachgebaut) — hier auf eine nackte
 * `Fastify()`-Instanz angewandt, ohne cors/multipart/websocket (die
 * betroffenen sechs Wege brauchen keins davon) und ohne `initDb()`s
 * Geschwister aus `index.ts` (Sitzungssaat, Modell-Warmlauf, Sprachdienst) —
 * die haben mit der Frage „ist die Route registriert?" nichts zu tun und
 * bräuchten Netz oder ein KI-Modell, das dieser Lauf nicht hat und nicht
 * braucht.
 *
 * DIE ERWARTETE LISTE KOMMT AUS DER OBERFLÄCHE SELBST
 * `routenAusOberflaeche()` liest PartnerGruppenPanel.tsx (nur LESEND — die
 * Datei gehört gerade einem anderen Auftrag) und findet jeden
 * `partnerFetch(...)`-Aufruf per Muster, statt eine von Hand gepflegte
 * Liste hier zu führen, die genau derselben Vergessenheit unterläge wie die
 * Routen selbst. Kommt in der Oberfläche morgen ein siebter Aufruf dazu,
 * nimmt dieser Lauf ihn automatisch mit — ohne dass hier etwas geändert
 * werden müsste.
 *
 * ZWEI STUFEN JE ROUTE
 *   1) REGISTRIERT? — jede aus der Oberfläche abgeleitete Route bekommt eine
 *      minimale Anfrage; ein „echtes" 404 (Fastifys eigener
 *      Nicht-gefunden-Antworttext, `error: 'Not Found'`, ohne `code`) zählt
 *      als fehlende Registrierung. Eine Antwort mit `code` — und sei es
 *      selbst ein 404 aus einem Dienst wie `fehler.nichtGefunden` — bedeutet:
 *      der Router hat die Anfrage an einen echten Wächter übergeben, es ist
 *      also registriert.
 *   2) FUNKTIONIERT RICHTIG? — von Hand geschriebene Anfragen mit echten
 *      Daten (anlegen → umbenennen → löschen, in dieser Reihenfolge, mit der
 *      `id` aus der vorherigen Antwort), damit eine Route, die zwar
 *      registriert ist, aber an die FALSCHE Dienstfunktion gebunden wurde,
 *      ebenfalls auffällt.
 *
 * Aufruf:  node scripts/partnergruppen-routen-pruefen.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { db, initDb } from '../db/index.js';
import { registerRoutes } from '../http/routes.js';
import { signToken } from '../auth.js';

initDb();

// Ein voll berechtigtes Konto, roh per SQL — dieselbe Machart wie
// rechte-eskalation.mts, kontoRoh(). 'owner' trägt laut
// @stellium/shared/permissions.ts ALLE Rechte (ROLE_DEFAULTS.owner =
// [...ALLE]), also auch `mail.lesen`/`mail.verwalten` — hier geht es um die
// Wegfindung des Routers, nicht um die Rechteschwelle je Route (die prüft
// rechte-eskalation.mts für die admin-Endpunkte, und `mail.verwalten` ist
// dieselbe Schwelle wie dort, nicht eigens hier nachgebildet).
db.run(
  `INSERT INTO users (id, handle, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
  'http-pruefer', 'http-pruefer', 'HTTP-Prüfer', 'x', 'owner', Date.now(),
);
const token = signToken('http-pruefer');

let fehler = 0;
const pruef = (name: string, ist: unknown, soll: unknown) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `  ${JSON.stringify(ist)} statt ${JSON.stringify(soll)}`}`);
};

/* ── Die echten Routen, ohne app.listen() ─────────────────────────── */

const app = Fastify({ logger: false });
await registerRoutes(app);

interface Antwort { statusCode: number; body: unknown; }

async function anfrage(method: string, pfad: string, payload?: unknown): Promise<Antwort> {
  const antwort = await app.inject({
    method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

/**
 * Fastifys eigener Nicht-gefunden-Antworttext für eine Adresse, die KEIN
 * Handler kennt: `{ statusCode: 404, error: 'Not Found', message: '...' }`,
 * OHNE `code` — jeder Fehler, den diese Anwendung selbst wirft (`fehler()`/
 * `weiterreichen()` in routes.ts), trägt dagegen immer ein `code`-Feld, auch
 * bei einem eigenen 404 wie `fehler.nichtGefunden`. Genau dieser Unterschied
 * ist die Probe: „hat der Router die Anfrage überhaupt an einen Handler
 * übergeben?", unabhängig davon, was der Handler danach entscheidet.
 */
function routeUnbekannt(antwort: Antwort): boolean {
  if (antwort.statusCode !== 404) return false;
  const b = antwort.body as { error?: string; code?: string } | undefined;
  return b?.error === 'Not Found' && !b?.code;
}

/* ── 1) Die erwartete Liste kommt aus der Oberfläche selbst ─────────── */
console.log('\n1) Erwartete Routen aus PartnerGruppenPanel.tsx ableiten');

interface ErwarteteRoute { method: string; pfad: string; }

function routenAusOberflaeche(quelltext: string): ErwarteteRoute[] {
  // Jeder Aufruf hat die Form `partnerFetch<Typ>(<Pfad>[, { ...Optionen }])`
  // — der Typparameter kann selbst geschweifte Klammern enthalten (`<{
  // gruppen: PartnerGruppeInfo[] }>`), deshalb `[^>]*` statt eines
  // Klammerpaar-Zählers: kein spitzes „>" kommt in diesen Typen vor.
  const aufrufRe = /partnerFetch<[^>]*>\(\s*(`[^`]*`|'[^']*')/g;
  const routen: ErwarteteRoute[] = [];
  let treffer: RegExpExecArray | null;
  while ((treffer = aufrufRe.exec(quelltext))) {
    // Bis zum Semikolon, das die `return partnerFetch(...)`-Anweisung
    // schließt, statt die Klammern selbst zu zählen (das Optionen-Objekt
    // enthält mit `JSON.stringify({ ... })` seinerseits geschachtelte
    // Klammern) — für den einzigen Zweck hier (das `method:`-Feld finden)
    // reicht der ganze Anweisungstext bis zum nächsten Semikolon.
    const semikolon = quelltext.indexOf(';', treffer.index);
    const anweisung = quelltext.slice(treffer.index, semikolon === -1 ? treffer.index + 400 : semikolon + 1);
    const methodTreffer = anweisung.match(/method:\s*'([A-Z]+)'/);
    const method = methodTreffer ? methodTreffer[1] : 'GET';

    const rohPfad = treffer[1].slice(1, -1); // Anführungszeichen/Backticks weg
    // Nur der Teil VOR der ersten `${...}`-Einsetzung ist statisch — der
    // reicht, um zwischen den sechs Adressen hier zu unterscheiden
    // (`/api/post/partner`, `/api/post/partner/gruppe`,
    // `/api/post/partnergruppen`, `/api/post/partnergruppen/:id`).
    const statischerTeil = rohPfad.split('${')[0];
    const hatId = rohPfad.includes('${encodeURIComponent(id)}');
    routen.push({ method, pfad: hatId ? `${statischerTeil}:id` : statischerTeil });
  }
  // Eindeutig machen — `gruppenHolen()` etc. könnten theoretisch mehrfach im
  // Quelltext aufgerufen werden, das wäre dieselbe Route, keine zusätzliche.
  const eindeutig = new Map<string, ErwarteteRoute>();
  for (const r of routen) eindeutig.set(`${r.method} ${r.pfad}`, r);
  return [...eindeutig.values()];
}

const panelPfad = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../desktop/src/components/PartnerGruppenPanel.tsx',
);
const panelQuelltext = fs.readFileSync(panelPfad, 'utf8');
const erwarteteRouten = routenAusOberflaeche(panelQuelltext);

// Kanarienvogel wie in rechte-eskalation.mts (ADMIN_OWNERONLY-Kommentar):
// keine feste Liste, aber eine Mindestzahl, die beweist, dass der Parser
// wirklich etwas gefunden hat und nicht nur ein leeres Ergebnis grün zeigt.
pruef('Sanity: der Parser findet mindestens die sechs bekannten Aufrufe', erwarteteRouten.length >= 6, true);
console.log(`  ${erwarteteRouten.map((r) => `${r.method} ${r.pfad}`).join('\n  ')}`);

/* ── 2) Jede abgeleitete Route ist registriert ───────────────────────
 * Minimale, generische Anfrage je Route — es geht hier NUR um „kennt der
 * Router diese Methode+Adresse", nicht um ein sinnvolles Ergebnis (das prüft
 * Abschnitt 3 mit echten Daten). `:id` wird durch einen Platzhalter ersetzt,
 * der als ID-Syntax gültig, aber garantiert keine echte Gruppe ist — für die
 * Wegfindung selbst spielt das keine Rolle (Fastify matcht `:id` gegen jeden
 * Wert), erst der Handler dahinter würde ihn ablehnen. */
console.log('\n2) Jede abgeleitete Route ist registriert (kein Fastify-eigenes 404)');

for (const route of erwarteteRouten) {
  const pfad = route.pfad.replace(':id', 'pg_nicht_vorhanden');
  const payload = route.method === 'GET' || route.method === 'DELETE' ? undefined : {};
  const antwort = await anfrage(route.method, pfad, payload);
  pruef(`${route.method} ${route.pfad} ist registriert`, routeUnbekannt(antwort), false);
}

/* ── 3) Der volle Weg mit echten Daten: anlegen → umbenennen → löschen ──
 * Registriert ist nicht dasselbe wie richtig verdrahtet — diese drei Schritte
 * laufen über EXAKT dieselbe `id`, die die vorherige Antwort geliefert hat,
 * genau wie PartnerGruppenPanel.tsx es tut (gruppeAnlegenApi() →
 * gruppeUmbenennenApi(aktiveBenutzerGruppe.id, ...) →
 * gruppeLoeschenApi(g.id)). */
console.log('\n3) Der volle Weg: anlegen, umbenennen, löschen — über HTTP');

const listeVorher = await anfrage('GET', '/api/post/partnergruppen');
pruef('GET /api/post/partnergruppen (vorher): 200', listeVorher.statusCode, 200);
const gruppenVorher = (listeVorher.body as { gruppen?: unknown[] })?.gruppen ?? [];
pruef('...liefert mindestens die sieben eingebauten Gruppen', gruppenVorher.length >= 7, true);

const angelegt = await anfrage('POST', '/api/post/partnergruppen', { name: 'HTTP-Prüfer Verein' });
pruef('POST /api/post/partnergruppen: 200', angelegt.statusCode, 200);
const neueGruppe = (angelegt.body as { gruppe?: { id: string; name: string; eingebaut: boolean } })?.gruppe;
pruef('...liefert eine benutzerdefinierte Gruppe mit dem eingegebenen Namen',
  neueGruppe && !neueGruppe.eingebaut && neueGruppe.name, 'HTTP-Prüfer Verein');

const doppelt = await anfrage('POST', '/api/post/partnergruppen', { name: 'http-prüfer verein' });
pruef('...derselbe Name (Groß-/Kleinschreibung) wird über HTTP mit 400 abgewiesen', doppelt.statusCode, 400);
pruef('...mit der Kennung aus dem Dienst, nicht neu erfunden',
  (doppelt.body as { code?: string })?.code, 'fehler.gruppeNameVergeben');

const id = neueGruppe!.id;
const umbenannt = await anfrage('PATCH', `/api/post/partnergruppen/${id}`, { name: 'HTTP-Prüfer Verein Süd' });
pruef('PATCH /api/post/partnergruppen/:id: 200', umbenannt.statusCode, 200);
pruef('...der neue Name kommt wirklich an',
  (umbenannt.body as { gruppe?: { name: string } })?.gruppe?.name, 'HTTP-Prüfer Verein Süd');

const umbenennenEingebaut = await anfrage('PATCH', '/api/post/partnergruppen/kunden', { name: 'Käufer' });
pruef('...eine eingebaute Gruppe lässt sich über HTTP nicht umbenennen', umbenennenEingebaut.statusCode, 400);
pruef('...mit der Kennung aus dem Dienst', (umbenennenEingebaut.body as { code?: string })?.code, 'fehler.gruppeEingebaut');

const geloescht = await anfrage('DELETE', `/api/post/partnergruppen/${id}`);
pruef('DELETE /api/post/partnergruppen/:id: 200', geloescht.statusCode, 200);
pruef('...meldet 0 betroffene Briefpartner (die Gruppe hatte keine Mitglieder)',
  (geloescht.body as { betroffenePartner?: number })?.betroffenePartner, 0);

const listeNachher = await anfrage('GET', '/api/post/partnergruppen');
const gruppenNachher = (listeNachher.body as { gruppen?: { id: string }[] })?.gruppen ?? [];
pruef('...die gelöschte Gruppe steht nicht mehr in der Liste', gruppenNachher.some((g) => g.id === id), false);

/* Die beiden ursprünglichen Routen — /api/post/partner (lesen) und
   /api/post/partner/gruppe (eine Gruppe setzen) — liefen schon vor diesem
   Fund; hier nur eine kurze Gegenprobe, dass sie über exakt denselben
   registrierten Router weiterhin antworten, keine zweite Instanz. */
const partnerListe = await anfrage('GET', '/api/post/partner');
pruef('GET /api/post/partner: 200', partnerListe.statusCode, 200);

console.log(fehler
  ? `\n\x1b[31m${fehler} fehlgeschlagen\x1b[0m\n`
  : '\n\x1b[32mAlle Adressen, die PartnerGruppenPanel.tsx aufruft, sind registriert und richtig verdrahtet.\x1b[0m\n');
process.exit(fehler ? 1 : 0);
