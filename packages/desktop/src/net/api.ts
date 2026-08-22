import type {
  AiCapabilities, AiModelInfo, AiModelSelection, GlossaryEntry, ManagedUser,
  MemberRole, Message, OneTimeCredential, PermissionInfo, PermissionKey,
  ReleaseInfo, ReleasePlatform, SearchHit, SelfUser, StoredFile, StorageUsage,
} from '@stellium/shared';

import { useStore } from '../state/store.js';
import { spracheDesSystems, translate, type TranslationKey } from '../i18n/kern.js';

/**
 * Meldungen dieser Ebene in der eingestellten Oberflächensprache.
 *
 * Über den Kern (i18n/kern.js), nicht über i18n/index.js: DAS lädt seinerseits
 * den Zustand, und weil der Zustand umgekehrt diese Datei einbindet, wäre ein
 * Ringschluss über zwei Module die Folge. Der Zustand selbst lässt sich davon
 * unabhängig gefahrlos direkt anfassen — genau wie state/store.ts es in
 * seiner eigenen ts()-Funktion vormacht: useStore.getState() liest nur beim
 * tatsächlichen Aufruf, nie beim Laden des Moduls, und entsteht dieser
 * Aufruf immer erst lange nach dem Start (bei einer fehlgeschlagenen
 * Anfrage), sind beide Module längst fertig geladen.
 *
 * Vorher stand hier spracheDesSystems() — die Sprache des RECHNERS, nicht die
 * eingestellte Oberflächensprache. Wer die Oberfläche bewusst auf Englisch
 * gestellt hat, aber an einem deutschen Rechner sitzt, bekam Verbindungs- und
 * Anmeldefehler mitten in der englischen Oberfläche auf Deutsch zu lesen. Vor
 * der Anmeldung ist self noch null, und der Rückfall auf spracheDesSystems()
 * greift dann von selbst — wie überall sonst im Haus auch.
 */
function txt(key: TranslationKey, werte?: Record<string, string | number>): string {
  return translate(useStore.getState().self?.uiLanguage || spracheDesSystems(), key, werte);
}

const STORAGE_SERVER = 'stellium.serverUrl';
const STORAGE_TOKEN = 'stellium.token';

export function serverUrl(): string {
  const gemerkt = localStorage.getItem(STORAGE_SERVER);
  if (gemerkt) return gemerkt;

  // Im Browser vom Server selbst geladen? Dann ist er auch der Server. Ohne
  // das müsste jede Person auf dem Telefon die Adresse abtippen, unter der
  // sie ohnehin gerade steht.
  if (typeof window !== 'undefined' && !window.stellium
      && /^https?:$/.test(window.location.protocol)
      && !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
    return window.location.origin;
  }

  return 'http://localhost:8787';
}
export function setServerUrl(url: string): void {
  localStorage.setItem(STORAGE_SERVER, url.replace(/\/+$/, ''));
}
export function token(): string | null {
  return localStorage.getItem(STORAGE_TOKEN);
}
export function setToken(value: string | null): void {
  if (value) localStorage.setItem(STORAGE_TOKEN, value);
  else localStorage.removeItem(STORAGE_TOKEN);
}

/**
 * Adresse für einen Abruf, den der Browser selbst macht — Bild, Download.
 * Solche Abrufe können keine Kopfzeilen mitschicken, deshalb geht der
 * Nachweis hier ausnahmsweise mit in die Adresse.
 */
/**
 * Den Text zu einer Fehlerkennung finden.
 *
 * Fehlt die Kennung im Wörterbuch, kommt der Text des Servers zurück. So
 * bleibt jede Meldung lesbar, auch wenn eine neue Serverfassung eine Kennung
 * schickt, die eine ältere App noch nicht kennt.
 */
function uebersetzterFehler(
  code: string | undefined, ersatz: string, werte?: Record<string, string>,
): string {
  if (!code) return ersatz;
  const uebersetzt = txt(code as Parameters<typeof txt>[0], werte);
  return uebersetzt && uebersetzt !== code ? uebersetzt : ersatz;
}

