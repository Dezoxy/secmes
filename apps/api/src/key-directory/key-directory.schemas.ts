import { z } from 'zod';

// Local for now (no client consumer yet) — migrate to @secmes/contracts when the web app publishes
// KeyPackages (needs the monorepo build-order fix). All values are PUBLIC base64 key material.
const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');

export const PublishKeyPackagesSchema = z
  .object({
    signaturePublicKey: base64.max(512),
    keyPackages: z.array(base64.max(8192)).min(1).max(100),
  })
  .strict(); // reject unknown keys (fail-closed) instead of silently stripping them
export type PublishKeyPackages = z.infer<typeof PublishKeyPackagesSchema>;
