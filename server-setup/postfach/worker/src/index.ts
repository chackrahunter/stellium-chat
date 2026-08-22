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

/* Grenzen, die HIER greifen müssen und nicht erst in Fastify.
   Läuft eine Mail in Fastifys Rumpfgrenze, antwortet der Server mit 413,
   der Worker wertet das als Fehlschlag und leitet weiter — und dann hat der
   Absender bestimmt, wo seine Post landet. Deshalb sind diese Werte
   deutlich kleiner als die der Gegenstelle. */
const ANHANG_MAX = 1 * 1024 * 1024;        // je Anhang
const ANHAENGE_MAX_GESAMT = 5 * 1024 * 1024;
const VERSUCHE = 3;

/*
 * Base64 in Blöcken.
 *
 * Hier stand `btoa(String.fromCharCode(...new Uint8Array(inhalt)))`. Das
 * Aufspreizen in die Argumentliste sprengt in V8 den Stack — je nach Lage ab
 * etwa 64 KB. Der Fehler landete im `catch` und die Mail wurde weitergeleitet
 * statt zugestellt. Es brauchte dafür keinen Angreifer: eine PDF-Rechnung
 * reicht.
 */
function alsBase64(daten: ArrayBuffer): string {
  const bytes = new Uint8Array(daten);
  const teile: string[] = [];
  const fenster = 0x8000;
  for (let i = 0; i < bytes.length; i += fenster) {
    teile.push(String.fromCharCode(...bytes.subarray(i, i + fenster)));
  }
  return btoa(teile.join(''));
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    let letzterFehler: unknown = null;

    try {
      const post = await PostalMime.parse(message.raw);

      /* Anhänge deckeln, statt an ihnen zu scheitern. Ein fehlender Anhang
         mit Vermerk ist unendlich viel besser als eine Mail, die woanders
         hingeht. */
      let gesamt = 0;
      const anhaenge = (post.attachments ?? []).slice(0, 25).map((a) => {
        const roh = typeof a.content === 'string' ? null : a.content;
        const groesse = roh ? roh.byteLength : (a.content as string).length;
        const passt = groesse <= ANHANG_MAX && gesamt + groesse <= ANHAENGE_MAX_GESAMT;
        if (passt) gesamt += groesse;
        return {
          name: a.filename ?? 'ohne-namen',
          typ: a.mimeType,
          groesse,
          uebergross: !passt,
          inhalt: passt ? (roh ? alsBase64(roh) : (a.content as string)) : null,
        };
      });

      /* Die Prüfergebnisse von Cloudflare — aber die ERSTE Zeile, und nur
         wenn sie von Cloudflare stammt. Ein Absender darf eine eigene
         `Authentication-Results`-Zeile in seine Mail schreiben, und die
         Headers-API fügt gleichnamige Zeilen zusammen. Wer hier naiv nach
         „dmarc=pass" sucht, prüft am Ende die Behauptung des Absenders. */
      const pruefzeilen = (post.headers ?? [])
        .filter((h) => h.key?.toLowerCase() === 'authentication-results')
        .map((h) => h.value);
      const pruefung = pruefzeilen[0] ?? null;

      const rumpf = JSON.stringify({
        an: message.to,
        /* Der Umschlagabsender ist NICHT der sichtbare Absender. Beide
           mitschicken: `From:` steht im Mailprogramm, `MAIL FROM` zählt für
           SPF. Gehen sie auseinander, muss das jemand sehen. */
        von: post.from?.address ?? message.from,
        vonName: post.from?.name ?? null,
        umschlagVon: message.from,
        antwortAn: post.replyTo?.[0]?.address ?? null,
        betreff: post.subject ?? '',
        text: post.text ?? '',
        html: post.html ?? null,
        messageId: post.messageId ?? null,
        referenzen: post.references ?? null,
        pruefung,
        am: Date.now(),
        anhaenge,
      });

      /* Ein Zustellschlüssel aus UNSERER Hand. Auf der Message-ID des
         Absenders zu entdubletten wäre eine Zustellsperre: wer das Muster
         eines Lieferanten kennt, meldet dessen nächste Rechnungs-ID vorher
         an, und die echte Rechnung verschwindet dann lautlos als Dublette. */
      const schluessel = await zustellSchluessel(rumpf);

      for (let versuch = 1; versuch <= VERSUCHE; versuch += 1) {
        try {
          const antwort = await fetch(env.STELLIUM_EINGANG, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-stellium-eingang': env.EINGANG_GEHEIMNIS,
              'x-stellium-schluessel': schluessel,
            },
            body: rumpf,
            /* Ohne Frist hängt der Worker, solange der Pi hängt — und wird
               dann von der Plattform abgeräumt, bevor der Rückfall läuft. */
            signal: AbortSignal.timeout(10_000),
          });

          if (antwort.ok) return;

          /* 4xx heißt: Stellium hat es bekommen und abgelehnt. Das ist ein
             Fehler auf unserer Seite oder ein Angriff — Wiederholen hilft
             nicht, und Weiterleiten an ein Privatpostfach wäre die falsche
             Antwort. Lieber laut scheitern. */
          if (antwort.status >= 400 && antwort.status < 500 && antwort.status !== 429) {
            console.error(`[eingang] abgelehnt mit ${antwort.status} — nicht weitergeleitet`);
            return;
          }
          letzterFehler = new Error(`Stellium antwortet mit ${antwort.status}`);
        } catch (f) {
          letzterFehler = f;
        }
        if (versuch < VERSUCHE) {
          await new Promise((r) => setTimeout(r, 400 * 2 ** versuch));
        }
      }
      throw letzterFehler ?? new Error('unbekannt');
    } catch (fehler) {
      /*
       * Post darf nicht verschwinden — aber der Rückfall ist kein guter
       * Zustand, sondern ein Notausgang. Dort liegt die Mail unverschlüsselt
       * in einem privaten Postfach, ohne Rechteprüfung und ohne dass jemand
       * davon erfährt.
       *
       * Deshalb erst nach drei Versuchen, und nur bei Netz- oder
       * Serverfehlern. Und deshalb laut ins Protokoll: eine stille
       * Weiterleitung ist genau die Sorte Ausfall, die beide Seiten für
       * erfolgreich halten.
       */
      console.error('[eingang] nach', VERSUCHE, 'Versuchen weitergeleitet:', String(fehler));
      await message.forward(env.RUECKFALL_ADRESSE);
    }
  },
};

/** SHA-256 über den Rumpf, base64url — der Schlüssel für die Idempotenz. */
async function zustellSchluessel(rumpf: string): Promise<string> {
  const summe = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rumpf));
  return btoa(String.fromCharCode(...new Uint8Array(summe)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
