// OIDC config for JWT validation. All values are NON-secret (issuer, audience, JWKS URL).
// Sourced from env; populated when Zitadel is deployed (checkpoint 9). Until then `configured`
// is false and protected routes fail closed (see auth.module.ts).

export const OIDC_CONFIG = Symbol('OIDC_CONFIG');
export const OIDC_JWKS = Symbol('OIDC_JWKS');

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
  /** Verified claim that carries our tenant UUID. Configurable so we don't hard-bet Zitadel's claim shape. */
  tenantClaim: string;
  configured: boolean;
}

export function loadOidcConfig(): OidcConfig {
  const issuer = process.env.OIDC_ISSUER ?? '';
  const audience = process.env.OIDC_AUDIENCE ?? '';
  // Zitadel serves its JWKS at <issuer>/oauth/v2/keys; allow an explicit override.
  const jwksUri =
    process.env.OIDC_JWKS_URI ?? (issuer ? `${issuer.replace(/\/$/, '')}/oauth/v2/keys` : '');
  const tenantClaim = process.env.OIDC_TENANT_CLAIM ?? 'tenant_id';
  return {
    issuer,
    audience,
    jwksUri,
    tenantClaim,
    configured: Boolean(issuer && audience && jwksUri),
  };
}
