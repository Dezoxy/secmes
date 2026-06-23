import { describe, expect, it } from 'vitest';
import { pinoConfig, pinoHttpConfig } from './logger.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('pinoConfig', () => {
  it('formats level as string, not number', () => {
    const fmt = pinoConfig.formatters?.level as (label: string) => Record<string, string>;
    expect(fmt('warn')).toEqual({ level: 'warn' });
    expect(fmt('error')).toEqual({ level: 'error' });
    expect(fmt('info')).toEqual({ level: 'info' });
  });
});

describe('pinoHttpConfig', () => {
  describe('serializers.req', () => {
    const reqSerializer = pinoHttpConfig.serializers?.req as (
      req: Partial<IncomingMessage> & { url?: string; method?: string },
    ) => Record<string, unknown>;

    it('strips query string from url', () => {
      expect(reqSerializer({ method: 'GET', url: '/api/foo?token=abc' })).toMatchObject({
        url: '/api/foo',
      });
    });

    it('strips presigned URL query params', () => {
      expect(
        reqSerializer({
          method: 'GET',
          url: '/blobs/key?X-Amz-Signature=abc&AWSAccessKeyId=xyz',
        }),
      ).toMatchObject({ url: '/blobs/key' });
    });

    it('preserves url with no query string', () => {
      expect(reqSerializer({ method: 'POST', url: '/api/auth/session/refresh' })).toMatchObject({
        url: '/api/auth/session/refresh',
      });
    });

    it('returns empty url when url is undefined', () => {
      expect(reqSerializer({ method: 'GET' })).toMatchObject({ url: '' });
    });
  });

  describe('serializers.res', () => {
    it('returns only statusCode', () => {
      const resSerializer = pinoHttpConfig.serializers?.res as (
        res: Partial<ServerResponse>,
      ) => Record<string, unknown>;
      expect(resSerializer({ statusCode: 200 })).toEqual({ statusCode: 200 });
    });
  });

  describe('redact', () => {
    it('includes authorization header path', () => {
      expect(pinoHttpConfig.redact).toContain('req.headers.authorization');
    });

    it('includes cookie header path', () => {
      expect(pinoHttpConfig.redact).toContain('req.headers.cookie');
    });

    it('includes query params path', () => {
      expect(pinoHttpConfig.redact).toContain('req.query');
    });

    it('includes common secret field wildcards', () => {
      expect(pinoHttpConfig.redact).toContain('*.token');
      expect(pinoHttpConfig.redact).toContain('*.password');
      expect(pinoHttpConfig.redact).toContain('*.secret');
      expect(pinoHttpConfig.redact).toContain('*.key');
    });
  });
});
