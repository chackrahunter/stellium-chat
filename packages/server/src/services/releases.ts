import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReleaseInfo, ReleasePlatform } from '@stellium/shared';
import { db } from '../db/index.js';
import { config } from '../config.js';

/**
 * Verteilung neuer App-Versionen.
 *
 * Die Verwaltung lädt je Plattform eine Datei hoch; die Clients fragen beim
 * Start und danach stündlich nach. Bewusst über den eigenen Server statt über
 * einen öffentlichen Update-Dienst: die Firma soll selbst bestimmen, wann
 * welche Version läuft, und nichts nach außen melden müssen.
 *
 * Die Prüfsumme wird beim Hochladen berechnet und mitgeliefert. Wer eine Datei
 * lädt, kann damit feststellen, ob sie unterwegs verändert wurde.
 */

export const PLATTFORMEN: ReleasePlatform[] = ['darwin', 'win32', 'linux', 'server'];

function toRelease(r: any): ReleaseInfo {
  return {
    platform: r.platform,
    version: r.version,
    notes: r.notes ?? null,
    size: r.size,
    sha256: r.sha256,
    fileName: r.file_name,
    url: `/releases/${r.platform}/download`,
    publishedBy: r.published_by,
    publishedAt: r.published_at,
  };
}

export function listReleases(): ReleaseInfo[] {
  return db.all<any>('SELECT * FROM releases ORDER BY platform').map(toRelease);
}

export function getRelease(platform: string): (ReleaseInfo & { path: string }) | null {
  const r = db.get<any>('SELECT * FROM releases WHERE platform = ?', platform);
  return r ? { ...toRelease(r), path: r.path } : null;
}

/**
 * Woran eine Fassungsnummer in ihre Glieder zerfällt.
 *
 * Bewusst EINE Konstante für istNeuer() und fassungPlausibel(): sonst gäbe es
 * hier zwei Vorstellungen davon, was eine Fassung ist, und die eine ließe
 * eines Tages etwas durch, das die andere gar nicht vergleichen kann.
 */
const FASSUNG_TRENNER = /[.\-+]/;

/** Länger als das ist keine Fassungsnummer mehr, sondern Freitext. */
const FASSUNG_MAX = 32;

/**
 * Vergleicht zwei Versionen nach dem Muster 1.2.3. Unbekanntes zählt als 0,
 * damit ein Tippfehler in der Version kein Update auslöst, das zurückgeht.
 */
