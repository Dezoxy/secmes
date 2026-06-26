import type { NextFunction, Request, Response } from 'express';

interface CacheConfigurableApp {
  set(setting: 'etag', value: false): unknown;
  use(middleware: (req: Request, res: Response, next: NextFunction) => void): unknown;
}

export function noStoreApiResponses(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

export function configureDynamicResponseCaching(app: CacheConfigurableApp): void {
  // Authenticated JSON endpoints carry per-device state (for example pending MLS Welcomes).
  // Express ETags can turn fresh polls into 304 responses with no body, stranding join drains.
  app.set('etag', false);
  app.use(noStoreApiResponses);
}
