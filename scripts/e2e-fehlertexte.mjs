/**
 * Kommen Fehlermeldungen in der eingestellten Sprache an?
 *
 * Der Server antwortet auf Deutsch und legt eine Kennung bei. Die Oberfläche
 * sucht die Kennung im Wörterbuch und zeigt ihren eigenen Satz; der deutsche
 * Text ist nur der Rückfall. Fehlt die Kennung oder ihr Eintrag, sieht jeder
 * Mensch Deutsch — egal was er eingestellt hat.
 *
 * WAS DIESE PRÜFUNG FRÜHER FALSCH MASS
 * Bis hierher stand in dieser Datei eine von Hand gepflegte Liste von
 * Kennungen, und geprüft wurde nur, dass es sie im Wörterbuch gibt. Sie war
 * grün, während der Gateway `vertraulich` schickte und im Wörterbuch
 * `fehler.vertraulich` stand — die eine Seite der Lücke wurde gemessen und
 * das Ergebnis für das Ganze gehalten. Jede WebSocket-Meldung erschien auf
 * Deutsch, und keine Prüfung sagte etwas.
 *
 * Deshalb kommen die Kennungen jetzt aus dem Quelltext, nicht aus einer
 * Liste, und geprüft wird in beide Richtungen:
 *
 *   → geschickt, aber kein Eintrag   = Fehler. Jemand liest Deutsch.
 *   ← Eintrag, aber kein Absender     = Hinweis. Wahrscheinlich eine tote
 *                                       Zeile, vielleicht auch ein Umbau,
 *                                       der die Kennung nicht mitgezogen hat.
 *
 * Eingesammelt wird über die Namensform: ein Zeichenkettenliteral, das mit
 * `fehler.` oder `hinweis.` beginnt, ist eine Kennung. Das ist die
 * Verabredung im Code, und sie ist eng genug, dass nichts anderes
 * hineinrutscht — anders als bei einer Liste kann sie nicht veralten.
 *
 * ZWEI WEITERE LÜCKEN, GESCHLOSSEN
 *
 * Eingesammelt wurde bis hierher über eine Regex auf dem rohen Dateitext —
 * die kennt keinen Unterschied zwischen Code und Kommentar. Eine Kennung,
 * die nur zur Erklärung in Anführungszeichen in einem Kommentar stand (z. B.
 * 'fehler.keinRechtName' als Beispiel im Fließtext in http/routes.ts, oder
 * 'fehler.loginFalsch' in net/api.ts), zählte als verschickt bzw. benutzt.
 * `packages/server/src/index.ts` umging das bis hierher von Hand — die
 * Kennung `fehler.einrichtungOffen` steht dort ABSICHTLICH ohne
 * Anführungszeichen (siehe die Erklärung an der Stelle). Jetzt läuft die
 * Suche über den echten Syntaxbaum (`typescript`, derselbe Weg wie in
 * scripts/deutsch-finden.mjs — Grund dort im Dateikopf): Kommentare werden
 * nie als Knoten gebaut, ein Zeichenkettenliteral kann also nie aus einem
 * Kommentar stammen. Den Umweg in index.ts braucht deshalb niemand mehr.
 *
 * Zweitens: sechs Kennungen aus http/posteingang.ts (dem eingehenden
 * Cloudflare-Worker-Webhook, den nie ein Mensch liest) galten als
 * verschickt und fehlten zu Recht in keinem Wörterbuch — die Prüfung schlug
 * trotzdem an, weil sie scripts/deutsch-ausnahmen.mjs nie befragte, obwohl
 * genau diese Stelle dort bereits mit Begründung eingetragen ist. Dieses
 * Skript importiert jetzt dieselbe Ausnahmeliste (STELLEN), statt eine
 * zweite zu führen — eine neue Ausnahme dort gilt automatisch auch hier.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { probeserver } from './probeserver.mjs';
import { STELLEN as AUSNAHME_STELLEN, pruefeAusnahmen } from './deutsch-ausnahmen.mjs';

// Wirft laut beim Start, wenn dort ein Eintrag ohne Grund steht — dieselbe
// Wache wie in deutsch-finden.mjs, hier noch einmal, weil dieses Skript ein
// eigener Prozess ist und die Liste nicht ungeprüft übernehmen soll.
pruefeAusnahmen();

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/* ── Kennungen einsammeln ────────────────────────────────────── */

