import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Banknote, Loader2,
  ReceiptText, Repeat, TrendingUp, Users, Wallet,
} from 'lucide-react';
import { Shell } from './Panels.jsx';
import { useT, currentUiLanguage, type TranslationKey } from '../i18n';
import { api, type GumroadUebersicht, type PatreonKennzahlen, type PatreonMomentaufnahme } from '../net/api.js';
import { geld, prozent } from '../lib/format.js';

/**
 * Die ausführliche Verkaufsansicht — ein Klick von der Verkaufskachel in
 * SystemPanel.tsx entfernt.
 *
 * WARUM EINE EIGENE ANSICHT UND NICHT MEHR ZEILEN IN DER KACHEL: Die Kachel
 * sitzt zwischen Chat, Webseite und Netzwerk in derselben Tafel — sie soll
 * in drei, vier Zahlen sagen, ob das Geschäft läuft, nicht die vollständige
 * Buchhaltung ersetzen. Alles, was der Auftrag zusätzlich verlangt (Verlauf,
 * Probezeit im Detail, Erstattungen, Auszahlungen, Patreon daneben) gehört
 * hierher: wer es braucht, klickt einmal; wer nur den Puls sehen will, sieht
 * ihn ohne zu scrollen.
 *
 * WARUM ÜBERALL EIGENE LEERZUSTÄNDE: Diese Firma hat heute null Verkäufe bei
 * allen Produkten. Ein Verlaufsbalken, der bei null Datenpunkten trotzdem
 * eine leere Spur zeichnet, sieht aus wie ein Fehler, nicht wie "es hat noch
 * nicht angefangen". Jeder Abschnitt mit einem Diagramm prüft deshalb erst,
 * ob es überhaupt Daten gibt, und zeigt sonst einen Satz statt eines leeren
 * Balkens.
 */

function Zeile({ name, wert, ton }: { name: string; wert: React.ReactNode; ton?: 'gut' | 'warn' }) {
  return (
    <div className="syszeile">
      <span className="syszeile__name">{name}</span>
      <span className={`syszeile__wert ${ton ? `syszeile__wert--${ton}` : ''}`}>{wert}</span>
    </div>
  );
}

function Notiz({ text, ton }: { text: string; ton?: 'warn' }) {
  return <div className={`sys__notiz ${ton ? `sys__notiz--${ton}` : ''}`}>{text}</div>;
}

/* Ein großer Wert, drei nebeneinander am Kopf jedes Anbieterblocks — der
   Puls auf einen Blick, bevor die Einzelheiten darunter folgen. */
function Kennzahl({ label, wert }: { label: string; wert: string }) {
  return (
    <div className="verkauf__kennzahl">
      <div className="verkauf__kennzahlWert">{wert}</div>
      <div className="verkauf__kennzahlLabel">{label}</div>
    </div>
  );
}

function monatLabel(monat: string): string {
  const datum = new Date(`${monat}-01T00:00:00Z`);
  if (Number.isNaN(datum.getTime())) return monat;
  return new Intl.DateTimeFormat(currentUiLanguage(), { year: 'numeric', month: 'short', timeZone: 'UTC' }).format(datum);
}

/** Ein Balken je Zeile, Länge relativ zum größten Wert der Reihe — dieselbe
 *  Idee wie balken() in stellium-konsole.mjs, nur als HTML/CSS statt
 *  Terminalzeichen. Absichtlich kein Diagramm aus einer Bibliothek: für eine
 *  Handvoll Monatswerte wäre das mehr Gewicht als Nutzen. */
function Balkenreihe({ eintraege }: { eintraege: { label: string; wert: number; text: string }[] }) {
  const max = Math.max(1, ...eintraege.map((e) => Math.abs(e.wert)));
  return (
    <div className="verkauf__balken">
      {eintraege.map((e, i) => (
        <div className="verkauf__balkenzeile" key={`${e.label}-${i}`}>
          <span className="verkauf__balkenlabel">{e.label}</span>
          <span className="verkauf__balkenspur">
            <span className="verkauf__balkenfuellung"
                  style={{ width: `${Math.max(e.wert === 0 ? 0 : 2, (Math.abs(e.wert) / max) * 100)}%` }} />
          </span>
          <span className="verkauf__balkenwert">{e.text}</span>
        </div>
      ))}
    </div>
  );
}

const GUMROAD_STATUS = ['alive', 'pending_cancellation', 'failed_payment', 'pending_failure', 'cancelled'] as const;

