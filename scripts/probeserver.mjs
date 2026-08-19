/**
 * Ein eigener Server nur für einen Prüflauf.
 *
 * Manche Prüfungen brauchen ein Konto mit vollen Rechten — Konten anlegen,
 * Rollen ändern, Anbieter umstellen. Auf der Entwicklungsdatenbank ist das
 * Testkonto ein gewöhnliches Mitglied, und jede solche Prüfung endete mit 403.
 * Statt Rechte von Hand zu verbiegen, entsteht hier eine frische Datenbank:
 * der erste Zugang ist dort immer der Owner, und nach dem Lauf ist alles weg.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PASSWORT = `Probe-${crypto.randomBytes(9).toString('base64url')}`;

export async function probeserver({ mitSchluessel = false } = {}) {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-probe-'));
  const daten = path.join(ordner, 'daten');
  fs.mkdirSync(daten, { recursive: true });

  // Der Tresor mit dem Groq-Schlüssel, falls die Prüfung KI braucht.
  if (mitSchluessel) {
    const tresor = 'packages/server/data/secrets.enc';
    if (fs.existsSync(tresor)) fs.copyFileSync(tresor, path.join(daten, 'secrets.enc'));
  }

  const port = 8800 + Math.floor(Number(process.hrtime.bigint() % 150n));
  const kind = spawn('node', ['dist/index.js'], {
    cwd: 'packages/server',
    env: { ...process.env, DATA_DIR: daten, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let ausgabe = '';
  kind.stdout.on('data', (d) => { ausgabe += d; });
  kind.stderr.on('data', (d) => { ausgabe += d; });

  const S = `http://127.0.0.1:${port}`;
  const bis = Date.now() + 30000;
  let da = false;
  while (Date.now() < bis && !da) {
    try { da = Boolean((await fetch(`${S}/api/releases`)).status); } catch { /* noch nicht */ }
    if (!da) await new Promise((f) => setTimeout(f, 250));
  }
  if (!da) {
    kind.kill();
    throw new Error(`Probeserver startet nicht:\n${ausgabe.slice(-800)}`);
  }

  // Der Einmal-Zugang steht in der Startausgabe.
  const konto = (ausgabe.match(/Benutzername\s+(\S+)/) ?? [])[1] ?? 'don';
  const einmal = (ausgabe.match(/Einmal-Passwort\s+(\S+)/) ?? [])[1];
  if (!einmal) {
    kind.kill();
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
    kind.kill();
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
    stop() {
      try { kind.kill(); } catch { /* schon weg */ }
      fs.rmSync(ordner, { recursive: true, force: true });
    },
  };
}
