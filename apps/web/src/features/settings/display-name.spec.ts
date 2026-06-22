import { describe, expect, it } from 'vitest';
import { DISPLAY_NAME_MAX, DISPLAY_NAME_MIN } from '@argus/contracts';
import { DISPLAY_NAME_HINT, displayNameFieldError } from './display-name';

// The hint + error mapping that drives the live (as-you-type) validation in ProfileEdit. The
// underlying allow-list is exhaustively tested in @argus/contracts; here we pin the web-facing
// message selection and the always-visible guidance string.
describe('displayNameFieldError', () => {
  it('returns null for a valid name', () => {
    expect(displayNameFieldError('Brave Otter')).toBeNull();
  });

  it('reports the minimum length for too-short input', () => {
    expect(displayNameFieldError('a')).toBe(
      `display name must be at least ${DISPLAY_NAME_MIN} characters`,
    );
    expect(displayNameFieldError('')).toBe(
      `display name must be at least ${DISPLAY_NAME_MIN} characters`,
    );
  });

  it('reports the maximum length for too-long input', () => {
    expect(displayNameFieldError('A'.repeat(DISPLAY_NAME_MAX + 1))).toBe(
      `display name must be at most ${DISPLAY_NAME_MAX} characters`,
    );
  });

  it('reports the allowed set for disallowed characters', () => {
    const allowedMsg = "display name may use letters, numbers, spaces, and . _ - ' only";
    expect(displayNameFieldError('bad@name')).toBe(allowedMsg);
    expect(displayNameFieldError('wave \u{1f44b}')).toBe(allowedMsg); // emoji
    expect(displayNameFieldError('Bad\u200bName')).toBe(allowedMsg); // zero-width space
  });
});

describe('DISPLAY_NAME_HINT', () => {
  it('states the length bounds and the allowed characters', () => {
    expect(DISPLAY_NAME_HINT).toContain(`${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters`);
    expect(DISPLAY_NAME_HINT).toContain("letters, numbers, spaces, and . _ - '");
  });
});
