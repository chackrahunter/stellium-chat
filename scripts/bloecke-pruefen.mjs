/**
 * Tiefenprüfung des Blockspeichers.
 *
 * Der Blockspeicher erkauft seine Ersparnis mit einer Abhängigkeit: derselbe
 * Block steckt in mehreren Dateien. Das ist der ganze Witz daran — und
 * zugleich sein einziger echter Nachteil. Wo früher ein defektes Sektorenpaar
 * eine Datei ruinierte, trifft es jetzt jede Datei, die diesen Block benutzt.
 * Ein Speicher, der das nicht regelmäßig nachrechnet, merkt einen Schaden erst
 * dann, wenn jemand herunterladen will — also zum denkbar schlechtesten
 * Zeitpunkt.
 *
 * Deshalb rechnet dieser Lauf jeden Block nach: lesen, auspacken,
 * Fingerabdruck bilden, mit dem Namen vergleichen. Der Name eines Blocks *ist*
 * der Fingerabdruck seines Inhalts; passt beides nicht mehr zusammen, hat sich
 * auf der Platte etwas verändert. Zu jedem Fund steht dabei, welche Dateien
 * davon betroffen wären — das ist die Auskunft, die man braucht, um zu
 * entscheiden, was aus einer Sicherung zurückgeholt werden muss.
 *
 * Der Lauf **meldet nur**. Er löscht nichts, repariert nichts und rechnet
 * keinen Zähler gerade. Was ein Prüfwerkzeug im Vorbeigehen ändert, kann man
 * hinterher nicht mehr untersuchen.
 *
 * Aufruf:
 *
 *   node scripts/bloecke-pruefen.mjs [--daten <pfad>] [--schnell]
 *
 *   --daten    Wo die Datenbank liegt. Ohne Angabe gilt DATA_DIR.
 *   --schnell  Nur nachsehen, ob jeder Block da ist und die erwartete Größe
 *              hat — ohne auszupacken. Für einen großen Speicher, den man
 *              stündlich streifen will; der Fingerabdruck bleibt dabei außen
 *              vor und damit auch die Aussage über den Inhalt.
 */
import fs from 'node:fs';
import path from 'node:path';

/* ── Aufruf lesen ─────────────────────────────────────────────── */

const argumente = process.argv.slice(2);
const wert = (name) => {
  const i = argumente.indexOf(name);
  return i >= 0 ? argumente[i + 1] : undefined;
};
const schnell = argumente.includes('--schnell');
const datenOrdner = wert('--daten');
if (datenOrdner) process.env.DATA_DIR = path.resolve(datenOrdner);

const wurzel = path.resolve(import.meta.dirname, '..');
const dist = path.join(wurzel, 'packages/server/dist');
if (!fs.existsSync(path.join(dist, 'services/bloecke.js'))) {
  console.error(
    'Der Server ist nicht gebaut. Erst bauen:\n'
    + '  npm run build:shared && npm run build -w @stellium/server',
  );
  process.exit(2);
}

const { db } = await import(path.join(dist, 'db/index.js'));
const bloecke = await import(path.join(dist, 'services/bloecke.js'));
const { config } = await import(path.join(dist, 'config.js'));

db.exec('PRAGMA busy_timeout = 15000');

const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

/* ── Wer hängt an einem Block? ────────────────────────────────── */

/**
 * Die Dateien, die einen Block benutzen — mit Namen, nicht mit Kennungen.
 *
 * Eine Kennung sagt niemandem etwas. Wer nach einem Schaden entscheiden muss,
 * was aus der Sicherung zurückkommt, will lesen, welche Datei betroffen ist.
 */
function betroffeneDateien(summe) {
  return db.all(
    `SELECT dl.art, dl.datei_id,
            COALESCE(f.name, a.name, '(Eintrag fehlt)') AS name
       FROM datei_bloecke dl
       LEFT JOIN files       f ON dl.art = 'file'       AND f.id = dl.datei_id
       LEFT JOIN attachments a ON dl.art = 'attachment' AND a.id = dl.datei_id
      WHERE dl.summe = ?
      ORDER BY name`,
    summe,
  );
}

function nenne(dateien) {
  const namen = [...new Set(dateien.map((d) => d.name))];
  const gezeigt = namen.slice(0, 6).join(', ');
  return namen.length > 6 ? `${gezeigt} … (+${namen.length - 6})` : gezeigt || '(keine)';
}

/* ── Die Blöcke selbst ────────────────────────────────────────── */

const alle = db.all('SELECT summe, groesse, belegt, verfahren, verweise FROM bloecke ORDER BY summe');
const gesamtBelegt = alle.reduce((n, b) => n + b.belegt, 0);

console.log(`\nTiefenprüfung des Blockspeichers — ${config.dataDir}`);
console.log(`  ${alle.length} Blöcke, ${mb(gesamtBelegt)} auf der Platte${schnell ? ' (schnelle Runde)' : ''}\n`);

const fehlen = [];
const beschaedigt = [];
let geprueft = 0;
let gelesen = 0;
const begonnen = Date.now();

