// The About-page changelog is GENERATED from git tags + conventional commits at build time
// (apps/web/scripts/gen-release-notes.mjs), never hand-edited. This module just re-exports the generated
// data + the shared type so consumers keep a stable import path. Run `pnpm --filter @argus/web gen:notes`
// to refresh the committed fallback; CD regenerates it before the image build.
export type { ReleaseNote } from './release-notes-types';
export { releaseNotes } from '../generated/release-notes.generated';
