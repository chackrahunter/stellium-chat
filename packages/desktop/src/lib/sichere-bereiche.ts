/**
 * Doppelten oder fehlenden Sicherheitsabstand erkennen und ausgleichen —
 * gemessen, nicht geraten.
 *
 * Hintergrund ist WebKit-Fehler #301994 (aufgetreten in iOS 26.1, behoben in
 * 26.2, seit 26.5.2 und der 27er-Beta wieder da): Die Startbildschirm-App
 * bekommt einen um die Statusleistenhöhe verkleinerten Viewport (auf dem
 * iPhone 17 Pro: innerHeight 812 bei 874 Punkten Schirmhöhe). WO das System
 * die fehlenden Punkte wegnimmt, unterscheidet sich:
 *
 *   Lage A: Viewport beginnt UNTER der Uhr, env(safe-area-inset-top) fällt
 *           auf 0 — die env-Werte stimmen dann einfach, nichts zu tun.
 *   Lage B: Viewport klebt am oberen Schirmrand, unten bleibt ein toter
 *           Streifen, den iOS flach einfärbt. env() meldet weiter oben ~62
 *           und unten 34 — oben stimmt das (die Uhr steht über dem Inhalt),
 *           unten ist es gelogen (die Home-Leiste liegt UNTER dem Streifen,
 *           nicht über der Seite). Auf dem Gerät nachgemessen am 20.08.2026.
 *
 * Bekannte Unschärfe: Eine frühere Messung auf demselben Gerät (Kopfzeile bei
 * 124 statt 68 Punkten) zeigte den Viewport UNTER der Uhr, während env oben
 * trotzdem ~62 meldete — dieselben Zahlen wie Lage B, aber die Gegenlage.
 * Aus fehl/oben/unten allein sind die beiden nicht zu unterscheiden. Als
 * Zünglein dient window.screenY: meldet es die Verschiebung, ist es die
 * Gegenlage; meldet es 0 (auf diesem Gerät für Lage B gemessen), gilt die
 * aktuelle Messung. Taucht die 124er-Kopfzeile je wieder auf, ist das der
 * Ort, an dem weiterzusuchen ist.
 *
 * Ein Gegenmittel per Meta-Tag oder Manifest gibt es nicht — im Bugtracker
 * und in den Foren ist alles durchprobiert und gescheitert. Es bleibt nur,
 * zur Laufzeit zu messen und die eigenen Abstände passend zu übersteuern.
 *
 * Zwei Fallen, beide auf dem Gerät gefunden:
 *   – Beim Kaltstart sind die env()-Werte noch 0 und stehen erst mit dem
 *     ersten resize-Ereignis (im Labor: 13 ms nach load). Einmal zu früh
 *     gemessen, und jede Fallunterscheidung greift daneben — deshalb wird
 *     kurz nach dem Start nachgemessen.
 *   – Nachgemessen wird nur bei geschlossener Bildschirmtastatur (echt
 *     gemessen über visualViewport, siehe tastatur.ts): eine offene Tastatur
 *     kann innerHeight verfälschen. Bloßer Feld-Fokus taugt NICHT als
 *     Kriterium — der Composer fokussiert sich beim Start und bei jedem
 *     Kanalwechsel selbst, ohne dass iOS die Tastatur zeigt; eine
 *     Fokus-Sperre hätte jede Nachmessung dauerhaft blockiert.
 */

import { tastaturOffen } from './tastatur.js';

/* Beide env()-Werte mit EINEM Probe-Element und einem Layout-Durchlauf:
   Höhe trägt den oberen, das Polster den unteren Wert. */
function envWerte(): { oben: number; unten: number } {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;'
    + 'height:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(el);
  const stil = getComputedStyle(el);
  const werte = { oben: parseFloat(stil.height) || 0, unten: parseFloat(stil.paddingBottom) || 0 };
  el.remove();
  return werte;
}

/* Schirmhöhe passend zur aktuellen Ausrichtung — iOS meldet screen.height
   immer als lange Kante, auch im Querformat. */
function schirmHoehe(): number {
  return window.innerWidth > window.innerHeight
    ? Math.min(screen.width, screen.height)
    : Math.max(screen.width, screen.height);
}

/* Ohne viewport-fit=cover legt iOS den Ausschnitt unter die Statusleiste — er
   reicht damit bis zur letzten Bildschirmzeile, was er MIT cover nicht tat
   (dort blieben unten 62 Punkte tot, auf dem Geraet gemessen).
   Der Preis: env() meldet danach ueberall 0, auch fuer die Wischleiste. Den
   Abstand muss die App also selbst mitbringen, sonst laeuft ihr unterer Rand
   in die runde Schirmecke und in die Zone der Wischgeste.
   Bedingung `fehl > 8`: nur Geraete, bei denen der Ausschnitt ueberhaupt
   unter der Statusleiste beginnt — also solche mit Insel oder Kerbe. Ein
   Geraet mit Home-Knopf hat diese Luecke nicht und braucht den Abstand
   ebensowenig wie ein Zeigegeraet mit Maus. */
