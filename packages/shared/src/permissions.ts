/**
 * Rechte-Katalog.
 *
 * Jedes Recht ist eine einzelne Erlaubnis. Rollen sind nur Vorlagen: sie geben
 * einen Satz Vorgaben, und für einzelne Personen kann davon abgewichen werden.
 * Durchgesetzt wird alles auf dem Server — die Oberfläche blendet Dinge nur
 * zusätzlich aus, damit niemand gegen Wände läuft.
 */

export type PermissionKey =
  /* Nachrichten */
  | 'message.send'
  | 'message.edit_own'
  | 'message.delete_own'
  | 'message.delete_any'
  | 'message.pin'
  | 'message.forward'
  | 'message.schedule'
  | 'reaction.add'
  /* Erwähnungen */
  | 'mention.user'
  | 'mention.everyone'
  /* Kanäle */
  | 'channel.create'
  | 'channel.create_private'
  | 'channel.manage'
  | 'channel.archive'
  | 'channel.delete'
  | 'channel.members'
  | 'dm.start'
  /* Inhalte */
  | 'file.upload'
  | 'voice.send'
  | 'poll.create'
  | 'poll.close_any'
  | 'task.create'
  | 'task.assign'
  | 'task.delete'
  | 'event.create'
  | 'event.manage'
  | 'file.manage'
  | 'idea.create'
  | 'idea.vote'
  | 'idea.manage'
  /* KI und Übersetzung */
  | 'ai.translate'
  | 'ai.assistant'
  | 'ai.model_select'
  | 'ki.verwalten'
  | 'glossary.manage'
  /* Vertraulichkeit */
  | 'vertraulich.kanal'
  | 'vertraulich.freigabe_lesen'
  /* System */
  | 'system.ansehen'
  | 'verkauf.sehen'
  | 'verkauf.verwalten'
  | 'bank.sehen'
  | 'bank.verwalten'
  /* Post */
  | 'mail.lesen'
  | 'mail.senden'
  | 'mail.verwalten'
  /* Fernzugriff */
  | 'fern.zugriff'
  | 'fern.verwalten'
  /* Einmalcodes */
  | 'einmalcode.nutzen'
  | 'einmalcode.verwalten'
  /* Passwort-Tresor */
  | 'passwort.nutzen'
  /* Problemberichte */
  | 'report.submit'
  | 'report.review'
  /* Verwaltung */
  | 'release.publish'
  | 'user.invite'
  | 'user.manage'
  | 'user.delete'
  | 'permission.manage';

export interface PermissionInfo {
  key: PermissionKey;
  /** Gruppe für die Darstellung in den Einstellungen. */
  group: 'nachrichten' | 'kanaele' | 'inhalte' | 'ki' | 'system' | 'post' | 'fernzugriff' | 'verwaltung';
  /**
   * NUR für Fehlermeldungen des Servers (routes.ts, ws/gateway.ts) — nicht
   * für die Oberfläche. Die Anzeige läuft über das Wörterbuch:
   * `perm.<key>.label` / `perm.<key>.hint` in i18n/de.ts und en.ts.
   */
  labelDe: string;
  /** Nur Owner darf dieses Recht vergeben. */
  ownerOnly?: boolean;
}

