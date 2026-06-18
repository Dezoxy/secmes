import {
  Archive,
  Bell,
  Command,
  Database,
  HardDrive,
  KeyRound,
  Lock,
  MessageSquare,
  Search,
  Settings,
  Shield,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface V2NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  target: string;
}

export const v2NavItems: V2NavItem[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, target: '/v2/chat' },
  { id: 'security', label: 'Security', icon: Shield, target: '/v2/security' },
  { id: 'devices', label: 'Devices', icon: HardDrive, target: '/v2/devices' },
  { id: 'settings', label: 'Settings', icon: Settings, target: '/v2/settings' },
];

export interface V2Conversation {
  id: string;
  name: string;
  initials: string;
  preview: string;
  time: string;
  status: 'verified' | 'pending' | 'quiet';
  unread?: number;
}

export const v2Conversations: V2Conversation[] = [
  {
    id: 'sarah',
    name: 'Sarah Chen',
    initials: 'SC',
    preview: 'Can you review the security copy?',
    time: '2m',
    status: 'verified',
    unread: 2,
  },
  {
    id: 'alpha',
    name: 'Project Alpha',
    initials: 'PA',
    preview: 'Room keys rotated after Jordan joined.',
    time: '14m',
    status: 'verified',
  },
  {
    id: 'legal',
    name: 'Legal review',
    initials: 'LR',
    preview: 'Waiting for device verification.',
    time: '1h',
    status: 'pending',
  },
  {
    id: 'ops',
    name: 'Operations',
    initials: 'OP',
    preview: 'Device verified.',
    time: '3h',
    status: 'quiet',
  },
];

export interface V2Message {
  id: string;
  author: 'self' | 'peer';
  body: string;
  time: string;
  state?: string;
}

export const v2Messages: V2Message[] = [
  {
    id: 'm1',
    author: 'peer',
    body: 'The new onboarding copy is ready. I kept the security caveat short.',
    time: '10:24',
  },
  {
    id: 'm2',
    author: 'self',
    body: 'Good. Keep the passkey step first, then link to transparency for the details.',
    time: '10:26',
    state: 'Delivered',
  },
  {
    id: 'm3',
    author: 'peer',
    body: 'Agreed. Should we show MLS and verified device in the header only?',
    time: '10:27',
  },
];

export const v2MessagesByConversation: Record<string, V2Message[]> = {
  sarah: v2Messages,
  alpha: [
    {
      id: 'alpha-1',
      author: 'peer',
      body: 'Jordan joined Project Alpha. I rotated the room keys after approval.',
      time: '09:44',
    },
    {
      id: 'alpha-2',
      author: 'self',
      body: 'Good. Keep the join event visible in the security timeline.',
      time: '09:48',
      state: 'Delivered',
    },
    {
      id: 'alpha-3',
      author: 'peer',
      body: 'Done. The old device can no longer receive new group messages.',
      time: '09:51',
    },
  ],
  legal: [
    {
      id: 'legal-1',
      author: 'peer',
      body: 'I opened the invite from a new browser. It is waiting for approval.',
      time: '08:12',
    },
    {
      id: 'legal-2',
      author: 'self',
      body: 'Do not share the code in this thread. Confirm it out of band first.',
      time: '08:14',
      state: 'Delivered',
    },
    {
      id: 'legal-3',
      author: 'peer',
      body: 'Understood. I will call before completing device verification.',
      time: '08:16',
    },
  ],
  ops: [
    {
      id: 'ops-1',
      author: 'peer',
      body: 'Device verified successfully.',
      time: '07:31',
    },
    {
      id: 'ops-2',
      author: 'self',
      body: 'Keep the retention note short and link to the transparency page.',
      time: '07:35',
      state: 'Delivered',
    },
  ],
};

export interface V2CommandAction {
  label: string;
  hint: string;
  icon: LucideIcon;
  target: string;
}

export const v2CommandActions: V2CommandAction[] = [
  { label: 'Jump to Sarah Chen', hint: 'Conversation', icon: Search, target: '/v2/chat' },
  { label: 'Verify contact', hint: 'Security', icon: Shield, target: '/v2/security' },
  { label: 'Open trusted devices', hint: 'Device', icon: HardDrive, target: '/v2/devices' },
  { label: 'Open storage controls', hint: 'Storage', icon: Database, target: '/v2/storage' },
];

export interface V2RouteSketch {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  description: string;
}

export const v2RouteSketches: V2RouteSketch[] = [
  {
    id: 'landing',
    label: 'Landing',
    path: '/',
    icon: Lock,
    description: 'Passkey-first entry with a minimal product preview.',
  },
  {
    id: 'chat',
    label: 'Chat',
    path: '/chat',
    icon: MessageSquare,
    description: 'Focused thread with command navigation and tiny security state.',
  },
  {
    id: 'settings',
    label: 'Settings',
    path: '/settings',
    icon: Settings,
    description: 'Sparse account controls with search-first navigation.',
  },
  {
    id: 'security',
    label: 'Security',
    path: '/security',
    icon: Shield,
    description: 'Recovery and verification controls without dashboard weight.',
  },
  {
    id: 'devices',
    label: 'Devices',
    path: '/devices',
    icon: HardDrive,
    description: 'Trusted browser/device list and approval states.',
  },
  {
    id: 'storage',
    label: 'Storage',
    path: '/storage',
    icon: Database,
    description: 'Encrypted local cache and attachment storage controls.',
  },
  {
    id: 'invite',
    label: 'Invite',
    path: '/invite',
    icon: Users,
    description: 'Invite handoff before workspace binding.',
  },
  {
    id: 'callback',
    label: 'Auth callback',
    path: '/auth/callback',
    icon: KeyRound,
    description: 'Minimal secure redirect completion state.',
  },
  {
    id: 'transparency',
    label: 'Transparency',
    path: '/transparency',
    icon: Archive,
    description: 'Public trust center for crypto model and code delivery caveat.',
  },
];

export const v2SettingsRows = [
  { label: 'Profile', value: 'Display name, avatar, account identifier', icon: Settings },
  { label: 'Security', value: 'Passkey unlock, safety checks', icon: Shield },
  { label: 'Notifications', value: 'Quiet hours and push behavior', icon: Bell },
  { label: 'Data & storage', value: 'Encrypted local cache controls', icon: Database },
];

export const v2TrustFacts = [
  'Crypto-blind server',
  'MLS active',
  'Verified device',
  'EU storage',
] as const;

export const v2CommandHint = {
  icon: Command,
  label: 'Search or jump to conversation',
} as const;
