import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type {
  CreateSsoConfigBody,
  RotateSsoSecretBody,
  SsoConfig,
  UpdateSsoConfigBody,
} from '@argus/contracts';
import type { VerifiedAuth } from '../auth/auth.service.js';
import { AuditService } from '../audit/audit.service.js';
import { schema, withTenant } from '../db/index.js';
import { ZitadelManagementClient } from './zitadel-management.client.js';

const APP_BASE_URL = (process.env.APP_BASE_URL ?? 'https://app.4rgus.com').replace(/\/$/, '');

// RFC-1918 + loopback patterns — block SSRF via issuerUrl.
const BLOCKED_HOSTNAMES = new Set(['localhost', 'zitadel', 'postgres', 'redis', 'minio']);
const RFC1918_RE =
  /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|::1)$/;

function validateIssuerUrl(raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequestException('Invalid issuer URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('issuerUrl must use HTTPS');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    RFC1918_RE.test(host)
  ) {
    throw new BadRequestException('issuerUrl hostname is not allowed');
  }
}

function rowToDto(row: typeof schema.tenantSsoConfigs.$inferSelect): SsoConfig {
  return {
    id: row.id,
    providerType: row.providerType as SsoConfig['providerType'],
    providerName: row.providerName,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    loginUrl: row.loginUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly zitadel: ZitadelManagementClient,
    private readonly audit: AuditService,
  ) {}

  async getSsoConfig(auth: VerifiedAuth): Promise<SsoConfig | null> {
    const rows = await withTenant(auth.tenantId, (tx) =>
      tx
        .select()
        .from(schema.tenantSsoConfigs)
        .where(eq(schema.tenantSsoConfigs.tenantId, auth.tenantId))
        .limit(1),
    );
    return rows[0] ? rowToDto(rows[0]) : null;
  }

  async createSsoConfig(auth: VerifiedAuth, body: CreateSsoConfigBody): Promise<SsoConfig> {
    validateIssuerUrl(body.issuerUrl);

    // 409 if already configured.
    const existing = await withTenant(auth.tenantId, (tx) =>
      tx
        .select({ id: schema.tenantSsoConfigs.id })
        .from(schema.tenantSsoConfigs)
        .where(eq(schema.tenantSsoConfigs.tenantId, auth.tenantId))
        .limit(1),
    );
    if (existing.length > 0) {
      throw new ConflictException('SSO is already configured for this tenant');
    }

    // Resolve tenant name for Zitadel org display.
    const tenantRows = await withTenant(auth.tenantId, (tx) =>
      tx
        .select({ name: schema.tenants.name })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, auth.tenantId))
        .limit(1),
    );
    const tenantName = tenantRows[0]?.name ?? auth.tenantId;

    let orgId: string | null = null;
    let idpId: string | null = null;

    try {
      ({ orgId } = await this.zitadel.createOrg(tenantName));
      ({ idpId } = await this.zitadel.createOidcIdp(orgId, {
        name: body.providerName,
        issuer: body.issuerUrl,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        scopes: ['openid', 'profile', 'email'],
      }));
      await this.zitadel.activateIdpInLoginPolicy(orgId, idpId);
    } catch (err) {
      if (orgId) {
        await this.zitadel.deleteOrg(orgId).catch(() => undefined);
      }
      throw err;
    }

    const loginUrl = `${APP_BASE_URL}/?orgID=${orgId}`;

    const rows = await withTenant(auth.tenantId, (tx) =>
      tx
        .insert(schema.tenantSsoConfigs)
        .values({
          tenantId: auth.tenantId,
          zitadelOrgId: orgId!,
          zitadelIdpId: idpId!,
          providerType: body.providerType,
          providerName: body.providerName,
          issuerUrl: body.issuerUrl,
          clientId: body.clientId,
          loginUrl,
        })
        .returning(),
    );

    const row = rows[0]!;
    await this.audit.record(auth.tenantId, {
      eventType: 'sso.configured',
      actorSub: auth.sub,
    });
    return rowToDto(row);
  }

  async updateSsoConfig(auth: VerifiedAuth, body: UpdateSsoConfigBody): Promise<SsoConfig> {
    if (body.issuerUrl) validateIssuerUrl(body.issuerUrl);

    const existing = await withTenant(auth.tenantId, (tx) =>
      tx
        .select()
        .from(schema.tenantSsoConfigs)
        .where(eq(schema.tenantSsoConfigs.tenantId, auth.tenantId))
        .limit(1),
    );
    if (!existing[0]) throw new NotFoundException('SSO not configured for this tenant');

    const cfg = existing[0];
    const patch: Partial<{ name: string; issuer: string; clientId: string; scopes: string[] }> = {};
    if (body.providerName) patch.name = body.providerName;
    if (body.issuerUrl) patch.issuer = body.issuerUrl;
    if (body.clientId) patch.clientId = body.clientId;

    await this.zitadel.updateOidcIdp(cfg.zitadelOrgId, cfg.zitadelIdpId, patch);

    const rows = await withTenant(auth.tenantId, (tx) =>
      tx
        .update(schema.tenantSsoConfigs)
        .set({
          ...(body.providerName ? { providerName: body.providerName } : {}),
          ...(body.issuerUrl ? { issuerUrl: body.issuerUrl } : {}),
          ...(body.clientId ? { clientId: body.clientId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.tenantSsoConfigs.tenantId, auth.tenantId))
        .returning(),
    );

    await this.audit.record(auth.tenantId, { eventType: 'sso.updated', actorSub: auth.sub });
    return rowToDto(rows[0]!);
  }

  async rotateSsoSecret(auth: VerifiedAuth, body: RotateSsoSecretBody): Promise<void> {
    const existing = await withTenant(auth.tenantId, (tx) =>
      tx
        .select()
        .from(schema.tenantSsoConfigs)
        .where(eq(schema.tenantSsoConfigs.tenantId, auth.tenantId))
        .limit(1),
    );
    if (!existing[0]) throw new NotFoundException('SSO not configured for this tenant');

    await this.zitadel.rotateIdpSecret(
      existing[0].zitadelOrgId,
      existing[0].zitadelIdpId,
      body.clientSecret,
    );

    await withTenant(auth.tenantId, (tx) =>
      tx
        .update(schema.tenantSsoConfigs)
        .set({ updatedAt: new Date() })
        .where(eq(schema.tenantSsoConfigs.tenantId, auth.tenantId)),
    );
    await this.audit.record(auth.tenantId, {
      eventType: 'sso.secret_rotated',
      actorSub: auth.sub,
    });
  }

  async deleteSsoConfig(auth: VerifiedAuth): Promise<void> {
    const existing = await withTenant(auth.tenantId, (tx) =>
      tx
        .select()
        .from(schema.tenantSsoConfigs)
        .where(eq(schema.tenantSsoConfigs.tenantId, auth.tenantId))
        .limit(1),
    );
    if (!existing[0]) throw new NotFoundException('SSO not configured for this tenant');

    const cfg = existing[0];

    // DB row first: if this fails, Zitadel state is unchanged (clean failure).
    // Zitadel delete after: if it fails, the org is orphaned but the DB is consistent
    // — recoverable from the Zitadel console (same as the create-rollback scenario).
    await withTenant(auth.tenantId, (tx) =>
      tx.delete(schema.tenantSsoConfigs).where(eq(schema.tenantSsoConfigs.tenantId, auth.tenantId)),
    );

    await this.zitadel.deleteOrg(cfg.zitadelOrgId).catch((err: unknown) => {
      this.logger.warn(
        `deleteOrg ${cfg.zitadelOrgId} failed after DB delete — org may be orphaned: ${String(err)}`,
      );
    });

    await this.audit.record(auth.tenantId, { eventType: 'sso.deleted', actorSub: auth.sub });
  }
}
