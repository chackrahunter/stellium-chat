import type { User, UserStatus } from '@stellium/shared';
import { fileUrl } from '../net/api.js';
import { t, type TranslationKey } from '../i18n/index.js';
import { initials } from '../lib/format.js';

interface Props {
  user?: Pick<User, 'displayName' | 'avatarColor' | 'avatarUrl' | 'status'> | null;
  size?: number;
  showPresence?: boolean;
  status?: UserStatus;
}

export function Avatar({ user, size = 38, showPresence = false, status }: Props) {
  const name = user?.displayName ?? '?';
  const color = user?.avatarColor ?? '#7c5cff';
  const presence = status ?? user?.status ?? 'offline';
  /* Der Punkt war zu klein, um die Farbe auf einen Blick zu erkennen —
     besonders in der Mitgliederliste, wo die Bilder ohnehin klein sind.
     Ein gutes Drittel des Bildes, mindestens zwölf Pixel. */
  const dot = Math.max(12, Math.round(size * 0.36));

  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: user?.avatarUrl ? 'none' : `linear-gradient(140deg, ${color}, ${shade(color, -34)})`,
      }}
      title={name}
    >
      {user?.avatarUrl ? <img src={fileUrl(user.avatarUrl)} alt="" /> : initials(name)}
      {showPresence && (
        <span
          className={`avatar__presence presence--${presence}`}
          style={{ width: dot, height: dot }}
          title={t(PRESENCE_LABEL[presence])}
        />
      )}
    </div>
  );
}

/**
 * Nur Schlüssel — übersetzt wird erst beim Anzeigen oben (`t(PRESENCE_LABEL[presence])`).
 *
 * Vorher stand hier `t('user.dnd')` direkt in der Konstanten: das lief genau
 * einmal beim Laden dieses Moduls, vor jeder Anmeldung, und nie wieder — die
 * Beschriftung "Bitte nicht stören" blieb für die ganze Sitzung in der
 * Sprache stehen, die beim Start der App galt, auch nach einem Sprachwechsel.
 * 'Online' und 'Offline' standen daneben sogar ganz ohne Wörterbuch fest da
 * — Englisch in jeder der 22 Sprachen, während 'Abwesend' hart Deutsch war.
 * Diese Zeile ist der title an JEDEM Profilbild der App und damit einer der
 * meistgesehenen Texte überhaupt.
 *
 * common.online/away/dnd/offline gibt es bereits fertig übersetzt in allen
 * 22 Wörterbüchern (unbenutzt, offenbar genau für diesen Zweck angelegt) —
 * eigene user.*-Schlüssel wären nur eine zweite Kopie derselben vier Wörter
 * gewesen. So macht es StatusMenu.tsx (EINTRAEGE) bereits vor: Schlüssel in
 * der Konstante, Übersetzung erst beim Rendern.
 */
const PRESENCE_LABEL: Record<UserStatus, TranslationKey> = {
  online: 'common.online', away: 'common.away', dnd: 'common.dnd', offline: 'common.offline',
};

/** Hex-Farbe abdunkeln/aufhellen, damit der Avatar einen Verlauf bekommt. */
function shade(hex: string, amount: number): string {
  const m = /^#?([\da-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const r = clamp((num >> 16) + amount);
  const g = clamp(((num >> 8) & 0xff) + amount);
  const b = clamp((num & 0xff) + amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
