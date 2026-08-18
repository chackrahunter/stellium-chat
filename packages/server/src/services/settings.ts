import { db } from '../db/index.js';

/** Server-weite Einstellungen als einfache Schlüssel/Wert-Ablage. */

export function getSetting(key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(key: string, value: string | null, userId: string): void {
  if (value === null) {
    db.run('DELETE FROM app_settings WHERE key = ?', key);
    return;
  }
  db.run(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    key, value, userId, Date.now(),
  );
}

export const SETTING_MODEL_QUALITY = 'ai.model.quality';
export const SETTING_MODEL_FAST = 'ai.model.fast';
