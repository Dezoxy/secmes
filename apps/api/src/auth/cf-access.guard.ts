import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Request } from 'express';

// Defense-in-depth gate for the admin/breakglass surface (the highest-privilege path). In production these
// routes sit behind Cloudflare Access; cloudflared injects `Cf-Access-Jwt-Assertion` (a short-lived JWT signed
// by the team's Access keys) only on requests that passed the Access policy, and strips any client-supplied
// copy. Caddy already 404s these paths when the header is absent (the edge boundary); THIS guard verifies the
// JWT's SIGNATURE + iss/aud/expiry so a forged header can't reach the admin logic even on a future topology
// where something else can reach the origin. `jose` is the cleared invariant-#4 exception (same as session
// tokens). See docs/threat-models/admin-access-gating.md.
//
// Env-gated, mirroring the breakglass ADMIN_BOOTSTRAP_HASH_FILE / Sentry-DSN degraded-mode pattern: when
// CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are BOTH set, the guard enforces; when unset (local dev, un-armed
// deploy — no Access in front) it is a pass-through no-op so dev + tests run with zero Access infrastructure.
@Injectable()
export class CfAccessGuard implements CanActivate {
  private readonly enabled: boolean;
  private readonly issuer: string | undefined;
  private readonly audience: string | undefined;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(@InjectPinoLogger(CfAccessGuard.name) private readonly logger: PinoLogger) {
    const team = process.env['CF_ACCESS_TEAM_DOMAIN']?.trim();
    const aud = process.env['CF_ACCESS_AUD']?.trim();
    if (team && aud) {
      // Accept a bare team name ("acme"), the full host ("acme.cloudflareaccess.com"), or a URL. For a URL
      // take the ORIGIN so a stray path/trailing slash can't produce a wrong issuer; the team-name branches
      // build the canonical Access issuer. A wrong issuer fails CLOSED (admin 401s), never open.
      let base: string;
      if (team.startsWith('http')) {
        try {
          base = new URL(team).origin;
        } catch {
          base = team.replace(/\/+$/, '');
        }
      } else {
        base = `https://${team.includes('.') ? team : `${team}.cloudflareaccess.com`}`;
      }
      this.issuer = base;
      this.audience = aud;
      this.jwks = createRemoteJWKSet(new URL(`${base}/cdn-cgi/access/certs`));
      this.enabled = true;
      this.logger.info({ issuer: base }, 'Cloudflare Access verification ENABLED');
    } else {
      this.enabled = false;
      // Observability for the silent-no-op risk: in production this WARN flags that the admin/breakglass
      // API is protected only by the Caddy edge gate (the env vars weren't armed). No secret is logged.
      this.logger.warn(
        'Cloudflare Access verification DISABLED (CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD unset) — admin/breakglass API relies on the edge (Caddy) gate only',
      );
    }
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true; // no Access in front (dev / un-armed) → pass through
    const req = ctx.switchToHttp().getRequest<Request>();
    const raw = req.headers['cf-access-jwt-assertion'];
    const assertion = Array.isArray(raw) ? raw[0] : raw;
    if (!assertion) throw new UnauthorizedException('admin access required');
    try {
      await jwtVerify(assertion, this.jwks!, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'], // Cloudflare Access signs with RS256; pinning the alg rejects alg:none/confusion
        clockTolerance: 5,
      });
    } catch {
      // Never surface the assertion or the underlying jose error. Fail closed.
      throw new UnauthorizedException('admin access required');
    }
    return true;
  }
}