function randAbstand(): string | null {
  if (schirmHoehe() - window.innerHeight <= 8) return null;
  if (!window.matchMedia('(pointer: coarse)').matches) return null;
  /* Null, nicht 34: die Leiste soll bis an den unteren Rand reichen. Dass
     sie dort nicht angeschnitten wird, loest nicht ein Abstand, sondern die
     Rundung der Karte selbst — siehe die Rechnung in mobil.css. */
  return '0px';
}

function anwenden(): void {
  const wurzel = document.documentElement.style;
  const klassen = document.documentElement.classList;
  const zuruecksetzen = () => {
    wurzel.removeProperty('--sicher-oben');
    /* NICHT einfach loeschen: ohne cover meldet env unten 0, und dann stuende
       die Eingabeleiste in der Wischgeste. Der eigene Wert tritt an die
       Stelle des fehlenden env-Werts. */
    const rand = randAbstand();
    if (rand) wurzel.setProperty('--sicher-unten', rand);
    else wurzel.removeProperty('--sicher-unten');
    klassen.remove('viewport-beschnitten');
  };

  const fehl = schirmHoehe() - window.innerHeight;


  if (fehl <= 8) {
    /* Voller Schirm — kein Beschnitt, die env()-Werte aus tokens.css gelten.
       Vorher gesetzte Übersteuerungen zurücknehmen (Drehung, iOS-Update).
       Erst hier messen: der gesunde Fall soll keine Probe-Elemente zahlen. */
    zuruecksetzen();
    return;
  }

  const { oben, unten } = envWerte();

  if (oben <= 8) {
    /* Lage A: env sagt oben 0 — das System hat den Viewport unter die Uhr
       geschoben und die env-Werte passen. Auch der iPad-Fenstermodus landet
       hier (dort liefert env nichts); übersteuern wäre in beiden Fällen
       falsch. */
    zuruecksetzen();
    return;
  }

  if (unten > 8 && fehl >= oben + unten - 6) {
    /* Oben UND unten hat das System schon Platz genommen, env meldet trotzdem
       volle Werte — eigene Abstände wären doppelt. Der Viewport endet über
       der Home-Leiste, also die Naht am unteren Rand überblenden. */
    wurzel.setProperty('--sicher-oben', '0px');
    wurzel.setProperty('--sicher-unten', '0px');
    klassen.add('viewport-beschnitten');
    return;
  }

  if (Math.abs(fehl - oben) <= 10) {
    if (window.screenY >= oben - 10) {
      /* Gegenlage (siehe Kopfkommentar): das System hat den Viewport nach
         unten geschoben UND env meldet oben trotzdem die Leistenhöhe —
         eigener Abstand oben wäre der zweite. Unten stimmt env. */
      wurzel.setProperty('--sicher-oben', '0px');
      wurzel.removeProperty('--sicher-unten');
      klassen.remove('viewport-beschnitten');
      return;
    }
    /* Lage B: es fehlt genau die Statusleistenhöhe, env meldet sie oben
       weiterhin — der Viewport klebt am oberen Schirmrand. Oben braucht es
       den vollen Abstand (die Uhr steht über dem Inhalt), unten endet der
       Viewport bereits über der Home-Leiste: dort keinen Abstand doppeln,
       nur die Naht zum flachen Systemstreifen überblenden. */
    wurzel.removeProperty('--sicher-oben');
    wurzel.setProperty('--sicher-unten', '0px');
    klassen.add('viewport-beschnitten');
    return;
  }

  /* Unbekannte Geometrie (geteilter Bildschirm, künftige iOS-Launen):
     lieber den env()-Werten glauben als raten. */
  zuruecksetzen();
}

export function sichereBereicheVerbinden(): void {
  /* Nur die iOS-Startbildschirm-App ist betroffen. navigator.standalone gibt
     es nur in Safari auf iOS; auf Android stimmen die env()-Werte nativ, im
     Browser verwaltet Safari seine Leisten selbst — dort wird gar nichts
     verkabelt. */
  if ((navigator as { standalone?: boolean }).standalone !== true) return;

  /* Vor dem ersten Zeichnen einmal — und danach gezielt nach: die env()-Werte
     stehen beim Kaltstart noch nicht (siehe Kopfkommentar). KEIN dauerhafter
     resize-Beobachter: das erste resize nach dem Start trägt die echten
     Werte, danach hat der Beobachter seine Schuldigkeit getan; der Timer ist
     das Netz, falls es ausbleibt. */
  anwenden();
  /* Blockt die Tastatur eine Nachmessung, wird sie nachgeholt statt
     verworfen — sonst behält z. B. eine Drehung während des Tippens die
     Übersteuerungen der alten Ausrichtung für den Rest der Sitzung. */
  let holtNach = false;
  const nachmessen = () => {
    if (tastaturOffen()) {
      if (!holtNach) {
        holtNach = true;
        setTimeout(() => { holtNach = false; nachmessen(); }, 1000);
      }
      return;
    }
    anwenden();
  };
  setTimeout(nachmessen, 1200);
  window.addEventListener('resize', nachmessen);
  setTimeout(() => window.removeEventListener('resize', nachmessen), 3000);

  window.addEventListener('orientationchange', () => setTimeout(nachmessen, 300));
}
