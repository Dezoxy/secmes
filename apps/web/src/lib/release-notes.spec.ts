import { describe, expect, it } from 'vitest';
import { APP_VERSION_TAG } from './app-version';
import { releaseNotes } from './release-notes';

describe('release notes', () => {
  it('includes a current app-version entry with readable notes', () => {
    expect(releaseNotes[0]?.version).toBe(APP_VERSION_TAG);

    for (const note of releaseNotes) {
      expect(note.version).toMatch(/^v\d+\.\d+\.\d+/);
      expect(note.title.trim().length).toBeGreaterThan(0);
      expect(note.items.length).toBeGreaterThan(0);
      for (const item of note.items) expect(item.trim().length).toBeGreaterThan(0);
    }
  });
});
