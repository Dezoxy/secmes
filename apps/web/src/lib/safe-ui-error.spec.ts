import { describe, expect, it } from 'vitest';

import { createSafeUiError, isSafeUiError, toSafeUiError } from './safe-ui-error';

describe('safe UI errors', () => {
  it('does not expose arbitrary Error.message content', () => {
    const raw = new Error(
      'POST https://storage.example.com/file?X-Amz-Signature=secret Authorization: Bearer token123 plaintext hello',
    );
    raw.stack = 'Error: leaked stack\n    at sendMessage (/private/tmp/source.ts:9:1)';

    const safe = toSafeUiError(raw);

    expect(safe.message).not.toContain('storage.example.com');
    expect(safe.message).not.toContain('X-Amz-Signature');
    expect(safe.message).not.toContain('Bearer');
    expect(safe.message).not.toContain('token123');
    expect(safe.message).not.toContain('plaintext hello');
    expect(safe.message).not.toContain('/private/tmp');
  });

  it('does not expose arbitrary string errors', () => {
    const safe = toSafeUiError('message content with token=secret and https://example.com/path');

    expect(safe.message).toBe('This action could not be completed. Try again in a moment.');
    expect(safe.message).not.toContain('secret');
    expect(safe.message).not.toContain('example.com');
  });

  it('maps API client errors to safe copy and metadata', () => {
    const safe = toSafeUiError({
      kind: 'http',
      status: 401,
      message: 'GET /api/me failed with Authorization: Bearer secret-token',
    });

    expect(safe).toMatchObject({
      safe: true,
      title: 'Request failed',
      message: 'Your session may have expired. Sign in again if this keeps happening.',
      status: 401,
      kind: 'http',
    });
    expect(safe.message).not.toContain('/api/me');
    expect(safe.message).not.toContain('secret-token');
  });

  it('maps failed ApiResult objects without exposing response details', () => {
    const safe = toSafeUiError({
      ok: false,
      status: 500,
      error: {
        kind: 'http',
        status: 500,
        message: 'https://storage.example.com/private?sig=secret failed',
      },
    });

    expect(safe.message).toBe('The service is unavailable. Try again in a moment.');
    expect(safe.status).toBe(500);
    expect(safe.message).not.toContain('storage.example.com');
  });

  it('preserves explicitly created safe UI errors', () => {
    const safe = createSafeUiError({
      title: 'Profile not saved',
      message: 'Use a smaller avatar.',
      kind: 'local-storage',
    });

    expect(isSafeUiError(safe)).toBe(true);
    expect(toSafeUiError(safe)).toEqual(safe);
  });
});
