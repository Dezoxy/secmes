import { describe, expect, it } from 'vitest';
import { releaseNotes } from './release-notes';

// The changelog is GENERATED from git tags + commits (apps/web/scripts/gen-release-notes.mjs) and re-exported
// here. Assert the re-exported data's SHAPE only — specific content varies by tag/commits, and the generator's
// parsing/grouping is covered by scripts/release-notes-core.spec.ts.
describe('release notes (generated)', () => {
  it('exposes a non-empty list of well-formed entries', () => {
    expect(Array.isArray(releaseNotes)).toBe(true);
    expect(releaseNotes.length).toBeGreaterThan(0);
    for (const note of releaseNotes) {
      expect(note.version.trim().length).toBeGreaterThan(0);
      expect(note.title.trim().length).toBeGreaterThan(0);
      expect(note.groups.length).toBeGreaterThan(0);
      for (const group of note.groups) {
        expect(group.label.trim().length).toBeGreaterThan(0);
        expect(group.items.length).toBeGreaterThan(0);
        for (const item of group.items) expect(item.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
