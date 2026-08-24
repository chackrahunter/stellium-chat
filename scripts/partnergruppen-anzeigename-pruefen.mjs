#!/usr/bin/env node
/**
 * Prüft `kollidiertMitEingebautemAnzeigenamen()`
 * (packages/desktop/src/lib/partnergruppen-name.ts) OHNE Browser/React: die
 * freundliche, sprachbewusste Vorwarnung, die verhindert, dass eine
 * benutzerdefinierte Gruppe optisch mit einem eingebauten Chip zusammenfällt.
 *
 * DER FEHLER, DEN DAS FÄNGT
 *
 * `gruppenNamePruefen()` auf dem Server (post-partnergruppen.ts) vergleicht
 * einen vorgeschlagenen Namen nur gegen die festen KENNUNGEN
 * (`PARTNER_GRUPPEN`: 'kunden', 'behoerden', …), nicht gegen ihre ÜBERSETZTEN
 * Anzeigenamen — mit Absicht, siehe Funktionskopf dort. Für Deutsch trifft
 * die serverseitige Prüfung trotzdem meistens, weil die Kennung zufällig wie
 * der deutsche Anzeigename aussieht ("kunden" ~ "Kunden") — in den anderen 21
 * Sprachen trifft sie NIE, weil dort ein ganz anderes Wort auf dem
 * eingebauten Chip steht ("clients", "customers", "clientes", …). Diese
 * Prüfung hier schließt die Lücke auf der Oberfläche, sprachbewusst, in
 * JEDER der 22 Sprachen — die serverseitige Kennungsprüfung bleibt daneben
 * unverändert die letzte, verbindliche Instanz (siehe dort).
 *
 * WARUM KEIN REACT/DOM
 * `kollidiertMitEingebautemAnzeigenamen()` nimmt `t()` als Parameter statt
 * `useT()` selbst aufzurufen — genau wie `textKiNachTextaenderung()`
 * (post-schreiben-entwurf.ts) erspart das diesem Prüflauf, React, den Store
 * oder ein CSS-Modul mitzuladen. `translate()` aus i18n/kern.ts reicht: es
 * ist die reine, zustandsfreie Übersetzungsfunktion, dieselbe, die
 * `useT()` innen benutzt.
 *
 * DREI GRUPPEN VON SZENARIEN
 *   1. Für JEDE der 22 Sprachen und JEDE der 7 eingebauten Gruppen: der
 *      tatsächlich angezeigte Name kollidiert mit sich selbst — das ist der
 *      eigentliche Fang, weil es für 21 der 22 Sprachen mit der alten,
 *      kennungsbasierten Prüfung nie zugetroffen hätte. WICHTIG: der
 *      Erwartungswert kommt aus `rohesWort()` (i18n/kern.ts) — einem
 *      unabhängigen, rückfallfreien Blick in GENAU dieses eine Wörterbuch —
 *      und NICHT aus einem zweiten Aufruf von `translate()`. Ein zweiter
 *      `translate()`-Aufruf mit denselben Argumenten wäre eine reine
 *      Selbstprobe: er stimmte auch dann noch mit dem ersten überein, wenn
 *      das Wörterbuch den Schlüssel gar nicht trägt, weil `translate()`s
 *      Rückfallkette (Deutsch, dann der rohe Schlüssel) auf beiden Seiten
 *      gleichermaßen greift — und hielte damit für jede Sprache, in der ein
 *      Schlüssel fehlt, GENAUSO grün wie für eine, in der er wirklich
 *      übersetzt ist. `rohesWort()` unterscheidet das: fehlt der Schlüssel,
 *      liefert es `undefined`, nicht denselben Text wie `translate()`.
 *   2. Gegenprobe je Sprache: ein Name, der mit NICHTS eingebautem etwas zu
 *      tun hat, kollidiert nicht — sonst wäre die Prüfung nur noch lauter,
 *      nicht mehr treffsicher.
 *   3. Robustheit: Groß-/Kleinschreibung und mehrfacher/umgebender
 *      Leerraum spielen keine Rolle (dieselbe Normalisierung wie
 *      `gruppenNamePruefen()` auf dem Server: trim + Leerraum zusammenziehen
 *      + Kleinschreibung).
 *
 * Aufruf:  node scripts/partnergruppen-anzeigename-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulPfad = path.join(wurzel, 'packages/desktop/src/lib/partnergruppen-name.ts');
const kernPfad = path.join(wurzel, 'packages/desktop/src/i18n/kern.ts');
// Direkt aus der Quelldatei, nicht über den Paketnamen @stellium/shared --
// derselbe Grund wie bei modulPfad/kernPfad: die generierte Probe liegt
// außerhalb jedes Arbeitsbaums, ein Paketname wäre von dort aus nicht ohne
// Weiteres aufzulösen, ein Dateipfad schon.
const sharedPfad = path.join(wurzel, 'packages/shared/src/types.ts');
const desktopPaket = path.join(wurzel, 'packages/desktop');

for (const p of [modulPfad, kernPfad, sharedPfad]) {
  if (!fs.existsSync(p)) {
    console.error(`Nicht gefunden: ${p}`);
    process.exit(1);
  }
}

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-partnergruppen-anzeigename-'));
let fehler = 0;
try {
  const probeDatei = path.join(ordner, 'probe.mts');
  fs.writeFileSync(
    probeDatei,
    `import { kollidiertMitEingebautemAnzeigenamen as kollidiert } from ${JSON.stringify(pathToFileUrlLiteral(modulPfad))};
import { translate, rohesWort, UI_LANGUAGES } from ${JSON.stringify(pathToFileUrlLiteral(kernPfad))};
import { PARTNER_GRUPPEN } from ${JSON.stringify(pathToFileUrlLiteral(sharedPfad))};

let fehler = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(\`  \${ok ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\${ok ? '' : \`  \${JSON.stringify(ist)} statt \${JSON.stringify(soll)}\`}\`);
};

if (UI_LANGUAGES.length < 22) {
  console.log(\`  \\x1b[31m✗\\x1b[0m UI_LANGUAGES hat nur \${UI_LANGUAGES.length} Sprachen -- Auftrag verlangt 22\`);
  fehler++;
}
if (PARTNER_GRUPPEN.length < 7) {
  console.log(\`  \\x1b[31m✗\\x1b[0m PARTNER_GRUPPEN hat nur \${PARTNER_GRUPPEN.length} Gruppen -- erwartet 7\`);
  fehler++;
}

// Szenario 1 + 3: für JEDE Sprache und JEDE eingebaute Gruppe kollidiert der
// tatsächlich angezeigte Name mit sich selbst -- der eigentliche Fang, siehe
// Dateikopf. Der Erwartungswert kommt aus rohesWort() -- einem unabhängigen,
// rückfallfreien Blick in GENAU dieses eine Wörterbuch, NICHT aus einem
// zweiten translate()-Aufruf (der wäre eine reine Selbstprobe, siehe
// Dateikopf). Fehlt der Schlüssel im Wörterbuch, ist das hier ein eigener,
// lauter Fund -- keine still bestehende Kollisionsprobe mit sich selbst.
for (const { code } of UI_LANGUAGES) {
  for (const id of PARTNER_GRUPPEN) {
    const key = \`partnerGruppen.gruppe.\${id}\`;
    const eigen = rohesWort(code, key);
    pruef(\`[\${code}] "\${id}" hat einen echten, sprachspezifischen Anzeigenamen im Wörterbuch (kein fehlender Schlüssel)\`,
      typeof eigen === 'string' && eigen.trim() !== '', true);
    if (typeof eigen !== 'string' || eigen.trim() === '') continue; // s.o. -- schon gemeldet, kein Folgefehler hinterher

    const angezeigt = translate(code, key);
    pruef(\`[\${code}] translate() liefert für "\${id}" GENAU den unabhängig gelesenen Wörterbuch-Eintrag\`,
      angezeigt, eigen);

    const t = (k) => translate(code, k);
    pruef(\`[\${code}] Anzeigename von "\${id}" ("\${angezeigt}") kollidiert mit sich selbst\`,
      kollidiert(angezeigt, t), true);
    // Groß-/Kleinschreibung und umgebender Leerraum spielen keine Rolle --
    // dieselbe Normalisierung wie gruppenNamePruefen() auf dem Server.
    pruef(\`[\${code}] "\${id}" GROSS/leer drumherum kollidiert ebenso\`,
      kollidiert(\`  \${angezeigt.toUpperCase()}  \`, t), true);
  }
}

// Szenario 2: Gegenprobe je Sprache -- ein Name ohne jeden Bezug zu einer
// eingebauten Gruppe kollidiert NICHT, sonst wäre die Prüfung nur lauter,
// nicht treffsicherer.
for (const { code } of UI_LANGUAGES) {
  const t = (key) => translate(code, key);
  pruef(\`[\${code}] unabhängiger Name kollidiert nicht\`,
    kollidiert('Projektpartner Nord', t), false);
}

// Leerer/nur-Leerraum-Name: keine Kollision (nichts zum Vergleichen), keine
// falsch-positive Meldung für ein Feld, das ohnehin schon durch die
// Pflichtfeld-Prüfung fällt.
pruef('leerer Name kollidiert nicht', kollidiert('   ', (key) => translate('de', key)), false);

console.log(fehler ? \`\\x1b[31m\${fehler} fehlgeschlagen\\x1b[0m\` : '\\x1b[32mok\\x1b[0m');
process.exit(fehler ? 1 : 0);
`,
  );

  execFileSync('npx', ['tsx', probeDatei], { cwd: desktopPaket, stdio: 'inherit' });
} catch {
  fehler += 1;
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}

console.log(fehler
  ? '\n\x1b[31mAnzeigenamen-Kollisionsprüfung verletzt\x1b[0m\n'
  : '\n\x1b[32mDie Kollisionsprüfung greift in allen 22 Oberflächensprachen gegen den tatsächlich angezeigten'
    + ' Namen einer eingebauten Gruppe, nicht nur zufällig in Deutsch — und bleibt daneben still, wo kein'
    + ' Bezug zu einer eingebauten Gruppe besteht.\x1b[0m\n');
process.exit(fehler ? 1 : 0);

/** file://-URL als Literal für die generierte Probedatei — Windows-Backslashes eingeschlossen. */
function pathToFileUrlLiteral(p) {
  return `file://${p.replace(/\\/g, '/')}`;
}
