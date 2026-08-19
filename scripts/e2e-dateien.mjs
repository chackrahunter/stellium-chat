/**
 * Verschlüsselte Dateien — sieht die Oberfläche das auch so?
 *
 * e2e-vertraulich.mjs redet mit dem Server und beweist dort, dass der Host
 * nicht mitliest. Was es nicht zeigen kann: dass eine Person danach noch
 * etwas davon hat. Genau da liegt bei Dateien die Bruchstelle — der Server
 * kann ein verschlüsseltes Bild nicht mehr als Bild ausliefern, also muss die
 * App es holen, aufschließen und selbst zeichnen. Ein `<img src>` auf die
 * Serveradresse ergäbe ein kaputtes Bild, und niemand außer diesem Lauf würde
 * es merken.
 *
 * Deshalb reicht hier kein Statuscode: geprüft wird, was der Browser aus der
 * Antwort macht (`naturalWidth` ist erst größer als null, wenn er das Bild
 * wirklich dekodiert hat) und was beim Herunterladen wirklich auf der Platte
 * landet.
 *
 * Alles läuft über die Oberfläche und nicht über einen eigenen `import()` der
 * Krypto-Ebene: ein zweiter Import wäre eine zweite Ausfertigung mit eigenem
 * Zustand — sie kennt weder die eigene Kennung noch die Kanalschlüssel, und
 * der Lauf prüfte dann etwas, das es in der App gar nicht gibt.
 *
 * Braucht die Oberfläche unter http://localhost:5173 (`npm run dev`). Der
 * Server kommt aus dem Lauf selbst — eine frische Datenbank, damit das
 * Probekonto volle Rechte hat und niemandes Daten im Weg liegen.
 *
 *   node scripts/e2e-dateien.mjs
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { probeserver } from './probeserver.mjs';

const APP = process.env.STELLIUM_APP ?? 'http://localhost:5173';
const probe = await probeserver();
const S = probe.S;

const ergebnisse = [];
const pruefe = async (n, f) => {
  try { const x = await f(); ergebnisse.push(1); console.log(`  ✓ ${n}${x ? ` — ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/**
 * Ein echtes PNG bauen — kein Behelfsbild.
 *
 * Ein Ein-mal-ein-Pixel-Bild bestünde die Prüfung auch dann noch, wenn beim
 * Entschlüsseln fast alles schiefginge: bei einem Pixel gibt es kaum etwas
 * kaputtzumachen. Ein richtiges Bild mit Muster geht nur dann auf, wenn jedes
 * Stück in der richtigen Reihenfolge zurückkommt.
 *
 * Der Textbrocken am Ende steht hinter IEND und ändert am Bild nichts — er ist
 * die Marke, nach der auf der Platte gesucht wird.
 */
