/**
 * Werkbank für scripts/kennung-wasserlinie-pruefen.mjs: mintet Kennungen
 * unter einer gemockten Systemuhr, optional nachdem eine Zeile mit einer
 * vorgegebenen Kennung in `messages` angelegt wurde — simuliert damit den
 * Bestand aus einem vorigen Prozesslauf, ohne dass newId() selbst dafür
 * etwas Besonderes wüsste.
 *
 * Steuerung über Umgebungsvariablen statt Argumente, damit der Treiber mit
 * einem einzigen spawnSync() je Szenario auskommt — dasselbe Muster wie
 * src/pruefungen/schluessel-start.mts für scripts/schluesselwechsel-pruefen.mjs.
 *
 *   KENNUNG_SEED     wenn gesetzt: vor dem Minten eine Zeile mit GENAU
 *                    dieser Kennung in `messages` anlegen
 *   KENNUNG_ZEITEN   Kommaliste von Zeitstempeln (ms) — für jeden Eintrag
 *                    EIN newId()-Aufruf mit genau dieser gemockten Uhr, der
 *                    Reihe nach. Hat Vorrang vor KENNUNG_ZEIT/KENNUNG_ANZAHL.
 *   KENNUNG_ZEIT     einzelner Zeitstempel (ms) für KENNUNG_ANZAHL Aufrufe
 *                    mit derselben gemockten Uhr (Default: die echte Uhr)
 *   KENNUNG_ANZAHL   Anzahl der Aufrufe mit KENNUNG_ZEIT (Default 1, 0 =
 *                    gar nicht minten — nur seeden)
 *   KENNUNG_PREFIX   Präfix für newId() (Default 'm_', wie messages.id)
 *   KENNUNG_MIT_ZEIT wenn gesetzt: newIdMitZeit() statt newId() aufrufen und
 *                    die geklemmte Zeit mit hinter der Kennung ausgeben
 *                    (`KENNUNG:<id>|<zeit>`) — für
 *                    scripts/kennung-wasserlinie-pruefen.mjs, das prüft, ob
 *                    ein `created_at` aus derselben Vergabe wie die `id`
 *                    kommt statt aus einem eigenen, unabhängigen
 *                    `Date.now()`.
 *
 * Jede gemintete Kennung steht — mit dem Präfix `KENNUNG:` davor, damit sie
 * sich von den ganz gewöhnlichen console.log()-Zeilen aus initDb()/migrate()
 * unterscheiden lässt — auf einer eigenen Zeile auf stdout, zum Schluss die
 * Zeile MINT-OK. Warnungen aus util/id.ts laufen normal über console.warn
 * auf stderr mit — der Treiber liest sie dort.
 */
import { db, initDb } from '../db/index.js';
import { newId, newIdMitZeit } from '../util/id.js';

initDb();

const seed = process.env.KENNUNG_SEED;
if (seed) {
  // schema.sql setzt PRAGMA foreign_keys = ON — messages.channel_id/user_id
  // brauchen also wirklich vorhandene Zeilen, kein Als-ob.
  db.run(`INSERT OR IGNORE INTO users (id, handle, display_name, password_hash, created_at)
          VALUES ('probe-kennung-u', 'probe-kennung-u', 'Probe', 'x', 0)`);
  db.run(`INSERT OR IGNORE INTO channels (id, kind, name, created_by, created_at)
          VALUES ('probe-kennung-ch', 'public', 'probe', 'probe-kennung-u', 0)`);
  db.run(
    `INSERT INTO messages (id, channel_id, user_id, text, created_at)
     VALUES (?, 'probe-kennung-ch', 'probe-kennung-u', 'x', 0)`,
    seed,
  );
}

const prefix = process.env.KENNUNG_PREFIX ?? 'm_';
const zeiten = process.env.KENNUNG_ZEITEN
  ? process.env.KENNUNG_ZEITEN.split(',').map(Number)
  : Array(Number(process.env.KENNUNG_ANZAHL ?? '1')).fill(
    process.env.KENNUNG_ZEIT ? Number(process.env.KENNUNG_ZEIT) : Date.now(),
  );

// Date.now() für den Rest dieses (wegwerfbaren) Prozesses überschreiben —
// echt bleibt sie nur, falls zeiten leer ist (KENNUNG_ANZAHL=0, reines Seeden).
const echteUhr = Date.now.bind(Date);
let index = 0;
Date.now = () => (index < zeiten.length ? zeiten[index] : echteUhr());

const mitZeit = Boolean(process.env.KENNUNG_MIT_ZEIT);
for (index = 0; index < zeiten.length; index++) {
  if (mitZeit) {
    const { id, zeit } = newIdMitZeit(prefix);
    console.log(`KENNUNG:${id}|${zeit}`);
  } else {
    console.log(`KENNUNG:${newId(prefix)}`);
  }
}

console.log('MINT-OK');
