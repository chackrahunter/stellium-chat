/**
 * Anhänge einer Mail — sehen und herunterladen.
 *
 * Eigene, kleine Komponente statt eines Blocks in PostPanel.tsx: an
 * PostPanel.tsx/PostMeldungen.tsx arbeitet gerade ein anderer Auftrag, der die
 * Freigabe-Oberfläche für KI-Entwürfe baut. Diese Datei hängt sich dort mit
 * einer einzigen Zeile ein (siehe VerlaufEintrag in PostPanel.tsx) und kennt
 * sonst nichts von der Tafel, die sie umgibt.
 *
 * SICHERHEIT — WARUM DIESE LISTE NIE MEHR TUT ALS EINEN VERWEIS ZU ZEIGEN
 *
 * Ein Anhang aus fremder Post ist die gefährlichste Datei im ganzen System:
 * sie stammt von jemandem, den niemand kennt. Diese Komponente zeigt deshalb
 * NIE eine Vorschau, NIE ein `<img>`, NIE einen Rahmen für den Inhalt — nur
 * Name, Größe und einen Verweis auf die Auslieferungsroute
 * (`GET /api/post/anhang/:id`), die ihrerseits IMMER mit
 * `Content-Type: application/octet-stream` und
 * `Content-Disposition: attachment` ausliefert (siehe http/routes.ts) — ganz
 * unabhängig davon, welchen Typ der Absender behauptet oder wie die Datei
 * heißt. Der Browser lädt herunter, er zeigt nie an.
 *
 * KEIN VIRENSCHUTZ: das sagt der Hinweis am Ende der Liste der Person, die
 * öffnet, ehrlich — statt eine Sicherheit vorzutäuschen, die es nicht gibt.
 *
 * Ein Anhang ohne `id` (siehe `MailAnhang` in @stellium/shared) hat keine
 * Bytes — zu groß für den Cloudflare-Worker oder unlesbar kodiert. Er steht
 * trotzdem in der Liste, nur ohne Verweis: eine Bewerbung ohne Lebenslauf soll
 * auffallen, nicht klanglos fehlen.
 */
import { AlertTriangle, Download, Paperclip } from 'lucide-react';
import type { MailAnhang } from '@stellium/shared';
import { useT } from '../i18n/index.js';
import { dateiUrl } from '../net/api.js';
import { fileSize } from '../lib/format.js';
import '../styles/post-anhaenge.css';

export function PostAnhaenge({ anhaenge }: { anhaenge: MailAnhang[] }) {
  const t = useT();
  if (!anhaenge.length) return null;

  return (
    <div className="mail-anhaenge">
      <div className="mail-anhaenge__liste" role="list" aria-label={t('post.anhaengeAria')}>
        {anhaenge.map((a, i) => (a.id ? (
          <a
            key={a.id}
            role="listitem"
            className="mail-anhang"
            // Der Nachweis geht in die Adresse (?token=), nicht in einen
            // Kopf: ein <a href> schickt keine Kopfzeilen mit (siehe
            // dateiUrl() in net/api.ts).
            href={dateiUrl(`/api/post/anhang/${encodeURIComponent(a.id)}`)}
            target="_blank"
            rel="noreferrer"
            title={a.name}
          >
            <Paperclip size={12} className="mail-anhang__symbol" aria-hidden="true" />
            <span className="mail-anhang__name truncate">{a.name}</span>
            <span className="mail-anhang__groesse">{fileSize(a.groesse)}</span>
            <Download size={12} className="mail-anhang__laden" aria-hidden="true" />
          </a>
        ) : (
          <span
            key={`${a.name}-${i}`}
            role="listitem"
            className="mail-anhang mail-anhang--fehlt"
            title={t('post.anhangNichtAngekommen')}
          >
            <Paperclip size={12} className="mail-anhang__symbol" aria-hidden="true" />
            <span className="mail-anhang__name truncate">{a.name}</span>
            <span className="mail-anhang__hinweis">{t('post.anhangNichtAngekommen')}</span>
          </span>
        )))}
      </div>
      <p className="mail-anhaenge__warnung">
        <AlertTriangle size={11} aria-hidden="true" />
        {t('post.anhangKeinVirenschutz')}
      </p>
    </div>
  );
}
