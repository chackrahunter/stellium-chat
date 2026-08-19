import crypto from 'node:crypto';
import {
  effectivePermissions, PERMISSION_KEYS,
  type MemberRoleName, type PermissionKey,
} from '@stellium/shared';
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { avatarColorFor, hashPassword } from '../auth.js';
import { blindIndex, decryptField, encryptField } from '../crypto/pii.js';

/* ── Einmal-Passwörter ────────────────────────────────────────── */

/**
 * Gut vorlesbares Einmal-Passwort. Bewusst ohne Zeichen, die man verwechselt
 * (0/O, 1/l/I) — es wird meist mündlich oder auf Papier weitergegeben.
 */
export function generateOneTimePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const gruppen: string[] = [];
  for (let g = 0; g < 4; g++) {
    let teil = '';
    for (let i = 0; i < 4; i++) {
      teil += alphabet[crypto.randomInt(alphabet.length)];
    }
    gruppen.push(teil);
  }
  return gruppen.join('-');   // z.B. K7QM-3XAF-9TRW-DP2H
}

const INVITE_TTL = 14 * 86_400_000;

function recordInvite(userId: string, createdBy: string): void {
  db.run(
    'INSERT INTO invites (id, user_id, created_by, created_at, expires_at, used_at) VALUES (?,?,?,?,?,NULL)',
    newId('inv_'), userId, createdBy, Date.now(), Date.now() + INVITE_TTL,
  );
}

/* ── Nachschlagen ─────────────────────────────────────────────── */

/** Login über den Blind-Index: funktioniert mit Benutzername oder E-Mail. */
export function findByLogin(login: string): { id: string; password_hash: string; disabled: number } | null {
  const idx = blindIndex(login);
  const row = db.get<{ id: string; password_hash: string; disabled: number }>(
    'SELECT id, password_hash, disabled FROM users WHERE handle_bidx = ? OR email_bidx = ?', idx, idx,
  );
  if (row) return row;

  // Konten aus der Zeit vor der Verschlüsselung
  return db.get<{ id: string; password_hash: string; disabled: number }>(
    'SELECT id, password_hash, disabled FROM users WHERE lower(handle) = lower(?) OR lower(email) = lower(?)',
    login.trim(), login.trim(),
  ) ?? null;
}

export function handleTaken(handle: string, exceptUserId?: string): boolean {
  const row = db.get<{ id: string }>('SELECT id FROM users WHERE handle_bidx = ?', blindIndex(handle));
  return Boolean(row && row.id !== exceptUserId);
}

export function emailTaken(email: string, exceptUserId?: string): boolean {
  const row = db.get<{ id: string }>('SELECT id FROM users WHERE email_bidx = ?', blindIndex(email));
  return Boolean(row && row.id !== exceptUserId);
}

/* ── Rechte ───────────────────────────────────────────────────── */

export function overridesFor(userId: string): Partial<Record<PermissionKey, boolean>> {
  const rows = db.all<{ permission: string; allowed: number }>(
    'SELECT permission, allowed FROM user_permissions WHERE user_id = ?', userId,
  );
  const out: Partial<Record<PermissionKey, boolean>> = {};
  for (const r of rows) {
    if (PERMISSION_KEYS.includes(r.permission as PermissionKey)) {
      out[r.permission as PermissionKey] = Boolean(r.allowed);
    }
  }
  return out;
}

export function permissionsFor(userId: string): Record<PermissionKey, boolean> {
  const row = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  const role = (row?.role ?? 'member') as MemberRoleName;
  return effectivePermissions(role, overridesFor(userId));
}

export function may(userId: string, permission: PermissionKey): boolean {
  return permissionsFor(userId)[permission] === true;
}

/** Recht setzen. null bedeutet: zurück zur Rollenvorgabe. */
export function setPermission(userId: string, permission: PermissionKey, allowed: boolean | null, setBy: string): void {
  if (!PERMISSION_KEYS.includes(permission)) throw new Error(`Unbekanntes Recht: ${permission}`);
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  if (!ziel) throw new Error('Konto nicht gefunden');
  if (ziel.role === 'owner') throw new Error('Dem Owner lassen sich keine Rechte nehmen.');

  if (allowed === null) {
    db.run('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?', userId, permission);
    return;
  }
  db.run(
    `INSERT INTO user_permissions (user_id, permission, allowed, set_by, set_at) VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, permission) DO UPDATE SET allowed = excluded.allowed, set_by = excluded.set_by, set_at = excluded.set_at`,
    userId, permission, allowed ? 1 : 0, setBy, Date.now(),
  );
}

