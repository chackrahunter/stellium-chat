/** WebSocket-Protokoll zwischen Desktop-Client und Server. */

import type {
  Freigabe, FreigabeSchluessel, KontoPaket, OeffentlicherSchluessel, SchluesselPaket,
} from './vertraulich.js';
import type {
  AiSummary, CalendarEvent, Channel, ChannelState, Draft, LinkPreview, Message,
  Idea, IdeaComment, IdeaStatus, MeetingProtocol, Notiz, Poll, Projekt, PushSubscriptionJSON, ReadReceipt, Reaction, ReleaseInfo, Reminder, ScheduledMessage, SelfUser, SmartReply, StoredFile, StorageUsage,
  Task, TaskEvent, TaskPriority, TaskStatus, TranslationView, User,
  UserStatus, VoiceNote,
  Vorschlag, VorschlagAenderung,
} from './types.js';

export const WS_PROTOCOL_VERSION = 1;

/* ── Client -> Server ─────────────────────────────────────────── */

export type ClientEvent =
  /**
   * `appVersion`/`platform` sind optional und neu: sie sagen der Verwaltung,
   * welche Fassung dieses Gerät gerade fährt (siehe ws/gateway.ts,
   * authenticate(), und ManagedUser in types.ts). Ein alter Client kennt die
   * Felder noch nicht und lässt sie einfach weg — ein neuer Server muss das
   * aushalten (tut er: fehlt appVersion, bleibt der zuletzt bekannte Stand
   * unangetastet). Umgekehrt ignoriert ein alter Server unbekannte Felder
   * ohnehin. Kein Grund, WS_PROTOCOL_VERSION hochzuzählen — das Protokoll
   * selbst ändert sich nicht, es kommt nur eine zusätzliche, verzichtbare
   * Auskunft mit.
   */
  | { t: 'auth'; token: string; protocol: number; appVersion?: string; platform?: string }
  | { t: 'ping'; ts: number }
  | { t: 'channel:open'; channelId: string; before?: string; limit?: number }
  | { t: 'channel:create'; kind: 'public' | 'private'; name: string; topic?: string; memberIds?: string[]; primaryLanguage?: string | null }
  | { t: 'channel:join'; channelId: string }
  | { t: 'channel:leave'; channelId: string }
  | { t: 'channel:update'; channelId: string; name?: string; topic?: string; purpose?: string; primaryLanguage?: string | null; archived?: boolean; readOnly?: boolean }
  | { t: 'channel:delete'; channelId: string }
  | { t: 'channel:hide'; channelId: string }
  | { t: 'channel:members'; channelId: string; add?: string[]; remove?: string[] }
  | { t: 'channel:mute'; channelId: string; muted: boolean }
  | { t: 'channel:star'; channelId: string; starred: boolean }
  | { t: 'dm:open'; userId: string }
  | { t: 'message:send'; clientId: string; channelId: string; text: string; parentId?: string | null; attachmentIds?: string[]; sourceLang?: string | null;
      /** Anhänge, die beim Senden noch hochladen — siehe Message.pendingAttachments. */
      pendingAttachments?: { tempId: string; name: string; mime: string }[] }
  /**
   * Ein Anhang, der erst nach der Nachricht fertig geworden ist, wird ihr
   * nachträglich angehängt. Nur die sendende Person darf das für ihre eigene,
   * noch nicht gelöschte Nachricht — siehe messages.attachUpload().
   */
  | { t: 'message:attach'; messageId: string; tempId: string; attachmentId: string }
  /**
   * Der Upload ist gescheitert, nachdem die Nachricht schon stand. Räumt nur
   * den Platzhalter weg (siehe Message.pendingAttachments) — die Datei selbst
   * gibt es in diesem Fall gar nicht erst, denn `message:attach` ist der
   * einzige Weg, wie eine fertige Datei je bei ihrer Nachricht ankommt.
   */
  | { t: 'message:attachGiveUp'; messageId: string; tempId: string }
  | { t: 'message:edit'; messageId: string; text: string }
  | { t: 'message:delete'; messageId: string; scope?: 'all' | 'me' }
  | { t: 'message:react'; messageId: string; emoji: string }
  | { t: 'message:pin'; messageId: string; pinned: boolean }
  | { t: 'message:save'; messageId: string; saved: boolean }
  | { t: 'message:schedule'; channelId: string; text: string; sendAt: number; parentId?: string | null }
  | { t: 'message:unschedule'; scheduledId: string }
  | { t: 'thread:open'; messageId: string }
  | { t: 'typing'; channelId: string; parentId?: string | null }
  | { t: 'read'; channelId: string; lastMessageId: string }
  /**
   * Wer eigene Nachrichten gelesen hat, und wann — für mehrere auf einmal.
   *
   * Gebündelt, nicht pro Nachricht: ein offener Kanal mit vielen eigenen
   * Beiträgen soll eine Anfrage auslösen, nicht ein Dutzend. Der Server
   * antwortet nur für Nachrichten, die die anfragende Person selbst sehen
   * darf — für den Rest kommt stillschweigend nichts zurück.
   */
  | { t: 'message:read-receipts'; messageIds: string[] }
  | { t: 'presence:set'; status: UserStatus; statusEmoji?: string | null; statusText?: string | null; statusExpiresAt?: number | null }
  | { t: 'prefs:update'; patch: Partial<Pick<SelfUser,
      'language' | 'autoTranslate' | 'notifyOn' | 'theme' | 'density' |
      'composeTargetPreview' | 'quietHoursStart' | 'quietHoursEnd' |
      'displayName' | 'title' | 'timezone' | 'notificationSound' | 'translationSpeed'
      | 'uiLanguage' | 'lesebestaetigungAus'>> }
  | { t: 'translate:request'; messageId: string; targetLang: string; force?: boolean }
  | { t: 'translate:roundtrip'; messageId: string; targetLang: string }
  | { t: 'compose:preview'; requestId: string; text: string; targetLang: string; channelId: string }
  | { t: 'ai:catchup'; requestId: string; channelId: string; sinceMessageId?: string | null }
  | { t: 'ai:thread-summary'; requestId: string; messageId: string }
  | { t: 'ai:smart-replies'; requestId: string; channelId: string; parentId?: string | null }
  /**
   * Emoji-Reaktionen für eine einzelne Nachricht vorschlagen — der seltene
   * Rückfall, wenn der örtliche Abgleich (packages/desktop/src/emoji/
   * katalog.ts) nichts Brauchbares findet. Kein channelId nötig: der Server
   * schlägt die Nachricht selbst nach und prüft daran, ob ihr Kanal
   * vertraulich ist (siehe klartextNoetigFuerNachricht in ws/gateway.ts). */
  | { t: 'ai:reaction-suggest'; requestId: string; messageId: string }
  /* channelId ist kein Beiwerk: ohne sie kann der Server nicht erkennen, ob
     der Entwurf aus einem vertraulichen Kanal stammt — und schickte ihn dann
     ahnungslos an die KI. Die Oberfläche blendet den Knopf dort zwar aus,
     aber eine Zusage, die nur die eigene App einhält, ist keine Zusage. */
  | { t: 'ai:rewrite'; requestId: string; text: string; tone: RewriteTone; targetLang?: string | null;
      channelId?: string | null }
  | { t: 'ai:ask'; requestId: string; channelId: string; question: string }

  /* Umfragen */
  | { t: 'poll:create'; clientId: string; channelId: string; question: string; options: string[]; multiple: boolean; anonymous: boolean; closesAt?: number | null; parentId?: string | null }
  | { t: 'poll:vote'; pollId: string; optionIds: string[] }
  | { t: 'poll:close'; pollId: string }

  /* Weiterleiten */
  | { t: 'message:forward'; clientId: string; messageId: string; toChannelId: string; comment?: string }

  /* Erinnerungen */
  | { t: 'reminder:create'; messageId?: string | null; channelId: string; note?: string | null; remindAt: number }
  | { t: 'reminder:cancel'; reminderId: string }
  | { t: 'reminder:done'; reminderId: string }

  /* Entwürfe */
  | { t: 'draft:save'; channelId: string; parentId?: string | null; text: string }

  /* Sprachnachrichten */
  | { t: 'voice:send'; clientId: string; channelId: string; attachmentId: string; durationMs: number; parentId?: string | null }
  | { t: 'voice:retranscribe'; messageId: string }

  /* KI-Assistent als Gesprächspartner */
  | { t: 'ai:open-chat' }
  | { t: 'ai:open-team-channel' }
  | { t: 'ai:set-mode'; channelId: string; mode: 'off' | 'mention' | 'always' }

  /* Aufgaben */
  | { t: 'task:list'; channelId?: string | null; assigneeId?: string | null }
  | { t: 'task:create'; title: string; description?: string | null; assigneeId?: string | null; channelId?: string | null; messageId?: string | null; dueAt?: number | null; priority?: TaskPriority; status?: TaskStatus; projektId?: string | null }
  | { t: 'task:update'; taskId: string; patch: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigneeId?: string | null; dueAt?: number | null; projektId?: string | null } }
  | { t: 'task:move'; taskId: string; status: TaskStatus; afterId?: string | null }
  | { t: 'task:comment'; taskId: string; text: string }
  | { t: 'task:watch'; taskId: string; watching: boolean }
  | { t: 'task:delete'; taskId: string }
  | { t: 'task:history'; taskId: string }
  /** „Passt" — die von der KI angelegte Aufgabe ist angesehen. */
  | { t: 'task:geprueft'; taskId: string }

  /* Projekte — Schubladen für Aufgaben */
  | { t: 'projekt:list' }
  | { t: 'projekt:create'; name: string; beschreibung?: string | null; farbe?: string }
  | { t: 'projekt:update'; projektId: string; patch: { name?: string; beschreibung?: string | null; farbe?: string; archiviert?: boolean } }
  | { t: 'projekt:delete'; projektId: string }
  | { t: 'ai:extract-tasks'; requestId: string; channelId: string }
  | { t: 'ai:protocol'; channelId: string; sinceMessageId?: string | null }

  /* Ideenboard */
  | { t: 'idea:list' }
  | { t: 'idea:create'; title: string; body?: string | null; tag?: string; channelId?: string | null }
  | { t: 'idea:update'; ideaId: string; patch: { title?: string; body?: string | null; tag?: string; channelId?: string | null } }
  | { t: 'idea:status'; ideaId: string; status: IdeaStatus; decision?: string | null }
  | { t: 'idea:vote'; ideaId: string; wert: 1 | -1 }
  | { t: 'idea:comments'; ideaId: string }
  | { t: 'idea:comment'; ideaId: string; text: string }
  | { t: 'idea:comment-delete'; commentId: string; ideaId: string }
  | { t: 'idea:delete'; ideaId: string }
  /** „Passt" — die von der KI eingebrachte Idee ist angesehen. */
  | { t: 'idea:geprueft'; ideaId: string }

  /* Vorschlagseingang */
  | { t: 'vorschlag:list' }
  /**
   * Annehmen — mit den Änderungen, die auf der Karte gemacht wurden.
   *
   * Titel, Art, Zuständige:r und Frist reisen mit, statt vorher einzeln
   * gespeichert zu werden: ein Vorschlag, den man halb geändert liegen lässt,
   * soll unverändert bleiben.
   */
  | { t: 'vorschlag:accept'; requestId: string; vorschlagId: string; aenderung?: VorschlagAenderung }
  | { t: 'vorschlag:reject'; requestId: string; vorschlagId: string }
  /** Die letzte Annahme zurücknehmen — nimmt das Entstandene wieder weg. */
  | { t: 'vorschlag:undo'; requestId: string; vorschlagId: string }

  /* Kalender */
  | { t: 'event:list'; from: number; to: number }
  | { t: 'event:create'; title: string; description?: string | null; kind?: string; startsAt: number; endsAt: number; allDay?: boolean; location?: string | null; channelId?: string | null; attendeeIds?: string[] }
  | { t: 'event:update'; eventId: string; patch: { title?: string; description?: string | null; startsAt?: number; endsAt?: number; allDay?: boolean; location?: string | null; kind?: string } }
  | { t: 'event:respond'; eventId: string; response: 'yes' | 'no' | 'maybe' }
  | { t: 'event:attendees'; eventId: string; add?: string[]; remove?: string[] }
  | { t: 'event:delete'; eventId: string }
  /** „Passt" — der von der KI eingetragene Termin ist angesehen. */
  | { t: 'event:geprueft'; eventId: string }
  /** Trägt die KI selbst ein, statt nur vorzuschlagen? Nur mit Verwaltungsrecht. */
  | { t: 'ki:selbst-eintragen'; an: boolean }

  /* Dateiablage */
  | { t: 'file:list'; channelId?: string | null; folder?: string }
  | { t: 'file:update'; fileId: string; name?: string; description?: string | null; folder?: string }
  | { t: 'file:delete'; fileId: string }

  /* ── Vertrauliche Kanäle ──────────────────────────────────
     Alles, was hier hin- und hergeht, ist entweder öffentlich (Schlüsselteile,
     die öffentlich sein sollen) oder bereits verschlossen. Der Server ist
     Briefkasten, nicht Empfänger. */

  /** Öffentlichen Teil hinterlegen — und wahlweise die verschlossene Sicherung. */
  | { t: 'vertraulich:schluessel-melden'; jwk: string; abdruck: string; sicherung?: string | null }
  /** Öffentliche Teile anderer Konten holen, um für sie verpacken zu können. */
  | { t: 'vertraulich:schluessel-holen'; userIds?: string[] }
  /** Die eigene verschlossene Sicherung anfordern — für ein neues Gerät. */
  | { t: 'vertraulich:sicherung-holen' }
  /** Kanal auf vertraulich stellen und gleich für alle Mitglieder verpacken. */
  | { t: 'vertraulich:einschalten'; channelId: string; pakete: { userId: string; paket: SchluesselPaket }[] }
  /** Fehlende Pakete nachreichen — nach Aufnahme oder nach einem Wechsel. */
  | { t: 'vertraulich:pakete'; channelId: string; fassung: number; pakete: { userId: string; paket: SchluesselPaket }[] }
  /** Den Kanalschlüssel wechseln, weil jemand gegangen ist. */
  | { t: 'vertraulich:wechseln'; channelId: string; pakete: { userId: string; paket: SchluesselPaket }[] }
  /** Die eigenen Pakete eines Kanals holen (alle Fassungen). */
  | { t: 'vertraulich:paket-holen'; channelId: string }
  /** Vorfall melden: Kanalschlüssel für die Verwaltung freigeben. */
  | { t: 'vertraulich:vorfall-melden'; channelId: string; grund: string;
      codeAbdruck: string; tage?: number;
      pakete: { userId: string; paket: SchluesselPaket }[] }
  /** Freigaben eines Kanals auflisten. */
  | { t: 'vertraulich:freigaben'; channelId?: string | null }
  /** Mit dem Code an den freigegebenen Schlüssel kommen. */
  | { t: 'vertraulich:freigabe-oeffnen'; freigabeId: string; codeAbdruck: string }
  /** Eine Freigabe vorzeitig beenden. */
  | { t: 'vertraulich:freigabe-zuruecknehmen'; freigabeId: string }

  /* ── Notizen ──────────────────────────────────────────────
     Dieselbe Bauart wie bei vertraulichen Kanälen: was hier hin- und
     hergeht, ist entweder öffentlich oder schon verschlossen. Anders als
     dort gibt es keinen Nachrichtenstrom, sondern genau ein Schriftstück je
     Notiz — deshalb `version` in notiz:speichern statt einer Fassung je
     Nachricht. */

  /** Die eigenen Notizen — eigene und die, zu denen man hinzugefügt wurde. */
  | { t: 'notiz:list' }
  /**
   * Neu anlegen. `requestId`, weil die Oberfläche gleich danach hineinspringt.
   * Die Kennung kommt ausnahmsweise von der App, nicht vom Server: der
   * Notizschlüssel wird für die eigene Person selbst verpackt (siehe
   * lib/notizen.ts), und die Verpackung braucht die Kennung schon in der
   * Ableitung, bevor der Server je eine vergeben könnte. Kollisionsfrei genug
   * (128 Bit Zufall) — und selbst eine Kollision schlüge nur als gewöhnlicher
   * INSERT-Fehler fehl, nie als stille Überschreibung einer fremden Notiz.
   */
  | { t: 'notiz:anlegen'; requestId: string; id: string; chiffrat: string; paket: SchluesselPaket;
      /**
       * Dasselbe, ein zweites Mal — verpackt mit dem Kontoschlüssel statt mit
       * dem ECDH-Teil DIESES Geräts. Wahlfrei, weil ein Gerät, das seit
       * dieser Fassung nie eine Anmeldung gesehen hat, keinen Kontoschlüssel
       * haben kann (er entsteht nur, wo das Passwort im Klartext vorliegt).
       * Fehlt es hier, holt es der Kontoweg später nach — siehe
       * notiz:konto-fehlt.
       */
      kontoPaket?: KontoPaket }
  /**
   * Speichern — mit dem Stand, von dem aus die App losgeschrieben hat.
   * Weicht er vom aktuellen ab, lehnt der Server ab (notiz:konflikt) statt
   * stillschweigend zu überschreiben. `force` überschreibt trotzdem —
   * bewusste Entscheidung einer Person, keine Voreinstellung. `requestId`
   * verbindet die Antwort (notiz:upsert oder notiz:konflikt) mit genau
   * diesem Versuch — dieselbe Machart wie bei vorschlag:accept.
   */
  | { t: 'notiz:speichern'; requestId: string; notizId: string; chiffrat: string; version: number; force?: boolean }
  | { t: 'notiz:loeschen'; notizId: string }
  /** Für ein Konto verpacken, das schon einen Schlüssel hinterlegt hat. */
  | { t: 'notiz:mitglied-hinzufuegen'; notizId: string; userId: string; paket: SchluesselPaket }
  /**
   * Entfernen UND den Notizschlüssel wechseln — in einem Schritt, weil nur
   * die besitzende Person das darf und sie den Schlüssel deshalb immer
   * schon in der Hand hat (siehe services/notizen.ts, mitgliedEntfernen).
   * `requestId`, weil die App bei einem Wettlauf (siehe dort) automatisch
   * und ohne Rückfrage neu versucht — dafür muss sie wissen, ob genau dieser
   * Versuch geklappt hat.
   */
  | { t: 'notiz:mitglied-entfernen'; requestId: string; notizId: string; userId: string;
      neueFassung: number; chiffrat: string; version: number;
      pakete: { userId: string; paket: SchluesselPaket }[] }
  /** Antwort auf notiz:pakete-fehlen: der Schlüssel ist jetzt für diese Person verpackt. */
  | { t: 'notiz:pakete-nachreichen'; notizId: string; userId: string; paket: SchluesselPaket }
  /**
   * Ein Notizschlüssel, mit dem eigenen Kontoschlüssel verpackt.
   *
   * Immer nur für sich selbst — es gibt kein Ereignis, das ein Kontopaket für
   * eine andere Person schriebe, und der Server nimmt auch keines an: den
   * Kontoschlüssel einer anderen Person hat niemand.
   *
   * Wird ausschließlich geschickt, NACHDEM das Gerät den Notizschlüssel am
   * Chiffrat der Notiz selbst erprobt hat (siehe lib/notizen.ts). Ohne diese
   * Regel könnte hier ein Paket ankommen, das in der Datenbank richtig
   * aussieht und sich nie öffnen lässt.
   */
  | { t: 'notiz:konto-paket-setzen'; notizId: string; fassung: number; paket: KontoPaket }

  /* ── Web Push ─────────────────────────────────────────────── */

  /**
   * Dieses Gerät möchte auch dann benachrichtigt werden, wenn die App nicht
   * offen ist. Geht auch dann noch einmal hinaus, wenn der Browser das
   * Abonnement von sich aus erneuert (`pushsubscriptionchange`) — der Server
   * kennt kein Update, nur ein Ersetzen über denselben `endpoint`.
   */
  | { t: 'push:subscribe'; subscription: PushSubscriptionJSON }
  /** Dieses eine Gerät wieder abmelden — beim Abschalten in den Einstellungen. */
  | { t: 'push:unsubscribe'; endpoint: string };

