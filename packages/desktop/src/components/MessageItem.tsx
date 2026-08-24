import { memo, useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, Bell, Bookmark, Check, CheckCheck, Copy, EyeOff, Forward, Languages, Loader2, Lock,
  MessageSquare, MoreHorizontal, Pencil, Pin, RefreshCw, Smile, Sparkles, Trash2,
  Unlock,
} from 'lucide-react';
import {
  DELETE_FOR_ALL_WINDOW_MS, EDIT_WINDOW_MS, minutesLeft,
  withinDeleteWindow, withinEditWindow, type Attachment, type Message,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { spracheName, useT } from '../i18n/index.js';
import { fileUrl } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { Markdown } from './Markdown.jsx';
import { EmojiPicker } from './EmojiPicker.jsx';
import { PollCard } from './PollCard.jsx';
import { VoiceMessage } from './VoiceMessage.jsx';
import { LinkPreviewCard } from './LinkPreviewCard.jsx';
import { clsx, fileSize, languageInfo, timeOfDay, zeitAusSicht } from '../lib/format.js';
import { sichereRaender } from '../lib/klemmen.js';
import { useKlartext, useVerschlosseneDatei } from './Vertraulich.jsx';
import { emojiVorschlaege, useEmojiKatalog } from '../emoji/katalog.js';
import { kiVorschlaegeAnfordern, useKiVorschlag } from '../state/emoji-vorschlaege.js';
import type { TranslationKey } from '../i18n/index.js';

interface Props {
  message: Message;
  grouped: boolean;
  inThread?: boolean;
}

const QUICK_EMOJI = ['👍', '🎉', '👀', '❤️', '🚀', '✅'];

export const MessageItem = memo(function MessageItem({ message, grouped, inThread = false }: Props) {
  const t = useT();
  const self = useStore((s) => s.self);
  const author = useStore((s) => s.users[message.userId]);
  const showOriginal = useStore((s) => s.showOriginal[message.id] ?? false);
  const translating = useStore((s) => s.translating[message.id] ?? false);
  const roundTrip = useStore((s) => s.roundTrips[message.id]);
  const highlighted = useStore((s) => s.highlightMessageId === message.id);
  const {
    react, toggleOriginal, requestTranslation, requestRoundTrip,
    openThread, deleteMessage, editMessage, pin, save, setLightbox,
    startForward, startReminder, setProfileUser,
  } = useStore.getState();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  /* Das „…"-Menü hängt per Portal direkt am <body>, nicht mehr verschachtelt
     in der Werkzeugleiste. Vorher lag es dort als `position: absolute`, und
     .stream (Nachrichtenliste), .main, .app und .rahmen schneiden alle mit
     overflow. Bei der letzten Nachricht — direkt über dem Eingabefeld —
     blieb unterhalb kein Platz mehr: das Menü öffnete trotzdem stur nach
     unten und wurde von .stream am eigenen Rand abgeschnitten, sichtbar als
     dunkler, abgerissener Kasten über der Eingabezeile. moreOrten() misst
     jetzt die echte Lage des Knopfs und dreht die Öffnungsrichtung um, wenn
     unten kein Platz bleibt — siehe ContextMenu.tsx für dasselbe Muster. */
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [moreOrt, setMoreOrt] = useState<{ left: number; top: number } | null>(null);

  const moreOrten = useCallback(() => {
    const knopf = moreBtnRef.current;
    const kasten = moreMenuRef.current;
    if (!knopf || !kasten) return;
    const k = knopf.getBoundingClientRect();
    const rand = sichereRaender();
    const breite = kasten.offsetWidth;
    const hoehe = kasten.offsetHeight;
    const left = Math.max(
      8 + rand.links,
      Math.min(k.right - breite, window.innerWidth - breite - 8 - rand.rechts),
    );
    // Zuerst unter dem Knopf versuchen, wie bisher; reicht der Platz nicht —
    // eben der gemeldete Fall bei der letzten Nachricht — nach oben klappen.
    let top = k.bottom + 4;
    if (top + hoehe > window.innerHeight - 8 - rand.unten) top = k.top - hoehe - 4;
    setMoreOrt({ left, top: Math.max(8 + rand.oben, top) });
  }, []);

  useLayoutEffect(() => {
    if (menuOpen) moreOrten();
  }, [menuOpen, moreOrten]);

  // Auch bei kleinem oder verändertem Fenster an der richtigen Stelle bleiben.
  useEffect(() => {
    if (!menuOpen) return;
    window.addEventListener('resize', moreOrten);
    return () => window.removeEventListener('resize', moreOrten);
  }, [menuOpen, moreOrten]);

  /* Entschlüsselt wird beim Anzeigen. In gewöhnlichen Kanälen kommt der Text
     unverändert zurück — die Prüfung kostet einen Zeichenvergleich. */
  const vertraulich = useStore((s) => Boolean(s.channels[message.channelId]?.vertraulich));
  const { text: klartext, unlesbar } = useKlartext(message.channelId, message.text);

  const isMine = self?.id === message.userId;
  // Bearbeiten und Zurücknehmen sind zeitlich begrenzt: nach zwei Stunden ist
  // die Nachricht Teil eines Verlaufs, auf den sich andere bezogen haben.
  const darfBearbeiten = isMine && withinEditWindow(message.createdAt) && message.kind !== 'poll';
  const darfFuerAlleLoeschen =
    (isMine && withinDeleteWindow(message.createdAt)) || Boolean(self?.permissions['message.delete_any']);
  const restBearbeiten = minutesLeft(message.createdAt, EDIT_WINDOW_MS);
  const restLoeschen = minutesLeft(message.createdAt, DELETE_FOR_ALL_WINDOW_MS);
  const isMention = self ? message.mentionUserIds.includes(self.id) : false;
  const translation = message.translation;
  /* Das Modell gibt bei Umgangssprache ohne Satzzeichen gelegentlich den
     Eingabetext zurück, statt zu übersetzen — gemessen in 37 % der Fälle bei
     Englisch als Quelle. Der Server fasst dann nach und markiert, wenn auch
     das nichts half. Diesen Fall darf die Oberfläche nicht als Übersetzung
     ausgeben: „Übersetzt aus English" über unübersetztem Englisch ist
     schlimmer als gar keine Angabe, weil es den Leser in die Irre führt. */
  const unuebersetzt = Boolean(translation?.unuebersetzt);
  const hasTranslation = Boolean(translation && translation.text !== message.text) && !unuebersetzt;
  const bodyText = hasTranslation && !showOriginal ? translation!.text : klartext;
  /*
   * hasTranslation wird auch dann true, wenn der Server gar nichts
   * übersetzt hat, sondern nur eine Maßangabe umgerechnet wurde — zwei
   * Konten derselben Sprache, unterschiedliche Zeitzone (siehe
   * messwerteFuerEmpfaenger(), translation/index.ts): translation.lang
   * entspricht dann message.sourceLang, der Text unterscheidet sich aber
   * trotzdem ("25 °C" -> "77 °F (25 °C)"). Ohne diese Unterscheidung
   * behauptete die Pille darunter fälschlich "Translated from English".
   */
  const nurMasseinheiten = hasTranslation && message.sourceLang === translation?.lang;

  /*
   * Emoji-Reaktionsvorschläge — örtlich, aus dem Namensbestand.
   *
   * Sprache: dieselbe, in der bodyText oben gewählt wurde (nicht zwingend die
   * Ausgangssprache der Nachricht). Wer auf den Originaltext umschaltt, soll
   * auch dazu passende Vorschläge sehen, nicht welche für die Übersetzung.
   * Ohne Übersetzung (Text und Anzeigesprache stimmen mutmaßlich überein)
   * zählt die erkannte Ausgangssprache, sonst die eigene Übersetzungssprache
   * als letzter Rückfall — katalog.ts fällt darüber hinaus selbst auf
   * Englisch zurück, falls auch dafür kein Bestand erzeugt wurde.
   */
  const textSprache = hasTranslation && !showOriginal
    ? translation!.lang
    : (message.sourceLang ?? self?.language ?? self?.uiLanguage ?? 'en');
  const emojiKatalog = useEmojiKatalog(textSprache);

  /* Kein Netz, kein Modell, keine Kosten — reiner Abgleich auf dem Gerät.
     Trotzdem nichts in vertraulichen Kanälen: siehe VERTRAULICH_ABGESCHALTET
     ('reaktionsvorschlaege') in shared/src/vertraulich.ts für die Begründung,
     warum das auch für den rein örtlichen Weg gilt. */
  const lokaleVorschlaege = useMemo(() => {
    if (vertraulich || unlesbar || !emojiKatalog || !bodyText.trim()) return [];
    return emojiVorschlaege(bodyText, emojiKatalog, 3).map((v) => v.char);
  }, [vertraulich, unlesbar, emojiKatalog, bodyText]);

  /* Der seltene KI-Rückfall (state/emoji-vorschlaege.ts) — nur ANGEBOTEN, wenn
     das Recht 'ai.assistant' da ist und der Kanal nicht vertraulich ist.
     Angefordert wird er dadurch noch nicht: das passiert erst durch einen
     Klick in EmojiPicker.tsx, nie von hier aus automatisch. */
  const kiVorschlag = useKiVorschlag(message.id);
  const kiDarfGefragtWerden = !vertraulich && Boolean(self?.permissions['ai.assistant']);

  /* WARUM HIER UND NICHT WEITER UNTEN, NEBEN beiTipp:
     Dieser Hook stand früher NACH den drei Rückgaben unten
     (hiddenForMe/deletedAt/systemKind) — und genau das hat am 22.08.2026 die
     App zum Absturz gebracht: „Minified React error #300 — Rendered fewer
     hooks than expected". Hooks müssen bei JEDEM Durchlauf einer Instanz in
     exakt derselben Reihenfolge aufgerufen werden; React zählt sie nur durch,
     ohne ihre Namen zu kennen. Eine Rückgabe VOR einem Hook nimmt ihn für
     diesen Durchlauf aus der Zählung — reicht ein Durchlauf mehr Hooks als
     der nächste, reißt React den ganzen Baum ein. Das traf hier nicht nur
     einen Neuaufbau: MessageList.tsx:207 gibt dieselbe Nachrichten-ID über
     einen Löschvorgang hinweg an dieselbe Instanz weiter (state/store.ts,
     'message:deleted' mischt deletedAt in die BESTEHENDE Nachricht), trifft
     also eine bereits fertig gerenderte Nachricht mitten im Betrieb. Deshalb
     steht dieser Hook jetzt VOR den drei Rückgaben, ohne jede Bedingung —
     wer ihn wieder nach unten schiebt, baut denselben Absturz erneut ein. */
  /* Auf Touch gibt es kein Überfahren. iOS tut zwar so (klebriger
     :hover nach jedem Tipp) — aber genau das ließ über den Nachrichten
     lauter offene Aktionsleisten zurück, die niemand bestellt hatte.
     Deshalb: auf groben Zeigern öffnet ein Tipp auf die Nachricht die
     Leiste, ein zweiter (oder ein Tipp auf eine andere Nachricht)
     schließt sie. Maus-Geräte behalten das Überfahren. */
  const [aktionenOffen, setAktionenOffen] = useState(false);
  useEffect(() => {
    if (!aktionenOffen) return;
    const zu = (e: Event) => {
      if ((e as CustomEvent).detail !== message.id) setAktionenOffen(false);
    };
    document.addEventListener('msg-aktionen', zu);
    return () => document.removeEventListener('msg-aktionen', zu);
  }, [aktionenOffen, message.id]);

  // Für mich ausgeblendet: nur ein dezenter Hinweis, kein Inhalt.
  if (message.hiddenForMe) {
    return (
      <div className="msg msg--grouped" style={{ opacity: 0.45 }}>
        <div className="msg__gutter" />
        <div className="msg__body muted" style={{ fontStyle: 'italic', fontSize: 13 }}>
          {t('msg.hiddenForYou')}
        </div>
      </div>
    );
  }

  if (message.deletedAt) {
    return (
      <div className="msg msg--grouped">
        <div className="msg__gutter" />
        <div className="msg__body muted" style={{ fontStyle: 'italic', fontSize: 13.5 }}>
          {t('msg.deleted')}
        </div>
      </div>
    );
  }

  if (message.systemKind) {
    const eigen = systemtextVertraulich(message, author?.displayName ?? '', t);
    return (
      <div className="msg msg--grouped" style={{ opacity: 0.7 }}>
        <div className="msg__gutter" />
        <div className="msg__body muted" style={{ fontSize: 13 }}>
          {eigen && <Lock size={11} style={{ verticalAlign: -1, marginRight: 5, color: 'var(--violet-soft)' }} />}
          {eigen ?? message.text}
        </div>
      </div>
    );
  }

  const submitEdit = () => {
    const clean = draft.trim();
    if (clean && clean !== klartext) editMessage(message.id, clean);
    setEditing(false);
  };

  /* In den Entwurf gehört der lesbare Text, nicht das Chiffrat aus dem
     Zustand — sonst bearbeitete man Base64. */
  const bearbeitenStarten = () => { setDraft(klartext); setEditing(true); };

  const beiTipp = (e: React.MouseEvent) => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    /* Knöpfe, Links und Eingaben in der Nachricht behalten ihren Sinn. */
    if ((e.target as HTMLElement).closest('button, a, input, textarea, [role="menu"]')) return;
    const offen = !aktionenOffen;
    setAktionenOffen(offen);
    if (offen) document.dispatchEvent(new CustomEvent('msg-aktionen', { detail: message.id }));
  };

  return (
    <motion.div
      layout="position"
      initial={message.pending ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      data-message-id={message.id}
      className={clsx(
        'msg',
        grouped && 'msg--grouped',
        isMention && 'msg--mention',
        message.pending && 'msg--pending',
        message.failed && 'msg--failed',
        highlighted && 'msg--highlight',
        aktionenOffen && 'msg--aktionen',
      )}
      onClick={beiTipp}
    >
      <div className="msg__gutter">
        {grouped
          ? <span className="msg__time-hover">{timeOfDay(message.createdAt)}</span>
          : (
            <button
              onClick={() => setProfileUser(message.userId)}
              title={t('profile.of', { name: author?.displayName ?? '' })}
              aria-label={t('profile.of', { name: author?.displayName ?? '' })}
            >
              <Avatar user={author} size={38} showPresence />
            </button>
          )}
      </div>

      <div style={{ minWidth: 0 }}>
        {message.forwardedFrom && (
          <div className="msg__forwarded">
            <Forward size={11} />
            {t('msg.forwardedBy', { name: useStore.getState().users[message.forwardedFrom.userId]?.displayName ?? t('msg.someone') })}
          </div>
        )}

        {!grouped && (
          <div className="msg__head">
            <button className="msg__author" onClick={() => setProfileUser(message.userId)}>
              {author?.displayName ?? t('common.unknown')}
            </button>
            <span className="msg__time">{timeOfDay(message.createdAt)}</span>
            {message.editedAt && <span className="msg__tag">{t('msg.edited')}</span>}
            {message.pinned && <Pin size={12} className="muted" />}
            {message.sourceLang && (
              <span className="msg__tag" title={t('msg.writtenIn', { language: spracheName(message.sourceLang ?? '') })}>
                {languageInfo(message.sourceLang).flag} {message.sourceLang.toUpperCase()}
              </span>
            )}
          </div>
        )}

        {editing ? (
          <div className="stack gap-2" style={{ marginTop: 4 }}>
            <textarea
              className="textarea"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(); }
                if (e.key === 'Escape') { setEditing(false); setDraft(klartext); }
              }}
            />
            <div className="hstack gap-2">
              <button className="btn btn--primary" onClick={submitEdit}><Check size={15} /> {t('msg.saveButton')}</button>
              <button className="btn btn--ghost" onClick={() => { setEditing(false); setDraft(klartext); }}>{t('msg.cancel')}</button>
              <span className="muted" style={{ fontSize: 12 }}>{t('msg.enterSaves')}</span>
            </div>
          </div>
        ) : message.kind === 'voice' && message.voice ? (
          <VoiceMessage
            voice={message.voice}
            messageId={message.id}
            translatedText={hasTranslation ? translation!.text : null}
            showOriginal={showOriginal}
          />
        ) : (
          <div className="msg__body translated">
            {/* Fehlt der Schlüssel, ist das kein Fehler, sondern der normale
                Zustand auf einem neuen Gerät. Deshalb ein Hinweis in der
                Zeile und keine Fehlermeldung. */}
            {unlesbar ? (
              <div className="muted" style={{ fontStyle: 'italic', fontSize: 13.5 }}>
                <Lock size={12} style={{ verticalAlign: -2, marginRight: 5 }} />
                {t('vertraulich.nichtLesbar')}
              </div>
            ) : message.kind === 'poll' && message.poll
              ? <PollCard poll={message.poll} />
              : <Markdown text={bodyText} selfHandle={self?.handle} />}

            {translating && !hasTranslation && (
              <div className="tr-pending">
                <Sparkles size={11} className="spark" />
                <span>{t('msg.translating')}</span>
                <span className="tr-pending__bar" />
              </div>
            )}

            {unuebersetzt && (
              // Kein Knopf: es gibt nichts aufzuklappen, der Text steht schon da.
              <div className="translated__meta translated__meta--roh">
                <AlertTriangle size={11} />
                {t('msg.notTranslated', { language: spracheName(message.sourceLang ?? '') })}
              </div>
            )}

            {hasTranslation && (
              <>
                <button
                  className="translated__meta"
                  onClick={() => toggleOriginal(message.id)}
                  title={showOriginal ? t('msg.showTranslation') : t('msg.showOriginal')}
                >
                  <Languages size={11} className="spark" />
                  {showOriginal
                    ? t('msg.original')
                    : nurMasseinheiten
                      ? t('msg.unitsConverted')
                      : t('msg.translatedFrom', {
                        // Der Name der Sprache gehört in die Sprache der
                        // Oberfläche: "Translated from German", nicht "Deutsch".
                        language: spracheName(message.sourceLang ?? ''),
                      })}
                </button>

                {showOriginal && (
                  <div className="translated__original">
                    <Markdown text={translation!.text} selfHandle={self?.handle} />
                  </div>
                )}

                {/* Der Demo-Provider übersetzt gar nicht und meldet darum immer
                    niedrige Konfidenz — die Warnung wäre dort reines Rauschen. */}
                {translation!.provider !== 'demo'
                  && translation!.confidence != null
                  && translation!.confidence < 0.45 && (
                  <div className="confidence-low">
                    <AlertTriangle size={11} />
                    {t('msg.lowConfidence')}
                  </div>
                )}

                {roundTrip && (
                  <div className="translated__original" style={{ borderLeftColor: 'var(--cyan)' }}>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
                      {t('msg.backTranslation', { percent: Math.round(roundTrip.similarity * 100) })}
                      {roundTrip.similarity < 0.5 && ` — ${t('msg.meaningMayDiffer')}`}
                    </div>
                    {roundTrip.backTranslation}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {message.kind === 'voice' && hasTranslation && (
          <button className="translated__meta" onClick={() => toggleOriginal(message.id)}>
            <Languages size={11} className="spark" />
            {showOriginal
              ? t('msg.showTranslationTitle')
              : t('msg.originalIn', { language: spracheName(message.sourceLang ?? '') })}
          </button>
        )}

        {message.links.length > 0 && (
          <div className="link-cards">
            {message.links.map((preview) => <LinkPreviewCard key={preview.url} preview={preview} />)}
          </div>
        )}

        {(message.attachments.filter((a) => message.kind !== 'voice' || !a.mime.startsWith('audio/')).length > 0
          || (message.pendingAttachments?.length ?? 0) > 0) && (
          <div className="attachments">
            {message.attachments
              .filter((a) => message.kind !== 'voice' || !a.mime.startsWith('audio/'))
              .map((att) => <AnhangKachel key={att.id} anhang={att} imKanal={message.channelId} />)}
            {/* Ein Anhang, der beim Senden noch nicht fertig war (siehe
                Composer.tsx, submit()). Nichts davon steht in der Datenbank —
                verschwindet die Nachricht aus dem Verlauf, verschwindet auch
                das hier, ohne dass je eine falsche Zusage stand. */}
            {message.pendingAttachments?.map((p) => (
              <div key={p.tempId} className="att-file att-file--laeuft">
                <Loader2 size={13} className="spin" />
                <div className="stack">
                  <span className="att-file__name truncate">{p.name}</span>
                  <span className="att-file__size">{t('files.uploading')}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="reactions">
            {message.reactions.map((r) => (
              <motion.button
                key={r.emoji}
                whileTap={{ scale: 0.88 }}
                className={clsx('reaction', self && r.userIds.includes(self.id) && 'reaction--mine')}
                onClick={() => react(message.id, r.emoji)}
                title={r.userIds.map((id) => useStore.getState().users[id]?.displayName ?? '?').join(', ')}
              >
                <span>{r.emoji}</span>
                <span className="reaction__count">{r.userIds.length}</span>
              </motion.button>
            ))}
            <button
              className="reaction"
              onClick={() => setPickerOpen(true)}
              title={t('msg.pickReaction')}
              aria-label={t('msg.pickReaction')}
            >
              <Smile size={13} />
            </button>
          </div>
        )}

        {!inThread && message.replyCount > 0 && (
          <button className="thread-link" onClick={() => openThread(message.id)}>
            <span className="thread-link__faces">
              {message.threadParticipantIds.slice(0, 3).map((id) => (
                <Avatar key={id} user={useStore.getState().users[id]} size={20} />
              ))}
            </span>
            {t('msg.replyCount', { n: message.replyCount })}
          </button>
        )}

        {isMine && <Lesebestaetigung message={message} />}
      </div>

      {/* Aktionsleiste beim Überfahren — die drei Schnellreaktionen sind
          Vorschläge zu GENAU DIESER Nachricht, wenn der örtliche Abgleich
          etwas gefunden hat (siehe lokaleVorschlaege oben), sonst die feste
          Grundauswahl von früher. Kein neuer Knopf, keine neue Fläche — nur
          derselbe, seit je vorhandene Platz, jetzt mit klügerem Inhalt. */}
      <div className="msg__actions">
        {(lokaleVorschlaege.length > 0 ? lokaleVorschlaege : QUICK_EMOJI.slice(0, 3)).map((emoji) => (
          <button key={emoji} className="icon-btn icon-btn--sm" onClick={() => react(message.id, emoji)} title={t('msg.reactWith', { emoji })}>
            <span style={{ fontSize: 15 }}>{emoji}</span>
          </button>
        ))}
        <button className="icon-btn icon-btn--sm" onClick={() => setPickerOpen(true)} title={t('msg.pickReaction')} aria-label={t('msg.pickReaction')}><Smile size={15} /></button>
        {!inThread && (
          <button className="icon-btn icon-btn--sm" onClick={() => openThread(message.id)} title={t('msg.replyInThread')} aria-label={t('msg.replyInThread')}><MessageSquare size={15} /></button>
        )}
        {/* Übersetzen und Weiterleiten brauchen Klartext auf dem Server. In
            einem vertraulichen Kanal gibt es dort keinen — der Knopf könnte
            nur scheitern. */}
        {!vertraulich && (hasTranslation ? (
          <button className="icon-btn icon-btn--sm" onClick={() => requestRoundTrip(message.id)} title={t('msg.checkBackTranslation')} aria-label={t('msg.checkBackTranslation')}><RefreshCw size={15} /></button>
        ) : (
          <button className="icon-btn icon-btn--sm" onClick={() => requestTranslation(message.id)} title={t('msg.translateToMine')} aria-label={t('msg.translateToMine')}><Languages size={15} /></button>
        ))}
        <button ref={moreBtnRef} className="icon-btn icon-btn--sm" onClick={() => setMenuOpen((v) => !v)} title={t('msg.more')} aria-label={t('msg.more')}><MoreHorizontal size={15} /></button>

        {createPortal(
          <AnimatePresence>
            {menuOpen && (
              <motion.div
                ref={moreMenuRef}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                style={{
                  position: 'fixed',
                  // Bis moreOrten() gemessen hat, außerhalb des Bilds — sonst
                  // blitzte für einen Bildpunkt die Ecke oben links auf.
                  left: moreOrt?.left ?? -9999, top: moreOrt?.top ?? -9999,
                  zIndex: 80,
                  minWidth: 210, padding: 5, borderRadius: 'var(--r-md)',
                  background: 'var(--bg-elevated)', border: '1px solid var(--line)',
                  boxShadow: 'var(--shadow-md)',
                }}
                onMouseLeave={() => setMenuOpen(false)}
              >
                <MenuItem icon={<Bookmark size={14} />} label={t('msg.save')} onClick={() => { save(message.id, true); setMenuOpen(false); }} />
                <MenuItem icon={<Bell size={14} />} label={t('msg.remind')} onClick={() => { startReminder(message); setMenuOpen(false); }} />
                {!vertraulich && (
                  <MenuItem icon={<Forward size={14} />} label={t('msg.forward')} onClick={() => { startForward(message); setMenuOpen(false); }} />
                )}
                <MenuItem icon={<Pin size={14} />} label={message.pinned ? t('msg.unpin') : t('msg.pin')} onClick={() => { pin(message.id, !message.pinned); setMenuOpen(false); }} />
                <MenuItem icon={<Copy size={14} />} label={t('msg.copy')} onClick={() => { void navigator.clipboard.writeText(klartext); setMenuOpen(false); }} />
                {darfBearbeiten && (
                  <MenuItem
                    icon={<Pencil size={14} />}
                    label={`${t('msg.edit')} · ${t('msg.minutesLeft', { n: restBearbeiten })}`}
                    onClick={() => { bearbeitenStarten(); setMenuOpen(false); }}
                  />
                )}
                {isMine && !darfBearbeiten && (
                  <MenuItem icon={<Pencil size={14} />} label={t('msg.editExpired')} disabled onClick={() => {}} />
                )}
                {darfFuerAlleLoeschen && (
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label={isMine && !self?.permissions['message.delete_any']
                      ? `${t('msg.deleteForAll')} · ${t('msg.minutesLeft', { n: restLoeschen })}`
                      : t('msg.deleteForAll')}
                    danger
                    onClick={() => { deleteMessage(message.id, 'all'); setMenuOpen(false); }}
                  />
                )}
                <MenuItem
                  icon={<EyeOff size={14} />}
                  label={t('msg.deleteForMe')}
                  onClick={() => { deleteMessage(message.id, 'me'); setMenuOpen(false); }}
                />
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
      </div>

      <AnimatePresence>
        {pickerOpen && (
          <EmojiPicker
            onPick={(emoji) => { react(message.id, emoji); setPickerOpen(false); }}
            onClose={() => setPickerOpen(false)}
            vorschlaege={lokaleVorschlaege}
            kiNachfrage={kiDarfGefragtWerden ? {
              emojis: kiVorschlag.emojis,
              laeuft: kiVorschlag.laeuft,
              anfordern: () => kiVorschlaegeAnfordern(message.id),
            } : undefined}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
});

/* ── Lesebestätigung ──────────────────────────────────────────── */

/**
 * Wer eine eigene Nachricht gelesen hat, und wann.
 *
 * Nur an eigenen Nachrichten (siehe Aufrufstelle), und nur wenn schon
 * mindestens eine Person gelesen hat — für eine frische Nachricht, die noch
 * niemand gesehen hat, gäbe es nichts zu zeigen, was nicht ohnehin der
 * Normalzustand jeder eben gesendeten Nachricht wäre.
 *
 * Die Zahlen und Namen kommen aus derselben Lesemarke wie der
 * Ungelesen-Zähler in der Seitenleiste (channel_members in der Datenbank) —
 * es gibt keine zweite, konkurrierende Ablage darüber, was gelesen ist.
 * requestReadReceipts() fragt einmal an; danach hält store.ts den Stand über
 * eingehende `read`-Meldungen anderer Mitglieder von selbst frisch.
 */
function Lesebestaetigung({ message }: { message: Message }) {
  const t = useT();
  const channel = useStore((s) => s.channels[message.channelId]);
  const receipts = useStore((s) => s.readReceipts[message.id]);
  const users = useStore((s) => s.users);
  const requestReadReceipts = useStore((s) => s.requestReadReceipts);

  useEffect(() => {
    if (receipts === undefined) requestReadReceipts([message.id]);
  }, [message.id, receipts, requestReadReceipts]);

  const [offen, setOffen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [ort, setOrt] = useState<{ left: number; top: number } | null>(null);
  const schliessTimer = useRef<number | null>(null);

  const positionieren = useCallback(() => {
    const knopf = btnRef.current;
    const kasten = boxRef.current;
    if (!knopf || !kasten) return;
    const k = knopf.getBoundingClientRect();
    const rand = sichereRaender();
    const breite = kasten.offsetWidth;
    const hoehe = kasten.offsetHeight;
    const left = Math.max(
      8 + rand.links,
      Math.min(k.right - breite, window.innerWidth - breite - 8 - rand.rechts),
    );
    let top = k.bottom + 4;
    if (top + hoehe > window.innerHeight - 8 - rand.unten) top = k.top - hoehe - 4;
    setOrt({ left, top: Math.max(8 + rand.oben, top) });
  }, []);

  useLayoutEffect(() => { if (offen) positionieren(); }, [offen, positionieren]);

  // Öffnen — beim Überfahren mit der Maus wie beim Antippen. Ein bereits
  // laufendes Schließen (siehe unten) wird dabei zurückgenommen, sonst
  // schlösse ein Wechsel vom Knopf auf das Fenster kurz danach wieder zu.
  const oeffnen = () => {
    if (schliessTimer.current != null) { window.clearTimeout(schliessTimer.current); schliessTimer.current = null; }
    setOffen(true);
  };
  // Kleine Verzögerung, damit der Weg von Knopf zu Fenster nicht selbst als
  // Verlassen zählt — beide Seiten rufen dasselbe Timeout auf.
  const verzoegertSchliessen = () => {
    schliessTimer.current = window.setTimeout(() => setOffen(false), 150);
  };

  useEffect(() => {
    if (!offen) return;
    // Auf Touch gibt es kein „daneben vorbei gehovert" — ein Tipp irgendwo
    // sonst muss schließen. window.addEventListener('resize') hält die
    // Position auch bei einer Größenänderung des Fensters richtig, wie beim
    // „…"-Menü weiter oben.
    const beiAussen = (e: PointerEvent) => {
      const ziel = e.target as Node;
      if (btnRef.current?.contains(ziel) || boxRef.current?.contains(ziel)) return;
      setOffen(false);
    };
    document.addEventListener('pointerdown', beiAussen);
    window.addEventListener('resize', positionieren);
    return () => {
      document.removeEventListener('pointerdown', beiAussen);
      window.removeEventListener('resize', positionieren);
    };
  }, [offen, positionieren]);

  useEffect(() => () => {
    if (schliessTimer.current != null) window.clearTimeout(schliessTimer.current);
  }, []);

  if (!receipts?.length) return null;

  // Direktnachricht: nur eine lesende Person — die schlichte Form reicht,
  // eine Liste mit einem einzigen Namen wäre nur eine umständlichere
  // Wiederholung derselben Auskunft.
  if (channel?.kind === 'dm') {
    const [erste] = receipts;
    const leser = users[erste.userId];
    const zeit = erste.at != null
      ? zeitAusSicht(erste.at, leser?.language ?? 'en', leser?.timezone ?? '')
      : null;
    return (
      <div className="msg__read-receipt msg__read-receipt--dm muted">
        {zeit ? t('msg.readAt', { time: zeit }) : t('msg.read')}
      </div>
    );
  }

  return (
    <>
      <button
        ref={btnRef}
        className="msg__read-receipt"
        onMouseEnter={oeffnen}
        onMouseLeave={verzoegertSchliessen}
        onFocus={oeffnen}
        onClick={oeffnen}
        title={t('msg.readByCount', { n: receipts.length })}
        aria-label={t('msg.readByCount', { n: receipts.length })}
      >
        <CheckCheck size={12} />
        <span>{receipts.length}</span>
      </button>

      {createPortal(
        <AnimatePresence>
          {offen && (
            <motion.div
              ref={boxRef}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="read-receipt-popover"
              style={{ position: 'fixed', left: ort?.left ?? -9999, top: ort?.top ?? -9999 }}
              onMouseEnter={oeffnen}
              onMouseLeave={verzoegertSchliessen}
            >
              <div className="read-receipt-popover__header muted">{t('msg.readByHeader')}</div>
              {receipts.map((r) => {
                const leser = users[r.userId];
                const zeit = r.at != null
                  ? zeitAusSicht(r.at, leser?.language ?? 'en', leser?.timezone ?? '')
                  : null;
                return (
                  <div key={r.userId} className="read-receipt-popover__row">
                    <Avatar user={leser} size={18} />
                    <span className="read-receipt-popover__name">{leser?.displayName ?? t('common.unknown')}</span>
                    {zeit && <span className="read-receipt-popover__time">{zeit}</span>}
                  </div>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

function MenuItem({ icon, label, onClick, danger, disabled }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%',
        padding: '7px 10px', borderRadius: 'var(--r-xs)',
        fontSize: 13.5, textAlign: 'left',
        color: danger ? 'var(--rose)' : 'var(--tx-mid)',
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}{label}
    </button>
  );
}

/* ── Zugangsmeldungen aus vertraulichen Kanälen ───────────────── */

/**
 * Der Server schreibt seine Zugangsmeldungen als fertigen Satz in den Kanal.
 *
 * Das muss er auch: sie sollen selbst dann lesbar sein, wenn jemandem der
 * Schlüssel fehlt, und sie dürfen nicht von der App abhängen, die sie
 * ausgelöst hat — sonst könnte man sie weglassen. Für die Anzeige wird der
 * Satz hier durch den Eintrag der Oberflächensprache ersetzt.
 *
 * Der Grund einer Freigabe ist der einzige Teil, den der Server nicht kennt.
 * Er steht hinter dem Doppelpunkt am Ende; alles davor ist der feste Satz.
 */
const GRUND_IM_SYSTEMTEXT = /—[^:]*:\s*([\s\S]+)$/;

const SYSTEMTEXTE: Record<string, TranslationKey> = {
  'vertraulich.ein': 'sys.vertraulichEin',
  'vertraulich.freigabe': 'sys.vertraulichFreigabe',
  'vertraulich.eingeloest': 'sys.vertraulichEingeloest',
  'vertraulich.zurueckgenommen': 'sys.vertraulichZurueckgenommen',
};

function systemtextVertraulich(
  message: Message,
  name: string,
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string,
): string | null {
  const schluessel = SYSTEMTEXTE[message.systemKind ?? ''];
  if (!schluessel) return null;
  const grund = GRUND_IM_SYSTEMTEXT.exec(message.text)?.[1]?.trim() ?? '';
  return t(schluessel, { name, grund });
}

/* ── Anhänge ──────────────────────────────────────────────────── */

/**
 * Ein Anhang — offen oder verschlossen.
 *
 * Der offene Fall ist der von jeher: der Server liefert das Bild aus, das
 * `<img src>` zeigt es. Beim verschlossenen geht das nicht, und zwar
 * grundsätzlich nicht — beim Server liegt Chiffrat, und ein Bildbetrachter
 * bekäme Rauschen. Also holt die App die Datei, schließt sie auf und zeigt
 * sie aus dem Arbeitsspeicher. Erst dabei kommen auch Name und Typ zum
 * Vorschein; auf dem Server steht an ihrer Stelle ein Platzhalter.
 *
 * Der dritte Fall ist der wichtigste für das Vertrauen in die Sache: ein
 * offener Anhang in einem vertraulichen Kanal. Den gibt es, weil ein Kanal
 * nachträglich vertraulich gestellt werden kann — was vorher hochgeladen
 * wurde, liegt weiter offen da, und niemand kann das rückwirkend ändern.
 * Diese Anhänge werden gekennzeichnet, statt sie stillschweigend zwischen
 * den verschlossenen mitlaufen zu lassen: wer sich auf das Schloss verlässt,
 * soll sehen, wo es nicht gilt.
 */
function AnhangKachel({ anhang, imKanal }: { anhang: Attachment; imKanal: string }) {
  const t = useT();
  const kanal = useStore((s) => s.channels[imKanal]);
  const setLightbox = useStore((s) => s.setLightbox);
  const { url, name, mime, unlesbar, laeuft } = useVerschlosseneDatei(anhang);

  const verschlossen = Boolean(anhang.huelle);
  const ausOffenerZeit = !verschlossen && Boolean(kanal?.vertraulich);

  if (verschlossen && laeuft) {
    return <div className="att-file att-file--laeuft">{t('anhang.wirdGeoeffnet')}</div>;
  }
  if (verschlossen && (unlesbar || !url)) {
    return (
      <div className="att-file att-file--zu" title={t('anhang.unlesbarHinweis')}>
        <div className="stack">
          <span className="att-file__name">{t('anhang.unlesbar')}</span>
          <span className="att-file__size">{fileSize(anhang.size)}</span>
        </div>
      </div>
    );
  }

  const adresse = verschlossen ? url! : fileUrl(anhang.url);

  if (mime.startsWith('image/')) {
    /* Die Marke sitzt inline und nicht in einer eigenen Regel: das Stylesheet
       gehört gerade jemand anderem. Sie soll auffallen, ohne das Bild zu
       verdecken — deshalb unter dem Bild und nicht darauf. */
    return (
      <span className="att-bild">
        <img
          className="att-img"
          src={adresse}
          alt={name}
          loading="lazy"
          width={anhang.width ?? undefined}
          height={anhang.height ?? undefined}
          onClick={() => setLightbox(adresse)}
        />
        {ausOffenerZeit && (
          <span
            className="att-offen-marke muted"
            title={t('anhang.ausOffenerZeitHinweis')}
          >
            <Unlock size={10} /> {t('anhang.ausOffenerZeit')}
          </span>
        )}
      </span>
    );
  }

  return (
    <a
      className="att-file"
      href={adresse}
      download={verschlossen ? name : undefined}
      target={verschlossen ? undefined : '_blank'}
      rel="noreferrer"
    >
      <div className="stack">
        <span className="att-file__name">{name}</span>
        <span className="att-file__size">
          {fileSize(anhang.size)}
          {ausOffenerZeit && ` · ${t('anhang.ausOffenerZeit')}`}
        </span>
      </div>
    </a>
  );
}
