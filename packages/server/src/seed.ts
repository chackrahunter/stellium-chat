import { detectLanguage } from '@stellium/shared';
import { avatarColorFor, hashPassword } from './auth.js';
import { db, initDb, reindexMessage } from './db/index.js';
import { newId } from './util/id.js';

interface SeedUser {
  handle: string; displayName: string; email: string; language: string;
  timezone: string; title: string; role: 'owner' | 'admin' | 'member';
}

const USERS: SeedUser[] = [
  { handle: 'don',    displayName: 'Don-Calvin Kuhn', email: 'don@stellium.example',    language: 'de', timezone: 'Europe/Berlin',    title: 'Gründer',                role: 'owner'  },
  { handle: 'sarah',  displayName: 'Sarah Lindqvist',  email: 'sarah@stellium.example',  language: 'en', timezone: 'Europe/London',    title: 'Head of Product',        role: 'admin'  },
  { handle: 'yuki',   displayName: 'Yuki Tanaka',      email: 'yuki@stellium.example',   language: 'ja', timezone: 'Asia/Tokyo',       title: 'Backend Engineer',       role: 'member' },
  { handle: 'marta',  displayName: 'Marta Kowalska',   email: 'marta@stellium.example',  language: 'pl', timezone: 'Europe/Warsaw',    title: 'QA Lead',                role: 'member' },
  { handle: 'lucas',  displayName: 'Lucas Moreau',     email: 'lucas@stellium.example',  language: 'fr', timezone: 'Europe/Paris',     title: 'Designer',               role: 'member' },
  { handle: 'ana',    displayName: 'Ana Beltrán',      email: 'ana@stellium.example',    language: 'es', timezone: 'Europe/Madrid',    title: 'Customer Success',       role: 'member' },
];

const CHANNELS = [
  { name: 'allgemein',   topic: 'Alles, was das ganze Team angeht',            lang: 'de' },
  { name: 'engineering', topic: 'Builds, Deployments, Architektur',            lang: 'en' },
  { name: 'design',      topic: 'Mockups, Design-System, Feedback',            lang: 'en' },
  { name: 'support',     topic: 'Kundenanfragen und Eskalationen',             lang: 'en' },
  { name: 'zufaellig',   topic: 'Kaffee, Memes, Wochenendpläne',               lang: 'de' },
];

const GLOSSARY: { term: string; translations: Record<string, string> | null; note: string }[] = [
  { term: 'Stellium',      translations: null, note: 'Firmenname — bleibt in jeder Sprache gleich' },
  { term: 'Sternenkarte',  translations: { en: 'Star Map', fr: 'Carte stellaire', es: 'Mapa estelar', ja: 'スターマップ', pl: 'Mapa gwiazd' }, note: 'Unser Dashboard-Produkt' },
  { term: 'Orbit',         translations: null, note: 'Interner Name der Deployment-Pipeline' },
];

const CONVERSATION: { channel: string; handle: string; text: string; minutesAgo: number }[] = [
  { channel: 'allgemein', handle: 'don',   minutesAgo: 240, text: 'Guten Morgen zusammen! Kurze Info: ab heute läuft die Live-Übersetzung im Chat. Schreibt einfach in eurer Sprache.' },
  { channel: 'allgemein', handle: 'sarah', minutesAgo: 236, text: 'That is genuinely great news. I have been copy-pasting into a translator for weeks.' },
  { channel: 'allgemein', handle: 'yuki',  minutesAgo: 232, text: 'ありがとうございます！これで議論に参加しやすくなります。' },
  { channel: 'allgemein', handle: 'marta', minutesAgo: 228, text: 'Świetnie. Czy tłumaczenie działa też w wątkach?' },
  { channel: 'allgemein', handle: 'don',   minutesAgo: 225, text: 'Ja, in Threads und DMs genauso. Und du siehst immer das Original mit einem Klick.' },

  { channel: 'engineering', handle: 'yuki',  minutesAgo: 180, text: 'Orbit deploy for `api-gateway` finished. p95 latency dropped from 240ms to 130ms.' },
  { channel: 'engineering', handle: 'don',   minutesAgo: 176, text: 'Stark. Hast du die Änderung am Connection-Pool schon dokumentiert?' },
  { channel: 'engineering', handle: 'yuki',  minutesAgo: 170, text: 'Not yet — I will write it up in the runbook today.' },
  { channel: 'engineering', handle: 'marta', minutesAgo: 165, text: 'Znalazłam regresję w wyszukiwarce: zapytania z polskimi znakami nie zwracają wyników.' },
  { channel: 'engineering', handle: 'sarah', minutesAgo: 160, text: 'Can you file that as a blocker? We ship on Thursday.' },

  { channel: 'design', handle: 'lucas', minutesAgo: 120, text: "J'ai retravaillé la Carte stellaire : nouvelle hiérarchie typographique et des états de survol plus lisibles." },
  { channel: 'design', handle: 'sarah', minutesAgo: 115, text: 'The contrast on the secondary buttons still looks low to me. Can we bump it?' },
  { channel: 'design', handle: 'lucas', minutesAgo: 110, text: "Oui, je passe à un ratio de 4.5:1 minimum sur tous les boutons." },

  { channel: 'support', handle: 'ana',   minutesAgo: 90, text: 'Un cliente pregunta si Stellium admite inicio de sesión con SAML. ¿Alguien lo sabe?' },
  { channel: 'support', handle: 'sarah', minutesAgo: 85, text: 'SAML is on the roadmap for Q3. For now we support Google and Microsoft OAuth.' },
  { channel: 'support', handle: 'ana',   minutesAgo: 82, text: 'Perfecto, se lo comunico. Gracias.' },

  { channel: 'zufaellig', handle: 'marta', minutesAgo: 45, text: 'Ktoś ma ochotę na kawę o 15:00?' },
  { channel: 'zufaellig', handle: 'don',   minutesAgo: 42, text: 'Immer. Ich bin dabei ☕' },
  { channel: 'zufaellig', handle: 'lucas', minutesAgo: 40, text: 'Je vous rejoins avec plaisir.' },
];

