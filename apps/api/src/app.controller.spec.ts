import { describe, it, expect } from 'vitest';
import { reflectRouteMeta } from './common/testing/route-meta.js';
import { AppController } from './app.controller.js';

// Contract tier: healthz and root are the only deliberately-public routes here (operational probe + service
// banner). Pinning isPublic:true is the contract — a regression that drops @Public would break liveness
// checks, and (more importantly) nothing else on this controller should ever become public by accident.
describe('AppController route contract', () => {
  const ROUTES = ['health', 'root'] as const;

  it.each(ROUTES)('%s is public, 200 GET, no guards', (method) => {
    expect(reflectRouteMeta(AppController, method)).toEqual({
      isPublic: true,
      isAllowUnbound: false,
      hasPublicRateLimit: false,
      httpCode: 200,
      guards: [],
    });
  });
});

describe('AppController', () => {
  const controller = new AppController();

  it('healthz returns ok', () => {
    expect(controller.health()).toEqual({ status: 'ok' });
  });

  it('root reports service identity', () => {
    const body = controller.root();
    expect(body.service).toBe('argus-api');
    expect(body.status).toBe('ok');
  });
});
