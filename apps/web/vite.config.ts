import { Buffer } from 'node:buffer';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
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
  ],
});