export const PERMISSIONS: PermissionInfo[] = [
  { key: 'message.send', group: 'nachrichten', labelDe: 'Nachrichten senden' },
  { key: 'message.edit_own', group: 'nachrichten', labelDe: 'Eigene Nachrichten bearbeiten' },
  { key: 'message.delete_own', group: 'nachrichten', labelDe: 'Eigene Nachrichten löschen' },
  { key: 'message.delete_any', group: 'nachrichten', labelDe: 'Fremde Nachrichten löschen' },
  { key: 'message.pin', group: 'nachrichten', labelDe: 'Nachrichten anpinnen' },
  { key: 'message.forward', group: 'nachrichten', labelDe: 'Weiterleiten' },
  { key: 'message.schedule', group: 'nachrichten', labelDe: 'Später senden' },
  { key: 'reaction.add', group: 'nachrichten', labelDe: 'Reagieren' },

  { key: 'mention.user', group: 'nachrichten', labelDe: 'Personen erwähnen' },
  { key: 'mention.everyone', group: 'nachrichten', labelDe: 'Alle erwähnen' },

  { key: 'channel.create', group: 'kanaele', labelDe: 'Kanäle anlegen' },
  { key: 'channel.create_private', group: 'kanaele', labelDe: 'Private Kanäle anlegen' },
  { key: 'channel.manage', group: 'kanaele', labelDe: 'Kanäle bearbeiten' },
  { key: 'channel.archive', group: 'kanaele', labelDe: 'Kanäle archivieren' },
  { key: 'channel.delete', group: 'kanaele', labelDe: 'Kanäle löschen' },
  { key: 'channel.members', group: 'kanaele', labelDe: 'Mitglieder verwalten' },
  { key: 'dm.start', group: 'kanaele', labelDe: 'Direktnachrichten schreiben' },

  { key: 'file.upload', group: 'inhalte', labelDe: 'Dateien hochladen' },
  { key: 'voice.send', group: 'inhalte', labelDe: 'Sprachnachrichten senden' },
  { key: 'poll.create', group: 'inhalte', labelDe: 'Umfragen starten' },
  { key: 'poll.close_any', group: 'inhalte', labelDe: 'Fremde Umfragen beenden' },
  { key: 'task.create', group: 'inhalte', labelDe: 'Aufgaben anlegen' },
  { key: 'task.assign', group: 'inhalte', labelDe: 'Aufgaben zuweisen' },
  { key: 'task.delete', group: 'inhalte', labelDe: 'Aufgaben löschen' },
  { key: 'event.create', group: 'inhalte', labelDe: 'Termine anlegen' },
  { key: 'event.manage', group: 'inhalte', labelDe: 'Fremde Termine bearbeiten' },
  { key: 'file.manage', group: 'inhalte', labelDe: 'Dateiablage verwalten' },

  { key: 'ai.translate', group: 'ki', labelDe: 'Live-Übersetzung nutzen' },
  { key: 'ai.assistant', group: 'ki', labelDe: 'KI-Funktionen nutzen' },
  { key: 'ai.model_select', group: 'ki', labelDe: 'KI-Modell festlegen' },

  /* Den API-Schlüssel des Arbeitsbereichs hinterlegen — dieselbe Klasse wie
     `mail.verwalten`, `verkauf.verwalten` und `fern.verwalten`, und deshalb
     dieselbe Machart: `ownerOnly`, und die Route dazu prüft es mit
     requirePermission() (http/routes.ts, /api/ki/zugang). Auch der NAME folgt
     dieser Familie und nicht den `ai.*`-Rechten darüber: `ai.translate` und
     `ai.model_select` sind Rechte auf das BENUTZEN der KI, dieses hier ist
     eines auf ein Geheimnis — und jedes Recht auf ein Geheimnis im Haus heißt
     `<bereich>.verwalten`.

     BEWUSST NICHT `ai.model_select`: das Modell zu wählen kostet nichts und
     steckt darum in der Rollenvorlage TEAMLEITUNG. Der Schlüssel dagegen ist
     die Rechnung des Unternehmens — wer ihn austauscht, lenkt jede KI-Anfrage
     des Hauses auf ein fremdes Konto um, und niemandem fällt es auf.

     ADMINISTRATOREN BEKOMMEN IHN TROTZDEM, über `ADMIN = ALLE.filter(...)`
     weiter unten. Das ist hier ausdrücklich entschieden und nicht bloß
     durchgerutscht (siehe den Kommentar an jener Stelle, der genau diese
     Entscheidung verlangt): ein Administrator trägt bereits `fern.zugriff`
     und `fern.verwalten`, also den Fernzugriff auf den Pi. Wer die Maschine
     erreicht, kommt an die .env — ihm den Schlüssel in der Oberfläche
     vorzuenthalten wäre ein Schloss an einer Tür ohne Wand daneben, genau
     die Abwägung wie bei `bank.verwalten`. `ownerOnly` erfüllt seinen Zweck
     trotzdem: VERGEBEN darf dieses Recht allein der Inhaber. */
  { key: 'ki.verwalten', group: 'ki', ownerOnly: true, labelDe: 'KI-Zugang einrichten' },
  { key: 'idea.create', group: 'inhalte', labelDe: 'Ideen einbringen' },
  { key: 'idea.vote', group: 'inhalte', labelDe: 'Über Ideen abstimmen' },
  { key: 'idea.manage', group: 'inhalte', labelDe: 'Ideen entscheiden' },
  { key: 'glossary.manage', group: 'ki', labelDe: 'Glossar pflegen' },

  { key: 'vertraulich.kanal', group: 'kanaele', labelDe: 'Kanäle vertraulich stellen' },
  { key: 'vertraulich.freigabe_lesen', group: 'verwaltung', ownerOnly: true, labelDe: 'Freigaben bei Vorfällen lesen' },

  { key: 'system.ansehen', group: 'system', labelDe: 'Systemwerte ansehen' },

  /* Bewusst NICHT Teil von `system.ansehen`. Dessen Hinweis verspricht
     ausdrücklich "nur Zahlen — Auslastung, Speicher, Besucher"; Einnahmen
     gehören in eine andere Klasse. Wer den Server im Blick behalten soll,
     muss deshalb nicht auch sehen, was das Geschäft einbringt. */
  { key: 'verkauf.sehen', group: 'system', labelDe: 'Verkaufszahlen ansehen' },

  { key: 'mail.lesen', group: 'post', labelDe: 'Postfach lesen' },
  { key: 'mail.senden', group: 'post', labelDe: 'Post senden und beantworten' },
  { key: 'mail.verwalten', group: 'post', ownerOnly: true, labelDe: 'Postfach einrichten' },

  { key: 'verkauf.verwalten', group: 'system', ownerOnly: true, labelDe: 'Verkaufszugang einrichten' },

  /* Bewusst NICHT Teil von `verkauf.sehen`: dieses Recht steckt bereits im
     Rechteprofil TEAMLEITUNG. Es dafür mitzunutzen gäbe jeder Teamleitung den
     Kontostand des Unternehmens mit — auf einem Recht, das für einen anderen
     Zweck vergeben wurde.
     Administratoren tragen beide Schlüssel trotzdem automatisch mit — bewusst
     NICHT in den Ausschluss von `ADMIN` weiter unten aufgenommen; die
     Begründung dafür steht dort, an derselben Stelle wie der Mechanismus. */
  { key: 'bank.sehen', group: 'system', ownerOnly: true, labelDe: 'Kontostand ansehen' },
  { key: 'bank.verwalten', group: 'system', ownerOnly: true, labelDe: 'Bankzugang einrichten' },

  /* Bewusst KEIN Eintrag in ROLE_DEFAULTS: dies ist das einzige Recht im
     Katalog, das einen Authentisierungsfaktor weitergibt statt Zugang zu
     Daten — es wird je Person in der Rechte-Tafel vergeben, nicht über eine
     Rollenvorlage. Owner und Administratoren erhalten beide Schlüssel
     trotzdem automatisch: der Owner über `[...ALLE]`, Administratoren über
     `ADMIN = ALLE.filter(...)` weiter unten — beide leiten sich aus
     PERMISSION_KEYS ab, in das dieser Eintrag hier automatisch eingeht. */
  { key: 'einmalcode.nutzen', group: 'system', labelDe: 'Einmalcodes nutzen' },
  { key: 'einmalcode.verwalten', group: 'system', ownerOnly: true, labelDe: 'Einmalcodes einrichten' },

  /* Bewusst KEIN Eintrag in ROLE_DEFAULTS — aus demselben Grund wie bei
     `einmalcode.nutzen` direkt darüber, nur dass hier nicht ein zweiter
     Faktor weitergegeben wird, sondern der Zugang zu den Firmenkonten
     selbst (Google, PayPal, Gumroad, Resend, Patreon). Wer die Tafel sehen
     soll, bekommt dieses Recht einzeln in der Rechte-Tafel — nie über eine
     Rollenvorlage, sonst stünde der Tresor plötzlich jedem "Mitglied" offen.
     Owner und Administratoren erhalten es trotzdem automatisch: der Owner
     über `[...ALLE]`, Administratoren über `ADMIN = ALLE.filter(...)`
     weiter unten — beide leiten sich aus PERMISSION_KEYS ab, in das dieser
     Eintrag hier automatisch eingeht. */
  { key: 'passwort.nutzen', group: 'system', labelDe: 'Passwort-Tresor nutzen' },

  /* Melden selbst ist KEIN Vorrecht — im Gegenteil: wer am wenigsten Rechte
     hat, stolpert im Zweifel zuerst über eine Wand, die alle anderen nie zu
     sehen bekommen. Deshalb unten in NUR_LESEN, der untersten Rollenvorlage,
     und von dort über jede Kette bis zum Owner mit dabei — nur `bot` bleibt
     ausdrücklich außen vor: ein technisches Konto erlebt die Oberfläche
     nicht und hat nichts zu melden. */
  { key: 'report.submit', group: 'inhalte', labelDe: 'Probleme melden' },
  /* Das Gegenstück: die Liste ansehen und Berichte weiterschalten. Bewusst
     NICHT in report.submit enthalten (wer meldet, muss die Meldungen der
     ganzen Belegschaft nicht mitlesen können — Berichte tragen Freitext, den
     Leute manchmal unbedacht tippen) und bewusst NICHT in irgendeiner
     ROLE_DEFAULTS-Vorlage vergeben: dieses Recht ist für die eine Person
     gedacht, die Berichte sichtet, und für das technische Konto, über das
     ein n8n-Arbeitsablauf sie abholt — beides einzeln in der Rechte-Tafel
     vergeben (services/users.ts, setPermission()), nie pauschal über eine
     Rolle. Administratoren bekommen es trotzdem automatisch über
     `ADMIN = ALLE.filter(...)` weiter unten, aus demselben Grund wie
     passwort.nutzen darüber. Die eigenen Berichte darf jede Person ohnehin
     sehen — das prüft die Route unabhängig von diesem Recht. */
  { key: 'report.review', group: 'verwaltung', labelDe: 'Problemberichte einsehen und bearbeiten' },

  { key: 'fern.zugriff', group: 'fernzugriff', labelDe: 'Pi fernsteuern' },
  { key: 'fern.verwalten', group: 'fernzugriff', ownerOnly: true, labelDe: 'Fernzugang einrichten' },

  { key: 'release.publish', group: 'verwaltung', labelDe: 'Fassungen veröffentlichen' },
  { key: 'user.invite', group: 'verwaltung', labelDe: 'Konten anlegen' },
  { key: 'user.manage', group: 'verwaltung', labelDe: 'Konten verwalten' },
  { key: 'user.delete', group: 'verwaltung', ownerOnly: true, labelDe: 'Konten löschen' },
  { key: 'permission.manage', group: 'verwaltung', ownerOnly: true, labelDe: 'Rechte vergeben' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export type MemberRoleName =
  | 'owner' | 'admin' | 'moderator' | 'technik' | 'teamlead'
  | 'member' | 'contributor' | 'guest' | 'readonly' | 'bot';

export interface RoleInfo {
  name: MemberRoleName;
  labelDe: string;
  labelEn: string;
  hintDe: string;
  hintEn: string;
  /** Nur der Owner darf diese Rolle vergeben. */
  ownerOnly?: boolean;
  /** Nicht für Menschen gedacht. */
  technical?: boolean;
}

/* ── Rechteprofile ────────────────────────────────────────────── */

const ALLE = PERMISSION_KEYS;

/** Nur mitlesen. Für Praktikanten in der Einarbeitung, Archiv-Zugänge, Audits. */
const NUR_LESEN: PermissionKey[] = [
  'ai.translate',
  /* Ganz unten und mit Absicht: wer nur mitliest, ist im Team, und ein
     Fehler, den nur diese Person sieht, kommt sonst nie an. Ausführliche
     Begründung oben bei PERMISSIONS, Eintrag 'report.submit'. */
  'report.submit',
];

/** Darf antworten und reagieren, aber nichts Eigenes anstoßen. */
const GAST: PermissionKey[] = [
  ...NUR_LESEN,
  'message.send', 'message.edit_own', 'message.delete_own', 'reaction.add',
];

/** Arbeitet mit, legt aber keine Struktur an. Für Externe und Werkstudenten. */
const MITWIRKEND: PermissionKey[] = [
  ...GAST,
  'mention.user', 'file.upload', 'voice.send', 'message.forward', 'dm.start',
  'ai.assistant', 'task.create', 'event.create', 'idea.create', 'idea.vote',
];

/** Der Normalfall im Team. */
const MITGLIED: PermissionKey[] = [
  ...MITWIRKEND,
  'message.pin', 'message.schedule', 'channel.create', 'poll.create',
  'task.assign',
  /* Vertraulichkeit ist kein Vorrecht der Leitung: wer einen Kanal anlegen
     darf, darf ihn auch schützen. Die Gegenprobe — Vertraulichkeit nur für
     die Leitung — hätte genau die Gespräche ungeschützt gelassen, um die es
     dabei am häufigsten geht. */
  'vertraulich.kanal',
];

/** Hält die Kanäle in Ordnung, verwaltet aber keine Konten. */
const MODERATOR: PermissionKey[] = [
  ...MITGLIED,
  'message.delete_any', 'mention.everyone', 'poll.close_any',
  'channel.create_private', 'channel.manage', 'channel.archive', 'channel.members',
  'glossary.manage', 'task.delete', 'event.manage', 'file.manage', 'idea.manage',
];

/**
 * Hält den Server im Blick, ohne Konten oder Kanäle anzufassen.
 *
 * Eine eigene Rolle und nicht ein Recht an der Teamleitung: wer die Technik
 * betreut, ist nicht zwangsläufig wer, der Leute aufnimmt — und umgekehrt.
 * Beides in eine Rolle zu werfen hieße, jedem von beiden zu geben, was er
 * nicht braucht.
 */
const TECHNIK: PermissionKey[] = [
  ...MITGLIED,
  'system.ansehen',
];

/** Führt ein Team: nimmt Leute auf und setzt Passwörter zurück. */
const TEAMLEITUNG: PermissionKey[] = [
  ...MITGLIED,
  'mention.everyone', 'channel.create_private', 'channel.manage', 'channel.members',
  'user.invite', 'user.manage', 'task.delete', 'event.manage', 'idea.manage',
  /* Wer ein Team führt, soll auch sehen, ob der Server steht — die Frage
     kommt bei ihm an, nicht bei der Technik. */
  'system.ansehen',
  /* Den Pi fernsteuern darf die Leitung von Haus aus — steht der Rechner
     still, hängt das ganze Team, und dann soll niemand erst den Inhaber
     suchen müssen. NUR das Benutzen: `fern.verwalten`, also Adresse und
     Passwort hinterlegen, bleibt beim Inhaber und den Administratoren.
     Wer den Zugang benutzt, bekommt ihn dabei nie zu sehen — die App holt
     ihn sich selbst. */
  'fern.zugriff',
  /* Die Post des Unternehmens gehört zur Führung — Abo-Anfragen und
     Behördenpost landen bei ihr, nicht bei der Technik. Einrichten darf sie
     das Postfach nicht: `mail.verwalten` bleibt beim Inhaber, wie beim
     Fernzugang auch. */
  'mail.lesen', 'mail.senden',
  /* Was das Geschäft einbringt, gehört zur Führung eines Teams. Die Technik
     bekommt es NICHT: wer den Server betreut, braucht Umsatzzahlen nicht,
     und beides in eine Rolle zu werfen hieße wieder, jedem zu geben, was er
     nicht braucht. */
  'verkauf.sehen',
];

/**
 * Alles außer den Owner-Vorbehalten (Löschen und Rechtevergabe).
 *
 * Das Freigaberecht bleibt drin: "die Verwaltung" im Sinne der Freigabe ist
 * genau dieser Kreis. Wer ihn kleiner haben will, nimmt einzelnen Konten das
 * Recht — dafür gibt es die persönlichen Ausnahmen.
 *
 * OPT-OUT, NICHT OPT-IN: `ALLE.filter(...)` heißt, diese Liste startet mit
 * JEDEM Eintrag aus PERMISSION_KEYS und zieht nur die drei genannten wieder
 * ab. Ein neues Recht im Katalog landet damit automatisch — ohne eigene
 * Zeile, ohne dass irgendwer das an dieser Stelle bestätigt — bei jedem
 * Administrator. Wer eine neue PermissionKey einträgt, muss deshalb HIER
 * bewusst entscheiden, ob Administratoren sie auch bekommen sollen, statt es
 * stillschweigend über diesen Mechanismus laufen zu lassen — und sie im
 * Zweifel ausdrücklich mit aufnehmen.
 *
 * BEISPIEL FÜR DIESE ENTSCHEIDUNG: `bank.sehen`/`bank.verwalten` (der
 * PayPal-Kontostand) stehen ABSICHTLICH NICHT in dieser Liste, obwohl beide
 * `ownerOnly` sind. Ein Administrator trägt ohnehin schon `fern.zugriff` und
 * `fern.verwalten` — Fernzugriff auf den Pi selbst. Wer die Maschine
 * erreicht, liest die Datenbank auch ohne diese beiden Rechte; sie ihm
 * vorzuenthalten wäre ein Schloss an einer Tür ohne Wand daneben. Sie
 * trotzdem hier einzutragen würde außerdem das Muster brechen, dem
 * `mail.verwalten`, `verkauf.verwalten` und `fern.verwalten` alle folgen —
 * und ein Rechtemodell mit Ausnahmen von der eigenen Regel ist schwerer zu
 * durchschauen als eines, das ein wenig großzügiger, aber konsistent ist.
 * `ownerOnly` erfüllt seinen eigentlichen Zweck trotzdem: nur der Inhaber
 * darf diese beiden Rechte an jemand ANDEREN vergeben.
 *
 * WARUM DIESELBE BEGRÜNDUNG FÜR `passwort.nutzen` NICHT TRÄGT — UND WARUM
 * DAS RECHT TROTZDEM HIER BLEIBT
 *
 * `passwort.nutzen` fällt über den Opt-out oben ebenfalls jedem Administrator
 * zu. Das Argument von gerade eben („wer die Maschine erreicht, liest die
 * Datenbank ohnehin") gilt dafür AUSDRÜCKLICH NICHT: der Tresor ist
 * Ende-zu-Ende verschlüsselt. In der Datenbank steht nur Chiffrat, und die
 * Schlüssel dazu liegen ausschließlich in Paketen, die auf den privaten Teil
 * eines Geräts oder auf den passwortabgeleiteten Kontoschlüssel einer
 * bestimmten Person rechnen (services/passwoerter.ts,
 * services/kontoschluessel.ts). Wer die Platte hat, hat den Tresor gerade
 * nicht — das ist der ganze Sinn des Aufbaus, und ihn hier als Nebensatz
 * wegzureden hieße, ihn zu untergraben.
 *
 * Der Schluss stimmt trotzdem, nur aus einem anderen Grund: `passwort.nutzen`
 * ist ein Recht auf die TAFEL, kein Recht auf die EINTRÄGE. Es öffnet
 * ausschließlich, was einem ohnehin gehört oder was einem jemand ausdrücklich
 * freigegeben hat — die Liste kommt aus `owner_id = ich OR ich stehe in
 * passwort_mitglieder`, und ohne Schlüsselpaket ist selbst ein
 * mitgeliefertes Chiffrat nur Rauschen. Ein Administrator ohne Freigabe sieht
 * mit diesem Recht seinen eigenen, leeren Tresor. Das Recht, das wirklich
 * etwas verteilt, ist keins: es ist das TEILEN, und teilen darf allein die
 * besitzende Person jedes Eintrags.
 */
const ADMIN: PermissionKey[] = ALLE.filter(
  (k) => k !== 'user.delete' && k !== 'permission.manage' && k !== 'channel.delete',
);

/** Integrationen und der KI-Assistent: schreiben, aber nichts verwalten. */
const BOT: PermissionKey[] = [
  'message.send', 'message.edit_own', 'message.delete_own',
  'reaction.add', 'file.upload', 'ai.translate',
];

export const ROLES: RoleInfo[] = [
  { name: 'owner', ownerOnly: true,
    labelDe: 'Inhaber', labelEn: 'Owner',
    hintDe: 'Darf alles und kann nicht eingeschränkt werden. Nur der Inhaber vergibt diese Rolle.',
    hintEn: 'May do everything and cannot be restricted. Only the owner grants this role.' },
  { name: 'admin',
    labelDe: 'Administrator', labelEn: 'Administrator',
    hintDe: 'Verwaltet Konten, Kanäle und die KI. Kann keine Konten löschen und keine Rechte vergeben.',
    hintEn: 'Manages accounts, channels and the AI. Cannot delete accounts or grant permissions.' },
  { name: 'moderator',
    labelDe: 'Moderation', labelEn: 'Moderator',
    hintDe: 'Hält die Kanäle in Ordnung: fremde Nachrichten löschen, Umfragen beenden, Glossar pflegen. Ohne Kontoverwaltung.',
    hintEn: 'Keeps channels tidy: delete others’ messages, close polls, maintain the glossary. No account management.' },
  { name: 'technik',
    labelDe: 'Technik', labelEn: 'Technical',
    hintDe: 'Sieht die Systemwerte des Servers — Auslastung, Speicher, Temperatur, Dienste. Verwaltet keine Konten und keine Kanäle.',
    hintEn: 'Sees the server status — load, memory, temperature, services. Manages neither accounts nor channels.' },
  { name: 'teamlead',
    labelDe: 'Teamleitung', labelEn: 'Team lead',
    hintDe: 'Nimmt neue Leute auf und setzt Passwörter zurück. Vergibt keine Einzelrechte.',
    hintEn: 'Onboards people and resets passwords. Does not grant individual permissions.' },
  { name: 'member',
    labelDe: 'Mitglied', labelEn: 'Member',
    hintDe: 'Der Normalfall: schreiben, Kanäle anlegen, Umfragen starten, KI nutzen.',
    hintEn: 'The normal case: write, create channels, start polls, use the AI.' },
  { name: 'contributor',
    labelDe: 'Mitwirkend', labelEn: 'Contributor',
    hintDe: 'Arbeitet mit, legt aber keine Kanäle oder Umfragen an. Passend für Externe und Werkstudierende.',
    hintEn: 'Takes part but creates no channels or polls. Suits externals and working students.' },
  { name: 'guest',
    labelDe: 'Gast', labelEn: 'Guest',
    hintDe: 'Antwortet und reagiert. Keine Dateien, keine Erwähnungen, keine KI-Hilfen.',
    hintEn: 'Replies and reacts. No files, no mentions, no AI assistance.' },
  { name: 'readonly',
    labelDe: 'Nur lesen', labelEn: 'Read only',
    hintDe: 'Liest mit, schreibt nichts. Für Einarbeitung, Prüfungen und Archivzugänge.',
    hintEn: 'Reads along, writes nothing. For onboarding, audits and archive access.' },
  { name: 'bot', technical: true,
    labelDe: 'Bot', labelEn: 'Bot',
    hintDe: 'Für den KI-Assistenten und Integrationen. Schreibt, verwaltet aber nichts.',
    hintEn: 'For the AI assistant and integrations. Writes but manages nothing.' },
];

export const ROLE_DEFAULTS: Record<MemberRoleName, PermissionKey[]> = {
  owner: [...ALLE],
  admin: ADMIN,
  moderator: MODERATOR,
  technik: TECHNIK,
  teamlead: TEAMLEITUNG,
  member: MITGLIED,
  contributor: MITWIRKEND,
  guest: GAST,
  readonly: NUR_LESEN,
  bot: BOT,
};

export function roleInfo(name: MemberRoleName): RoleInfo | undefined {
  return ROLES.find((r) => r.name === name);
}

/** Rechte einer Rolle als Nachschlagetabelle. */
export function defaultsFor(role: MemberRoleName): Record<PermissionKey, boolean> {
  const erlaubt = new Set(ROLE_DEFAULTS[role] ?? MITGLIED);
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, erlaubt.has(k)])) as Record<PermissionKey, boolean>;
}

