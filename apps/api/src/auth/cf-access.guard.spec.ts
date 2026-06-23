import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock `jose` so the guard never hits the network (no real Cloudflare JWKS fetch). vi.hoisted lets the
// mock factory reference these spies despite vi.mock hoisting above the imports.
const { jwtVerifyMock, jwksMock } = vi.hoisted(() => ({
  jwtVerifyMock: vi.fn(),
  jwksMock: vi.fn(() => 'mock-jwks'),
}));
vi.mock('jose', () => ({ createRemoteJWKSet: jwksMock, jwtVerify: jwtVerifyMock }));

import { CfAccessGuard } from './cf-access.guard.js';

function ctxWith(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

const TEAM_KEY = 'CF_ACCESS_TEAM_DOMAIN';
const AUD_KEY = 'CF_ACCESS_AUD';
const savedTeam = process.env[TEAM_KEY];
const savedAud = process.env[AUD_KEY];

function setEnv(team: string | undefined, aud: string | undefined): void {
  if (team === undefined) delete process.env[TEAM_KEY];
  else process.env[TEAM_KEY] = team;
  if (aud === undefined) delete process.env[AUD_KEY];
  else process.env[AUD_KEY] = aud;
}

const pinoMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as never;

describe('CfAccessGuard', () => {
  afterEach(() => {
    setEnv(savedTeam, savedAud);
    jwtVerifyMock.mockReset();
    jwksMock.mockClear();
  });

  it('passes through when CF_ACCESS_* is unset (dev / un-armed deploy) — even with no header', async () => {
    setEnv(undefined, undefined);
    const guard = new CfAccessGuard(pinoMock);
    expect(await guard.canActivate(ctxWith({}))).toBe(true);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('rejects when enabled and the Access header is absent (before any JWKS fetch)', async () => {
    setEnv('acme', 'aud-tag');
    const guard = new CfAccessGuard(pinoMock);
    await expect(guard.canActivate(ctxWith({}))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('rejects when enabled and the Access JWT fails verification (forged / expired)', async () => {
    setEnv('acme', 'aud-tag');
    jwtVerifyMock.mockRejectedValueOnce(new Error('signature verification failed'));
    const guard = new CfAccessGuard(pinoMock);
    await expect(
      guard.canActivate(ctxWith({ 'cf-access-jwt-assertion': 'forged.jwt.token' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jwtVerifyMock).toHaveBeenCalledOnce();
  });

  it('allows when enabled and the Access JWT verifies, pinning iss/aud/RS256', async () => {
    setEnv('acme', 'aud-tag');
    jwtVerifyMock.mockResolvedValueOnce({ payload: { sub: 'operator@example.com' } });
    const guard = new CfAccessGuard(pinoMock);
    expect(await guard.canActivate(ctxWith({ 'cf-access-jwt-assertion': 'valid.jwt.token' }))).toBe(
      true,
    );
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'valid.jwt.token',
      'mock-jwks',
      expect.objectContaining({
        issuer: 'https://acme.cloudflareaccess.com',
        audience: 'aud-tag',
        algorithms: ['RS256'],
        clockTolerance: 5,
      }),
    );
  });

  it('handles an array-valued Cf-Access-Jwt-Assertion header (takes the first)', async () => {
    setEnv('acme', 'aud-tag');
    jwtVerifyMock.mockResolvedValueOnce({ payload: {} });
    const guard = new CfAccessGuard(pinoMock);
    expect(
      await guard.canActivate(ctxWith({ 'cf-access-jwt-assertion': ['first.jwt', 'second.jwt'] })),
    ).toBe(true);
    expect(jwtVerifyMock).toHaveBeenCalledWith('first.jwt', 'mock-jwks', expect.anything());
  });

  it('normalizes a full-host team domain to the https issuer', async () => {
    setEnv('acme.cloudflareaccess.com', 'aud-tag');
    jwtVerifyMock.mockResolvedValueOnce({ payload: {} });
    const guard = new CfAccessGuard(pinoMock);
    await guard.canActivate(ctxWith({ 'cf-access-jwt-assertion': 't' }));
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      't',
      'mock-jwks',
      expect.objectContaining({ issuer: 'https://acme.cloudflareaccess.com' }),
    );
  });
});
