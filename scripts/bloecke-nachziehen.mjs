/**
 * Was vor der Umstellung hochgeladen wurde, in den Blockspeicher holen.
 *
 * Der Blockspeicher greift seit seiner Einführung bei jedem Upload. Alles, was
 * davor kam, liegt weiterhin als ganze Datei auf der Platte — erkennbar daran,
 * dass in der Zeile kein Verfahren steht. Diese Dateien profitieren von nichts:
 * nicht vom Zusammenlegen gleicher Inhalte, nicht vom Packen. Genau die holt
 * dieser Lauf nach.
 *
 * Drei Dinge sind ihm wichtiger als Geschwindigkeit:
 *
 *   **Eine nach der anderen.** Auf einem Raspberry Pi teilt sich dieser Lauf
 *   die Maschine mit einem laufenden Chat. Parallelität würde die Karte
 *   sättigen und den Server für alle zäh machen; nacheinander merkt niemand
 *   etwas außer dem Fortschritt hier.
 *
 *   **Jederzeit abbrechbar.** Strg-C bricht nicht mitten in einer Datei ab,
 *   sondern nach der laufenden. Der nächste Start setzt fort, wo dieser
 *   aufgehört hat — es gibt keinen Merkzettel, an dem etwas hängen könnte:
 *   erledigt ist, was in der Zeile steht.
 *
 *   **Erst beweisen, dann löschen.** Die Ausgangsdatei verschwindet erst,
 *   wenn aus den Blöcken nachweislich wieder dieselbe Datei entsteht — Byte
 *   für Byte, geprüft über denselben Weg, den auch das Herunterladen nimmt.
 *   Fällt der Nachweis durch, bleibt alles, wie es war.
 *
 * Aufruf:
 *
 *   node scripts/bloecke-nachziehen.mjs [--daten <pfad>] [--probe] [--anzahl N]
 *
 *   --daten   Wo die Datenbank liegt. Ohne Angabe gilt DATA_DIR, sonst der
 *             Datenordner des Serverpakets.
 *   --probe   Nur zeigen, was anstünde. Ändert nichts.
 *   --anzahl  Höchstens so viele Dateien in diesem Lauf.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* ── Aufruf lesen ─────────────────────────────────────────────── */

const argumente = process.argv.slice(2);
const wert = (name) => {
  const i = argumente.indexOf(name);
  return i >= 0 ? argumente[i + 1] : undefined;
};
const gesetzt = (name) => argumente.includes(name);

const nurProbe = gesetzt('--probe');
const hoechstens = Number(wert('--anzahl') ?? Infinity);
const datenOrdner = wert('--daten');

/* Der Datenordner muss stehen, **bevor** die Serverbausteine geladen werden:
   config.js liest ihn beim Laden ein und legt danach nichts mehr um. */
if (datenOrdner) process.env.DATA_DIR = path.resolve(datenOrdner);

const wurzel = path.resolve(import.meta.dirname, '..');
const dist = path.join(wurzel, 'packages/server/dist');
if (!fs.existsSync(path.join(dist, 'services/ablage.js'))) {
  console.error(
    'Der Server ist nicht gebaut. Erst bauen:\n'
    + '  npm run build:shared && npm run build -w @stellium/server',
  );
  process.exit(2);
}

const { db } = await import(path.join(dist, 'db/index.js'));
const ablage = await import(path.join(dist, 'services/ablage.js'));
const bloecke = await import(path.join(dist, 'services/bloecke.js'));
const { config } = await import(path.join(dist, 'config.js'));

/* Der Server darf während des Laufs weiterarbeiten. Trifft er dabei auf
   dieselbe Datenbank, wartet SQLite — ohne diese Geduld bräche der Lauf beim
   ersten gleichzeitigen Schreibvorgang mit "database is locked" ab. */
db.exec('PRAGMA busy_timeout = 15000');

/* ── Anzeige ──────────────────────────────────────────────────── */

const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const prozent = (teil, ganz) => (ganz > 0 ? `${Math.round((100 * teil) / ganz)} %` : '0 %');

/* ── Was steht an? ────────────────────────────────────────────── */