export type RewriteTone =
  | 'polish' | 'formal' | 'friendly' | 'concise' | 'expand' | 'bullets' | 'apologize';

/* ── Server -> Client ─────────────────────────────────────────── */

export type ServerEvent =
  | { t: 'ready'; self: SelfUser; users: User[]; channels: Channel[]; states: ChannelState[]; scheduled: ScheduledMessage[]; reminders: Reminder[]; drafts: Draft[]; serverTime: number; /** Stand, der auf dem Server läuft. */ serverVersion: string;
      /** Fassung, die für den Server bereitliegt und noch nicht eingespielt ist. */
      serverUpdate: string | null; ai: AiCapabilities;
      /**
       * Der öffentliche VAPID-Schlüssel, mit dem der Client sich fürs
       * Web-Push-Abonnement anmeldet. `null` heißt: dem Server fehlt der
       * private Gegenpart (siehe Server-Log) — dann bleibt es beim alten Weg,
       * der nur läuft, während die App offen ist.
       */
      vapidPublicKey: string | null }
  | { t: 'pong'; ts: number }
  /**
   * Eine Meldung an den Client. `code` ist eine Kennung aus dem Wörterbuch
   * der Oberfläche, `werte` füllt ihre Platzhalter. `message` ist derselbe
   * Satz auf Deutsch — der Rückfall für Clients, die die Kennung noch nicht
   * kennen. So muss der Server nicht wissen, welche Sprache am anderen Ende
   * läuft.
   */
  /**
   * `clientId` ist optional und neu: sie sagt, welche gerade geschickte
   * `message:send` diesen Fehler ausgelöst hat — der Server kennt sie längst
   * (`message:send` trägt sie schon lange hin), er hat sie beim Abweisen nur
   * nie zurückgegeben. Ohne sie ließ sich ein kennungsloser Fehler nur raten
   * (welche Nachricht war's?), mit ihr ist die Zuordnung exakt.
   *
   * Ein alter Server kennt das Feld nicht und lässt es einfach weg — ein
   * neuer Client muss das aushalten und degradiert dann auf den alten Weg
   * (Protokoll abbrechen, falls eins wartet), nicht auf einen Absturz. Ein
   * alter Client wiederum ignoriert ein unbekanntes Feld ohnehin. `requestId`
   * bleibt daneben bestehen — sie deckt die Anfragen ab, die eine haben
   * (KI-Hilfen, Notizen, …), `clientId` die eine, die nie eine `requestId`
   * bekommen hat: `message:send`.
   */
  | { t: 'error'; code?: string; message: string; werte?: Record<string, string>; requestId?: string; clientId?: string }
  | { t: 'channel:history'; channelId: string; messages: Message[]; hasMore: boolean }
  | { t: 'channel:upsert'; channel: Channel }
  | { t: 'channel:removed'; channelId: string }
  | { t: 'channel:state'; state: ChannelState }
  | { t: 'message:new'; message: Message; clientId?: string }
  | { t: 'message:updated'; message: Message }
  | { t: 'message:deleted'; messageId: string; channelId: string }
  | { t: 'reaction:updated'; messageId: string; channelId: string; reactions: Reaction[] }
  | { t: 'thread:history'; parentId: string; channelId: string; messages: Message[] }
  | { t: 'typing'; channelId: string; userId: string; parentId: string | null }
  | { t: 'presence'; userId: string; status: UserStatus; statusEmoji: string | null; statusText: string | null; statusExpiresAt: number | null; lastSeenAt: number | null }
  /**
   * Die Lesemarke eines anderen Mitglieds ist vorgerückt.
   *
   * `at` ist der Zeitpunkt dieses Sprungs — derselbe für jede Nachricht
   * zwischen der alten und der neuen Marke, siehe messages.markRead(). `null`
   * heißt: die Marke rückte in Wahrheit gar nicht vor (z.B. eine doppelte oder
   * veraltete Meldung) — dann bleibt eine schon bekannte Lesebestätigung
   * unverändert.
   */
  | { t: 'read'; channelId: string; userId: string; lastMessageId: string; at: number | null }
  /** Antwort auf message:read-receipts — nur für Nachrichten, die die Person sehen darf. */
  | { t: 'message:read-receipts'; receipts: Record<string, ReadReceipt[]> }
  | { t: 'user:upsert'; user: User }
  | { t: 'self:updated'; self: SelfUser }
  | { t: 'translation'; messageId: string; translation: TranslationView }
  | { t: 'roundtrip'; messageId: string; targetLang: string; backTranslation: string; similarity: number }
  | { t: 'compose:preview'; requestId: string; text: string; targetLang: string; sourceLang: string }
  | { t: 'scheduled:upsert'; item: ScheduledMessage }
  | { t: 'scheduled:removed'; scheduledId: string }
  | { t: 'ai:catchup'; requestId: string; summary: AiSummary }
  | { t: 'ai:thread-summary'; requestId: string; messageId: string; summary: AiSummary }
  | { t: 'ai:smart-replies'; requestId: string; replies: SmartReply[] }
  /** Antwort auf ai:reaction-suggest — messageId mit, weil requestId in der
   *  Oberfläche pro Nachricht verwaltet wird (siehe state/emoji-vorschlaege.ts),
   *  nicht global wie bei den übrigen KI-Aufträgen. Leeres Array ist eine
   *  gültige, gemerkte Antwort: "die KI hat auch nichts Passendes gefunden". */
  | { t: 'ai:reaction-suggest'; requestId: string; messageId: string; emojis: string[] }
  | { t: 'ai:rewrite'; requestId: string; text: string }
  | { t: 'ai:ask'; requestId: string; answer: string; citedMessageIds: string[] }

  | { t: 'poll:updated'; poll: Poll; channelId: string }
  | { t: 'reminder:upsert'; reminder: Reminder }
  | { t: 'reminder:removed'; reminderId: string }
  | { t: 'reminder:fire'; reminder: Reminder; message: Message | null }
  | { t: 'drafts'; drafts: Draft[] }
  | { t: 'voice:transcript'; messageId: string; voice: VoiceNote }
  | { t: 'links'; messageId: string; links: LinkPreview[] }
  | { t: 'ai:model-changed'; ai: AiCapabilities }
  /** Der Assistent formuliert gerade eine Antwort. */
  | { t: 'ai:thinking'; channelId: string; active: boolean }

  | { t: 'task:list'; tasks: Task[] }
  | { t: 'projekt:list'; projekte: Projekt[] }
  | { t: 'projekt:upsert'; projekt: Projekt }
  | { t: 'projekt:deleted'; projektId: string }
  /** Die Einstellung „KI trägt selbst ein" wurde umgelegt. */
  | { t: 'ai:einstellung'; selbstEintragen: boolean }
  /**
   * Was die letzte Antwort gekostet hat — Marken hinein, Marken heraus.
   *
   * Geht an denselben Kreis wie „denkt nach": wer der KI zusieht, soll auch
   * sehen, woran sie kaut. Bei einem Modell auf eigener Maschine ist das die
   * einzige Auskunft darüber, warum es dauert.
   */
  | { t: 'ai:verbrauch'; channelId: string; eingabe: number; ausgabe: number; modell: string | null }
  | { t: 'task:upsert'; task: Task }
  | { t: 'task:removed'; taskId: string }
  | { t: 'task:history'; taskId: string; events: TaskEvent[] }
  | {
      t: 'ai:extract-tasks'; requestId: string;
      tasks: { title: string; assigneeId: string | null; dueAt: number | null }[];
      /**
       * Wie viele davon als Vorschlag im Eingang liegen.
       *
       * Die Erkennung legt seit dem Vorschlagseingang nichts mehr direkt an.
       * Zwei Wege, die dasselbe tun, führen getrennte Lesemarken und
       * entscheiden eines Tages verschieden — es gibt jetzt einen.
       */
      vorgeschlagen: number;
      /** Wie viele es schon gab und darum nicht doppelt entstanden sind. */
      uebersprungen: number;
    }
  | { t: 'ai:protocol'; protocol: MeetingProtocol }
  | { t: 'idea:list'; ideas: Idea[] }
  | { t: 'idea:upsert'; idea: Idea }
  | { t: 'idea:removed'; ideaId: string }
  | { t: 'idea:comments'; ideaId: string; comments: IdeaComment[] }
  | { t: 'vorschlag:list'; vorschlaege: Vorschlag[] }
  /**
   * Ein Vorschlag hat sich geändert.
   *
   * `requestId` trägt die Kennung der Anfrage zurück, die ihn geändert hat.
   * Ohne dieses Feld wartet der Knopf, der die Anfrage geschickt hat, auf
   * eine Antwort, die er nicht zuordnen kann — genau die Bauart, aus der
   * der ewige Kreisel bei `ai:protocol` entstanden ist. Fehlt es, kam die
   * Änderung von woanders und niemand wartet darauf.
   */
  | { t: 'vorschlag:upsert'; requestId?: string; vorschlag: Vorschlag }
  /**
   * Frisch entstanden, ungefragt zugestellt.
   *
   * Getrennt von `upsert`, weil nur das hier die Zahl am Eingang hochzählen
   * und läuten darf — ein `upsert` ist die Folge einer eigenen Handlung und
   * soll niemanden anstupsen.
   */
  | { t: 'vorschlag:neu'; vorschlag: Vorschlag }
  | { t: 'vorschlag:removed'; vorschlagId: string }
  | { t: 'release:available'; release: ReleaseInfo }
  /** Bitte diesen Kanal anzeigen — etwa, wenn er gerade erst entstanden ist. */
  | { t: 'channel:focus'; channelId: string }
  /**
   * Der Server aktualisiert sich gleich selbst und ist dabei kurz weg.
   * Alle Angaben in Millisekunden seit der Epoche, damit alle Uhren
   * dieselbe Zeit anzeigen — eine mitgeschickte Restdauer liefe auf jedem
   * Gerät anders, je nachdem wann die Meldung ankam.
   */
  | { t: 'server:update'; version: string; notes: string | null; startetUm: number; dauertEtwa: number; serverZeit: number }
  | { t: 'server:update-abgesagt' }

  | { t: 'event:list'; events: CalendarEvent[] }
  | { t: 'event:upsert'; event: CalendarEvent }
  | { t: 'event:removed'; eventId: string }

  | { t: 'file:list'; files: StoredFile[]; usage: { used: number; quota: number; fileCount: number } }
  | { t: 'file:upsert'; file: StoredFile; usage?: StorageUsage }
  | { t: 'file:removed'; fileId: string }

  /* ── Vertrauliche Kanäle ────────────────────────────────── */

  | { t: 'vertraulich:schluessel'; schluessel: OeffentlicherSchluessel[] }
  /** Die eigene verschlossene Sicherung. Ohne Wiederherstellungscode wertlos. */
  | { t: 'vertraulich:sicherung'; paket: string | null }
  /** Die eigenen Schlüsselpakete eines Kanals, nach Fassung. */
  | { t: 'vertraulich:paket'; channelId: string; fassung: number;
      pakete: { fassung: number; paket: SchluesselPaket }[] }
  /**
   * Für diese Konten fehlt im Kanal noch ein Paket.
   *
   * Geht an alle, die den Schlüssel schon haben. Wer zuerst antwortet, hat
   * ihn verpackt — die anderen Antworten laufen ins Leere, und das ist
   * billiger als eine Absprache darüber, wer zuständig ist.
   */
  | { t: 'vertraulich:pakete-fehlen'; channelId: string; fassung: number; userIds: string[] }
  /** Bitte den Kanalschlüssel wechseln — jemand hat den Kanal verlassen. */
  | { t: 'vertraulich:wechsel-noetig'; channelId: string; grund: string }
  | { t: 'vertraulich:freigaben'; channelId: string | null; freigaben: Freigabe[] }
  | { t: 'vertraulich:freigabe'; freigabe: Freigabe }
  | { t: 'vertraulich:freigabe-schluessel'; schluessel: FreigabeSchluessel }

  /* ── Notizen ────────────────────────────────────────────── */

  | { t: 'notiz:list'; notizen: Notiz[] }
  /** Antwort auf notiz:anlegen — trägt die requestId zur Zuordnung. */
  | { t: 'notiz:erstellt'; requestId: string; notiz: Notiz }
  /**
   * Geht an jedes Mitglied inklusive der besitzenden Person. `requestId` ist
   * nur gesetzt, wenn dies die Antwort auf einen eigenen notiz:speichern-Ruf
   * ist — für alle anderen Empfänger bleibt sie leer, dieselbe Machart wie
   * bei vorschlag:upsert.
   */
  | { t: 'notiz:upsert'; requestId?: string; notiz: Notiz }
  /** Gelöscht, oder der eigene Zugriff ist weg (entfernt worden). */
  | { t: 'notiz:entfernt'; notizId: string }
  /** Das eigene Schlüsselpaket dieser Notiz — nach Aufnahme oder Wechsel. */
  | { t: 'notiz:schluessel'; notizId: string; fassung: number; paket: SchluesselPaket }
  /** Dasselbe über den Kontoweg — jedes Gerät desselben Kontos kann es öffnen. */
  | { t: 'notiz:konto-paket'; notizId: string; fassung: number; paket: KontoPaket }
  /**
   * Notizen, für die diese Person zwar ein Gerätepaket hat, aber (noch) kein
   * gültiges Kontopaket — die Liste, mit der der Altbestand nachwächst.
   *
   * Vom Server errechnet und nicht vom Client geraten: nur der Server weiß,
   * welche Zeilen wirklich dastehen und ob ihre `konto_fassung` noch die
   * aktuelle ist.
   */
  | { t: 'notiz:konto-fehlt'; notizIds: string[] }
  /**
   * Speichern abgelehnt: der mitgeschickte Stand ist nicht mehr aktuell.
   * `aktuell` trägt die Notiz, wie sie gerade auf dem Server steht — die App
   * entscheidet daran, ob sie verwirft oder ausdrücklich überschreibt
   * (notiz:speichern mit force).
   */
  | { t: 'notiz:konflikt'; requestId: string; notizId: string; aktuell: Notiz }
  /** Für dieses Konto fehlt noch ein Paket — es hat gerade erst einen Schlüssel hinterlegt. */
  | { t: 'notiz:pakete-fehlen'; notizId: string; userId: string };

