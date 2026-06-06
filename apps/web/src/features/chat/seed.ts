import type { Conversation, ImageAttachment } from './types';
import { ME } from './types';

// Local DEV seed so the chat UX can be built + reviewed before the live E2EE wiring (Phase-3 client
// loop) lands. None of this touches the server; in the real app this shape is produced by decrypting
// fetched ciphertext with @argus/crypto. No external URLs — images are generated inline (offline).

function gradientImage(hue: number): ImageAttachment['src'] {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='280' height='200'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${hue},70%,55%)'/>` +
    `<stop offset='1' stop-color='hsl(${(hue + 50) % 360},65%,40%)'/>` +
    `</linearGradient></defs><rect width='280' height='200' fill='url(#g)'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const m = 60_000;
const base = Date.now();

export const seedConversations: Conversation[] = [
  {
    id: 'conv-1',
    kind: 'direct',
    participants: [
      { id: ME, name: 'You', online: true },
      { id: 'u1', name: 'Sarah Chen', online: true },
    ],
    unread: 2,
    messages: [
      {
        id: 'm1',
        senderId: 'u1',
        body: 'Hey! Did you see the new design mockups?',
        sentAt: base - 45 * m,
        status: 'read',
      },
      {
        id: 'm2',
        senderId: ME,
        body: 'Yes! They look amazing — love the palette.',
        sentAt: base - 40 * m,
        status: 'read',
      },
      {
        id: 'm3',
        senderId: 'u1',
        body: 'Sharing a reference I had in mind:',
        sentAt: base - 30 * m,
        status: 'read',
        images: [{ id: 'img-1', src: gradientImage(280), alt: 'design reference' }],
      },
      {
        id: 'm4',
        senderId: ME,
        body: 'Perfect. Call tomorrow at 2pm to plan it?',
        sentAt: base - 25 * m,
        status: 'read',
      },
      {
        id: 'm5',
        senderId: 'u1',
        body: 'Works for me — talk then!',
        sentAt: base - 2 * m,
        status: 'delivered',
      },
    ],
  },
  {
    id: 'conv-2',
    kind: 'group',
    title: 'Project Alpha',
    participants: [
      { id: ME, name: 'You' },
      { id: 'u2', name: 'Marcus Johnson' },
      { id: 'u3', name: 'Emily Davis', online: true },
      { id: 'u4', name: 'Alex Rivera' },
    ],
    unread: 5,
    messages: [
      {
        id: 'm6',
        senderId: 'u2',
        body: 'Pushed the latest changes to the repo.',
        sentAt: base - 120 * m,
        status: 'read',
      },
      {
        id: 'm7',
        senderId: 'u3',
        body: 'Nice work — reviewing today.',
        sentAt: base - 100 * m,
        status: 'read',
      },
      {
        id: 'm8',
        senderId: ME,
        body: 'Thanks both, super helpful.',
        sentAt: base - 85 * m,
        status: 'read',
      },
      {
        id: 'm9',
        senderId: 'u2',
        body: 'Standup in 10?',
        sentAt: base - 10 * m,
        status: 'delivered',
      },
    ],
  },
  {
    id: 'conv-3',
    kind: 'direct',
    participants: [
      { id: ME, name: 'You' },
      { id: 'u5', name: 'Jordan Kim', online: true },
    ],
    unread: 0,
    messages: [
      {
        id: 'm10',
        senderId: ME,
        body: 'Free for lunch today?',
        sentAt: base - 180 * m,
        status: 'read',
      },
      {
        id: 'm11',
        senderId: 'u5',
        body: 'Sure — the new place downtown?',
        sentAt: base - 150 * m,
        status: 'read',
      },
      { id: 'm12', senderId: ME, body: 'Perfect, noon!', sentAt: base - 120 * m, status: 'read' },
    ],
  },
  {
    id: 'conv-4',
    kind: 'direct',
    participants: [
      { id: ME, name: 'You' },
      { id: 'u6', name: 'Taylor Smith' },
    ],
    unread: 1,
    messages: [
      {
        id: 'm13',
        senderId: 'u6',
        body: 'Did you get my note about the report?',
        sentAt: base - 300 * m,
        status: 'read',
      },
      {
        id: 'm14',
        senderId: ME,
        body: 'Reviewing now — looks good so far.',
        sentAt: base - 240 * m,
        status: 'read',
      },
      {
        id: 'm15',
        senderId: 'u6',
        body: 'Great, ping me with questions.',
        sentAt: base - 30 * m,
        status: 'delivered',
      },
    ],
  },
];
