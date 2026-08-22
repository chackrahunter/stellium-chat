import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Bookmark, Bot, CalendarDays, Download, FolderOpen, Gauge, Inbox, Lightbulb, ListChecks, MessageSquare, Monitor, Settings, ShieldCheck, Sparkles, Star } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { imBrowser } from './DownloadPanel.jsx';
import { StatusMenu } from './StatusMenu.jsx';
import { useKiKanaele } from '../lib/ai-channels.js';
import { useVorschlaege } from '../state/vorschlaege.js';

/**
 * Was hinter dem Stern liegt.
 *
 * Die Leiste war auf vierzehn Symbole gewachsen — untereinander eine Spalte,
 * in der man suchen muss, und auf einem niedrigen Fenster passte sie nicht
 * mehr ganz hinein. Geblieben sind die Reiter des Arbeitstags; hierher
 * gewandert ist, was man selten und dann gezielt braucht.
 *
 * Warum `position: fixed` und nicht absolut in der Leiste: die Leiste ist
 * sechzig Punkte breit, das Menü ist breiter, und irgendein Vorfahr schneidet
 * am Ende immer ab. Fest positioniert hängt es an nichts und wird nirgends
 * beschnitten — dafür muss die Stelle von Hand gemessen werden.
 */
function SternMenue({ eintraege }: {
  eintraege: Array<{ id: string; symbol: ReactNode; text: string; tun: () => void }>;
}) {
  const t = useT();
  const [offen, setOffen] = useState(false);
  const [ort, setOrt] = useState<{ top: number; left: number } | null>(null);
  const knopf = useRef<HTMLButtonElement>(null);
  const kasten = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!offen) { setOrt(null); return; }
    const messen = () => {
      const r = knopf.current?.getBoundingClientRect();
      if (!r) return;
      setOrt({ top: Math.max(8, r.top), left: r.right + 10 });
    };
    messen();
    window.addEventListener('resize', messen);
    /* `true`: die Leiste selbst kann rollen, und dann wandert der Stern unter
       dem stehenden Menü weg. */
    window.addEventListener('scroll', messen, true);
    return () => {
      window.removeEventListener('resize', messen);
      window.removeEventListener('scroll', messen, true);
    };
  }, [offen]);

  /* Schließen wie überall sonst: Klick daneben, Escape. */
  useEffect(() => {
    if (!offen) return;
    const beiTaste = (e: KeyboardEvent) => { if (e.key === 'Escape') setOffen(false); };
    const beiKlick = (e: PointerEvent) => {
      const z = e.target as Node;
      if (kasten.current?.contains(z) || knopf.current?.contains(z)) return;
      setOffen(false);
    };
    document.addEventListener('keydown', beiTaste);
    document.addEventListener('pointerdown', beiKlick);
    return () => {
      document.removeEventListener('keydown', beiTaste);
      document.removeEventListener('pointerdown', beiKlick);
    };
  }, [offen]);

  if (!eintraege.length) {
    /* Ohne Einträge bleibt der Stern, was er war: ein Zeichen, kein Knopf. */
    return (
      <div className="rail__logo no-drag" title="Stellium">
        <Star size={21} color="#fff" fill="#fff" />
      </div>
    );
  }

  return (
    <>
      <button
        ref={knopf}
        className="rail__logo rail__logo--knopf no-drag"
        aria-haspopup="menu"
        aria-expanded={offen}
        title={t('nav.mehr')}
        onClick={() => setOffen((v) => !v)}
      >
        <Star size={21} color="#fff" fill="#fff" />
      </button>

      {offen && ort && (
        <div
          ref={kasten}
          className="sternmenue"
          role="menu"
          style={{ top: ort.top, left: ort.left }}
        >
          <div className="sternmenue__titel">{t('nav.mehr')}</div>
          {eintraege.map((e) => (
            <button
              key={e.id}
              className="sternmenue__zeile"
              role="menuitem"
              onClick={() => { setOffen(false); e.tun(); }}
            >
              <span className="sternmenue__symbol">{e.symbol}</span>
              {e.text}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function Rail() {
  const t = useT();
  const self = useStore((s) => s.self);
  /* Der Server schickt die Rechtekarte mit dem eigenen Konto mit — hier ist
     sie nur die Frage, ob der Knopf erscheint. Entschieden wird ohnehin
     dort: die Route prüft dasselbe Recht noch einmal. */
  const darfSystem = self?.permissions?.['system.ansehen'] === true;
  const states = useStore((s) => s.states);
  const reminders = useStore((s) => s.reminders);
  const tasks = useStore((s) => s.tasks);
  const ai = useStore((s) => s.ai);
  const offeneVorschlaege = useVorschlaege((s) => s.liste.length);
  const activeId = useStore((s) => s.activeChannelId);
  const { istKi, chatId: kiChatId } = useKiKanaele();
  const { setOverlay } = useStore.getState();

  // Chat und KI sind zwei Reiter derselben Leiste — genau einer ist aktiv.
  const kiAktiv = istKi(activeId);

  // Nur was mir zugeteilt und noch nicht fertig ist, verdient eine Zahl.
  const offeneAufgaben = Object.values(tasks).filter(
    (a) => a.assigneeId === self?.id && a.status !== 'finished',
  ).length;

  const totalUnread = Object.values(states).reduce((sum, s) => sum + (s.muted ? 0 : s.unreadCount), 0);
  const totalMentions = Object.values(states).reduce((sum, s) => sum + s.mentionCount, 0);

  return (
    <nav className="rail drag-region">
      {/* Werkzeuge statt Reiter: hier steht, was man selten und dann gezielt
          braucht. Die Leiste darunter bleibt der Arbeitstag. */}
      <SternMenue
        eintraege={[
          { id: 'catchup', symbol: <Sparkles size={17} />, text: t('nav.catchup'),
            tun: () => setOverlay('catchup') },
          { id: 'saved', symbol: <Bookmark size={17} />, text: t('nav.saved'),
            tun: () => setOverlay('search') },
          /* Nur in der installierten App: der Handschlag braucht scrypt aus
             dem Hauptprozess, den es im Browser nicht gibt. */
          ...(!imBrowser() ? [{ id: 'fern', symbol: <Monitor size={17} />, text: t('fern.titel'),
            tun: () => setOverlay('fern') }] : []),
          ...(darfSystem ? [{ id: 'system', symbol: <Gauge size={17} />, text: t('system.titel'),
            tun: () => setOverlay('system') }] : []),
          ...(self?.permissions['user.manage'] ? [{ id: 'team', symbol: <ShieldCheck size={17} />, text: t('nav.team'),
            tun: () => setOverlay('team') }] : []),
          /* Umgekehrt: wer die App schon hat, braucht keinen Weg zum
             Herunterladen. */
          ...(imBrowser() ? [{ id: 'download', symbol: <Download size={17} />, text: t('download.nav'),
            tun: () => setOverlay('download') }] : []),
        ]}
      />

      <button
        className="rail-btn no-drag"
        data-tour="chat"
        aria-pressed={!kiAktiv}
        onClick={() => useStore.getState().openLastHumanChannel()}
        title={t('nav.chat')}
      >
        <MessageSquare size={20} />
        {(totalMentions || totalUnread) > 0 && (
          <span className="rail-btn__dot">{totalMentions || (totalUnread > 99 ? '99+' : totalUnread)}</span>
        )}
      </button>

      <button
        className="rail-btn rail-btn--ki no-drag"
        data-tour="ai"
        aria-pressed={kiAktiv}
        onClick={() => (kiChatId ? useStore.getState().openChannel(kiChatId) : useStore.getState().openAiChat())}
        title={t('nav.aiChat')}
      >
        <Bot size={20} />
      </button>

      {/* Der Eingang steht direkt unter der KI, weil er ihr Ausgang ist: was
          sie im Verlauf gefunden hat, liegt hier und wartet auf ein Ja oder
          Nein. Ohne KI bliebe er für immer leer — dann steht er nur da,
          solange noch etwas Altes darin liegt. */}
      {(ai?.assistant || offeneVorschlaege > 0) && (
        <button
          className="rail-btn no-drag"
          data-tour="vorschlaege"
          onClick={() => useVorschlaege.getState().oeffnen()}
          title={t('vorschlaege.nav')}
        >
          <Inbox size={20} />
          {offeneVorschlaege > 0 && (
            <span className="rail-btn__dot">{offeneVorschlaege > 99 ? '99+' : offeneVorschlaege}</span>
          )}
        </button>
      )}

      <button className="rail-btn no-drag" data-tour="tasks" onClick={() => setOverlay('tasks')} title={t('nav.tasks')}>
        <ListChecks size={20} />
        {offeneAufgaben > 0 && <span className="rail-btn__dot">{offeneAufgaben > 99 ? '99+' : offeneAufgaben}</span>}
      </button>

      <button className="rail-btn no-drag" data-tour="calendar" onClick={() => setOverlay('calendar')} title={t('nav.calendar')}>
        <CalendarDays size={20} />
      </button>

      <button className="rail-btn no-drag" data-tour="files" onClick={() => setOverlay('files')} title={t('nav.files')}>
        <FolderOpen size={20} />
      </button>

      <button className="rail-btn no-drag" data-tour="ideas" onClick={() => setOverlay('ideas')} title={t('nav.ideas')}>
        <Lightbulb size={20} />
      </button>

      <button className="rail-btn no-drag" data-tour="reminders" onClick={() => setOverlay('reminders')} title={t('nav.reminders')}>
        <Bell size={20} />
        {reminders.length > 0 && <span className="rail-btn__dot">{reminders.length}</span>}
      </button>

      <span className="rail__spacer" />

      <button className="rail-btn no-drag" data-tour="settings" onClick={() => setOverlay('settings')} title={t('nav.settings')}>
        <Settings size={20} />
      </button>
      <StatusMenu />
    </nav>
  );
}
