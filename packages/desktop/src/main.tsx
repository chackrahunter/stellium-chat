import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { App } from './App.jsx';
import { Fangkorb } from './components/Fangkorb.jsx';
import { Startbildschirm } from './components/Startbildschirm.jsx';
import { Fernsteuerung } from './components/Fernsteuerung.jsx';
import { einrichtungNoetig } from './lib/installation.js';
import { updatesVerbinden } from './lib/updates.js';
import { auffrischenVerbinden } from './lib/auffrischen.js';
import { sichereBereicheVerbinden } from './lib/sichere-bereiche.js';
import { tastaturVerbinden } from './lib/tastatur.js';
import { meldewegPruefen, meldewegVorbereiten } from './lib/benachrichtigung.js';
import './styles/app.css';
/* Nach app.css, nicht davor: die mobile Ansicht baut auf app.css auf
   und muss deshalb später kommen. Als @import am Dateiende wäre sie
   ungültig — CSS erlaubt @import nur ganz oben. */
import './styles/post.css';
import './styles/partnergruppen.css';
import './styles/mobil.css';

/**
 * Plattform setzen, bevor React das erste Mal zeichnet. Auf macOS liegen die
 * Fensterknöpfe im Fensterinhalt; das Layout muss von Anfang an Platz lassen,
 * sonst blitzt das Logo unter den Knöpfen auf.
 */
document.documentElement.dataset.platform = window.stellium?.platform ?? 'browser';

const container = document.getElementById('root');
if (!container) throw new Error('#root fehlt im HTML');

updatesVerbinden();
/* Im Browser und in der Startbildschirm-App gibt es keinen Hauptprozess, der
   eine neue Fassung meldet. Diese Zeile merkt sie selbst. */
auffrischenVerbinden();
/* Muss vor dem ersten Zeichnen laufen — sonst springt die Kopfzeile. */
sichereBereicheVerbinden();
/* iOS legt die Tastatur ÜBER die Seite statt sie zu verkleinern —
   diese Zeile macht die sichtbare Höhe als --vv-hoehe verfügbar. */
tastaturVerbinden();
/* Einmal nachsehen, ob das System Benachrichtigungen überhaupt annimmt —
   sonst behaupten die Einstellungen etwas, das nicht stimmt. */
meldewegPruefen();
/* Der Service Worker ist auf dem Telefon der einzige Weg, auf dem eine
   Benachrichtigung überhaupt ankommt — vor dem ersten Bedarf registrieren. */
meldewegVorbereiten();

/* Der äußerste Fangkorb. Ohne ihn hängt React bei einem Fehler beim Zeichnen
   den ganzen Baum aus: #root ist leer, das Fenster bleibt schwarz und nichts
   sagt, warum. Mit ihm steht dort wenigstens ein Satz und ein Knopf. */
/* Auf dem Telefon im Browser statt der App die Anleitung zum Einrichten.
   Die Entscheidung faellt EINMAL vor dem ersten Zeichnen und nicht als
   Zustand in der App: sonst baute React erst die ganze Oberflaeche auf,
   meldete sich am Server an und ersetzte sie eine Zeichnung spaeter wieder —
   sichtbar als Flackern und unnoetige Last. */
createRoot(container).render(
  <StrictMode>
    <Fangkorb>
      {/* `#fern` heißt: dieses Fenster zeigt NUR den Bildschirm des Pi.
          Es meldet sich nicht am Chatserver an und baut keine Oberfläche
          auf — beides bräuchte es nicht, und beides kostete Speicher und
          eine zweite Verbindung. Geöffnet wird es aus dem Hauptfenster
          heraus (fern:fenster im Hauptprozess). */}
      {/* „Bewegung reduzieren" gilt auch fuer framer-motion.

          Die Ruecknahme in app.css (`prefers-reduced-motion`) trifft mit
          ihrem `*`-Selektor jede CSS-Animation und jeden Uebergang — aber
          framer-motion animiert nicht ueber CSS. Es setzt die Werte in
          JavaScript Bild fuer Bild (WAAPI beziehungsweise direkt am style),
          und daran kommt keine Stilregel heran. In 40 Dateien liegen
          `motion`- und `AnimatePresence`-Elemente: Fenster, Meldungen,
          Thread, Nachrichten. Wer die Systemeinstellung einschaltet, sah sie
          bisher trotzdem in voller Bewegung.

          `reducedMotion="user"` fragt dieselbe Medienabfrage ab und laesst
          framer-motion dann nur noch Deckkraft und Farbe animieren — Lage,
          Groesse und Drehung springen. Genau das ist gemeint: nichts blinkt
          weg, aber nichts bewegt sich mehr durchs Bild.

          Hier an der Wurzel und nicht in 40 Dateien: `useReducedMotion` in
          jeder einzelnen waere dieselbe Entscheidung vierzigmal, und die
          einundvierzigste Datei vergaesse sie. */}
      <MotionConfig reducedMotion="user">
        {location.hash === '#fern'
          ? <Fernsteuerung eigenstaendig onClose={() => window.close()} />
          : einrichtungNoetig() ? <Startbildschirm /> : <App />}
      </MotionConfig>
    </Fangkorb>
  </StrictMode>,
);
