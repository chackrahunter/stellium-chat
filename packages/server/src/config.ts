import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Vault, redact, resolvePassphrase } from './secrets.js';

/**
 * Die Daten hängen am Server-Paket, nicht am Arbeitsverzeichnis.
 *
 * Vorher entschied das aktuelle Verzeichnis darüber, wo Datenbank und Tresor
 * liegen: aus dem Projektwurzelverzeichnis gestartet fand der Server einen
 * anderen Datenbestand als aus packages/server heraus — mit leerer Datenbank
 * und ohne Schlüssel, ohne dass irgendetwas kaputt aussah.
 *
 * Diese Datei liegt in src/ beziehungsweise dist/; eine Ebene darüber ist das
 * Paketverzeichnis.
 */
const paketWurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

/**
 * Ein ausdrücklich gesetzter Pfad gilt relativ zum Arbeitsverzeichnis — wer ihn
 * angibt, meint das, was er gerade vor sich hat. Die Vorgabe dagegen hängt am
 * Paket und bleibt damit überall dieselbe.
 */
function ordner(name: string, vorgabe: string): string {
  const gesetzt = str(name);
  return gesetzt ? path.resolve(process.cwd(), gesetzt) : path.resolve(paketWurzel, vorgabe);
}

const dataDir = ordner('DATA_DIR', 'data');
const uploadDir = ordner('UPLOAD_DIR', path.join(dataDir, 'uploads'));
fs.mkdirSync(dataDir, { recursive: true });
const storageDir = ordner('STORAGE_DIR', path.join(dataDir, 'storage'));
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(storageDir, { recursive: true });
const releaseDir = ordner('RELEASE_DIR', path.join(dataDir, 'releases'));
fs.mkdirSync(releaseDir, { recursive: true });

/** Secret persistieren, damit Tokens einen Neustart überleben. */
function resolveSecret(): string {
  const fromEnv = str('JWT_SECRET');
  if (fromEnv && fromEnv !== 'bitte-aendern-langer-zufalls-string') return fromEnv;
  const file = path.join(dataDir, '.jwt-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const gen = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, gen, { mode: 0o600 });
    console.warn('[config] JWT_SECRET nicht gesetzt — generiertes Secret in data/.jwt-secret abgelegt.');
    return gen;
  }
}

/* ── Verschlüsselte Schlüssel ─────────────────────────────────── */

/**
 * Schlüssel kommen entweder aus der Umgebung oder aus dem verschlüsselten
 * Tresor. Die Umgebung gewinnt, weil sie ausdrücklich gesetzt wurde — dann
 * gibt es aber einen deutlichen Hinweis, dass der Schlüssel im Klartext liegt.
 */
const vault = new Vault(path.join(dataDir, 'secrets.enc'));

let vaultSecrets: Record<string, string> | null = null;
export let vaultStatus: 'aus' | 'offen' | 'verschlossen' = 'aus';

function openVault(): Record<string, string> {
  if (vaultSecrets) return vaultSecrets;
  if (!vault.exists()) { vaultStatus = 'aus'; vaultSecrets = {}; return vaultSecrets; }

  const passphrase = resolvePassphrase();
  if (!passphrase) {
    vaultStatus = 'verschlossen';
    console.warn(
      '[secrets] Es gibt einen verschlüsselten Tresor, aber kein Masterpasswort.\n'
      + '          Setze STELLIUM_MASTER_PASSPHRASE oder lege es mit\n'
      + '          "npm run secret -w @stellium/server -- setzen groq" in der Keychain ab.',
    );
    vaultSecrets = {};
    return vaultSecrets;
  }

  try {
    vaultSecrets = vault.load(passphrase.passphrase);
    vaultStatus = 'offen';
  } catch (err) {
    vaultStatus = 'verschlossen';
    console.error(`[secrets] Tresor lässt sich nicht öffnen: ${(err as Error).message}`);
    vaultSecrets = {};
  }
  return vaultSecrets;
}

/** Schlüssel holen: erst Umgebung, dann Tresor. */
function secret(envName: string, vaultName: string): string {
  const fromEnv = str(envName);
  if (fromEnv) {
    if (vault.exists() && openVault()[vaultName]) {
      console.warn(
        `[secrets] ${envName} steht im Klartext in der Umgebung und überschreibt den`
        + ' verschlüsselten Wert. Entferne die Zeile aus der .env, damit der Tresor greift.',
      );
    }
    return fromEnv;
  }
  return openVault()[vaultName] ?? '';
}

export type AiProvider = 'groq' | 'openai' | 'deepl' | 'libre' | 'demo';

/**
 * Welcher Stand hier gerade läuft.
 *
 * Der Server kannte seine eigene Version bisher nicht — dadurch stand in der
 * Aktualisierungsansicht "alles aktuell", während der Server noch auf dem
 * alten Stand lief. Die Nummer steht in der Version der App: aus demselben
 * Quelltextstand entsteht beides, und das Serverpaket trägt sie mit.
 */
