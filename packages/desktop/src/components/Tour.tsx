import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, BarChart3, Bell, Bot, Check, Forward, Hash,
  Languages, Mic, Search, Settings2, ShieldCheck, Sparkles, Star, Users, X,
} from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import type { TranslationKey } from '../i18n/index.js';

/**
 * Einführung beim allerersten Login.
 *
 * Bewusst keine Klick-für-Klick-Führung durch die echte Oberfläche: die würde
 * bei jeder Layoutänderung brechen. Stattdessen erklärt jede Karte eine
 * Funktion mit einer kleinen Vorführung daneben — schnell zu überspringen und
 * jederzeit über die Einstellungen wieder aufrufbar.
 */

const SPEICHER = 'stellium.tourGesehen';

export function tourBereitsGesehen(): boolean {
  return localStorage.getItem(SPEICHER) === 'ja';
}

export function tourAlsGesehenMerken(): void {
  localStorage.setItem(SPEICHER, 'ja');
}

export function tourZuruecksetzen(): void {
  localStorage.removeItem(SPEICHER);
}

interface Schritt {
  id: string;
  icon: React.ReactNode;
  titel: TranslationKey;
  text: TranslationKey;
  vorfuehrung: React.ReactNode;
}

/* ── Kleine Vorführungen ──────────────────────────────────────── */

const wiegen = { duration: 2.4, repeat: Infinity, ease: 'easeInOut' as const };

function VorfuehrungUebersetzung() {
  return (
    <div className="tour-demo">
      <motion.div className="tour-bubble" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}>
        <span className="tour-bubble__name">Yuki 🇯🇵</span>
        <span>会議は明日の10時からです。</span>
      </motion.div>
      <motion.div className="tour-arrow"
        animate={{ opacity: [0.3, 1, 0.3] }} transition={wiegen}>
        <Languages size={16} />
      </motion.div>
      <motion.div className="tour-bubble tour-bubble--out"
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.5 }}>
        <span className="tour-bubble__name">für dich 🇩🇪</span>
        <span>Das Meeting ist morgen um 10 Uhr.</span>
      </motion.div>
    </div>
  );
}

function VorfuehrungKi() {
  return (
    <div className="tour-demo">
      <div className="tour-bubble"><span className="tour-bubble__name">du</span><span>Was habe ich verpasst?</span></div>
      <motion.div className="tour-bubble tour-bubble--ki"
        animate={{ opacity: [0.55, 1, 0.55] }} transition={wiegen}>
        <span className="tour-bubble__name"><Bot size={11} /> Stellium KI</span>
        <span>Drei Punkte: Release verschoben, Marta braucht Rückmeldung, Kaffee um 15 Uhr.</span>
      </motion.div>
    </div>
  );
}

function VorfuehrungSprache() {
  return (
    <div className="tour-demo tour-demo--mitte">
      <div className="tour-welle">
        {Array.from({ length: 22 }, (_, i) => (
          <motion.span key={i}
            animate={{ scaleY: [0.25, 0.4 + Math.abs(Math.sin(i * 0.9)) * 0.75, 0.25] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.045, ease: 'easeInOut' }} />
        ))}
      </div>
      <div className="tour-bubble tour-bubble--out" style={{ marginTop: 12 }}>
        <span className="tour-bubble__name">Transkript, übersetzt</span>
        <span>„Ich schaue mir das nachher an."</span>
      </div>
    </div>
  );
}

