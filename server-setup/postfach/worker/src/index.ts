/**
 * Der Türsteher für eingehende Post.
 *
 * Läuft NICHT auf dem Pi, sondern bei Cloudflare. Das ist der ganze Trick an
 * diesem Aufbau: Cloudflare nimmt die Mail an seinen eigenen Servern entgegen,
 * dieser Worker zerlegt sie dort und schickt fertiges JSON an Stellium — über
 * eine gewöhnliche HTTPS-Anfrage durch den bestehenden Tunnel, also von außen
 * nach innen über eine Verbindung, die der Pi selbst aufgebaut hat.
 *
 * Damit braucht der Empfang **keine Portfreigabe im Router**. Die
 * NAT-PMP-Freigaben, die am 22.08.2026 die Fernsteuerung gekostet haben, sind
 * hier ohne Bedeutung.
 *
 * Und der zweite Grund für diesen Umweg: das Zerlegen echter Post ist die
 * unangenehme Arbeit — mehrteilige Nachrichten, base64, quoted-printable,
 * wechselnde Zeichensätze, Anhänge. Sie bleibt hier, in einem kleinen Bündel
 * bei Cloudflare. Der Stellium-Server bekommt nur noch Felder und braucht
 * dafür kein einziges fremdes Paket.
 */
import PostalMime from 'postal-mime';

export interface Env {
  /** Wohin die zerlegte Post geht, etwa https://chat.stellium.club/api/post/eingang */
  STELLIUM_EINGANG: string;
  /** Gemeinsames Geheimnis. Ohne das könnte jeder erfundene „Post" einspeisen. */
  EINGANG_GEHEIMNIS: string;
  /** Wohin die Mail geht, wenn Stellium gerade nicht erreichbar ist. */
  RUECKFALL_ADRESSE: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    try {
      const post = await PostalMime.parse(message.raw);

      const antwort = await fetch(env.STELLIUM_EINGANG, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-stellium-eingang': env.EINGANG_GEHEIMNIS,
        },
        body: JSON.stringify({
          an: message.to,
          von: message.from,
          betreff: post.subject ?? '',
          text: post.text ?? '',
          html: post.html ?? null,
          /* Die Kennungen, an denen Mailprogramme einen Verlauf aufhängen.
             Ohne sie wäre jede Antwort von uns eine neue Nachricht mit „Re:"
             davor statt einer Antwort im selben Strang. */
          messageId: message.headers.get('message-id') ?? null,
          referenzen: message.headers.get('references') ?? null,
          am: Date.now(),
          anhaenge: (post.attachments ?? []).map((a) => ({
            name: a.filename ?? 'ohne-namen',
            typ: a.mimeType,
            /* Base64, damit es durch JSON passt. Große Anhänge bleiben
               absichtlich draußen — Cloudflare weist Mails über 25 MiB
               ohnehin schon an der Annahme ab. */
            inhalt: typeof a.content === 'string'
              ? a.content
              : btoa(String.fromCharCode(...new Uint8Array(a.content))),
          })),
        }),
      });

      /* Ein 500er von Stellium ist genauso ein Verlust wie gar keine
         Verbindung — beides muss in den Rückfall. */
      if (!antwort.ok) throw new Error(`Stellium antwortet mit ${antwort.status}`);
    } catch (fehler) {
      /*
       * Post darf nicht verschwinden.
       *
       * Ohne diesen Zweig wäre eine Mail weg, sobald der Tunnel kurz hängt
       * oder der Server neu startet — ohne Fehlermeldung, ohne Zustellbericht
       * an den Absender, ohne dass es jemand merkt. Das ist die schlimmste
       * Sorte Ausfall: einer, den beide Seiten für erfolgreich halten.
       *
       * Der Rückfall geht an eine bei Cloudflare verifizierte Adresse. Sie
       * bekommt dann eben ein paar Mails von Hand — besser als keine.
       */
      console.error('[eingang] weitergeleitet statt zugestellt:', String(fehler));
      await message.forward(env.RUECKFALL_ADRESSE);
    }
  },
};
