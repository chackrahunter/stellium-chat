/**
 * Profilbilder: annehmen, verkleinern, ablegen, ausliefern, aufräumen.
 *
 * Ein hochgeladenes Bild ist die klassischste Einfallstelle, die es gibt —
 * deshalb landet hier nie, was eine Person geschickt hat, sondern immer nur,
 * was aus einem Neuaufbau in fester Größe herauskommt. Das erledigt mehrere
 * Dinge auf einen Schlag:
 *
 *   - EXIF (und damit GPS-Koordinaten aus Handyfotos) ist weg. sharp lässt
 *     alle Metadaten (EXIF/ICC/XMP) standardmäßig weg, solange withMetadata()
 *     nirgends aufgerufen wird — genau deshalb steht dieser Aufruf hier
 *     nirgends. Siehe verarbeiten().
 *   - Ein als Bild getarntes Skript übersteht den Neuaufbau nicht: was
 *     herauskommt, ist immer neu erzeugtes WebP, nie eine Kopie der
 *     Originalbytes.
 *   - Die Ausgabegröße ist immer dieselbe, egal was hereinkam — kein Konto
 *     kann durch ein besonders großes Bild besonders viel Platz belegen.
 *
 * Erlaubt sind ausschließlich JPEG, PNG und WebP — geprüft an den ersten
 * Bytes der Datei (erkenneBildTyp), nicht an ihrem Namen und nicht an der
 * vom Client behaupteten Art. Beides ist frei erfunden. SVG ist bewusst
 * nicht dabei: eine SVG-Datei ist Markup, das der Browser ausführt, kein
 * Bild im Sinne dieser Prüfung — auch wenn sharp selbst (über librsvg)
 * durchaus SVGs lesen könnte, kommt sie bei uns nicht so weit.
 *
 * Abgelegt wird neben `uploads` und `storage` (siehe config.ts) — ein
 * eigener Unterordner unter demselben `dataDir`, kein zweiter Wurzelort.
 * Der Blockspeicher der beiden anderen (ablage.ts, mit Zerlegung in Teile,
 * Wiedererkennung gleicher Inhalte, Übernahme im Hintergrund) passt hier
 * nicht: Profilbilder sind immer klein, werden bei jeder Änderung komplett
 * neu erzeugt statt wiederverwendet, und es gibt höchstens eines pro Konto.
 * Eine eigene, sehr viel einfachere Ablage spart die Umwege, die dieser
 * Anwendungsfall nicht braucht.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { abweisung } from '../util/abweisung.js';
import { newId } from '../util/id.js';

export const avatarDir = path.join(config.dataDir, 'avatare');
fs.mkdirSync(avatarDir, { recursive: true });

/**
 * Obergrenze für die hochgeladene Datei — schon beim Empfangen durchgesetzt
 * (siehe die Route), nicht erst nachdem sie eingelesen ist. Großzügig für
 * ein unbearbeitetes Handyfoto, weit unter dem allgemeinen Limit für Anhänge
 * (config.maxUploadBytes, 50 MB): ein Profilbild braucht diese Größenordnung
 * nie, und wer mit einer mehrere hundert Megabyte großen Datei anfragt, soll
 * so früh wie möglich abgewiesen werden — nicht erst nach dem Einlesen.
 */
export const AVATAR_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Obergrenze für die im Bildkopf angegebenen Pixel — von sharp/libvips
 * geprüft, BEVOR das Bild entpackt wird (limitInputPixels vertraut den
 * Maßangaben im Kopf und vergleicht nur diese, ohne die Bilddaten
 * anzurühren). Ohne diese Grenze entpackt libvips als Erstes, was die Datei
 * über sich behauptet — ein winziges PNG mit einem Kopf von 50000×50000
 * Pixeln würde versuchen, mehrere Gigabyte Bildspeicher zu belegen: die
 * "Dekompressionsbombe". Auf einem Raspberry Pi der sichere Weg, den Server
 * (und alles, was gerade sonst noch läuft — Übersetzung, Websocket,
 * Sprachaufnahmen) in die Knie zu zwingen.
 *
 * 40 Megapixel decken jedes reale Fotohandy großzügig ab (auch 108-MP-Sensoren
 * liefern JPEGs meist deutlich verkleinert) und bleiben trotzdem weit unter
 * dem, was eine solche Bombe bräuchte, um wehzutun.
 */
const AVATAR_MAX_MEGAPIXEL = 40_000_000;

/**
 * Kantenlänge des Ausgabebilds — quadratisch, für jede Größe in der
 * Oberfläche (Avatar.tsx skaliert per CSS) genügend groß, auch auf einem
 * Bildschirm mit hoher Punktdichte. Größer zu gehen kostete nur Platz auf
 * dem Pi, ohne dass es irgendwo sichtbar schärfer würde.
 */
const AVATAR_KANTE = 512;

/** Wie im Client (lib/bilder.ts) — sichtbar verlustfrei, deutlich kleiner als die Ausgangsdatei. */
const AVATAR_QUALITAET = 82;

/**
 * Bildart an den ersten Bytes erkennen — nie am Dateinamen, nie am vom
 * Client behaupteten Content-Type. Beides steht frei erfunden im Request;
 * das hier sind die einzigen drei Signaturen, die als Bild durchgehen.
 */
