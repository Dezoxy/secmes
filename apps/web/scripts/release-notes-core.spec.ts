import { describe, expect, it } from 'vitest';

import {
  buildReleaseEntry,
  buildReleaseNotes,
  normalizeTagVersion,
  parseCommitSubject,
} from './release-notes-core.mjs';

describe('parseCommitSubject', () => {
  it('parses a scoped feat with a PR ref', () => {
    expect(parseCommitSubject('feat(web): passkey unlock (#227)')).toEqual({
      type: 'feat',
      scope: 'web',
      summary: 'passkey unlock',
      pr: '227',
    });
  });

  it('parses an unscoped fix without a PR ref', () => {
    expect(parseCommitSubject('fix: tenant id')).toEqual({
      type: 'fix',
      scope: null,
      summary: 'tenant id',
      pr: null,
    });
  });

  it('treats a breaking `!` marker as the same type', () => {
    expect(parseCommitSubject('feat(api)!: drop legacy route (#9)')?.type).toBe('feat');
  });

  it('drops noise types and non-conventional / merge lines', () => {
    expect(parseCommitSubject('chore(deps): bump zod (#1)')).toBeNull();
    expect(parseCommitSubject('docs: readme')).toBeNull();
    expect(parseCommitSubject('ci(security): pin actions')).toBeNull();
    expect(parseCommitSubject('Merge pull request #5 from x')).toBeNull();
    expect(parseCommitSubject('just some text')).toBeNull();
    expect(parseCommitSubject('')).toBeNull();
  });
});

describe('buildReleaseEntry', () => {
  it('keeps feat+fix (feat first), prefixes fixes, drops noise, uses date as title', () => {
    const entry = buildReleaseEntry({
      version: 'v1.0.0',
      date: '2026-01-02',
      subjects: ['fix: b (#2)', 'feat: a (#1)', 'chore: c', 'perf: p (#3)'],
    });
    expect(entry).toEqual({
      version: 'v1.0.0',
      title: '2026-01-02',
      items: ['a (#1)', 'Fix: b (#2)', 'Fix: p (#3)'],
    });
  });

  it('returns null when nothing user-facing remains', () => {
    expect(
      buildReleaseEntry({ version: 'v1', date: 'd', subjects: ['chore: x', 'ci: y'] }),
    ).toBeNull();
    expect(buildReleaseEntry({ version: 'v1', date: 'd', subjects: [] })).toBeNull();
  });

  it('caps at 12 items with an overflow line', () => {
    const subjects = Array.from({ length: 15 }, (_, i) => `feat: item ${i}`);
    const entry = buildReleaseEntry({ version: 'v1', date: 'd', subjects });
    expect(entry?.items).toHaveLength(13); // 12 + overflow
    expect(entry?.items.at(-1)).toBe('…and 3 more changes');
  });
});

describe('buildReleaseNotes', () => {
  it('drops releases with no user-facing changes', () => {
    const notes = buildReleaseNotes([
      { version: 'v2', date: 'd2', subjects: ['feat: x (#1)'] },
      { version: 'v1', date: 'd1', subjects: ['chore: y'] },
    ]);
    expect(notes.map((n) => n.version)).toEqual(['v2']);
  });
});

describe('normalizeTagVersion', () => {
  it('strips aws- and v prefixes', () => {
    expect(normalizeTagVersion('aws-v0.4.0')).toBe('0.4.0');
    expect(normalizeTagVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeTagVersion('0.0.0')).toBe('0.0.0');
  });
});
