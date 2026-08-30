import type { ProblemberichtBereich } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { usePartnerGruppenUi } from '../state/partnergruppen.js';
import { useGedaechtnisUi } from '../state/gedaechtnis.js';
import { useEinmalcodeUi } from '../state/einmalcode.js';
import { usePasswortUi } from '../state/passwort.js';
import { useNotzugangUi } from '../state/notzugang.js';
import { usePaypalUi } from '../state/paypal.js';
import { useVerkaufMeldungenUi } from '../state/verkaufMeldungen.js';

/**
 * Wo in der App gerade jemand steht — für den Problembericht.
 *
 * WARUM DAS HIER STEHT UND NICHT IM FORMULAR SELBST
 * Wer auf „Problem melden" klickt, hat das Formular noch gar nicht offen —
 * diese Funktion muss also GENAU IN DEM MOMENT laufen, in dem der Knopf
 * gedrückt wird (state/problemberichte.ts, oeffnen()), nicht erst, wenn das
 * Formular selbst zeichnet. Bis dahin hätte `overlay` längst gewechselt (auf
 * das Problemberichte-Panel selbst) und der eigentliche Ort wäre verloren.
 *
 * Niemand tippt das ab — das ist der ganze Punkt: die App weiß es schon.
 * `bereich` im Formular startet mit genau diesem Wert vorausgefüllt, bleibt
 * aber änderbar (siehe ProblemberichtBereich in @stellium/shared): ein Fehler
 * fällt nicht selten woanders auf, als er entstanden ist.
 */
export function aktuellesPanel(): ProblemberichtBereich {
  if (usePasswortUi.getState().offen) return 'passwoerter';
  if (
    usePartnerGruppenUi.getState().offen || useGedaechtnisUi.getState().offen
    || useEinmalcodeUi.getState().offen || useNotzugangUi.getState().offen
    || usePaypalUi.getState().offen || useVerkaufMeldungenUi.getState().offen
  ) return 'verwaltung';

  const { overlay, activeChannelId } = useStore.getState();
  switch (overlay) {
    case 'channelSettings':
    case 'newChannel':
      return 'kanaele';
    case 'quick':
    case 'search':
    case 'saved':
      return 'suche';
    case 'tasks':
    case 'taskExtract':
      return 'aufgaben';
    case 'calendar':
    case 'schedule':
    case 'reminders':
      return 'kalender';
    case 'files':
      return 'dateien';
    case 'ideas':
      return 'ideenboard';
    case 'poll':
      return 'umfragen';
    case 'post':
    case 'postMeldungen':
      return 'post';
    case 'notizen':
      return 'notizen';
    case 'people':
    case 'team':
      return 'team';
    case 'models':
    case 'glossary':
      return 'ki';
    case 'settings':
      return 'einstellungen';
    case 'system':
    case 'fern':
      return 'verwaltung';
    case null:
      return activeChannelId ? 'chat' : 'sonstiges';
    default:
      return 'sonstiges';
  }
}