function png(breite, hoehe) {
  const crc = (bytes) => {
    let c = ~0;
    for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const stueck = (typ, daten) => {
    const laenge = Buffer.alloc(4); laenge.writeUInt32BE(daten.length);
    const rumpf = Buffer.concat([Buffer.from(typ, 'ascii'), daten]);
    const summe = Buffer.alloc(4); summe.writeUInt32BE(crc(rumpf));
    return Buffer.concat([laenge, rumpf, summe]);
  };
  const kopf = Buffer.alloc(13);
  kopf.writeUInt32BE(breite, 0); kopf.writeUInt32BE(hoehe, 4);
  kopf[8] = 8; kopf[9] = 2;
  const zeilen = Buffer.concat(Array.from({ length: hoehe }, (_, y) => Buffer.concat([
    Buffer.from([0]),
    Buffer.concat(Array.from({ length: breite }, (_, x) => (
      (Math.floor(x / 40) + Math.floor(y / 40)) % 2 === 0
        ? Buffer.from([124, 92, 255]) : Buffer.from([34, 211, 238])))),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    stueck('IHDR', kopf), stueck('IDAT', zlib.deflateSync(zeilen)), stueck('IEND', Buffer.alloc(0)),
  ]);
}

const MARKE = `UI-GEHEIM-${Date.now().toString(36)}`;
const BILD = Buffer.concat([png(320, 200), Buffer.from(MARKE, 'utf8')]);
const ALTBILD = Buffer.concat([png(200, 120), Buffer.from(`${MARKE}-ALT`, 'utf8')]);
const ALTBILDDATEI = '/tmp/stellium-ui-altbild.png';
fs.writeFileSync(ALTBILDDATEI, ALTBILD);
const BILDDATEI = '/tmp/stellium-ui-bild.png';
fs.writeFileSync(BILDDATEI, BILD);

const PAPIER = `PRIVAT-${MARKE}: nur für mich.`;
const PAPIERDATEI = '/tmp/stellium-ui-privat.txt';
fs.writeFileSync(PAPIERDATEI, PAPIER);

const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({
  viewport: { width: 1400, height: 950 }, locale: 'de-DE', acceptDownloads: true,
})).newPage();
p.on('console', (m) => { if (m.type() === 'error') console.log('    [browser]', m.text().slice(0, 160)); });
await p.goto(APP);
await p.evaluate(([s, t]) => {
  localStorage.setItem('stellium.serverUrl', s);
  localStorage.setItem('stellium.token', t);
  localStorage.setItem('stellium.tourGesehen', 'ja');
}, [S, probe.token]);
await p.reload();
await p.waitForSelector('.app', { timeout: 20000 });
await p.waitForTimeout(2500);

console.log('\nVerschlossener Anhang in der Oberfläche');

let kanalId = null;

await pruefe('Vor der Umstellung geht ein Bild noch offen hinein', async () => {
  /* Der Fall, um den es bei Punkt vier geht: ein Kanal wird nachträglich
     vertraulich gestellt. Was vorher hochgeladen wurde, liegt weiter offen da
     — der Server kann es nicht nachträglich verschließen, er hat den Schlüssel
     nicht. Hier entsteht genau so ein Anhang. */
  kanalId = await p.evaluate(async () => {
    const store = window.__stelliumStore;
    const name = `ui-vertraulich-${Math.random().toString(36).slice(2, 7)}`;
    store.getState().createChannel({ kind: 'private', name });
    const bis = Date.now() + 8000;
    let kanal = null;
    while (Date.now() < bis && !kanal) {
      kanal = Object.values(store.getState().channels).find((c) => c.name === name);
      if (!kanal) await new Promise((f) => setTimeout(f, 120));
    }
    if (!kanal) throw new Error('Kanal kam nicht an');
    store.getState().openChannel(kanal.id);
    return kanal.id;
  });
  muss(kanalId, 'kein Kanal');

  await p.waitForSelector('textarea', { timeout: 15000 });
  await Promise.all([
    p.waitForResponse((r) => r.url().includes('/api/uploads') && r.request().method() === 'POST',
      { timeout: 60000 }),
    p.setInputFiles('input[type=file]', ALTBILDDATEI),
  ]);
  await p.waitForTimeout(500);
  await p.fill('textarea', 'Noch offen');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelectorAll('.att-img').length > 0,
    null, { timeout: 20000 });
  const quelle = await p.getAttribute('.att-img', 'src');
  muss(!quelle.startsWith('blob:'), 'der Anhang war schon verschlossen');
  return 'offen hochgeladen, offen angezeigt';
});

await pruefe('Kanal über die Oberfläche vertraulich stellen', async () => {
  /* Alles über die Oberfläche, kein Griff in die Module: nur so läuft es durch
     dieselbe Fassung von lib/vertraulich.ts wie in der App. Ein eigener
     import() im Prüfling wäre eine zweite Ausfertigung mit eigenem Zustand —
     und die kennt weder die eigene Kennung noch die Kanalschlüssel. */
  await p.waitForTimeout(900);
  await p.evaluate(() => window.__stelliumStore.getState().setOverlay('channelSettings'));
  await p.waitForTimeout(800);
  await p.getByRole('switch', { name: 'Vertraulich stellen' }).click();
  await p.getByRole('button', { name: 'Kanal vertraulich stellen' }).click();
  await p.waitForFunction((id) => window.__stelliumStore.getState().channels[id]?.vertraulich,
    kanalId, { timeout: 10000 });
  await p.evaluate(() => window.__stelliumStore.getState().setOverlay(null));
  await p.waitForTimeout(800);
  return kanalId.slice(0, 12) + '…';
});

await pruefe('Ein Bild anhängen und absenden', async () => {
  await p.waitForSelector('textarea', { timeout: 15000 });
  /* Auf die Antwort des Uploads warten und nicht auf die Uhr. Vorher wird die
     Nachricht gar nicht abgeschickt — der Composer weist das ab, solange noch
     etwas läuft, und der Lauf prüfte dann eine Nachricht, die es nicht gibt. */
  await Promise.all([
    p.waitForResponse((r) => r.url().includes('/api/uploads') && r.request().method() === 'POST',
      { timeout: 60000 }),
    p.setInputFiles('input[type=file]', BILDDATEI),
  ]);
  await p.waitForTimeout(500);
  await p.fill('textarea', 'Anbei');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelectorAll('.msg').length > 0, null, { timeout: 15000 });
  return 'abgeschickt';
});

