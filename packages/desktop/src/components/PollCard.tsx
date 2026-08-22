import { useState } from 'react';
import { motion } from 'framer-motion';
import { BarChart3, Check, Lock, Users } from 'lucide-react';
import type { Poll } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT, t } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { relativeTime } from '../lib/format.js';

export function PollCard({ poll }: { poll: Poll }) {
  const self = useStore((s) => s.self);
  const users = useStore((s) => s.users);
  const { votePoll, closePoll } = useStore.getState();

  const mine = new Set(poll.myVotes);
  const leader = Math.max(1, ...poll.options.map((o) => o.votes));
  const canClose = self && (poll.createdBy === self.id || self.role === 'owner' || self.role === 'admin');

  /*
   * Anonyme Umfragen: Auswahl wird erst beim Bestätigen abgeschickt, und
   * danach steht sie fest (siehe voteAnonym() in services/polls.ts — der
   * Server kennt die Zuordnung Person→Antwort gar nicht erst, kann eine
   * spätere Änderung also auch nicht sauber verrechnen).
   *
   * `auswahl` ist deshalb rein lokal, nie an den Store gemeldet: sie ist die
   * Vormerkung vor dem einen erlaubten Klick auf "Abstimmen", nicht die
   * Stimme selbst. Nach dem Abstimmen sagt der Server nur noch `hasVoted` —
   * WAS gewählt wurde, weiß danach niemand mehr, auch diese Komponente nicht.
   */
  const [auswahl, setAuswahl] = useState<string[]>([]);
  const [wirdGesendet, setWirdGesendet] = useState(false);
  const gesperrt = poll.anonymous && poll.hasVoted;

  const toggle = (optionId: string) => {
    if (poll.closed || gesperrt) return;
    if (poll.anonymous) {
      setAuswahl((prev) => {
        if (poll.multiple) {
          return prev.includes(optionId) ? prev.filter((id) => id !== optionId) : [...prev, optionId];
        }
        return prev.includes(optionId) ? [] : [optionId];
      });
      return;
    }
    if (poll.multiple) {
      const next = mine.has(optionId)
        ? poll.myVotes.filter((id) => id !== optionId)
        : [...poll.myVotes, optionId];
      votePoll(poll.id, next);
    } else {
      // Nochmal auf dieselbe Antwort tippen nimmt die Stimme zurück.
      votePoll(poll.id, mine.has(optionId) ? [] : [optionId]);
    }
  };

  const anonymAbstimmen = () => {
    if (!auswahl.length || wirdGesendet) return;
    setWirdGesendet(true);
    votePoll(poll.id, auswahl);
    // Kein Zurücksetzen von `wirdGesendet` bei Erfolg: sobald die Antwort des
    // Servers eintrifft, wird `poll.hasVoted` wahr, `gesperrt` greift, und
    // dieser Zweig wird gar nicht mehr gerendert. Bleibt eine Antwort aus
    // (z. B. Leitung weg), lieber ein weiterer Klick als eine zweite,
    // stillschweigend verworfene Anfrage.
    setWirdGesendet(false);
  };

  return (
    <div className="poll">
      <div className="poll__head">
        <BarChart3 size={13} />
        {t('poll.label')}
        {poll.multiple && <span className="poll__flag">{t('poll.multiple')}</span>}
        {poll.anonymous && <span className="poll__flag"><Lock size={9} /> {t('poll.anonymous')}</span>}
        {poll.closed && <span className="poll__flag poll__flag--closed">{t('poll.closed')}</span>}
      </div>

      <div className="poll__question">{poll.translation?.question ?? poll.question}</div>

      <div className="stack gap-2">
        {poll.options.map((option) => {
          // Nach dem Abstimmen bei einer anonymen Umfrage lässt sich keine
          // bestimmte Antwort mehr als "meine" markieren — das wüsste nur der
          // Server, wenn er es sich gemerkt hätte, und genau das tut er nicht.
          const chosen = poll.anonymous ? (!gesperrt && auswahl.includes(option.id)) : mine.has(option.id);
          const share = poll.totalVoters ? option.votes / poll.totalVoters : 0;
          return (
            <button
              key={option.id}
              className={`poll-option${chosen ? ' poll-option--mine' : ''}${(poll.closed || gesperrt) ? ' poll-option--closed' : ''}`}
              onClick={() => toggle(option.id)}
              disabled={poll.closed || gesperrt}
            >
              <motion.span
                className="poll-option__fill"
                initial={false}
                animate={{ width: `${Math.round(share * 100)}%` }}
                transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                style={{ opacity: option.votes === leader && option.votes > 0 ? 0.28 : 0.15 }}
              />
              <span className={`poll-option__mark${chosen ? ' poll-option__mark--on' : ''}`}>
                {chosen && <Check size={11} strokeWidth={3.5} />}
              </span>
              <span className="poll-option__text">
                {poll.translation?.options[option.id] ?? option.text}
              </span>

              {!poll.anonymous && option.voterIds.length > 0 && (
                <span className="poll-option__faces">
                  {option.voterIds.slice(0, 4).map((id) => (
                    <Avatar key={id} user={users[id]} size={17} />
                  ))}
                </span>
              )}
              <span className="poll-option__count">{option.votes}</span>
            </button>
          );
        })}
      </div>

      {poll.anonymous && !poll.closed && !gesperrt && (
        <button
          className="btn btn--primary btn--sm"
          style={{ marginTop: 8 }}
          disabled={!auswahl.length || wirdGesendet}
          onClick={anonymAbstimmen}
        >
          {t('poll.confirmVote')}
        </button>
      )}

      <div className="poll__foot">
        <Users size={11} />
        {poll.totalVoters === 0
          ? t('poll.noVotes')
          : t(poll.totalVoters === 1 ? 'poll.oneVote' : 'poll.votes', { n: poll.totalVoters })}
        {gesperrt && <span>· {t('poll.votedAnonymous')}</span>}
        {poll.closesAt && !poll.closed && <span>· {t('poll.endsIn', { zeit: relativeTime(poll.closesAt) })}</span>}
        {canClose && !poll.closed && (
          <button className="poll__close" onClick={() => closePoll(poll.id)}>{t('poll.close')}</button>
        )}
      </div>
    </div>
  );
}