/**
 * Endgültige Rechte: Rollenvorgabe, überschrieben von persönlichen Ausnahmen.
 * Der Owner behält immer alles — sonst könnte er sich selbst aussperren.
 */
export function effectivePermissions(
  role: MemberRoleName,
  overrides: Partial<Record<PermissionKey, boolean>> = {},
): Record<PermissionKey, boolean> {
  if (role === 'owner') return defaultsFor('owner');
  const base = defaultsFor(role);
  for (const [key, allowed] of Object.entries(overrides)) {
    if (PERMISSION_KEYS.includes(key as PermissionKey)) base[key as PermissionKey] = Boolean(allowed);
  }
  return base;
}

export function permissionInfo(key: PermissionKey): PermissionInfo | undefined {
  return PERMISSIONS.find((p) => p.key === key);
}


/* ── Zeitfenster fürs Bearbeiten und Löschen ──────────────────── */

/**
 * Wie lange eine Nachricht nach dem Senden noch geändert werden darf.
 * Danach ist sie Teil des Gesprächsverlaufs: wer eine Stunde später etwas
 * anderes dort stehen sähe, könnte die Unterhaltung nicht mehr nachvollziehen.
 */
export const EDIT_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Wie lange man eine eigene Nachricht für alle zurücknehmen darf.
 * Danach bleibt nur noch das Ausblenden für einen selbst — sonst entstünden
 * Lücken in einem Verlauf, auf den sich andere schon bezogen haben.
 */
export const DELETE_FOR_ALL_WINDOW_MS = 2 * 60 * 60 * 1000;

export function withinEditWindow(createdAt: number, now = Date.now()): boolean {
  return now - createdAt <= EDIT_WINDOW_MS;
}

export function withinDeleteWindow(createdAt: number, now = Date.now()): boolean {
  return now - createdAt <= DELETE_FOR_ALL_WINDOW_MS;
}

/** Verbleibende Zeit in Minuten, für die Anzeige. */
export function minutesLeft(createdAt: number, windowMs: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((createdAt + windowMs - now) / 60000));
}