const KENNUNG_MUSTER = /^(?:fehler|hinweis)\.[A-Za-z][A-Za-z0-9]*$/;
const I18N = 'packages/desktop/src/i18n';

function dateien(ordner, endung = /\.tsx?$/) {
  const raus = [];
  for (const name of readdirSync(ordner)) {
    const pfad = join(ordner, name);
    if (statSync(pfad).isDirectory()) raus.push(...dateien(pfad, endung));
    else if (endung.test(name)) raus.push(pfad);
  }
  return raus;
}

/**
 * Dieselbe Abgleich-Regel wie ausgenommeneStelle() in deutsch-finden.mjs (dort
 * nicht exportiert, deshalb hier nachgebaut) — aber auf AUSNAHME_STELLEN aus
 * genau derselben Datei, nicht auf einer zweiten Liste: ein Ordnereintrag
 * endet auf "/**" und gilt als Präfix für alles darunter; eine Datei ohne
 * `zeile` gilt ganz, mit `zeile` nur für genau diese eine Zeile.
 */
function ausgenommen(dateiRel, zeile) {
  return AUSNAHME_STELLEN.some((e) => {
    const ordnerWeit = e.datei.endsWith('/**');
    const praefix = ordnerWeit ? e.datei.slice(0, -2) : e.datei;
    const dateiPasst = ordnerWeit ? dateiRel.startsWith(praefix) : dateiRel === e.datei;
    if (!dateiPasst) return false;
    return e.zeile === undefined || e.zeile === zeile;
  });
}

/**
 * Kennungen in genau einer Datei, samt Zeile — über den echten Syntaxbaum,
 * nicht über eine Regex auf dem rohen Dateitext. Ein Kommentar wird nie als
 * Knoten gebaut, ein Zeichenkettenliteral kann also nie aus einem Kommentar
 * stammen (siehe Dateikopf). `.tsx`-Dateien im TSX-Modus, `.ts`-Dateien im
 * TS-Modus — genau die Aufteilung, die scripts/deutsch-finden.mjs schon
 * vormacht (pruefeClientArtigeDatei() vs. pruefeServerDatei()): der
 * TSX-Modus liest `<Foo>bar` als JSX statt als den alten Typ-Cast, den
 * reines TypeScript im Server-Baum durchaus benutzen könnte.
 */
function kennungenInDatei(pfad) {
  const inhalt = readFileSync(pfad, 'utf8');
  const art = pfad.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const quelle = ts.createSourceFile(pfad, inhalt, ts.ScriptTarget.Latest, true, art);
  const treffer = [];
  const gehe = (knoten) => {
    if ((ts.isStringLiteral(knoten) || ts.isNoSubstitutionTemplateLiteral(knoten))
        && KENNUNG_MUSTER.test(knoten.text)) {
      const zeile = quelle.getLineAndCharacterOfPosition(knoten.getStart(quelle)).line + 1;
      treffer.push({ kennung: knoten.text, zeile });
    }
    ts.forEachChild(knoten, gehe);
  };
  ts.forEachChild(quelle, gehe);
  return treffer;
}

/** Alle Kennungen in einem Baum, samt Fundstelle. Eine Stelle, die
    scripts/deutsch-ausnahmen.mjs mit Begründung ausnimmt (Server-zu-Server-
    Wege, die nie ein Mensch liest), zählt hier nicht als Absender. */
