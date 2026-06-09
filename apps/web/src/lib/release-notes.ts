export interface ReleaseNote {
  version: string;
  title: string;
  items: string[];
}

export const releaseNotes: ReleaseNote[] = [
  {
    version: 'v0.3.2',
    title: 'Settings release notes',
    items: [
      'Release notes now scroll inside their own box instead of moving the whole settings page.',
      'The release notes box fills the About panel with matching side and bottom margins.',
      'Version history now runs from v0.0.1 through v0.3.2.',
    ],
  },
  {
    version: 'v0.3.1',
    title: 'Settings polish',
    items: [
      'About copy now covers Android, iOS, iPadOS, macOS, and desktop PWA installs.',
      'The standalone About version footer was removed.',
      'The font-size preview updates live and no longer shows extra marker dots.',
    ],
  },
  {
    version: 'v0.3.0',
    title: 'UI consistency sweep',
    items: [
      'Chat menus share one floating surface style.',
      'Conversation panels use the same entry motion as other overlays.',
      'Mobile settings spacing was tightened at the screen edges.',
    ],
  },
  {
    version: 'v0.2.5',
    title: 'PWA update flow',
    items: [
      'About includes a manual check for installed app updates.',
      'New service-worker updates can prompt before restarting.',
      'Auth, API, WebSocket, and attachment requests stay out of runtime caches.',
    ],
  },
  {
    version: 'v0.2.4',
    title: 'Recovery UX',
    items: [
      'First-run recovery reminders stay local and dismissible.',
      'Recovery backup creation includes a client-only passphrase strength meter.',
      'Recovery copy makes clear that identity recovery does not restore past message history.',
    ],
  },
  {
    version: 'v0.2.3',
    title: 'A11y and responsive pass',
    items: [
      'Chat and settings landmarks have stronger Playwright coverage.',
      'Modal focus entry, focus return, and expanded states are covered.',
      'Desktop and mobile QA covers chat, settings, profile, composer, and route shells.',
    ],
  },
  {
    version: 'v0.2.2',
    title: 'Frontend safety baseline',
    items: [
      'Static PWA caching is explicit and narrow.',
      'Privacy-safe telemetry accepts only technical metadata and sends nothing by default.',
      'Bundle visibility and frontend hosting security notes are documented.',
    ],
  },
  {
    version: 'v0.2.1',
    title: 'Rate limiting and abuse protection',
    items: [
      'API throttling keys on the verified user and never on client-supplied identity.',
      'Abuse-prone mutation routes have tighter limits.',
      'WebSocket subscribe frames have their own per-socket cap.',
    ],
  },
  {
    version: 'v0.2.0',
    title: 'Encrypted attachment lifecycle',
    items: [
      'Encrypted attachment cleanup is handled by a least-privilege worker.',
      'Expired blobs are removed before their database rows.',
      'Attachment cleanup logs IDs and metadata only.',
    ],
  },
  {
    version: 'v0.1.9',
    title: 'Encrypted attachments',
    items: [
      'Images encrypt client-side before upload.',
      'Recipients request member-only download grants before decrypting locally.',
      'The server stores ciphertext refs and metadata only.',
    ],
  },
  {
    version: 'v0.1.8',
    title: 'Live E2EE messaging',
    items: [
      'The chat can send, fetch, and receive live encrypted messages.',
      'Messages are persisted locally in a sealed history log.',
      'WebSocket authentication happens in the first app frame, not in the URL.',
    ],
  },
  {
    version: 'v0.1.7',
    title: 'Installable PWA shell',
    items: [
      'The Vite app builds a manifest and service worker.',
      'The app shell uses local icons and avoids external image requests.',
      'Navigation fallback excludes auth, API, WebSocket, and presigned URL paths.',
    ],
  },
  {
    version: 'v0.1.6',
    title: 'API security hardening',
    items: [
      'Messaging and identity routes are documented in OpenAPI.',
      'The 42Crunch audit reached 100/100 for the documented API surface.',
      'Shared error envelopes keep route responses typed.',
    ],
  },
  {
    version: 'v0.1.5',
    title: 'Realtime delivery',
    items: [
      'WebSocket delivery forwards opaque ciphertext only.',
      'Offline catch-up fetches missed messages after reconnect.',
      'Redis backplane support exists for multi-instance fan-out.',
    ],
  },
  {
    version: 'v0.1.4',
    title: 'Client crypto foundation',
    items: [
      'MLS lives behind the shared crypto package.',
      'Device keys are generated client-side and sealed at rest.',
      'Recovery restores identity only, preserving the forward-secrecy model.',
    ],
  },
  {
    version: 'v0.1.3',
    title: 'Identity and tenancy',
    items: [
      'OIDC login works locally with Zitadel and PKCE.',
      'The API derives tenant context only from verified tokens.',
      '/me and the per-tenant user directory are RLS-scoped.',
    ],
  },
  {
    version: 'v0.1.2',
    title: 'Tenant isolation',
    items: [
      'Drizzle runs tenant work with a per-transaction tenant session variable.',
      'Tenants and users tables enforce row-level security.',
      'Audit events store IDs and metadata only.',
    ],
  },
  {
    version: 'v0.1.1',
    title: 'Chat decomposition',
    items: [
      'Chat state, message sending, WebSocket behavior, and history backfill were split apart.',
      'Crypto and live WebSocket behavior sit behind narrower hooks.',
      'Stable refs and callbacks reduce unnecessary chat rerenders.',
    ],
  },
  {
    version: 'v0.1.0',
    title: 'Browser persistence',
    items: [
      'Local records use versioned storage keys and safe JSON parsing.',
      'Corrupted Argus state can be wiped without touching unrelated browser data.',
      'Plaintext messages, keys, passphrases, tokens, presigned URLs, and decrypted attachments stay out of localStorage.',
    ],
  },
  {
    version: 'v0.0.5',
    title: 'Profile and settings boundary',
    items: [
      'The app UI remains passkey-first without username/password login controls.',
      'Argus profile fields stay local: generated ID, optional display name, and bounded avatar.',
      'Settings sections split into focused profile, security, privacy, notifications, appearance, storage, devices, and about surfaces.',
    ],
  },
  {
    version: 'v0.0.4',
    title: 'Route-owned shell',
    items: [
      '/chat remains the main product route.',
      'Settings, security, devices, and storage route shells were added.',
      'Route components own layout boundaries and avoid direct untyped backend calls.',
    ],
  },
  {
    version: 'v0.0.3',
    title: 'UI foundations',
    items: [
      'Design tokens define backgrounds, panels, borders, text, status colors, and accents.',
      'Reusable Button, IconButton, Modal, Avatar, and SettingsRow primitives were introduced.',
      'Purple remains the default accent while preserving the approved color list.',
    ],
  },
  {
    version: 'v0.0.2',
    title: 'Frontend verification',
    items: [
      'Playwright smoke tests cover chat, settings, mobile navigation, profile edits, and passkey-first auth.',
      'The frontend PR gate runs verification, waits for CI, and requests Codex review.',
      'Unresolved actionable Codex review threads block the gate.',
    ],
  },
  {
    version: 'v0.0.1',
    title: 'Frontend inventory',
    items: [
      'User-facing surfaces were inventoried and assigned owners.',
      'Real, placeholder, and backend-blocked pages were documented.',
      'The frontend roadmap established the shared baseline for follow-up work.',
    ],
  },
];
