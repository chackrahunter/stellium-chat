/**
 * Hat wirklich jede Sprache jeden Eintrag?
 *
 * Deutsch ist die Vorlage. Fehlt anderswo ein Schlüssel, fällt die Oberfläche
 * dort auf Deutsch zurück — und genau das sieht man als Nutzer: eine englische
 * Ansicht mit deutschen Brocken darin.
 *
 * ZWEITE FRAGE, und die ist wichtiger: hat die Vorlage selbst alles?
 *
 * Der Vergleich der 21 Sprachen gegen de.ts allein ist blind für den
 * schlimmsten Fall. Werden alle 22 Dateien im selben Lauf aus derselben
 * beschädigten Vorlage erzeugt, sind sie hinterher einträchtig unvollständig
 * — und diese Prüfung meldete „Alle Sprachen vollständig", während in der
 * Oberfläche die rohen Schlüssel standen. Genau so ist es passiert.
 *
 * Deshalb wird zusätzlich gegen den Code gemessen: jeder Schlüssel, den
 * t('…') irgendwo anfordert, muss in de.ts stehen. Das ist die einzige
 * Vorlage, die nicht mit den Wörterbüchern zusammen kaputtgehen kann.
 */
import fs from 'node:fs';
import path from 'node:path';

const ordner = 'packages/desktop/src/i18n';
const quelle = 'packages/desktop/src';

const schluessel = (datei) => {
  const roh = fs.readFileSync(path.join(ordner, datei), 'utf8');
  return new Set([...roh.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]));
};

/* Was der Code tatsächlich anfordert. Gesucht wird nur die Form mit
   unmittelbarer Zeichenkette — t(variable) lässt sich von außen nicht
   auflösen und wird bewusst nicht geraten. */
function angeforderte() {
  const gefunden = new Map(); // Schlüssel → wo zuerst gesehen
  const durchgehen = (verzeichnis) => {
    for (const eintrag of fs.readdirSync(verzeichnis, { withFileTypes: true })) {
      const voll = path.join(verzeichnis, eintrag.name);
      if (eintrag.isDirectory()) {
        if (voll.includes('/i18n')) continue; // die Wörterbücher selbst nicht
        durchgehen(voll);
      } else if (/\.tsx?$/.test(eintrag.name)) {
        const text = fs.readFileSync(voll, 'utf8');
        for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) {
          if (!gefunden.has(m[1])) gefunden.set(m[1], path.relative(quelle, voll));
        }
      }
    }
  };
  durchgehen(quelle);
  return gefunden;
}

const vorlage = schluessel('de.ts');
const sprachen = fs.readdirSync(ordner)
  .filter((d) => /^[a-z]{2}\.ts$/.test(d) && d !== 'de.ts')
  .sort();

let luecken = 0;

/* ── Zuerst die Vorlage gegen den Code ───────────────────────── */

const gebraucht = angeforderte();
const fehlenInVorlage = [...gebraucht].filter(([k]) => !vorlage.has(k));

console.log(`Vorlage: ${vorlage.size} Einträge in de.ts · ${gebraucht.size} Schlüssel im Code angefordert\n`);

if (fehlenInVorlage.length) {
  console.log(`  ✗ de.ts fehlen ${fehlenInVorlage.length} Schlüssel, die der Code anfordert:`);
  for (const [k, wo] of fehlenInVorlage.slice(0, 25)) console.log(`      ${k}   ${wo}`);
  if (fehlenInVorlage.length > 25) console.log(`      … und ${fehlenInVorlage.length - 25} weitere`);
  console.log('');
  luecken += fehlenInVorlage.length;
}

/* ── Dann die übrigen Sprachen gegen die Vorlage ─────────────── */

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

console.log(`\n${luecken === 0 ? 'Alle Sprachen vollständig — und die Vorlage deckt den Code.' : `${luecken} fehlende Einträge insgesamt.`}`);
process.exit(luecken ? 1 : 0);
