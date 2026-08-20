import { Component, type ErrorInfo, type ReactNode } from 'react';
import { spracheDesSystems, translate, type TranslationKey } from '../i18n/kern.js';
import { currentUiLanguage } from '../i18n/index.js';

/**
 * Fangkorb für Fehler beim Zeichnen.
 *
 * Wirft irgendeine Komponente beim Zeichnen, hängt React den **ganzen** Baum
 * aus: `#root` ist leer, die App zeigt nichts, und nichts an der Oberfläche
 * sagt, warum. Genau das ist hier schon passiert — ein `t(...)` außerhalb
 * seines Gültigkeitsbereichs in einer modulweiten Komponente. Die Typprüfung
 * war dabei sauber: `t` gab es ja, nur nicht an dieser Stelle.
 *
 * Ein Fangkorb ist die einzige Stelle in React, an der so ein Fehler
 * abgefangen werden kann, und er muss eine Klasse sein — Haken gibt es dafür
 * nicht. Zwei liegen im Baum:
 *
 *   - einer ganz außen (main.tsx), damit statt eines leeren Fensters etwas
 *     Lesbares samt „Neu laden" erscheint;
 *   - einer um die Fensterschicht (App.tsx), damit ein kaputter Dialog nicht
 *     den Chat mitnimmt, der dahinter einwandfrei läuft.
 *
 * Bewusst ohne Zustand und ohne `useT`: wer hier landet, kann sich auf nichts
 * mehr verlassen. Die Sprache kommt direkt aus dem Kern, und selbst das steht
 * in einem try — ein Fangkorb, der beim Fangen wirft, ist keiner.
 */

interface Props {
  children: ReactNode;
  /** Klein und eingebettet statt ganzseitig — für die Fensterschicht. */
  eingebettet?: boolean;
  /** Wechselt dieser Wert, wird ein neuer Versuch unternommen. */
  zuruecksetzenBei?: unknown;
}

interface State {
  fehler: Error | null;
  /** Wechselnder Wert, an dem der Zurücksetzen-Vergleich hängt. */
  gesehenBei: unknown;
}

/**
 * Übersetzen, ohne sich auf irgendetwas zu verlassen.
 *
 * `currentUiLanguage` liest den Zustand — und der ist womöglich gerade das
 * Problem. Deshalb steht selbst diese Zeile in einem `try`; notfalls tut es
 * die Sprache des Rechners, und wenn auch die nicht zu haben ist, Deutsch.
 */
function text(key: TranslationKey): string {
  let sprache = 'de';
  try { sprache = currentUiLanguage(); } catch { /* Zustand nicht zu haben */ }
  try { return translate(sprache, key); } catch { /* Wörterbuch kaputt */ }
  try { return translate(spracheDesSystems(), key); } catch { return key; }
}

export class Fangkorb extends Component<Props, State> {
  state: State = { fehler: null, gesehenBei: undefined };

  static getDerivedStateFromError(fehler: Error): Partial<State> {
    return { fehler };
  }

  /**
   * Ein Fangkorb, dessen Inhalt sich ändert, muss es noch einmal versuchen —
   * sonst bliebe die Meldung stehen, obwohl längst ein anderer Dialog offen
   * ist. Der Vergleich läuft über den mitgegebenen Wert, nicht über die
   * Kinder: die sind bei jedem Zeichnen neu.
   */
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (state.fehler && props.zuruecksetzenBei !== state.gesehenBei) {
      return { fehler: null, gesehenBei: props.zuruecksetzenBei };
    }
    if (!state.fehler && props.zuruecksetzenBei !== state.gesehenBei) {
      return { gesehenBei: props.zuruecksetzenBei };
    }
    return null;
  }

  componentDidCatch(fehler: Error, info: ErrorInfo): void {
    // In die Konsole, damit der Prüflauf und die Entwicklerwerkzeuge es sehen.
    console.error('[Stellium] Fangkorb', fehler, info.componentStack);
  }

  render(): ReactNode {
    const { fehler } = this.state;
    if (!fehler) return this.props.children;

    const einzelheiten = `${fehler.name}: ${fehler.message}`;

    if (this.props.eingebettet) {
      return (
        <div className="scrim scrim--center" data-fangkorb="teil">
          <div className="panel" style={{ width: 'min(440px, 100%)', padding: 'var(--sp-5)' }}>
            <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 700 }}>{text('fangkorb.teilTitel')}</h2>
            <p className="muted" style={{ margin: '0 0 14px', fontSize: 13.5 }}>{text('fangkorb.teilText')}</p>
            <pre style={{
              margin: '0 0 14px', maxHeight: 120, overflow: 'auto', fontSize: 11.5,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.7,
            }}>{einzelheiten}</pre>
            <button className="btn btn--primary" onClick={() => this.setState({ fehler: null })}>
              {text('common.retry')}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="auth" data-fangkorb="ganz">
        <div className="auth__card" role="alert">
          <h1 className="auth__title">{text('fangkorb.titel')}</h1>
          <p className="auth__sub">{text('fangkorb.text')}</p>
          <pre style={{
            margin: '0 0 var(--sp-4)', maxHeight: 140, overflow: 'auto', fontSize: 11.5,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.7,
          }}>{einzelheiten}</pre>
          <button className="btn btn--primary btn--block" onClick={() => window.location.reload()}>
            {text('fangkorb.neuLaden')}
          </button>
        </div>
      </div>
    );
  }
}
