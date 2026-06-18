import { describe, expect, it } from 'vitest';
import webPackage from '../../package.json';
import { APP_VERSION, APP_VERSION_TAG, normalizeAppVersion } from './app-version';

describe('app version metadata', () => {
  it('falls back to the web package version when no build version is injected', () => {
    expect(APP_VERSION).toBe(webPackage.version);
    expect(APP_VERSION_TAG).toBe(`v${webPackage.version}`);
  });
});

describe('normalizeAppVersion', () => {
  it('strips the aws- experiment prefix and a leading v', () => {
    expect(normalizeAppVersion('aws-v0.4.0')).toBe('0.4.0');
    expect(normalizeAppVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeAppVersion('2.0.0')).toBe('2.0.0');
  });

  it('falls back to 0.0.0 for empty/unset input', () => {
    expect(normalizeAppVersion(undefined)).toBe('0.0.0');
    expect(normalizeAppVersion('')).toBe('0.0.0');
    expect(normalizeAppVersion('   ')).toBe('0.0.0');
  });
});
