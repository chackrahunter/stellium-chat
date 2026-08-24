#!/usr/bin/env node
/**
 * Prüft die WERTE der 22 Wörterbücher in packages/desktop/src/i18n/ auf
 * inhaltliche Stimmigkeit — nicht auf Vollständigkeit.
 *
 * WARUM ES DIESE PRÜFUNG BRAUCHT
 * Zwei Läufe bewachten die Wörterbücher bisher, und beide sehen die Werte nie an:
 *   · scripts/sprachen-vollstaendig.mjs vergleicht nur SCHLÜSSELMENGEN. Ein
 *     spanischer Satz, der behauptet „du schreibst hier auf Deutsch", hat
 *     denselben Schlüssel wie das Original und fällt dort nie auf.
 *   · scripts/woerterbuecher-erzeugen.mjs lässt bestehende Einträge bewusst in
 *     Ruhe (sonst überschriebe jeder Lauf jede Handkorrektur). Genau deshalb
 *     überlebte die Abweichung jede Neuerzeugung.
 *
 * Vier Fehlerklassen, alle real vorgekommen:
 *   1 SPRACHNENNUNG   Eine Übersetzung nennt eine feste Menschensprache, wo die
 *                     deutsche Vorlage keine nennt. Der Klassiker: „Escribes
 *                     aquí en alemán" — ein spanischer Kollege liest, er
 *                     schreibe auf Deutsch. Die eigene Sprache ist ein
 *                     Laufzeitwert, kein Wörterbuchtext.
 *   2 DEUTSCHES KÜRZEL  Ein deutsches Kürzel steht unübersetzt in einem
 *                     fremden Wörterbuch — „KI" (Künstliche Intelligenz) in
 *                     polnischen, niederländischen, dänischen Sätzen.
 *   3 VARIANTENPAAR   Beide Seiten eines bekannten Varianten-Paars stehen in
 *                     derselben Datei: pt.ts hatte „Ficheiros" (Portugal) und
 *                     „Arquivos" (Brasilien) nebeneinander, dazu utilizador/
 *                     usuário, ecrã/tela, telemóvel/celular.
 *   4 ANREDE          Geduzt und gesiezt in einer Datei. ru/uk/fr/pt brachen
 *                     alle auf DEMSELBEN Schlüsselsatz aus (fehler.keinRecht,
 *                     fehler.anmeldungFehlgeschlagen, vorschlaege.subtitle,
 *                     ai.privateHint) — dort folgte der Übersetzer dem
 *                     deutschen „du", während der Rest der Datei siezte.
 *
 * WAS SIE ABSICHTLICH NICHT KANN
 * Keine dieser Regeln ist Sprachverständnis. Sie erkennt Wörter, keine
 * Grammatik: ein Imperativ ohne Pronomen („Wybierz…") verrät seine Anrede
 * nicht, eine gebeugte Sprachbezeichnung nur, soweit der Stamm trägt, und
 * Sprachen ohne Höflichkeitsform (da, no, sv, fi, ja, ko, zh, tr, hi, ar) sind
 * von Regel 4 gar nicht erfasst. Das Ziel ist nicht Vollständigkeit, sondern
 * dass GENAU DIESE vier Defekte nicht unbemerkt zurückkommen.
 *
 * RATCHET
 * Ein sauberes Null ist heute nicht erreichbar — Regel 1 und 4 leben von
 * Stammvergleichen und finden auch Sätze, die guter Stil sind. Darum je Datei
 * und Regel ein hinterlegter Stand in scripts/stimmigkeit-schwelle.json: die
 * Zahl darf sinken, ein Anstieg ist ein Hardstop. Eine Prüfung, die vom ersten
 * Tag an grün sein MUSS, wird von der nächsten Person entschärft statt erfüllt.
 *
 *   node scripts/woerterbuecher-stimmigkeit-pruefen.mjs
 *   node scripts/woerterbuecher-stimmigkeit-pruefen.mjs --schwelle-aktualisieren
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const I18N_DIR = path.join(REPO, 'packages/desktop/src/i18n');
const SCHWELLE_DATEI = path.join(REPO, 'scripts/stimmigkeit-schwelle.json');
const AKTUALISIEREN = process.argv.includes('--schwelle-aktualisieren');

const QUELLE = 'de';
const SPRACHEN = ['ar', 'cs', 'da', 'de', 'en', 'es', 'fi', 'fr', 'hi', 'it', 'ja', 'ko',
  'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'tr', 'uk', 'zh'];

/** Zeilen der Form   'schlüssel': 'wert',   mit Zeilennummer. */
function woerterbuchLesen(datei) {
  const text = fs.readFileSync(datei, 'utf8');
  const eintraege = new Map();
  text.split('\n').forEach((zeile, i) => {
    const m = zeile.match(/^\s+'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*$/);
    if (!m) return;
    const roh = (m[2] ?? m[3] ?? '')
      .replace(/\\n/g, '\n').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    eintraege.set(m[1], { wert: roh, zeile: i + 1 });
  });
  return eintraege;
}

const wb = new Map();
for (const code of SPRACHEN) wb.set(code, woerterbuchLesen(path.join(I18N_DIR, `${code}.ts`)));

const funde = [];
function melden(regel, code, zeile, schluessel, text) {
  funde.push({ regel, datei: `packages/desktop/src/i18n/${code}.ts`, zeile, schluessel, text });
}

/* ────────────────────────────────────────────────────────────────────────
 * REGEL 1 — Sprachnennung
 *
 * Die Namen der 22 Sprachen IN JEDER der 22 Sprachen kommen aus
 * Intl.DisplayNames, nicht aus einer 22×22-Tabelle von Hand: die Namen kennt
 * die Laufzeit längst (dieselbe Quelle, aus der i18n/kern.ts sprachName()
 * speist), und eine neue Oberflächensprache erweitert die Prüfung damit von
 * selbst.
 *
 * Gebeugte Formen („po niemiecku", „по‑русски", „saksaksi") träfe der reine
 * Nominativ nicht. Darum wird bei Namen über sechs Zeichen der Stamm ohne die
 * letzten beiden Zeichen gesucht — „niemiecki" → „niemieck" trifft auch
 * „niemiecku". Kürzere Namen bleiben unangetastet, sonst würde der Stamm zu
 * kurz und träfe Zufälliges.
 * ──────────────────────────────────────────────────────────────────────── */
const OHNE_WORTGRENZE = new Set(['ja', 'ko', 'zh', 'hi', 'ar', 'th']);
/** Schriften ohne Wortzwischenraum schreiben Sprachnamen sehr kurz („\u5fb7\u8a9e",
 *  „\ub3c5\uc77c\uc5b4"). Überall sonst wären zwei bis drei Zeichen als Stamm eine
 *  Zufallsmaschine: die Hindi-Bezeichnung für Tschechisch ist „\u091a\u0947\u0915" und steckt in
 *  jedem „\u091a\u0947\u0915\u0938\u092e" (Prüfsumme) — fünf Fehlalarme aus einem einzigen zu kurzen
 *  Stamm. Darum mindestens vier Zeichen, außer in CJK. */
const CJK = new Set(['ja', 'ko', 'zh']);

/* Gestammt wird nur in Latein und Kyrillisch. Dort ist ein Zeichen ein
   Zeichen, und dort trägt der Stamm die Beugung („niemiecki" → „niemieck"
   trifft „niemiecku"). In Devanagari, Arabisch und CJK zählt .length
   Kombinationszeichen mit: die Hindi-Bezeichnung für Französisch, फ़्रेंच,
   schrumpfte auf einen Rest, der in रीफ़्रेश (refresh) steckt. Diese Schriften
   beugen Sprachnamen ohnehin kaum — dort gilt der volle Name. */
const STAMMBAR = /^[\p{Script=Latin}\p{Script=Cyrillic}\s'’-]+$/u;

function stamm(name) {
  return name.length > 6 && STAMMBAR.test(name) ? name.slice(0, name.length - 2) : name;
}

function sprachStaemme(inSprache) {
  let anzeige;
  try {
    anzeige = new Intl.DisplayNames([inSprache], { type: 'language' });
  } catch {
    return [];
  }
  const mindestens = CJK.has(inSprache) ? 2 : 4;
  const raus = [];
  for (const code of SPRACHEN) {
    let name;
    try { name = anzeige.of(code); } catch { continue; }
    if (!name || name === code) continue;
    const s = stamm(name).toLocaleLowerCase(inSprache);
    if (s.length < mindestens) continue;
    raus.push(s);
  }
  return [...new Set(raus)];
}

const STAEMME = new Map(SPRACHEN.map((c) => [c, sprachStaemme(c)]));

function nenntSprache(text, code) {
  const klein = text.toLocaleLowerCase(code);
  return STAEMME.get(code).some((s) => {
    if (OHNE_WORTGRENZE.has(code)) return klein.includes(s);
    const i = klein.indexOf(s);
    if (i < 0) return false;
    // Kein Buchstabe unmittelbar davor — „Alemán" ja, „Salemán" nein.
    return !/\p{L}/u.test(klein[i - 1] ?? '');
  });
}

for (const [schluessel, deEintrag] of wb.get(QUELLE)) {
  if (nenntSprache(deEintrag.wert, QUELLE)) continue; // Vorlage nennt selbst eine — dann ist es Absicht.
  for (const code of SPRACHEN) {
    if (code === QUELLE) continue;
    const e = wb.get(code).get(schluessel);
    if (!e) continue;
    if (nenntSprache(e.wert, code)) melden('SPRACHNENNUNG', code, e.zeile, schluessel, e.wert);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * REGEL 2 — deutsches Kürzel in fremdem Wörterbuch
 *
 * „KI" ist in no.ts KEIN Fehler: kunstig intelligens heißt auf Norwegisch
 * tatsächlich KI, das ist die vom Språkrådet empfohlene Form. Eine mechanische
 * Regel darf eine richtige Übersetzung nicht kaputtmachen — deshalb steht die
 * Ausnahme hier und nicht als Notlösung in no.ts.
 * ──────────────────────────────────────────────────────────────────────── */
const KUERZEL = [
  { wort: 'KI', ausser: new Set(['no']), warum: 'Künstliche Intelligenz — anderswo AI/IA/ШІ/ИИ' },
  { wort: 'bzw.', ausser: new Set(), warum: 'beziehungsweise' },
  { wort: 'ggf.', ausser: new Set(), warum: 'gegebenenfalls' },
  { wort: 'usw.', ausser: new Set(), warum: 'und so weiter' },
  { wort: 'd. h.', ausser: new Set(), warum: 'das heißt' },
  { wort: 'z. B.', ausser: new Set(), warum: 'zum Beispiel' },
];

for (const code of SPRACHEN) {
  if (code === QUELLE) continue;
  for (const [schluessel, e] of wb.get(code)) {
    for (const k of KUERZEL) {
      if (k.ausser.has(code)) continue;
      const muster = new RegExp(`(?<!\\p{L})${k.wort.replace(/[.]/g, '\\.')}(?!\\p{L})`, 'u');
      if (muster.test(e.wert)) {
        melden('DEUTSCHES-KUERZEL', code, e.zeile, schluessel, `„${k.wort}" (${k.warum}) — ${e.wert}`);
        break;
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * REGEL 3 — beide Seiten eines Varianten-Paars in einer Datei
 *
 * pt.ts ist als blankes „pt" registriert (i18n/kern.ts) — es gibt kein
 * pt-PT und kein pt-BR. Eine Datei kann also nur EINE Variante führen. Gemeldet
 * wird erst, wenn beide Seiten vorkommen: eine Datei, die durchgehend
 * „ficheiro" sagt, ist stimmig, auch wenn hier Brasilien gewählt wurde.
 * ──────────────────────────────────────────────────────────────────────── */
const PAARE = [
  { code: 'pt', a: 'ficheiro', b: 'arquivo', worum: 'Datei (PT/BR)' },
  { code: 'pt', a: 'utilizador', b: 'usuário', worum: 'Benutzer (PT/BR)' },
  { code: 'pt', a: 'ecrã', b: 'tela', worum: 'Bildschirm (PT/BR)' },
  { code: 'pt', a: 'telemóvel', b: 'celular', worum: 'Mobiltelefon (PT/BR)' },
  { code: 'pt', a: 'palavra-passe', b: 'senha', worum: 'Passwort (PT/BR)' },
  { code: 'pt', a: 'equipa', b: 'equipe', worum: 'Team (PT/BR)' },
  { code: 'pt', a: 'partilhar', b: 'compartilhar', worum: 'teilen (PT/BR)' },
  { code: 'en', a: 'colour', b: 'color', worum: 'Farbe (GB/US)' },
  { code: 'en', a: 'organise', b: 'organize', worum: 'organisieren (GB/US)' },
  { code: 'es', a: 'ordenador', b: 'computadora', worum: 'Rechner (ES/LatAm)' },
  { code: 'zh', a: '軟體', b: '软件', worum: 'Software (traditionell/vereinfacht)' },
];

for (const p of PAARE) {
  const dict = wb.get(p.code);
  if (!dict) continue;
  const trefferA = [];
  const trefferB = [];
  for (const [schluessel, e] of dict) {
    const klein = e.wert.toLocaleLowerCase(p.code);
    // „compartilhar" enthält „partilhar" — die längere Seite gewinnt.
    const hatB = klein.includes(p.b);
    const hatA = klein.includes(p.a) && !(p.b.includes(p.a) && !klein.replace(new RegExp(p.b, 'g'), '').includes(p.a));
    if (hatA) trefferA.push({ schluessel, ...e });
    if (hatB) trefferB.push({ schluessel, ...e });
  }
  if (!trefferA.length || !trefferB.length) continue;
  // Die kleinere Seite ist die Abweichung — sie wird einzeln gemeldet.
  const minderheit = trefferA.length <= trefferB.length ? trefferA : trefferB;
  const wort = trefferA.length <= trefferB.length ? p.a : p.b;
  const andere = trefferA.length <= trefferB.length ? p.b : p.a;
  for (const t of minderheit) {
    melden('VARIANTENPAAR', p.code, t.zeile, t.schluessel,
      `${p.worum}: „${wort}" hier, „${andere}" im Rest der Datei — ${t.wert}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * REGEL 4 — gemischte Anrede
 *
 * Nur für Sprachen mit echter Höflichkeitsform und nur an Pronomen und
 * Possessiva festgemacht. Welche Anrede eine Datei führt, wird nicht
 * vorgeschrieben, sondern gezählt: die Mehrheit gilt, die Minderheit wird
 * gemeldet. Französische und deutsche Höflichkeitsnormen sind nicht dieselbe
 * Frage — eine Datei darf sich von den anderen unterscheiden, nur nicht von
 * sich selbst.
 * ──────────────────────────────────────────────────────────────────────── */
const ANREDE = {
  de: { du: /(?<!\p{L})(du|dich|dir|dein\w*)(?!\p{L})/iu, sie: /(?<!\p{L})(Sie|Ihnen|Ihre[nmrs]?)(?!\p{L})/u },
  fr: { du: /(?<!\p{L})(tu|ton|ta|tes|toi)(?!\p{L})/iu, sie: /(?<!\p{L})(vous|votre|vos)(?!\p{L})/iu },
  es: { du: /(?<!\p{L})(tú|tus|contigo|tienes|puedes|tuyo|tuya)(?!\p{L})/iu, sie: /(?<!\p{L})(usted|ustedes)(?!\p{L})/iu },
  pt: { du: /(?<!\p{L})(tu|teu|tua|teus|tuas|contigo|tens|podes|fazes)(?!\p{L})/iu, sie: /(?<!\p{L})(você|vocês)(?!\p{L})/iu },
  nl: { du: /(?<!\p{L})(je|jij|jouw|jou)(?!\p{L})/iu, sie: /(?<!\p{L})(uw|U)(?!\p{L})/u },
  it: { du: /(?<!\p{L})(tu|tuo|tua|tuoi|tue)(?!\p{L})/iu, sie: /(?<!\p{L})(Lei|Suo|Sua|vostro)(?!\p{L})/u },
  pl: { du: /(?<!\p{L})(ty|ci|cię|ciebie|twój|twoja|twoje|twoim|twojego)(?!\p{L})/iu, sie: /(?<!\p{L})(Pan|Pani|Państw\w*)(?!\p{L})/u },
  cs: { du: /(?<!\p{L})(ty|tebe|tobě|tvůj|tvoje|tvá|tvé|tvým)(?!\p{L})/iu, sie: /(?<!\p{L})(vy|vás|vám|váš|vaše|vašem)(?!\p{L})/iu },
  ru: { du: /(?<!\p{L})(ты|тебя|тебе|тобой|тво[йяёеиём]\w*)(?!\p{L})/iu, sie: /(?<!\p{L})(вы|вас|вам|вами|ваш\w*)(?!\p{L})/iu },
  uk: { du: /(?<!\p{L})(ти|тебе|тобі|тобою|тв[ій|оя|оє|ої]\w*)(?!\p{L})/iu, sie: /(?<!\p{L})(ви|вас|вам|вами|ваш\w*)(?!\p{L})/iu },
};

/* Deutsch: großgeschriebenes „Sie" ist MITTEN im Satz die Anrede, am
   Satzanfang aber genauso gut das gewöhnliche Personalpronomen — „Sie weicht
   um {sekunden} Sekunden ab" meint die Uhr, nicht die Leserin. Ohne diese
   Ausnahme meldete die Regel genau solche Sätze als gesiezt. */
function vorbehandeln(code, text) {
  if (code !== 'de') return text;
  return text.replace(/(^|[.!?…:—–]\s+|\n)Sie(?=\s)/g, '$1sie');
}

for (const [code, muster] of Object.entries(ANREDE)) {
  const dict = wb.get(code);
  if (!dict) continue;
  const duZeilen = [];
  const sieZeilen = [];
  for (const [schluessel, e] of dict) {
    const wert = vorbehandeln(code, e.wert);
    const hatDu = muster.du.test(wert);
    const hatSie = muster.sie.test(wert);
    if (hatDu && !hatSie) duZeilen.push({ schluessel, ...e });
    else if (hatSie && !hatDu) sieZeilen.push({ schluessel, ...e });
  }
  if (!duZeilen.length || !sieZeilen.length) continue;
  const minderheit = duZeilen.length <= sieZeilen.length ? duZeilen : sieZeilen;
  const form = duZeilen.length <= sieZeilen.length ? 'geduzt' : 'gesiezt';
  const mehrheit = form === 'geduzt' ? 'gesiezt' : 'geduzt';
  for (const t of minderheit) {
    melden('ANREDE', code, t.zeile, t.schluessel,
      `${form}, die Datei ist sonst ${mehrheit} (${Math.max(duZeilen.length, sieZeilen.length)}:${minderheit.length}) — ${t.wert}`);
  }
}

/* ───────────────────────────── Ausgabe ───────────────────────────── */
const REGELN = ['SPRACHNENNUNG', 'DEUTSCHES-KUERZEL', 'VARIANTENPAAR', 'ANREDE'];
funde.sort((a, b) => REGELN.indexOf(a.regel) - REGELN.indexOf(b.regel)
  || a.datei.localeCompare(b.datei) || a.zeile - b.zeile);

for (const regel of REGELN) {
  const dieser = funde.filter((f) => f.regel === regel);
  console.log(`\n${'─'.repeat(60)}\n${regel} — ${dieser.length} Fund(e)\n${'─'.repeat(60)}`);
  for (const f of dieser) {
    console.log(`  ${f.datei}:${f.zeile}  ${f.schluessel}`);
    console.log(`      ${f.text.replace(/\n/g, ' ')}`);
  }
  if (!dieser.length) console.log('  (nichts)');
}

/** Stand je Datei UND Regel — ein neuer Fund in ar.ts darf sich nicht hinter
 *  einer Reparatur in pt.ts verstecken, und ein neuer ANREDE-Fund nicht hinter
 *  einer behobenen SPRACHNENNUNG. */
const jetzt = {};
for (const f of funde) {
  const schl = `${f.datei}|${f.regel}`;
  jetzt[schl] = (jetzt[schl] ?? 0) + 1;
}

function schwelleLesen() {
  if (!fs.existsSync(SCHWELLE_DATEI)) return null;
  try { return JSON.parse(fs.readFileSync(SCHWELLE_DATEI, 'utf8')); } catch { return null; }
}

function schwelleSchreiben(stand) {
  fs.writeFileSync(SCHWELLE_DATEI, `${JSON.stringify({
    __hinweis: [
      'Wird von scripts/woerterbuecher-stimmigkeit-pruefen.mjs gelesen und mit',
      '--schwelle-aktualisieren geschrieben. Zaehlt Funde je Datei UND Regel, nicht global —',
      'ein neuer Fund in ar.ts darf sich nicht hinter einer Reparatur in pt.ts verstecken.',
      'Darf je Eintrag nur sinken; ein Anstieg ist im Gate ein Hardstop.',
    ],
    erzeugtAm: new Date().toISOString().slice(0, 10),
    stellen: Object.fromEntries(Object.entries(stand).sort(([a], [b]) => a.localeCompare(b))),
  }, null, 2)}\n`);
}

console.log(`\n${'═'.repeat(60)}\nSCHWELLE (scripts/stimmigkeit-schwelle.json) — Ratchet\n${'═'.repeat(60)}`);
const gesamt = funde.length;
const schwelle = schwelleLesen();

if (AKTUALISIEREN) {
  const alt = schwelle ? Object.values(schwelle.stellen).reduce((a, b) => a + b, 0) : Infinity;
  if (schwelle && gesamt > alt) {
    console.log(`\n✗ --schwelle-aktualisieren schreibt keinen Anstieg (${alt} → ${gesamt}).`);
    console.log('  Erst die neuen Funde beheben. Eine Erhöhung geht nur per Hand-Edit der Datei.');
    process.exit(1);
  }
  schwelleSchreiben(jetzt);
  console.log(`\n✓ Stand geschrieben: ${gesamt} Fund(e) über ${Object.keys(jetzt).length} Stelle(n).`);
  process.exit(0);
}

if (!schwelle) {
  console.log(`\n✗ Keine Schwelle hinterlegt (${path.relative(REPO, SCHWELLE_DATEI)} fehlt).`);
  console.log('  Einmalig anlegen: node scripts/woerterbuecher-stimmigkeit-pruefen.mjs --schwelle-aktualisieren');
  process.exit(1);
}

const stellen = new Set([...Object.keys(schwelle.stellen), ...Object.keys(jetzt)]);
const schlechter = [];
const besser = [];
for (const stelle of [...stellen].sort()) {
  const alt = schwelle.stellen[stelle] ?? 0;
  const neu = jetzt[stelle] ?? 0;
  if (neu > alt) schlechter.push(`${stelle}: ${alt} → ${neu}`);
  else if (neu < alt) besser.push(`${stelle}: ${alt} → ${neu}`);
}

const altGesamt = Object.values(schwelle.stellen).reduce((a, b) => a + b, 0);
console.log(`\nGesamt erlaubt: ${altGesamt}   Gesamt jetzt: ${gesamt}`);
if (besser.length) {
  console.log(`\n✓ ${besser.length} Stelle(n) besser geworden:`);
  for (const z of besser) console.log(`    ${z}`);
  console.log('  Danach einmal --schwelle-aktualisieren, sonst hält der neue Stand nicht.');
}
if (schlechter.length) {
  console.log(`\n✗ SCHWELLE ÜBERSCHRITTEN — ${schlechter.length} Stelle(n) über dem hinterlegten Stand:`);
  for (const z of schlechter) console.log(`    ${z}`);
  process.exit(1);
}
console.log('\n✓ Innerhalb der Schwelle — keine Stelle über ihrem hinterlegten Stand.');
process.exit(0);