for (const block of alle) {
  const pfad = bloecke.blockPfad(block.summe);

  if (!fs.existsSync(pfad)) {
    fehlen.push({ ...block, grund: 'Die Blockdatei liegt nicht auf der Platte.' });
  } else if (schnell) {
    /* Ohne Auspacken bleibt nur die Größe. Sie ist ein schwacher, aber nicht
       wertloser Zeuge: eine abgeschnittene Datei fällt damit auf, eine
       veränderte nicht. */
    const da = fs.statSync(pfad).size;
    if (da !== block.belegt) {
      beschaedigt.push({ ...block, grund: `${da} statt ${block.belegt} Byte auf der Platte` });
    }
  } else {
    const befund = bloecke.pruefeBlock(block.summe);
    if (befund.zustand === 'fehlt') fehlen.push({ ...block, grund: befund.grund });
    else if (befund.zustand !== 'ok') beschaedigt.push({ ...block, grund: befund.grund });
    gelesen += block.belegt;
  }

  geprueft += 1;
  // Bei großen Speichern soll man sehen, dass es vorangeht.
  if (geprueft % 500 === 0) {
    process.stdout.write(`  … ${geprueft}/${alle.length} geprüft\r`);
  }
}
if (geprueft >= 500) process.stdout.write(' '.repeat(40) + '\r');

/* ── Was sonst nicht zusammenpasst ────────────────────────────── */

/* Verweise auf Blöcke, die es in der Tabelle gar nicht gibt. Solche Dateien
   sind bereits jetzt nicht mehr herstellbar — beim Zusammensetzen fällt es
   spätestens am Fingerabdruck auf, aber dann steht schon jemand davor. */
const insLeere = db.all(
  `SELECT DISTINCT dl.summe FROM datei_bloecke dl
     WHERE NOT EXISTS (SELECT 1 FROM bloecke b WHERE b.summe = dl.summe)`,
);

/* Zeilen, deren Datei es nicht mehr gibt. Passiert, wenn eine Datei ohne
   Umweg über die Ablage verschwindet — beim Löschen eines Kanals räumt die
   Datenbank Nachrichten, Anhänge und Dateien selbst ab. */
const verwaisteEintraege = db.all(
  `SELECT DISTINCT art, datei_id FROM datei_bloecke
     WHERE (art = 'file'       AND datei_id NOT IN (SELECT id FROM files))
        OR (art = 'attachment' AND datei_id NOT IN (SELECT id FROM attachments))`,
);

/* Dateien, die sich für abgelegt halten, aber keine Blöcke haben. */
const ohneBloecke = db.all(
  `SELECT id, 'file' AS art, name FROM files
     WHERE encoding = 'bloecke'
       AND NOT EXISTS (SELECT 1 FROM datei_bloecke d WHERE d.art = 'file' AND d.datei_id = files.id)
   UNION ALL
   SELECT id, 'attachment' AS art, name FROM attachments
     WHERE encoding = 'bloecke'
       AND NOT EXISTS (SELECT 1 FROM datei_bloecke d WHERE d.art = 'attachment' AND d.datei_id = attachments.id)`,
);

/* Zähler, die nicht mehr zur Wahrheit passen. Kein Schaden am Inhalt, aber
   ein Hinweis: zu hohe Zähler halten Blöcke fest, die niemand mehr braucht. */
const zaehlerSchief = db.all(
  `SELECT summe, verweise, belegt,
          (SELECT COUNT(*) FROM datei_bloecke d WHERE d.summe = bloecke.summe) AS wirklich
     FROM bloecke
    WHERE verweise <> (SELECT COUNT(*) FROM datei_bloecke d WHERE d.summe = bloecke.summe)`,
);

/* Blockdateien auf der Platte, zu denen keine Zeile mehr gehört. Die kosten
   Platz und sonst nichts — aber sie zeigen, dass irgendwo aufgeräumt wurde,
   ohne zu Ende aufzuräumen. */
