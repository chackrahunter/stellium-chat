/**
 * Bilder vor dem Hochladen verkleinern.
 *
 * Der Engpass beim Hochladen ist die Leitung nach oben — gemessen rund
 * 2,5 MB/s. Daran ändert kein Übertragungstrick etwas. Was hilft: weniger
 * Bytes. Ein Foto vom Telefon bringt gut und gern vier Megabyte mit, obwohl
 * es im Chat auf höchstens 2560 Pixel angesehen wird. Verkleinert bleiben
 * davon oft unter 500 Kilobyte — der Rest ist Auflösung, die niemand sieht.
 *
 * Angefasst wird nur, was sich dafür eignet: JPEG, PNG und WebP. GIF bliebe
 * ohne Bewegung zurück, SVG ist ohnehin winzig, und HEIC kann der Browser
 * nicht zeichnen.
 */

const GEEIGNET = /^image\/(jpe?g|png|webp)$/i;
/* Ab wann verkleinert wird. Früher lagen hier 1,5 MB — dadurch gingen genau
   die Dateien unangetastet durch, bei denen am meisten zu holen ist:
   Bildschirmfotos wiegen meist 200–900 KB und schrumpfen als WebP um rund
   drei Viertel. Unter 150 KB lohnt der Aufwand dann wirklich nicht mehr. */
const AB_GROESSE = 150_000;
const MAX_KANTE = 2560;
const QUALITAET = 0.82;

export interface Verkleinert {
  datei: File;
  vorher: number;
  nachher: number;
}

/**
 * Gibt die verkleinerte Datei zurück — oder das Original, wenn das Verkleinern
 * nichts bringt oder nicht geht. Nie schlechter als vorher.
 */
export async function bildVerkleinern(datei: File): Promise<Verkleinert> {
  const unveraendert = { datei, vorher: datei.size, nachher: datei.size };
  if (!GEEIGNET.test(datei.type) || datei.size < AB_GROESSE) return unveraendert;

  try {
    const bild = await bitmap(datei);
    const kante = Math.max(bild.width, bild.height);
    const faktor = kante > MAX_KANTE ? MAX_KANTE / kante : 1;
    const breite = Math.round(bild.width * faktor);
    const hoehe = Math.round(bild.height * faktor);

    const flaeche = document.createElement('canvas');
    flaeche.width = breite;
    flaeche.height = hoehe;
    const stift = flaeche.getContext('2d');
    if (!stift) return unveraendert;
    stift.imageSmoothingQuality = 'high';
    stift.drawImage(bild, 0, 0, breite, hoehe);
    bild.close?.();

    /* PNG mit Text oder Screenshots kann als JPEG unschön werden — deshalb
       beide Wege gehen und den kleineren nehmen, aber nur wenn er wirklich
       kleiner ist als das Original. */
    const kandidaten = await Promise.all([
      blob(flaeche, 'image/webp', QUALITAET),
      blob(flaeche, 'image/jpeg', QUALITAET),
    ]);
    const beste = kandidaten.filter(Boolean).sort((a, b) => a!.size - b!.size)[0];
    if (!beste || beste.size >= datei.size * 0.9) return unveraendert;

    const endung = beste.type === 'image/webp' ? 'webp' : 'jpg';
    const name = datei.name.replace(/\.[^.]+$/, '') + '.' + endung;
    return {
      datei: new File([beste], name, { type: beste.type, lastModified: datei.lastModified }),
      vorher: datei.size,
      nachher: beste.size,
    };
  } catch {
    // Kann der Browser das Bild nicht zeichnen, geht das Original raus.
    return unveraendert;
  }
}

function bitmap(datei: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(datei);
  return Promise.reject(new Error('createImageBitmap fehlt'));
}

function blob(flaeche: HTMLCanvasElement, typ: string, guete: number): Promise<Blob | null> {
  return new Promise((fertig) => flaeche.toBlob(fertig, typ, guete));
}
