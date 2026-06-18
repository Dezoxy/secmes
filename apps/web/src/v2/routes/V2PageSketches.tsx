import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Copy,
  Database,
  FileKey,
  Fingerprint,
  HardDrive,
  KeyRound,
  Lock,
  Mail,
  RefreshCw,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { joinClasses, v2ClassNames } from '../design/tokens';
import { v2RouteSketches, v2SettingsRows, v2TrustFacts } from '../mocks/sketch-data';
import { V2AsidePanel, V2Badge, V2CommandBar, V2FactRow, V2SketchShell } from '../shell/V2Shell';
import { V2ChatSketch } from '../chat/V2ChatSketch';

const storageCards: Array<{
  id: string;
  title: string;
  body: string;
  detail: string;
  icon: LucideIcon;
}> = [
  {
    id: 'cache',
    title: 'Local cache',
    body: 'Encrypted browser state only',
    detail: 'Message bodies stay in local encrypted state. Server records remain ciphertext.',
    icon: Database,
  },
  {
    id: 'attachments',
    title: 'Attachments',
    body: 'Ciphertext blobs in object storage',
    detail:
      'Uploads should expose file names, sizes, and delivery state without revealing content.',
    icon: Lock,
  },
  {
    id: 'cleanup',
    title: 'Cleanup',
    body: 'Future per-device purge controls',
    detail: 'Local purge should be explicit, reversible only through recovery, and device scoped.',
    icon: RefreshCw,
  },
];

const deviceRows = [
  ['macbook', 'MacBook Pro', 'Current browser - last seen now', 'Verified'],
  ['iphone', 'iPhone PWA', 'Last seen yesterday', 'Verified'],
  ['browser', 'New browser', 'Waiting for approval code', 'Pending'],
] as const;

function V2SectionCard({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={joinClasses('rounded-2xl p-5', v2ClassNames.panel, className)}>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function V2RouteIndex() {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {v2RouteSketches.map(({ id, label, path, icon: Icon, description }) => (
        <Link
          key={id}
          to={`/v2/${id}`}
          className={joinClasses(
            'group rounded-2xl p-4 transition-colors hover:border-teal-300/18 hover:bg-[#151a20]',
            v2ClassNames.panel,
            v2ClassNames.focus,
          )}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.04] text-white/56 transition-colors group-hover:text-teal-100">
              <Icon className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">{label}</p>
              <p className="text-xs text-white/36">{path}</p>
            </div>
          </div>
          <p className="mt-3 text-sm leading-6 text-white/52">{description}</p>
          <span className="mt-4 inline-flex items-center gap-2 text-xs font-medium text-teal-200/78">
            Open sketch
            <ArrowRight className="h-3.5 w-3.5" />
          </span>
        </Link>
      ))}
    </div>
  );
}

