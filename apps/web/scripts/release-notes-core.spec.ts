import { describe, expect, it } from 'vitest';

import {
  buildReleaseEntry,
  buildReleaseNotes,
  normalizeTagVersion,
  parseCommitSubject,
  tagRefGlobs,
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
  it('groups feat→New / fix+perf→Fixes, capitalizes, drops PR refs + noise, date as title', () => {
    const entry = buildReleaseEntry({
      version: 'v1.0.0',
      date: '2026-01-02',
      subjects: ['fix: b (#2)', 'feat: a (#1)', 'chore: c', 'perf: p (#3)'],
    });
    expect(entry).toEqual({
      version: 'v1.0.0',
      title: '2026-01-02',
      groups: [
        { label: 'New', items: ['A'] },
        { label: 'Fixes', items: ['B', 'P'] },
      ],
    });
  });

  it('capitalizes an all-lowercase first word but preserves a leading mixed-case product name', () => {
    const entry = buildReleaseEntry({
      version: 'v1',
      date: 'd',
      subjects: ['feat: iOS install prompt', 'fix: macOS notarization', 'fix: tidy logs'],
    });
    expect(entry?.groups).toEqual([
      { label: 'New', items: ['iOS install prompt'] },
      { label: 'Fixes', items: ['macOS notarization', 'Tidy logs'] },
    ]);
  });

  it('omits a group with no items (fixes-only release)', () => {
    const entry = buildReleaseEntry({ version: 'v1', date: 'd', subjects: ['fix: only a fix'] });
    expect(entry?.groups).toEqual([{ label: 'Fixes', items: ['Only a fix'] }]);
  });

  it('returns null when nothing user-facing remains', () => {
    expect(
      buildReleaseEntry({ version: 'v1', date: 'd', subjects: ['chore: x', 'ci: y'] }),
    ).toBeNull();
    expect(buildReleaseEntry({ version: 'v1', date: 'd', subjects: [] })).toBeNull();
  });

  it('caps at 12 items and carries the overflow as a neutral note, not inside a group', () => {
    const subjects = Array.from({ length: 15 }, (_, i) => `feat: item ${i}`);
    const entry = buildReleaseEntry({ version: 'v1', date: 'd', subjects });
    expect(entry?.groups).toHaveLength(1);
    const newGroup = entry?.groups[0];
    expect(newGroup?.label).toBe('New');
    expect(newGroup?.items).toHaveLength(12); // capped; the overflow line is NOT mixed into the group
    expect(entry?.overflowNote).toBe('…and 3 more changes');
  });

  it('does not misfile hidden fixes under New when the first 12 are all feats', () => {
    const subjects = [
      ...Array.from({ length: 12 }, (_, i) => `feat: feature ${i}`),
      'fix: a hidden fix',
      'fix: another hidden fix',
    ];
    const entry = buildReleaseEntry({ version: 'v1', date: 'd', subjects });
    // Only New survives the cap; the hidden fixes must NOT appear as a phantom "more changes" item under New.
    expect(entry?.groups.map((g) => g.label)).toEqual(['New']);
    expect(entry?.groups[0]?.items).toHaveLength(12);
    expect(entry?.groups[0]?.items.some((i) => i.includes('more changes'))).toBe(false);
    expect(entry?.overflowNote).toBe('…and 2 more changes');
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

describe('tagRefGlobs', () => {
  it('scopes an experiment build to the aws-v* namespace only', () => {
    expect(tagRefGlobs('aws-v0.4.0')).toEqual(['refs/tags/aws-v*']);
  });

  it('scopes a prod build to the v* namespace only', () => {
    expect(tagRefGlobs('v1.2.3')).toEqual(['refs/tags/v*']);
  });

  it('falls back to both namespaces when the trigger is unknown/empty (local/dev)', () => {
    expect(tagRefGlobs('')).toEqual(['refs/tags/v*', 'refs/tags/aws-v*']);
    expect(tagRefGlobs(undefined)).toEqual(['refs/tags/v*', 'refs/tags/aws-v*']);
    expect(tagRefGlobs('nightly')).toEqual(['refs/tags/v*', 'refs/tags/aws-v*']);
  });
});
