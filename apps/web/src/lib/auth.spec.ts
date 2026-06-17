import { describe, it, expect, afterEach } from 'vitest';
import { setToken, accessToken } from './auth';

// Verify the module-level token store: token held only in memory, never in persistent storage.
describe('in-memory access token store', () => {
  afterEach(() => setToken(null));

  it('returns null when no token is set', async () => {
    expect(await accessToken()).toBeNull();
  });

  it('returns the token after setToken', async () => {
    setToken('test-jwt');
    expect(await accessToken()).toBe('test-jwt');
  });

  it('clears the token on setToken(null)', async () => {
    setToken('tok');
    setToken(null);
    expect(await accessToken()).toBeNull();
  });
});
