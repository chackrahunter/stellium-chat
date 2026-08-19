/**
 * Englisch ist Vorlage wie Deutsch — der Generator füllt es deshalb nicht.
 * Fehlende Schlüssel werden hier einzeln nachgeholt.
 */
import fs from 'node:fs';

const SCHLUESSEL = process.env.GROQ_API_KEY ?? '';
if (!SCHLUESSEL) { console.error('GROQ_API_KEY fehlt.'); process.exit(1); }

const lies = (f) => fs.readFileSync(`packages/desktop/src/i18n/${f}.ts`, 'utf8');
const schluessel = (inhalt) => [...inhalt.matchAll(/^\s*'([a-zA-Z0-9._]+)':\s*'((?:[^'\\]|\\.)*)'/gm)]
  .map((m) => [m[1], m[2]]);

const de = schluessel(lies('de'));
const en = new Map(schluessel(lies('en')));
const fehlend = de.filter(([k]) => !en.has(k));

if (!fehlend.length) { console.log('Englisch ist vollständig.'); process.exit(0); }
console.log(`${fehlend.length} Einträge fehlen auf Englisch.`);

/* In Stapeln: alles auf einmal sprengt das Antwortbudget, und ein
   abgeschnittenes JSON ist unbrauchbar. */
const STAPEL = 30;
const uebersetzt = {};

for (let i = 0; i < fehlend.length; i += STAPEL) {
  const teil = fehlend.slice(i, i + STAPEL);
  const antwort = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SCHLUESSEL}` },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      temperature: 0.2,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Übersetze die Oberflächentexte einer Chat-App ins Englische.',
            'Kurz und alltäglich, wie in Slack oder Teams — keine Behördensprache.',
            'Platzhalter in geschweiften Klammern bleiben unverändert stehen.',
            'Antworte als JSON: {"<schlüssel>": "<englischer Text>"}',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify(Object.fromEntries(teil)) },
      ],
    }),
  });
  const daten = await antwort.json();
  if (!antwort.ok) { console.error(daten.error ?? daten); process.exit(1); }
  try {
    Object.assign(uebersetzt, JSON.parse(daten.choices[0].message.content));
    process.stdout.write(`  ${Object.keys(uebersetzt).length}/${fehlend.length}\r`);
  } catch {
    console.error(`\nStapel ab ${i} unlesbar — übersprungen`);
  }
}

let inhalt = lies('en');
const stelle = inhalt.lastIndexOf('};');
const zeilen = fehlend
  .filter(([k]) => uebersetzt[k])
  .map(([k]) => `  '${k}': '${String(uebersetzt[k]).replace(/'/g, "\\'")}',\n`)
  .join('');
fs.writeFileSync('packages/desktop/src/i18n/en.ts', inhalt.slice(0, stelle) + zeilen + inhalt.slice(stelle));
console.log(`\n${zeilen.split('\n').length - 1} Einträge ergänzt.`);
