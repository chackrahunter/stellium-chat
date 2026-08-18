import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Verschlüsselte Ablage für API-Schlüssel.
 *
 * Was das leistet und was nicht — bitte einmal lesen, bevor man sich darauf
 * verlässt:
 *
 *  Geschützt ist der Schlüssel gegen jemanden, der die Dateien liest:
 *  ein gestohlenes Backup, eine kopierte Festplatte, ein versehentlich
 *  veröffentlichtes data/-Verzeichnis, ein Kollege mit Leserechten.
 *
 *  NICHT geschützt ist er gegen jemanden, der Code als der Serverbenutzer
 *  ausführen kann. Der Server muss den Schlüssel im Klartext an Groq schicken,
 *  also muss er ihn zur Laufzeit im Speicher haben. Das ist keine Schwäche
 *  dieser Umsetzung, sondern eine Eigenschaft der Aufgabe.
 *
 * Aufbau:
 *   Passwort  →  scrypt (N=2^17, speicherhart)  →  256-Bit-Masterkey
 *   Masterkey →  HKDF  →  zwei unabhängige Teilschlüssel
 *   Klartext  →  AES-256-GCM  →  ChaCha20-Poly1305  →  Datei
 *
 * Die Kaskade aus zwei Verfahren ist bewusst gewählt: bricht eines der beiden,
 * schützt das andere weiter. Den eigentlichen Widerstand gegen Ausprobieren
 * liefert aber scrypt, nicht die Anzahl der Verfahren.
 */

const MAGIC = 'STLM1';
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 32 };   // ~128 MB Speicher pro Versuch
const KEYCHAIN_SERVICE = 'stellium-master';
const KEYCHAIN_ACCOUNT = 'stellium';

export interface SecretStore { [name: string]: string }

/* ── Schlüsselableitung ───────────────────────────────────────── */

function deriveMaster(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    maxmem: 256 * SCRYPT.N * SCRYPT.r,
  });
}

/** Aus einem Masterkey zwei voneinander unabhängige Teilschlüssel machen. */
function subKeys(master: Buffer, salt: Buffer): { aes: Buffer; chacha: Buffer } {
  const aes = Buffer.from(crypto.hkdfSync('sha256', master, salt, Buffer.from('stellium/aes-256-gcm'), 32));
  const chacha = Buffer.from(crypto.hkdfSync('sha256', master, salt, Buffer.from('stellium/chacha20-poly1305'), 32));
  return { aes, chacha };
}

/* ── Verschlüsseln und Entschlüsseln ──────────────────────────── */

export function encrypt(plaintext: string, passphrase: string): Buffer {
  const salt = crypto.randomBytes(32);
  const master = deriveMaster(passphrase, salt);
  const { aes, chacha } = subKeys(master, salt);

  // Schicht 1: AES-256-GCM
  const ivAes = crypto.randomBytes(12);
  const c1 = crypto.createCipheriv('aes-256-gcm', aes, ivAes);
  const inner = Buffer.concat([c1.update(plaintext, 'utf8'), c1.final()]);
  const tagAes = c1.getAuthTag();

  // Schicht 2: ChaCha20-Poly1305 über das Ergebnis von Schicht 1
  const ivCha = crypto.randomBytes(12);
  const c2 = crypto.createCipheriv('chacha20-poly1305', chacha, ivCha, { authTagLength: 16 });
  const outer = Buffer.concat([c2.update(Buffer.concat([ivAes, tagAes, inner])), c2.final()]);
  const tagCha = c2.getAuthTag();

  master.fill(0); aes.fill(0); chacha.fill(0);

  const header = Buffer.from(`${MAGIC}\n`, 'utf8');
  const lengths = Buffer.alloc(4);
  lengths.writeUInt32BE(outer.length);
  return Buffer.concat([header, salt, ivCha, tagCha, lengths, outer]);
}

