import { describe, expect, it } from 'vitest';

import {
  isPresignedAttachmentUrl,
  isPwaOfflineShellAsset,
  isPwaNavigationFallbackAllowed,
  isPwaStaticPrecacheCandidate,
  pwaNavigateFallback,
  pwaPrecacheGlobPatterns,
  shouldUsePwaRuntimeCache,
} from './pwa-cache-policy';

function request(url: string, headers?: HeadersInit): Request {
  return new Request(url, { headers });
}

describe('PWA cache policy', () => {
  it('keeps precache narrowed to static build assets', () => {
    expect(pwaPrecacheGlobPatterns).toEqual(['**/*.{css,html,ico,js,png,svg,webmanifest}']);
    expect(isPwaStaticPrecacheCandidate('/assets/app.js')).toBe(true);
    expect(isPwaStaticPrecacheCandidate('/assets/app.css')).toBe(true);
    expect(isPwaStaticPrecacheCandidate('/icon.svg')).toBe(true);
    expect(isPwaStaticPrecacheCandidate('/api/messages')).toBe(false);
    expect(isPwaStaticPrecacheCandidate('/attachments/decrypted-content')).toBe(false);
  });

  it('does not serve navigation fallback for auth callback or API-like routes', () => {
    expect(pwaNavigateFallback).toBe('/index.html');
    expect(isPwaOfflineShellAsset('/index.html')).toBe(true);
    expect(isPwaOfflineShellAsset('/auth/callback')).toBe(false);
    expect(isPwaNavigationFallbackAllowed('/chat')).toBe(true);
    expect(isPwaNavigationFallbackAllowed('/settings')).toBe(true);
    expect(isPwaNavigationFallbackAllowed('/auth/callback?code=secret&state=opaque')).toBe(false);
    expect(isPwaNavigationFallbackAllowed('/api/conversations')).toBe(false);
    expect(isPwaNavigationFallbackAllowed('/ws')).toBe(false);
  });

  it('recognizes S3-compatible presigned URLs', () => {
    expect(
      isPresignedAttachmentUrl(
        new URL('https://s3.eu-central-003.backblazeb2.com/bucket/file?X-Amz-Signature=secret'),
      ),
    ).toBe(true);
    expect(isPresignedAttachmentUrl(new URL('https://cdn.example.com/assets/app.js'))).toBe(false);
  });

  it('does not runtime-cache auth-bearing, API, presigned, or static requests', () => {
    expect(
      shouldUsePwaRuntimeCache(
        request('https://app.example.com/assets/app.js', { Authorization: 'Bearer token' }),
        new URL('https://app.example.com/assets/app.js'),
      ),
    ).toBe(false);
    expect(
      shouldUsePwaRuntimeCache(
        request('https://app.example.com/api/messages'),
        new URL('https://app.example.com/api/messages'),
      ),
    ).toBe(false);
    expect(
      shouldUsePwaRuntimeCache(
        request('https://s3.eu-central-003.backblazeb2.com/bucket/file?X-Amz-Signature=secret'),
        new URL('https://s3.eu-central-003.backblazeb2.com/bucket/file?X-Amz-Signature=secret'),
      ),
    ).toBe(false);
    expect(
      shouldUsePwaRuntimeCache(
        request('https://app.example.com/assets/app.js'),
        new URL('https://app.example.com/assets/app.js'),
      ),
    ).toBe(false);
  });
});
