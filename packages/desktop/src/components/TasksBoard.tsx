import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlarmClock, CalendarDays, Check, Eye, EyeOff, FolderKanban, Hash, Inbox, ListChecks, Loader2,
  MessageSquare, Pencil, Plus, Sparkles, Trash2, User as UserIcon, X,
} from 'lucide-react';
import {
  TASK_STATUSES, TASK_PRIORITIES, type Task, type TaskPriority, type TaskStatus,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useVorschlaege } from '../state/vorschlaege.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { PruefListe } from './PruefListe.jsx';
import { ProjektDialog } from './ProjektDialog.jsx';
import { clsx, dateTime, dayLabel, relativeTime } from '../lib/format.js';

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
  /* Wie viele Vorschläge dieser Art warten. Aus demselben Laden wie der
     Eingang selbst — keine zweite Zählung, die irgendwann abweicht. */
  const offeneVorschlaege = useVorschlaege(
    (s) => s.liste.filter((v) => v.art === 'aufgabe').length,
  );

  const tasks = useStore((s) => s.tasks);
  const projekte = useStore((s) => s.projekte);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const { loadTasks, loadProjekte, moveTask, deleteTask, setOverlay, aufgabeGeprueft } = useStore.getState();

  const [nurMeine, setNurMeine] = useState(false);
  /** Welches Projekt gezeigt wird: null = alle, '' = ohne Projekt. */
  const [projektFilter, setProjektFilter] = useState<string | null>(null);
  /** Der Reiter „Prüfen": zeigt nur, was die KI selbst eingetragen hat. */
  const [pruefen, setPruefen] = useState(false);
  const [projekteOffen, setProjekteOffen] = useState(false);
  const [neuOffen, setNeuOffen] = useState(false);
  const [offeneAufgabe, setOffeneAufgabe] = useState<string | null>(null);
  const [gezogen, setGezogen] = useState<string | null>(null);
  const [ueberSpalte, setUeberSpalte] = useState<TaskStatus | null>(null);

  useEffect(() => { loadTasks(); loadProjekte(); }, [loadTasks, loadProjekte]);

  /* Was die KI selbst eingetragen hat und noch niemand angesehen hat. */
  const ungeprueft = useMemo(
    () => Object.values(tasks).filter((a) => a.vonKi && !a.geprueft),
    [tasks],
  );

  /* Steht nichts mehr zum Prüfen an, führt der Reiter ins Leere — dann
     zurück aufs Brett, statt eine leere Seite anzustarren. */
  useEffect(() => {
    if (pruefen && !ungeprueft.length) setPruefen(false);
  }, [pruefen, ungeprueft.length]);

  const spalten = useMemo(() => {
    const alle = Object.values(tasks)
      .filter((a) => !nurMeine || a.assigneeId === self?.id)
      /* Ohne Projektwahl alles; mit '' nur das ohne Schublade. */
      .filter((a) => projektFilter === null || (a.projektId ?? '') === projektFilter)
      .sort((a, b) => {
        // Termine zuerst, dann Wichtigkeit, dann Alter.
        const af = a.dueAt ?? Infinity;
        const bf = b.dueAt ?? Infinity;
        if (af !== bf) return af - bf;
        return TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority)
          || a.createdAt - b.createdAt;
      });
    return TASK_STATUSES.map((status) => ({ status, items: alle.filter((a) => a.status === status) }));
  }, [tasks, nurMeine, self?.id, projektFilter]);

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
          {/* Die Schublade: alles, ein Projekt, oder das ohne Projekt. */}
          <select
            className="pill pill--select"
            value={projektFilter ?? '__alle'}
            onChange={(e) => setProjektFilter(e.target.value === '__alle' ? null : e.target.value)}
            title={t('projekte.title')}
          >
            <option value="__alle">{t('projekte.all')}</option>
            <option value="">{t('projekte.none')}</option>
            {Object.values(projekte)
              .filter((p) => !p.archiviert)
              .map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button className="pill" onClick={() => setProjekteOffen(true)} title={t('projekte.title')}>
            <FolderKanban size={13} /> {t('projekte.title')}
          </button>
          {/* „Prüfen" erscheint nur, wenn es etwas zu prüfen gibt — ein
              dauerhaft leerer Reiter ist ein Versprechen, das keiner einlöst. */}
          {ungeprueft.length > 0 && (
            <button
              className={clsx('pill', pruefen ? 'pill--accent' : 'pill--warn')}
              onClick={() => setPruefen((v) => !v)}
            >
              <Sparkles size={13} /> {t('pruefen.count', { n: ungeprueft.length })}
            </button>
          )}
          {ai?.assistant && activeChannelId && (
            <button className="pill" onClick={() => setOverlay('taskExtract')} title={t('ai.extractTasks')}>
              <Sparkles size={13} /> {t('ai.extractTasks')}
            </button>
          )}
          {/* Dons „jeweils": das Brett zeigt, dass Vorschläge dieser Art
              warten, und führt in den einen Eingang — vorgefiltert. Ein
              eigener Reiter je Brett wäre der zweite Ort zum Nachsehen. */}
          {offeneVorschlaege > 0 && (
            <button
              className="pill"
              onClick={() => useVorschlaege.getState().oeffnen('aufgabe')}
            >
              <Inbox size={13} /> {t('vorschlaege.doorTasks', { n: offeneVorschlaege })}
            </button>
          )}
          <button className="pill pill--accent" onClick={() => setNeuOffen(true)}>
            <Plus size={13} /> {t('tasks.new')}
          </button>
        </>
      }
    >
      {pruefen ? (
        <PruefListe
          eintraege={ungeprueft.map((a) => ({
            id: a.id,
            titel: a.title,
            neben: [
              a.assigneeId ? users[a.assigneeId]?.displayName : null,
              a.channelId ? `#${channels[a.channelId]?.name ?? ''}` : null,
              a.dueAt ? dayLabel(a.dueAt) : null,
            ].filter(Boolean).join(' · ') || null,
          }))}
          onOeffnen={(id) => setOffeneAufgabe(id)}
          onPasst={(id) => aufgabeGeprueft(id)}
          onWeg={(id) => { if (confirm(t('tasks.deleteConfirm'))) deleteTask(id); }}
        />
      ) : !Object.keys(tasks).length ? (
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
        {projekteOffen && <ProjektDialog key="projekte" onClose={() => setProjekteOffen(false)} />}
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
        /* `layout` ordnet um, wenn sich die Reihenfolge ändert — das genügt.
           Hier stand zusätzlich `layoutId={`task_${task.id}`}`, und das war
           die Lücke in der Spalte: `layoutId` ist für Übergänge zwischen
           VERSCHIEDENEN Komponenten gedacht (ein Element verschwindet hier
           und taucht dort wieder auf). Framer-Motion legt dafür eine eigene
           Projektion an und hält den Platz des alten Elements so lange frei,
           bis der Übergang fertig ist. Wird er unterbrochen — ein Umlauf
           mittendrin, ein Wechsel der Spalte, ein Scrollen —, bleibt der
           Platz reserviert: eine leere Kartenhöhe mitten in der Spalte,
           ohne dass eine Karte fehlt.
           Jede Karte hat längst einen stabilen `key`; `layoutId` brachte
           nichts dazu. Die Ideentafel nebenan macht es seit jeher ohne und
           hat das Problem nicht. */
        layout
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
        {task.vonKi && !task.geprueft && (
          <span className="task-card__ki" title={t('pruefen.hint')}>
            <Sparkles size={10} /> {t('pruefen.badge')}
          </span>
        )}

        <span className="task-card__meta">
          {zustaendig
            ? <Avatar user={zustaendig} size={17} />
            : <span className="task-card__nobody"><UserIcon size={11} /></span>}
          {kanal && <span className="task-card__chan"><Hash size={10} />{kanal.name}</span>}
          {task.projektId && projekte[task.projektId] && (
            <span className="task-card__chan" title={t('projekte.assign')}>
              <span
                className="projekt-punkt"
                style={{ background: projekte[task.projektId].farbe }}
              />
              {projekte[task.projektId].name}
            </span>
          )}
          {frist && (
            <span
              className={clsx('task-card__due', frist.ueberfaellig && 'task-card__due--late')}
              title={dateTime(task.dueAt!)}
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
  const dialogProjekte = useStore((s) => s.projekte);

  const [title, setTitle] = useState(vorgabe?.title ?? '');
  const [description, setDescription] = useState('');
  const [assigneeId, setAssigneeId] = useState(vorgabe?.assigneeId ?? '');
  const [channelId, setChannelId] = useState(activeChannelId ?? '');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [due, setDue] = useState(vorgabe?.dueAt ? tagesFeld(vorgabe.dueAt) : '');
  const [projektId, setProjektId] = useState('');

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
      projektId: projektId || null,
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
            {Object.values(users).filter((u) => !u.disabled && u.role !== 'bot' && !u.technisch).map((u) => (
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
            <option value="">{t('tasks.noChannel')}</option>
            {Object.values(channels).filter((c) => c.kind !== 'dm' && !c.archived).map((c) => (
              <option key={c.id} value={c.id}>#{c.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label">{t('projekte.assign')}</label>
          <select className="select" value={projektId} onChange={(e) => setProjektId(e.target.value)}>
            <option value="">{t('projekte.none')}</option>
            {Object.values(dialogProjekte).filter((p) => !p.archiviert).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
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
          <label className="field__label">{t('tasks.statusLabel')}</label>
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
            {Object.values(users).filter((u) => !u.disabled && u.role !== 'bot' && !u.technisch).map((u) => (
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
                  <strong>{wer?.displayName ?? t('common.unknown')}</strong>{' '}
                  {t(`tasks.event.${e.kind}` as never)}
                  {e.kind === 'comment' && e.text && <em> — {e.text}</em>}
                  {e.kind === 'status' && e.nach && <em> → {t(`tasks.status.${e.nach}` as never)}</em>}
                </span>
                <span className="task-log__when">{relativeTime(e.createdAt)}</span>
              </div>
            );
          })}
          {!verlauf?.length && <p className="muted" style={{ fontSize: 12 }}>{t('tasks.historyEmpty')}</p>}
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
