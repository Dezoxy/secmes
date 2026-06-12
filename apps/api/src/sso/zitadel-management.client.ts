import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  ZITADEL_MANAGEMENT_CONFIG,
  type ZitadelManagementConfig,
} from './zitadel-management.config.js';

const TIMEOUT_MS = 10_000;

interface OidcIdpConfig {
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

async function zFetch(
  url: string,
  pat: string,
  init: RequestInit & { orgId?: string },
): Promise<Response> {
  const { orgId, ...rest } = init;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${pat}`,
    'Content-Type': 'application/json',
    ...(orgId ? { 'x-zitadel-orgid': orgId } : {}),
    ...(rest.headers as Record<string, string> | undefined),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...rest, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function assertOk(res: Response, context: string): Promise<unknown> {
  if (res.ok) return res.json().catch(() => null);
  const body = await res.text().catch(() => '');
  throw new Error(`Zitadel ${context}: HTTP ${res.status} — ${body.slice(0, 200)}`);
}

@Injectable()
export class ZitadelManagementClient {
  constructor(
    @Inject(ZITADEL_MANAGEMENT_CONFIG)
    private readonly cfg: ZitadelManagementConfig,
  ) {}

  private ensure(): void {
    if (!this.cfg.configured) {
      throw new ServiceUnavailableException('SSO management not configured on this instance');
    }
  }

  async createOrg(name: string): Promise<{ orgId: string }> {
    this.ensure();
    const res = await zFetch(`${this.cfg.baseUrl}/v2/organizations`, this.cfg.pat, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const data = (await assertOk(res, 'createOrg')) as { organizationId: string };
    return { orgId: data.organizationId };
  }

  async createOidcIdp(orgId: string, config: OidcIdpConfig): Promise<{ idpId: string }> {
    this.ensure();
    const res = await zFetch(`${this.cfg.baseUrl}/management/v1/idps/oidc`, this.cfg.pat, {
      method: 'POST',
      orgId,
      body: JSON.stringify({
        name: config.name,
        issuer: config.issuer,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scopes: config.scopes,
        displayNameMapping: 'DISPLAY_NAME_MAPPING_EMAIL',
        usernameMapping: 'USERNAME_MAPPING_TYPE_EMAIL',
      }),
    });
    const data = (await assertOk(res, 'createOidcIdp')) as { id: string };
    return { idpId: data.id };
  }

  async activateIdpInLoginPolicy(orgId: string, idpId: string): Promise<void> {
    this.ensure();
    const res = await zFetch(
      `${this.cfg.baseUrl}/management/v1/policies/login/idps`,
      this.cfg.pat,
      { method: 'POST', orgId, body: JSON.stringify({ idpId }) },
    );
    await assertOk(res, 'activateIdpInLoginPolicy');
  }

  async updateOidcIdp(
    orgId: string,
    idpId: string,
    patch: Partial<Pick<OidcIdpConfig, 'name' | 'issuer' | 'clientId' | 'scopes'>>,
  ): Promise<void> {
    this.ensure();
    const res = await zFetch(
      `${this.cfg.baseUrl}/management/v1/idps/oidc/${encodeURIComponent(idpId)}`,
      this.cfg.pat,
      { method: 'PUT', orgId, body: JSON.stringify(patch) },
    );
    await assertOk(res, 'updateOidcIdp');
  }

  async rotateIdpSecret(orgId: string, idpId: string, secret: string): Promise<void> {
    this.ensure();
    const res = await zFetch(
      `${this.cfg.baseUrl}/management/v1/idps/oidc/${encodeURIComponent(idpId)}/secret`,
      this.cfg.pat,
      { method: 'PUT', orgId, body: JSON.stringify({ clientSecret: secret }) },
    );
    await assertOk(res, 'rotateIdpSecret');
  }

  async deleteIdp(orgId: string, idpId: string): Promise<void> {
    this.ensure();
    const res = await zFetch(
      `${this.cfg.baseUrl}/management/v1/idps/${encodeURIComponent(idpId)}`,
      this.cfg.pat,
      { method: 'DELETE', orgId },
    );
    await assertOk(res, 'deleteIdp');
  }

  async deleteOrg(orgId: string): Promise<void> {
    this.ensure();
    const res = await zFetch(
      `${this.cfg.baseUrl}/v2/organizations/${encodeURIComponent(orgId)}`,
      this.cfg.pat,
      { method: 'DELETE' },
    );
    await assertOk(res, 'deleteOrg');
  }
}
