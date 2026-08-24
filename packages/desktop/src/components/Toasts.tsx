import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';

export function Toasts() {
  const t = useT();
  const toasts = useStore((s) => s.toasts);
  const { dismissToast } = useStore.getState();

  return (
    <div
      className="toasts"
      aria-live="polite"
      aria-atomic="true"
      role="status"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            layout
            initial={{ opacity: 0, x: 40, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.95 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className={`toast toast--${toast.kind}`}
          >
            {toast.kind === 'error' ? <AlertCircle size={17} style={{ color: 'var(--rose)', flex: 'none' }} />
              : toast.kind === 'ok' ? <CheckCircle2 size={17} style={{ color: 'var(--mint)', flex: 'none' }} />
              : <Info size={17} className="muted" style={{ flex: 'none' }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="toast__title">{toast.title}</div>
              {toast.body && <div className="toast__body">{toast.body}</div>}
            </div>
            <button
              className="icon-btn icon-btn--sm"
              onClick={() => dismissToast(toast.id)}
              aria-label={t('common.close')}
              title={t('common.close')}
            >
              <X size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