export function dateiUrl(pfad: string): string {
  const t = token();
  const basis = `${serverUrl()}${pfad}`;
  return t ? `${basis}${pfad.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : basis;
}

export function wsUrl(): string {
  const http = serverUrl();
  return `${http.replace(/^http/, 'ws')}/ws`;
}

/**
 * Absolute Adresse für Anhänge (der Server liefert relative Pfade).
 *
 * Führt bewusst über denselben Weg wie {@link dateiUrl}: seit der Server
 * Anhänge nur noch an Berechtigte ausliefert, braucht auch ein `<img src>`
 * den Nachweis in der Adresse. Zwei Wege für dieselbe Sache waren einer zu
 * viel — der ohne Nachweis lieferte nur noch 401.
 */
export function fileUrl(relative: string): string {
  return relative.startsWith('http') ? relative : dateiUrl(relative);
}

/**
 * Ein Fehler vom Server.
 *
 * Der Server antwortet auf Deutsch — er weiß nicht, welche Sprache am anderen
 * Ende eingestellt ist, und soll es auch nicht wissen müssen. Deshalb schickt
 * er zusätzlich eine Kennung wie 'fehler.loginFalsch'. Kennt die Oberfläche
 * sie, zeigt sie ihren eigenen Text; kennt sie sie nicht, bleibt der deutsche
 * Satz stehen — besser als eine leere Meldung.
 */
class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  // Nur wenn wirklich etwas mitgeht. Ein DELETE ohne Rumpf, aber mit
  // JSON-Kopfzeile, weist Fastify mit "Bad Request" ab, bevor die eigene
  // Behandlung überhaupt drankommt — Konten ließen sich deshalb nicht löschen.
  if (init.body !== undefined && init.body !== null && !(init.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }
  const t = token();
  if (t) headers.set('authorization', `Bearer ${t}`);

  let res: Response;
  try {
    res = await fetch(`${serverUrl()}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(txt('api.serverUnreachable', { adresse: serverUrl() }), 0);
  }

  if (!res.ok) {
    let message = txt('api.error', { status: res.status });
    let code: string | undefined;
    let werte: Record<string, string> | undefined;
    try {
      const rumpf = (await res.json()) as
        { error?: string; code?: string; werte?: Record<string, string> };
      message = rumpf.error ?? message;
      code = rumpf.code;
      werte = rumpf.werte;
    } catch { /* kein JSON */ }
    throw new ApiError(uebersetzterFehler(code, message, werte), res.status, code);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Was der Server nach einem Upload über die Datei zurückgibt. */
export interface Anhang {
  id: string; messageId: string | null; name: string; mime: string; size: number;
  url: string; width: number | null; height: number | null;
}

/**
 * Zusatzangaben zum Hochladen.
 *
 * `verschluesselt` ist keine Mitteilung an den Server — der sieht am Inhalt
 * selbst, was er bekommen hat. Es steuert nur, was die App sich hier sparen
 * kann: die Frage nach einer schon vorhandenen Datei. Bei Chiffrat kann sie
 * grundsätzlich nicht anschlagen, denn jeder Dateischlüssel ist Zufall und
 * dieselbe Datei sieht zweimal völlig anders aus. Die Prüfsumme trotzdem zu
 * rechnen hieße, eine große Datei ohne jede Aussicht einmal durchzulesen.
 */
export interface UploadWunsch {
  verschluesselt?: boolean;
}

/**
 * Prüfsumme einer Datei im Browser — in Stücken, damit auch große Dateien
 * nicht am Stück in den Speicher müssen.
 */
async function pruefsumme(file: File): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const puffer = await file.arrayBuffer();
    const roh = await crypto.subtle.digest('SHA-256', puffer);
    return [...new Uint8Array(roh)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/** Liegt die Datei schon auf dem Server? Dann gibt es sie sofort. */
async function schonDa(
  file: File,
  onProgress?: (anteil: number, bytes: number) => void,
): Promise<Anhang | null> {
  // Bei Kleinigkeiten kostet das Rechnen mehr, als es spart.
  if (file.size < 256 * 1024) return null;
  const summe = await pruefsumme(file);
  if (!summe) return null;
  try {
    const antwort = await request<{ bekannt: boolean; attachment?: Anhang }>('/api/uploads/bekannt', {
      method: 'POST',
      body: JSON.stringify({ sha256: summe, size: file.size, name: file.name, mime: file.type }),
    });
    if (antwort.bekannt && antwort.attachment) {
      onProgress?.(1, file.size);
      return antwort.attachment;
    }
  } catch { /* dann eben hochladen */ }
  return null;
}

/* ── Verkaufsstatistik: Formen der Antworten von services/gumroad.ts und
   services/patreon.ts auf dem Server ──────────────────────────────────
   Nicht aus @stellium/shared importiert — dieses Paket bündelt das
   Chat-Protokoll und Typen, die wirklich über beide Seiten hinweg geteilt
   werden (Nachrichten, Rechte). Diese Formen hier sind reine
   Verkauf-Auskünfte, dieselbe lokale Bauart wie schon patreonZugang() oben. */
export interface PatreonKennzahlen {
  stand: number;
  kampagneId: string;
  aktiveUnterstuetzer: number;
  deklinierteUnterstuetzer: number;
  ehemaligeUnterstuetzer: number;
  follower: number;
  monatlicheEinnahmenCents: number;
  waehrung: string | null;
  neuDiesenMonat: number;
  abgaengeDiesenMonat: null;
}

export interface PatreonMomentaufnahme {
  tag: string; aktive: number; deklination: number; ehemalig: number; follower: number;
  einnahmenCents: number; waehrung: string | null; neuDiesenMonat: number;
}

export interface GumroadUebersicht {
  stand: number;
  hatDaten: boolean;
  tokenVorhanden: boolean;
  waehrung: string;
  umsatz: {
    monatCent: number; zahlend: number; inProbe: number;
    aufteilung: { laufzeit: string; anzahl: number; monatCent: number }[];
  };
  abonnenten: {
    aktiv: number; probe: number; zahlend: number; gekuendigt: number; gescheitert: number;
    statusVerteilung: Record<string, number>;
  };
  verlauf: { monat: string; bruttoCent: number; nettoCent: number; anzahl: number }[];
  zuAbgaenge: { monat: string; neu: number; abgang: number }[];
  erstattungen: { anzahl: number; betragCent: number; teilweise: number };
  anfechtungen: { anzahl: number; betragCent: number };
  rueckbuchungen: { anzahl: number; betragCent: number };
  einmalig: { anzahl: number; bruttoCent: number };
  wiederkehrend: { anzahl: number; bruttoCent: number };
  auszahlungen: { status: string; waehrung: string | null; anzahl: number; summeRoh: number }[];
}

export const api = {
  health: () => request<{ ok: boolean; workspace: string; ai: AiCapabilities }>('/api/health'),

  login: (login: string, password: string) =>
    request<{ token: string; user: SelfUser }>('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ login, password }),
    }),

  me: () => request<{ user: SelfUser; ai: AiCapabilities }>('/api/me'),

  /** Ersteinrichtung nach dem Einmal-Passwort. */
  setup: (input: { handle?: string; email?: string; displayName?: string; newPassword: string }) =>
    request<{ user: SelfUser }>('/api/auth/setup', { method: 'POST', body: JSON.stringify(input) }),

  changePassword: (current: string, next: string) =>
    request<{ ok: boolean }>('/api/auth/password', {
      method: 'POST', body: JSON.stringify({ current, next }),
    }),

  /* ── Kontenverwaltung ─────────────────────────────────────── */

  permissionCatalogue: () => request<{ permissions: PermissionInfo[] }>('/api/permissions'),

  adminUsers: () => request<{ users: ManagedUser[] }>('/api/admin/users'),

  createUser: (input: { displayName: string; handle?: string; email?: string; role?: MemberRole; language?: string; timezone?: string }) =>
    request<{ credential: OneTimeCredential; users: ManagedUser[] }>('/api/admin/users', {
      method: 'POST', body: JSON.stringify(input),
    }),

  resetUserPassword: (userId: string) =>
    request<{ credential: OneTimeCredential; users: ManagedUser[] }>(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST', body: '{}',
    }),

  setUserRole: (userId: string, role: MemberRole) =>
    request<{ users: ManagedUser[] }>(`/api/admin/users/${userId}/role`, {
      method: 'POST', body: JSON.stringify({ role }),
    }),

  setUserPermission: (userId: string, permission: PermissionKey, allowed: boolean | null) =>
    request<{ users: ManagedUser[] }>(`/api/admin/users/${userId}/permission`, {
      method: 'POST', body: JSON.stringify({ permission, allowed }),
    }),

  setUserDisabled: (userId: string, disabled: boolean) =>
    request<{ users: ManagedUser[] }>(`/api/admin/users/${userId}/disabled`, {
      method: 'POST', body: JSON.stringify({ disabled }),
    }),

  deleteUser: (userId: string) =>
    request<{ users: ManagedUser[] }>(`/api/admin/users/${userId}`, { method: 'DELETE' }),

  search: (params: { q: string; channelId?: string | null; from?: string | null; files?: boolean }) => {
    const qs = new URLSearchParams({ q: params.q });
    if (params.channelId) qs.set('channelId', params.channelId);
    if (params.from) qs.set('from', params.from);
    if (params.files) qs.set('files', '1');
    return request<{ hits: SearchHit[] }>(`/api/search?${qs}`);
  },

  saved: () => request<{ messages: Message[] }>('/api/saved'),
  pins: (channelId: string) => request<{ messages: Message[] }>(`/api/channels/${channelId}/pins`),

  models: () => request<{ selection: AiModelSelection | null; models: AiModelInfo[] }>('/api/ai/models'),

  selectModels: (input: { quality?: string | null; fast?: string | null; auto?: boolean }) =>
    request<{ selection: AiModelSelection; ai: AiCapabilities }>('/api/ai/models', {
      method: 'POST', body: JSON.stringify(input),
    }),

  /** Anbieter umstellen — auch auf ein Modell im eigenen Netz. */
  selectProvider: (input: { anbieter: string | null; baseUrl?: string; model?: string; fastModel?: string }) =>
    request<{ ai: AiCapabilities; selection: AiModelSelection | null }>('/api/ai/provider', {
      method: 'POST', body: JSON.stringify(input),
    }),

  /** Nachsehen, ob unter der Adresse ein Modell antwortet. */
  checkLocal: (baseUrl: string) =>
    request<{ erreichbar: boolean; modelle: string[]; fehler: string | null }>('/api/ai/local-check', {
      method: 'POST', body: JSON.stringify({ baseUrl }),
    }),

  /** Ein Konto in eine andere Schublade legen. */
  setUserKategorie: (id: string, kategorie: string | null) =>
    request<{ users: ManagedUser[] }>(`/api/admin/users/${id}/kategorie`, {
      method: 'POST', body: JSON.stringify({ kategorie }),
    }),

  /**
   * Die Ablage holen — über HTTP und nicht über die Ereignisleitung.
   *
   * Der Unterschied ist nicht die Technik, sondern die Auskunft: dieser Weg
   * weiß, wer fragt, und gibt private Dateien deshalb nur ihrem Besitzer
   * heraus. Über die Leitung käme die Liste ohne Konto, und dort ließe sich
   * gar nicht entscheiden, wessen private Dateien dazugehören.
   */
  libraryFiles: (filter?: { channelId?: string; folder?: string }) => {
    const qs = new URLSearchParams();
    if (filter?.channelId) qs.set('channelId', filter.channelId);
    if (filter?.folder !== undefined) qs.set('folder', filter.folder);
    const anhang = qs.toString();
    return request<{ files: StoredFile[]; usage: StorageUsage }>(
      `/api/files${anhang ? `?${anhang}` : ''}`,
    );
  },

  glossary: () => request<{ entries: GlossaryEntry[] }>('/api/glossary'),
  addGlossary: (input: { term: string; translations: Record<string, string> | null; note?: string }) =>
    request<{ entries: GlossaryEntry[] }>('/api/glossary', { method: 'POST', body: JSON.stringify(input) }),
  removeGlossary: (id: string) =>
    request<{ entries: GlossaryEntry[] }>(`/api/glossary/${id}`, { method: 'DELETE' }),

  /**
   * Hochladen. Große Dateien gehen in mehreren Strömen gleichzeitig.
   *
   * Ein einzelner Strom bleibt auf einer Leitung mit Laufzeit weit unter dem,
   * was möglich ist — jede Bestätigung kostet eine halbe Runde, und das Fenster
   * wächst nur langsam. Vier Teile parallel füllen die Leitung deutlich besser.
   */
  uploadSchnell: async (
    file: File,
    onProgress?: (fraction: number, bytes: number) => void,
    wunsch?: UploadWunsch,
  ): Promise<{ attachment: Anhang }> => {
    /* Zuerst fragen, ob der Server die Datei schon hat. Das Rechnen der
       Prüfsumme dauert Millisekunden, das Übertragen Minuten — bei allem, was
       schon einmal geschickt wurde, ist der Upload danach sofort fertig.

       Bei verschlüsseltem Inhalt entfällt die Frage: dort ist nie etwas schon
       da (siehe UploadWunsch), und die Antwort dürfte es auch nicht sein. */
    const bekannt = wunsch?.verschluesselt ? null : await schonDa(file, onProgress);
    if (bekannt) return { attachment: bekannt };

    const GRENZE = 8 * 1024 * 1024;      // darunter lohnt der Aufwand nicht
    const TEILGROESSE = 4 * 1024 * 1024;
    const GLEICHZEITIG = 4;

    if (file.size <= GRENZE) {
      return api.upload(file, (anteil) => onProgress?.(anteil, Math.round(anteil * file.size)));
    }

    const teile = Math.ceil(file.size / TEILGROESSE);
    const { uploadId } = await request<{ uploadId: string }>('/api/uploads/start', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, mime: file.type, size: file.size, parts: teile }),
    });

    /* Fortschritt über alle Teile zusammen. Jeder Teil meldet für sich; die
       Summe ergibt den Balken. */
    const erledigt = new Array<number>(teile).fill(0);
    const melden = () => {
      const bytes = erledigt.reduce((a, b) => a + b, 0);
      onProgress?.(Math.min(1, bytes / file.size), bytes);
    };

    let naechster = 0;
    const arbeiter = async () => {
      for (;;) {
        const nummer = naechster++;
        if (nummer >= teile) return;
        const von = nummer * TEILGROESSE;
        const stueck = file.slice(von, Math.min(von + TEILGROESSE, file.size));
        await new Promise<void>((fertig, schief) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', `${serverUrl()}/api/uploads/${uploadId}/part/${nummer}`);
          const t = token();
          if (t) xhr.setRequestHeader('authorization', `Bearer ${t}`);
          xhr.setRequestHeader('content-type', 'application/octet-stream');
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            erledigt[nummer] = e.loaded;
            melden();
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              erledigt[nummer] = stueck.size;
              melden();
              fertig();
            } else {
              schief(new ApiError(`Teil ${nummer} fehlgeschlagen (${xhr.status})`, xhr.status));
            }
          };
          xhr.onerror = () => schief(new ApiError(`Teil ${nummer}: keine Verbindung`, 0));
          xhr.send(stueck);
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(GLEICHZEITIG, teile) }, arbeiter));
    return request<{ attachment: Anhang }>(`/api/uploads/${uploadId}/finish`, { method: 'POST' });
  },

  upload: async (file: File, onProgress?: (fraction: number) => void) => {
    const form = new FormData();
    form.append('file', file);

    // XHR statt fetch, weil nur XHR den Upload-Fortschritt meldet.
    return new Promise<{ attachment: Anhang }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${serverUrl()}/api/uploads`);
      const t = token();
      if (t) xhr.setRequestHeader('authorization', `Bearer ${t}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new ApiError(data.error ?? `Upload fehlgeschlagen (${xhr.status})`, xhr.status));
        } catch {
          reject(new ApiError(txt('api.badResponse'), xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError(txt('api.uploadNoConnection'), 0));
      xhr.send(form);
    });
  },

  /* ── Fernzugang zum Pi ───────────────────────────────────────
     `fernStand` sagt nur, OB etwas hinterlegt ist und ob man darf.
     `fernZugang` liefert Adresse und Passwort — und wird ausschließlich
     unmittelbar vor dem Verbinden gerufen. Der Rückgabewert geht direkt
     an den Hauptprozess und wird nirgends in den Zustand geschrieben,
     nirgends angezeigt und nirgends protokolliert. */
  /* Die Werte des Servers. `da: false` heißt nicht Fehler, sondern: auf
     diesem Rechner gibt es die Serverkonsole nicht. */
  system: () => request<{ da: boolean; werte?: unknown }>('/api/systemwerte'),

  /* Online-Zeit. `ich` steht für das eigene Konto — so braucht der Aufrufer
     die eigene Kennung nicht mitzuführen. */
  praesenz: (userId: string, zeitraum: 'heute' | 'woche' | 'monat' | 'jahr') =>
    request<{
      zeitraum: string;
      summen: Record<'heute' | 'woche' | 'monat' | 'jahr', number>;
      verlauf: { tag: string; sekunden: number }[];
    }>(`/api/praesenz/${encodeURIComponent(userId)}?zeitraum=${zeitraum}`),

  verkaufZugang: () => request<{ hinterlegt: boolean; verschluesselt: boolean }>('/api/verkauf/zugang'),
  verkaufZugangSetzen: (token: string) => request<{ hinterlegt: boolean }>(
    '/api/verkauf/zugang', { method: 'POST', body: JSON.stringify({ token }) }),

  /* Patreon: vier Werte statt einem, siehe verkaufzugang.ts auf dem Server.
     Nur die Client-ID kommt als echter Wert zurück — die anderen drei nur
     als "hinterlegt oder nicht". */
  patreonZugang: () => request<{
    hinterlegt: boolean; clientId: string | null; clientSecretHinterlegt: boolean;
    refreshTokenHinterlegt: boolean; ablaufAm: number | null; verschluesselt: boolean;
  }>('/api/verkauf/patreon'),
  patreonZugangSetzen: (werte: {
    clientId?: string; clientSecret?: string; accessToken?: string; refreshToken?: string;
  }) => request<{
    hinterlegt: boolean; clientId: string | null; clientSecretHinterlegt: boolean;
    refreshTokenHinterlegt: boolean; ablaufAm: number | null; verschluesselt: boolean;
  }>('/api/verkauf/patreon', { method: 'POST', body: JSON.stringify(werte) }),

  /* Zusätzlich zu patreonZugang(): ob die automatische Erneuerung zuletzt
     geklappt hat. Getrennter Aufruf, damit patreonZugang() (siehe
     verkaufzugang.ts auf dem Server) unangetastet bleibt. */
  patreonErneuerungsStand: () => request<{
    scope: string | null; letzterFehler: string | null;
    letzterVersuchAm: number | null; letzteErneuerungAm: number | null;
  }>('/api/verkauf/patreon/erneuerung'),

  /* Nur die Patreon-Zahlen selbst — für die kleine Zeile in der
     Verkaufskachel (SystemPanel.tsx). Dieselbe Route wie im Reiter
     "Schlüssel" käme in Frage, hat dort aber eine eigene Fehlerbehandlung
     (Diagnose); die Kachel braucht nur die nackten Zahlen oder gar nichts. */
  verkaufPatreonKennzahlen: () => request<PatreonKennzahlen>('/api/verkauf/patreon/kennzahlen'),

  /* Die ausführliche Ansicht (VerkaufDetailPanel.tsx) — ein Aufruf für
     Gumroad UND Patreon, siehe /api/verkauf/uebersicht auf dem Server. Beide
     Felder können unabhängig `null` sein: kein Fehler, sondern "dieser
     Anbieter ist nicht eingerichtet". */
  verkaufUebersicht: () => request<{
    gumroad: GumroadUebersicht | null;
    patreon: PatreonKennzahlen | null;
    patreonVerlauf: PatreonMomentaufnahme[];
  }>('/api/verkauf/uebersicht'),

  /* Postfach: dieselbe Trennung wie beim Fernzugang. Zurück kommt nur, DASS
     etwas hinterlegt ist — die Schlüssel selbst gibt der Server nie heraus,
     auch nicht an den, der sie eingetragen hat. */
  postZugang: () => request<{
    versandBereit: boolean; eingangBereit: boolean; verschluesselt: boolean;
    absender: string | null; name: string | null;
  }>('/api/post/zugang'),
  postZugangSetzen: (werte: {
    absender?: string; name?: string; versandSchluessel?: string; eingangGeheimnis?: string;
  }) => request<{ versandBereit: boolean; eingangBereit: boolean }>(
    '/api/post/zugang', { method: 'POST', body: JSON.stringify(werte) }),

  fernStand: () => request<{ hinterlegt: boolean; verschluesselt: boolean; kennung: string | null; darf: boolean }>('/api/fern/stand'),
  fernZugang: () => request<{ adresse: string; passwort: string; kennung: string }>('/api/fern/zugang'),
  fernZugangSetzen: (werte: { adresse?: string; passwort?: string; kennung?: string }) =>
    request<{ hinterlegt: boolean; verschluesselt: boolean; kennung: string | null }>(
      '/api/fern/zugang', { method: 'POST', body: JSON.stringify(werte) }),
  fernZugangLoeschen: () =>
    request<{ hinterlegt: boolean; verschluesselt: boolean; kennung: string | null }>(
      '/api/fern/zugang', { method: 'DELETE' }),

  releases: () => request<{ releases: ReleaseInfo[] }>('/api/releases'),
  removeRelease: (platform: ReleasePlatform) =>
    request<{ releases: ReleaseInfo[] }>(`/api/releases/${platform}`, { method: 'DELETE' }),

  /** Eine neue App-Version für eine Plattform bereitstellen. */
  publishRelease: (platform: ReleasePlatform, form: FormData) =>
    new Promise<{ release: ReleaseInfo; releases: ReleaseInfo[] }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${serverUrl()}/api/releases/${platform}`);
      const t = token();
      if (t) xhr.setRequestHeader('authorization', `Bearer ${t}`);
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new ApiError(data.error ?? `Upload fehlgeschlagen (${xhr.status})`, xhr.status));
        } catch {
          reject(new ApiError(txt('api.badResponse'), xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError(txt('api.uploadNoConnection'), 0));
      xhr.send(form);
    }),

  /** Ablage statt Anhang: die Datei landet in der Team-Dateiablage. */
  uploadToLibrary: (form: FormData, onProgress?: (fraction: number) => void) =>
    new Promise<{ file: StoredFile; usage: StorageUsage }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${serverUrl()}/api/files`);
      const t = token();
      if (t) xhr.setRequestHeader('authorization', `Bearer ${t}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new ApiError(data.error ?? `Upload fehlgeschlagen (${xhr.status})`, xhr.status));
        } catch {
          reject(new ApiError(txt('api.badResponse'), xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError(txt('api.uploadNoConnection'), 0));
      xhr.send(form);
    }),
};

export { ApiError };
