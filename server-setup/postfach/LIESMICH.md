# Postfach für stellium.club

Eigene Firmenadressen (`info@`, `support@`, …) für **0 € im Monat**, und beim
Empfänger steht die eigene Adresse — ohne „via" irgendetwas.

## Warum es so gebaut ist

Der naheliegende Gedanke war: einen Mailserver auf den Pi. Das geht nicht, und
zwar nicht aus Bequemlichkeit:

* Die Maschine hängt an einem Wohnanschluss ohne Versandruf. Post von dort
  landet bei fast jedem Empfänger im Spam oder wird gleich abgewiesen.
* Port 25 sperren viele Anbieter ohnehin.
* Die Portfreigaben im Router laufen stündlich ab (siehe
  `server-setup/fernsteuerung/einheiten/`). Ein Mailserver, der eine Stunde
  nicht erreichbar ist, verliert Post.

Der zweite Gedanke war IMAP. Auch das nicht — nicht wegen des Protokolls,
sondern wegen dem, was danach kommt: echte Post ist mehrteilig,
base64- oder quoted-printable-kodiert, in wechselnden Zeichensätzen, mit
Anhängen. Einen MIME-Zerleger von Hand zu schreiben heißt, jahrelang
Sonderfälle nachzureichen, und bis dahin zeigt die Anzeige Zeichensalat.

## Der Aufbau

    Absender
       │
       ▼
    Cloudflare Email Routing        kostenlos, eingehend unbegrenzt
       │
       ▼
    Email Worker (dieses Verzeichnis)
       │  zerlegt die Mail mit postal-mime
       │  schickt fertiges JSON per HTTPS
       ▼
    Stellium  POST /api/post/eingang     durch den bestehenden Tunnel

**Der Empfang braucht keine Portfreigabe.** Der Tunnel wird vom Pi nach außen
aufgebaut; die Anfrage des Workers läuft darüber hinein. Alles, was heute an
NAT-PMP hängt, ist hier ohne Bedeutung.

Gesendet wird getrennt davon über einen Anbieter mit DKIM auf der eigenen
Domain (Resend im Gratistarif: 100 Mails am Tag, 3 000 im Monat). Cloudflare
kann inzwischen auch senden, aber nur im kostenpflichtigen Workers-Tarif.

## Einrichten

### 1. Cloudflare Email Routing (im Dashboard)

* **Destination addresses** → ein vorhandenes Postfach eintragen und den
  Bestätigungslink klicken. Ohne das nimmt Cloudflare keine Regel an.
* **Routing rules** → je Adresse eine Regel. Solange der Worker noch nicht
  läuft: `Send to an email`. Danach umstellen auf `Send to a Worker`.
* `noreply` bekommt `Drop` — die Adresse sieht gültig aus und nimmt nichts an.
* **Catch-all** einschalten, damit Tippfehler nicht zurückprallen.

Die DNS-Einträge setzt der Assistent selbst. Die krummen MX-Prioritäten
(89, 8, 78) sind kein Fehler: Cloudflare vergibt sie automatisch, alle drei
Server sind gleichwertig.

### 2. Den Worker ausliefern

    cd server-setup/postfach/worker
    npm install
    npx wrangler secret put EINGANG_GEHEIMNIS     # dasselbe wie in Stellium
    npx wrangler secret put RUECKFALL_ADRESSE     # verifizierte Zieladresse
    npm run deploy

Die Geheimnisse gehören **nicht** in `wrangler.jsonc` — die Datei liegt im
Repo.

### 3. DMARC

    TXT  _dmarc.stellium.club   v=DMARC1; p=none; rua=mailto:<adresse>;

`p=none` zum Start, und das ist keine Nachlässigkeit: zwei DKIM-Pfade laufen
neu an, und bei einem Konfigurationsfehler verschwände eigene Post unsichtbar
im Spam der Empfänger. Erst nach ein bis zwei Wochen sauberer Berichte auf
`quarantine`, später `reject`. Vorhanden sein **muss** der Eintrag aber ab dem
ersten Tag — Microsoft lehnt Post von Domains ohne jeden DMARC-Eintrag ab.

## Was schiefgehen kann

* **Der Root-MX gehört ab jetzt exklusiv Cloudflare.** Bestehende Mail-Einträge
  auf der Domain müssen vorher weichen. Am 22.08.2026 nachgesehen: es gab
  keine.
* **Zwei SPF-Einträge nebeneinander machen beide ungültig.** Kommt später ein
  weiterer Dienst dazu, wird der bestehende Eintrag **ergänzt**, nicht
  danebengestellt.
* **Der Worker darf nichts verschlucken.** Ist Stellium gerade weg, leitet er
  an `RUECKFALL_ADRESSE` weiter. Ohne das wäre die Mail verloren — ohne
  Fehlermeldung, ohne Zustellbericht, ohne dass es jemand merkt. Das ist die
  schlimmste Sorte Ausfall: einer, den beide Seiten für erfolgreich halten.
* **Der Eingang braucht ein Geheimnis.** `/api/post/eingang` hängt öffentlich
  am Tunnel; ohne Prüfung könnte jeder erfundene Post einspeisen.
