/**
 * Ein eigener Server nur für einen Prüflauf.
 *
 * Manche Prüfungen brauchen ein Konto mit vollen Rechten — Konten anlegen,
 * Rollen ändern, Anbieter umstellen. Auf der Entwicklungsdatenbank ist das
 * Testkonto ein gewöhnliches Mitglied, und jede solche Prüfung endete mit 403.
 * Statt Rechte von Hand zu verbiegen, entsteht hier eine frische Datenbank:
 * der erste Zugang ist dort immer der Owner, und nach dem Lauf ist alles weg.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';

const PASSWORT = `Probe-${crypto.randomBytes(9).toString('base64url')}`;

/**
 * Was frühere Läufe liegengelassen haben, wegräumen.
 *
 * Vor der Frist im Herunterfahren des Servers überlebten Probeserver ihr
 * SIGTERM und ließen ihren Datenordner stehen — hier lagen 61 davon. Der Platz
 * ist das kleinere Übel; das größere war, dass die zugehörigen Prozesse noch
 * Ports hielten. Angefasst wird nur, was seit über einer Stunde niemand mehr
 * berührt hat: ein Ordner, an dem gerade ein anderer Prüflauf arbeitet, ist
 * jünger, und den darf man ihm nicht unter den Füßen wegziehen.
 */
function altlastenWegraeumen() {
  const grenze = Date.now() - 60 * 60 * 1000;
  let weg = 0;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('stellium-probe-')) continue;
      const voll = path.join(os.tmpdir(), name);
      try {
        if (fs.statSync(voll).mtimeMs > grenze) continue;
        fs.rmSync(voll, { recursive: true, force: true });
        weg += 1;
      } catch { /* gehört jemand anderem oder ist schon weg */ }
    }
  } catch { /* kein Zugriff auf das Temp-Verzeichnis — dann eben nicht */ }
  return weg;
}

/** Die jüngste Änderung irgendwo unter diesem Ordner. 0, wenn es ihn nicht gibt. */
function juengste(ordner) {
  let neuste = 0;
  const gehe = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) gehe(p);
      else neuste = Math.max(neuste, fs.statSync(p).mtimeMs);
    }
  };
  try { gehe(ordner); } catch { return 0; }
  return neuste;
}

/**
 * Den Server bauen, wenn der Bau älter ist als die Quellen.
 *
 * Gestartet wird `dist/index.js`, nicht der Quelltext. Ohne diese Prüfung
 * misst ein Lauf also einen Stand, den es so nicht mehr gibt — und meldet
 * grün, was nie ausgeführt wurde. Genau daran ist hier ein Umbau am Gateway
 * vorbeigelaufen: die Quellen waren geändert, die Prüfung sprach mit dem Bau
 * von vorgestern und war zufrieden.
 *
 * Der Sperrordner ist nötig, weil hier mehrere Prüfläufe nebeneinander
 * arbeiten. `mkdir` gelingt nur einem von ihnen; die anderen warten, bis der
 * Bau fertig ist, statt ihn im selben Verzeichnis zu überschreiben.
 */
function bauenWennNoetig() {
  const quellen = Math.max(juengste('packages/server/src'), juengste('packages/shared/src'));
  if (juengste('packages/server/dist') >= quellen) return false;

  const sperre = path.join(os.tmpdir(), 'stellium-bau.lock');
  for (let versuch = 0; versuch < 120; versuch++) {
    try {
      fs.mkdirSync(sperre);
      try {
        execFileSync('npm', ['run', 'build:server'], { stdio: 'pipe' });
        return true;
      } finally { fs.rmSync(sperre, { recursive: true, force: true }); }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Ein anderer Lauf baut gerade. Kurz warten und nachsehen, ob er fertig ist.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      if (juengste('packages/server/dist') >= quellen) return false;
    }
  }
  throw new Error('Der Bau ist seit zwei Minuten gesperrt — läuft noch einer?');
}

