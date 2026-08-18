import crypto from 'node:crypto';

/** Zeitlich sortierbare IDs — Nachrichten lassen sich damit stabil ordnen. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(8).toString('base64url');
  return `${prefix}${time}${rand}`;
}

export function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}
