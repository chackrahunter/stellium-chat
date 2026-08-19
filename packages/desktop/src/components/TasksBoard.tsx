import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlarmClock, CalendarDays, Check, Eye, EyeOff, Hash, ListChecks, Loader2,
  MessageSquare, Plus, Sparkles, Trash2, User as UserIcon,
} from 'lucide-react';
import {
  TASK_STATUSES, TASK_PRIORITIES, type Task, type TaskPriority, type TaskStatus,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { clsx, relativeTime } from '../lib/format.js';

const SPALTEN_FARBE: Record<TaskStatus, string> = {
  pending: 'var(--text-dim)',
  working: 'var(--blue)',
  review: 'var(--amber)',
  finished: 'var(--green)',
  blocked: 'var(--red)',
};

const PRIO_FARBE: Record<TaskPriority, string> = {
  low: 'var(--text-dim)',
  normal: 'var(--blue)',
  high: 'var(--amber)',
  urgent: 'var(--red)',
};

/** Tagesgenaue Einordnung eines Termins — für Färbung und Kurztext. */
function faelligkeit(dueAt: number | null, jetzt = Date.now()) {
  if (!dueAt) return null;
  const tag = 86_400_000;
  const restTage = Math.floor((dueAt - jetzt) / tag);
  return { ueberfaellig: dueAt < jetzt, heute: restTage === 0 && dueAt >= jetzt, restTage };
}

export function TasksBoard({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tasks = useStore((s) => s.tasks);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const { loadTasks, moveTask, deleteTask, setOverlay } = useStore.getState();

  const [nurMeine, setNurMeine] = useState(false);
  const [neuOffen, setNeuOffen] = useState(false);
  const [offeneAufgabe, setOffeneAufgabe] = useState<string | null>(null);
  const [gezogen, setGezogen] = useState<string | null>(null);
  const [ueberSpalte, setUeberSpalte] = useState<TaskStatus | null>(null);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  const spalten = useMemo(() => {
    const alle = Object.values(tasks)
      .filter((a) => !nurMeine || a.assigneeId === self?.id)
      .sort((a, b) => {
        // Termine zuerst, dann Wichtigkeit, dann Alter.
        const af = a.dueAt ?? Infinity;
        const bf = b.dueAt ?? Infinity;
        if (af !== bf) return af - bf;
        return TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority)
          || a.createdAt - b.createdAt;
      });
    return TASK_STATUSES.map((status) => ({ status, items: alle.filter((a) => a.status === status) }));
  }, [tasks, nurMeine, self?.id]);

  const offen = Object.values(tasks).filter((a) => a.status !== 'finished').length;

  return (
    <Shell
      title={t('tasks.title')}
      subtitle={t('tasks.openCount', { count: offen })}
      icon={<ListChecks size={18} />}
      onClose={onClose}
      width={1180}
      actions={
        <>
          <button
            className={clsx('pill', nurMeine && 'pill--accent')}
            onClick={() => setNurMeine((v) => !v)}
          >
            <UserIcon size={13} /> {nurMeine ? t('tasks.mine') : t('tasks.all')}
          </button>
          {ai?.assistant && activeChannelId && (
            <button className="pill" onClick={() => setOverlay('taskExtract')} title={t('ai.extractTasks')}>
              <Sparkles size={13} /> {t('ai.extractTasks')}
            </button>
          )}
          <button className="pill pill--accent" onClick={() => setNeuOffen(true)}>
            <Plus size={13} /> {t('tasks.new')}
          </button>
        </>
      }
    >
      {!Object.keys(tasks).length ? (
        <div className="empty-state">
          <ListChecks size={30} className="muted" />
          <p>{t('tasks.empty')}</p>
        </div>
      ) : (
        <div className="board">
          {spalten.map(({ status, items }) => (
            <div
              key={status}
              className={clsx('board__col', ueberSpalte === status && 'board__col--over')}
              onDragOver={(e) => { e.preventDefault(); setUeberSpalte(status); }}
              onDragLeave={() => setUeberSpalte((v) => (v === status ? null : v))}
              onDrop={(e) => {
                e.preventDefault();
                setUeberSpalte(null);
                const id = gezogen ?? e.dataTransfer.getData('text/plain');
                if (id && tasks[id]?.status !== status) moveTask(id, status);
                setGezogen(null);
              }}
            >
              <header className="board__head">
                <span className="board__dot" style={{ background: SPALTEN_FARBE[status] }} />
                <span className="board__title">{t(`tasks.status.${status}` as never)}</span>
                <span className="board__count">{items.length}</span>
              </header>

              <div className="board__cards">
                <AnimatePresence initial={false}>
                  {items.map((aufgabe) => (
                    <TaskCard
                      key={aufgabe.id}
                      task={aufgabe}
                      onOpen={() => setOffeneAufgabe(aufgabe.id)}
                      onDragStart={() => setGezogen(aufgabe.id)}
                      onDragEnd={() => { setGezogen(null); setUeberSpalte(null); }}
                    />
                  ))}
                </AnimatePresence>
                {!items.length && <p className="board__empty">{t('tasks.emptyColumn')}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <AnimatePresence>
        {neuOffen && <TaskDialog key="neu" onClose={() => setNeuOffen(false)} />}
        {offeneAufgabe && tasks[offeneAufgabe] && (
          <TaskDetail
            key={offeneAufgabe}
            task={tasks[offeneAufgabe]}
            onClose={() => setOffeneAufgabe(null)}
            onDelete={() => {
              if (confirm(t('tasks.deleteConfirm'))) { deleteTask(offeneAufgabe); setOffeneAufgabe(null); }
            }}
          />
        )}
      </AnimatePresence>
    </Shell>
  );

  function TaskCard({ task, onOpen, onDragStart, onDragEnd }: {
    task: Task; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void;
  }) {
    const zustaendig = task.assigneeId ? users[task.assigneeId] : null;
    const kanal = task.channelId ? channels[task.channelId] : null;
    const frist = faelligkeit(task.dueAt);

    return (
      <motion.button
        layout
        layoutId={`task_${task.id}`}
        className="task-card"
        draggable
        onDragStart={(e) => {
          (e as unknown as React.DragEvent).dataTransfer?.setData('text/plain', task.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onClick={onOpen}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.16 }}
      >
        <span className="task-card__prio" style={{ background: PRIO_FARBE[task.priority] }} />
        <span className="task-card__title">{task.title}</span>

        <span className="task-card__meta">
          {zustaendig
            ? <Avatar user={zustaendig} size={17} />
            : <span className="task-card__nobody"><UserIcon size={11} /></span>}
          {kanal && <span className="task-card__chan"><Hash size={10} />{kanal.name}</span>}
          {frist && (
            <span
              className={clsx('task-card__due', frist.ueberfaellig && 'task-card__due--late')}
              title={new Date(task.dueAt!).toLocaleString()}
            >
              <AlarmClock size={10} />
              {frist.ueberfaellig ? t('tasks.overdue') : frist.heute ? t('tasks.dueToday') : relativeTime(task.dueAt!)}
            </span>
          )}
          {task.watcherIds.includes(self?.id ?? '') && <Eye size={11} className="muted" />}
        </span>
      </motion.button>
    );
  }
}

/* ── Anlegen ────────────────────────────────────────────────── */

function TaskDialog({ onClose, vorgabe }: {
  onClose: () => void;
  vorgabe?: { title?: string; assigneeId?: string | null; dueAt?: number | null };
}) {
  const t = useT();
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const activeChannelId = useStore((s) => s.activeChannelId);

  const [title, setTitle] = useState(vorgabe?.title ?? '');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(vorgabe?.assigneeId ?? '');
  const [channelId, setChannelId] = useState(activeChannelId ?? '');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [due, setDue] = useState(vorgabe?.dueAt ? tagesFeld(vorgabe.dueAt) : '');

  const absenden = () => {
    if (!title.trim()) return;
    useStore.getState().createTask({
      title: title.trim(),
      description: description.trim() || null,
      assigneeId: assigneeId || null,
      channelId: channelId || null,
      priority,
      // Ohne Uhrzeit ist "fällig" das Ende des gewählten Tages.
      dueAt: due ? new Date(`${due}T23:59`).getTime() : null,
    });
    onClose();
  };

  return (
    <Shell title={t('tasks.new')} icon={<Plus size={18} />} onClose={onClose} width={520}>
      <div className="field">
        <label className="field__label">{t('tasks.newTitle')}</label>
        <input
          className="input" value={title} autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') absenden(); }}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('tasks.description')}</label>
        <textarea
          className="input" rows={3} value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="field__label">{t('tasks.assignee')}</label>
          <select className="select" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">{t('tasks.unassigned')}</option>
            {Object.values(users).filter((u) => !u.disabled && u.role !== 'bot').map((u) => (
              <option key={u.id} value={u.id}>{u.displayName}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.priority')}</label>
          <select
            className="select" value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority)}
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>{t(`tasks.priority.${p}` as never)}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.channel')}</label>
          <select className="select" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">—</option>
            {Object.values(channels).filter((c) => c.kind !== 'dm' && !c.archived).map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.due')}</label>
          <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
      </div>

      <div className="panel__foot">
        <button className="btn btn--primary" onClick={absenden} disabled={!title.trim()}>
          {t('tasks.create')}
        </button>
      </div>
    </Shell>
  );
}

function tagesFeld(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── Einzelansicht ──────────────────────────────────────────── */

function TaskDetail({ task, onClose, onDelete }: { task: Task; onClose: () => void; onDelete: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const verlauf = useStore((s) => s.taskHistory[task.id]);
  const { updateTask, commentTask, watchTask, loadTaskHistory } = useStore.getState();
  const [kommentar, setKommentar] = useState('');

  useEffect(() => { loadTaskHistory(task.id); }, [task.id, loadTaskHistory]);

  const beobachtet = task.watcherIds.includes(self?.id ?? '');

  return (
    <Shell
      title={task.title}
      icon={<ListChecks size={18} />}
      onClose={onClose}
      width={640}
      actions={
        <>
          <button
            className="icon-btn"
            onClick={() => watchTask(task.id, !beobachtet)}
            title={beobachtet ? t('tasks.unwatch') : t('tasks.watch')}
          >
            {beobachtet ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button className="icon-btn icon-btn--danger" onClick={onDelete} title={t('tasks.delete')}>
            <Trash2 size={16} />
          </button>
        </>
      }
    >
      <div className="grid-2">
        <div className="field">
          <label className="field__label">{t('tasks.status.pending')}</label>
          <select
            className="select" value={task.status}
            onChange={(e) => updateTask(task.id, { status: e.target.value as TaskStatus })}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>{t(`tasks.status.${s}` as never)}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.assignee')}</label>
          <select
            className="select" value={task.assigneeId ?? ''}
            onChange={(e) => updateTask(task.id, { assigneeId: e.target.value || null })}
          >
            <option value="">{t('tasks.unassigned')}</option>
            {Object.values(users).filter((u) => !u.disabled && u.role !== 'bot').map((u) => (
              <option key={u.id} value={u.id}>{u.displayName}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.priority')}</label>
          <select
            className="select" value={task.priority}
            onChange={(e) => updateTask(task.id, { priority: e.target.value as TaskPriority })}
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>{t(`tasks.priority.${p}` as never)}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('tasks.due')}</label>
          <input
            className="input" type="date"
            value={task.dueAt ? tagesFeld(task.dueAt) : ''}
            onChange={(e) => updateTask(task.id, {
              dueAt: e.target.value ? new Date(`${e.target.value}T23:59`).getTime() : null,
            })}
          />
        </div>
      </div>

      <div className="field">
        <label className="field__label">{t('tasks.description')}</label>
        <textarea
          className="input" rows={3}
          defaultValue={task.description ?? ''}
          onBlur={(e) => {
            const wert = e.target.value.trim() || null;
            if (wert !== (task.description ?? null)) updateTask(task.id, { description: wert });
          }}
        />
      </div>

      <div className="field">
        <label className="field__label">{t('tasks.history')}</label>
        <div className="task-log">
          {(verlauf ?? []).map((e) => {
            const wer = users[e.userId];
            return (
              <div key={e.id} className="task-log__row">
                <Avatar user={wer} size={18} />
                <span className="task-log__text">
                  <strong>{wer?.displayName ?? '—'}</strong>{' '}
                  {t(`tasks.event.${e.kind}` as never)}
                  {e.kind === 'comment' && e.text && <em> — {e.text}</em>}
                  {e.kind === 'status' && e.nach && <em> → {t(`tasks.status.${e.nach}` as never)}</em>}
                </span>
                <span className="task-log__when">{relativeTime(e.createdAt)}</span>
              </div>
            );
          })}
          {!verlauf?.length && <p className="muted" style={{ fontSize: 12 }}>—</p>}
        </div>
      </div>

      <div className="field" style={{ display: 'flex', gap: 8 }}>
        <input
          className="input" value={kommentar} placeholder={t('tasks.comment')}
          onChange={(e) => setKommentar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && kommentar.trim()) {
              commentTask(task.id, kommentar.trim());
              setKommentar('');
            }
          }}
        />
        <button
          className="btn"
          disabled={!kommentar.trim()}
          onClick={() => { commentTask(task.id, kommentar.trim()); setKommentar(''); }}
        >
          <MessageSquare size={14} />
        </button>
      </div>
    </Shell>
  );
}

/* ── Aufgaben aus einem Gespräch ────────────────────────────── */
