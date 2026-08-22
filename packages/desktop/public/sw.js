/*
 * Der Service Worker — für Benachrichtigungen.
 *
 * Warum es ihn geben muss: `new Notification(...)` ist der alte Weg und wird
 * an genau den Stellen nicht unterstützt, an denen Stellium auf dem Telefon
 * läuft. Eine Web-App auf dem iPhone-Startbildschirm kennt den Aufruf
 * schlicht nicht — iOS verlangt `ServiceWorkerRegistration.showNotification`.
 * Chrome verlangt dasselbe für installierte Web-Apps. Ohne diese Datei kam
 * deshalb auf keinem Telefon je eine Benachrichtigung an, und im Browser
 * auch nur dann, wenn jemand die Erlaubnis von Hand in den Einstellungen
 * erteilt hatte.
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
