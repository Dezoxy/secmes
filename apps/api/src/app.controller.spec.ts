import { describe, it, expect } from 'vitest';
import { AppController } from './app.controller.js';

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
