import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const root = process.cwd();

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

const dataDir = path.resolve(root, str('DATA_DIR', './data'));
const uploadDir = path.resolve(root, str('UPLOAD_DIR', path.join(dataDir, 'uploads')));
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

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

export type AiProvider = 'groq' | 'openai' | 'deepl' | 'libre' | 'demo';

export const config = {
  port: int('PORT', 8787),
  host: str('HOST', '0.0.0.0'),
  jwtSecret: resolveSecret(),
  tokenTtlSeconds: int('TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
  dataDir,
  uploadDir,
  dbFile: path.join(dataDir, 'stellium.db'),
  maxUploadBytes: int('MAX_UPLOAD_MB', 50) * 1024 * 1024,
  workspaceName: str('WORKSPACE_NAME', 'Stellium'),

  ai: {
    provider: (str('AI_PROVIDER', 'groq') as AiProvider),
    groq: {
      apiKey: str('GROQ_API_KEY'),
      baseUrl: str('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
      model: str('GROQ_MODEL', 'llama-3.3-70b-versatile'),
      fastModel: str('GROQ_FAST_MODEL', 'llama-3.1-8b-instant'),
    },
    openai: {
      apiKey: str('OPENAI_API_KEY'),
      baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      model: str('OPENAI_MODEL', 'gpt-4o-mini'),
      fastModel: str('OPENAI_FAST_MODEL', 'gpt-4o-mini'),
    },
    deepl: {
      apiKey: str('DEEPL_API_KEY'),
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