function GumroadAbschnitt({ g, t }: { g: GumroadUebersicht; t: ReturnType<typeof useT> }) {
  if (!g.hatDaten) {
    return (
      <section className="sys__block">
        <h3 className="sys__titel"><Wallet size={14} /> {t('verkauf.gumroadUeberschrift')}</h3>
        <Notiz text={g.tokenVorhanden ? t('verkaufUebersicht.leer') : t('verkaufUebersicht.gumroadNichtEingerichtet')} />
      </section>
    );
  }

  const statusLabel = (s: string) => t(`verkaufUebersicht.status.${s}` as TranslationKey);
  /* Gumroads eigene Plankennungen (monthly, quarterly, …) sind KEINE
     Intl-Zeiteinheiten — anders als bei der Probezeit (die trägt echte
     Intl-Einheiten wie "week", siehe zeitspanne() in system.probe oben in
     SystemPanel.tsx) braucht es hier ein eigenes, kleines Wörterbuch. */
  const laufzeitLabel = (l: string) => t(`verkaufUebersicht.laufzeit.${l}` as TranslationKey);

  return (
    <>
      <section className="sys__block verkauf__kopf">
        <Kennzahl label={t('system.umsatz')} wert={geld(g.umsatz.monatCent, g.waehrung)} />
        <Kennzahl label={t('verkaufUebersicht.zahlend')} wert={String(g.umsatz.zahlend)} />
        <Kennzahl label={t('verkaufUebersicht.inProbe')} wert={String(g.umsatz.inProbe)} />
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><Users size={14} /> {t('verkaufUebersicht.abonnentenNachStatus')}</h3>
        {GUMROAD_STATUS.map((s) => (
          <Zeile key={s} name={statusLabel(s)} wert={g.abonnenten.statusVerteilung[s] ?? 0} />
        ))}
        {g.umsatz.aufteilung.length > 0 && (
          <>
            <Notiz text={t('verkaufUebersicht.aufteilungHinweis')} />
            {g.umsatz.aufteilung.map((a) => (
              <Zeile key={a.laufzeit} name={laufzeitLabel(a.laufzeit)}
                     wert={`${a.anzahl}× · ${geld(a.monatCent, g.waehrung)}`} />
            ))}
          </>
        )}
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><TrendingUp size={14} /> {t('verkaufUebersicht.verlauf')}</h3>
        {g.verlauf.length === 0 ? <Notiz text={t('verkaufUebersicht.verlaufLeer')} /> : (
          <Balkenreihe eintraege={g.verlauf.map((v) => ({
            label: monatLabel(v.monat), wert: v.nettoCent, text: geld(v.nettoCent, g.waehrung),
          }))} />
        )}
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><ArrowUpRight size={14} /> {t('verkaufUebersicht.zuAbgaenge')}</h3>
        {g.zuAbgaenge.length === 0 ? <Notiz text={t('verkaufUebersicht.verlaufLeer')} /> : g.zuAbgaenge.map((z) => (
          <Zeile key={z.monat} name={monatLabel(z.monat)}
                 wert={`+${z.neu} · -${z.abgang}`} ton={z.abgang > z.neu ? 'warn' : undefined} />
        ))}
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><ArrowDownRight size={14} /> {t('verkaufUebersicht.erstattungenTitel')}</h3>
        <Zeile name={t('verkaufUebersicht.erstattet')}
               wert={`${g.erstattungen.anzahl} · ${geld(g.erstattungen.betragCent, g.waehrung)}`} />
        {g.erstattungen.teilweise > 0 && (
          <Zeile name={t('verkaufUebersicht.teilweiseErstattet')} wert={String(g.erstattungen.teilweise)} />
        )}
        <Zeile name={t('verkaufUebersicht.angefochten')}
               wert={`${g.anfechtungen.anzahl} · ${geld(g.anfechtungen.betragCent, g.waehrung)}`} />
        <Zeile name={t('verkaufUebersicht.rueckgebucht')}
               wert={`${g.rueckbuchungen.anzahl} · ${geld(g.rueckbuchungen.betragCent, g.waehrung)}`}
               ton={g.rueckbuchungen.anzahl > 0 ? 'warn' : undefined} />
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><Repeat size={14} /> {t('verkaufUebersicht.artTitel')}</h3>
        <Zeile name={t('verkaufUebersicht.einmalig')}
               wert={`${g.einmalig.anzahl} · ${geld(g.einmalig.bruttoCent, g.waehrung)}`} />
        <Zeile name={t('verkaufUebersicht.wiederkehrend')}
               wert={`${g.wiederkehrend.anzahl} · ${geld(g.wiederkehrend.bruttoCent, g.waehrung)}`} />
        {(g.einmalig.anzahl + g.wiederkehrend.anzahl) > 0 && (
          <Zeile name={t('verkaufUebersicht.wiederkehrendAnteil')}
                 wert={prozent(g.wiederkehrend.anzahl / (g.einmalig.anzahl + g.wiederkehrend.anzahl))} />
        )}
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><ReceiptText size={14} /> {t('verkaufUebersicht.auszahlungenTitel')}</h3>
        {g.auszahlungen.length === 0 ? <Notiz text={t('verkaufUebersicht.auszahlungenLeer')} /> : g.auszahlungen.map((a) => (
          <Zeile key={`${a.status}-${a.waehrung}`} name={`${a.status} · ${a.waehrung ?? '—'}`}
                 wert={`${a.anzahl} · ${a.summeRoh.toLocaleString(currentUiLanguage())}`} />
        ))}
      </section>
    </>
  );
}