await pruefe('Der Server hat nur Chiffrat bekommen', async () => {
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeile = db.prepare(
    'SELECT id, name, mime, huelle, path, message_id FROM attachments ORDER BY created_at DESC LIMIT 1').get();
  db.close();
  muss(zeile, 'kein Anhang in der Datenbank');
  muss(zeile.message_id, 'der Anhang hängt an keiner Nachricht — die Nachricht ging nicht raus');
  muss(zeile.huelle, 'der Anhang trägt keine Hülle');
  muss(JSON.parse(zeile.huelle).channelId === kanalId, 'die Hülle zeigt auf einen anderen Kanal');
  muss(zeile.name !== 'stellium-ui-bild.png', `der Server kennt den Namen: "${zeile.name}"`);
  const roh = fs.readFileSync(zeile.path);
  muss(!roh.includes(Buffer.from(MARKE, 'utf8')), 'der Klartext liegt auf der Platte');
  muss(roh.subarray(0, 3).toString() === 'd1:', 'kein Umschlag');
  return `"${zeile.name}", ${zeile.mime}, Hülle kanal`;
});

await pruefe('Die Oberfläche zeigt das Bild trotzdem', async () => {
  /* Das zweite Bild im Verlauf ist das verschlossene — das erste stammt aus
     der Zeit davor und geht weiter ganz gewöhnlich über den Server. */
  await p.waitForFunction(() => document.querySelectorAll('.att-img').length >= 2,
    null, { timeout: 20000 });
  const quelle = await p.locator('.att-img').last().getAttribute('src');
  /* Die Adresse muss aus dem Arbeitsspeicher kommen. Stünde hier die Adresse
     des Servers, hätte die App das Chiffrat unbesehen an den Bildbetrachter
     weitergereicht — und der zeigte ein kaputtes Symbol. */
  muss(quelle?.startsWith('blob:'), `src ist "${String(quelle).slice(0, 40)}"`);

  /* Und dekodiert muss es sein. Ein `<img>` mit gültiger Adresse beweist
     nichts: naturalWidth ist erst dann größer als null, wenn der Browser das
     Bild wirklich gelesen hat. */
  await p.waitForFunction(() => {
    const bilder = document.querySelectorAll('.att-img');
    const img = bilder[bilder.length - 1];
    return Boolean(img && img.complete && img.naturalWidth > 0);
  }, null, { timeout: 15000 });
  const masse = await p.evaluate(() => {
    const bilder = document.querySelectorAll('.att-img');
    const img = bilder[bilder.length - 1];
    return `${img.naturalWidth}×${img.naturalHeight}`;
  });
  return `blob:… ${masse} dekodiert`;
});

await pruefe('Der Anhang aus der offenen Zeit wird als solcher gekennzeichnet', async () => {
  /* Er liegt weiter unverschlüsselt beim Server, und daran ändert die
     Umstellung nichts — nachträglich verschließen kann ihn niemand. Ihn
     stillschweigend zwischen den verschlossenen mitlaufen zu lassen wäre die
     Unehrlichkeit: wer sich auf das Schloss verlässt, soll sehen, wo es nicht
     gilt. */
  const marken = await p.locator('.att-offen-marke').count();
  muss(marken === 1, `${marken} Kennzeichnungen statt einer`);
  const text = await p.locator('.att-offen-marke').first().innerText();
  muss(/offen/i.test(text), `Text "${text}"`);

  const bilder = await p.locator('.att-img').count();
  muss(bilder === 2, `${bilder} Bilder statt zweier`);
  return `${text} — am alten Anhang, nicht am neuen`;
});

