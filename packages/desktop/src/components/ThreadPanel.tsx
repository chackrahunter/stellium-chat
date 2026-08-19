import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { MessageItem } from './MessageItem.jsx';
import { Composer } from './Composer.jsx';

export function ThreadPanel({ parentId }: { parentId: string }) {
  const t = useT();
  const messages = useStore((s) => s.threads[parentId]) ?? [];
  const channelId = messages[0]?.channelId;
  const { openThread } = useStore.getState();

  return (
    <motion.aside
      className="thread"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="thread__head">
        <h2>{t('thread.title')}</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {Math.max(0, messages.length - 1)} {messages.length === 2 ? t('msg.reply') : t('msg.replies')}
        </span>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => openThread(null)} title={t('common.close')}>
          <X size={17} />
        </button>
      </div>

      <div className="thread__scroll">
        {messages.map((msg, i) => (
          <div key={msg.id}>
            <MessageItem message={msg} grouped={false} inThread />
            {i === 0 && messages.length > 1 && (
              <div className="daybar"><span>{messages.length - 1} {t('msg.replies')}</span></div>
            )}
          </div>
        ))}
      </div>

      {channelId && <Composer channelId={channelId} parentId={parentId} placeholder={t('composer.threadPlaceholder')} autoFocus />}
    </motion.aside>
  );
}
