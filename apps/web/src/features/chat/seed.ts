// Seed data + view-model for the chat UI, ported from the reworked design (`~/Downloads`).
//
// IMPORTANT: `content` and image bytes here are DECRYPTED plaintext that exists ONLY in browser
// memory. In the live app they come from MLS decryption (`@argus/crypto`) after fetching opaque
// ciphertext from the crypto-blind server — the server never sees any of this. For now a local seed
// drives the UI; SENDING runs a real in-browser MLS round-trip (see ChatScreen + lib/mls.ts).
//
// Avatars are GENERATED offline (initials on a deterministic gradient, as data-URI SVGs) — no external
// image requests, replacing the design's stock-photo (Unsplash) avatars (privacy + offline PWA).

export type User = {
  id: string;
  name: string;
  avatar: string;
  isOnline: boolean;
};

// `sending`/`failed` extend the design's 3 states so the real MLS send can reflect progress + failure.
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export type Attachment = {
  id: string;
  type: 'image' | 'file';
  /** Renderable source: a generated data URI (seed) or a locally-decoded data URI. Never a server URL. */
  url: string;
  name: string;
  size?: string;
};

export type Message = {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
  status: MessageStatus;
  /** True once the message has been through a real MLS encrypt→decrypt round-trip (shows a lock). */
  encrypted?: boolean;
  attachments?: Attachment[];
};

export type Conversation = {
  id: string;
  type: 'direct' | 'group';
  name?: string;
  avatar?: string;
  participants: User[];
  messages: Message[];
  unreadCount: number;
};

function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

