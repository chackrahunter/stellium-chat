/**
 * Die Startbilder für die iOS-Startbildschirm-App erzeugen.
 *
 * WARUM ES SIE BRAUCHT
 *
 * Startet Stellium vom Startbildschirm, zeigt iOS zuerst einen leeren
 * Startschirm und erst danach die Seite. Dieser Startschirm ist WEISS —
 * gegen eine durchweg dunkle App ein Blitz, der beim Öffnen jedes Mal
 * blendet. `background_color` im Manifest ändert daran nichts: Android liest
 * es, iOS nicht. iOS liest ausschließlich `apple-touch-startup-image`.
 *
 * WARUM ES VIELE SIND
 *
 * Ein Startbild gilt nur, wenn seine Maße GENAU zum Gerät passen; ein
 * unpassendes überspringt iOS wortlos und nimmt wieder Weiß. Es gibt also
 * kein „eines für alle" — nur eine Tabelle, und die steht hier statt
 * verstreut in der index.html.
 *
 * Die Bilder sind einfarbig (--grund-rand, dieselbe Farbe wie `theme-color`
 * in der index.html). Ein einfarbiges PNG ist auch bei 1320 × 2868 nur rund
 * ein Kilobyte groß, deshalb kosten alle zusammen kaum etwas.
 *
 *     node scripts/startbilder-erzeugen.mjs           # Bilder schreiben
 *     node scripts/startbilder-erzeugen.mjs --links   # die <link>-Zeilen ausgeben
 *
 * Ändert sich die Farbe, hier ändern und neu laufen lassen. Kommt ein Gerät
 * dazu, eine Zeile in GERAETE ergänzen, laufen lassen und die Ausgabe von
 * `--links` in packages/desktop/index.html übernehmen.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/* Dieselbe Farbe wie <meta name="theme-color"> und --grund-rand. Steht ein
   anderer Wert hier, sieht man beim Start einen Farbsprung statt eines
   nahtlosen Übergangs — genau das, was die Bilder verhindern sollen. */
const FARBE = [0x17, 0x27, 0x36];

const ZIEL = 'packages/desktop/public/start';

/* [Breite, Höhe, Punktdichte, welche Geräte] — Breite und Höhe in CSS-Punkten,
   also das, was die Medienabfrage abfragt. */
const GERAETE = [
  [440, 956, 3, 'iPhone 16/17 Pro Max'],
  [430, 932, 3, 'iPhone 14/15 Pro Max, 15/16 Plus'],
  [428, 926, 3, 'iPhone 12/13 Pro Max'],
  [414, 896, 3, 'iPhone XS Max, 11 Pro Max'],
  [414, 896, 2, 'iPhone XR, 11'],
  [402, 874, 3, 'iPhone 16/17 Pro'],
  [393, 852, 3, 'iPhone 14 Pro, 15/16'],
  [390, 844, 3, 'iPhone 12/13/14'],
  [375, 812, 3, 'iPhone X/XS, 11 Pro, 13 mini'],
  [375, 667, 2, 'iPhone SE'],
];

/**
 * Ein einfarbiges PNG als Bytes. Ohne Fremdpaket — zlib bringt Node mit.
 *
 * Ein Bild mit Farbtabelle und EINEM Bit je Pixel, nicht 24. Das ist hier
 * kein Geiz, sondern eine Grössenordnung: bei 1206 × 2622 sind 24 Bit je
 * Pixel 9,5 MB Rohdaten, und deflate schafft höchstens etwa 1032 : 1 — auch
 * eine völlig gleichförmige Fläche landet damit nie unter 9 KB. Mit einem Bit
 * je Pixel sind es 395 KB roh und rund 400 Byte fertig. Über zwanzig Bilder
 * ist das der Unterschied zwischen 260 KB und 8 KB im Repository.
 *
 * Die Farbe steht dabei nicht mehr in den Pixeln, sondern in der Farbtabelle;
 * jedes Pixel zeigt nur noch auf Eintrag 0. Deshalb sind alle Bilddaten Null
 * und der Zeilenfilter 0 genügt.
 */
function einfarbigesPng(breite, hoehe, [r, g, b]) {
  const jeZeile = 1 + Math.ceil(breite / 8);
  const roh = Buffer.alloc(jeZeile * hoehe);   // alles 0: Filter 0, Eintrag 0

  const stueck = (art, inhalt) => {
    const laenge = Buffer.alloc(4);
    laenge.writeUInt32BE(inhalt.length);
    const kopfUndInhalt = Buffer.concat([Buffer.from(art, 'ascii'), inhalt]);
    const pruef = Buffer.alloc(4);
    pruef.writeUInt32BE(crc32(kopfUndInhalt));
    return Buffer.concat([laenge, kopfUndInhalt, pruef]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(breite, 0);
  ihdr.writeUInt32BE(hoehe, 4);
  ihdr[8] = 1;   // ein Bit je Pixel
  ihdr[9] = 3;   // mit Farbtabelle
  /* Zwei Einträge, weil ein Bit zwei Werte kennt. Benutzt wird nur der
     erste; der zweite muss trotzdem dastehen, sonst ist die Tabelle für die
     Bittiefe zu kurz und strenge Leser lehnen das Bild ab. */
  const plte = Buffer.from([r, g, b, r, g, b]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    stueck('IHDR', ihdr),
    stueck('PLTE', plte),
    stueck('IDAT', zlib.deflateSync(roh, { level: 9 })),
    stueck('IEND', Buffer.alloc(0)),
  ]);
}

/* Eigene CRC-32-Tabelle für Node-Fassungen ohne zlib.crc32. */
let tabelle = null;
function crc32(puffer) {
  if (!tabelle) {
    tabelle = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tabelle[n] = c;
    }
  }
  let c = -1;
  for (const byte of puffer) c = tabelle[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const nurLinks = process.argv.includes('--links');
if (!nurLinks) fs.mkdirSync(ZIEL, { recursive: true });

const zeilen = [];
for (const [b, h, dichte, was] of GERAETE) {
  for (const [lage, pb, ph] of [['portrait', b, h], ['landscape', h, b]]) {
    const px = pb * dichte;
    const py = ph * dichte;
    const name = `${px}x${py}.png`;
    if (!nurLinks) fs.writeFileSync(path.join(ZIEL, name), einfarbigesPng(px, py, FARBE));
    zeilen.push(`    <link rel="apple-touch-startup-image" href="/start/${name}"`
      + `\n          media="screen and (device-width: ${b}px) and (device-height: ${h}px)`
      + ` and (-webkit-device-pixel-ratio: ${dichte}) and (orientation: ${lage})" />`
      + (lage === 'portrait' ? '' : `  <!-- ${was} -->`));
  }
}

if (nurLinks) console.log(zeilen.join('\n'));
else console.log(`${zeilen.length} Startbilder in ${ZIEL}`);