function kennungenIn(wurzel, ueberspringen = () => false) {
  const gefunden = new Map();
  for (const pfad of dateien(wurzel)) {
    if (ueberspringen(pfad)) continue;
    for (const { kennung, zeile } of kennungenInDatei(pfad)) {
      if (ausgenommen(pfad, zeile)) continue;
      if (!gefunden.has(kennung)) gefunden.set(kennung, pfad);
    }
  }
  return gefunden;
}

const geschickt = kennungenIn('packages/server/src');
const imClient = kennungenIn('packages/desktop/src', (p) => p.includes('/i18n/'));

const sprachen = readdirSync(I18N).filter((d) => /^[a-z]{2}\.ts$/.test(d));
const woerterbuecher = new Map(sprachen.map((d) => {
  const inhalt = readFileSync(join(I18N, d), 'utf8');
  return [d.slice(0, 2), new Set([...inhalt.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]))];
}));

console.log('\nKennungen aus dem Quelltext gegen die Wörterbücher');

await pruefe('Der Server schickt überhaupt Kennungen', async () => {
  muss(geschickt.size > 20, `nur ${geschickt.size} gefunden — sammelt die Prüfung noch richtig ein?`);
  return `${geschickt.size} aus dem Server, ${imClient.size} aus der Oberfläche`;
});

await pruefe('Jede geschickte Kennung steht im deutschen Wörterbuch', async () => {
  const de = woerterbuecher.get('de');
  const fehlend = [...geschickt].filter(([k]) => !de.has(k));
  muss(fehlend.length === 0,
    `${fehlend.length} ohne Eintrag: ${fehlend.slice(0, 4).map(([k, p]) => `${k} (${p.replace('packages/server/src/', '')})`).join(', ')}`);
  return `${geschickt.size} Kennungen`;
});

await pruefe('Jede Kennung hat einen Text in allen 22 Sprachen', async () => {
  const alle = new Set([...geschickt.keys(), ...imClient.keys()]);
  const fehlend = [];
  for (const [sprache, eintraege] of woerterbuecher) {
    for (const k of alle) if (!eintraege.has(k)) fehlend.push(`${sprache}:${k}`);
  }
  muss(fehlend.length === 0, `${fehlend.length} fehlen, z. B. ${fehlend[0]}`);
  return `${alle.size} Kennungen × ${woerterbuecher.size} Sprachen`;
});

await pruefe('Platzhalter sind in jeder Sprache dieselben', async () => {
  const de = readFileSync(join(I18N, 'de.ts'), 'utf8');
  const platzhalter = (inhalt, k) => {
    const zeile = inhalt.match(new RegExp(`^\\s*'${k.replace('.', '\\.')}': '(.*)',$`, 'm'));
    return zeile ? [...zeile[1].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',') : null;
  };
  const schief = [];
  let verglichen = 0;
  /* Einmal lesen statt je Kennung und Sprache: sonst wird dieselbe Datei
     hundertfach von der Platte geholt. */
  const inhalte = new Map(sprachen.filter((s) => s !== 'de.ts')
    .map((s) => [s, readFileSync(join(I18N, s), 'utf8')]));
  for (const k of geschickt.keys()) {
    const soll = platzhalter(de, k);
    if (soll === null) continue;         // die Kennung steht nicht in de.ts
    if (!soll) continue;                 // ohne Platzhalter gibt es nichts zu vergleichen
    for (const [sprache, inhalt] of inhalte) {
      const ist = platzhalter(inhalt, k);
      if (ist === null) continue;
      verglichen += 1;
      if (ist !== soll) schief.push(`${sprache}:${k} „${ist}" statt „${soll}"`);
    }
  }
  /* Ohne diese Zeile konnte die Prüfung nichts messen und trotzdem bestehen:
     greift der Ausdruck oben nicht mehr — eine andere Schreibweise im
     Wörterbuch genügt dafür —, ist `soll` überall null, die Schleife läuft
     leer, `schief` bleibt leer, und es steht ein Häkchen da. */
  muss(verglichen > 0,
    'kein einziger Platzhalter verglichen — der Ausdruck greift nicht mehr auf die Wörterbücher');
  muss(schief.length === 0, `${schief.length} weichen ab, z. B. ${schief[0]}`);
  return `${verglichen} Vergleiche`;
});