function eigeneVersion(): string {
  for (const kandidat of [
    path.resolve(paketWurzel, '../desktop/package.json'),
    path.resolve(paketWurzel, '../../packages/desktop/package.json'),
    path.resolve(paketWurzel, 'package.json'),
  ]) {
    try {
      const v = JSON.parse(fs.readFileSync(kandidat, 'utf8')).version;
      if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) return v;
    } catch { /* nächster Kandidat */ }
  }
  return '0.0.0';
}

export const config = {
  version: eigeneVersion(),
  port: int('PORT', 8787),
  host: str('HOST', '0.0.0.0'),
  jwtSecret: resolveSecret(),
  tokenTtlSeconds: int('TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
  dataDir,
  uploadDir,
  storageDir,
  releaseDir,
  dbFile: path.join(dataDir, 'stellium.db'),
  maxUploadBytes: int('MAX_UPLOAD_MB', 50) * 1024 * 1024,
  workspaceName: str('WORKSPACE_NAME', 'Stellium'),

  /**
   * Das erste Konto beim Erststart. Bewusst nicht "admin" oder "root" als
   * Vorgabe: das sind die ersten Namen, die bei Anmeldeversuchen durchprobiert
   * werden. Ohne Angabe wird der Name des angemeldeten Systembenutzers
   * verwendet.
   */
  owner: {
    handle: str('OWNER_HANDLE'),
    name: str('OWNER_NAME'),
  },

  ai: {
    provider: (str('AI_PROVIDER', 'groq') as AiProvider),
    groq: {
      apiKey: secret('GROQ_API_KEY', 'groq'),
      baseUrl: str('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
      // Leer = der Server holt die Modell-Liste bei Groq und wählt selbst.
      // Eine gesetzte ID nagelt das Modell fest.
      model: str('GROQ_MODEL'),
      fastModel: str('GROQ_FAST_MODEL'),
    },
    openai: {
      apiKey: secret('OPENAI_API_KEY', 'openai'),
      baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      model: str('OPENAI_MODEL'),
      fastModel: str('OPENAI_FAST_MODEL'),
    },
    deepl: {
      apiKey: secret('DEEPL_API_KEY', 'deepl'),
      get baseUrl() {
        const key = str('DEEPL_API_KEY');
        return str('DEEPL_BASE_URL', key.endsWith(':fx')
          ? 'https://api-free.deepl.com/v2'
          : 'https://api.deepl.com/v2');
      },
    },
    libre: {
      baseUrl: str('LIBRE_URL', 'http://localhost:5000'),
      apiKey: str('LIBRE_API_KEY'),
    },
    memoryCacheSize: int('TRANSLATION_MEMORY_CACHE', 5000),
    requestTimeoutMs: int('AI_TIMEOUT_MS', 25_000),
  },
} as const;

/** Ist ein echter Übersetzungs-/KI-Provider konfiguriert? */
export function aiConfigured(): boolean {
  switch (config.ai.provider) {
    case 'groq': return Boolean(config.ai.groq.apiKey);
    case 'openai': return Boolean(config.ai.openai.apiKey);
    case 'deepl': return Boolean(config.ai.deepl.apiKey);
    case 'libre': return Boolean(config.ai.libre.baseUrl);
    default: return false;
  }
}

/** Kann der Provider mehr als übersetzen (Zusammenfassungen, Smart Replies)? */
export function assistantAvailable(): boolean {
  return (config.ai.provider === 'groq' && Boolean(config.ai.groq.apiKey)) ||
         (config.ai.provider === 'openai' && Boolean(config.ai.openai.apiKey));
}


/** Woher der aktive Schlüssel stammt — nur für die Anzeige, nie der Wert selbst. */
export function secretOrigin(): { quelle: 'umgebung' | 'tresor' | 'keiner'; tresor: typeof vaultStatus; hinweis: string } {
  const key = config.ai.provider === 'groq' ? config.ai.groq.apiKey
    : config.ai.provider === 'openai' ? config.ai.openai.apiKey
    : config.ai.provider === 'deepl' ? config.ai.deepl.apiKey : '';

  if (!key) return { quelle: 'keiner', tresor: vaultStatus, hinweis: 'Kein Schlüssel gefunden.' };

  const ausUmgebung = Boolean(
    (config.ai.provider === 'groq' && process.env.GROQ_API_KEY)
    || (config.ai.provider === 'openai' && process.env.OPENAI_API_KEY)
    || (config.ai.provider === 'deepl' && process.env.DEEPL_API_KEY),
  );

  return {
    quelle: ausUmgebung ? 'umgebung' : 'tresor',
    tresor: vaultStatus,
    hinweis: ausUmgebung
      ? `im Klartext aus der Umgebung — ${redact(key)}`
      : `entschlüsselt aus dem Tresor — ${redact(key)}`,
  };
}
