import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth', () => ({ accessToken: vi.fn() }));
import { accessToken } from './auth';
import { recordReceipt, fetchReceipts } from './api';

const token = vi.mocked(accessToken);

const CONV = '550e8400-e29b-41d4-a716-446655440000';
const U1 = '550e8400-e29b-41d4-a716-446655440001';
const M1 = '550e8400-e29b-41d4-a716-446655440002';

describe('delivery-receipt API wrappers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    token.mockResolvedValue('test-token');
  });

  describe('recordReceipt', () => {
    it('POSTs status + throughMessageId and resolves on 204', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));

      await expect(recordReceipt(CONV, 'read', M1)).resolves.toBeUndefined();
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe(`/api/conversations/${CONV}/receipts`);
      expect((init as RequestInit).method).toBe('POST');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        status: 'read',
        throughMessageId: M1,
      });
    });

    it('throws on a non-204 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
      await expect(recordReceipt(CONV, 'delivered', M1)).rejects.toThrow();
    });
  });

  describe('fetchReceipts', () => {
    it('returns the per-member watermark array on 200', async () => {
      const payload = [
        {
          userId: U1,
          deliveredThroughMessageId: M1,
          deliveredAt: '2026-01-01T00:00:00.000Z',
          readThroughMessageId: null,
          readAt: null,
        },
      ];
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 200 }),
      );

      await expect(fetchReceipts(CONV)).resolves.toEqual(payload);
    });

    it('throws a classified message on an unexpected non-OK status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
      await expect(fetchReceipts(CONV)).rejects.toThrow('status 500');
    });

    it('throws when the response body fails the contract schema', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify([{ wrong: 'shape' }]), { status: 200 }),
      );
      await expect(fetchReceipts(CONV)).rejects.toThrow('did not match the expected contract');
    });
  });
});