export async function probeserver({ mitSchluessel = false } = {}) {
  altlastenWegraeumen();
  bauenWennNoetig();
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-probe-'));
  const daten = path.join(ordner, 'daten');
  fs.mkdirSync(daten, { recursive: true });

  // Der Tresor mit dem Groq-Schlüssel, falls die Prüfung KI braucht.
  if (mitSchluessel) {
    const tresor = 'packages/server/data/secrets.enc';
    if (fs.existsSync(tresor)) fs.copyFileSync(tresor, path.join(daten, 'secrets.enc'));
  }

  /* Der Port wurde einmal aus der Uhrzeit gewürfelt (`hrtime % 150`). Starten
     zwei Prüfläufe im selben Augenblick — und das tun sie, wenn mehrere
     Agenten gleichzeitig arbeiten —, greifen beide nach demselben Port, einer
     scheitert, und die Prüfung meldet einen Fehler, den es gar nicht gibt.
     Genau so sind hier Läufe falsch rot geworden.

     Deshalb wird der Port jetzt vom Betriebssystem vergeben: kurz auf 0
     lauschen, die Nummer merken, wieder schließen. Das Zeitfenster bis der
     Server sie belegt ist winzig, und wer sie doch wegschnappt, wird beim
     Warten auf den Start bemerkt statt still verwechselt. */
  const port = await new Promise((fertig, schiefgegangen) => {
    const sucher = net.createServer();
    sucher.unref();
    sucher.on('error', schiefgegangen);
    sucher.listen(0, '127.0.0.1', () => {
      const { port: p } = sucher.address();
      sucher.close(() => fertig(p));
    });
  });

  /* `detached` steckt das Kind in eine eigene Prozessgruppe. Ohne das trifft
     ein Abbruch nur den Server selbst, und was er gestartet hat, läuft weiter. */
  const kind = spawn('node', ['dist/index.js'], {
    cwd: 'packages/server',
    env: { ...process.env, DATA_DIR: daten, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let beendet = false;
  kind.on('exit', () => { beendet = true; });

  /* Kein SIGTERM ins Blaue. Erst höflich, dann bestimmt, und in beiden Fällen
     wird abgewartet — sonst kehrt `stop()` zurück, während der Prozess noch
     lebt und seinen Port hält. Auch das hat hier Prüfläufe falsch rot gemacht. */
  const beenden = async () => {
    if (beendet) return;
    const gruppe = (signal) => { try { process.kill(-kind.pid, signal); } catch { try { kind.kill(signal); } catch { /* schon weg */ } } };
    gruppe('SIGTERM');
    const frist = Date.now() + 3000;
    while (!beendet && Date.now() < frist) await new Promise((f) => setTimeout(f, 50));
    if (!beendet) {
      gruppe('SIGKILL');
      const harteFrist = Date.now() + 2000;
      while (!beendet && Date.now() < harteFrist) await new Promise((f) => setTimeout(f, 50));
    }
  };

  /* Auch wenn der Prüflauf abstürzt oder abgebrochen wird, bleibt nichts
     liegen. Ohne das sammeln sich Server an, die Ports besetzen — und der
     nächste Lauf scheitert an einem Gespenst. */
  const aufraeumen = () => { try { process.kill(-kind.pid, 'SIGKILL'); } catch { /* schon weg */ } };
  process.once('exit', aufraeumen);
  process.once('SIGINT', () => { aufraeumen(); process.exit(130); });
  process.once('SIGTERM', () => { aufraeumen(); process.exit(143); });
  process.once('uncaughtException', (f) => { aufraeumen(); throw f; });

  let ausgabe = '';
  kind.stdout.on('data', (d) => { ausgabe += d; });
  kind.stderr.on('data', (d) => { ausgabe += d; });

  const S = `http://127.0.0.1:${port}`;
  const bis = Date.now() + 30000;
  let da = false;
  while (Date.now() < bis && !da) {
    /* Wenn das eigene Kind schon gestorben ist, antwortet auf diesem Port
       jemand anderes — ein liegengebliebener Server aus einem früheren Lauf.
       Den für den eigenen zu halten ist die heimtückischste Fehlerquelle hier:
       die Prüfung läuft dann gegen eine fremde Datenbank und scheitert an
       etwas, das mit ihrem Gegenstand nichts zu tun hat. */
    if (kind.exitCode !== null || kind.signalCode !== null) {
      throw new Error(`Der Probeserver ist beim Starten gestorben (${
        kind.exitCode ?? kind.signalCode}):\n${ausgabe.slice(-800)}`);
    }
    try { da = Boolean((await fetch(`${S}/api/releases`)).status); } catch { /* noch nicht */ }
    if (!da) await new Promise((f) => setTimeout(f, 250));
  }
  if (!da) {
    await beenden();
    throw new Error(`Probeserver startet nicht:\n${ausgabe.slice(-800)}`);
  }

  // Der Einmal-Zugang steht in der Startausgabe.
  const konto = (ausgabe.match(/Benutzername\s+(\S+)/) ?? [])[1] ?? 'don';
  const einmal = (ausgabe.match(/Einmal-Passwort\s+(\S+)/) ?? [])[1];
  if (!einmal) {
    await beenden();
    throw new Error(`Kein Einmal-Passwort in der Ausgabe:\n${ausgabe.slice(-800)}`);
  }

  const erst = await (await fetch(`${S}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: konto, password: einmal }),
  })).json();

  await fetch(`${S}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${erst.token}` },
    body: JSON.stringify({
      handle: konto, displayName: 'Probe-Leitung',
      email: `${konto}@probe.test`, newPassword: PASSWORT, language: 'de',
    }),
  });

  const angemeldet = await (await fetch(`${S}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: konto, password: PASSWORT }),
  })).json();

  if (!angemeldet.token) {
    await beenden();
    throw new Error(`Die Einrichtung des Probekontos ist fehlgeschlagen: ${
      angemeldet.error ?? JSON.stringify(angemeldet).slice(0, 200)}`);
  }

  return {
    S,
    token: angemeldet.token,
    login: konto,
    passwort: PASSWORT,
    kopf: { 'content-type': 'application/json', authorization: `Bearer ${angemeldet.token}` },
    ausgabe: () => ausgabe,
    /** Wo die Datenbank liegt — für Prüfungen, die hineinsehen müssen. */
    datenbank: `${daten}/stellium.db`,
    /**
     * Das ganze Datenverzeichnis.
     *
     * Für Prüfungen, die nicht nur in die Datenbank sehen, sondern auch auf
     * die Platte: hochgeladene Dateien liegen dort und nicht in der Tabelle.
     * Eine Zusage über Dateien lässt sich nur dort nachprüfen, wo die Bytes
     * wirklich liegen.
     */
    datenordner: daten,
    /** Wartet, bis der Prozess wirklich weg ist — sonst hält er seinen Port. */
    async stop() {
      await beenden();
      fs.rmSync(ordner, { recursive: true, force: true });
    },
  };
}