export function erkenneBildTyp(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Ein hochgeladenes Bild in das feste Ausgabeformat bringen.
 *
 * Der Rückgabewert ist immer ein quadratisches WebP mit AVATAR_KANTE Kante
 * und ganz ohne Metadaten. Wirft eine Abweisung, wenn die Bytes keinem der
 * drei erlaubten Typen entsprechen, wenn sharp die Datei nicht lesen kann,
 * oder wenn die angegebenen Maße limitInputPixels überschreiten.
 */
export async function verarbeiten(roh: Buffer): Promise<Buffer> {
  const typ = erkenneBildTyp(roh);
  if (!typ) {
    throw abweisung(
      'fehler.bildTypNichtErlaubt',
      'Nur JPEG, PNG oder WebP — geprüft am Dateiinhalt, nicht am Namen.',
    );
  }

  try {
    return await sharp(roh, {
      limitInputPixels: AVATAR_MAX_MEGAPIXEL,
      /* 'warning' ist sharps eigene Vorgabe für nicht vertrauenswürdige
         Eingaben (siehe deren Dokumentation) — deshalb hier nicht
         gelockert. Jede Auffälligkeit beim Lesen soll den Versuch beenden,
         nicht nur eine Warnung ins Protokoll schreiben. */
      failOn: 'warning',
    })
      // Ausrichtung aus dem EXIF-Tag übernehmen, BEVOR die Angabe gleich mit
      // dem Rest der Metadaten verworfen wird — sonst läge ein
      // Hochformatfoto vom Handy nachher auf der Seite.
      .autoOrient()
      // Fester Mittenausschnitt: Das ist die "eigene neue Komponente" im
      // Client so beschrieben, und der Server setzt es durch, unabhängig
      // davon, was tatsächlich hereinkam — die Oberfläche ist ein
      // Versprechen, kein Nachweis.
      .resize(AVATAR_KANTE, AVATAR_KANTE, { fit: 'cover', position: 'centre' })
      .webp({ quality: AVATAR_QUALITAET })
      // KEIN .withMetadata() — genau das Weglassen entfernt EXIF (inkl.
      // GPS), ICC und XMP aus der Ausgabe. Das ist sharps dokumentiertes
      // Standardverhalten, kein Sonderfall, den man vergessen könnte.
      .toBuffer();
  } catch (fehlerObjekt) {
    // Hier landen sowohl kaputte Bilddaten als auch der Grenzfall oben:
    // limitInputPixels lässt die Verarbeitung mit einer eigenen Meldung
    // scheitern, bevor überhaupt ein voller Rahmen decodiert wurde.
    throw abweisung(
      'fehler.bildBeschaedigt',
      `Bild lässt sich nicht verarbeiten: ${(fehlerObjekt as Error).message}`,
      { grund: (fehlerObjekt as Error).message },
    );
  }
}

function pfadVon(datei: string): string {
  return path.join(avatarDir, datei);
}

/**
 * Prüft, ob ein Dateiname wirklich eine von uns vergebene Kennung ist — kein
 * `../`, kein absoluter Pfad, keine fremde Endung. Der Name kommt aus der
 * Adresse (`GET /avatare/:datei`) und damit von außen; ohne diese Prüfung
 * entschiede eine fremde Person, welche Datei unterhalb von avatarDir
 * ausgeliefert oder – schlimmer – beim nächsten Wechsel gelöscht wird.
 */
export function gueltigerDateiname(datei: string): boolean {
  return /^[A-Za-z0-9_-]+\.webp$/.test(datei);
}

/**
 * Ein fertig verarbeitetes Bild unter einer frischen Kennung ablegen.
 *
 * Die Kennung wechselt bei jeder Änderung — das ist der ganze Trick gegen
 * den Zwischenspeicher. Browser und App dürfen die Adresse eines
 * Profilbilds für immer behalten, weil sie nach der nächsten Änderung nie
 * wieder auftaucht: die neue Datei hat eine neue Adresse und ist für jeden
 * Zwischenspeicher ein erster Abruf, den `cache-control: immutable` dann
 * auch tatsächlich für ein Jahr behalten darf.
 *
 * Gibt den neuen relativen Pfad zurück, wie er in `users.avatar_url` steht.
 * Löscht die alte Datei bewusst NICHT selbst — das übernimmt die Route erst,
 * nachdem die Datenbank auf die neue Adresse zeigt (siehe dort).
 */
export async function ablegen(userId: string, bild: Buffer): Promise<string> {
  const datei = `${userId}-${newId('av_')}.webp`;
  await fs.promises.writeFile(pfadVon(datei), bild, { mode: 0o644 });
  return `/avatare/${datei}`;
}

/**
 * Die Datei einer (alten oder entfernten) Adresse löschen — best effort,
 * nie fatal. Fehlt sie schon, ist das kein Fehler; ein Fehlschlag beim
 * Löschen soll niemals den eigentlichen Vorgang (neues Bild steht schon,
 * oder Bild wurde entfernt) rückgängig machen.
 */
export async function entfernen(url: string | null): Promise<void> {
  if (!url) return;
  const datei = path.basename(url);
  if (!gueltigerDateiname(datei)) return; // sollte nie vorkommen, aber sicher ist sicher
  try {
    await fs.promises.rm(pfadVon(datei), { force: true });
  } catch (fehlerObjekt) {
    console.error('[avatare] Alte Datei ließ sich nicht entfernen:', (fehlerObjekt as Error).message);
  }
}

/** Eine Revision zum Ausliefern öffnen — oder null, wenn es sie nicht (mehr) gibt. */
export function oeffnen(datei: string): fs.ReadStream | null {
  if (!gueltigerDateiname(datei)) return null;
  const voll = pfadVon(datei);
  if (!fs.existsSync(voll)) return null;
  return fs.createReadStream(voll);
}
