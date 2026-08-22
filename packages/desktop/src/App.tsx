import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, WifiOff } from 'lucide-react';
import { useStore } from './state/store.js';
import { t } from './i18n/index.js';
import { Cosmos } from './components/Cosmos.jsx';
import { Rail } from './components/Rail.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { ChannelHeader } from './components/ChannelHeader.jsx';
import { MessageList } from './components/MessageList.jsx';
import { Composer } from './components/Composer.jsx';
import { TypingBar } from './components/TypingBar.jsx';
import { ThreadPanel } from './components/ThreadPanel.jsx';
import { QuickSwitcher } from './components/QuickSwitcher.jsx';
import { SearchOverlay } from './components/SearchOverlay.jsx';
import { Settings } from './components/Settings.jsx';
import { CatchupPanel, GlossaryPanel, NewChannelDialog, PeoplePanel } from './components/Panels.jsx';
import { ForwardDialog, PollDialog, ReminderDialog, RemindersPanel } from './components/Dialogs.jsx';
import { ProfileCard } from './components/ProfileCard.jsx';
import { ChannelSettings } from './components/ChannelSettings.jsx';
import { Tour, tourBereitsGesehen } from './components/Tour.jsx';
import { Login } from './components/Login.jsx';
import { Setup } from './components/Setup.jsx';
import { TeamAdmin } from './components/TeamAdmin.jsx';
import { TasksBoard } from './components/TasksBoard.jsx';
import { CalendarPanel } from './components/CalendarPanel.jsx';
import { FilesPanel } from './components/FilesPanel.jsx';
import { ProtocolPanel } from './components/ProtocolPanel.jsx';
import { IdeaBoard } from './components/IdeaBoard.jsx';
import { VorschlagPosteingang } from './components/VorschlagPosteingang.jsx';
import { useVorschlaege } from './state/vorschlaege.js';
import { DownloadPanel } from './components/DownloadPanel.jsx';
import { Fernsteuerung } from './components/Fernsteuerung.jsx';
import { SystemPanel } from './components/SystemPanel.jsx';
import { UpdateBanner, UpdateWillkommen, ServerWartung } from './components/UpdateBanner.jsx';
import { MeldungBitte } from './components/MeldungBitte.jsx';
import { Toasts } from './components/Toasts.jsx';
import { Fangkorb } from './components/Fangkorb.jsx';
import { FreigabenDialog, VorfallDialog, WiederherstellungHinweis } from './components/Vertraulich.jsx';
import { clsx } from './lib/format.js';
/* Die Schlüsselarbeit für vertrauliche Kanäle hängt sich beim Laden selbst an
   den Draht zum Server. Sie steht hier ausdrücklich, obwohl der Zustand sie
   ohnehin lädt: wer diese Zeile streicht, soll merken, dass etwas fehlt. */
import './lib/vertraulich.js';

