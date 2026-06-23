import { ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '../db/index.js';
import { canonicalPair, requireDirectFriendship, requireFriendship } from './membership.js';

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

// Builds a tx mock whose successive .select() chains resolve `results[0]`, `results[1]`, ... in order —
// used for guards that run several queries in one transaction (e.g. requireDirectFriendship does
// conversation lookup → peer lookup → friendship lookup).
function mockTxSeq(results: unknown[][]): Tx {
  let call = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      const rows = results[call++] ?? [];
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      };
    }),
  } as unknown as Tx;
}

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONV = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

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

describe('requireDirectFriendship', () => {
  it('is a no-op for a non-DM conversation (isDirect=false) — no peer/friendship lookup', async () => {
    const tx = mockTxSeq([[{ isDirect: false }]]);
    await expect(requireDirectFriendship(tx, CONV, USER_A)).resolves.toBeUndefined();
    expect((tx.select as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // conversation lookup only
  });

  it('is a no-op for a legacy conversation (isDirect=null)', async () => {
    const tx = mockTxSeq([[{ isDirect: null }]]);
    await expect(requireDirectFriendship(tx, CONV, USER_A)).resolves.toBeUndefined();
    expect((tx.select as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('resolves for a DM with exactly one peer who is an accepted friend', async () => {
    const tx = mockTxSeq([[{ isDirect: true }], [{ userId: USER_B }], [{ id: 'f1' }]]);
    await expect(requireDirectFriendship(tx, CONV, USER_A)).resolves.toBeUndefined();
  });

  it('throws Forbidden for a DM whose single peer is not a friend', async () => {
    const tx = mockTxSeq([[{ isDirect: true }], [{ userId: USER_B }], []]);
    await expect(requireDirectFriendship(tx, CONV, USER_A)).rejects.toThrow(ForbiddenException);
  });

  it('fails CLOSED (500) for a DM with more than one peer — never gates on an arbitrary member', async () => {
    const tx = mockTxSeq([[{ isDirect: true }], [{ userId: USER_B }, { userId: USER_C }]]);
    await expect(requireDirectFriendship(tx, CONV, USER_A)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('fails CLOSED (500) for a DM with no peer besides the caller', async () => {
    const tx = mockTxSeq([[{ isDirect: true }], []]);
    await expect(requireDirectFriendship(tx, CONV, USER_A)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('fails CLOSED (500) when the conversation row is missing (membership precondition violated)', async () => {
    const tx = mockTxSeq([[]]);
    await expect(requireDirectFriendship(tx, CONV, USER_A)).rejects.toThrow(
      InternalServerErrorException,
    );
  });
});

describe('canonicalPair', () => {
  it('returns the lower id as low and higher as high', () => {
    expect(canonicalPair(USER_A, USER_B)).toEqual({ low: USER_A, high: USER_B });
  });

  it('is symmetric — argument order does not change the pair', () => {
    expect(canonicalPair(USER_B, USER_A)).toEqual(canonicalPair(USER_A, USER_B));
  });

  it('lower-cases uppercase UUID input so it matches the stored canonical row', () => {
    const upper = USER_A.toUpperCase();
    expect(canonicalPair(upper, USER_B)).toEqual(canonicalPair(USER_A, USER_B));
  });
});