function alleBlockDateien(ordner) {
  const gefunden = [];
  const gehe = (ort) => {
    let eintraege;
    try { eintraege = fs.readdirSync(ort, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const voll = path.join(ort, e.name);
      if (e.isDirectory()) gehe(voll);
      else if (/^[a-f0-9]{64}$/.test(e.name)) gefunden.push({ name: e.name, pfad: voll });
    }
  };
  gehe(ordner);
  return gefunden;
}

const bekannt = new Set(alle.map((b) => b.summe));
const aufDerPlatte = alleBlockDateien(path.join(config.storageDir, 'bloecke'));
const karteileichen = aufDerPlatte.filter((d) => !bekannt.has(d.name));
const karteileichenPlatz = karteileichen.reduce((n, d) => {
  try { return n + fs.statSync(d.pfad).size; } catch { return n; }
}, 0);

/* Und schließlich ganze Dateien, zu denen keine Zeile mehr gehört. Die stammen
   aus der Zeit vor dem Blockspeicher und aus Wegen, auf denen eine Datei
   verschwindet, ohne dass jemand die Platte anfasst — beim Löschen eines
   Kanals zum Beispiel räumt die Datenbank ihre Zeilen ab und lässt den Inhalt
   liegen. Sie stören nichts, sie kosten nur Platz; wer sie wegräumt, sollte
   aber wissen, was er da wegräumt. */
function ganzeDateienOhneZeile() {
  const bekanntePfade = new Set([
    ...db.all('SELECT path FROM attachments').map((r) => r.path),
    ...db.all('SELECT path FROM files').map((r) => r.path),
  ]);
  const gefunden = [];
  for (const ordner of new Set([config.uploadDir, config.storageDir])) {
    let eintraege;
    try { eintraege = fs.readdirSync(ordner, { withFileTypes: true }); } catch { continue; }
    for (const e of eintraege) {
      if (!e.isFile()) continue;
      const voll = path.join(ordner, e.name);
      if (bekanntePfade.has(voll)) continue;
      try { gefunden.push({ pfad: voll, groesse: fs.statSync(voll).size }); } catch { /* schon weg */ }
    }
  }
  return gefunden;
}

const herrenlos = ganzeDateienOhneZeile();
const herrenlosPlatz = herrenlos.reduce((n, d) => n + d.groesse, 0);

/* ── Bericht ──────────────────────────────────────────────────── */

const dauer = ((Date.now() - begonnen) / 1000).toFixed(1);
console.log(
  schnell
    ? `  ${geprueft} Blöcke angesehen in ${dauer} s.\n`
    : `  ${geprueft} Blöcke nachgerechnet (${mb(gelesen)} gelesen) in ${dauer} s.\n`,
);

function melde(ueberschrift, zeilen) {
  if (!zeilen.length) return;
  console.log(`  ${ueberschrift}`);
  for (const z of zeilen) console.log(`    ${z}`);
  console.log('');
}

melde(
  `✗ ${fehlen.length} Block/Blöcke fehlen — die folgenden Dateien lassen sich nicht mehr herstellen:`,
  fehlen.map((b) => `${b.summe.slice(0, 12)}… (${mb(b.groesse)})  →  ${nenne(betroffeneDateien(b.summe))}`),
);

melde(
  `✗ ${beschaedigt.length} Block/Blöcke passen nicht mehr zu ihrem Fingerabdruck:`,
  beschaedigt.map((b) => `${b.summe.slice(0, 12)}… — ${b.grund}  →  ${nenne(betroffeneDateien(b.summe))}`),
);

melde(
  `✗ ${insLeere.length} Verweis(e) auf Blöcke, die es nicht gibt:`,
  insLeere.map((v) => `${v.summe.slice(0, 12)}…  →  ${nenne(betroffeneDateien(v.summe))}`),
);

melde(
  `✗ ${ohneBloecke.length} Datei(en) gelten als abgelegt, haben aber keinen einzigen Block:`,
  ohneBloecke.map((d) => `${d.name} (${d.art} ${d.datei_id ?? d.id})`),
);

melde(
  `· ${verwaisteEintraege.length} Blockverweis(e) ohne Datei — belegen Platz, schaden aber nichts:`,
  verwaisteEintraege.map((v) => `${v.art} ${v.datei_id}`),
);

melde(
  `· ${zaehlerSchief.length} Verweiszähler stimmen nicht mit den Zeilen überein:`,
  zaehlerSchief.map((z) => `${z.summe.slice(0, 12)}… — Zähler ${z.verweise}, wirklich ${z.wirklich}`),
);

if (karteileichen.length) {
  console.log(`  · ${karteileichen.length} Blockdatei(en) auf der Platte ohne Eintrag (${mb(karteileichenPlatz)}).\n`);
}

melde(
  `· ${herrenlos.length} ganze Datei(en) ohne Zeile in der Datenbank (${mb(herrenlosPlatz)}):`,
  herrenlos.map((d) => `${path.basename(d.pfad)} — ${mb(d.groesse)}`),
);

const schwer = fehlen.length + beschaedigt.length + insLeere.length + ohneBloecke.length;
const leicht = verwaisteEintraege.length + zaehlerSchief.length + karteileichen.length + herrenlos.length;

if (!schwer && !leicht) {
  console.log('  Alles in Ordnung: jeder Block liegt da, wo er hingehört, und trägt den Inhalt, den sein Name verspricht.\n');
} else if (!schwer) {
  console.log('  Kein Inhalt beschädigt. Aufzuräumen gibt es trotzdem etwas — siehe oben.\n');
} else {
  /* Der Weg zurück steht in der Sicherung selbst — dort und nicht hier, weil
     er sich mit dem Sicherungswerkzeug ändert und eine Abschrift an zweiter
     Stelle irgendwann falsch wird. Das `-n` beim Kopieren ist der Grund, warum
     das gefahrlos ist: ein vorhandener Block kann gar nicht der falsche sein,
     sein Name ist die Prüfsumme seines Inhalts. */
  console.log(
    `  ${schwer} Befund(e), die Dateien betreffen. Die fehlenden Blöcke stehen in der\n`
    + '    Sicherung neben der Datenbank; wie sie zurückkommen, steht in\n'
    + '    data/sicherungen/LIESMICH.txt.\n',
  );
}

process.exit(schwer ? 1 : 0);
