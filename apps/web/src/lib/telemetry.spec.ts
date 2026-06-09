import { describe, expect, it } from 'vitest';

import { createTelemetryEvent } from './telemetry';

describe('privacy-safe telemetry boundary', () => {
  it('accepts event names and technical metadata only', () => {
    const result = createTelemetryEvent('settings.section_opened', {
      section: 'security',
      status: 'ok',
      durationMs: 42,
      retryable: false,
      empty: undefined,
    });

    expect(result).toEqual({
      ok: true,
      event: {
        name: 'settings.section_opened',
        metadata: {
          section: 'security',
          status: 'ok',
          durationMs: 42,
          retryable: false,
        },
      },
    });
  });

  it('rejects invalid event names', () => {
    expect(createTelemetryEvent('Message Sent', {}).ok).toBe(false);
    expect(createTelemetryEvent('message.sent.with.user@example.com', {}).ok).toBe(false);
  });

  it('rejects sensitive metadata keys', () => {
    const sensitiveKeys = [
      'messageContent',
      'accessToken',
      'privateKey',
      'recoveryPassphrase',
      'authorizationHeader',
    ];

    for (const key of sensitiveKeys) {
      const result = createTelemetryEvent('chat.send_failed', { [key]: 'secret' });

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'sensitive-metadata' },
      });
    }
  });

  it('rejects sensitive metadata values', () => {
    const sensitiveValues = [
      'Authorization: Bearer secret-token',
      'token=secret-token',
      'private key material',
      'recovery passphrase words',
      'plaintext message body',
    ];

    for (const value of sensitiveValues) {
      const result = createTelemetryEvent('chat.send_failed', { reason: value });

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'sensitive-metadata' },
      });
    }
  });

  it('rejects free-form string metadata under innocuous keys', () => {
    const freeForm = createTelemetryEvent('chat.send_failed', {
      reason: 'meet me at 5 by the gate',
    });
    const enumLike = createTelemetryEvent('chat.send_failed', {
      failureKind: 'network_timeout',
    });

    expect(freeForm).toMatchObject({
      ok: false,
      error: { kind: 'unsupported-metadata' },
    });
    expect(enumLike).toMatchObject({
      ok: true,
      event: { metadata: { failureKind: 'network_timeout' } },
    });
  });

  it('rejects presigned attachment URLs', () => {
    const result = createTelemetryEvent('attachment.upload_failed', {
      storageRegion: 'eu-central-003',
      failure: 'https://s3.eu-central-003.backblazeb2.com/bucket/file?X-Amz-Signature=secret',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'sensitive-metadata' },
    });
  });

  it('rejects nested or structured values', () => {
    const result = createTelemetryEvent('settings.section_opened', {
      section: ['security'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'unsupported-metadata' },
    });
  });
});
