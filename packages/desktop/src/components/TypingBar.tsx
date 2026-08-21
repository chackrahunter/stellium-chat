import { markenSchaetzung } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';

/**
 * Die Zeile unter dem Schreibfeld: wer gerade tippt — oder was die KI tut.
 *
 * Bei der KI steht dort nicht nur „denkt nach", sondern auch, woran sie kaut:
 * die Marken der letzten Antwort, und beim Tippen live die Schätzung für das,
 * was gerade entsteht. Auf einem Modell im eigenen Haus ist das die einzige
 * Auskunft darüber, warum eine Antwort dauert — und die Zahl neben dem
 * Eingabefeld erklärt eine lange Wartezeit besser als jeder Ladebalken.
 */
export function TypingBar({ channelId }: { channelId: string }) {
  const t = useT();
  const typing = useStore((s) => s.typing[channelId]);
  const denkt = useStore((s) => s.aiThinking[channelId] ?? false);
  const verbrauch = useStore((s) => s.aiVerbrauch[channelId]);
  const entwurf = useStore((s) => s.drafts[`${channelId}:`] ?? '');
  const users = useStore((s) => s.users);
  const selfId = useStore((s) => s.self?.id);

  /* Dieselbe Schätzung, mit der der Server rechnet (@stellium/shared) — eine
     zweite Regel hier hieße zwei Zahlen, die sich widersprechen. */
  const eingabeJetzt = entwurf.trim() ? markenSchaetzung(entwurf) : 0;

  /* Mit Tausendertrennung in der Sprache des Lesers: „12.480" ist auf einen
     Blick zu erfassen, „12480" muss man zählen. */
  const sprache = useStore((s) => s.self?.language ?? 'de');
  const zahl = (n: number) => n.toLocaleString(sprache);

  // Der Assistent hat Vorrang: wenn er arbeitet, ist das die wichtigere Info.
  if (denkt) {
    return (
      <div className="typing typing--ki">
        <span className="typing__dots"><i /><i /><i /></span>
        {t('ai.thinking')}
        {verbrauch && (
          <span className="typing__marken" title={verbrauch.modell ?? undefined}>
            {t('ai.tokens', { ein: zahl(verbrauch.eingabe), aus: zahl(verbrauch.ausgabe) })}
          </span>
        )}
      </div>
    );
  }

  const names = Object.keys(typing ?? {})
    .filter((id) => id !== selfId)
    .map((id) => users[id]?.displayName)
    .filter(Boolean) as string[];

  /* Auch ohne Tipper: schreibt jemand an die KI, steht hier live, was die
     Frage kosten wird. Erst ab ein paar Zeichen — eine Zahl, die bei jedem
     Buchstaben zuckt, ist Unruhe ohne Auskunft. */
  const kiZeile = (eingabeJetzt > 0 || verbrauch) && (
    <span className="typing__marken">
      {eingabeJetzt > 0 && t('ai.tokensLive', { ein: zahl(eingabeJetzt) })}
      {eingabeJetzt > 0 && verbrauch && ' · '}
      {verbrauch && t('ai.tokensLast', { ein: zahl(verbrauch.eingabe), aus: zahl(verbrauch.ausgabe) })}
    </span>
  );

  if (names.length === 0) {
    return <div className="typing">{kiZeile}</div>;
  }

  const label = names.length === 1
    ? t('typing.one', { name: names[0] })
    : names.length === 2
      ? t('typing.two', { a: names[0], b: names[1] })
      : t('typing.many', { n: names.length });

  return (
    <div className="typing">
      <span className="typing__dots"><i /><i /><i /></span>
      {label}
      {kiZeile}
    </div>
  );
}
