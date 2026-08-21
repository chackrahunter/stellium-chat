import { useEffect, useState } from 'react';
import {
  aufforderungBeobachten, aufforderungDa, einrichtenAnbieten, lageBestimmen,
  type Browserfamilie,
} from '../lib/installation.js';

/**
 * Die Einrichtungsseite für mobile Browser.
 *
 * Stellium läuft auf dem Telefon als Startbildschirm-App, nicht als Seite im
 * Browser — nur so gibt es den ganzen Schirm, Benachrichtigungen und einen
 * Start ohne Adressleiste. Wer die Adresse im Browser öffnet, landet deshalb
 * zuerst hier.
 *
 * Der Kern ist nicht die Aufforderung, sondern die ANLEITUNG: der Weg zum
 * Symbol ist in jedem Browser ein anderer, und eine allgemeine Anleitung
 * ("füge die Seite zum Startbildschirm hinzu") hilft niemandem, der das Menü
 * nicht ohnehin kennt. Deshalb steht hier für jede Browserfamilie der echte
 * Weg mit dem Symbol, nach dem zu suchen ist.
 */

/* ── Symbole ──────────────────────────────────────────────────
   Gezeichnet statt geladen: sie müssen zu dem passen, was der Nutzer
   gerade auf seinem Schirm sieht, und in der Farbe der Seite erscheinen.
   Eine Bilddatei könnte beides nicht. */

const strich = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/* Das Teilen-Symbol von iOS: ein Kasten, aus dem oben ein Pfeil steigt. */
function TeilenIos() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...strich}>
      <path d="M12 15V3" />
      <path d="m8.5 6.5 3.5-3.5 3.5 3.5" />
      <path d="M8 10H6.5A2.5 2.5 0 0 0 4 12.5v6A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-6A2.5 2.5 0 0 0 17.5 10H16" />
    </svg>
  );
}

/* Ein Pluszeichen im Kasten — so heißt „Zum Home-Bildschirm" in der Liste. */
function PlusFeld() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...strich}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

/* Die drei senkrechten Punkte oben rechts in Chrome und Firefox. */
function PunkteSenkrecht() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="19" r="1.8" fill="currentColor" />
    </svg>
  );
}

/* Die drei Striche unten rechts in Samsung Internet. */
function Balken() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...strich}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

/* Der Kompass von Safari — daran erkennt man die App auf dem Schirm. */
function Kompass() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...strich}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.8 8.2-2 5.6-5.6 2 2-5.6z" />
    </svg>
  );
}

/* Ein Haken für den letzten Schritt. */
function Haken() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...strich}>
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}

/* Ein Raster aus Kacheln — der Startbildschirm selbst. */
function Kacheln() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...strich}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </svg>
  );
}

/* ── Anleitungen ──────────────────────────────────────────── */

interface Schritt { symbol: React.ReactNode; text: React.ReactNode }