function escapeSvgText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** A generated, fully-offline avatar (gradient + initials) as a data-URI SVG — no external request. */
export function generatedAvatar(name: string): string {
  const hue = hueFromString(name);
  const c1 = `hsl(${hue} 45% 48%)`;
  const c2 = `hsl(${(hue + 40) % 360} 45% 34%)`;
  const label = escapeSvgText(initials(name));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>` +
    `<rect width="96" height="96" fill="url(#g)"/>` +
    `<text x="48" y="50" font-family="system-ui,-apple-system,sans-serif" font-size="38" font-weight="600" ` +
    `fill="rgba(255,255,255,0.92)" text-anchor="middle" dominant-baseline="central">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const SAFE_RASTER_AVATAR_DATA_URI =
  /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;
export const MAX_AVATAR_DATA_URI_LENGTH = 120_000;

export function safeAvatarSrc(src: string | undefined, fallbackName: string): string {
  const fallback = generatedAvatar(fallbackName);
  if (!src) return fallback;
  if (src === fallback) return src;
  if (src.length > MAX_AVATAR_DATA_URI_LENGTH) return fallback;
  return SAFE_RASTER_AVATAR_DATA_URI.test(src) ? src : fallback;
}

export const currentUser: User = {
  id: 'current-user',
  name: 'Alex Thompson',
  avatar: generatedAvatar('Alex Thompson'),
  isOnline: true,
};

function user(id: string, name: string, isOnline: boolean): User {
  return { id, name, isOnline, avatar: generatedAvatar(name) };
}

const sarah = user('user-1', 'Sarah Chen', true);
const marcus = user('user-2', 'Marcus Johnson', false);
const emily = user('user-3', 'Emily Davis', true);
const alexR = user('user-4', 'Alex Rivera', false);
const jordan = user('user-5', 'Jordan Kim', true);
const taylor = user('user-6', 'Taylor Smith', false);

export const users: User[] = [sarah, marcus, emily, alexR, jordan, taylor];

// Anchor the seed to app-load time so it always reads fresh ("45m ago"); relative formatting below
// uses the current clock, so both seeded and real sent messages age correctly as the app runs.
const BASE_TIME = Date.now();
const ago = (mins: number): Date => new Date(BASE_TIME - mins * 60_000);

export const conversations: Conversation[] = [
  {
    id: 'conv-1',
    type: 'direct',
    participants: [currentUser, sarah],
    unreadCount: 2,
    messages: [
      {
        id: 'msg-1-1',
        senderId: sarah.id,
        content: 'Hey! Did you see the new design mockups?',
        timestamp: ago(45),
        status: 'read',
      },
      {
        id: 'msg-1-2',
        senderId: currentUser.id,
        content: 'Yes! They look amazing. I especially love the color palette.',
        timestamp: ago(40),
        status: 'read',
        encrypted: true,
      },
      {
        id: 'msg-1-3',
        senderId: sarah.id,
        content: 'Right? The purple accents really tie everything together.',
        timestamp: ago(35),
        status: 'read',
      },
      {
        id: 'msg-1-4',
        senderId: sarah.id,
        content: 'I have some reference images I wanted to share with you',
        timestamp: ago(30),
        status: 'read',
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            url: generatedAvatar('Design Reference'),
            name: 'design-reference.png',
          },
        ],
      },
      {
        id: 'msg-1-5',
        senderId: currentUser.id,
        content: 'This is perfect! Can we schedule a call to discuss implementation?',
        timestamp: ago(25),
        status: 'read',
        encrypted: true,
      },
      {
        id: 'msg-1-6',
        senderId: sarah.id,
        content: 'Absolutely! How about tomorrow at 2pm?',
        timestamp: ago(5),
        status: 'read',
      },
      {
        id: 'msg-1-7',
        senderId: sarah.id,
        content: 'Let me know if that works for you!',
        timestamp: ago(2),
        status: 'delivered',
      },
    ],
  },
  {
    id: 'conv-2',
    type: 'group',
    name: 'Project Alpha',
    avatar: generatedAvatar('Project Alpha'),
    participants: [currentUser, marcus, emily, alexR],
    unreadCount: 5,
    messages: [
      {
        id: 'msg-2-1',
        senderId: marcus.id,
        content: 'Team, I have pushed the latest changes to the repo.',
        timestamp: ago(120),
        status: 'read',
      },
      {
        id: 'msg-2-2',
        senderId: emily.id,
        content: 'Great work Marcus! I will review it today.',
        timestamp: ago(100),
        status: 'read',
      },
      {
        id: 'msg-2-3',
        senderId: alexR.id,
        content: 'Here are the API docs for reference',
        timestamp: ago(90),
        status: 'read',
        attachments: [
          { id: 'att-2', type: 'file', url: '#', name: 'api-documentation.pdf', size: '2.4 MB' },
        ],
      },
      {
        id: 'msg-2-4',
        senderId: currentUser.id,
        content: 'Thanks Alex! This will be super helpful.',
        timestamp: ago(85),
        status: 'read',
        encrypted: true,
      },
      {
        id: 'msg-2-5',
        senderId: marcus.id,
        content: 'Can everyone join the standup in 10 minutes?',
        timestamp: ago(10),
        status: 'delivered',
      },
    ],
  },
  {
    id: 'conv-3',
    type: 'direct',
    participants: [currentUser, jordan],
    unreadCount: 0,
    messages: [
      {
        id: 'msg-3-1',
        senderId: currentUser.id,
        content: 'Hey Jordan, are you free for lunch today?',
        timestamp: ago(180),
        status: 'read',
        encrypted: true,
      },
      {
        id: 'msg-3-2',
        senderId: jordan.id,
        content: 'Sure! How about that new place downtown?',
        timestamp: ago(150),
        status: 'read',
      },
      {
        id: 'msg-3-3',
        senderId: currentUser.id,
        content: 'Perfect, see you at noon!',
        timestamp: ago(120),
        status: 'read',
        encrypted: true,
      },
    ],
  },
  {
    id: 'conv-4',
    type: 'direct',
    participants: [currentUser, taylor],
    unreadCount: 1,
    messages: [
      {
        id: 'msg-4-1',
        senderId: taylor.id,
        content: 'Did you get my email about the quarterly report?',
        timestamp: ago(300),
        status: 'read',
      },
      {
        id: 'msg-4-2',
        senderId: currentUser.id,
        content: 'Yes, I am reviewing it now. Looks good so far!',
        timestamp: ago(240),
        status: 'read',
        encrypted: true,
      },
      {
        id: 'msg-4-3',
        senderId: taylor.id,
        content: 'Great! Let me know if you need any clarifications.',
        timestamp: ago(30),
        status: 'delivered',
      },
    ],
  },
  {
    id: 'conv-5',
    type: 'group',
    name: 'Weekend Plans',
    avatar: generatedAvatar('Weekend Plans'),
    participants: [currentUser, sarah, jordan, taylor],
    unreadCount: 0,
    messages: [
      {
        id: 'msg-5-1',
        senderId: sarah.id,
        content: 'Anyone up for hiking this Saturday?',
        timestamp: ago(1440),
        status: 'read',
      },
      {
        id: 'msg-5-2',
        senderId: jordan.id,
        content: 'I am in! What trail are you thinking?',
        timestamp: ago(1380),
        status: 'read',
      },
      {
        id: 'msg-5-3',
        senderId: currentUser.id,
        content: 'Count me in too!',
        timestamp: ago(1320),
        status: 'read',
        encrypted: true,
      },
    ],
  },
  {
    id: 'conv-6',
    type: 'direct',
    participants: [currentUser, emily],
    unreadCount: 0,
    messages: [
      {
        id: 'msg-6-1',
        senderId: emily.id,
        content: 'Thanks for your help with the presentation!',
        timestamp: ago(2880),
        status: 'read',
      },
      {
        id: 'msg-6-2',
        senderId: currentUser.id,
        content: 'Anytime! It turned out great.',
        timestamp: ago(2820),
        status: 'read',
        encrypted: true,
      },
    ],
  },
];

export function getConversationDisplayName(
  conversation: Conversation,
  currentUserId: string,
): string {
  if (conversation.type === 'group' && conversation.name) return conversation.name;
  const other = conversation.participants.find((p) => p.id !== currentUserId);
  return other?.name || 'Unknown';
}

export function getConversationAvatar(conversation: Conversation, currentUserId: string): string {
  if (conversation.type === 'group' && conversation.avatar) return conversation.avatar;
  const other = conversation.participants.find((p) => p.id !== currentUserId);
  return other?.avatar || generatedAvatar('Unknown');
}

export function getOtherParticipant(
  conversation: Conversation,
  currentUserId: string,
): User | undefined {
  return conversation.participants.find((p) => p.id !== currentUserId);
}

export function formatMessageTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  const month = date.toLocaleString('en-US', { month: 'short' });
  return `${month} ${date.getDate()}`;
}

export function formatFullTime(date: Date): string {
  // Local time — timestamps are real (load-anchored seed + actual send time), so show the user's clock.
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}
