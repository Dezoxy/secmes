import { useCallback, useEffect, useState } from 'react';
import { Clipboard, Cpu, KeyRound, ScrollText, ShieldCheck, Trash2 } from 'lucide-react';
import {
  adminRevokeDevice,
  createSsoConfig,
  deleteSsoConfig,
  getSsoConfig,
  listAdminAudit,
  listAdminDevices,
  rotateSsoSecret,
  updateSsoConfig,
  type AdminAuditResponse,
  type AuditEventSummary,
  type DeviceSummary,
  type SsoConfig,
} from '../../lib/api';
import { Button, StateBlock } from '../ui';

type SubTab = 'devices' | 'audit' | 'sso';

// ── Devices ──────────────────────────────────────────────────────────────────

function DeviceRow({
  device,
  onRevoke,
}: {
  device: DeviceSummary;
  onRevoke: (deviceId: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
      <Cpu className="h-4 w-4 shrink-0 text-white/30" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          {device.displayName ?? device.email}
        </p>
        <p className="truncate text-xs text-white/40">
          {device.email}&ensp;·&ensp;
          <span className="font-mono">{device.signaturePublicKeyPrefix}…</span>
          &ensp;·&ensp;{new Date(device.createdAt).toLocaleDateString()}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onRevoke(device.deviceId)}
        title="Revoke device"
        className="rounded-lg p-1.5 text-white/30 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function DevicesTab() {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices(await listAdminDevices());
      setError(null);
    } catch {
      setError('Could not load devices.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = async (deviceId: string) => {
    try {
      await adminRevokeDevice(deviceId);
      setError(null);
      setDevices((prev) => prev?.filter((d) => d.deviceId !== deviceId) ?? null);
    } catch {
      setError('Could not revoke device.');
    } finally {
      setConfirmId(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <StateBlock variant="error" title="Error">
          {error}
        </StateBlock>
      )}

      {devices === null && !error && <StateBlock variant="loading" title="Loading devices" />}

      {devices?.length === 0 && <StateBlock variant="empty" title="No registered devices" />}

      {devices?.map((device) =>
        confirmId === device.deviceId ? (
          <div
            key={device.deviceId}
            className="flex items-center gap-3 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] px-4 py-3"
          >
            <p className="flex-1 text-sm text-rose-200">
              Revoke <strong>{device.displayName ?? device.email}</strong>&apos;s device?
            </p>
            <Button size="sm" variant="danger" onClick={() => void handleRevoke(device.deviceId)}>
              Revoke
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <DeviceRow key={device.deviceId} device={device} onRevoke={(id) => setConfirmId(id)} />
        ),
      )}
    </div>
  );
}

// ── Audit Log ─────────────────────────────────────────────────────────────────

function eventTypeBadgeClass(eventType: string): string {
  if (eventType.startsWith('auth.')) return 'border-blue-400/30 bg-blue-500/10 text-blue-300';
  if (eventType.startsWith('device.')) return 'border-rose-400/30 bg-rose-500/10 text-rose-300';
  if (
    eventType.startsWith('member.') ||
    eventType.startsWith('tenant.') ||
    eventType.startsWith('invite.')
  )
    return 'border-purple-400/30 bg-purple-500/10 text-purple-300';
  return 'border-white/10 bg-white/[0.04] text-white/60';
}

function AuditRow({ event }: { event: AuditEventSummary }) {
  const actor =
    event.actorDisplayName ?? (event.actorSub ? `${event.actorSub.slice(0, 16)}…` : '—');
  return (
    <div className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-xs ${eventTypeBadgeClass(event.eventType)}`}
          >
            {event.eventType}
          </span>
          <span className="text-xs text-white/50">{actor}</span>
        </div>
        <p className="mt-0.5 text-xs text-white/30">
          {new Date(event.createdAt).toLocaleString()}
          {event.ip && <>&ensp;·&ensp;{event.ip}</>}
        </p>
      </div>
    </div>
  );
}

function AuditTab() {
  const [page, setPage] = useState<AdminAuditResponse | null>(null);
  const [events, setEvents] = useState<AuditEventSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const result = await listAdminAudit(cursor);
      setPage(result);
      setEvents((prev) => (cursor ? [...prev, ...result.events] : result.events));
      setError(null);
    } catch {
      setError('Could not load audit log.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <StateBlock variant="error" title="Error">
          {error}
        </StateBlock>
      )}

      {events.length === 0 && loading && <StateBlock variant="loading" title="Loading audit log" />}

      {events.length === 0 && !loading && !error && (
        <StateBlock variant="empty" title="No audit events" />
      )}

      {events.map((event) => (
        <AuditRow key={event.id} event={event} />
      ))}

      {page?.nextCursor && (
        <Button
          variant="ghost"
          size="sm"
          loading={loading}
          loadingLabel="Loading…"
          onClick={() => void load(page.nextCursor)}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

// ── SSO ────────────────────────────────────────────────────────────────────────

const SSO_PROVIDER_OPTIONS = [
  { value: 'oidc_generic', label: 'Generic OIDC' },
  { value: 'google', label: 'Google Workspace' },
  { value: 'entra', label: 'Microsoft Entra' },
  { value: 'okta', label: 'Okta' },
] as const;

function SsoTab() {
  const [config, setConfig] = useState<SsoConfig | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rotatePending, setRotatePending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({
    providerType: 'oidc_generic',
    providerName: '',
    issuerUrl: '',
    clientId: '',
    clientSecret: '',
  });
  const [editForm, setEditForm] = useState({ providerName: '', issuerUrl: '', clientId: '' });
  const [rotateSecret, setRotateSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setConfig(await getSsoConfig());
      setError(null);
    } catch {
      setError('Could not load SSO configuration.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      const created = await createSsoConfig({
        providerType: form.providerType as 'oidc_generic' | 'google' | 'entra' | 'okta',
        providerName: form.providerName,
        issuerUrl: form.issuerUrl,
        clientId: form.clientId,
        clientSecret: form.clientSecret,
      });
      setConfig(created);
      setError(null);
    } catch {
      setError('Could not configure SSO. Check your credentials and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async () => {
    setSubmitting(true);
    try {
      const updated = await updateSsoConfig({
        ...(editForm.providerName ? { providerName: editForm.providerName } : {}),
        ...(editForm.issuerUrl ? { issuerUrl: editForm.issuerUrl } : {}),
        ...(editForm.clientId ? { clientId: editForm.clientId } : {}),
      });
      setConfig(updated);
      setEditing(false);
      setError(null);
    } catch {
      setError('Could not update SSO configuration.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRotate = async () => {
    setSubmitting(true);
    try {
      await rotateSsoSecret({ clientSecret: rotateSecret });
      setRotatePending(false);
      setRotateSecret('');
      setError(null);
    } catch {
      setError('Could not rotate the client secret.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    setSubmitting(true);
    try {
      await deleteSsoConfig();
      setConfig(null);
      setConfirmDelete(false);
      setError(null);
    } catch {
      setError('Could not remove SSO configuration.');
    } finally {
      setSubmitting(false);
    }
  };

  const copyLoginUrl = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (config === undefined) return <StateBlock variant="loading" title="Loading SSO config" />;

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <StateBlock variant="error" title="Error">
          {error}
        </StateBlock>
      )}

      {config === null && !editing && (
        <div className="flex flex-col gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-4">
          <p className="text-sm text-white/60">
            No SSO configured. Fill in your OIDC IdP details to enable single sign-on.
          </p>
          <div className="grid gap-2">
            <select
              className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white"
              value={form.providerType}
              onChange={(e) => setForm((f) => ({ ...f, providerType: e.target.value }))}
            >
              {SSO_PROVIDER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {(['providerName', 'issuerUrl', 'clientId'] as const).map((field) => (
              <input
                key={field}
                type="text"
                placeholder={
                  field === 'providerName'
                    ? 'Display name (e.g. Acme Corp)'
                    : field === 'issuerUrl'
                      ? 'Issuer URL (https://…)'
                      : 'Client ID'
                }
                className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white placeholder:text-white/30"
                value={form[field]}
                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
              />
            ))}
            <input
              type="password"
              placeholder="Client Secret"
              className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white placeholder:text-white/30"
              value={form.clientSecret}
              onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))}
            />
          </div>
          <Button
            size="sm"
            loading={submitting}
            loadingLabel="Configuring…"
            onClick={() => void handleCreate()}
            disabled={!form.providerName || !form.issuerUrl || !form.clientId || !form.clientSecret}
          >
            Configure SSO
          </Button>
        </div>
      )}

      {config !== null && (
        <div className="flex flex-col gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
            <span className="text-sm font-medium text-white">{config.providerName}</span>
          </div>
          <div className="grid gap-1 text-xs text-white/50">
            <p>
              <span className="text-white/30">Issuer</span>&ensp;{config.issuerUrl}
            </p>
            <p>
              <span className="text-white/30">Client ID</span>&ensp;
              <span className="font-mono">{config.clientId}</span>
            </p>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2">
            <span className="flex-1 truncate font-mono text-xs text-white/70">
              {config.loginUrl}
            </span>
            <button
              type="button"
              onClick={() => copyLoginUrl(config.loginUrl)}
              className="shrink-0 rounded p-1 text-white/40 transition-colors hover:text-white/80"
              title="Copy login URL"
            >
              <Clipboard className="h-3.5 w-3.5" />
            </button>
          </div>
          {copied && <p className="text-xs text-emerald-400">Copied!</p>}
          <p className="text-xs text-white/40">
            Share this URL with your team. Users who open it will authenticate via your IdP.
          </p>

          {!editing && !rotatePending && !confirmDelete && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditForm({
                    providerName: config.providerName,
                    issuerUrl: config.issuerUrl,
                    clientId: config.clientId,
                  });
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRotatePending(true)}>
                <KeyRound className="h-3.5 w-3.5" />
                Rotate Secret
              </Button>
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                Remove
              </Button>
            </div>
          )}

          {editing && (
            <div className="flex flex-col gap-2">
              {(['providerName', 'issuerUrl', 'clientId'] as const).map((field) => (
                <input
                  key={field}
                  type="text"
                  placeholder={
                    field === 'providerName'
                      ? 'Display name'
                      : field === 'issuerUrl'
                        ? 'Issuer URL'
                        : 'Client ID'
                  }
                  className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white placeholder:text-white/30"
                  value={editForm[field]}
                  onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                />
              ))}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={submitting}
                  loadingLabel="Saving…"
                  onClick={() => void handleUpdate()}
                >
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {rotatePending && (
            <div className="flex flex-col gap-2">
              <input
                type="password"
                placeholder="New client secret"
                className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white placeholder:text-white/30"
                value={rotateSecret}
                onChange={(e) => setRotateSecret(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  loading={submitting}
                  loadingLabel="Rotating…"
                  onClick={() => void handleRotate()}
                  disabled={!rotateSecret}
                >
                  Rotate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRotatePending(false);
                    setRotateSecret('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {confirmDelete && (
            <div className="flex items-center gap-3 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] px-4 py-3">
              <p className="flex-1 text-sm text-rose-200">
                Remove SSO and delete the Zitadel organization? This cannot be undone.
              </p>
              <Button
                size="sm"
                variant="danger"
                loading={submitting}
                loadingLabel="Removing…"
                onClick={() => void handleDelete()}
              >
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────

export function AdminPanel() {
  const [tab, setTab] = useState<SubTab>('devices');

  const tabs: { id: SubTab; label: string; Icon: typeof Cpu }[] = [
    { id: 'devices', label: 'Devices', Icon: Cpu },
    { id: 'audit', label: 'Audit Log', Icon: ScrollText },
    { id: 'sso', label: 'SSO', Icon: ShieldCheck },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 rounded-xl border border-white/5 bg-white/[0.02] p-1">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === id ? 'bg-white/[0.08] text-white' : 'text-white/40 hover:text-white/70'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'devices' && <DevicesTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'sso' && <SsoTab />}
    </div>
  );
}