/* Die andere Richtung. Sie lässt die Prüfung nicht durchfallen: ein Eintrag
   ohne Absender tut niemandem weh, er ist nur wahrscheinlich überflüssig. */
const de = woerterbuecher.get('de');
const ohneAbsender = [...de].filter((k) => /^(fehler|hinweis)\./.test(k)
  && !geschickt.has(k) && !imClient.has(k));
if (ohneAbsender.length) {
  console.log(`\n  ℹ ${ohneAbsender.length} Einträge ohne Absender — schickt sie noch jemand?`);
  for (const k of ohneAbsender) console.log(`      ${k}`);
}

/* ── Am laufenden Server ─────────────────────────────────────── */

const probe = await probeserver();
const S = probe.S;
const holen = async (pfad, rumpf) => {
  const antwort = await fetch(`${S}${pfad}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rumpf ?? {}),
  });
  return { status: antwort.status, ...(await antwort.json().catch(() => ({}))) };
};

console.log('\nDer laufende Server legt die Kennung wirklich bei');

await pruefe('Falsches Passwort', async () => {
  const a = await holen('/api/auth/login', { login: 'niemand', password: 'falsch' });
  muss(a.status === 401, `Status ${a.status}`);
  muss(a.code === 'fehler.loginFalsch', `Kennung fehlt (${a.code ?? 'keine'})`);
  return a.code;
});

await pruefe('Zugangsdaten fehlen', async () => {
  const a = await holen('/api/auth/login', {});
  muss(a.code === 'fehler.zugangsdatenFehlen', `Kennung fehlt (${a.code ?? 'keine'})`);
});

await pruefe('Selbstanmeldung gibt es nicht', async () => {
  const a = await holen('/api/auth/register', {});
  muss(a.code === 'fehler.keineSelbstanmeldung', `Kennung fehlt (${a.code ?? 'keine'})`);
});

await pruefe('Der deutsche Text bleibt als Rückfall stehen', async () => {
  const a = await holen('/api/auth/login', { login: 'niemand', password: 'falsch' });
  muss(typeof a.error === 'string' && a.error.length > 5, 'kein Text dabei');
  return `„${a.error}"`;
});

/* Die Ereignisleitung ist der Weg, auf dem die Meldungen bisher ungefiltert
   deutsch ankamen. Deshalb hier ausdrücklich: Kennung, Rückfalltext und —
   wo die Meldung Platzhalter hat — die Werte dazu. */
await pruefe('Auch über die Ereignisleitung kommt eine Kennung', async () => {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`${S.replace('http', 'ws')}/ws`);
  const meldung = await new Promise((fertig, schief) => {
    const uhr = setTimeout(() => schief(new Error('keine Antwort in 8 s')), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token: 'unsinn', protocol: 1 })));
    ws.on('message', (roh) => {
      const ev = JSON.parse(roh.toString());
      if (ev.t !== 'error') return;
      clearTimeout(uhr); ws.close(); fertig(ev);
    });
    ws.on('error', (e) => { clearTimeout(uhr); schief(e); });
  });
  muss(/^fehler\./.test(meldung.code ?? ''), `Kennung ist „${meldung.code}" — keine aus dem Wörterbuch`);
  muss(woerterbuecher.get('de').has(meldung.code), `„${meldung.code}" fehlt im Wörterbuch`);
  muss(typeof meldung.message === 'string' && meldung.message.length > 3, 'kein Rückfalltext dabei');
  return meldung.code;
});

await probe.stop();
const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
