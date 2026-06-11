import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./auth', () => ({ accessToken: vi.fn() }));
import { accessToken } from './auth';
import { storeBackup, fetchBackup } from './api';

const token = vi.mocked(accessToken);

describe('key backup API wrappers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    token.mockResolvedValue('test-token');
  });

  describe('storeBackup', () => {
    it('PUT /backups/me with the artifact and returns on 204', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));

      await expect(storeBackup('opaque-artifact-blob')).resolves.toBeUndefined();
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe('/api/backups/me');
      expect((init as RequestInit).method).toBe('PUT');
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        backup: 'opaque-artifact-blob',
      });
    });

    it('throws on a non-204 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
      await expect(storeBackup('artifact')).rejects.toThrow();
    });
  });

  describe('fetchBackup', () => {
    it('returns the backup string on 200', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ backup: 'sealed-artifact' }), { status: 200 }),
      );

      const result = await fetchBackup();
      expect(result).toBe('sealed-artifact');
    });

    it('returns null on 404', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ message: 'no backup stored' }), { status: 404 }),
      );

      const result = await fetchBackup();
      expect(result).toBeNull();
    });

    it('throws a classified message on unexpected non-OK status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
      await expect(fetchBackup()).rejects.toThrow('status 500');
    });

    it('throws when response body fails the contract schema', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ wrong: 'shape' }), { status: 200 }),
      );
      await expect(fetchBackup()).rejects.toThrow('did not match the expected contract');
    });
  });
});
