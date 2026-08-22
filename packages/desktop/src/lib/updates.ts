import { useStore } from '../state/store.js';
import { spracheDesSystems, translate, type TranslationKey } from '../i18n/kern.js';

/** Meldungen in der Sprache der angemeldeten Person. */
function t(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(useStore.getState().self?.uiLanguage || spracheDesSystems(), key, werte);
}

/**
 * Meldungen des Hauptprozesses in den Zustand übernehmen.
 * Einmal beim Start aufgerufen; im Browser passiert nichts.
 */
/** Zählt die Restzeit herunter — der Hauptprozess meldet nur den Startwert. */
let uhr: ReturnType<typeof setInterval> | null = null;

export function updatesVerbinden(): () => void {
  if (!window.stellium?.onUpdate) return () => {};

  return window.stellium.onUpdate((art, daten) => {
    const d = (daten ?? {}) as {
      version?: string; notes?: string | null; geladen?: number; gesamt?: number;
      message?: string; sekunden?: number; versuch?: number;
      /* Neuere Fehlermeldungen kommen als Schlüssel + Werte statt als fertiger
         Satz: der Hauptprozess kennt die Sprache der angemeldeten Person
         nicht (das ist Sache des Renderers, siehe t() oben), konnte den Grund
         bisher aber nur als bereits-deutschen Text mitschicken. Ältere
         Aufrufstellen liefern weiterhin `message` direkt — beides wird unten
         bedient. */
      key?: TranslationKey; params?: Record<string, string | number>;
    };
    switch (art) {
      case 'found':
        useStore.setState({ update: { zustand: 'gefunden', version: d.version, notes: d.notes ?? null } });
        break;
      case 'progress':
        useStore.setState({
          update: {
            zustand: 'laedt',
            version: d.version,
            anteil: d.gesamt ? Math.min(1, (d.geladen ?? 0) / d.gesamt) : 0,
          },
        });
        break;
      case 'ready':
        useStore.setState({ update: { zustand: 'bereit', version: d.version, notes: d.notes ?? null } });
        useStore.getState().toast({
          kind: 'ok',
          title: t('update.readyTitle', { version: d.version ?? '' }),
          body: t('update.readyBody'),
        });
        break;
      case 'deadline': {
        // Die Uhr läuft im Hauptprozess; hier nur mitzählen, damit der
        // Hinweis die Restzeit zeigen kann.
        if (uhr) clearInterval(uhr);
        let rest = d.sekunden ?? 300;
        useStore.setState((s) => ({ update: { ...s.update, zustand: 'bereit', restSekunden: rest, verschoben: false } }));
        uhr = setInterval(() => {
          rest -= 1;
          if (rest <= 0) { clearInterval(uhr!); uhr = null; return; }
          useStore.setState((s) => ({ update: { ...s.update, restSekunden: rest } }));
        }, 1000);
        break;
      }
      case 'postponed':
        if (uhr) { clearInterval(uhr); uhr = null; }
        useStore.setState((s) => ({ update: { ...s.update, restSekunden: undefined, verschoben: true } }));
        break;
      case 'retry':
        /* Der Download ist abgerissen und setzt neu an. Ohne diese Meldung
           stand der Balken still und niemand wusste, ob noch etwas passiert. */
        useStore.getState().toast({
          kind: 'info',
          title: t('update.retrying', { versuch: d.versuch ?? 1 }),
          body: d.message ?? undefined,
        });
        break;
      case 'installing':
        useStore.setState({ update: { zustand: 'installiert', version: d.version } });
        break;
      case 'none':
        useStore.setState({ update: { zustand: 'aktuell', version: d.version } });
        break;
      case 'error':
        if (uhr) { clearInterval(uhr); uhr = null; }
        useStore.setState({ update: { zustand: 'fehler', fehler: d.key ? t(d.key, d.params) : d.message } });
        break;
    }
  });
}
