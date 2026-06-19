// Build-output guard (CDI-4): after a build, assert the SW SRI manifest is fully inlined and covers every
// built JS/CSS asset. Catches a future Vite / vite-plugin-pwa / esbuild change that silently drops the
// inlining or a chunk — the exact silent-regression class CDI-4 names. Run in CI after `pnpm -r build`.
/* global process, console */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const outDir = process.argv[2] ?? 'dist';
const sw = await readFile(path.join(outDir, 'sw.js'), 'utf8');
const manifest = JSON.parse(await readFile(path.join(outDir, 'bundle-manifest.json'), 'utf8'));

const errors = [];

// 1. The placeholder must be gone — i.e. the inline step actually ran.
if (sw.includes('__SW_INTEGRITY_MANIFEST_JSON__')) {
  errors.push(
    'dist/sw.js still contains the unreplaced __SW_INTEGRITY_MANIFEST_JSON__ placeholder — the ' +
      'inline-sw-integrity build step did not run (the SW would throw on load).',
  );
}

// 2. Every built asset (incl. the ts-mls crypto chunks) must have its file + hash inlined into sw.js.
for (const { file, sha384 } of manifest.files) {
  if (!sw.includes(file)) errors.push(`asset ${file} is not referenced in the inlined SW manifest`);
  if (!sw.includes(sha384))
    errors.push(`asset ${file}'s sha384 is not present in the inlined SW manifest`);
}

// 3. Sanity: the manifest must actually contain crypto chunks (a guard that the chunks didn't move/rename
// out from under us, which would silently shrink CDI-1's coverage).
const cryptoChunks = manifest.files.filter((f) =>
  /\/(nist|ed448|chacha|ml-dsa|ml-kem|dhkem|hybridkem)/.test(f.file),
);
if (cryptoChunks.length === 0) {
  errors.push(
    'bundle-manifest.json lists no ts-mls crypto chunks — CDI-1 coverage may have regressed; ' +
      'check the chunk naming before relaxing this guard.',
  );
}

if (errors.length > 0) {
  console.error('check-sw-integrity: FAILED\n  - ' + errors.join('\n  - '));
  process.exit(1);
}
console.log(
  `check-sw-integrity: OK — ${manifest.files.length} assets inlined (${cryptoChunks.length} crypto chunks)`,
);
