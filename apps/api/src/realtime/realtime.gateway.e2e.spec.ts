import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';

// Boots the REAL app + native ws adapter and connects an actual WebSocket — proves the adapter is mounted
// at /ws and message frames route to the gateway handlers (the part unit tests can't cover). DB-gated
// because it boots the full AppModule. Auto-skips without DATABASE_URL.
const DB_URL = process.env.DATABASE_URL;

describe.skipIf(!DB_URL)('RealtimeGateway (e2e over a real WebSocket)', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0);
    const addr = app.getHttpServer().address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    url = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('routes an auth frame and closes a socket that sends no token', async () => {
    const client = new WebSocket(url);
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no close within timeout')), 5000);
      client.on('open', () => client.send(JSON.stringify({ event: 'auth', data: {} })));
      client.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      client.on('error', () => {
        /* a close frame may surface as an error first; the close handler resolves */
      });
    });
    expect(code).toBe(4400); // gateway routed the frame to onAuth, which closed (no token)
  });

  it('closes a socket with an unverifiable token (OIDC not configured → 4401)', async () => {
    const client = new WebSocket(url);
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no close within timeout')), 5000);
      client.on('open', () => client.send(JSON.stringify({ event: 'auth', data: { token: 'x' } })));
      client.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      client.on('error', () => {});
    });
    expect(code).toBe(4401); // routed to onAuth → AuthService.verify threw → unauthorized close
  });
});
