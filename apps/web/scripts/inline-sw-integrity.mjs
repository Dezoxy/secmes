// Post-build step (CDI-1): inline the per-asset SHA-384 map into dist/sw.js so the service worker can verify
// dynamically-import()ed crypto chunks (nist-*, ed448-*, chacha-*, …) before they execute. The hashes come
// straight from dist/bundle-manifest.json — the SAME values the SRI integrity= attrs carry (one source of
// truth). This runs AFTER `vite build` (a post-build npm step, not a Vite plugin) because vite-plugin-pwa
// emits sw.js late in its own closeBundle, after every other plugin hook — so a deterministic post-build pass
// is the only reliable ordering. The map MUST be inlined, never runtime-fetched: a runtime fetch would let an
// attacker who swapped a chunk also serve a matching manifest (the CDI-3 self-defeat).
// See docs/threat-models/code-delivery-integrity.md.
/* global process, console */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outDir = process.argv[2] ?? 'dist';
const manifestPath = path.join(outDir, 'bundle-manifest.json');
const swPath = path.join(outDir, 'sw.js');

// esbuild may emit the placeholder string in single, double, OR backtick quotes — match any, and replace the
// WHOLE JSON.parse(...) call with a literal JS object (JSON.stringify output is valid object-literal syntax),
// so the JSON's own double quotes never clash with the surrounding string quote.
const PLACEHOLDER = /JSON\.parse\(\s*(['"`])__SW_INTEGRITY_MANIFEST_JSON__\1\s*\)/;

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const integrity = {};
for (const entry of manifest.files) integrity[entry.file] = entry.sha384;

const sw = await readFile(swPath, 'utf8');
if (!PLACEHOLDER.test(sw)) {
  console.error(
    'inline-sw-integrity: placeholder JSON.parse("__SW_INTEGRITY_MANIFEST_JSON__") not found in ' +
      `${swPath} — sw.ts must keep it so the SRI manifest can be inlined (CDI-1).`,
  );
  process.exit(1);
}
await writeFile(swPath, sw.replace(PLACEHOLDER, JSON.stringify(integrity)));
console.log(
  `inline-sw-integrity: inlined ${Object.keys(integrity).length} asset hashes into ${swPath}`,
);
