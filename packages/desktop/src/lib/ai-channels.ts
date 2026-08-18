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
export function useKiKanaele(): {
  chatId: string | null;
  teamId: string | null;
  istKi: (id: string | null) => boolean;
  /** Alle Chats mit der KI — auch verwaiste aus früheren Ständen. */
  alleKiChats: Set<string>;
} {
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);

  return useMemo(() => {
    const liste = Object.values(channels);

    // Es kann mehr als einen Chat mit der KI geben: wird ein Konto gelöscht,
    // bleibt dessen Chat mit dem Bot als Rest zurück. Alle gehören aus der
    // Direktnachrichtenliste heraus, nicht nur der erste gefundene.
    const kiChats = liste.filter((c) => c.kind === 'dm' && users[c.dmPeerId ?? '']?.role === 'bot');
    // Der jüngste ist der eigene — ältere sind Überbleibsel.
    const chatId = kiChats.sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null;
    const teamId = liste.find((c) => c.kind === 'public' && c.name === KI_TEAM_CHANNEL)?.id ?? null;
    const alleKiChats = new Set(kiChats.map((c) => c.id));

    return {
      chatId,
      teamId,
      alleKiChats,
      istKi: (id: string | null) => id != null && (alleKiChats.has(id) || id === teamId),
    };
  }, [channels, users]);
}
