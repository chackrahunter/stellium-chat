/*
 * Der Service Worker — für Benachrichtigungen.
 *
 * Warum es ihn geben muss: `new Notification(...)` ist der alte Weg und wird
 * an genau den Stellen nicht unterstützt, an denen Stellium auf dem Telefon
 * läuft. Eine Web-App auf dem iPhone-Startbildschirm kennt den Aufruf
 * schlicht nicht — iOS verlangt `ServiceWorkerRegistration.showNotification`.
 * Chrome verlangt dasselbe für installierte Web-Apps.
 *
 * Zwei ganz verschiedene Auslöser laufen hier zusammen, und der Unterschied
 * ist der Grund, warum es diese Datei überhaupt braucht:
 *
 *   - `notificationclick` — jemand tippt auf eine bereits gezeigte Meldung.
 *     Das gab es schon immer, unabhängig davon, wie sie entstand.
 *   - `push` — eine Nachricht vom Push-Dienst (Apple/Google/Mozilla), die
 *     ankommt, WÄHREND STELLIUM NICHT LÄUFT. Ohne dieses Ereignis kam bisher
 *     jede echte Benachrichtigung nie an: `zeigen()` in
 *     lib/benachrichtigung.ts läuft im Code der offenen Seite, und der
 *     existiert auf einem gesperrten Telefon schlicht nicht. Ein
 *     Service Worker dagegen wacht das Betriebssystem gezielt für genau
 *     dieses Ereignis wieder auf — das ist der ganze Witz von Web Push.
 *
 * Bewusst OHNE Zwischenspeicher für Dateien. Ein Service Worker, der auch
 * Antworten aufbewahrt, entscheidet mit darüber, welche Fassung der App
 * jemand sieht — und dann streiten zwei Stellen um dasselbe: er und
 * lib/auffrischen.ts, das die neue Fassung selbst bemerkt. Zwei Stellen für
 * eine Aufgabe sind eine Fehlerquelle mehr, und die Ersparnis wäre gering,
 * weil der Server ohnehin passende Zwischenspeicher-Regeln mitschickt.
 */

/* Sofort übernehmen statt auf das Schließen aller Fenster zu warten — sonst
   bliebe eine neue Fassung dieser Datei tagelang wirkungslos. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/*
 * Ein Tipp auf die Benachrichtigung.
 *
 * Ist Stellium schon offen, wird dieses Fenster nach vorn geholt und der
 * Kanal darin geöffnet — ein zweites aufzumachen wäre das Gegenteil von dem,
 * was jemand erwartet, der auf eine Nachricht tippt.
 */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const kanal = e.notification.data && e.notification.data.kanalId;
  e.waitUntil((async () => {
    const fenster = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const f of fenster) {
      if (!f.url.startsWith(self.registration.scope)) continue;
      await f.focus();
      if (kanal) f.postMessage({ art: 'kanal-oeffnen', kanalId: kanal });
      return;
    }
    /* Keines offen: neu öffnen. Der Kanal geht als Ankersatz mit, weil ein
       frisch geöffnetes Fenster keine Nachricht empfangen kann, bevor es
       fertig geladen hat. */
    await self.clients.openWindow(kanal ? `/#kanal=${kanal}` : '/');
  })());
});

/*
 * Eine Push-Nachricht vom Server — das eigentliche Ziel dieser Datei.
 *
 * Die Nutzlast ist verschlüsselt zwischen Server und Browser unterwegs (der
 * Push-Dienst dazwischen kann sie nicht lesen); an dieser Stelle liegt sie
 * bereits entschlüsselt vor. Form siehe services/push.ts: { titel, text,
 * kanalId, gruppe }.
 *
 * `titel`/`text` kommen bereits in der Sprache der empfangenden Person an —
 * der Server löst das auf (services/push.ts, textAufloesen(), mit
 * store.uiLanguageOf() und einem eigenen kleinen Wörterbuch in
 * services/push-i18n.ts), nicht dieser Worker hier. Dieser Datei fehlt damit
 * absichtlich jedes Wörterbuch und jede Sprachlogik: sie zeigt an, was
 * ankommt, mehr nicht — ein veralteter, noch nicht ersetzter Stand dieser
 * Datei zeigt eine Übersetzung darum genauso richtig an wie der aktuellste.
 */
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let daten = {};
    try { daten = e.data ? e.data.json() : {}; } catch { /* leere oder kaputte Nutzlast — dann eben ohne Text */ }

    /* Steht gerade ein Fenster im Vordergrund, sieht diese Person die App
       ohnehin gerade an — die Nachricht kam dann über die offene
       WebSocket-Verbindung längst an und zeigt sich selbst
       (state/store.ts, notifyIfNeeded()). Eine zweite, vom Push-Dienst
       ausgelöste Meldung obendrauf wäre nur ein Echo derselben Sache. Der
       Server kennt den Sichtbarkeitszustand eines Fensters nicht — das kann
       nur hier, im Worker desselben Geräts, entschieden werden. */
    const fenster = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (fenster.some((f) => f.focused)) return;

    await self.registration.showNotification(daten.titel || 'Stellium', {
      body: daten.text || '',
      tag: daten.gruppe || daten.kanalId || 'stellium',
      icon: '/stellium-192.png',
      badge: '/stellium-192.png',
      data: { kanalId: daten.kanalId || null },
    });
  })());
});

/*
 * Der Browser erneuert ein Abonnement von sich aus — ein ablaufender
 * interner Schlüssel, ein Wechsel des Push-Diensts. Der Server erfährt davon
 * nichts von selbst, er kennt nur den `endpoint`, den er zuletzt bekommen
 * hat, und der wird mit der Erneuerung ungültig.
 *
 * Zwei Wege, ihn trotzdem zu erreichen: ein offenes Fenster bekommt das neue
 * Abonnement sofort zugeschickt und reicht es über die WebSocket-Verbindung
 * weiter (die hat einen Anmeldenachweis, den dieser Worker nicht besitzt —
 * er kann den Server nicht direkt anrufen). Ist keines offen, holt sich die
 * App das beim nächsten Start ohnehin selbst: pushAbonnieren() in
 * lib/benachrichtigung.ts vergleicht bei jedem Verbindungsaufbau, ob der
 * Server noch dasselbe Abonnement kennt.
 */
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const alteOptionen = e.oldSubscription && e.oldSubscription.options;
    if (!alteOptionen || !alteOptionen.applicationServerKey) return;   // ohne Schlüssel kein Neuaufbau möglich
    const neu = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: alteOptionen.applicationServerKey,
    });
    const fenster = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const f of fenster) f.postMessage({ art: 'push-erneuert', subscription: neu.toJSON() });
  })());
});
