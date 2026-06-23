import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startMetricsServer } from './metrics-server.js';

describe('metrics-server (separate internal port)', () => {
  let server: Server | undefined;

  afterEach(
    () =>
      new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      }),
  );

  async function start(): Promise<number> {
    server = startMetricsServer(0); // ephemeral port
    await new Promise<void>((resolve) => {
      if (server!.listening) resolve();
      else server!.once('listening', () => resolve());
    });
    return (server!.address() as AddressInfo).port;
  }

  it('serves the Prometheus registry on GET /metrics', async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/openmetrics-text');
    expect(await res.text()).toContain('argus_api_');
  });

  it('404s any other path (it is not a general HTTP surface)', async () => {
    const port = await start();
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/metrics/../secrets`)).status).toBe(404);
  });

  it('rejects non-GET methods on /metrics', async () => {
    const port = await start();
    expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(404);
  });
});