export interface AiCapabilities {
  provider: string;
  /** Kann der Anbieter Sprachnachrichten transkribieren? */
  transcription: boolean;
  transcriptionModel: string | null;
  /** Modell für Übersetzung und Zusammenfassungen. */
  model: string | null;
  /** Kleineres Modell für Antwortvorschläge und kurze Aufgaben. */
  fastModel: string | null;
  /** Wie das Modell zustande kam. */
  modelSource: 'auto' | 'pinned' | 'manual' | 'fallback' | null;
  /** Wie viele brauchbare Modelle der Anbieter gerade anbietet. */
  modelsAvailable: number | null;
  translation: boolean;
  assistant: boolean;
  /**
   * Trägt die KI selbst ein, statt nur vorzuschlagen?
   *
   * An heißt: gefundene Aufgaben, Ideen und Termine stehen sofort auf den
   * Brettern — gekennzeichnet als ungeprüft und gesammelt im Reiter „Prüfen".
   */
  selbstEintragen: boolean;
  /**
   * Name des Dienstes, der gerade einspringt — sonst null.
   *
   * Steht hier etwas, antwortet nicht das eingestellte Modell, sondern eine
   * Vertretung: das eigene läuft nicht. Die Einstellung bleibt unverändert,
   * die Vertretung tritt von selbst ab, sobald das eigene wieder da ist.
   */
  vertretung: string | null;
  /** Läuft das Modell im eigenen Netz (Ollama, llama.cpp)? */
  lokal: boolean;
  /** Adresse des lokalen Dienstes — nur zur Anzeige. */
  lokaleAdresse: string | null;
  /**
   * Antwortet der Rechner mit dem lokalen Modell gerade?
   *
   * null heißt: kein lokales Modell eingestellt, oder es wurde noch nicht
   * nachgesehen. „translation" allein sagt nur, ob ein Anbieter eingestellt
   * ist — für ein Modell im eigenen Netz ist das die halbe Wahrheit.
   */
  lokalerZustand: 'erreichbar' | 'antwortet-nicht' | 'kein-modell' | null;
  /** Was dort zuletzt geladen war. */
  lokaleModelle: string[] | null;
  /** Klartext-Grund, wenn es klemmt. */
  lokalerFehler: string | null;
  /** Wann zuletzt nachgesehen wurde. */
  lokalGeprueftAm: number | null;
  /** Wann zuletzt wirklich jemand geantwortet hat. */
  lokalErfolgAm: number | null;
  /**
   * Hinweis zum Stand der KI — dieselbe Machart wie bei den Fehlermeldungen:
   * der Server schickt eine Kennung, die Oberfläche setzt ihren eigenen Satz in
   * der eingestellten Sprache ein. So muss der Server nicht wissen, welche
   * Sprache am anderen Ende läuft.
   */
  noteCode: string | null;
  /** Platzhalterwerte zur Kennung, etwa der Name des Anbieters. */
  noteWerte: Record<string, string> | null;
  /** Derselbe Hinweis auf Deutsch — Rückfall für Clients, die die Kennung noch nicht kennen. */
  note: string | null;
}

export function encode(ev: ClientEvent | ServerEvent): string {
  return JSON.stringify(ev);
}

export function decode<T = ClientEvent | ServerEvent>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}
