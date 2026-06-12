import { useCallback, useEffect, useState } from 'react';
import { Cpu, ScrollText, Trash2 } from 'lucide-react';
import {
  adminRevokeDevice,
  listAdminAudit,
  listAdminDevices,
  type AdminAuditResponse,
  type AuditEventSummary,
  type DeviceSummary,
} from '../../lib/api';
import { Button, StateBlock } from '../ui';

type SubTab = 'devices' | 'audit';

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

// ── Shell ─────────────────────────────────────────────────────────────────────

export function AdminPanel() {
  const [tab, setTab] = useState<SubTab>('devices');

  const tabs: { id: SubTab; label: string; Icon: typeof Cpu }[] = [
    { id: 'devices', label: 'Devices', Icon: Cpu },
    { id: 'audit', label: 'Audit Log', Icon: ScrollText },
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
    </div>
  );
}
