#!/usr/bin/env node
/**
 * Erzeugt die Wörterbücher der Oberfläche für alle Sprachen, in die Stellium
 * auch Nachrichten übersetzt.
 *
 *   node scripts/woerterbuecher-erzeugen.mjs           alle fehlenden
 *   node scripts/woerterbuecher-erzeugen.mjs fr es     nur diese
 *   node scripts/woerterbuecher-erzeugen.mjs --alle    auch bestehende neu
 *   node scripts/woerterbuecher-erzeugen.mjs --neue     nur fehlende Einträge
 *
 * Das Ergebnis sind feste Dateien, keine Aufrufe zur Laufzeit: die Oberfläche
 * muss sofort da sein, auch ohne Netz, und darf nichts kosten.
 *
 * Deutsch ist die Vorlage, Englisch die Zweitmeinung — beide werden mitgegeben,
 * damit das Modell bei mehrdeutigen Wörtern ("Kanal", "Stand") die im
 * Programmzusammenhang richtige Lesart trifft.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i18n = path.join(wurzel, 'packages/desktop/src/i18n');

const F = { aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m', gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', blau: '\x1b[38;5;111m' };
const sag = (t = '') => process.stdout.write(`${t}\n`);
const raus = (t) => { sag(`\n${F.rot}✗ ${t}${F.aus}\n`); process.exit(1); };

/* ── Vorlagen einlesen ───────────────────────────────────────── */

