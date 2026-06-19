import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Coverage guard (the final piece of the controller-spec effort): every NestJS controller is a route on
// the server's trust boundary, and each one must ship a sibling *.controller.spec.ts pinning its auth
// posture (@Public vs guarded) and status contract via reflectRouteMeta. This meta-test fails the moment a
// new controller lands without a spec, so coverage cannot silently regress. It runs inside `pnpm -r test`
// — the local pre-push gate AND the CI build-test job — so no extra workflow wiring is needed.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function srcFiles(): string[] {
  // recursive readdir → posix-normalised relative paths (Windows back-slashes folded for the sibling match)
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' }).map((p) =>
    p.replaceAll('\\', '/'),
  );
}

describe('controller spec coverage', () => {
  it('every *.controller.ts has a sibling *.controller.spec.ts', () => {
    const files = srcFiles();
    const specs = new Set(files.filter((f) => f.endsWith('.controller.spec.ts')));
    const controllers = files.filter(
      (f) => f.endsWith('.controller.ts') && !f.endsWith('.controller.spec.ts'),
    );

    // Self-check: if the glob found nothing, the path resolution is wrong and the guard would pass vacuously.
    expect(controllers.length).toBeGreaterThan(0);

    const missing = controllers.filter(
      (c) => !specs.has(c.replace(/\.controller\.ts$/, '.controller.spec.ts')),
    );
    expect(missing, `controllers missing a sibling spec:\n${missing.join('\n')}`).toEqual([]);
  });
});
