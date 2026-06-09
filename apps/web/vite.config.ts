import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { sri } from 'vite-plugin-sri3';
import webPackage from './package.json';
import {
  pwaNavigateFallback,
  pwaNavigateFallbackDenylist,
  pwaPrecacheGlobPatterns,
} from './src/lib/pwa-cache-policy';
import { argusPwaManifest } from './src/lib/pwa-installability';

interface BundleReportEntry {
  fileName: string;
  bytes: number;
  type: 'asset' | 'chunk';
}

const bundleReportAssetPattern = /\.(?:css|js)$/;
const bundleReportEntryLimit = 8;

function byteLength(value: string | Uint8Array): number {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function bundleVisibilityPlugin(): Plugin {
  return {
    name: 'argus-bundle-visibility',
    apply: 'build',
    generateBundle(_options, bundle) {
      const entries: BundleReportEntry[] = Object.values(bundle)
        .filter((output) => bundleReportAssetPattern.test(output.fileName))
        .map((output) => ({
          fileName: output.fileName,
          bytes: output.type === 'chunk' ? byteLength(output.code) : byteLength(output.source),
          type: output.type,
        }))
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, bundleReportEntryLimit);

      if (entries.length === 0) return;

      this.info(
        [
          'argus bundle visibility: largest generated JS/CSS assets',
          ...entries.map(
            (entry) =>
              `  ${formatBytes(entry.bytes).padStart(9)}  ${entry.type}  ${entry.fileName}`,
          ),
        ].join('\n'),
      );
    },
  };
}

interface BundleManifestFile {
  file: string;
  sha384: string;
  bytes: number;
}

// Published bundle hash (#43): emit bundle-manifest.json with a sha384 for every built JS/CSS asset (the same
// value the SRI `integrity="sha384-…"` attrs carry) plus one deterministic build digest. Lets an auditor (and
// the future security page, roadmap G7) verify "what bytes is my browser running". This is a CHECKSUM over
// PUBLIC static artifacts — not message/key crypto and not a protocol — so it intentionally lives here, not in
// `packages/crypto` (see docs/threat-models/code-delivery-integrity.md §4). No secrets enter the manifest;
// `.json` is outside the PWA precache glob, so it stays network-fetched (always fresh).
function bundleIntegrityManifestPlugin(): Plugin {
  return {
    name: 'argus-bundle-integrity-manifest',
    apply: 'build',
    // writeBundle, NOT generateBundle: read each asset back from DISK after Vite has written it, so the sha384
    // is over the exact bytes the browser receives — and equals the SRI `integrity` value. In generateBundle
    // the entry + dynamic-import chunks still hold un-rewritten `__VITE_PRELOAD__` markers (vite's internal
    // import-analysis plugin finalizes them late, which is why sri3 hijacks that plugin); reading from disk
    // sidesteps that ordering entirely and is order-independent of sri/vite-plugin-pwa.
    async writeBundle(options, bundle) {
      const outDir = options.dir ?? 'dist';
      const files: BundleManifestFile[] = [];
      for (const name of Object.keys(bundle).sort()) {
        if (!bundleReportAssetPattern.test(name)) continue;
        const bytes = await readFile(path.join(outDir, name));
        files.push({
          file: name,
          sha384: createHash('sha384').update(bytes).digest('base64'),
          bytes: bytes.byteLength,
        });
      }
      if (files.length === 0) return;

      // One fingerprint over the sorted "file sha384" lines — THE per-build identifier (no app version field:
      // apps/web is unversioned `0.0.0`, so it would imply provenance it can't carry; the digest is the truth).
      // No timestamp → byte-stable across rebuilds of the same source, so a release's client bytes are
      // reproducibly verifiable. Covers the Rollup app bundle (JS/CSS); the service worker + Workbox runtime are
      // pinned separately (Caddy no-cache + content hash).
      const bundleDigest = createHash('sha384')
        .update(files.map((entry) => `${entry.file} ${entry.sha384}`).join('\n'))
        .digest('base64');

      await writeFile(
        path.join(outDir, 'bundle-manifest.json'),
        `${JSON.stringify({ algorithm: 'sha384', bundleDigest, files }, null, 2)}\n`,
      );
    },
  };
}

// React + Vite PWA — the static, crypto-blind-friendly client for argus.
export default defineConfig({
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(webPackage.version),
  },
  // Dev-only: proxy `/api/*` to the local API so the browser talks same-origin (no CORS). The API
  // runs on the host via `make api-dev`; see docs/local-auth.md. Prod uses a real origin (VITE_API_URL).
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // The realtime gateway (Slice 5C). `ws: true` upgrades the connection; the path `/ws` is preserved
      // (the gateway mounts at `/ws`). The token is sent in the first app frame, never the URL.
      '/ws': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    bundleVisibilityPlugin(),
    VitePWA({
      registerType: 'prompt',
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: [...pwaPrecacheGlobPatterns],
        navigateFallback: pwaNavigateFallback,
        navigateFallbackDenylist: [...pwaNavigateFallbackDenylist],
        // Static precache only. API, auth, WebSocket, attachment, and authorization-bearing requests must
        // remain network-only until a threat-modeled runtime cache is intentionally added.
        runtimeCaching: [],
      },
      manifest: argusPwaManifest,
    }),
    // Subresource Integrity (#43): inject sha384 `integrity=` onto the built <script>/<link> tags so the
    // browser refuses to execute a tampered or swapped bundle — defense-in-depth behind the strict
    // `script-src 'self'` CSP (a same-origin compromise that swaps a JS/CSS asset can't run unnoticed).
    // sri3 runs in generateBundle with enforce:'post', so the integrity attrs land in index.html BEFORE
    // vite-plugin-pwa's closeBundle precaches it: the service worker caches the SRI'd HTML and the Workbox
    // precache revisions stay consistent. Same-origin assets need no `crossorigin` for SRI enforcement.
    // Keep this LAST in the plugins array (per sri3 docs) so it hashes the final emitted content.
    sri(),
    // Published bundle hash (#43): emits dist/bundle-manifest.json. Hashes assets read back from disk in
    // writeBundle, so it is order-independent of sri / vite-plugin-pwa.
    bundleIntegrityManifestPlugin(webPackage.version),
  ],
});
