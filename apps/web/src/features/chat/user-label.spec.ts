import { describe, expect, it } from 'vitest';
import { contactDisplayName, contactSearchText } from './user-label';

describe('contact labels', () => {
  it('uses an explicit display name when present', () => {
    const user = {
      userId: 'user-1',
      argusId: 'argus-abc123-shadow',
      displayName: 'Shadow Operator',
    };

    expect(contactDisplayName(user)).toBe('Shadow Operator');
    expect(contactSearchText(user)).toBe('shadow operator argus-abc123-shadow');
  });

  it('falls back to Anonymous contact when displayName is blank', () => {
    const user = { userId: 'user-2', argusId: 'argus-abc123-blank', displayName: '' };

    expect(contactDisplayName(user)).toBe('Anonymous contact');
    expect(contactSearchText(user)).toBe('argus-abc123-blank');
  });

  it('handles nullable backend display names', () => {
    const user = { userId: 'user-3', argusId: 'argus-abc123-null', displayName: null };

    expect(contactDisplayName(user)).toBe('Anonymous contact');
    expect(contactSearchText(user)).toBe('argus-abc123-null');
  });

  it('falls back to userId in search text when argusId is absent', () => {
    const user = { userId: 'user-4', displayName: null };

    expect(contactSearchText(user)).toBe('user-4');
  });
});