export function App() {
  const booted = useStore((s) => s.booted);
  const self = useStore((s) => s.self);
  const connection = useStore((s) => s.connection);
  const connectionDetail = useStore((s) => s.connectionDetail);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const threadParentId = useStore((s) => s.threadParentId);
  const schubladeOffen = useStore((s) => s.schubladeOffen);
  const overlay = useStore((s) => s.overlay);
  /* Der Eingang für KI-Vorschläge hängt an einem eigenen Laden, nicht an
     `overlay`: er geht mit einem Filter auf, und eine Kennung allein hat dafür
     keinen Platz. Siehe state/vorschlaege.ts. */
  const vorschlagFilter = useVorschlaege((s) => s.offen);
  const lightbox = useStore((s) => s.lightbox);
  const forwarding = useStore((s) => s.forwarding);
  const remindingAbout = useStore((s) => s.remindingAbout);
  const profileUserId = useStore((s) => s.profileUserId);

  /* Beim allerersten Mal die Einführung zeigen — danach nie wieder von selbst.
     Bewusst in einem Effekt: mitten in der Darstellung darf kein Zustand
     gesetzt werden, und beim Schließen ginge die Einführung sonst sofort
     wieder auf. */
  const angemeldet = Boolean(self && !self.mustChangePassword && !self.mustCompleteProfile);
  useEffect(() => {
    if (angemeldet && !tourBereitsGesehen()) useStore.getState().setOverlay('tour');
  }, [angemeldet]);

  /* Tastenkürzel */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const store = useStore.getState();
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); store.setOverlay('quick'); }
      else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); store.setOverlay('search'); }
      else if (mod && e.key === ',') { e.preventDefault(); store.setOverlay('settings'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); store.setOverlay('newChannel'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); store.setOverlay('tasks'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); store.setOverlay('calendar'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); store.setOverlay('files'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); store.setOverlay('ideas'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        if (store.activeChannelId) store.runCatchup(store.activeChannelId);
      } else if (e.key === 'Escape') {
        if (store.lightbox) store.setLightbox(null);
        else if (store.profileUserId) store.setProfileUser(null);
        else if (store.forwarding) store.startForward(null);
        else if (store.remindingAbout) store.startReminder(null);
        else if (store.overlay) store.setOverlay(null);
        else if (store.schubladeOffen) store.setSchublade(false);
        else if (store.threadParentId) store.openThread(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Menü-Befehle aus dem Electron-Hauptprozess */
  useEffect(() => {
    const off = window.stellium?.onMenu((action) => {
      const store = useStore.getState();
      if (action === 'settings') store.setOverlay('settings');
      if (action === 'new-channel') store.setOverlay('newChannel');
      if (action === 'quick-switch') store.setOverlay('quick');
      if (action === 'search') store.setOverlay('search');
      if (action === 'catchup' && store.activeChannelId) store.runCatchup(store.activeChannelId);
    });
    const offClick = window.stellium?.onNotificationClick((channelId) => {
      useStore.getState().openChannel(channelId);
    });
    // Dasselbe im Browser: die Benachrichtigung meldet sich über ein Ereignis.
    const imBrowser = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id) useStore.getState().openChannel(id);
    };
    window.addEventListener('stellium:kanal-oeffnen', imBrowser);
    return () => {
      off?.();
      offClick?.();
      window.removeEventListener('stellium:kanal-oeffnen', imBrowser);
    };
  }, []);

  useEffect(() => { void useStore.getState().boot(); }, []);


  if (!booted) {
    return (
      <>
        <Cosmos />
        <div className="auth">
          <Loader2 size={26} className="spin" style={{ color: 'var(--violet-soft)' }} />
        </div>
      </>
    );
  }

  if (!self) {
    return (
      <>
        <Cosmos />
        <Login />
        <Toasts />
      </>
    );
  }

  // Wer mit einem Einmal-Passwort da ist, richtet zuerst sein Konto ein.
  if (self.mustChangePassword || self.mustCompleteProfile) {
    return (
      <>
        <Cosmos />
        <Setup />
        <Toasts />
      </>
    );
  }

  const closeOverlay = () => useStore.getState().setOverlay(null);

  return (
    <>
      <Cosmos />
      <div className="rahmen">
        <ServerWartung />
        <UpdateBanner />
        <MeldungBitte />
        <div className={clsx('app', threadParentId && 'app--thread', schubladeOffen && 'app--schublade')}>
        <Rail />
        <Sidebar />
        {/* Auf dem Telefon liegt die Liste über dem Chat. Ein Tippen daneben
            schließt sie — der übliche Handgriff. */}
        <div
          className="schublade-schleier"
          onClick={() => useStore.getState().setSchublade(false)}
          aria-hidden="true"
        />

        <main className="main">
          {connection !== 'open' && (
            <div className={clsx('conn-banner', connection === 'failed' && 'conn-banner--error')}>
              {connection === 'failed'
                ? <><WifiOff size={14} /> {t('conn.lost')}</>
                : <><Loader2 size={14} className="spin" /> {t('conn.connecting')}{connectionDetail ? ` · ${connectionDetail}` : '…'}</>}
            </div>
          )}

          {activeChannelId ? (
            <>
              <ChannelHeader channelId={activeChannelId} />
              <WiederherstellungHinweis channelId={activeChannelId} />
              <MessageList channelId={activeChannelId} />
              <TypingBar channelId={activeChannelId} />
              <Composer channelId={activeChannelId} autoFocus />
            </>
          ) : (
            <div className="empty">
              <div className="empty__orb" />
              <h2>{t('app.pickChannel')}</h2>
              <p>
                {t('common.pickChannelHint', { shortcut: `${navigator.platform.includes('Mac') ? '⌘' : t('common.ctrlKey')}+K` })}
              </p>
            </div>
          )}
        </main>

        <AnimatePresence>
          {threadParentId && <ThreadPanel key={threadParentId} parentId={threadParentId} />}
        </AnimatePresence>
        </div>
      </div>

      {/* Eigener Fangkorb um die Fensterschicht: wirft ein Dialog beim
          Zeichnen, soll der Chat dahinter weiterlaufen statt mitzugehen.
          Zurückgesetzt wird, sobald ein anderes Fenster drankommt. */}
      <Fangkorb eingebettet zuruecksetzenBei={overlay}>
      <AnimatePresence>
        {overlay === 'quick' && <QuickSwitcher key="quick" onClose={closeOverlay} />}
        {overlay === 'search' && <SearchOverlay key="search" onClose={closeOverlay} />}
        {overlay === 'settings' && <Settings key="settings" onClose={closeOverlay} />}
        {overlay === 'newChannel' && <NewChannelDialog key="new" onClose={closeOverlay} />}
        {overlay === 'glossary' && <GlossaryPanel key="glossary" onClose={closeOverlay} />}
        {overlay === 'people' && <PeoplePanel key="people" onClose={closeOverlay} />}
        {overlay === 'catchup' && <CatchupPanel key="catchup" onClose={closeOverlay} />}
        {overlay === 'reminders' && <RemindersPanel key="reminders" onClose={closeOverlay} />}
        {overlay === 'team' && <TeamAdmin key="team" onClose={closeOverlay} />}
        {overlay === 'tour' && <Tour key="tour" onClose={closeOverlay} />}
        {overlay === 'tasks' && <TasksBoard key="tasks" onClose={closeOverlay} />}
        {overlay === 'calendar' && <CalendarPanel key="calendar" onClose={closeOverlay} />}
        {overlay === 'files' && <FilesPanel key="files" onClose={closeOverlay} />}
        {overlay === 'protocol' && <ProtocolPanel key="protocol" onClose={closeOverlay} />}
        {overlay === 'ideas' && <IdeaBoard key="ideas" onClose={closeOverlay} />}
        {overlay === 'download' && <DownloadPanel key="download" onClose={closeOverlay} />}
        {overlay === 'fern' && <Fernsteuerung key="fern" onClose={closeOverlay} />}
        {overlay === 'system' && <SystemPanel key="system" onClose={closeOverlay} />}
        {vorschlagFilter && (
          <VorschlagPosteingang
            key="vorschlaege"
            startFilter={vorschlagFilter}
            onClose={() => useVorschlaege.getState().schliessen()}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        <UpdateWillkommen key="neu" />
        {overlay === 'channelSettings' && activeChannelId && (
          <ChannelSettings key="chset" channelId={activeChannelId} onClose={closeOverlay} />
        )}
        {overlay === 'poll' && activeChannelId && (
          <PollDialog key="poll" channelId={activeChannelId} onClose={closeOverlay} />
        )}
        {overlay === 'vorfall' && activeChannelId && (
          <VorfallDialog key="vorfall" channelId={activeChannelId} onClose={closeOverlay} />
        )}
        {overlay === 'freigaben' && (
          <FreigabenDialog key="freigaben" channelId={activeChannelId} onClose={closeOverlay} />
        )}
      </AnimatePresence>
      </Fangkorb>

      <AnimatePresence>
        {forwarding && (
          <ForwardDialog key="forward" message={forwarding} onClose={() => useStore.getState().startForward(null)} />
        )}
        {remindingAbout && (
          <ReminderDialog key="remind" message={remindingAbout} onClose={() => useStore.getState().startReminder(null)} />
        )}
        {profileUserId && (
          <ProfileCard key="profile" userId={profileUserId} onClose={() => useStore.getState().setProfileUser(null)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {lightbox && (
          <motion.div
            className="lightbox"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => useStore.getState().setLightbox(null)}
          >
            <motion.img
              src={lightbox}
              alt=""
              initial={{ scale: 0.94 }} animate={{ scale: 1 }} exit={{ scale: 0.94 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <Toasts />
    </>
  );
}