export function V2LandingSketch() {
  return (
    <section className={v2ClassNames.page} aria-label="Landing v2 sketch">
      <div className="mx-auto grid min-h-screen w-full max-w-7xl grid-cols-1 gap-10 px-6 py-8 lg:grid-cols-[0.9fr_1.1fr] lg:px-10">
        <div className="flex flex-col justify-between">
          <header className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-sm font-semibold">
              A
            </div>
            <span className="text-sm font-semibold tracking-[0.18em] text-white/86">ARGUS</span>
          </header>

          <main className="max-w-xl py-16">
            <V2Badge tone="verified">
              <Check className="h-3.5 w-3.5" />
              Crypto-blind by design
            </V2Badge>
            <h1 className="mt-6 text-5xl font-semibold tracking-tight text-white">
              Private team messaging, sealed end to end.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-white/56">
              A sparse messenger for sensitive work. Passkey entry, verified devices, and MLS state
              stay visible without making the interface noisy.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/v2/chat"
                className={joinClasses(
                  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-teal-300 px-4 text-sm font-semibold text-[#07100f]',
                  v2ClassNames.focus,
                )}
              >
                <Fingerprint className="h-4 w-4" />
                Continue with passkey
              </Link>
              <Link
                to="/v2/transparency"
                className={joinClasses(
                  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/[0.08] px-4 text-sm font-medium text-white/66 hover:bg-white/[0.04]',
                  v2ClassNames.focus,
                )}
              >
                Security & transparency
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-2">
              {v2TrustFacts.map((fact) => (
                <V2Badge key={fact}>{fact}</V2Badge>
              ))}
            </div>
          </main>
        </div>

        <div className="flex items-center">
          <div
            className={joinClasses(
              'w-full rounded-3xl p-4 shadow-2xl shadow-black/30',
              v2ClassNames.panel,
            )}
          >
            <div className="mb-4">
              <V2CommandBar />
            </div>
            <div className="grid min-h-[36rem] grid-cols-[16rem_minmax(0,1fr)] overflow-hidden rounded-2xl border border-white/[0.06]">
              <div className="border-r border-white/[0.06] bg-[#0d1014] p-4">
                <p className="mb-3 text-xs uppercase tracking-[0.12em] text-white/34">Recent</p>
                {['Sarah Chen', 'Project Alpha', 'Legal review'].map((name, index) => (
                  <div
                    key={name}
                    className={joinClasses(
                      'flex items-center gap-3 border-b border-white/[0.05] py-3',
                      index === 0 && 'text-teal-100',
                    )}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.05] text-xs font-semibold">
                      {name
                        .split(' ')
                        .map((part) => part[0])
                        .join('')}
                    </span>
                    <span className="text-sm">{name}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col bg-[#0b0d10]">
                <div className="border-b border-white/[0.06] p-4">
                  <p className="text-sm font-semibold text-white">Sarah Chen</p>
                  <div className="mt-2 flex gap-2">
                    <V2Badge tone="verified">Verified</V2Badge>
                    <V2Badge>MLS</V2Badge>
                  </div>
                </div>
                <div className="flex-1 space-y-4 p-5">
                  <div className="max-w-md rounded-2xl border border-white/[0.07] bg-white/[0.04] px-4 py-3 text-sm text-white/78">
                    Security copy is ready for review.
                  </div>
                  <div className="ml-auto max-w-md rounded-2xl bg-teal-300 px-4 py-3 text-sm text-[#07100f]">
                    Keep the caveat short and link to transparency.
                  </div>
                </div>
                <div className="border-t border-white/[0.06] p-4">
                  <div className="rounded-xl border border-white/[0.07] bg-[#111418] px-4 py-3 text-sm text-white/36">
                    Message Sarah Chen
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function V2SettingsSketch() {
  const [selectedSetting, setSelectedSetting] = useState(v2SettingsRows[0]?.label ?? 'Profile');
  const selectedRow = useMemo(
    () => v2SettingsRows.find((row) => row.label === selectedSetting) ?? v2SettingsRows[0]!,
    [selectedSetting],
  );

  return (
    <V2SketchShell
      active="settings"
      title="Settings"
      subtitle="A search-first sketch for the existing /settings route."
      aside={
        <V2AsidePanel title="Settings command ideas">
          <V2FactRow label="Jump by intent" value="Type privacy, storage, profile, or recovery." />
          <V2FactRow
            label="Device scoped"
            value="Changes apply to this browser unless server-backed."
          />
        </V2AsidePanel>
      }
    >
      <div className="grid gap-4 px-4 py-6 md:px-6 md:py-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <V2SectionCard title="Account controls">
          <div className="divide-y divide-white/[0.06]">
            {v2SettingsRows.map(({ label, value, icon: Icon }) => (
              <button
                key={label}
                type="button"
                onClick={() => setSelectedSetting(label)}
                aria-pressed={selectedSetting === label}
                className={joinClasses(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-4 text-left transition-colors hover:bg-white/[0.035]',
                  selectedSetting === label && 'bg-teal-300/[0.07]',
                  v2ClassNames.focus,
                )}
              >
                <Icon className="h-4 w-4 text-white/36" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-white/86">{label}</span>
                  <span className="mt-0.5 block text-sm text-white/45">{value}</span>
                </span>
                <ArrowRight className="h-4 w-4 text-white/30" />
              </button>
            ))}
          </div>
        </V2SectionCard>
        <V2SectionCard title={selectedRow.label}>
          <p className="text-sm leading-6 text-white/52">{selectedRow.value}</p>
          <div className="mt-5 space-y-3">
            <V2FactRow label="State" value="Selected locally in the v2 sketch." tone="verified" />
            <V2FactRow
              label="Pattern"
              value="Rows expose intent first, then a narrow detail pane."
            />
          </div>
        </V2SectionCard>
      </div>
    </V2SketchShell>
  );
}

export function V2SecuritySketch() {
  const [activePanel, setActivePanel] = useState<'unlock' | 'verification'>('unlock');
  const securityPanels = {
    unlock: {
      title: 'Unlocked by your passkey',
      body: 'The keystore is sealed under a per-passkey PRF key — no passphrase, nothing to back up. A lost passkey means a fresh start with a new registration code from the admin.',
      icon: FileKey,
      tone: 'text-teal-200',
      facts: ['Passkey PRF unlock', 'No recovery file', 'No plaintext leaves the browser'],
    },
    verification: {
      title: 'Safety numbers',
      body: 'Contact verification appears in the thread header and command actions, without turning chat into an admin dashboard.',
      icon: Shield,
      tone: 'text-emerald-200',
      facts: ['Manual trust check', 'Visible in thread', 'Device scoped decision'],
    },
  } as const;
  const panel = securityPanels[activePanel];
  const PanelIcon = panel.icon;
  const securityModes: Array<{
    id: 'unlock' | 'verification';
    label: string;
    icon: LucideIcon;
  }> = [
    { id: 'unlock', label: 'Unlock', icon: FileKey },
    { id: 'verification', label: 'Verification', icon: Shield },
  ];

  return (
    <V2SketchShell
      active="security"
      title="Security"
      subtitle="Passkey unlock, verification, and device trust for the existing /security route."
      aside={
        <V2AsidePanel title="Security states">
          <V2FactRow
            label="Passkey login"
            value="Discoverable passkey, no password."
            tone="verified"
          />
        </V2AsidePanel>
      }
    >
      <div className="grid gap-4 px-4 py-6 md:px-6 md:py-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <V2SectionCard title="Security modes">
          <div className="space-y-2">
            {securityModes.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActivePanel(id)}
                aria-pressed={activePanel === id}
                className={joinClasses(
                  'flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                  activePanel === id
                    ? 'border-teal-300/18 bg-teal-300/[0.07] text-white'
                    : 'border-white/[0.06] bg-white/[0.025] text-white/56 hover:bg-white/[0.04]',
                  v2ClassNames.focus,
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="text-sm font-medium">{label}</span>
              </button>
            ))}
          </div>
        </V2SectionCard>
        <V2SectionCard title={panel.title}>
          <div className="flex items-start gap-4">
            <PanelIcon className={joinClasses('mt-1 h-5 w-5', panel.tone)} />
            <div>
              <p className="text-sm leading-6 text-white/52">{panel.body}</p>
              <div className="mt-5 grid gap-2 sm:grid-cols-3">
                {panel.facts.map((fact) => (
                  <div
                    key={fact}
                    className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-xs text-white/52"
                  >
                    {fact}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </V2SectionCard>
      </div>
    </V2SketchShell>
  );
}

export function V2DevicesSketch() {
  const [selectedDeviceId, setSelectedDeviceId] =
    useState<(typeof deviceRows)[number][0]>('macbook');
  const selectedDevice = deviceRows.find(([id]) => id === selectedDeviceId) ?? deviceRows[0]!;
  const [, selectedName, selectedMeta, selectedState] = selectedDevice;

  return (
    <V2SketchShell
      active="devices"
      title="Devices"
      subtitle="Trusted browsers and enrollment states for the existing /devices route."
      aside={
        <V2AsidePanel title="Approval model">
          <V2FactRow label="Current browser" value="Trusted and unlocked." tone="verified" />
          <V2FactRow label="New device" value="Requires code confirmation." tone="warning" />
        </V2AsidePanel>
      }
    >
      <div className="grid gap-4 px-4 py-6 md:px-6 md:py-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <V2SectionCard title="Trusted devices">
          <div className="divide-y divide-white/[0.06]">
            {deviceRows.map(([id, name, meta, state]) => (
              <button
                key={id}
                type="button"
                onClick={() => setSelectedDeviceId(id)}
                aria-pressed={selectedDeviceId === id}
                className={joinClasses(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-4 text-left transition-colors hover:bg-white/[0.035]',
                  selectedDeviceId === id && 'bg-teal-300/[0.07]',
                  v2ClassNames.focus,
                )}
              >
                <HardDrive className="h-4 w-4 text-white/36" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white/86">{name}</p>
                  <p className="mt-0.5 text-sm text-white/45">{meta}</p>
                </div>
                <V2Badge tone={state === 'Pending' ? 'warning' : 'verified'}>{state}</V2Badge>
              </button>
            ))}
          </div>
        </V2SectionCard>
        <V2SectionCard title={selectedName}>
          <div className="space-y-3">
            <V2FactRow
              label="Trust state"
              value={
                selectedState === 'Pending'
                  ? 'Needs code confirmation.'
                  : 'Allowed to unlock local state.'
              }
              tone={selectedState === 'Pending' ? 'warning' : 'verified'}
            />
            <V2FactRow label="Last activity" value={selectedMeta} />
            <button
              type="button"
              className={joinClasses(
                'inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/[0.08] px-3 text-sm font-medium text-white/62 hover:bg-white/[0.04]',
                v2ClassNames.focus,
              )}
            >
              Review device
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </V2SectionCard>
      </div>
    </V2SketchShell>
  );
}

export function V2StorageSketch() {
  const [activeStorageId, setActiveStorageId] = useState(storageCards[0]?.id ?? 'cache');
  const [cleanupQueued, setCleanupQueued] = useState(false);
  const activeStorage =
    storageCards.find((card) => card.id === activeStorageId) ?? storageCards[0]!;
  const ActiveStorageIcon = activeStorage.icon;

  return (
    <V2SketchShell
      active="settings"
      title="Storage"
      subtitle="Encrypted local state sketch for the existing /storage route."
      aside={
        <V2AsidePanel title="Storage rules">
          <V2FactRow label="Plaintext" value="Never stored server-side." tone="verified" />
          <V2FactRow label="Attachments" value="Encrypted before upload." tone="verified" />
        </V2AsidePanel>
      }
    >
      <div className="grid gap-4 px-4 py-6 md:px-6 md:py-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-1">
          {storageCards.map(({ id, title, body, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveStorageId(id)}
              aria-pressed={activeStorageId === id}
              className={joinClasses(
                'rounded-2xl border p-5 text-left transition-colors hover:border-teal-300/18 hover:bg-[#151a20]',
                activeStorageId === id
                  ? 'border-teal-300/18 bg-teal-300/[0.06]'
                  : 'border-white/[0.07] bg-[#111418]',
                v2ClassNames.focus,
              )}
            >
              <h2 className="text-sm font-semibold text-white">{title}</h2>
              <Icon className="mb-4 h-5 w-5 text-teal-200" />
              <p className="text-sm leading-6 text-white/48">{body}</p>
            </button>
          ))}
        </div>
        <V2SectionCard title={activeStorage.title}>
          <ActiveStorageIcon className="mb-4 h-5 w-5 text-teal-200" />
          <p className="text-sm leading-6 text-white/52">{activeStorage.detail}</p>
          <div className="mt-5 space-y-3">
            <V2FactRow
              label="Server visibility"
              value="Metadata only; content remains opaque."
              tone="verified"
            />
            <V2FactRow
              label="Cleanup state"
              value={cleanupQueued ? 'Local cleanup queued in this sketch.' : 'No cleanup queued.'}
              tone={cleanupQueued ? 'warning' : 'neutral'}
            />
          </div>
          <button
            type="button"
            onClick={() => setCleanupQueued((value) => !value)}
            className={joinClasses(
              'mt-5 inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/[0.08] px-3 text-sm font-medium text-white/62 hover:bg-white/[0.04]',
              v2ClassNames.focus,
            )}
          >
            <RefreshCw className="h-4 w-4" />
            {cleanupQueued ? 'Cancel cleanup' : 'Queue cleanup'}
          </button>
        </V2SectionCard>
      </div>
    </V2SketchShell>
  );
}

export function V2InviteSketch() {
  const [inviteAccepted, setInviteAccepted] = useState(false);

  return (
    <section className={v2ClassNames.page} aria-label="Invite v2 sketch">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-6">
        <div className={joinClasses('rounded-3xl p-6', v2ClassNames.panel)}>
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-300/12 text-teal-200">
            <Mail className="h-5 w-5" />
          </div>
          <h1 className="mt-6 text-2xl font-semibold text-white">Open workspace invite</h1>
          <p className="mt-3 text-sm leading-6 text-white/52">
            Sign in with your passkey, then Argus will bind this invite token locally before opening
            onboarding.
          </p>
          {inviteAccepted && (
            <div className="mt-5">
              <V2FactRow
                label="Invite ready"
                value="Workspace binding would continue after passkey sign-in."
                tone="verified"
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => setInviteAccepted(true)}
            className={joinClasses(
              'mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-300 px-4 text-sm font-semibold text-[#07100f]',
              v2ClassNames.focus,
            )}
          >
            {inviteAccepted ? 'Continue to sign-in' : 'Continue'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}

export function V2AuthCallbackSketch() {
  const [completed, setCompleted] = useState(false);

  return (
    <section className={v2ClassNames.page} aria-label="Auth callback v2 sketch">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6">
        <div className={joinClasses('rounded-3xl p-6', v2ClassNames.panel)}>
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.16em] text-white/36">
            ARGUS
          </p>
          <KeyRound className="h-6 w-6 text-teal-200" />
          <h1 className="mt-5 text-xl font-semibold text-white">Completing sign-in</h1>
          <p className="mt-2 text-sm leading-6 text-white/50">
            {completed
              ? 'Redirect accepted. The app can now open the encrypted local session.'
              : 'Finishing the secure redirect. If this fails, return to the passkey entry screen.'}
          </p>
          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
            <div
              className={joinClasses(
                'h-full rounded-full bg-teal-300 transition-all',
                completed ? 'w-full' : 'w-2/3',
              )}
            />
          </div>
          <button
            type="button"
            onClick={() => setCompleted(true)}
            className={joinClasses(
              'mt-6 inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/[0.08] px-3 text-sm font-medium text-white/62 hover:bg-white/[0.04]',
              v2ClassNames.focus,
            )}
          >
            Complete sketch state
            <Check className="h-4 w-4" />
          </button>
        </div>
      </div>
    </section>
  );
}

export function V2TransparencySketch() {
  const [copiedDigest, setCopiedDigest] = useState(false);

  return (
    <section className={v2ClassNames.page} aria-label="Transparency v2 sketch">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <header className="mb-10 flex items-center justify-between gap-4 border-b border-white/[0.07] pb-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/36">ARGUS</p>
            <h1 className="mt-2 text-3xl font-semibold text-white">Security & transparency</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/52">
              A concise public trust center for the cryptography model, code-delivery caveat, and
              infrastructure residency.
            </p>
          </div>
          <V2Badge tone="verified">Public trust center</V2Badge>
        </header>
        <div className="grid gap-4 md:grid-cols-3">
          <V2SectionCard title="Crypto model">
            <p className="text-sm leading-6 text-white/50">
              Server stores and forwards ciphertext only. MLS runs in the browser.
            </p>
          </V2SectionCard>
          <V2SectionCard title="Bundle digest">
            <button
              type="button"
              onClick={() => setCopiedDigest(true)}
              className={joinClasses(
                'flex w-full items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-left font-mono text-xs text-white/56 hover:bg-white/[0.04]',
                v2ClassNames.focus,
              )}
            >
              {copiedDigest ? 'sha384 copied' : 'sha384'}
              <Copy className="ml-auto h-3.5 w-3.5 text-white/32" />
            </button>
          </V2SectionCard>
          <V2SectionCard title="Data residency">
            <p className="text-sm leading-6 text-white/50">
              EU storage and VM region are shown as product facts, not marketing claims.
            </p>
          </V2SectionCard>
        </div>
        <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] p-5">
          <p className="text-sm font-medium text-amber-100">PWA code-delivery caveat</p>
          <p className="mt-2 text-sm leading-6 text-white/56">
            Browser-delivered encryption code cannot provide native-app code immutability. The v2
            page keeps this caveat visible and short.
          </p>
        </div>
      </div>
    </section>
  );
}

export function V2Sketchbook() {
  return (
    <V2SketchShell
      active="sketchbook"
      title="V2 Sketchbook"
      subtitle="Static page sketches matching the current v1 route inventory."
      aside={
        <V2AsidePanel title="Boundary">
          <V2FactRow label="Not routed" value="These sketches are isolated under src/v2." />
          <V2FactRow
            label="Current UI safe"
            value="No production route imports v2 yet."
            tone="verified"
          />
        </V2AsidePanel>
      }
      commandPreview={false}
    >
      <div className="px-6 py-8">
        <V2RouteIndex />
      </div>
    </V2SketchShell>
  );
}

export { V2ChatSketch };
