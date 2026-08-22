import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Bookmark, Bot, CalendarDays, Download, FolderOpen, Gauge, Inbox, Lightbulb, ListChecks, Mail, MailSearch, MessageSquare, Monitor, NotebookPen, Settings, ShieldCheck, Sparkles, Star, Users } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { imBrowser } from './DownloadPanel.jsx';
import { StatusMenu } from './StatusMenu.jsx';
import { useKiKanaele } from '../lib/ai-channels.js';
import { useVorschlaege } from '../state/vorschlaege.js';
import { usePartnerGruppenUi } from '../state/partnergruppen.js';
import { counterLabel } from '../lib/format.js';

/**
 * Was hinter dem Stern liegt.
 *
 * Die Leiste war auf vierzehn Symbole gewachsen — untereinander eine Spalte,
 * in der man suchen muss, und auf einem niedrigen Fenster passte sie nicht
 * mehr ganz hinein. Geblieben sind die Reiter des Arbeitstags; hierher
 * gewandert ist, was man selten und dann gezielt braucht.
 *
 * Warum es am `document.body` hängt und nicht in der Leiste:
 *
 * `.rail` trägt `backdrop-filter`. Das erzeugt einen eigenen Stapelkontext —
 * und, weniger bekannt, es macht die Leiste zum Bezugsrahmen für
 * `position: fixed` darin. Ein Menü als Kind der Leiste ist damit doppelt
 * gefangen: seine Stelle rechnet gegen die Leiste statt gegen das Fenster,
 * und sein `z-index` konkurriert nur INNERHALB der Leiste. Die Seitenleiste
 * daneben malt als späteres Geschwister über die ganze Leiste hinweg — das
 * Menü verschwand dahinter, egal wie hoch der Wert stand.
 *
 * Am `body` hängt es an nichts und wird nirgends beschnitten. Dafür muss die
 * Stelle von Hand gemessen werden; das erledigt der Effekt darunter.
 * `StatusMenu` geht denselben Weg, aus demselben Grund.
 */