console.log('\nPrivate Datei in der Ablage');

await pruefe('Ablage öffnen und auf privat stellen', async () => {
  await p.evaluate(() => window.__stelliumStore.getState().setOverlay('files'));
  // Auf die Ablage selbst warten und nicht auf die Uhr: das Fenster fährt
  // animiert ein, und wie lange das dauert, hängt am Rechner.
  await p.waitForSelector('.dropzone', { timeout: 15000 });
  const knopf = p.getByRole('button', { name: /^Privat$/ });
  await knopf.first().waitFor({ state: 'visible', timeout: 10000 });
  await knopf.first().click();
  return 'Schalter da und gedrückt';
});

await pruefe('Eine private Datei hochladen', async () => {
  await p.locator('.dropzone').locator('xpath=preceding::input[@type="file"][1]')
    .setInputFiles(PAPIERDATEI)
    .catch(async () => {
      const felder = await p.locator('input[type=file]').all();
      await felder[felder.length - 1].setInputFiles(PAPIERDATEI);
    });
  await p.waitForSelector('.file-row', { timeout: 20000 });
  const daten = await (await fetch(`${S}/api/files`, {
    headers: { authorization: `Bearer ${probe.token}` },
  })).json();
  muss(daten.files.length === 1, `${daten.files.length} Dateien in der Ablage`);
  muss(daten.files[0].privat, 'die Datei ist nicht als privat vermerkt');
  return `${daten.files[0].name}, privat`;
});

await pruefe('Beim Server liegt auch hier nur Chiffrat', async () => {
  const db = new DatabaseSync(probe.datenbank, { readOnly: true });
  const zeile = db.prepare('SELECT path, privat, huelle FROM files ORDER BY created_at DESC LIMIT 1').get();
  db.close();
  const roh = fs.readFileSync(zeile.path);
  muss(!roh.includes(Buffer.from(PAPIER, 'utf8')), 'der Klartext liegt auf der Platte');
  muss(roh.subarray(0, 3).toString() === 'd1:', 'kein Umschlag');
  muss(JSON.parse(zeile.huelle).art === 'konto', 'falsche Hülle');
  return 'd1:{…}, Hülle konto';
});

await pruefe('Der Knopf in der Ablage schließt sie wieder auf', async () => {
  /* Ein <a href> täte es hier nicht: beim Server liegt Chiffrat. Die App muss
     die Datei holen, aufschließen und erst dann weiterreichen — genau das wird
     hier über den echten Knopf ausgelöst und am Ergebnis abgelesen. */
  /* Ein Knopf, kein Verweis: bei einer privaten Datei muss die App sie erst
     holen und aufschließen. Genau daran erkennt man hier, dass der richtige
     Weg gegangen wird. */
  const knopf = p.locator('.file-row button[title="Herunterladen"]');
  muss(await knopf.count() === 1, `${await knopf.count()} Knöpfe in der Zeile`);
  const [download] = await Promise.all([
    p.waitForEvent('download', { timeout: 20000 }),
    knopf.click(),
  ]);
  const ziel = '/tmp/stellium-ui-zurueck.txt';
  await download.saveAs(ziel);
  const text = fs.readFileSync(ziel, 'utf8');
  muss(text === PAPIER, `zurück kam "${text.slice(0, 40)}"`);
  muss(download.suggestedFilename() === 'stellium-ui-privat.txt',
    `Name "${download.suggestedFilename()}"`);
  return `${download.suggestedFilename()} · ${text.slice(0, 24)}…`;
});

await b.close();
await probe.stop();

const schlecht = ergebnisse.filter((x) => !x).length;
console.log(`\n${ergebnisse.length - schlecht}/${ergebnisse.length} bestanden`);
process.exit(schlecht ? 1 : 0);