function woerterbuchLesen(datei) {
  const text = fs.readFileSync(datei, 'utf8');
  const eintraege = {};
  // Zeilen der Form   'schlüssel': 'wert',
  const muster = /^\s{2}'([^']+)':\s*'((?:[^'\\]|\\.)*)',\s*$/gm;
  let treffer;
  while ((treffer = muster.exec(text))) {
    eintraege[treffer[1]] = treffer[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }

  /* Der Zähler oben versteht nur einfach gequotete Werte in genau zwei
     Leerzeichen Einrückung. Alles andere — doppelte Anführungszeichen,
     Backticks, eine andere Einrückung — hält er für nicht vorhanden, und
     weil weiter unten aus den gelesenen Schlüsseln die ganze Datei neu
     geschrieben wird, verschwindet es dann wirklich. Genau so sind in einer
     Sitzung 53 Einträge abhandengekommen.

     Deshalb wird gegengezählt: wie viele Zeilen sehen überhaupt nach einem
     Eintrag aus? Weichen die Zahlen ab, versteht der Parser diese Datei
     nicht vollständig, und dann darf niemand auf seiner Grundlage schreiben. */
  const sieht_nach_eintrag_aus = (text.match(/^\s+(?:'[^']+'|"[^"]+"|[A-Za-z_$][\w$]*)\s*:/gm) ?? []).length;
  if (sieht_nach_eintrag_aus > Object.keys(eintraege).length) {
    throw new Error(
      `${path.basename(datei)}: ${sieht_nach_eintrag_aus} Einträge stehen in der Datei, `
      + `verstanden wurden nur ${Object.keys(eintraege).length}.\n`
      + '  Auf dieser Grundlage neu zu schreiben würde die übrigen löschen.\n'
      + "  Ursache ist fast immer ein Wert in doppelten Anführungszeichen — der Parser kennt nur einfache.",
    );
  }
  return eintraege;
}

const de = woerterbuchLesen(path.join(i18n, 'de.ts'));
const en = woerterbuchLesen(path.join(i18n, 'en.ts'));
const schluessel = Object.keys(de);
sag(`${F.blau}${F.fett}▸ Vorlage${F.aus}  ${schluessel.length} Einträge auf Deutsch, ${Object.keys(en).length} auf Englisch`);

/* ── Zielsprachen ────────────────────────────────────────────── */

const { LANGUAGES } = await import(path.join(wurzel, 'packages/shared/dist/languages.js'));
const args = process.argv.slice(2);
const alleNeu = args.includes('--alle');
const nurNeue = args.includes('--neue');
const gewuenscht = args.filter((a) => !a.startsWith('--'));

const ziele = LANGUAGES
  .filter((l) => l.code !== 'de' && l.code !== 'en')
  .filter((l) => (gewuenscht.length ? gewuenscht.includes(l.code) : true))
  .filter((l) => alleNeu || nurNeue || !fs.existsSync(path.join(i18n, `${l.code}.ts`)));

if (!ziele.length) { sag(`${F.grau}Nichts zu tun.${F.aus}`); process.exit(0); }
sag(`${F.blau}${F.fett}▸ Ziele${F.aus}    ${ziele.map((l) => l.code).join(', ')}`);

/* ── Modell ──────────────────────────────────────────────────── */

const schluesselDatei = process.env.GROQ_API_KEY ?? await groqSchluesselAusTresor();
if (!schluesselDatei) raus('Kein Groq-Schlüssel. GROQ_API_KEY setzen oder den Tresor bereitstellen.');

async function groqSchluesselAusTresor() {
  try {
    const { Vault, resolvePassphrase } = await import(path.join(wurzel, 'packages/server/dist/secrets.js'));
    const pass = resolvePassphrase();
    if (!pass) return null;
    const tresor = new Vault(path.join(wurzel, 'packages/server/data/secrets.enc'));
    return tresor.exists() ? tresor.load(pass.passphrase).groq ?? null : null;
  } catch { return null; }
}

const MODELL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
const BUENDEL = 40;

async function uebersetzeBuendel(sprache, teil) {
  const vorlage = teil.map((k) => ({ k, de: de[k], en: en[k] ?? null }));

  const antwort = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${schluesselDatei}` },
    body: JSON.stringify({
      model: MODELL,
      temperature: 0.1,
      max_completion_tokens: 8000,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            `Du übersetzt die Oberfläche einer Team-Chat-App nach ${sprache.native} (${sprache.code}).`,
            'Vorgegeben sind deutscher und englischer Text zum selben Schlüssel — nimm beide als Grundlage.',
            '',
            'Regeln:',
            '· Platzhalter in geschweiften Klammern bleiben unverändert: {version}, {n}, {name}, {shortcut}.',
            '· Der Ton ist knapp und freundlich, wie in guter Software — keine Beamtensprache.',
            '· Fachbegriffe der Oberfläche einheitlich halten: derselbe Begriff, wo dieselbe Sache gemeint ist.',
            '· Produktnamen bleiben: Stellium, StelliumAI, Groq, DuckDNS.',
            '· Länge im Rahmen halten — die Texte stehen in Knöpfen und schmalen Spalten.',
            '· Typografische Anführungszeichen und Gedankenstriche der Zielsprache verwenden.',
            '',
            'Antworte als JSON: {"<schlüssel>": "<übersetzung>", …} — jeder vorgelegte Schlüssel genau einmal.',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(vorlage) },
      ],
    }),
  });

  if (!antwort.ok) throw new Error(`${antwort.status} ${(await antwort.text()).slice(0, 160)}`);
  const daten = await antwort.json();
  return JSON.parse(daten.choices[0].message.content);
}

/* ── Schreiben ───────────────────────────────────────────────── */

function alsDatei(sprache, eintraege) {
  const zeilen = [
    `/** Oberfläche auf ${sprache.native}.`,
    ' *',
    ' *  Erzeugt mit scripts/woerterbuecher-erzeugen.mjs aus der deutschen',
    ' *  Vorlage. Handkorrekturen sind willkommen — beim nächsten Lauf werden',
    ' *  nur fehlende Sprachen angefasst, bestehende bleiben unberührt.',
    ' */',
    'export const ' + sprache.code + ' = {',
  ];
  for (const k of schluessel) {
    const wert = (eintraege[k] ?? en[k] ?? de[k]).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    zeilen.push(`  '${k}': '${wert}',`);
  }
  zeilen.push('};', '');
  return zeilen.join('\n');
}

for (const sprache of ziele) {
  process.stdout.write(`  ${F.grau}${sprache.code} ${sprache.native}${F.aus} `);

  // Bestehendes behalten und nur ergänzen: eine Sprache noch einmal komplett
  // durchs Modell zu schicken kostet Zeit und macht Handkorrekturen zunichte.
  const vorhanden = fs.existsSync(path.join(i18n, `${sprache.code}.ts`))
    ? woerterbuchLesen(path.join(i18n, `${sprache.code}.ts`))
    : {};
  const ergebnis = { ...vorhanden };
  let nichtUebersetzt = 0;
  const zuTun = nurNeue ? schluessel.filter((k) => !vorhanden[k]) : schluessel;

  if (!zuTun.length) { sag(` ${F.grau}nichts zu tun${F.aus}`); continue; }

  for (let i = 0; i < zuTun.length; i += BUENDEL) {
    const teil = zuTun.slice(i, i + BUENDEL);
    let versuch = 0;
    for (;;) {
      try {
        Object.assign(ergebnis, await uebersetzeBuendel(sprache, teil));
        process.stdout.write('.');
        break;
      } catch (err) {
        versuch += 1;
        /* `fehlend` gab es nie — der Zähler war ein Tippfehler und warf im
           Fehlerpfad einen ReferenceError. Der trat nur auf, wenn die
           Übersetzung dreimal hintereinander scheiterte, also genau dann, wenn
           man eine brauchbare Fehlermeldung am nötigsten braucht. Jetzt wird
           gezählt, was nicht durchkam, und am Ende genannt. */
        if (versuch >= 3) {
          process.stdout.write(`${F.rot}×${F.aus}`);
          nichtUebersetzt += teil.length;
          break;
        }
        await new Promise((r) => setTimeout(r, 1500 * versuch));
      }
    }
  }

  const fehlt = schluessel.filter((k) => !ergebnis[k]).length;
  if (nichtUebersetzt) {
    console.error(`\n  ${sprache.code}: ${nichtUebersetzt} Einträge kamen nach drei Anläufen nicht durch.`);
  }
  /* Letzter Riegel vor dem Schreiben. `alsDatei` schreibt ausschließlich die
     Schlüssel aus `schluessel` — also die von de.ts. Trägt die Zielsprache
     etwas, das de.ts nicht (mehr) hat, fiele es beim Schreiben lautlos weg.
     Ein Werkzeug, das Arbeit vernichtet, während es „Sprachen ergänzen" sagt,
     ist schlimmer als eins, das gar nichts tut. Also: lieber abbrechen. */
  const kaeme_weg = Object.keys(vorhanden).filter((k) => !schluessel.includes(k));
  if (kaeme_weg.length) {
    console.error(
      `\n  ${sprache.code}.ts: ${kaeme_weg.length} Einträge würden beim Schreiben verschwinden,\n`
      + `  weil de.ts sie nicht hat: ${kaeme_weg.slice(0, 8).join(', ')}`
      + `${kaeme_weg.length > 8 ? ` … und ${kaeme_weg.length - 8} weitere` : ''}\n`
      + '  Abgebrochen — nichts geschrieben. Entweder gehören sie nach de.ts,\n'
      + '  oder sie sind Reste und müssen gezielt entfernt werden.',
    );
    process.exitCode = 1;
    break;
  }

  fs.writeFileSync(path.join(i18n, `${sprache.code}.ts`), alsDatei(sprache, ergebnis));
  sag(` ${F.gruen}✓${F.aus} ${schluessel.length - fehlt}/${schluessel.length}${fehlt ? ` ${F.grau}(${fehlt} auf Englisch belassen)${F.aus}` : ''}`);
}

sag(`\n${F.gruen}${F.fett}Fertig.${F.aus} Jetzt noch  ${F.fett}node scripts/woerterbuecher-einbinden.mjs${F.aus}\n`);
