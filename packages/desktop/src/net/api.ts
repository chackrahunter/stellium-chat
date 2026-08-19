import type {
  AiCapabilities, AiModelInfo, AiModelSelection, GlossaryEntry, ManagedUser,
  MemberRole, Message, OneTimeCredential, PermissionInfo, PermissionKey,
  ReleaseInfo, ReleasePlatform, SearchHit, SelfUser, StoredFile, StorageUsage,
} from '@stellium/shared';

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
export function dateiUrl(pfad: string): string {
  const t = token();
  const basis = `${serverUrl()}${pfad}`;
  return t ? `${basis}${pfad.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : basis;
}

export function wsUrl(): string {
  const http = serverUrl();
  return `${http.replace(/^http/, 'ws')}/ws`;
}

/** Absolute URL für Anhänge (der Server liefert relative Pfade). */
export function fileUrl(relative: string): string {
  return relative.startsWith('http') ? relative : `${serverUrl()}${relative}`;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  const t = token();
  if (t) headers.set('authorization', `Bearer ${t}`);

  let res: Response;
  try {
    res = await fetch(`${serverUrl()}${path}`, { ...init, headers });
  } catch {
    throw new ApiError('Server nicht erreichbar. Läuft er unter ' + serverUrl() + '?', 0);
  }

  if (!res.ok) {
    let message = `Fehler ${res.status}`;
    try { message = ((await res.json()) as { error?: string }).error ?? message; } catch { /* kein JSON */ }
    throw new ApiError(message, res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
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

  glossary: () => request<{ entries: GlossaryEntry[] }>('/api/glossary'),
  addGlossary: (input: { term: string; translations: Record<string, string> | null; note?: string }) =>
    request<{ entries: GlossaryEntry[] }>('/api/glossary', { method: 'POST', body: JSON.stringify(input) }),
  removeGlossary: (id: string) =>
    request<{ entries: GlossaryEntry[] }>(`/api/glossary/${id}`, { method: 'DELETE' }),

  upload: async (file: File, onProgress?: (fraction: number) => void) => {
    const form = new FormData();
    form.append('file', file);

    // XHR statt fetch, weil nur XHR den Upload-Fortschritt meldet.
    return new Promise<{ attachment: { id: string; name: string; mime: string; size: number; url: string; width: number | null; height: number | null } }>((resolve, reject) => {
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
          reject(new ApiError('Ungültige Serverantwort beim Upload', xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError('Upload fehlgeschlagen — keine Verbindung', 0));
      xhr.send(form);
    });
  },

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
          reject(new ApiError('Ungültige Serverantwort beim Upload', xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError('Upload fehlgeschlagen — keine Verbindung', 0));
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
          reject(new ApiError('Ungültige Serverantwort beim Upload', xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError('Upload fehlgeschlagen — keine Verbindung', 0));
      xhr.send(form);
    }),
};

export { ApiError };