export function decrypt(blob: Buffer, passphrase: string): string {
  const headerEnd = blob.indexOf(0x0a) + 1;
  if (blob.subarray(0, headerEnd - 1).toString('utf8') !== MAGIC) {
    throw new Error('Unbekanntes Dateiformat — stammt die Datei von dieser Version?');
  }
  let at = headerEnd;
  const salt = blob.subarray(at, at += 32);
  const ivCha = blob.subarray(at, at += 12);
  const tagCha = blob.subarray(at, at += 16);
  const length = blob.readUInt32BE(at); at += 4;
  const outer = blob.subarray(at, at + length);

  const master = deriveMaster(passphrase, salt);
  const { aes, chacha } = subKeys(master, salt);

  try {
    const d2 = crypto.createDecipheriv('chacha20-poly1305', chacha, ivCha, { authTagLength: 16 });
    d2.setAuthTag(tagCha);
    const layer1 = Buffer.concat([d2.update(outer), d2.final()]);

    const ivAes = layer1.subarray(0, 12);
    const tagAes = layer1.subarray(12, 28);
    const inner = layer1.subarray(28);

    const d1 = crypto.createDecipheriv('aes-256-gcm', aes, ivAes);
    d1.setAuthTag(tagAes);
    return Buffer.concat([d1.update(inner), d1.final()]).toString('utf8');
  } catch {
    // Beide Verfahren sind authentifiziert — ein Fehler heißt falsches
    // Passwort oder manipulierte Datei. Welches von beidem, verraten wir nicht.
    throw new Error('Entschlüsselung fehlgeschlagen: falsches Passwort oder beschädigte Datei.');
  } finally {
    master.fill(0); aes.fill(0); chacha.fill(0);
  }
}

/* ── macOS-Keychain ───────────────────────────────────────────── */

export function keychainAvailable(): boolean {
  return process.platform === 'darwin';
}

export function readKeychain(): string | null {
  if (!keychainAvailable()) return null;
  try {
    return execFileSync('security', [
      'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Notbremse: Fragt die Keychain doch einmal interaktiv nach, darf der
      // Server nicht ewig warten. Lieber ohne Schlüssel starten und das melden.
      timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

export function writeKeychain(passphrase: string): void {
  if (!keychainAvailable()) throw new Error('Die Keychain gibt es nur auf macOS.');
  execFileSync('security', [
    'add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE,
    '-w', passphrase, '-U',
    // -A erlaubt allen Programmen dieses Benutzers den Zugriff, ohne dass
    // macOS jedes Mal nachfragt. Ohne das kann der Server nicht unbeaufsichtigt
    // starten — er bliebe an einem Dialog hängen.
    //
    // Der Schutz liegt dann darin, dass der Eintrag am Anmelde-Schlüsselbund
    // hängt: abgemeldet oder auf einem anderen Konto kommt niemand daran, und
    // die verschlüsselte Datei allein nützt nichts.
    // Wer es strenger will, lässt die Keychain weg und setzt
    // STELLIUM_MASTER_PASSPHRASE beim Start.
    '-A',
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
}

export function deleteKeychain(): void {
  if (!keychainAvailable()) return;
  try {
    execFileSync('security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE],
      { stdio: 'ignore', timeout: 5_000 });
  } catch { /* war nicht da */ }
}

/* ── Passwortquelle ───────────────────────────────────────────── */

export type PassphraseSource = 'env' | 'keychain' | 'datei' | null;

export interface ResolvedPassphrase {
  passphrase: string;
  source: Exclude<PassphraseSource, null>;
}

/**
 * Reihenfolge: Umgebungsvariable (für Server und Container), dann Keychain
 * (für Arbeitsplätze). Eine Datei mit dem Passwort neben den Daten wäre
 * sinnlos und wird deshalb bewusst nicht unterstützt.
 */
export function resolvePassphrase(): ResolvedPassphrase | null {
  const fromEnv = (process.env.STELLIUM_MASTER_PASSPHRASE ?? '').trim();
  if (fromEnv) return { passphrase: fromEnv, source: 'env' };

  const fromKeychain = readKeychain();
  if (fromKeychain) return { passphrase: fromKeychain, source: 'keychain' };

  return null;
}

/* ── Tresor ───────────────────────────────────────────────────── */

export class Vault {
  constructor(private readonly file: string) {}

  exists(): boolean { return fs.existsSync(this.file); }

  load(passphrase: string): SecretStore {
    if (!this.exists()) return {};
    const raw = decrypt(fs.readFileSync(this.file), passphrase);
    const parsed = JSON.parse(raw) as SecretStore;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Tresorinhalt ist beschädigt.');
    return parsed;
  }

  save(secrets: SecretStore, passphrase: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const blob = encrypt(JSON.stringify(secrets), passphrase);
    // Erst daneben schreiben, dann umbenennen — sonst steht bei einem Absturz
    // mitten im Schreiben eine halbe Datei da und alle Schlüssel sind weg.
    const tmp = `${this.file}.neu`;
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Nur zum Anzeigen: verrät die Namen, nie die Werte. */
  names(passphrase: string): string[] {
    return Object.keys(this.load(passphrase));
  }
}

/** Schlüssel für Logausgaben unkenntlich machen. */
export function redact(value: string | null | undefined): string {
  if (!value) return '(nicht gesetzt)';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} Zeichen)`;
}
