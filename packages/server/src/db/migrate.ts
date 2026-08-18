import { db } from './index.js';

/**
 * Spalten nachrüsten, die in älteren Datenbanken fehlen.
 * Neue Tabellen erledigt schema.sql mit CREATE TABLE IF NOT EXISTS —
 * für Spalten gibt es kein "IF NOT EXISTS", deshalb dieser Weg.
 */
const COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'users',    column: 'status_expires_at',  definition: 'INTEGER' },
  { table: 'users',    column: 'notification_sound', definition: "TEXT NOT NULL DEFAULT 'ping'" },
  { table: 'users',    column: 'translation_speed',  definition: "TEXT NOT NULL DEFAULT 'balanced'" },
  { table: 'messages', column: 'forwarded_from',     definition: 'TEXT' },
  { table: 'messages', column: 'kind',               definition: "TEXT NOT NULL DEFAULT 'text'" },
];

export function migrate(): void {
  for (const { table, column, definition } of COLUMNS) {
    const existing = db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!existing.length) continue;                       // Tabelle gibt es noch nicht
    if (existing.some((c) => c.name === column)) continue; // Spalte ist schon da
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] Spalte ${table}.${column} ergänzt`);
  }
}
