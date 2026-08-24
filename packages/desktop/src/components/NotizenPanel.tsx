import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Eye, Loader2, NotebookPen, Pencil, Plus, Search,
  Trash2, UserMinus, UserPlus, Users,
} from 'lucide-react';
import type { Notiz } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { Markdown } from './Markdown.jsx';
import { Shell } from './Panels.jsx';
import { clsx, relativeTime } from '../lib/format.js';
import {
  notizErstellen, notizLoeschen, notizMitgliedEntfernen, notizMitgliedHinzufuegen,
  notizSpeichern, notizenAnfordern, type NotizKlartext,
} from '../lib/notizen.js';
import '../styles/notizen.css';

/**
 * Die Notizen-Tafel.
 *
 * Verschlüsselt wie ein vertraulicher Kanal (siehe lib/notizen.ts), aber als
 * eigener Reiter: eine Liste eigener Schriftstücke statt eines
 * Nachrichtenstroms. Was hier bewusst NICHT passiert: eine eigene
 * Verschlüsselung. Alles Kryptografische steht in lib/notizen.ts und nutzt
 * dieselben Bausteine wie lib/vertraulich.ts.
 */
export function NotizenPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const self = useStore((s) => s.self);
  const users = useStore((s) => s.users);
  const notizen = useStore((s) => s.notizen);
  const notizenKlartext = useStore((s) => s.notizenKlartext);
  const notizenSchluesselFehlt = useStore((s) => s.notizenSchluesselFehlt);
  const notizenGeladen = useStore((s) => s.notizenGeladen);

  const [ausgewaehlteId, setAusgewaehlteId] = useState<string | null>(null);
  const [suche, setSuche] = useState('');
  const [legtAn, setLegtAn] = useState(false);
  const [loeschenLaeuft, setLoeschenLaeuft] = useState<string | null>(null);

  useEffect(() => { notizenAnfordern(); }, []);

  const liste = useMemo(() => {
    const q = suche.trim().toLowerCase();
    return Object.values(notizen)
      .filter((n) => {
        if (!q) return true;
        const klar = notizenKlartext[n.id];
        // Ungeöffnete (noch nicht entschlüsselte) Notizen fallen aus der
        // Suche heraus statt falsch positiv zu treffen — siehe DIE FALLEN,
        // Punkt 3: gesucht wird ausschließlich über das, was dieses Gerät
        // schon selbst gelesen hat, nie über einen Index auf dem Server.
        if (!klar) return false;
        return klar.titel.toLowerCase().includes(q) || klar.text.toLowerCase().includes(q);
      })
      .sort((a, b) => b.geaendertAm - a.geaendertAm);
  }, [notizen, notizenKlartext, suche]);

  useEffect(() => {
    if (ausgewaehlteId && !notizen[ausgewaehlteId]) setAusgewaehlteId(null);
  }, [ausgewaehlteId, notizen]);

  const anlegen = async () => {
    setLegtAn(true);
    try {
      const notiz = await notizErstellen('', '');
      setAusgewaehlteId(notiz.id);
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('notizen.fehlerAnlegen'), body: (fehler as Error).message });
    } finally {
      setLegtAn(false);
    }
  };

  const loeschen = async (notizId: string) => {
    notizLoeschen(notizId);
    if (ausgewaehlteId === notizId) setAusgewaehlteId(null);
    setLoeschenLaeuft(null);
  };

  const ausgewaehlt = ausgewaehlteId ? notizen[ausgewaehlteId] : null;

  return (
    <Shell
      title={t('notizen.titel')}
      subtitle={t('notizen.untertitel')}
      icon={<NotebookPen size={18} />}
      onClose={onClose}
      width={980}
      actions={
        <button className="pill pill--accent" onClick={() => void anlegen()} disabled={legtAn}>
          {legtAn ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
          {t('notizen.neu')}
        </button>
      }
    >
      <div className="notizen">
        <div className="notizen__liste">
          <div className="files-search" style={{ marginBottom: 'var(--sp-2)' }}>
            <Search size={14} className="muted" />
            <input
              className="input input--bare"
              value={suche}
              placeholder={t('notizen.suchePlatzhalter')}
              onChange={(e) => setSuche(e.target.value)}
            />
          </div>

          {!notizenGeladen && (
            <div className="hstack gap-2" style={{ padding: 'var(--sp-4) 0', justifyContent: 'center' }}>
              <Loader2 size={16} className="spin muted" />
            </div>
          )}

          {notizenGeladen && !liste.length && (
            <div className="empty-state">
              <NotebookPen size={26} className="muted" />
              <p>{t(suche ? 'notizen.keineTreffer' : 'notizen.leer')}</p>
            </div>
          )}

          {liste.map((n) => {
            const klar = notizenKlartext[n.id];
            const eigene = n.ownerId === self?.id;
            return (
              <button
                key={n.id}
                className="result"
                data-active={n.id === ausgewaehlteId}
                onClick={() => setAusgewaehlteId(n.id)}
              >
                <div className="result__main">
                  <div className="notizen-row__titel">
                    <span className="result__title truncate">
                      {klar
                        ? (klar.titel.trim() || t('notizen.ohneTitel'))
                        : t(notizenSchluesselFehlt[n.id] ? 'notizen.schluesselFehlt' : 'notizen.wirdEntschluesselt')}
                    </span>
                    {!klar && notizenSchluesselFehlt[n.id] && (
                      <AlertTriangle size={12} style={{ flex: 'none', color: 'var(--amber)' }} />
                    )}
                  </div>
                  <div className="result__sub truncate">
                    {!eigene && users[n.ownerId] && `${users[n.ownerId].displayName} · `}
                    {relativeTime(n.geaendertAm)}
                    {n.memberIds.length > 0 && ` · ${t('notizen.geteiltMitN', { n: n.memberIds.length })}`}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="notizen__editor">
          {!ausgewaehlt && (
            <div className="empty-state" style={{ height: '100%' }}>
              <NotebookPen size={32} className="muted" />
              <p>{t('notizen.keineAusgewaehlt')}</p>
            </div>
          )}
          {ausgewaehlt && (
            <NotizEditor
              key={ausgewaehlt.id}
              notiz={ausgewaehlt}
              onLoeschenAnfragen={() => setLoeschenLaeuft(ausgewaehlt.id)}
            />
          )}
        </div>
      </div>

      {loeschenLaeuft && (
        <div className="scrim scrim--center" onClick={() => setLoeschenLaeuft(null)}>
          <div className="panel" style={{ width: 'min(420px, 100%)' }} onClick={(e) => e.stopPropagation()}>
            <div className="panel__head">
              <AlertTriangle size={18} style={{ color: 'var(--rose)' }} />
              <h2>{t('notizen.loeschenTitel')}</h2>
            </div>
            <div className="panel__body">
              <p className="muted" style={{ marginTop: 0 }}>{t('notizen.loeschenText')}</p>
              <div className="hstack gap-2" style={{ marginTop: 'var(--sp-3)' }}>
                <button className="btn btn--danger" onClick={() => void loeschen(loeschenLaeuft)}>
                  <Trash2 size={15} /> {t('notizen.loeschenJa')}
                </button>
                <button className="btn btn--ghost" onClick={() => setLoeschenLaeuft(null)}>{t('common.cancel')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ── Der Editor für eine einzelne Notiz ───────────────────────── */

function NotizEditor({ notiz, onLoeschenAnfragen }: { notiz: Notiz; onLoeschenAnfragen: () => void }) {
  const t = useT();
  const self = useStore((s) => s.self);
  const users = useStore((s) => s.users);
  // Sobald ein Konflikt ansteht, trägt derselbe Klartext bereits den fremden,
  // aktuellen Serverstand — siehe lib/notizen.ts, case 'notiz:konflikt'.
  const klartext = useStore((s) => s.notizenKlartext[notiz.id]);
  const schluesselFehlt = useStore((s) => s.notizenSchluesselFehlt[notiz.id] ?? false);
  const konflikt = useStore((s) => s.notizKonflikte[notiz.id]);

  const [titel, setTitel] = useState(klartext?.titel ?? '');
  const [text, setText] = useState(klartext?.text ?? '');
  const [vorschau, setVorschau] = useState(false);
  const [speichert, setSpeichert] = useState(false);
  const [mitgliedOffen, setMitgliedOffen] = useState(false);
  const [mitgliedSuche, setMitgliedSuche] = useState('');
  const [entfernenLaeuft, setEntfernenLaeuft] = useState<string | null>(null);

  const eigenePuffer = useRef({ titel, text });
  eigenePuffer.current = { titel, text };
  const timerRef = useRef<number | null>(null);
  // Erst befüllt, sobald der Klartext das erste Mal da ist — vorher stünde
  // sonst ein leerer Puffer, der beim nächsten Tastendruck als „geändert"
  // gälte und einen leeren Stand über einen noch unentschlüsselten schriebe.
  const befuellt = useRef(Boolean(klartext));

  useEffect(() => {
    if (befuellt.current || !klartext) return;
    befuellt.current = true;
    setTitel(klartext.titel);
    setText(klartext.text);
  }, [klartext]);

  const speichereJetzt = (force = false) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!befuellt.current) return;
    const { titel: t2, text: t3 } = eigenePuffer.current;
    setSpeichert(true);
    void notizSpeichern(notiz.id, t2, t3, force).finally(() => setSpeichert(false));
  };

  // Beim Wechsel zu einer anderen Notiz oder beim Schließen der Tafel sofort
  // sichern, statt auf den Zeitgeber zu warten — eine Notiz, die man beim
  // Wegklicken verliert, ist wertlos.
  useEffect(() => () => { if (timerRef.current) speichereJetzt(); }, [notiz.id]);

  const geaendert = (neu: { titel?: string; text?: string }) => {
    if (neu.titel !== undefined) setTitel(neu.titel);
    if (neu.text !== undefined) setText(neu.text);
    if (timerRef.current) clearTimeout(timerRef.current);
    // Gesammelt, nicht bei jedem Tastenanschlag zum Server funken.
    timerRef.current = window.setTimeout(speichereJetzt, 900);
  };

  const darfVerwalten = notiz.ownerId === self?.id;
  const kandidaten = Object.values(users)
    .filter((u) => !u.disabled && !u.technisch && u.id !== notiz.ownerId && !notiz.memberIds.includes(u.id))
    .filter((u) => !mitgliedSuche
      || u.displayName.toLowerCase().includes(mitgliedSuche.toLowerCase())
      || u.handle.toLowerCase().includes(mitgliedSuche.toLowerCase()))
    .slice(0, 8);

  const hinzufuegen = async (userId: string) => {
    try {
      await notizMitgliedHinzufuegen(notiz.id, userId);
      setMitgliedSuche('');
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('notizen.fehlerHinzufuegen'), body: (fehler as Error).message });
    }
  };

  const entfernen = async (userId: string) => {
    setEntfernenLaeuft(userId);
    try {
      await notizMitgliedEntfernen(notiz.id, userId);
    } catch (fehler) {
      useStore.getState().toast({ kind: 'error', title: t('notizen.fehlerEntfernen'), body: (fehler as Error).message });
    } finally {
      setEntfernenLaeuft(null);
    }
  };

  const geaendertVonName = users[notiz.geaendertVon]?.displayName ?? '—';

  if (!klartext) {
    // Zwei ganz unterschiedliche Zustände hinter demselben leeren Klartext:
    // kurz nach dem Laden ist ein fehlender Schlüssel der Normalfall (siehe
    // lib/notizen.ts, decodiereUndSpeichere) — danach, wenn
    // schluesselWartenStarten() seine Frist erreicht hat, ohne dass ein
    // anderes Gerät geantwortet hätte, ist es das nicht mehr. Ein Kreisel,
    // der ewig dreht, wäre hier die unehrlichere der beiden Anzeigen (siehe
    // protocolFehler in state/store.ts für denselben Gedanken).
    if (schluesselFehlt) {
      return (
        <div className="empty-state" style={{ height: '100%' }}>
          <AlertTriangle size={22} className="muted" style={{ color: 'var(--amber)' }} />
          <p>{t('notizen.schluesselFehlt')}</p>
          <p className="muted" style={{ fontSize: 12.5, maxWidth: 360, textAlign: 'center' }}>
            {t('notizen.schluesselFehltText')}
          </p>
        </div>
      );
    }
    return (
      <div className="empty-state" style={{ height: '100%' }}>
        <Loader2 size={22} className="spin muted" />
        <p>{t('notizen.wirdEntschluesselt')}</p>
      </div>
    );
  }

  return (
    <>
      <input
        className="notizen__titel-feld"
        value={titel}
        placeholder={t('notizen.titelPlatzhalter')}
        onChange={(e) => geaendert({ titel: e.target.value })}
        onBlur={() => speichereJetzt()}
      />

      {konflikt && (
        <div className="hinweis" style={{ marginBottom: 'var(--sp-3)', alignItems: 'flex-start', borderColor: 'rgba(251,191,36,.4)', background: 'rgba(251,191,36,.12)' }}>
          <AlertTriangle size={14} style={{ flex: 'none', marginTop: 2, color: 'var(--amber)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('notizen.konfliktTitel')}</div>
            <div style={{ fontSize: 12.5, opacity: 0.9 }}>
              {t('notizen.konfliktText', { name: users[konflikt.geaendertVon]?.displayName ?? '—' })}
            </div>
            <div className="hstack gap-2" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <button
                className="btn"
                onClick={() => {
                  const aktuell = useStore.getState().notizenKlartext[notiz.id];
                  if (aktuell) { setTitel(aktuell.titel); setText(aktuell.text); }
                  useStore.setState((s) => {
                    const notizKonflikte = { ...s.notizKonflikte }; delete notizKonflikte[notiz.id];
                    return { notizKonflikte };
                  });
                }}
              >
                {t('notizen.konfliktUebernehmen')}
              </button>
              <button className="btn btn--danger" onClick={() => speichereJetzt(true)}>
                {t('notizen.konfliktUeberschreiben')}
              </button>
            </div>
          </div>
        </div>
      )}

      {vorschau ? (
        <div className="notizen__md">
          {text.trim()
            ? <Markdown text={text} />
            : <p className="muted">{t('notizen.leerVorschau')}</p>}
        </div>
      ) : (
        <textarea
          className="notizen__text-feld"
          value={text}
          placeholder={t('notizen.textPlatzhalter')}
          onChange={(e) => geaendert({ text: e.target.value })}
          onBlur={() => speichereJetzt()}
        />
      )}

      <div className="notizen__werkzeuge">
        <button className={clsx('pill', !vorschau && 'pill--accent')} onClick={() => setVorschau(false)}>
          <Pencil size={13} /> {t('notizen.bearbeiten')}
        </button>
        <button className={clsx('pill', vorschau && 'pill--accent')} onClick={() => setVorschau(true)}>
          <Eye size={13} /> {t('notizen.vorschau')}
        </button>

        <span className="muted" style={{ fontSize: 11.5, marginInlineStart: 'auto' }}>
          {speichert
            ? <><Loader2 size={11} className="spin" style={{ verticalAlign: -1, marginInlineEnd: 4 }} />{t('notizen.speichertGerade')}</>
            : t('notizen.geaendertVon', { name: geaendertVonName, zeit: relativeTime(notiz.geaendertAm) })}
        </span>

        <button className={clsx('pill', mitgliedOffen && 'pill--accent')} onClick={() => setMitgliedOffen((v) => !v)}>
          <Users size={13} />
          {t('notizen.zugriff')}{notiz.memberIds.length > 0 ? ` · ${notiz.memberIds.length + 1}` : ''}
        </button>
        <button className="icon-btn icon-btn--danger" title={t('notizen.loeschen')} aria-label={t('notizen.loeschen')} onClick={onLoeschenAnfragen}>
          <Trash2 size={15} />
        </button>
      </div>

      {mitgliedOffen && (
        <div style={{ marginTop: 'var(--sp-3)', paddingTop: 'var(--sp-3)', borderTop: '1px solid var(--line)' }}>
          <div className="ai-section__title">{t('notizen.zugriff')}</div>

          <div className="row">
            <Avatar user={users[notiz.ownerId]} size={26} />
            <div className="row__main" style={{ marginLeft: 10 }}>
              <div className="row__title">{users[notiz.ownerId]?.displayName ?? '—'}</div>
              <div className="row__sub">{t('notizen.besitzt')}</div>
            </div>
          </div>

          {notiz.memberIds.map((uid) => (
            <div className="row" key={uid}>
              <Avatar user={users[uid]} size={26} />
              <div className="row__main" style={{ marginLeft: 10 }}>
                <div className="row__title">{users[uid]?.displayName ?? '—'}</div>
              </div>
              {darfVerwalten && (
                <button
                  className="icon-btn"
                  title={t('notizen.entfernen')}
                  aria-label={t('notizen.entfernen')}
                  disabled={entfernenLaeuft === uid}
                  onClick={() => {
                    if (confirm(t('notizen.entfernenBestaetigen', { name: users[uid]?.displayName ?? '—' }))) {
                      void entfernen(uid);
                    }
                  }}
                >
                  {entfernenLaeuft === uid ? <Loader2 size={14} className="spin" /> : <UserMinus size={15} />}
                </button>
              )}
            </div>
          ))}

          {notiz.ehemaligeMitglieder.length > 0 && (
            <div className="notizen__ehemalige">
              {t('notizen.ehemalige', {
                namen: notiz.ehemaligeMitglieder
                  .map((m) => users[m.userId]?.displayName ?? '—')
                  .join(', '),
              })}
            </div>
          )}

          {darfVerwalten && (
            <div className="field" style={{ marginTop: 'var(--sp-3)' }}>
              <input
                className="input"
                value={mitgliedSuche}
                placeholder={t('notizen.personSuchen')}
                onChange={(e) => setMitgliedSuche(e.target.value)}
              />
              {mitgliedSuche && kandidaten.map((u) => (
                <button key={u.id} className="result" style={{ marginTop: 4 }} onClick={() => void hinzufuegen(u.id)}>
                  <Avatar user={u} size={24} />
                  <div className="result__main">
                    <div className="result__title">{u.displayName}</div>
                    <div className="result__sub">@{u.handle}</div>
                  </div>
                  <UserPlus size={15} className="muted" />
                </button>
              ))}
            </div>
          )}

          <p className="field__hint" style={{ marginTop: 'var(--sp-3)' }}>{t('notizen.entfernenHinweis')}</p>
        </div>
      )}
    </>
  );
}
