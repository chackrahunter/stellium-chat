import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, WifiOff } from 'lucide-react';
import { useStore } from './state/store.js';
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
import { Login } from './components/Login.jsx';
import { Setup } from './components/Setup.jsx';
import { TeamAdmin } from './components/TeamAdmin.jsx';
import { Toasts } from './components/Toasts.jsx';
import { clsx } from './lib/format.js';

export function App() {
  const booted = useStore((s) => s.booted);
  const self = useStore((s) => s.self);
  const connection = useStore((s) => s.connection);
  const connectionDetail = useStore((s) => s.connectionDetail);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const threadParentId = useStore((s) => s.threadParentId);
  const overlay = useStore((s) => s.overlay);
  const lightbox = useStore((s) => s.lightbox);
  const forwarding = useStore((s) => s.forwarding);
  const remindingAbout = useStore((s) => s.remindingAbout);
  const profileUserId = useStore((s) => s.profileUserId);

  /* Tastenkürzel */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const store = useStore.getState();
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); store.setOverlay('quick'); }
      else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); store.setOverlay('search'); }
      else if (mod && e.key === ',') { e.preventDefault(); store.setOverlay('settings'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); store.setOverlay('newChannel'); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        if (store.activeChannelId) store.runCatchup(store.activeChannelId);
      } else if (e.key === 'Escape') {
        if (store.lightbox) store.setLightbox(null);
        else if (store.profileUserId) store.setProfileUser(null);
        else if (store.forwarding) store.startForward(null);
        else if (store.remindingAbout) store.startReminder(null);
        else if (store.overlay) store.setOverlay(null);
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
    return () => { off?.(); offClick?.(); };
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
      <div className={clsx('app', threadParentId && 'app--thread')}>
        <Rail />
        <Sidebar />

        <main className="main">
          {connection !== 'open' && (
            <div className={clsx('conn-banner', connection === 'failed' && 'conn-banner--error')}>
              {connection === 'failed'
                ? <><WifiOff size={14} /> Verbindung verloren — bitte neu anmelden</>
                : <><Loader2 size={14} className="spin" /> Verbinde mit dem Server{connectionDetail ? ` · ${connectionDetail}` : '…'}</>}
            </div>
          )}

          {activeChannelId ? (
            <>
              <ChannelHeader channelId={activeChannelId} />
              <MessageList channelId={activeChannelId} />
              <TypingBar channelId={activeChannelId} />
              <Composer channelId={activeChannelId} autoFocus />
            </>
          ) : (
            <div className="empty">
              <div className="empty__orb" />
              <h2>Wähle einen Kanal</h2>
              <p>
                Links geht es los. Mit {navigator.platform.includes('Mac') ? '⌘' : 'Strg'}+K springst du
                direkt zu jedem Kanal oder Menschen.
              </p>
            </div>
          )}
        </main>

        <AnimatePresence>
          {threadParentId && <ThreadPanel key={threadParentId} parentId={threadParentId} />}
        </AnimatePresence>
      </div>

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
        {overlay === 'poll' && activeChannelId && (
          <PollDialog key="poll" channelId={activeChannelId} onClose={closeOverlay} />
        )}
      </AnimatePresence>

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