const DEMO_PASSWORD = 'stellium2024';

export async function ensureSeed(): Promise<void> {
  if (db.get('SELECT 1 AS x FROM users LIMIT 1')) return;
  seed();
  console.log(`
  ✦ Demo-Arbeitsbereich angelegt
    Zugänge:  ${USERS.map((u) => u.handle).join(', ')}
    Passwort: ${DEMO_PASSWORD} (für alle Demo-Konten)
`);
}

export function seed(): void {
  const at = Date.now();
  const userIds = new Map<string, string>();

  db.transaction(() => {
    for (const u of USERS) {
      const id = newId('u_');
      userIds.set(u.handle, id);
      db.run(
        `INSERT INTO users (id, handle, email, display_name, password_hash, avatar_color, title, timezone, language,
                            auto_translate, status, role, theme, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,'offline',?, 'dark', ?)`,
        id, u.handle, u.email, u.displayName, hashPassword(DEMO_PASSWORD), avatarColorFor(u.handle),
        u.title, u.timezone, u.language, u.role, at,
      );
    }

    const owner = userIds.get('don')!;
    const channelIds = new Map<string, string>();

    for (const c of CHANNELS) {
      const id = newId('ch_');
      channelIds.set(c.name, id);
      db.run(
        `INSERT INTO channels (id, kind, name, topic, primary_language, archived, created_by, created_at)
         VALUES (?, 'public', ?, ?, ?, 0, ?, ?)`,
        id, c.name, c.topic, c.lang, owner, at,
      );
      for (const uid of userIds.values()) {
        db.run('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)', id, uid, at);
      }
    }

    for (const g of GLOSSARY) {
      db.run(
        'INSERT INTO glossary (id, term, translations, case_sensitive, note, created_by, created_at) VALUES (?,?,?,0,?,?,?)',
        newId('gl_'), g.term, g.translations ? JSON.stringify(g.translations) : null, g.note, owner, at,
      );
    }

    // Nachrichten in chronologischer Reihenfolge, damit die IDs sortierbar bleiben.
    const ordered = [...CONVERSATION].sort((a, b) => b.minutesAgo - a.minutesAgo);
    const created: string[] = [];
    for (const m of ordered) {
      const id = newId('m_');
      const ts = at - m.minutesAgo * 60_000;
      const lang = detectLanguage(m.text).lang;
      db.run(
        `INSERT INTO messages (id, channel_id, user_id, parent_id, text, source_lang, pinned, created_at)
         VALUES (?,?,?,NULL,?,?,0,?)`,
        id, channelIds.get(m.channel)!, userIds.get(m.handle)!, m.text,
        lang === 'unknown' ? null : lang, ts,
      );
      created.push(id);
    }

    // Jeder hat den Kanal bis vor ein paar Nachrichten gelesen — sonst wäre alles ungelesen.
    for (const [, chId] of channelIds) {
      const rows = db.all<{ id: string }>(
        'SELECT id FROM messages WHERE channel_id = ? ORDER BY created_at ASC', chId,
      );
      if (rows.length < 2) continue;
      const upTo = rows[Math.max(0, rows.length - 3)].id;
      for (const uid of userIds.values()) {
        db.run('UPDATE channel_members SET last_read_message_id = ? WHERE channel_id = ? AND user_id = ?', upTo, chId, uid);
      }
    }

    for (const id of created) reindexMessage(id);
  });
}

// Direkt ausführbar: npm run seed
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  initDb();
  if (db.get('SELECT 1 AS x FROM users LIMIT 1')) {
    console.log('Es gibt bereits Nutzer — Seed übersprungen. Lösche data/stellium.db für einen frischen Start.');
  } else {
    seed();
    console.log(`Demo-Daten angelegt. Login: don / ${DEMO_PASSWORD}`);
  }
}
