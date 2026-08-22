/**
 * Briefpartner nach Gruppe — Kunden, Firmen, Lieferanten, Bewerber, Behörden,
 * Sonstige.
 *
 * EIGENSTÄNDIG, GENAU EINE EINTRITTSSTELLE
 *
 * `components/PostPanel.tsx` ist gerade in fremder Hand (siehe die Aufgabe)
 * — diese Tafel hängt sich deshalb nirgends dort ein. Sie holt ihre Daten
 * selbst (eigener kleiner Ersatz für `request()` aus net/api.ts, genau wie
 * PostPanel.tsx es für sich selbst schon vormacht, aus demselben Grund: die
 * eine Datei, die beide bräuchten, wird gerade woanders bearbeitet), zeigt
 * sich selbst als eigenes Fenster (`Shell`, wie jedes andere Fenster im
 * Haus) und braucht nur EINE Zeile, um zu erscheinen — siehe
 * state/partnergruppen.ts für die Tür (offen/öffnen/schließen) und den
 * Bericht am Ende der Aufgabe für die genaue Stelle in Rail.tsx und
 * App.tsx.
 *
 * Wer stattdessen die Gruppe direkt neben einer geöffneten Mail sehen will
 * (in PostPanel.tsx), kann optional `<PartnerGruppenBadge adresse={...} />`
 * einhängen (weiter unten, ebenfalls hier exportiert) — das ist ein
 * Bonus-Einstiegspunkt für später, keine Voraussetzung: diese Tafel hier
 * deckt "Gruppe je Briefpartner, änderbar", "Vorschlag erkennbar" und "nach
 * Gruppe filtern" bereits vollständig ab, unabhängig davon, ob die Badge
 * irgendwo eingehängt wird.
 *
 * FESTE GRUPPEN
 *
 * `PARTNER_GRUPPEN` kommt aus @stellium/shared — derselbe feste
 * Sechser-Grundstock, den auch der Server für seinen Vorschlag verwendet
 * (siehe packages/shared/src/types.ts für die Begründung "fest, nicht
 * frei"). Die Beschriftung je Gruppe steht im Wörterbuch
 * (`partnerGruppen.gruppe.<schlüssel>`), damit sie in allen 22 Sprachen
 * vorliegt wie jeder andere Text auch.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Users } from 'lucide-react';
import type { MailPartner, PartnerGruppe } from '@stellium/shared';
import { PARTNER_GRUPPEN } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { t as tStatisch, useT, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { ApiError, serverUrl, token } from '../net/api.js';
import { clsx, relativeTime } from '../lib/format.js';

/* ── Abruf — eigener, kleiner Ersatz für request() aus net/api.ts ────
   Siehe Dateikopf: net/api.ts wird an anderer Stelle bearbeitet, und diese
   Tafel soll die Datei nicht anfassen müssen. Spiegelt nur, was sie braucht
   — Basisadresse, Anmeldenachweis, das Lesen von `code`/`error` aus einer
   Fehlerantwort — damit vorhandene Übersetzungen für Fehlerkennungen (etwa
   'fehler.unbekannteGruppe' aus routes.ts) auch hier greifen. */
async function partnerFetch<T>(pfad: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set('content-type', 'application/json');
  const nachweis = token();
  if (nachweis) headers.set('authorization', `Bearer ${nachweis}`);

  let antwort: Response;
  try {
    antwort = await fetch(`${serverUrl()}${pfad}`, { ...init, headers });
  } catch {
    throw new ApiError(tStatisch('api.serverUnreachable', { adresse: serverUrl() }), 0);
  }

  if (!antwort.ok) {
    let message = tStatisch('api.error', { status: antwort.status });
    let code: string | undefined;
    try {
      const rumpf = await antwort.json() as { error?: string; code?: string };
      message = rumpf.error ?? message;
      code = rumpf.code;
    } catch { /* keine JSON-Antwort */ }
    if (code) {
      const uebersetzt = tStatisch(code as TranslationKey);
      if (uebersetzt && uebersetzt !== code) message = uebersetzt;
    }
    throw new ApiError(message, antwort.status, code);
  }
  return antwort.status === 204 ? (undefined as T) : ((await antwort.json()) as T);
}