/**
 * Alle Dateien, die noch als Ganzes auf der Platte liegen.
 *
 * In der Reihenfolge, in der sie hochgeladen wurden: das ist die Reihenfolge,
 * in der man sie erwartet, und ein abgebrochener Lauf hinterlässt eine klare
 * Grenze statt eines Flickenteppichs.
 */
function anstehende() {
  const offen = "(encoding IS NULL OR encoding = '')";
  return db.all(
    `SELECT id, 'attachment' AS art, name, mime, size, path, created_at FROM attachments WHERE ${offen}
     UNION ALL
     SELECT id, 'file' AS art, name, mime, size, path, created_at FROM files WHERE ${offen}
     ORDER BY created_at`,
  );
}

/**
 * Zeilen mit einem Verfahren, das wir hier nicht anfassen dürfen.
 *
 * Steht dort etwas anderes als "bloecke", liegt auf der Platte nicht die
 * ursprüngliche Datei, sondern eine gepackte Fassung davon. Die zu zerlegen
 * hieße, das Gepackte als Inhalt auszugeben — die Datei käme verändert zurück.
 * Solche Zeilen werden gemeldet und in Ruhe gelassen.
 */
function fremdeVerfahren() {
  const seltsam = "encoding IS NOT NULL AND encoding <> '' AND encoding <> 'bloecke'";
  return db.all(
    `SELECT id, 'attachment' AS art, name, encoding FROM attachments WHERE ${seltsam}
     UNION ALL
     SELECT id, 'file' AS art, name, encoding FROM files WHERE ${seltsam}`,
  );
}

/** Fingerabdruck einer Datei auf der Platte — die Vorlage für die Gegenprobe. */
function summeVonDatei(pfad) {
  const hash = crypto.createHash('sha256');
  const griff = fs.openSync(pfad, 'r');
  try {
    const puffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const gelesen = fs.readSync(griff, puffer, 0, puffer.length, null);
      if (gelesen <= 0) break;
      hash.update(puffer.subarray(0, gelesen));
    }
  } finally {
    fs.closeSync(griff);
  }
  return hash.digest('hex');
}

/** Fingerabdruck dessen, was der Server jetzt ausliefern würde. */
async function summeVomServer(id, art) {
  const strom = ablage.oeffnen({ id, art, pfad: null, encoding: 'bloecke' });
  if (!strom) throw new Error('Der Server findet zu dieser Datei keine Blöcke mehr.');
  const hash = crypto.createHash('sha256');
  let groesse = 0;
  for await (const stueck of strom) { hash.update(stueck); groesse += stueck.length; }
  return { summe: hash.digest('hex'), groesse };
}

/* ── Lauf ─────────────────────────────────────────────────────── */

let abbruchGewuenscht = false;
process.on('SIGINT', () => {
  if (abbruchGewuenscht) process.exit(130);      // zweimal Strg-C heißt: sofort
  abbruchGewuenscht = true;
  console.log('\n  Abbruch vorgemerkt — die laufende Datei wird noch fertig.');
});

const liste = anstehende();
const seltsame = fremdeVerfahren();
const vorher = bloecke.bilanz();

console.log(`\nBlöcke nachziehen — ${config.dataDir}`);
console.log(
  `  ${liste.length} Datei(en) offen, zusammen ${mb(liste.reduce((n, d) => n + d.size, 0))}. `
  + `Im Blockspeicher liegen ${vorher.bloecke} Blöcke (${mb(vorher.belegt)}).\n`,
);

if (seltsame.length) {
  console.log(`  ${seltsame.length} Zeile(n) mit fremdem Verfahren — die bleiben unangetastet:`);
  for (const s of seltsame) console.log(`    · ${s.name} (${s.art}, ${s.encoding})`);
  console.log('');
}

if (nurProbe) {
  for (const d of liste) {
    const da = fs.existsSync(d.path);
    console.log(`  · ${d.name} — ${mb(d.size)}${da ? '' : '  ⚠ Datei fehlt auf der Platte'}`);
  }
  console.log(`\n  Probelauf, nichts geändert.\n`);
  process.exit(0);
}

let erledigt = 0;
let fehlend = 0;
let gescheitert = 0;
let roh = 0;
let belegt = 0;

