import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CalendarDays, Check, ChevronLeft, ChevronRight, Clock, HelpCircle, MapPin,
  Plus, Sparkles, Trash2, X,
} from 'lucide-react';
import { EVENT_KINDS, type CalendarEvent, type EventKind } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Shell } from './Panels.jsx';
import { PruefListe } from './PruefListe.jsx';
import { clsx, localTimeFor } from '../lib/format.js';

const ART_FARBE: Record<EventKind, string> = {
  meeting: 'var(--violet)',
  deadline: 'var(--red)',
  absence: 'var(--amber)',
  holiday: 'var(--green)',
  reminder: 'var(--blue)',
};

const TAG = 86_400_000;

/** Montag 00:00 der Woche, in der das Datum liegt. */
function wochenStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const versatz = (d.getDay() + 6) % 7;
  return d.getTime() - versatz * TAG;
}

function uhrzeit(ms: number, sprache: string): string {
  return new Date(ms).toLocaleTimeString(sprache, { hour: '2-digit', minute: '2-digit' });
}

export function CalendarPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const events = useStore((s) => s.events);
  const self = useStore((s) => s.self);
  const { loadEvents, terminGeprueft, deleteEvent } = useStore.getState();

  const [anker, setAnker] = useState(() => wochenStart(Date.now()));
  const [neuOffen, setNeuOffen] = useState<number | null>(null);
  const [offenerTermin, setOffenerTermin] = useState<string | null>(null);
  /** Der Reiter „Prüfen": nur, was die KI selbst eingetragen hat. */
  const [pruefen, setPruefen] = useState(false);

  const bis = anker + 7 * TAG;
  useEffect(() => { loadEvents(anker, bis); }, [anker, bis, loadEvents]);

  const tage = useMemo(() => Array.from({ length: 7 }, (_, i) => anker + i * TAG), [anker]);

  const proTag = useMemo(() => {
    const karte = new Map<number, CalendarEvent[]>();
    for (const tag of tage) karte.set(tag, []);
    for (const e of Object.values(events)) {
      for (const tag of tage) {
        // Ein Termin erscheint an jedem Tag, den er berührt.
        if (e.startsAt < tag + TAG && e.endsAt > tag) karte.get(tag)!.push(e);
      }
    }
    for (const liste of karte.values()) liste.sort((a, b) => a.startsAt - b.startsAt);
    return karte;
  }, [events, tage]);

  const heute = new Date().setHours(0, 0, 0, 0);
  const sprache = self?.language ?? 'de';

  const ungeprueft = useMemo(
    () => Object.values(events).filter((e) => e.vonKi && !e.geprueft),
    [events],
  );
  /* Leerer Reiter führt ins Nichts — dann zurück auf die Woche. */
  useEffect(() => {
    if (pruefen && !ungeprueft.length) setPruefen(false);
  }, [pruefen, ungeprueft.length]);

  return (
    <Shell
      title={t('calendar.title')}
      subtitle={t('calendar.subtitle')}
      icon={<CalendarDays size={18} />}
      onClose={onClose}
      width={1100}
      actions={
        <>
          <button className="icon-btn" onClick={() => setAnker((a) => a - 7 * TAG)}><ChevronLeft size={16} /></button>
          <button className="pill" onClick={() => setAnker(wochenStart(Date.now()))}>{t('calendar.today')}</button>
          <button className="icon-btn" onClick={() => setAnker((a) => a + 7 * TAG)}><ChevronRight size={16} /></button>
          {ungeprueft.length > 0 && (
            <button
              className={clsx('pill', pruefen ? 'pill--accent' : 'pill--warn')}
              onClick={() => setPruefen((v) => !v)}
            >
              <Sparkles size={13} /> {t('pruefen.count', { n: ungeprueft.length })}
            </button>
          )}
          <button className="pill pill--accent" onClick={() => setNeuOffen(Date.now())}>
            <Plus size={13} /> {t('calendar.new')}
          </button>
        </>
      }
    >
      {pruefen ? (
        <PruefListe
          eintraege={ungeprueft.map((e) => ({
            id: e.id,
            titel: e.title,
            neben: new Date(e.startsAt).toLocaleString(sprache, {
              weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
            }),
          }))}
          onOeffnen={(id) => { setPruefen(false); setOffenerTermin(id); }}
          onPasst={(id) => terminGeprueft(id)}
          onWeg={(id) => { if (confirm(t('calendar.delete'))) deleteEvent(id); }}
        />
      ) : (
      <div className="week">
        {tage.map((tag) => {
          const liste = proTag.get(tag) ?? [];
          const d = new Date(tag);
          return (
            <div key={tag} className={clsx('week__day', tag === heute && 'week__day--today')}>
              <header className="week__head" onDoubleClick={() => setNeuOffen(tag + 9 * 3_600_000)}>
                <span className="week__dow">{d.toLocaleDateString(sprache, { weekday: 'short' })}</span>
                <span className="week__num">{d.getDate()}</span>
              </header>

              <div className="week__list">
                <AnimatePresence initial={false}>
                  {liste.map((e) => (
                    <motion.button
                      key={e.id}
                      layout
                      className="week__ev"
                      style={{ borderLeftColor: ART_FARBE[e.kind] }}
                      onClick={() => setOffenerTermin(e.id)}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      <span className="week__ev-time">
                        {e.allDay ? t('calendar.allDay') : uhrzeit(e.startsAt, sprache)}
                      </span>
                      <span className="week__ev-title">{e.title}</span>
                    </motion.button>
                  ))}
                </AnimatePresence>
                {!liste.length && <span className="week__empty">·</span>}
              </div>

              <button className="week__add" onClick={() => setNeuOffen(tag + 9 * 3_600_000)} title={t('calendar.new')}>
                <Plus size={13} />
              </button>
            </div>
          );
        })}
      </div>
      )}

      <AnimatePresence>
        {neuOffen !== null && <EventDialog key="neu" start={neuOffen} onClose={() => setNeuOffen(null)} />}
        {offenerTermin && events[offenerTermin] && (
          <EventDetail key={offenerTermin} event={events[offenerTermin]} onClose={() => setOffenerTermin(null)} />
        )}
      </AnimatePresence>
    </Shell>
  );
}

