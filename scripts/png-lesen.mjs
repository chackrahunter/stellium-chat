/**
 * Ein PNG von Hand lesen — nur so viel, wie zum Farbmessen nötig ist.
 *
 * Kein fremdes Paket: sharp ist hier nicht installiert, und html2canvas malt
 * ohnehin nur nach, was es aus dem DOM ableiten kann — nicht das, was der
 * Browser wirklich auf den Schirm gelegt hat. Ein Bildschirmabzug plus dieser
 * Leser gibt die echten Bildpunkte.
 *
 * Alle fünf Zeilenfilter werden ausgewertet. Ein Abzug mit einem Farbverlauf
 * benutzt fast nur die Filter 1, 3 und 4 — ein Leser, der nur Filter 0 kennt,
 * liefert genau dort keine Zahl, wo es interessant wird.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export function pngLesen(pfad) {
  const roh = fs.readFileSync(pfad);
  let pos = 8, breite = 0, hoehe = 0, tiefe = 0, farbtyp = 0;
  const teile = [];
  while (pos + 8 <= roh.length) {
    const len = roh.readUInt32BE(pos);
    const typ = roh.toString('ascii', pos + 4, pos + 8);
    if (typ === 'IHDR') {
      breite = roh.readUInt32BE(pos + 8); hoehe = roh.readUInt32BE(pos + 12);
      tiefe = roh[pos + 16]; farbtyp = roh[pos + 17];
    }
    if (typ === 'IDAT') teile.push(roh.subarray(pos + 8, pos + 8 + len));
    if (typ === 'IEND') break;
    pos += 12 + len;
  }
  if (tiefe !== 8) throw new Error(`Bildtiefe ${tiefe} wird hier nicht gelesen.`);
  const kanaele = { 0: 1, 2: 3, 4: 2, 6: 4 }[farbtyp];
  if (!kanaele) throw new Error(`Farbtyp ${farbtyp} wird hier nicht gelesen.`);

  const daten = zlib.inflateSync(Buffer.concat(teile));
  const bpp = kanaele, zeilenlaenge = breite * bpp;
  const bild = Buffer.alloc(hoehe * zeilenlaenge);
  let q = 0;
  for (let y = 0; y < hoehe; y += 1) {
    const filter = daten[q]; q += 1;
    const zeile = daten.subarray(q, q + zeilenlaenge); q += zeilenlaenge;
    const ziel = bild.subarray(y * zeilenlaenge, (y + 1) * zeilenlaenge);
    const oben = y > 0 ? bild.subarray((y - 1) * zeilenlaenge, y * zeilenlaenge) : null;
    for (let x = 0; x < zeilenlaenge; x += 1) {
      const a = x >= bpp ? ziel[x - bpp] : 0;
      const b = oben ? oben[x] : 0;
      const c = oben && x >= bpp ? oben[x - bpp] : 0;
      let v = zeile[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      ziel[x] = v & 255;
    }
  }
  return {
    breite, hoehe,
    punkt(x, y) {
      const i = y * zeilenlaenge + x * bpp;
      return kanaele >= 3 ? [bild[i], bild[i + 1], bild[i + 2]] : [bild[i], bild[i], bild[i]];
    },
  };
}

/** Helligkeit nach Rec. 709 — dafür taugt das Auge besser als der Mittelwert. */
export const hell = (c) => Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
