import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

import { configureDynamicResponseCaching, noStoreApiResponses } from './http-cache.js';

describe('dynamic API response caching', () => {
  it('disables Express ETags and installs the no-store middleware', () => {
    const app = {
      set: vi.fn(),
      use: vi.fn(),
    };

    configureDynamicResponseCaching(app);

    expect(app.set).toHaveBeenCalledWith('etag', false);
    expect(app.use).toHaveBeenCalledWith(noStoreApiResponses);
  });

  it('marks responses as non-cacheable before continuing', () => {
    const setHeader = vi.fn();
    const next = vi.fn();

    noStoreApiResponses(
      {} as Request,
      { setHeader } as unknown as Response,
      next as unknown as NextFunction,
    );

    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(setHeader).toHaveBeenCalledWith('Expires', '0');
    expect(next).toHaveBeenCalledOnce();
  });
});