export function istNeuer(neu: string, alt: string): boolean {
  const zerlegen = (v: string) => v.split(FASSUNG_TRENNER).map((t) => Number.parseInt(t, 10) || 0);
  const a = zerlegen(neu);
  const b = zerlegen(alt);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Die Plattformen, die ein Client von SICH SELBST melden darf — die
 * geschlossene Menge hinter users.client_platform.
 *
 * Woher genau diese vier: 'darwin'/'win32'/'linux' sind process.platform aus
 * dem Electron-Teil (desktop/electron/preload.ts, von desktop/src/net/socket.ts
 * ins `auth`-Ereignis gereicht), 'browser' ist der feste Rückfall derselben
 * Zeile für die Web-/PWA-Ansicht, die keine Electron-Brücke hat. Etwas
 * anderes sendet heute kein Client, und etwas anderes könnte clientAktuell()
 * unten auch gar nicht vergleichen.
 *
 * Bewusst NICHT dieselbe Liste wie PLATTFORMEN oben: dort steht 'server' —
 * ein Paket, das jemand hochlädt, kein Gerät, das sich anmeldet. Und dort
 * fehlt 'browser', weil es dafür keine hochladbare Datei gibt. Zwei Mengen
 * für zwei verschiedene Fragen, jede an ihrer Stelle begründet.
 */
export const CLIENT_PLATTFORMEN = ['darwin', 'win32', 'linux', 'browser'];

/**
 * Meldet dieser Client eine Plattform, die es überhaupt gibt?
 *
 * Für services/store.ts clientMeldung(). Alles andere wird dort verworfen —
 * die Spalte soll nur Werte tragen, die diese Liste kennt.
 */
export function plattformPlausibel(plattform: string): boolean {
  return CLIENT_PLATTFORMEN.includes(plattform);
}

/**
 * Hat das die Form einer Fassungsnummer, wie dieses Haus sie kennt?
 *
 * Gemessen an DERSELBEN Zerlegung, die istNeuer() zum Vergleichen benutzt
 * (FASSUNG_TRENNER), und an derselben Mindestform, die publish() beim
 * Hochladen verlangt (drei Zahlen). Damit entsteht hier keine zweite,
 * abweichende Vorstellung von „Fassung", die eines Tages von der ersten
 * abweicht.
 *
 * Erlaubt sind bis zu fünf Glieder: die drei Zahlen, die den Vergleich
 * tragen, und höchstens zwei kurze Anhängsel (1.2.3-rc.4). Was darüber
 * hinausgeht, könnte istNeuer() ohnehin nicht mehr sinnvoll auswerten — es
 * hier durchzulassen hieße nur, Freitext in einer Spalte abzulegen, die
 * TeamAdmin.tsx als Tatsache anzeigt.
 */
export function fassungPlausibel(fassung: string): boolean {
  if (fassung.length > FASSUNG_MAX) return false;
  const glieder = fassung.split(FASSUNG_TRENNER);
  if (glieder.length < 3 || glieder.length > 5) return false;
  return glieder.every((g, i) => (i < 3 ? /^\d{1,6}$/ : /^[0-9A-Za-z]{1,12}$/).test(g));
}

/**
 * Ist eine von einem Konto gemeldete Version für ihre Plattform noch die
 * aktuelle? Von services/store.ts (listManagedUsers()) verwendet, damit
 * ManagedUser.clientVersionAktuell dieselbe Vergleichslogik nutzt wie
 * /api/releases/check — kein zweiter, eigener Versionsvergleich (den gab es
 * in UpdatePanel.tsx schon einmal als Nachbau, siehe Kommentar dort).
 *
 * 'browser' hat keine eigene Zeile in der Tabelle `releases`: die Web-Ansicht
 * wird direkt vom laufenden Server ausgeliefert (siehe index.ts, wo
 * packages/desktop/dist bedient wird, und desktop/vite.config.ts, wo
 * __APP_VERSION__ aus genau derselben package.json entsteht wie
 * config.version hier) — ihre "aktuelle" Fassung IST also config.version.
 * Für darwin/win32/linux gilt dagegen ausdrücklich NICHT config.version,
 * sondern die zuletzt HOCHGELADENE Fassung dieser Plattform (getRelease):
 * eine Auslieferung kann eine Plattform vergessen oder verspätet nachreichen
 * (siehe veroeffentlichen.mjs), und bis dahin ist deren letzte hochgeladene
 * .dmg/.exe/.AppImage die einzige ehrliche Vergleichsgrundlage.
 *
 * `null`: keine Vergleichsgrundlage — noch nie gemeldet, oder für diese
 * Plattform liegt (noch) gar keine Fassung bereit.
 */
export function clientAktuell(platform: string | null, version: string | null): boolean | null {
  if (!platform || !version) return null;
  const aktuelle = platform === 'browser' ? config.version : getRelease(platform)?.version;
  if (!aktuelle) return null;
  return !istNeuer(aktuelle, version);
}

/** Wie lang die Änderungsliste einer Fassung höchstens wird. */
const ANMERKUNGEN_MAX = 20_000;

/**
 * Prüfsumme und Größe einer Datei, ohne sie in den Speicher zu holen.
 *
 * Hier stand `fs.readFileSync(tempPath)`. Für ein App-Paket sind das die
 * hundertfünfzig bis sechshundert Megabyte, die die Route durchlässt — auf
 * einem Raspberry Pi mit einem Gigabyte ist das kein Ausschlag im Diagramm,
 * sondern der Tod des Prozesses, und zwar genau in dem Augenblick, in dem
 * jemand ein Update verteilen will. Gemessen am Probeserver: der belegte
 * Speicher wuchs bei einer Datei von 160 MB um 178 MB.
 *
 * Bewusst mit readSync und nicht mit einem Strom: publish() ist synchron, und
 * das soll es bleiben — die Route ruft es zwischen zwei Dateioperationen auf,
 * deren Reihenfolge über die Wiederherstellbarkeit entscheidet.
 */
function summeUndGroesse(datei: string): { sha256: string; groesse: number } {
  const hash = createHash('sha256');
  const puffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(datei, 'r');
  let groesse = 0;
  try {
    for (;;) {
      const gelesen = fs.readSync(fd, puffer, 0, puffer.length, null);
      if (!gelesen) break;
      hash.update(puffer.subarray(0, gelesen));
      groesse += gelesen;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), groesse };
}

export function publish(input: {
  platform: ReleasePlatform; version: string; notes?: string | null;
  fileName: string; tempPath: string; publishedBy: string;
}): ReleaseInfo {
  if (!PLATTFORMEN.includes(input.platform)) throw new Error('Unbekannte Plattform.');
  if (!/^\d+\.\d+\.\d+/.test(input.version)) {
    throw new Error('Die Version muss dem Muster 1.2.3 folgen.');
  }

  const ziel = path.join(config.releaseDir, `${input.platform}-${path.basename(input.fileName)}`);
  const { sha256, groesse } = summeUndGroesse(input.tempPath);

  // Erst die neue Datei ablegen, dann die Datenbank umschreiben und ganz zum
  // Schluss die alte Datei entfernen — bricht etwas dazwischen ab, zeigt die
  // Datenbank immer noch auf eine Datei, die es wirklich gibt. (Trägt die neue
  // Datei denselben Namen wie die alte, wie beim Serverpaket, ersetzt das
  // Umbenennen den Inhalt schon hier; dagegen hilft erst ein Zwischenname.)
  fs.renameSync(input.tempPath, ziel);
  // Der bisherige Eintrag muss vor dem Schreiben gelesen werden, danach stünde
  // hier schon die neue Zeile und der alte Pfad wäre verloren.
  const vorher = getRelease(input.platform);

  db.run(
    `INSERT INTO releases (platform, version, notes, file_name, path, size, sha256, published_by, published_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(platform) DO UPDATE SET
       version = excluded.version, notes = excluded.notes, file_name = excluded.file_name,
       path = excluded.path, size = excluded.size, sha256 = excluded.sha256,
       published_by = excluded.published_by, published_at = excluded.published_at`,
    input.platform, input.version, input.notes?.trim().slice(0, ANMERKUNGEN_MAX) || null,
    path.basename(input.fileName), ziel, groesse, sha256,
    input.publishedBy, Date.now(),
  );

  if (vorher && vorher.path !== ziel && fs.existsSync(vorher.path)) {
    // Nach dem Schreiben darf nichts mehr scheitern: die Veröffentlichung ist
    // gültig. Bleibt die alte Datei liegen, kostet das nur Platz.
    try { fs.rmSync(vorher.path, { force: true }); } catch { /* egal */ }
  }
  return getRelease(input.platform)!;
}

export function removeRelease(platform: string): void {
  const vorhanden = getRelease(platform);
  if (vorhanden && fs.existsSync(vorhanden.path)) fs.rmSync(vorhanden.path, { force: true });
  db.run('DELETE FROM releases WHERE platform = ?', platform);
}
