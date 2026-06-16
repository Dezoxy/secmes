import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { schema, withTenant } from '../db/index.js';

@Injectable()
export class KeyBackupService {
  constructor(private readonly audit: AuditService) {}

  /** Store (or replace) the caller's sealed backup blob. Opaque — the server never opens it. */
  async store(auth: VerifiedAuth, backup: string): Promise<void> {
    await withTenant(auth.tenantId, async (tx) => {
      const userId = await resolveUserId(tx, auth);
      await tx
        .insert(schema.keyBackups)
        .values({ tenantId: auth.tenantId, userId, backup })
        .onConflictDoUpdate({
          target: [schema.keyBackups.tenantId, schema.keyBackups.userId],
          set: { backup, updatedAt: sql`now()` },
        });
    });
    // Audit the write — overwriting a victim's backup could brick their recovery (detectability).
    await this.audit.record(auth.tenantId, {
      eventType: 'keybackup.stored',
      actorSub: auth.sub,
    });
  }

  /** Fetch the caller's sealed backup for restore, or null if none. Each fetch is audited. */
  async fetch(auth: VerifiedAuth): Promise<string | null> {
    const backup = await withTenant(auth.tenantId, async (tx) => {
      const userId = await resolveUserId(tx, auth);
      const [row] = await tx
        .select({ backup: schema.keyBackups.backup })
        .from(schema.keyBackups)
        .where(
          and(eq(schema.keyBackups.tenantId, auth.tenantId), eq(schema.keyBackups.userId, userId)),
        )
        .limit(1);
      return row?.backup ?? null;
    });

    if (backup !== null) {
      // Audit each restore-fetch so abuse is detectable (rate-limiting is checkpoint 46).
      await this.audit.record(auth.tenantId, {
        eventType: 'keybackup.fetched',
        actorSub: auth.sub,
      });
    }
    return backup;
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

async function resolveUserId(tx: Tx, auth: VerifiedAuth): Promise<string> {
  const [user] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      auth.userId
        ? eq(schema.users.id, auth.userId)
        : eq(schema.users.externalIdentityId, auth.sub),
    )
    .limit(1);
  if (!user) throw new BadRequestException('user not provisioned; sign in first');
  return user.id;
}