function PatreonAbschnitt({ p, verlauf, t }: {
  p: PatreonKennzahlen; verlauf: PatreonMomentaufnahme[]; t: ReturnType<typeof useT>;
}) {
  return (
    <>
      <section className="sys__block verkauf__kopf">
        <Kennzahl label={t('verkaufUebersicht.patreonAktiv')} wert={String(p.aktiveUnterstuetzer)} />
        <Kennzahl label={t('verkaufUebersicht.patreonEinnahmen')} wert={geld(p.monatlicheEinnahmenCents, p.waehrung)} />
        <Kennzahl label={t('verkaufUebersicht.patreonNeu')} wert={String(p.neuDiesenMonat)} />
      </section>
      <section className="sys__block">
        <h3 className="sys__titel"><Users size={14} /> {t('verkauf.patreonUeberschrift')}</h3>
        <Zeile name={t('verkaufUebersicht.patreonDeklination')} wert={p.deklinierteUnterstuetzer} />
        <Zeile name={t('verkaufUebersicht.patreonEhemalig')} wert={p.ehemaligeUnterstuetzer} />
        <Zeile name={t('verkaufUebersicht.patreonFollower')} wert={p.follower} />
      </section>
      <section className="sys__block">
        <h3 className="sys__titel"><TrendingUp size={14} /> {t('verkaufUebersicht.verlauf')}</h3>
        {verlauf.length < 2 ? <Notiz text={t('verkaufUebersicht.patreonVerlaufLeer')} /> : (
          <Balkenreihe eintraege={verlauf.map((v) => ({
            label: monatLabel(v.tag.slice(0, 7)), wert: v.aktive, text: `${v.aktive}`,
          }))} />
        )}
      </section>
    </>
  );
}

export function VerkaufDetailPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [daten, setDaten] = useState<{
    gumroad: GumroadUebersicht | null; patreon: PatreonKennzahlen | null; patreonVerlauf: PatreonMomentaufnahme[];
  } | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    let eigenerLauf = true;
    api.verkaufUebersicht()
      .then((w) => { if (eigenerLauf) { setDaten(w); setFehler(null); } })
      .catch((f: Error) => { if (eigenerLauf) setFehler(f.message); });
    return () => { eigenerLauf = false; };
  }, []);

  const inhalt = () => {
    if (fehler) return <div className="sys__leer"><AlertTriangle size={15} /> {fehler}</div>;
    if (!daten) return <div className="sys__leer"><Loader2 size={16} className="dreht" /></div>;
    if (!daten.gumroad && !daten.patreon) {
      return <div className="sys__leer">{t('verkaufUebersicht.leer')}</div>;
    }
    return (
      <div className="sys verkauf__detail">
        {daten.gumroad && <GumroadAbschnitt g={daten.gumroad} t={t} />}
        {daten.patreon && <PatreonAbschnitt p={daten.patreon} verlauf={daten.patreonVerlauf} t={t} />}
      </div>
    );
  };

  return (
    <Shell title={t('verkaufUebersicht.titel')} icon={<Banknote size={16} />} onClose={onClose} width={620}>
      {inhalt()}
    </Shell>
  );
}
