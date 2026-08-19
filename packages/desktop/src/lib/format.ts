import { LANGUAGES, languageInfo } from '@stellium/shared';
import { currentUiLanguage, t } from '../i18n/index.js';

export { LANGUAGES, languageInfo };

/**
 * Datum, Uhrzeit und Zeitspannen in der Sprache der Oberfläche.
 *
 * Vorher stand hier überall 'de-DE' fest. Wer Stellium auf Englisch las, bekam
 * trotzdem "Donnerstag" und "vor 3 Stunden" — die Übersetzung endete an der
 * ersten Zahl.
 */
function sprache(): string {
  return currentUiLanguage();
}

export function timeOfDay(ts: number, timezone?: string): string {
  return new Intl.DateTimeFormat(sprache(), {
    hour: '2-digit', minute: '2-digit',
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(ts);
}

export function dayLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(date) - startOf(today)) / 86_400_000);
  if (diffDays === 0) return t('zeit.heute');
  if (diffDays === -1) return t('zeit.gestern');
  if (diffDays > -7) return new Intl.DateTimeFormat(sprache(), { weekday: 'long' }).format(date);
  return new Intl.DateTimeFormat(sprache(), {
    day: 'numeric', month: 'long',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  }).format(date);
}

export function relativeTime(ts: number): string {
  const rtf = new Intl.RelativeTimeFormat(sprache(), { numeric: 'auto' });
  const seconds = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(Math.round(seconds), 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

/** Datum und Uhrzeit zusammen — für Verläufe und Termine. */
export function dateTime(ts: number): string {
  return new Intl.DateTimeFormat(sprache(), { dateStyle: 'medium', timeStyle: 'short' }).format(ts);
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a); const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => [...p][0] ?? '').join('').toUpperCase() || '?';
}

/** Ortszeit eines Kollegen — hilft bei verteilten Teams. */
export function localTimeFor(timezone: string): { time: string; offHours: boolean } {
  try {
    const time = new Intl.DateTimeFormat(sprache(), { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(Date.now());
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: timezone }).format(Date.now()));
    return { time, offHours: hour < 8 || hour >= 19 };
  } catch {
    return { time: '', offHours: false };
  }
}

export function clsx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * Angezeigter Name eines Kanals — übersetzt, falls vorhanden.
 *
 * Der technische Name bleibt davon unberührt: Erwähnungen wie #vertrieb
 * müssen für alle dieselben sein, sonst zeigt ein Verweis ins Leere.
 */
export function kanalName(channel: { name: string; translation?: { name: string | null } | null }): string {
  return channel.translation?.name || channel.name;
}

/** Thema eines Kanals in der Lesesprache. */
export function kanalThema(channel: { topic: string | null; translation?: { topic: string | null } | null }): string | null {
  return channel.translation?.topic || channel.topic;
}
