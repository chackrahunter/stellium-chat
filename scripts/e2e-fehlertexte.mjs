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
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { probeserver } from './probeserver.mjs';

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/* ── Kennungen einsammeln ────────────────────────────────────── */

const KENNUNG = /'((?:fehler|hinweis)\.[A-Za-z][A-Za-z0-9]*)'/g;
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

/** Alle Kennungen in einem Baum, samt Fundstelle. */
function kennungenIn(wurzel, ueberspringen = () => false) {
  const gefunden = new Map();
  for (const pfad of dateien(wurzel)) {
    if (ueberspringen(pfad)) continue;
    const inhalt = readFileSync(pfad, 'utf8');
    for (const [, kennung] of inhalt.matchAll(KENNUNG)) {
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
  for (const k of geschickt.keys()) {
    const soll = platzhalter(de, k);
    if (!soll) continue;
    for (const sprache of sprachen) {
      if (sprache === 'de.ts') continue;
      const ist = platzhalter(readFileSync(join(I18N, sprache), 'utf8'), k);
      if (ist !== null && ist !== soll) schief.push(`${sprache}:${k} „${ist}" statt „${soll}"`);
    }
  }
  muss(schief.length === 0, `${schief.length} weichen ab, z. B. ${schief[0]}`);
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
