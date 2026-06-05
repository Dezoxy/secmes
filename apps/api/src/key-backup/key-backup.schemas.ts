import { z } from 'zod';

// Local for now (no client consumer yet). The `backup` is an OPAQUE sealed blob — the server never
// parses it (crypto-blind); only its size is bounded here to prevent abuse.
export const StoreBackupSchema = z
  .object({
    backup: z.string().min(1).max(65536),
  })
  .strict(); // reject unknown keys (fail-closed) instead of silently stripping them
export type StoreBackup = z.infer<typeof StoreBackupSchema>;
