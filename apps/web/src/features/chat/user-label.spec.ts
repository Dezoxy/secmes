import { describe, expect, it } from 'vitest';
import { contactDisplayName, contactSearchText } from './user-label';

describe('contact labels', () => {
  it('uses an explicit display name when present', () => {
    const user = { id: 'user-1', displayName: 'Shadow Operator', email: 'shadow@example.test' };

    expect(contactDisplayName(user)).toBe('Shadow Operator');
    expect(contactSearchText(user)).toBe('shadow operator user-1');
  });

  it('does not infer visible identity or search text from email', () => {
    const user = { id: 'user-2', displayName: '', email: 'alice@example.test' };

    expect(contactDisplayName(user)).toBe('Anonymous contact');
    expect(contactSearchText(user)).toBe('user-2');
  });

  it('handles nullable backend display names', () => {
    const user = { id: 'user-3', displayName: null, email: 'null-name@example.test' };

    expect(contactDisplayName(user)).toBe('Anonymous contact');
    expect(contactSearchText(user)).toBe('user-3');
  });
});