function VorfuehrungUmfrage() {
  const werte = [0.75, 0.35, 0.15];
  return (
    <div className="tour-demo tour-demo--mitte">
      <div className="tour-umfrage">
        <div className="tour-umfrage__frage">Wann machen wir das Team-Meeting?</div>
        {['Montag 10:00', 'Mittwoch 14:00', 'Freitag 09:00'].map((o, i) => (
          <div className="tour-umfrage__zeile" key={o}>
            <motion.span className="tour-umfrage__balken"
              initial={{ width: 0 }} animate={{ width: `${werte[i] * 100}%` }}
              transition={{ duration: 0.8, delay: 0.2 + i * 0.15, ease: [0.16, 1, 0.3, 1] }} />
            <span className="tour-umfrage__text">{o}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VorfuehrungRechte() {
  const rollen = [
    { name: 'Inhaber', anteil: 1 },
    { name: 'Moderation', anteil: 0.81 },
    { name: 'Mitglied', anteil: 0.55 },
    { name: 'Gast', anteil: 0.18 },
  ];
  return (
    <div className="tour-demo tour-demo--mitte">
      <div className="tour-rollen">
        {rollen.map((r, i) => (
          <div className="tour-rollen__zeile" key={r.name}>
            <span className="tour-rollen__name">{r.name}</span>
            <span className="tour-rollen__spur">
              <motion.span className="tour-rollen__fuellung"
                initial={{ width: 0 }} animate={{ width: `${r.anteil * 100}%` }}
                transition={{ duration: 0.7, delay: 0.15 * i, ease: [0.16, 1, 0.3, 1] }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VorfuehrungSuche() {
  return (
    <div className="tour-demo tour-demo--mitte">
      <motion.div className="tour-suche"
        animate={{ boxShadow: ['0 0 0 0 rgba(124,92,255,0)', '0 0 0 4px rgba(124,92,255,.18)', '0 0 0 0 rgba(124,92,255,0)'] }}
        transition={wiegen}>
        <Search size={14} />
        <span>latency</span>
      </motion.div>
      <div className="tour-treffer">
        <span className="tour-treffer__zeile">p95 <em>latency</em> dropped from 240ms…</span>
        <span className="tour-treffer__zeile">…auch in Übersetzungen gefunden</span>
      </div>
    </div>
  );
}

function VorfuehrungOrdnung() {
  return (
    <div className="tour-demo tour-demo--mitte">
      <div className="tour-kacheln">
        {[
          { icon: <Forward size={14} />, text: 'Weiterleiten' },
          { icon: <Bell size={14} />, text: 'Erinnern' },
          { icon: <Star size={14} />, text: 'Anheften' },
          { icon: <Hash size={14} />, text: 'Kanal verlinken' },
        ].map((k, i) => (
          <motion.span key={k.text} className="tour-kachel"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 * i, duration: 0.35 }}>
            {k.icon}{k.text}
          </motion.span>
        ))}
      </div>
    </div>
  );
}

/* ── Die Tour ─────────────────────────────────────────────────── */

const SCHRITTE: Schritt[] = [
  { id: 'willkommen', icon: <Star size={20} />, titel: 'tour.welcomeTitle', text: 'tour.welcomeText',
    vorfuehrung: <VorfuehrungUebersetzung /> },
  { id: 'sprache', icon: <Languages size={20} />, titel: 'tour.translationTitle', text: 'tour.translationText',
    vorfuehrung: <VorfuehrungUebersetzung /> },
  { id: 'ki', icon: <Bot size={20} />, titel: 'tour.aiTitle', text: 'tour.aiText',
    vorfuehrung: <VorfuehrungKi /> },
  { id: 'stimme', icon: <Mic size={20} />, titel: 'tour.voiceTitle', text: 'tour.voiceText',
    vorfuehrung: <VorfuehrungSprache /> },
  { id: 'umfrage', icon: <BarChart3 size={20} />, titel: 'tour.pollTitle', text: 'tour.pollText',
    vorfuehrung: <VorfuehrungUmfrage /> },
  { id: 'ordnung', icon: <Sparkles size={20} />, titel: 'tour.organiseTitle', text: 'tour.organiseText',
    vorfuehrung: <VorfuehrungOrdnung /> },
  { id: 'suche', icon: <Search size={20} />, titel: 'tour.searchTitle', text: 'tour.searchText',
    vorfuehrung: <VorfuehrungSuche /> },
  { id: 'kanal', icon: <Settings2 size={20} />, titel: 'tour.channelTitle', text: 'tour.channelText',
    vorfuehrung: <VorfuehrungOrdnung /> },
  { id: 'rechte', icon: <ShieldCheck size={20} />, titel: 'tour.rolesTitle', text: 'tour.rolesText',
    vorfuehrung: <VorfuehrungRechte /> },
  { id: 'fertig', icon: <Check size={20} />, titel: 'tour.doneTitle', text: 'tour.doneText',
    vorfuehrung: <VorfuehrungKi /> },
];

export function Tour({ onClose }: { onClose: () => void }) {
  const t = useT();
  const self = useStore((s) => s.self);
  const [i, setI] = useState(0);
  const [richtung, setRichtung] = useState(1);

  const schritt = SCHRITTE[i];
  const letzter = i === SCHRITTE.length - 1;

  // Nur Rollen zeigen, wer sie auch vergeben kann.
  const sichtbar = SCHRITTE.filter((s) =>
    s.id !== 'rechte' || Boolean(self?.permissions['user.manage']));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); weiter(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); zurueck(); }
      if (e.key === 'Escape') { e.preventDefault(); beenden(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const weiter = () => {
    if (i >= sichtbar.length - 1) { beenden(); return; }
    setRichtung(1);
    setI((v) => Math.min(v + 1, sichtbar.length - 1));
  };
  const zurueck = () => { setRichtung(-1); setI((v) => Math.max(0, v - 1)); };
  const beenden = () => { tourAlsGesehenMerken(); onClose(); };

  const aktuell = sichtbar[Math.min(i, sichtbar.length - 1)];

  return (
    <div className="scrim scrim--center tour-scrim">
      <motion.div className="tour"
        initial={{ opacity: 0, scale: 0.96, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 14 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>

        <button className="icon-btn tour__skip" onClick={beenden} title={t('tour.skip')}>
          <X size={16} />
        </button>

        <div className="tour__buehne">
          <AnimatePresence mode="wait" custom={richtung}>
            <motion.div key={aktuell.id} className="tour__inhalt"
              custom={richtung}
              initial={{ opacity: 0, x: richtung * 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: richtung * -40 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}>

              <motion.div className="tour__icon"
                initial={{ scale: 0.6, rotate: -12 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 220, damping: 16 }}>
                {aktuell.icon}
              </motion.div>

              <h2 className="tour__titel">{t(aktuell.titel)}</h2>
              <p className="tour__text">{t(aktuell.text)}</p>

              <div className="tour__demo">{aktuell.vorfuehrung}</div>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="tour__fuss">
          <button className="btn btn--ghost" onClick={beenden}>{t('tour.skip')}</button>

          <div className="tour__punkte">
            {sichtbar.map((s, n) => (
              <button key={s.id}
                className={`tour__punkt${n === i ? ' tour__punkt--an' : ''}`}
                onClick={() => { setRichtung(n > i ? 1 : -1); setI(n); }}
                title={t(s.titel)} />
            ))}
          </div>

          <div className="hstack gap-2">
            {i > 0 && (
              <button className="btn" onClick={zurueck}><ArrowLeft size={15} /> {t('tour.back')}</button>
            )}
            <button className="btn btn--primary" onClick={weiter}>
              {letzter || i === sichtbar.length - 1 ? t('tour.start') : t('tour.next')}
              {!(letzter || i === sichtbar.length - 1) && <ArrowRight size={15} />}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
