import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// React + Vite PWA — the static, crypto-blind-friendly client for secmes.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'secmes',
        short_name: 'secmes',
        description: 'Privacy-first, end-to-end-encrypted messaging',
        theme_color: '#1a1a24',
        background_color: '#1a1a24',
        display: 'standalone',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
});
