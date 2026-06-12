import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import type { AuditEventSummary, DeviceSummary } from '@argus/contracts';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { schema, withTenant } from '../db/index.js';

export interface AdminAuditCursor {
  createdAt: string;
  id: string;
}

export interface AdminAuditPage {
  events: AuditEventSummary[];
  nextCursor?: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
    'base64url',
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(cursor: string): AdminAuditCursor | null {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      raw != null &&
      typeof raw === 'object' &&
      'createdAt' in raw &&
      'id' in raw &&
      typeof (raw as { createdAt: unknown }).createdAt === 'string' &&
      typeof (raw as { id: unknown }).id === 'string'
    ) {
      const { createdAt, id } = raw as AdminAuditCursor;
      if (!UUID_RE.test(id) || Number.isNaN(Date.parse(createdAt))) return null;
      return { createdAt, id };
    }
    return null;
  } catch {
    return null;
  }
}

@Injectable()
export class AdminService {
  constructor(private readonly audit: AuditService) {}

  async listDevices(auth: VerifiedAuth): Promise<DeviceSummary[]> {
    return withTenant(auth.tenantId, (tx) =>
      tx
        .select({
          deviceId: schema.devices.id,
          userId: schema.devices.userId,
          displayName: schema.users.displayName,
          email: schema.users.email,
          signaturePublicKeyPrefix: sql<string>`left(${schema.devices.signaturePublicKey}, 12)`,
          createdAt: schema.devices.createdAt,
        })
        .from(schema.devices)
        .innerJoin(
          schema.users,
          and(
            eq(schema.users.id, schema.devices.userId),
            eq(schema.users.tenantId, schema.devices.tenantId),
            eq(schema.users.status, 'active'),
          ),
        )
        .orderBy(schema.users.displayName, schema.devices.createdAt),
    ).then((rows) =>
      rows.map((r) => ({
        deviceId: r.deviceId,
        userId: r.userId,
        displayName: r.displayName,
        email: r.email,
        signaturePublicKeyPrefix: r.signaturePublicKeyPrefix,
        createdAt: r.createdAt.toISOString(),
      })),
    );
  }

  async revokeDevice(auth: VerifiedAuth, deviceId: string): Promise<void> {
    const [deleted] = await withTenant(auth.tenantId, (tx) =>
      tx
        .delete(schema.devices)
        .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.tenantId, auth.tenantId)))
        .returning({ id: schema.devices.id }),
    );
    if (!deleted) throw new NotFoundException('device not found');
    await this.audit.record(auth.tenantId, { eventType: 'device.revoked', actorSub: auth.sub });
  }

  async listAudit(auth: VerifiedAuth, limit: number, cursor?: string): Promise<AdminAuditPage> {
    const cap = Math.max(1, Math.min(limit, 100));
    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) throw new BadRequestException('invalid cursor');

    const rows = await withTenant(auth.tenantId, (tx) =>
      tx
        .select({
          id: schema.auditEvents.id,
          eventType: schema.auditEvents.eventType,
          actorSub: schema.auditEvents.actorSub,
          actorDisplayName: schema.users.displayName,
          ip: schema.auditEvents.ip,
          createdAt: schema.auditEvents.createdAt,
        })
        .from(schema.auditEvents)
        .leftJoin(
          schema.users,
          and(
            eq(schema.users.tenantId, schema.auditEvents.tenantId),
            eq(schema.users.externalIdentityId, sql`${schema.auditEvents.actorSub}`),
          ),
        )
        .where(
          decoded
            ? sql`(${schema.auditEvents.createdAt}, ${schema.auditEvents.id}) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)` // nosemgrep: argus-no-sql-string-interpolation
            : undefined,
        )
        .orderBy(sql`${schema.auditEvents.createdAt} desc`, sql`${schema.auditEvents.id} desc`)
        .limit(cap + 1),
    );

    const hasMore = rows.length > cap;
    const page = hasMore ? rows.slice(0, cap) : rows;
    const last = page.at(-1);

    return {
      events: page.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        actorSub: r.actorSub ?? null,
        actorDisplayName: r.actorDisplayName ?? null,
        ip: r.ip ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined,
    };
  }
}