function anleitung(familie: Browserfamilie, name: string): {
  titel: string; schritte: Schritt[]; hinweis?: React.ReactNode;
} {
  switch (familie) {
    case 'safari-ios':
      return {
        titel: 'In Safari sind es drei Schritte',
        schritte: [
          { symbol: <TeilenIos />, text: <>Unten in der Leiste auf <b>Teilen</b> tippen — das Feld mit dem Pfeil nach oben.</> },
          { symbol: <PlusFeld />, text: <>In der Liste nach unten wischen bis <b>Zum Home-Bildschirm</b>.</> },
          { symbol: <Haken />, text: <>Oben rechts auf <b>Hinzufügen</b>. Fertig.</> },
        ],
      };

    case 'andere-ios':
      return {
        titel: `Auf dem iPhone geht das nur in Safari, nicht in ${name}`,
        schritte: [
          { symbol: <Kompass />, text: <>Die Seite in <b>Safari</b> öffnen. In {name} steht der Punkt im Menü, meist als <b>In Safari öffnen</b>.</> },
          { symbol: <TeilenIos />, text: <>Dort unten auf <b>Teilen</b> tippen.</> },
          { symbol: <PlusFeld />, text: <><b>Zum Home-Bildschirm</b> wählen, dann <b>Hinzufügen</b>.</> },
        ],
        hinweis: <>Das ist keine Vorliebe, sondern eine Vorgabe von Apple: nur Safari darf auf iPhone und iPad ein Symbol auf dem Startbildschirm anlegen.</>,
      };

    case 'chrome-android':
      return {
        titel: `In ${name} sind es zwei Schritte`,
        schritte: [
          { symbol: <PunkteSenkrecht />, text: <>Oben rechts auf die <b>drei Punkte</b> tippen.</> },
          { symbol: <PlusFeld />, text: <><b>App installieren</b> wählen — je nach Fassung heißt es <b>Zum Startbildschirm hinzufügen</b>.</> },
        ],
      };

    case 'samsung':
      return {
        titel: 'In Samsung Internet sind es zwei Schritte',
        schritte: [
          { symbol: <Balken />, text: <>Unten rechts auf die <b>drei Striche</b> tippen.</> },
          { symbol: <PlusFeld />, text: <><b>Seite hinzufügen zu</b> und dann <b>Startbildschirm</b> wählen.</> },
        ],
      };

    case 'firefox-android':
      return {
        titel: 'In Firefox sind es zwei Schritte',
        schritte: [
          { symbol: <PunkteSenkrecht />, text: <>Rechts in der Adressleiste auf die <b>drei Punkte</b> tippen.</> },
          { symbol: <PlusFeld />, text: <><b>Zum Startbildschirm hinzufügen</b> wählen.</> },
        ],
      };

    case 'in-app':
      return {
        titel: 'Diese Seite läuft gerade im Browser einer anderen App',
        schritte: [
          { symbol: <PunkteSenkrecht />, text: <>Im Menü dieser App auf <b>Im Browser öffnen</b> tippen.</> },
          { symbol: <TeilenIos />, text: <>Im richtigen Browser dann auf <b>Teilen</b> beziehungsweise das Menü.</> },
          { symbol: <PlusFeld />, text: <><b>Zum Startbildschirm hinzufügen</b> wählen.</> },
        ],
        hinweis: <>Eingebaute Browser — etwa in Instagram oder WhatsApp — können keine Symbole auf dem Startbildschirm anlegen.</>,
      };

    default:
      return {
        titel: 'So richtest du Stellium ein',
        schritte: [
          { symbol: <PunkteSenkrecht />, text: <>Das <b>Menü</b> deines Browsers öffnen — meist drei Punkte oder drei Striche.</> },
          { symbol: <PlusFeld />, text: <>Den Punkt <b>Zum Startbildschirm hinzufügen</b> wählen.</> },
          { symbol: <Kacheln />, text: <>Stellium ab jetzt über das neue Symbol öffnen.</> },
        ],
      };
  }
}

/* ── Die Seite ────────────────────────────────────────────── */

export function Startbildschirm() {
  const lage = lageBestimmen();
  const { titel, schritte, hinweis } = anleitung(lage.familie, lage.browsername);
  const [kannEinrichten, setKannEinrichten] = useState(aufforderungDa());

  /* Android meldet oft erst nach dem ersten Zeichnen, dass es das Einrichten
     selbst anbieten kann. Ohne das Horchen bliebe der Knopf aus, obwohl er
     eine Sekunde später möglich wäre. */
  useEffect(() => aufforderungBeobachten(setKannEinrichten), []);

  return (
    <div className="einrichten">
      <div className="einrichten__karte">
        <div className="einrichten__marke">
          <div className="einrichten__zeichen" aria-hidden="true"><Kacheln /></div>
          <div>
            <div className="einrichten__name">Stellium</div>
            <div className="einrichten__sinn">Chat mit Übersetzung in 22 Sprachen</div>
          </div>
        </div>

        <h1 className="einrichten__ueberschrift">Zuerst auf den Startbildschirm legen</h1>
        <p className="einrichten__warum">
          Auf dem Telefon läuft Stellium als eigene App, nicht als Seite im Browser.
          Nur so bleibt der ganze Bildschirm frei, kommen Benachrichtigungen an und
          startet die App ohne Adressleiste.
        </p>

        {kannEinrichten && (
          <>
            <button type="button" className="btn btn--primary einrichten__knopf"
                    onClick={() => { void einrichtenAnbieten(); }}>
              Jetzt einrichten
            </button>
            {/* Der Knopf ist der kurze Weg. Die Schritte darunter bleiben
                trotzdem stehen: bricht jemand die Abfrage ab, kommt sie in
                derselben Sitzung nicht wieder. */}
            <div className="einrichten__oder">oder von Hand:</div>
          </>
        )}

        <h2 className="einrichten__titel">{titel}</h2>
        <ol className="einrichten__schritte">
          {schritte.map((s, i) => (
            <li key={i} className="einrichten__schritt">
              <span className="einrichten__nummer">{i + 1}</span>
              <span className="einrichten__symbol">{s.symbol}</span>
              <span className="einrichten__text">{s.text}</span>
            </li>
          ))}
        </ol>

        {hinweis && <p className="einrichten__hinweis">{hinweis}</p>}

        {/* Bewusst nicht "angemeldet bleibst du": eine Startbildschirm-App hat
            einen eigenen Speicher, eine Anmeldung im Browser wandert NICHT
            mit. Wer das erwartet und dann doch das Anmeldefenster sieht,
            hält die App für kaputt. */}
        <p className="einrichten__fuss">
          Stellium ab dann immer über das neue Symbol öffnen. Dort meldest du dich
          einmal an und bleibst angemeldet.
        </p>
      </div>
    </div>
  );
}