for (const [i, datei] of liste.entries()) {
  if (abbruchGewuenscht) break;
  if (erledigt + fehlend + gescheitert >= hoechstens) break;

  const kopf = `  [${i + 1}/${liste.length}] ${datei.name}`;

  if (!fs.existsSync(datei.path)) {
    /* Die Zeile steht, der Inhalt fehlt. Das ist kein Fall für diesen Lauf:
       aus nichts entstehen keine Blöcke. Nur melden — wegräumen darf das nur,
       wer weiß, ob die Datei anderswo wieder auftaucht. */
    console.log(`${kopf} — übersprungen, die Datei liegt nicht mehr da`);
    fehlend += 1;
    continue;
  }

  const aufDerPlatte = fs.statSync(datei.path).size;
  if (aufDerPlatte !== datei.size) {
    console.log(
      `${kopf} — übersprungen, ${mb(aufDerPlatte)} auf der Platte gegen ${mb(datei.size)} in der Zeile`,
    );
    gescheitert += 1;
    continue;
  }

  const vorlage = summeVonDatei(datei.path);
  const begonnen = Date.now();

  const ergebnis = ablage.uebernehmen({
    id: datei.id, art: datei.art, pfad: datei.path, mime: datei.mime,
  });
  if (!ergebnis) {
    console.log(`${kopf} — gescheitert, die Datei bleibt unverändert liegen`);
    gescheitert += 1;
    continue;
  }

  /* Die zweite, unabhängige Gegenprobe: nicht über die Zerlegung, sondern über
     den Weg, den ein Herunterladen nimmt. Fällt sie durch, ist zwar nichts
     verloren — die Übernahme prüft ihrerseits schon —, aber dann stimmt etwas
     am Ausliefern, und das muss laut werden. */
  try {
    const zurueck = await summeVomServer(datei.id, datei.art);
    if (zurueck.summe !== vorlage || zurueck.groesse !== datei.size) {
      console.log(`${kopf} — ⚠ die Auslieferung gibt etwas anderes zurück als hochgeladen wurde`);
      gescheitert += 1;
      continue;
    }
  } catch (fehler) {
    console.log(`${kopf} — ⚠ Gegenprobe nicht möglich: ${fehler.message}`);
    gescheitert += 1;
    continue;
  }

  roh += datei.size;
  belegt += ergebnis.belegt;
  erledigt += 1;
  const dauer = ((Date.now() - begonnen) / 1000).toFixed(1);
  console.log(
    `${kopf} — ${mb(datei.size)} → ${mb(ergebnis.belegt)} `
    + `(${prozent(datei.size - ergebnis.belegt, datei.size)} gespart, `
    + `${ergebnis.bloecke} Blöcke, ${dauer} s)`,
  );
}

/* ── Bilanz ───────────────────────────────────────────────────── */

const nachher = bloecke.bilanz();

/* Was ohne Inhalt dasteht, bleibt für immer offen — das ist kein Rest, den ein
   zweiter Lauf abarbeiten könnte. Deshalb zählt hier nur, was noch da ist. */
const nochMachbar = anstehende().filter((d) => fs.existsSync(d.path)).length;

console.log('');
console.log(`  ${erledigt} Datei(en) nachgezogen: ${mb(roh)} → ${mb(belegt)} (${prozent(roh - belegt, roh)} gespart).`);
if (fehlend) console.log(`  ${fehlend} Zeile(n) ohne Inhalt auf der Platte — nur gemeldet, nichts angefasst.`);
if (gescheitert) console.log(`  ${gescheitert} Datei(en) gescheitert und unverändert liegengeblieben.`);
console.log(
  `  Blockspeicher: ${vorher.bloecke} → ${nachher.bloecke} Blöcke, `
  + `${mb(vorher.belegt)} → ${mb(nachher.belegt)}.`,
);
if (nochMachbar) {
  console.log(`  Noch offen: ${nochMachbar}. Derselbe Aufruf setzt fort.`);
} else {
  console.log('  Es liegt nichts mehr außerhalb des Blockspeichers.');
}
console.log('');

process.exit(gescheitert ? 1 : 0);