function SternMenue({ eintraege }: {
  eintraege: Array<{ id: string; symbol: ReactNode; text: string; tun: () => void }>;
}) {
  const t = useT();
  const [offen, setOffen] = useState(false);
  const [ort, setOrt] = useState<{ top: number; left: number; maxHoehe: number } | null>(null);
  const knopf = useRef<HTMLButtonElement>(null);
  const kasten = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!offen) { setOrt(null); return; }
    const messen = () => {
      const r = knopf.current?.getBoundingClientRect();
      if (!r) return;
      /* Arabisch ist eine der 22 Sprachen, und dort setzt die Oberfläche
         `dir="rtl"`. Die Leiste wandert damit an den RECHTEN Fensterrand —
         `r.right` liegt dann fast auf der Fensterbreite, und ein Menü zehn
         Punkte weiter rechts steht außerhalb des Bildes. Der Klick auf den
         Stern sähe wirkungslos aus. Das Statusmenü daneben rechnet aus
         demselben Grund so. */
      const vonRechts = getComputedStyle(document.documentElement).direction === 'rtl';
      const breite = kasten.current?.offsetWidth ?? 210;
      const gewuenscht = vonRechts ? r.left - breite - 10 : r.right + 10;
      const links = Math.max(8, Math.min(gewuenscht, window.innerWidth - breite - 8));
      const oben = Math.max(8, r.top);
      /* Die Höhe vom MENÜANFANG aus begrenzen, nicht vom Fensteranfang: auf
         macOS sitzt der Stern wegen der Fensterknöpfe erst bei y≈58, und
         `100vh` ließe das Menü bei niedrigen Fenstern unten herausragen,
         ohne zu rollen. */
      const neu = { top: oben, left: links, maxHoehe: window.innerHeight - oben - 8 };
      /* Nur setzen, wenn sich wirklich etwas geaendert hat. `scroll` mit
         `capture` feuert bei jedem Rollen irgendwo in der App — ohne diesen
         Vergleich erzwaenge jedes Rollen in der Nachrichtenliste ein neues
         Layout und ein Neuzeichnen des offenen Menues. */
      setOrt((alt) => (alt && alt.top === neu.top && alt.left === neu.left
        && alt.maxHoehe === neu.maxHoehe ? alt : neu));
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

  /* Fokus hinein, sobald es offen ist.
     Seit der Kasten am `body` hängt, steht er im Dokument hinter allem
     anderen — ohne diesen Umzug führte Tab vom Stern nicht ins Menü, sondern
     durch die ganze App, während das Menü offen stehen blieb. */
  useEffect(() => {
    if (!offen) return;
    kasten.current?.querySelector<HTMLButtonElement>('.sternmenue__zeile')?.focus();
  }, [offen]);

  /* Schließen wie überall sonst: Klick daneben, Escape. Dazu die
     Pfeiltasten — `role="menu"` verspricht sie, und ein Versprechen, das die
     Tastatur nicht einlöst, ist schlimmer als gar keine Rolle. */
  useEffect(() => {
    if (!offen) return;
    const beiTaste = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOffen(false);
        /* Zurück zum Auslöser, sonst landet der Fokus am Dokumentanfang und
           man muss sich neu durchhangeln. */
        knopf.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const zeilen = Array.from(
        kasten.current?.querySelectorAll<HTMLButtonElement>('.sternmenue__zeile') ?? []);
      if (!zeilen.length) return;
      e.preventDefault();
      const jetzt = zeilen.indexOf(document.activeElement as HTMLButtonElement);
      const schritt = e.key === 'ArrowDown' ? 1 : -1;
      /* Umlaufend: am Ende wieder oben. Wer bis unten kommt, will meist
         zurück zum Anfang und nicht steckenbleiben. */
      zeilen[(jetzt + schritt + zeilen.length) % zeilen.length].focus();
    };
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

  /* Schließt ein offenes Menü, wenn die Liste währenddessen leer wird (etwa
     weil eine Berechtigung per Live-Update verschwindet). Ohne das bliebe
     `offen` auf `true` stehen, obwohl unten gleich der Knopf samt Menü durch
     das bloße Sternzeichen ersetzt wird — die beiden Effekte oben blieben
     dann mit ihren globalen keydown-/pointerdown-Zuhörern angemeldet, ohne
     dass es noch etwas zu schließen gäbe. */
  useEffect(() => {
    if (!eintraege.length) setOffen(false);
  }, [eintraege.length]);

  if (!eintraege.length) {
    /* Heute unerreichbar: `Rail()` liefert weiter unten zwei Einträge
       (`catchup`, `saved`) bedingungslos mit, `eintraege.length` ist also nie
       0. Trotzdem absichtlich BEHALTEN und nicht entfernt — `SternMenue` ist
       eine allgemeine Komponente, keine an genau diese zwei Zeilen gebundene,
       und der Kommentar direkt am Aufruf unten hält fest, dass ohne Einträge
       ausdrücklich ein bloßes Zeichen gewollt ist, kein leerer Knopf mit
       leerem Menü darunter. Kommt später ein drittes, bedingtes Kriterium für
       `catchup` oder `saved` hinzu, wird dieser Zweig wieder erreichbar — dann
       soll er korrekt sein und nicht erst dann repariert werden müssen:
       `data-tour="stern"` bleibt darum erhalten (sonst verschwände der
       Tour-Schritt lautlos, weil sein Ziel-Selektor ins Leere liefe), und der
       Effekt oben räumt die globalen Zuhörer auf, falls das Menü gerade offen
       stand, als die Liste leer wurde. */
    return (
      <div className="rail__logo no-drag" title="Stellium" data-tour="stern">
        <Star size={21} color="#fff" fill="#fff" />
      </div>
    );
  }

  return (
    <>
      <button
        ref={knopf}
        className="rail__logo rail__logo--knopf no-drag"
        data-tour="stern"
        aria-haspopup="menu"
        aria-expanded={offen}
        title={t('nav.mehr')}
        onClick={() => setOffen((v) => !v)}
      >
        <Star size={21} color="#fff" fill="#fff" />
      </button>

      {offen && ort && createPortal(
        <div
          ref={kasten}
          className="sternmenue"
          role="menu"
          style={{ top: ort.top, left: ort.left, maxHeight: ort.maxHoehe }}
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
        </div>,
        document.body,
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
            /* Nicht 'search': SearchOverlay startet dort immer auf dem
               Such-Reiter, „Gemerkte Nachrichten" bräuchte dann einen
               zweiten Klick auf den Reiter „Gemerkt" im Fenster selbst.
               'saved' öffnet dieselbe Tafel, aber gleich auf dem richtigen
               Reiter (siehe SearchOverlay.tsx, initialTab). */
            tun: () => setOverlay('saved') },
          /* Nur in der installierten App: der Handschlag braucht scrypt aus
             dem Hauptprozess, den es im Browser nicht gibt. */
          ...(!imBrowser() ? [{ id: 'fern', symbol: <Monitor size={17} />, text: t('fern.titel'),
            tun: () => setOverlay('fern') }] : []),
          ...(darfSystem ? [{ id: 'system', symbol: <Gauge size={17} />, text: t('system.titel'),
            tun: () => setOverlay('system') }] : []),
          ...(self?.permissions['user.manage'] ? [{ id: 'team', symbol: <ShieldCheck size={17} />, text: t('nav.team'),
            tun: () => setOverlay('team') }] : []),
          /* Kunden, Firmen, Bewerber und so weiter einordnen — ein
             gelegentliches, gezieltes Aufräumen, kein täglicher Reiter,
             deshalb hier im Stern statt unten in der Leiste. Eigener Laden
             (state/partnergruppen.ts) statt setOverlay(): dieselbe
             Begründung wie bei useVorschlaege weiter oben — state/store.ts
             wird gerade an anderer Stelle bearbeitet. Dieselbe Schwelle wie
             beim Postfach selbst: `mail.lesen` genügt zum Ansehen. */
          ...(self?.permissions['mail.lesen'] ? [{ id: 'partnerGruppen', symbol: <Users size={17} />,
            text: t('partnerGruppen.nav'), tun: () => usePartnerGruppenUi.getState().oeffnen() }] : []),
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
          <span className="rail-btn__dot"><bdi>{counterLabel(totalMentions || totalUnread)}</bdi></span>
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
            <span className="rail-btn__dot"><bdi>{counterLabel(offeneVorschlaege)}</bdi></span>
          )}
        </button>
      )}

      <button className="rail-btn no-drag" data-tour="tasks" onClick={() => setOverlay('tasks')} title={t('nav.tasks')}>
        <ListChecks size={20} />
        {offeneAufgaben > 0 && <span className="rail-btn__dot"><bdi>{counterLabel(offeneAufgaben)}</bdi></span>}
      </button>

      {/* Die Unternehmenspost. Steht bei den Aufgaben und nicht hinter dem
          Stern: das ist Tagesgeschäft, kein selten gebrauchtes Werkzeug.
          Wer `mail.lesen` nicht hat, sieht den Reiter gar nicht — eine leere
          Tafel wäre schlechter als keine. */}
      {self?.permissions['mail.lesen'] && (
        <button className="rail-btn no-drag" onClick={() => setOverlay('post')} title={t('post.titel')}>
          <Mail size={20} />
        </button>
      )}

      {/* Was die KI aus der Post oben gemacht hat — direkt daneben, weil beide
          derselbe Rundgang durch dasselbe Postfach sind, nur mit anderem
          Blick. Dieselbe Schwelle wie beim Postfach selbst: `mail.lesen`, kein
          engeres Recht (siehe routes.ts, GET /api/post/meldungen). */}
      {self?.permissions['mail.lesen'] && (
        <button className="rail-btn no-drag" onClick={() => setOverlay('postMeldungen')} title={t('postSichtung.titel')}>
          <MailSearch size={20} />
        </button>
      )}

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

      <button className="rail-btn no-drag" data-tour="notizen" onClick={() => setOverlay('notizen')} title={t('nav.notizen')}>
        <NotebookPen size={20} />
      </button>

      <span className="rail__spacer" />

      <button className="rail-btn no-drag" data-tour="settings" onClick={() => setOverlay('settings')} title={t('nav.settings')}>
        <Settings size={20} />
      </button>
      <StatusMenu />
    </nav>
  );
}
