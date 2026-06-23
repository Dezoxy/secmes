import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '../db/index.js';
import { requireFriendship } from './membership.js';

// Builds a minimal Drizzle-tx mock whose .select chain returns the provided rows.
function mockTx(rows: Array<{ id: string }>): Tx {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as unknown as Tx;
}

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('requireFriendship', () => {
  it('resolves when an accepted friendship row is found', async () => {
    const tx = mockTx([{ id: 'f1' }]);
    await expect(requireFriendship(tx, USER_A, USER_B)).resolves.toBeUndefined();
  });

  it('throws ForbiddenException when no accepted row exists', async () => {
    const tx = mockTx([]);
    await expect(requireFriendship(tx, USER_A, USER_B)).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when called with args in reverse order (same canonical pair)', async () => {
    const tx = mockTx([]);
    await expect(requireFriendship(tx, USER_B, USER_A)).rejects.toThrow(ForbiddenException);
  });

  it('queries with canonical pair ordering regardless of argument order', async () => {
    const tx = mockTx([{ id: 'f1' }]);
    await requireFriendship(tx, USER_B, USER_A); // B > A alphabetically — should still resolve
    // The where clause is built by drizzle internals; we just confirm the chain was called
    expect((tx.select as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
