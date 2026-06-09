import { describe, expect, it } from 'vitest';
import { releaseNotes } from './release-notes';

describe('release notes', () => {
  function parseVersion(version: string): number[] {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) return [];
    return match.slice(1).map(Number);
  }

  it('includes readable notes in newest-first order', () => {
    expect(releaseNotes[0]?.version).toBe('v0.3.2');
    expect(releaseNotes.at(-1)?.version).toBe('v0.0.1');

    for (const note of releaseNotes) {
      expect(note.version).toMatch(/^v0\.\d+\.\d+$/);
      expect(note.version).not.toBe('v0.0.0');
      expect(note.title.trim().length).toBeGreaterThan(0);
      expect(note.items.length).toBeGreaterThan(0);
      for (const item of note.items) expect(item.trim().length).toBeGreaterThan(0);
    }

    for (let index = 1; index < releaseNotes.length; index += 1) {
      const previous = parseVersion(releaseNotes[index - 1]!.version);
      const current = parseVersion(releaseNotes[index]!.version);
      expect(previous.length).toBe(3);
      expect(current.length).toBe(3);
      expect(previous[0]! * 10_000 + previous[1]! * 100 + previous[2]!).toBeGreaterThan(
        current[0]! * 10_000 + current[1]! * 100 + current[2]!,
      );
    }
  });
});
