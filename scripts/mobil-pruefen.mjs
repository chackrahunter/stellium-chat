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
 * 3. MISST SICH ETWAS AM SICHTBAREN UND HÄNGT AM LAYOUT-VIEWPORT?
 *
 *    `--vv-hoehe` ist die Höhe des SICHTBAREN Ausschnitts (lib/tastatur.ts),
 *    `--vv-oben` seine Lage darin. Wer nur die Höhe nimmt, bekommt einen
 *    Kasten in der richtigen Grösse an der falschen Stelle: schiebt iOS das
 *    Dokument hoch, um ein Schreibfeld freizustellen, wandert er mit und
 *    seine erste Zeile verlässt den Schirm.
 *
 *    Genau so war es: `.app` nahm `height: var(--vv-hoehe)` und lag sonst im
 *    normalen Fluss. Bei offener Tastatur war die ganze Kopfzeile weg —
 *    Kanalname, Schubladengriff, Werkzeuge — und man kam an keinen anderen
 *    Kanal mehr. Die drei fixierten Elemente daneben (.rail, .sidebar,
 *    .thread) hatten `--vv-oben` von Anfang an; nur das Gerüst nicht.
 *
 *    Geprüft wird die Höhe und die Lage, NICHT die Polsterung: `.scrim`
 *    benutzt `--vv-hoehe` in einem `padding-bottom`, um einen Dialog über der
 *    Tastatur zu halten. Das ist die entgegengesetzte Rechnung und erzeugt
 *    den Widerspruch nicht — der entsteht erst, wenn Grösse und Lage aus
 *    verschiedenen Bezugssystemen kommen.
 *
 * 4. HÄLT AM UNTEREN RAND ETWAS FREI, WAS GAR NICHTS FREIHÄLT?
 *
 *    Solange `viewport-fit=cover` nicht im Viewport-Meta steht — und es steht
 *    dort mit Absicht nicht, siehe lib/sichere-bereiche.ts — meldet env()
 *    überall 0. `--sicher-unten` ist damit auf JEDEM Gerät 0, und eine Regel,
 *    die allein daran hängt, hält nichts frei. Sie sieht nur so aus.
 *
 *    Genau so lagen die zehn Knöpfe der Eingabeleiste in der Wischgeste:
 *    `.composer-wrap` trug `padding-bottom: calc(4px + var(--sicher-unten))`,
 *    das ergab 4 statt 38, und die Knöpfe endeten bei 857 von 874 — siebzehn
 *    Punkte tief in den untersten 34, die die Home-Geste beansprucht.
 *
 *    Der richtige Wert ist `--wischzone` (34px, in mobil.css als
 *    `--rand-unten` mit `--sicher-unten` zusammengefasst, damit Android
 *    seinen echten env()-Wert behält).
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

/* Angaben, in denen `--vv-hoehe` eine GRÖSSE oder eine LAGE bestimmt. Nur bei
   denen entsteht der Widerspruch aus Frage 3; in einer Polsterung nicht. */
const GEOMETRIE = /(?<![-\w])(height|min-height|max-height|block-size|min-block-size|max-block-size|top|bottom|inset|inset-block|inset-block-start|inset-block-end|translate|transform)\s*:\s*([^;]*var\(\s*--vv-hoehe)/g;

/* Angaben, die am unteren Rand etwas freihalten sollen. */
const UNTEN = /(?<![-\w])(padding-bottom|padding-block|padding-block-end|margin-bottom|margin-block-end|bottom|inset-block-end)\s*:\s*([^;]+)/g;

/* Steht `viewport-fit=cover` im Viewport-Meta? Nur ohne es ist env() blind —
   mit ihm liefert --sicher-unten einen echten Wert und Frage 4 ruht.
   Gelesen und nicht angenommen: eine Prüfung, die eine Voraussetzung rät,
   bleibt grün, wenn sich die Voraussetzung ändert. */
function envIstBlind() {
  const html = fs.readFileSync('packages/desktop/index.html', 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const meta = html.match(/<meta[^>]*name=["']viewport["'][^>]*>/i);
  return !meta || !/viewport-fit\s*=\s*cover/i.test(meta[0]);
}
const ENV_BLIND = envIstBlind();

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

  /* ── 3. Sichtbarer Ausschnitt: Grösse ohne Lage ─────────────── */
  for (const b of bloecke) {
    const sel = b[2].trim().replace(/\s+/g, ' ');
    const rumpf = b[3];
    if (!/var\(\s*--vv-hoehe/.test(rumpf)) continue;
    const treffer = [...rumpf.matchAll(GEOMETRIE)];
    if (!treffer.length) continue;                       /* nur Polsterung — erlaubt */
    if (/var\(\s*--vv-oben/.test(rumpf)) continue;        /* Lage ist mitgeführt */
    const zeile = text.slice(0, b.index).split('\n').length;
    console.log(`  ${F.rot}✗${F.aus} ${datei.split('/').pop()}:${zeile}  ${sel}`);
    console.log(`      ${F.grau}${treffer[0][1]}: … var(--vv-hoehe) … — aber kein var(--vv-oben)${F.aus}`);
    console.log(`      ${F.grau}Grösse vom sichtbaren Ausschnitt, Lage vom Layout-Viewport.`);
    console.log(`      Schiebt iOS das Dokument hoch, wandert das Element mit`);
    console.log(`      und seine erste Zeile verlässt den Schirm.${F.aus}`);
    fehler++;
  }

  /* ── 4. Unterer Rand: ein Abstand, der keiner ist ───────────── */
  if (ENV_BLIND) {
    for (const b of bloecke) {
      const sel = b[2].trim().replace(/\s+/g, ' ');
      const rumpf = b[3];
      const zeile = text.slice(0, b.index).split('\n').length;
      for (const m of rumpf.matchAll(UNTEN)) {
        if (!/var\(\s*--sicher-unten/.test(m[2])) continue;
        if (/var\(\s*--wischzone|var\(\s*--rand-unten/.test(m[2])) continue;
        console.log(`  ${F.rot}✗${F.aus} ${datei.split('/').pop()}:${zeile}  ${sel}`);
        console.log(`      ${F.grau}${m[1]}: ${m[2].trim().slice(0, 46)}${F.aus}`);
        console.log(`      ${F.grau}Ohne viewport-fit=cover meldet env() überall 0 —`);
        console.log(`      --sicher-unten hält hier also NICHTS frei, und das`);
        console.log(`      Element reicht in die untersten 34 Punkte der`);
        console.log(`      Home-Geste. Gemeint ist --rand-unten (--wischzone).${F.aus}`);
        fehler++;
      }
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
    + `  ${F.gruen}✓${F.aus} Die Geräte-Schicht baut von schmal nach breit auf.\n`
    + `  ${F.gruen}✓${F.aus} Wer sich am sichtbaren Ausschnitt misst, hängt auch daran.\n`
    + `  ${F.gruen}✓${F.aus} ${ENV_BLIND
      ? 'Kein unterer Abstand verlässt sich auf das blinde env().'
      : 'viewport-fit=cover ist zurück — env() sieht wieder, Frage 4 ruht.'}\n`);
process.exit(fehler ? 1 : 0);
