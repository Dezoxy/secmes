import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// React + Vite PWA — the static, crypto-blind-friendly client for argus.
export default defineConfig({
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
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'argus',
        short_name: 'argus',
        description: 'Privacy-first, end-to-end-encrypted messaging',
        theme_color: '#1a1a24',
        background_color: '#1a1a24',
        display: 'standalone',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
});
