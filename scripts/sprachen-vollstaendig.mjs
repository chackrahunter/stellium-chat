/**
 * Hat wirklich jede Sprache jeden Eintrag?
 *
 * Deutsch ist die Vorlage. Fehlt anderswo ein Schlüssel, fällt die Oberfläche
 * dort auf Deutsch zurück — und genau das sieht man als Nutzer: eine englische
 * Ansicht mit deutschen Brocken darin.
 */
import fs from 'node:fs';
import path from 'node:path';

const ordner = 'packages/desktop/src/i18n';
const schluessel = (datei) => {
  const roh = fs.readFileSync(path.join(ordner, datei), 'utf8');
  return new Set([...roh.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
};

const vorlage = schluessel('de.ts');
const sprachen = fs.readdirSync(ordner)
  .filter((d) => /^[a-z]{2}\.ts$/.test(d) && d !== 'de.ts')
  .sort();

let luecken = 0;
console.log(`Vorlage: ${vorlage.size} Einträge in de.ts\n`);
for (const datei of sprachen) {
  const hat = schluessel(datei);
  const fehlt = [...vorlage].filter((k) => !hat.has(k));
  const zuviel = [...hat].filter((k) => !vorlage.has(k));
  luecken += fehlt.length;
  const marke = fehlt.length ? '✗' : '✓';
  console.log(`  ${marke} ${datei.replace('.ts', '')}  ${hat.size} Einträge`
    + (fehlt.length ? `  — ${fehlt.length} fehlen: ${fehlt.slice(0, 4).join(', ')}${fehlt.length > 4 ? ' …' : ''}` : '')
    + (zuviel.length ? `  (${zuviel.length} unbekannt)` : ''));
}
console.log(`\n${luecken === 0 ? 'Alle Sprachen vollständig.' : `${luecken} fehlende Einträge insgesamt.`}`);
process.exit(luecken ? 1 : 0);
