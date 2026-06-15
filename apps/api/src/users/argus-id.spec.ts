import { describe, expect, it } from 'vitest';

import { ARGUS_ID_INDEX, generateArgusId, isArgusIdCollision } from './argus-id.js';

const ARGUS_ID_PATTERN = /^argus-[abcdefghjkmnpqrstuvwxyz23456789]{16}-[a-z]+$/;

describe('generateArgusId', () => {
  it('produces the canonical format', () => {
    const id = generateArgusId();
    expect(id).toMatch(ARGUS_ID_PATTERN);
  });

  it('starts with argus- prefix', () => {
    expect(generateArgusId()).toMatch(/^argus-/);
  });

  it('produces 1000 distinct ids (collision-free at this scale)', () => {
    const ids = Array.from({ length: 1000 }, generateArgusId);
    expect(new Set(ids).size).toBe(1000);
  });

  it('never uses ambiguous characters (0, 1, i, l, o) in the random segment', () => {
    for (let i = 0; i < 100; i++) {
      const id = generateArgusId();
      const segment = id.split('-')[1]!;
      expect(segment).not.toMatch(/[01ilo]/);
    }
  });
});

describe('isArgusIdCollision', () => {
  it('returns true for a 23505 on the argus_id index', () => {
    const err = { code: '23505', constraint_name: ARGUS_ID_INDEX };
    expect(isArgusIdCollision(err)).toBe(true);
  });

  it('returns true when wrapped in a cause chain', () => {
    const err = { cause: { code: '23505', constraint_name: ARGUS_ID_INDEX } };
    expect(isArgusIdCollision(err)).toBe(true);
  });

  it('returns false for a 23505 on a different index', () => {
    const err = { code: '23505', constraint_name: 'users_tenant_display_name_idx' };
    expect(isArgusIdCollision(err)).toBe(false);
  });

  it('returns false for non-unique-violation errors', () => {
    expect(isArgusIdCollision(new Error('network timeout'))).toBe(false);
    expect(isArgusIdCollision({ code: '23503' })).toBe(false);
    expect(isArgusIdCollision(null)).toBe(false);
  });
});