export function setRole(userId: string, role: MemberRoleName, setBy: string): void {
  if (!['owner', 'admin', 'member', 'guest'].includes(role)) throw new Error('Unbekannte Rolle');
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  if (!ziel) throw new Error('Konto nicht gefunden');
  if (ziel.role === 'owner' && role !== 'owner') {
    const andere = db.get<{ n: number }>("SELECT COUNT(*) n FROM users WHERE role = 'owner' AND id <> ?", userId);
    if ((andere?.n ?? 0) === 0) throw new Error('Der letzte Owner kann seine Rolle nicht abgeben.');
  }
  db.run('UPDATE users SET role = ? WHERE id = ?', role, userId);
  // Persönliche Ausnahmen passen selten zur neuen Rolle.
  db.run('DELETE FROM user_permissions WHERE user_id = ?', userId);
  void setBy;
}

/* ── Konten anlegen und ändern ────────────────────────────────── */

export interface CreatedAccount {
  userId: string;
  handle: string;
  oneTimePassword: string;
}

/**
 * Neues Konto mit Einmal-Passwort. Benutzername und E-Mail darf die Person
 * beim ersten Login selbst setzen — der Vorschlag hier ist nur ein Platzhalter.
 */
export function createAccount(input: {
  displayName: string;
  handle?: string;
  email?: string;
  role?: MemberRoleName;
  language?: string;
  timezone?: string;
  createdBy: string;
}): CreatedAccount {
  const displayName = input.displayName.trim();
  if (displayName.length < 2) throw new Error('Bitte einen Namen angeben.');

  const handle = (input.handle?.trim().toLowerCase() || vorschlagHandle(displayName));
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(handle)) {
    throw new Error('Benutzername: 2–32 Zeichen, Kleinbuchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.');
  }
  if (handleTaken(handle)) throw new Error(`Benutzername "${handle}" ist schon vergeben.`);

  const email = input.email?.trim().toLowerCase() ?? '';
  if (email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('E-Mail ist ungültig.');
    if (emailTaken(email)) throw new Error('Diese E-Mail wird bereits verwendet.');
  }

  const passwort = generateOneTimePassword();
  const id = newId('u_');
  const jetzt = Date.now();

  db.transaction(() => {
    db.run(
      `INSERT INTO users (id, handle, handle_bidx, email, email_bidx, display_name, password_hash,
                          avatar_color, timezone, language, role, must_change_password,
                          must_complete_profile, created_by, password_set_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      id,
      encryptField(handle), blindIndex(handle),
      email ? encryptField(email) : '', email ? blindIndex(email) : null,
      displayName, hashPassword(passwort), avatarColorFor(handle),
      input.timezone || 'Europe/Berlin', input.language || 'de',
      input.role ?? 'member',
      email ? 0 : 1,            // ohne E-Mail muss das Profil noch vervollständigt werden
      input.createdBy, jetzt, jetzt,
    );

    // In alle offenen Kanäle aufnehmen, damit niemand vor leerer Liste sitzt.
    for (const ch of db.all<{ id: string }>("SELECT id FROM channels WHERE kind = 'public' AND archived = 0")) {
      db.run('INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', ch.id, id, jetzt);
    }
    recordInvite(id, input.createdBy);
  });

  return { userId: id, handle, oneTimePassword: passwort };
}

function vorschlagHandle(displayName: string): string {
  const basis = displayName.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '')
    .slice(0, 24) || 'kollege';
  if (!handleTaken(basis)) return basis;
  for (let i = 2; i < 100; i++) {
    if (!handleTaken(`${basis}${i}`)) return `${basis}${i}`;
  }
  return `${basis}${crypto.randomInt(1000, 9999)}`;
}

/** Passwort zurücksetzen — erzeugt ein neues Einmal-Passwort. */
export function resetPassword(userId: string, byUserId: string): string {
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  if (!ziel) throw new Error('Konto nicht gefunden');

  const passwort = generateOneTimePassword();
  db.run(
    'UPDATE users SET password_hash = ?, must_change_password = 1, password_set_at = ? WHERE id = ?',
    hashPassword(passwort), Date.now(), userId,
  );
  recordInvite(userId, byUserId);
  return passwort;
}

export function setDisabled(userId: string, disabled: boolean): void {
  const ziel = db.get<{ role: string }>('SELECT role FROM users WHERE id = ?', userId);
  if (ziel?.role === 'owner' && disabled) throw new Error('Der Owner lässt sich nicht sperren.');
  db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, userId);
}

/**
 * Konto löschen. Nachrichten bleiben stehen — sonst würden Gespräche
 * unverständlich. Der Name wird durch einen Platzhalter ersetzt.
 */
export function deleteAccount(userId: string): void {
  const ziel = db.get<{ role: string; deleted_at: number | null }>(
    'SELECT role, deleted_at FROM users WHERE id = ?', userId,
  );
  if (!ziel) throw new Error('Konto nicht gefunden');
  if (ziel.role === 'owner') throw new Error('Der Owner lässt sich nicht löschen. Erst die Rolle übergeben.');
  if (ziel.deleted_at) throw new Error('Dieses Konto ist bereits gelöscht.');

  db.transaction(() => {
    db.run(
      `UPDATE users SET display_name = 'Ehemaliges Mitglied', handle = ?, handle_bidx = ?,
              email = '', email_bidx = NULL, avatar_url = NULL, status = 'offline',
              status_text = NULL, status_emoji = NULL, disabled = 1,
              password_hash = ?, role = 'guest', deleted_at = ?
       WHERE id = ?`,
      encryptField(`geloescht.${userId.slice(-6)}`), blindIndex(`geloescht.${userId.slice(-6)}`),
      hashPassword(crypto.randomBytes(32).toString('hex')),
      Date.now(),
      userId,
    );
    db.run('DELETE FROM user_permissions WHERE user_id = ?', userId);
    db.run('DELETE FROM channel_members WHERE user_id = ?', userId);
    db.run('DELETE FROM drafts WHERE user_id = ?', userId);
    db.run('DELETE FROM reminders WHERE user_id = ?', userId);
    db.run('DELETE FROM scheduled_messages WHERE user_id = ?', userId);
    db.run('DELETE FROM saved_messages WHERE user_id = ?', userId);
  });
}

/* ── Ersteinrichtung durch die Person selbst ──────────────────── */

export function completeSetup(userId: string, input: {
  handle?: string; email?: string; displayName?: string; newPassword: string;
}): void {
  if (input.newPassword.length < 10) throw new Error('Das neue Passwort braucht mindestens 10 Zeichen.');

  /* Dieser Weg setzt ein neues Passwort, ohne das bisherige zu kennen. Das ist
     nur in der Einrichtungsphase vertretbar — nach dem Anlegen des Kontos und
     nach einem Zurücksetzen. Ohne die Sperre bliebe er dauerhaft offen und
     wäre ein Umweg um changeOwnPassword(): wer einmal an ein Token käme,
     könnte das Passwort austauschen, ohne es je gekannt zu haben. Die Sperre
     hängt weiter unten an der WHERE-Bedingung des UPDATE und nicht an einer
     vorgeschalteten Abfrage — so kann zwischen Prüfen und Schreiben nichts
     dazwischenkommen. */
  const felder: string[] = ['password_hash = ?', 'must_change_password = 0', 'password_set_at = ?'];
  const werte: any[] = [hashPassword(input.newPassword), Date.now()];

  if (input.handle) {
    const handle = input.handle.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(handle)) {
      throw new Error('Benutzername: 2–32 Zeichen, Kleinbuchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.');
    }
    if (handleTaken(handle, userId)) throw new Error(`Benutzername "${handle}" ist schon vergeben.`);
    felder.push('handle = ?', 'handle_bidx = ?');
    werte.push(encryptField(handle), blindIndex(handle));
  }

  if (input.email) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('E-Mail ist ungültig.');
    if (emailTaken(email, userId)) throw new Error('Diese E-Mail wird bereits verwendet.');
    felder.push('email = ?', 'email_bidx = ?');
    werte.push(encryptField(email), blindIndex(email));
  }

  if (input.displayName?.trim()) {
    felder.push('display_name = ?');
    werte.push(input.displayName.trim().slice(0, 80));
  }

  felder.push('must_complete_profile = 0');
  const { changes } = db.run(
    `UPDATE users SET ${felder.join(', ')}
      WHERE id = ? AND (must_change_password = 1 OR must_complete_profile = 1)`,
    ...werte, userId,
  );
  if (!changes) {
    throw new Error('Die Ersteinrichtung ist bereits abgeschlossen. Das Passwort änderst du in den Einstellungen.');
  }
}

/** Passwort selbst ändern — dafür braucht es das alte. */
export function changeOwnPassword(userId: string, altes: string, neues: string,
                                  pruefe: (klartext: string, hash: string) => boolean): void {
  if (neues.length < 10) throw new Error('Das neue Passwort braucht mindestens 10 Zeichen.');
  const row = db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', userId);
  if (!row || !pruefe(altes, row.password_hash)) throw new Error('Das bisherige Passwort stimmt nicht.');
  db.run(
    'UPDATE users SET password_hash = ?, must_change_password = 0, password_set_at = ? WHERE id = ?',
    hashPassword(neues), Date.now(), userId,
  );
}

/* ── Klartext für die Anzeige ─────────────────────────────────── */

export function plainHandle(stored: string): string { return decryptField(stored); }
export function plainEmail(stored: string): string { return decryptField(stored); }
