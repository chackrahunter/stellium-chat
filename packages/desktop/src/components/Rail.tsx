import { Bell, Bookmark, Bot, CalendarDays, Download, FolderOpen, Gauge, Inbox, Lightbulb, ListChecks, MessageSquare, Monitor, Settings, ShieldCheck, Sparkles, Star } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { imBrowser } from './DownloadPanel.jsx';
import { StatusMenu } from './StatusMenu.jsx';
import { useKiKanaele } from '../lib/ai-channels.js';
import { useVorschlaege } from '../state/vorschlaege.js';

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
      <div className="rail__logo no-drag" title="Stellium">
        <Star size={21} color="#fff" fill="#fff" />
      </div>

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

      {/* Nur im Browser: wer die App schon installiert hat, braucht keinen
          Weg zum Herunterladen. imBrowser() ist bewusst keine Zustandsabfrage —
          window.stellium ändert sich zur Laufzeit nie. */}
      {imBrowser() && (
        <button className="rail-btn no-drag" onClick={() => setOverlay('download')} title={t('download.nav')}>
          <Download size={20} />
        </button>
      )}

      <button className="rail-btn no-drag" data-tour="ideas" onClick={() => setOverlay('ideas')} title={t('nav.ideas')}>
        <Lightbulb size={20} />
      </button>

      {/* Umgekehrt zum Herunterladen oben: Fernsteuerung gibt es NUR in der
          installierten App. Sie läuft über den Hauptprozess, weil der
          Handschlag scrypt braucht — im Browser gibt es das nicht. */}
      {!imBrowser() && (
        <button className="rail-btn no-drag" onClick={() => setOverlay('fern')} title={t('fern.titel')}>
          <Monitor size={20} />
        </button>
      )}

      {/* Anders als die Fernsteuerung überall: die Werte kommen über die
          gewöhnliche Schnittstelle und brauchen keinen Hauptprozess. Web,
          Mac, Windows, Linux — überall dasselbe. */}
      {darfSystem && (
        <button className="rail-btn no-drag" onClick={() => setOverlay('system')} title={t('system.titel')}>
          <Gauge size={20} />
        </button>
      )}

      <button className="rail-btn no-drag" onClick={() => setOverlay('catchup')} title={t('nav.catchup')}>
        <Sparkles size={20} />
      </button>

      <button className="rail-btn no-drag" onClick={() => setOverlay('search')} title={t('nav.saved')}>
        <Bookmark size={20} />
      </button>

      <button className="rail-btn no-drag" data-tour="reminders" onClick={() => setOverlay('reminders')} title={t('nav.reminders')}>
        <Bell size={20} />
        {reminders.length > 0 && <span className="rail-btn__dot">{reminders.length}</span>}
      </button>

      {self?.permissions['user.manage'] && (
        <button className="rail-btn no-drag" data-tour="team" onClick={() => setOverlay('team')} title={t('nav.team')}>
          <ShieldCheck size={20} />
        </button>
      )}

      <span className="rail__spacer" />

      <button className="rail-btn no-drag" data-tour="settings" onClick={() => setOverlay('settings')} title={t('nav.settings')}>
        <Settings size={20} />
      </button>
      <StatusMenu />
    </nav>
  );
}
