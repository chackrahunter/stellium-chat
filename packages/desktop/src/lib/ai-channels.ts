import { useMemo } from 'react';
import { useStore } from '../state/store.js';

export const KI_NAME = 'StelliumAI';
export const KI_TEAM_CHANNEL = 'ki-team';

/**
 * Die beiden KI-Oberflächen. Beide liegen technisch als Kanal in der Datenbank
 * — der private als Direktchat mit dem Bot-Konto, der gemeinsame als
 * öffentlicher Kanal. In der Oberfläche sind sie aber ein eigener Bereich und
 * ausdrücklich kein Direktchat, deshalb werden sie überall gesondert behandelt.
 */
export function useKiKanaele(): { chatId: string | null; teamId: string | null; istKi: (id: string | null) => boolean } {
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);

  return useMemo(() => {
    const liste = Object.values(channels);
    const chatId = liste.find((c) => c.kind === 'dm' && users[c.dmPeerId ?? '']?.role === 'bot')?.id ?? null;
    const teamId = liste.find((c) => c.kind === 'public' && c.name === KI_TEAM_CHANNEL)?.id ?? null;
    return {
      chatId,
      teamId,
      istKi: (id: string | null) => id != null && (id === chatId || id === teamId),
    };
  }, [channels, users]);
}
