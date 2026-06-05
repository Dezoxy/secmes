import { z } from 'zod';

// NOTE: these live here for now because no client consumes them yet. When the web app reads the
// directory, MOVE them to `@secmes/contracts` (the shared source of truth) — that migration also
// requires fixing the monorepo build order so the API can typecheck against contracts' built dist
// (CI currently runs `typecheck` before `build`, and contracts/dist is gitignored).

export const UserDirectoryQuerySchema = z.object({
  // query strings → number; bounded to cap result size (DoS guard).
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type UserDirectoryQuery = z.infer<typeof UserDirectoryQuerySchema>;
