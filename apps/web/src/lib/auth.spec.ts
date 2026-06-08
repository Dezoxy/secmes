import { describe, it, expect } from 'vitest';
import { createMemoryStorage, subjectFromUser } from './auth';

// The §8 invariant: the OIDC user/token store is in-memory only (never the browser's persistent
// storage), so an XSS can't lift a token from there. The store is wired into the UserManager's
// `userStore` in auth.ts; here we verify the shim is a real, isolated in-memory Storage.
describe('in-memory OIDC token store', () => {
  it('behaves like a Storage instance', () => {
    const s = createMemoryStorage();
    expect(s.length).toBe(0);
    s.setItem('k', 'v');
    expect(s.getItem('k')).toBe('v');
    expect(s.length).toBe(1);
    expect(s.key(0)).toBe('k');
    s.removeItem('k');
    expect(s.getItem('k')).toBeNull();
    s.setItem('a', '1');
    s.clear();
    expect(s.length).toBe(0);
  });

  it('isolates separate instances', () => {
    const a = createMemoryStorage();
    const b = createMemoryStorage();
    a.setItem('x', '1');
    expect(b.getItem('x')).toBeNull();
  });
});

describe('OIDC subject extraction', () => {
  it('uses only the stable subject claim for local storage scoping', () => {
    expect(
      subjectFromUser({
        profile: {
          sub: 'zitadel-subject-123',
          email: 'alice@example.test',
          name: 'Alice Example',
        },
      }),
    ).toBe('zitadel-subject-123');
  });

  it('does not fall back to email or display name as an identity scope', () => {
    expect(
      subjectFromUser({
        profile: {
          email: 'alice@example.test',
          name: 'Alice Example',
        },
      }),
    ).toBeNull();
  });
});
