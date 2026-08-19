import { motion } from 'framer-motion';
import { BarChart3, Check, Lock, Users } from 'lucide-react';
import type { Poll } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { Avatar } from './Avatar.jsx';
import { relativeTime } from '../lib/format.js';

export function PollCard({ poll }: { poll: Poll }) {
  const self = useStore((s) => s.self);
  const users = useStore((s) => s.users);
  const { votePoll, closePoll } = useStore.getState();

  const mine = new Set(poll.myVotes);
  const leader = Math.max(1, ...poll.options.map((o) => o.votes));
  const canClose = self && (poll.createdBy === self.id || self.role === 'owner' || self.role === 'admin');

  const toggle = (optionId: string) => {
    if (poll.closed) return;
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

  return (
    <div className="poll">
      <div className="poll__head">
        <BarChart3 size={13} />
        Umfrage
        {poll.multiple && <span className="poll__flag">Mehrfachwahl</span>}
        {poll.anonymous && <span className="poll__flag"><Lock size={9} /> anonym</span>}
        {poll.closed && <span className="poll__flag poll__flag--closed">beendet</span>}
      </div>

      <div className="poll__question">{poll.translation?.question ?? poll.question}</div>

      <div className="stack gap-2">
        {poll.options.map((option) => {
          const chosen = mine.has(option.id);
          const share = poll.totalVoters ? option.votes / poll.totalVoters : 0;
          return (
            <button
              key={option.id}
              className={`poll-option${chosen ? ' poll-option--mine' : ''}${poll.closed ? ' poll-option--closed' : ''}`}
              onClick={() => toggle(option.id)}
              disabled={poll.closed}
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

      <div className="poll__foot">
        <Users size={11} />
        {poll.totalVoters === 0
          ? 'Noch keine Stimme'
          : `${poll.totalVoters} ${poll.totalVoters === 1 ? 'Stimme' : 'Stimmen'}`}
        {poll.closesAt && !poll.closed && <span>· endet {relativeTime(poll.closesAt)}</span>}
        {canClose && !poll.closed && (
          <button className="poll__close" onClick={() => closePoll(poll.id)}>Beenden</button>
        )}
      </div>
    </div>
  );
}
