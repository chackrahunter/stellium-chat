import { useEffect, useState } from 'react';
import { t } from '../i18n';
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

/*
 * `*so*` im Text wird fett.
 *
 * Warum nicht einfach JSX mit <b> in der Anleitung: die Sätze müssen
 * übersetzbar sein, und ein Satz, der in fünf JSX-Stücke zerfällt, ist es
 * nicht — wer ihn übersetzt, bekommt Wortfetzen ohne Zusammenhang und kann
 * die Reihenfolge nicht ändern, obwohl genau das in vielen Sprachen nötig
 * ist. Ein Stern ist die kleinste Auszeichnung, die ein Übersetzer
 * unfallfrei stehen lässt.
 */
function fett(text: string): React.ReactNode[] {
  return text.split(/\*([^*]+)\*/g).map((teil, i) =>
    i % 2 === 1 ? <b key={i}>{teil}</b> : <span key={i}>{teil}</span>);
}

/* ── Anleitungen ──────────────────────────────────────────── */

interface Schritt { symbol: React.ReactNode; text: React.ReactNode }

function anleitung(familie: Browserfamilie, name: string): {
  titel: string; schritte: Schritt[]; hinweis?: React.ReactNode;
} {
  /* Ein Schlüssel je Schritt statt Textstücken im Code — siehe fett(). */
  const S = (k: string) => t(`einrichten.${k}` as never, { browser: name });
  const schritt = (symbol: React.ReactNode, k: string): Schritt =>
    ({ symbol, text: fett(S(k)) });

  switch (familie) {
    case 'safari-ios':
      return {
        titel: S('safari.titel'),
        schritte: [
          schritt(<TeilenIos />, 'safari.1'),
          schritt(<PlusFeld />, 'safari.2'),
          schritt(<Haken />, 'safari.3'),
        ],
      };

    case 'andere-ios':
      return {
        titel: S('ios.titel'),
        schritte: [
          schritt(<Kompass />, 'ios.1'),
          schritt(<TeilenIos />, 'ios.2'),
          schritt(<PlusFeld />, 'ios.3'),
        ],
        hinweis: S('ios.hinweis'),
      };

    case 'chrome-android':
      return {
        titel: S('chrome.titel'),
        schritte: [
          schritt(<PunkteSenkrecht />, 'chrome.1'),
          schritt(<PlusFeld />, 'chrome.2'),
        ],
      };

    case 'samsung':
      return {
        titel: S('samsung.titel'),
        schritte: [
          schritt(<Balken />, 'samsung.1'),
          schritt(<PlusFeld />, 'samsung.2'),
        ],
      };

    case 'firefox-android':
      return {
        titel: S('firefox.titel'),
        schritte: [
          schritt(<PunkteSenkrecht />, 'firefox.1'),
          schritt(<PlusFeld />, 'firefox.2'),
        ],
      };

    case 'in-app':
      return {
        titel: S('inapp.titel'),
        schritte: [
          schritt(<PunkteSenkrecht />, 'inapp.1'),
          schritt(<TeilenIos />, 'inapp.2'),
          schritt(<PlusFeld />, 'inapp.3'),
        ],
        hinweis: S('inapp.hinweis'),
      };

    default:
      return {
        titel: S('allg.titel'),
        schritte: [
          schritt(<PunkteSenkrecht />, 'allg.1'),
          schritt(<PlusFeld />, 'allg.2'),
          schritt(<Kacheln />, 'allg.3'),
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
            <div className="einrichten__sinn">{t('einrichten.sinn')}</div>
          </div>
        </div>

        <h1 className="einrichten__ueberschrift">{t('einrichten.ueberschrift')}</h1>
        <p className="einrichten__warum">{t('einrichten.warum')}</p>

        {kannEinrichten && (
          <>
            <button type="button" className="btn btn--primary einrichten__knopf"
                    onClick={() => { void einrichtenAnbieten(); }}>
              {t('einrichten.jetzt')}
            </button>
            {/* Der Knopf ist der kurze Weg. Die Schritte darunter bleiben
                trotzdem stehen: bricht jemand die Abfrage ab, kommt sie in
                derselben Sitzung nicht wieder. */}
            <div className="einrichten__oder">{t('einrichten.oder')}</div>
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
        <p className="einrichten__fuss">{t('einrichten.fuss')}</p>
      </div>
    </div>
  );
}