/** Wert für <input type="datetime-local"> — ohne Zeitzonenverschiebung. */
function feldWert(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function EventDialog({ start, onClose }: { start: number; onClose: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const self = useStore((s) => s.self);

  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<EventKind>('meeting');
  const [startsAt, setStartsAt] = useState(feldWert(start));
  const [endsAt, setEndsAt] = useState(feldWert(start + 3_600_000));
  const [allDay, setAllDay] = useState(false);
  const [location, setLocation] = useState('');
  const [channelId, setChannelId] = useState('');
  const [teilnehmer, setTeilnehmer] = useState<Set<string>>(new Set());

  const absenden = () => {
    if (!title.trim()) return;
    useStore.getState().createEvent({
      title: title.trim(),
      kind,
      startsAt: new Date(startsAt).getTime(),
      endsAt: new Date(endsAt).getTime(),
      allDay,
      location: location.trim() || null,
      channelId: channelId || null,
      attendeeIds: [...teilnehmer],
    });
    onClose();
  };

  return (
    <Shell title={t('calendar.new')} icon={<Plus size={18} />} onClose={onClose} width={540}>
      <div className="field">
        <label className="field__label">{t('calendar.eventTitle')}</label>
        <input
          className="input" value={title} autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') absenden(); }}
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label className="field__label">{t('calendar.starts')}</label>
          <input className="input" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('calendar.ends')}</label>
          <input className="input" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label">{t('calendar.kind.meeting')}</label>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
            {EVENT_KINDS.map((k) => <option key={k} value={k}>{t(`calendar.kind.${k}` as never)}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field__label">{t('calendar.location')}</label>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
      </div>

      <label className="switch">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        <span>{t('calendar.allDay')}</span>
      </label>

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
        <label className="field__label">{t('calendar.attendees')}</label>
        <div className="chip-grid">
          {Object.values(users).filter((u) => !u.disabled && u.role !== 'bot' && !u.technisch && u.id !== self?.id).map((u) => {
            const drin = teilnehmer.has(u.id);
            const zeit = localTimeFor(u.timezone);
            return (
              <button
                key={u.id}
                className={clsx('chip', drin && 'chip--on')}
                onClick={() => setTeilnehmer((alt) => {
                  const neu = new Set(alt);
                  if (drin) neu.delete(u.id); else neu.add(u.id);
                  return neu;
                })}
                // Zeitzonen sind der häufigste Grund für misslungene Termine.
                title={zeit?.time ? t('calendar.otherTimezone', { name: u.displayName, time: zeit.time }) : undefined}
              >
                <Avatar user={u} size={16} /> {u.displayName}
                {zeit?.offHours && <span className="chip__moon">🌙</span>}
              </button>
            );
          })}
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

function EventDetail({ event, onClose }: { event: CalendarEvent; onClose: () => void }) {
  const t = useT();
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const { respondEvent, deleteEvent } = useStore.getState();
  const sprache = self?.language ?? 'de';

  const meine = event.attendees.find((a) => a.userId === self?.id);
  const darfLoeschen = event.createdBy === self?.id || self?.permissions['event.manage'];

  return (
    <Shell
      title={event.title}
      icon={<CalendarDays size={18} />}
      onClose={onClose}
      width={520}
      actions={darfLoeschen ? (
        <button
          className="icon-btn icon-btn--danger"
          onClick={() => { deleteEvent(event.id); onClose(); }}
          title={t('calendar.delete')}
        >
          <Trash2 size={16} />
        </button>
      ) : undefined}
    >
      <p className="event-when">
        <Clock size={13} />
        {event.allDay
          ? t('calendar.allDay')
          : `${new Date(event.startsAt).toLocaleString(sprache)} – ${uhrzeit(event.endsAt, sprache)}`}
      </p>
      {event.location && <p className="event-when"><MapPin size={13} /> {event.location}</p>}
      {event.description && <p style={{ marginTop: 10 }}>{event.description}</p>}

      {!!event.attendees.length && (
        <div className="field">
          <label className="field__label">{t('calendar.attendees')}</label>
          <div className="chip-grid">
            {event.attendees.map((a) => {
              const u = users[a.userId];
              const zeit = localTimeFor(u?.timezone);
              return (
                <span
                  key={a.userId}
                  className={clsx('chip', a.response === 'yes' && 'chip--yes', a.response === 'no' && 'chip--no')}
                  title={zeit?.time && u ? t('calendar.otherTimezone', { name: u.displayName, time: zeit.time }) : undefined}
                >
                  <Avatar user={u} size={16} /> {u?.displayName ?? '—'}
                  {a.response === 'yes' && <Check size={11} />}
                  {a.response === 'no' && <X size={11} />}
                  {a.response === 'maybe' && <HelpCircle size={11} />}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {meine && (
        <div className="panel__foot" style={{ gap: 8 }}>
          <button
            className={clsx('btn', meine.response === 'yes' && 'btn--primary')}
            onClick={() => respondEvent(event.id, 'yes')}
          >{t('calendar.yes')}</button>
          <button
            className={clsx('btn', meine.response === 'maybe' && 'btn--primary')}
            onClick={() => respondEvent(event.id, 'maybe')}
          >{t('calendar.maybe')}</button>
          <button
            className={clsx('btn', meine.response === 'no' && 'btn--primary')}
            onClick={() => respondEvent(event.id, 'no')}
          >{t('calendar.no')}</button>
        </div>
      )}
    </Shell>
  );
}
