/**
 * Zwei Fragen an die Geräte-Schicht, beide aus echten Fehlern entstanden.
 *
 * 1. LÖSCHT IRGENDWO EINE KURZSCHREIBWEISE EINEN SICHERHEITSABSTAND?
 *
 *    `padding: 0 8px` setzt ALLE VIER Seiten. Steht der Sicherheitsabstand
 *    woanders, ist er damit still weg — und die Höhe bleibt trotzdem erhöht,
 *    weshalb der Inhalt unter der Statusleiste sitzt. In Safari fällt das
 *    nie auf (env() ist dort 0), sichtbar wird es erst in der App vom
 *    Startbildschirm. Genau so ist es dreimal passiert: .header, .rail,
 *    .composer-wrap.
 *
 * 2. IST DIE RICHTUNG NOCH RICHTIG?
 *
 *    Die Geräte-Schicht baut von schmal nach breit auf. Eine `max-width`-
 *    Abfrage darin wäre ein Rückfall in die alte Bauart — und der Anfang
 *    der nächsten Runde derselben Fehler. Am Zeigegerät festgemachte
 *    Abfragen sind erlaubt: die beschreiben kein Format, sondern eine Hand.
 *
 *     node scripts/mobil-pruefen.mjs
 */
import fs from 'node:fs';

const F = { rot: '\x1b[31m', gruen: '\x1b[32m', grau: '\x1b[90m', aus: '\x1b[0m' };
const DATEIEN = [
  'packages/desktop/src/styles/app.css',
  'packages/desktop/src/styles/mobil.css',
];

/* Elemente, die irgendwo einen Sicherheitsabstand tragen. */
const HEIKEL = ['.rahmen', '.rail', '.sidebar', '.header', '.composer-wrap', '.scrim'];

let fehler = 0;
console.log('');

for (const datei of DATEIEN) {
  const roh = fs.readFileSync(datei, 'utf8');
  /* Kommentare ausblenden, Zeilenzahlen erhalten. */
  const text = roh.replace(/\/\*[\s\S]*?\*\//g, (t) => t.replace(/[^\n]/g, ' '));

  /* ── 1. Kurzschreibweise auf heiklen Elementen ──────────────── */
  const bloecke = [...text.matchAll(/(^|\})\s*([^{}@][^{}]*?)\s*\{([^{}]*)\}/gms)];
  for (const b of bloecke) {
    const sel = b[2].trim().replace(/\s+/g, ' ');
    const rumpf = b[3];
    const zeile = text.slice(0, b.index).split('\n').length;
    const trifft = HEIKEL.filter((h) =>
      sel.split(',').some((t) => t.trim().split(/\s+/).some((w) => w === h || w.startsWith(h + ':') || w.startsWith(h + '.'))));
    if (!trifft.length) continue;
    for (const m of rumpf.matchAll(/(?<![-\w])(padding|margin)\s*:\s*([^;]+)/g)) {
      /* Ein einziger Wert setzt alle Seiten gleich — genauso gefährlich. */
      if (m[2].includes('var(--sicher-')) continue;
      console.log(`  ${F.rot}✗${F.aus} ${datei.split('/').pop()}:${zeile}  ${sel}`);
      console.log(`      ${F.grau}${m[1]}: ${m[2].trim().slice(0, 46)}${F.aus}`);
      console.log(`      ${F.grau}Kurzschreibweise auf einem Element mit Sicherheitsabstand —`);
      console.log(`      sie setzt alle vier Seiten und löscht ihn still.${F.aus}`);
      fehler++;
    }
  }

  /* ── 2. Richtung ────────────────────────────────────────────── */
  if (datei.endsWith('app.css')) {
    for (const m of text.matchAll(/@media[^{]*max-width:\s*(\d+)px[^{]*\{/g)) {
      if (Number(m[1]) > 880) continue;
      const zeile = text.slice(0, m.index).split('\n').length;
      console.log(`  ${F.rot}✗${F.aus} app.css:${zeile} enthält eine Handy-Abfrage (${m[1]}px)`);
      console.log(`      ${F.grau}Alles Mobile gehört nach mobil.css — nur dort kann es`);
      console.log(`      niemand aus Versehen überschreiben.${F.aus}`);
      fehler++;
    }
  }
  if (false) {
    /* Umgekehrte Frage als früher: steht wirklich ALLES Mobile hier?
       Eine schmale Medienabfrage anderswo wäre der Anfang derselben
       Zersplitterung, aus der wir gerade herausgekommen sind. */
  }
}

console.log(fehler
  ? `\n  ${F.rot}${fehler} Fund(e).${F.aus}\n`
  : `  ${F.gruen}✓${F.aus} Keine Kurzschreibweise löscht einen Sicherheitsabstand.\n`
    + `  ${F.gruen}✓${F.aus} Die Geräte-Schicht baut von schmal nach breit auf.\n`);
process.exit(fehler ? 1 : 0);