async function partnerHolen(filter: { gruppe?: string; nurVorschlaege?: boolean }): Promise<{ partner: MailPartner[]; offen: number }> {
  const qs = new URLSearchParams();
  if (filter.gruppe) qs.set('gruppe', filter.gruppe);
  if (filter.nurVorschlaege) qs.set('nurVorschlaege', '1');
  const anhang = qs.toString();
  return partnerFetch<{ partner: MailPartner[]; offen: number }>(`/api/post/partner${anhang ? `?${anhang}` : ''}`);
}

async function gruppeSpeichern(adresse: string, gruppe: PartnerGruppe | null): Promise<{ partner: MailPartner }> {
  return partnerFetch<{ partner: MailPartner }>('/api/post/partner/gruppe', {
    method: 'POST', body: JSON.stringify({ adresse, gruppe }),
  });
}

/* ── Die Tafel ─────────────────────────────────────────────────── */

type Filter = 'alle' | 'ohne' | 'vorschlaege' | PartnerGruppe;

export function PartnerGruppenPanel({ onClose }: { onClose: () => void }) {
  const t = useT();

  const [filter, setFilter] = useState<Filter>('alle');
  const [partner, setPartner] = useState<MailPartner[] | null>(null);
  const [offen, setOffen] = useState(0);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = async () => {
    setLaedt(true); setFehler(null);
    try {
      const antwort = await partnerHolen({
        gruppe: filter !== 'alle' && filter !== 'ohne' && filter !== 'vorschlaege' ? filter : undefined,
        nurVorschlaege: filter === 'vorschlaege',
      });
      // "Ohne Gruppe" filtert die Tafel selbst — der Server kennt nur "eine
      // bestimmte Gruppe" oder "alle", nicht deren Verneinung.
      setPartner(filter === 'ohne' ? antwort.partner.filter((p) => !p.gruppe) : antwort.partner);
      setOffen(antwort.offen);
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setLaedt(false);
    }
  };

  useEffect(() => { void laden(); }, [filter]);

  return (
    <Shell
      title={t('partnerGruppen.titel')}
      subtitle={t('partnerGruppen.untertitel', { n: offen })}
      icon={<Users size={18} />}
      onClose={onClose}
      width={860}
      actions={
        <button className="icon-btn" title={t('partnerGruppen.aktualisieren')} onClick={() => void laden()}>
          <RefreshCw size={15} />
        </button>
      }
    >
      <div className="partnergruppen">
        <div className="partnergruppen__filter">
          {(['alle', 'vorschlaege', 'ohne', ...PARTNER_GRUPPEN] as const).map((f) => (
            <button
              key={f}
              className={clsx('btn btn--sm', filter === f && 'btn--primary')}
              onClick={() => setFilter(f)}
            >
              {f === 'alle' ? t('partnerGruppen.filterAlle')
                : f === 'ohne' ? t('partnerGruppen.filterOhne')
                  : f === 'vorschlaege' ? t('partnerGruppen.filterVorschlaege')
                    : t(`partnerGruppen.gruppe.${f}` as TranslationKey)}
            </button>
          ))}
        </div>

        {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}

        {laedt && !partner && (
          <div className="empty-state">
            <Loader2 size={26} className="spin muted" role="status" aria-label={t('partnerGruppen.laedt')} />
          </div>
        )}

        {!laedt && partner && !partner.length && (
          <div className="empty-state">
            <Users size={26} className="muted" />
            <p>{filter === 'alle' ? t('partnerGruppen.leer') : t('partnerGruppen.leerGefiltert')}</p>
          </div>
        )}

        {!!partner?.length && (
          <div className="partnergruppen__liste">
            <div className="partnergruppen__kopf">
              <span>{t('partnerGruppen.spalteAdresse')}</span>
              <span>{t('partnerGruppen.spalteGruppe')}</span>
              <span>{t('partnerGruppen.spalteSeit')}</span>
            </div>
            {partner.map((p) => (
              <Zeile key={p.adresse} partner={p} onGeaendert={(neu) => {
                setPartner((liste) => liste?.map((x) => (x.adresse === neu.adresse ? neu : x)) ?? liste);
                setOffen((n) => n + (neu.gruppeVonKi ? 0 : (p.gruppeVonKi ? -1 : 0)));
              }}
              />
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Zeile({ partner, onGeaendert }: { partner: MailPartner; onGeaendert: (neu: MailPartner) => void }) {
  const t = useT();
  const darfAendern = useStore((s) => s.self?.permissions['mail.senden']);
  const [speichertGerade, setSpeichertGerade] = useState(false);

  const speichern = async (wert: string) => {
    if (!darfAendern) return;
    setSpeichertGerade(true);
    try {
      const antwort = await gruppeSpeichern(partner.adresse, (wert || null) as PartnerGruppe | null);
      onGeaendert(antwort.partner);
      useStore.getState().toast({ kind: 'ok', title: t('partnerGruppen.gespeichert') });
    } catch (err) {
      useStore.getState().toast({
        kind: 'error', title: t('partnerGruppen.speichernFehlgeschlagen'), body: (err as Error).message,
      });
    } finally {
      setSpeichertGerade(false);
    }
  };

  return (
    <div className="partnergruppen__zeile">
      <span className="partnergruppen__adresse truncate">{partner.adresse}</span>
      <span className="partnergruppen__gruppe-feld">
        <select
          className="select partnergruppen__select"
          value={partner.gruppe ?? ''}
          disabled={!darfAendern || speichertGerade}
          onChange={(e) => void speichern(e.target.value)}
          title={partner.begruendung ? t('partnerGruppen.begruendung', { text: partner.begruendung }) : undefined}
        >
          <option value="">{t('partnerGruppen.keineGruppe')}</option>
          {PARTNER_GRUPPEN.map((g) => (
            <option key={g} value={g}>{t(`partnerGruppen.gruppe.${g}` as TranslationKey)}</option>
          ))}
        </select>
        {/* Ein Vorschlag ist eine Vermutung, keine Tatsache — genau deshalb
            eigens markiert, statt einfach nur als Gruppe angezeigt zu
            werden. Auswählen desselben oder eines anderen Werts bestätigt
            oder ändert ihn (siehe gruppeSetzen() auf dem Server). */}
        {partner.gruppeVonKi && (
          <span className="pill partnergruppen__vorschlag" title={t('partnerGruppen.vorschlagHinweis')}>
            {t('partnerGruppen.vorschlagBadge')}
          </span>
        )}
        {speichertGerade && <Loader2 size={13} className="spin muted" />}
      </span>
      <span className="muted">{relativeTime(partner.seit)}</span>
    </div>
  );
}

/* ── Optionaler Bonus-Einstiegspunkt: eine Adresse inline anzeigen ───
 * Siehe Dateikopf. Holt sich ihren Stand selbst — kein globaler Zustand
 * nötig für eine einzelne Adresse. */
export function PartnerGruppenBadge({ adresse }: { adresse: string }) {
  const t = useT();
  const [partner, setPartner] = useState<MailPartner | null>(null);

  useEffect(() => {
    let lebt = true;
    void partnerHolen({}).then((r) => {
      if (lebt) setPartner(r.partner.find((p) => p.adresse === adresse) ?? null);
    }).catch(() => { /* stille Randanzeige — kein eigener Fehlerzustand nötig */ });
    return () => { lebt = false; };
  }, [adresse]);

  if (!partner?.gruppe) return null;
  return (
    <span className="pill partnergruppen__badge-inline">
      {t(`partnerGruppen.gruppe.${partner.gruppe}` as TranslationKey)}
      {partner.gruppeVonKi && <em>{t('partnerGruppen.vorschlagBadge')}</em>}
    </span>
  );
}
