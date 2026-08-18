import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';

export function TypingBar({ channelId }: { channelId: string }) {
  const t = useT();
  const typing = useStore((s) => s.typing[channelId]);
  const denkt = useStore((s) => s.aiThinking[channelId] ?? false);
  const users = useStore((s) => s.users);
  const selfId = useStore((s) => s.self?.id);

  // Der Assistent hat Vorrang: wenn er arbeitet, ist das die wichtigere Info.
  if (denkt) {
    return (
      <div className="typing typing--ki">
        <span className="typing__dots"><i /><i /><i /></span>
        {t('ai.thinking')}
      </div>
    );
  }

  const names = Object.keys(typing ?? {})
    .filter((id) => id !== selfId)
    .map((id) => users[id]?.displayName)
    .filter(Boolean) as string[];

  if (names.length === 0) return <div className="typing" />;

  const label = names.length === 1
    ? `${names[0]} schreibt`
    : names.length === 2
      ? `${names[0]} und ${names[1]} schreiben`
      : `${names.length} Personen schreiben`;

  return (
    <div className="typing">
      <span className="typing__dots"><i /><i /><i /></span>
      {label}…
    </div>
  );
}
