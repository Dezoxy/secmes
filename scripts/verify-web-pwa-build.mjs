/* global URL, console */
/* eslint-disable no-console, security/detect-non-literal-fs-filename */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const distUrl = new URL('../apps/web/dist/', import.meta.url);

function distPath(relativePath) {
  return new URL(relativePath, distUrl);
}

async function readDistText(relativePath) {
  return readFile(distPath(relativePath), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`PWA build verification failed: ${message}`);
  }
}

for (const file of [
  'index.html',
  'manifest.webmanifest',
  'registerSW.js',
  'robots.txt',
  'sw.js',
  'icon-192.png',
  'icon-512.png',
]) {
  assert(existsSync(distPath(file)), `missing ${file}`);
}

const indexHtml = await readDistText('index.html');
assert(indexHtml.includes('rel="manifest"'), 'index.html does not link the web manifest');
assert(indexHtml.includes('/registerSW.js'), 'index.html does not register the service worker');
assert(
  indexHtml.includes('name="description"') &&
    indexHtml.includes('privacy-first, end-to-end-encrypted messaging PWA'),
  'index.html does not include the Lighthouse-visible app description',
);

const robotsTxt = await readDistText('robots.txt');
assert(robotsTxt.includes('User-agent: *'), 'robots.txt does not declare a user agent');
assert(robotsTxt.includes('Allow: /'), 'robots.txt does not allow the static app shell');

const manifest = JSON.parse(await readDistText('manifest.webmanifest'));
const expectedManifest = {
  id: '/',
  name: 'argus',
  short_name: 'argus',
  lang: 'en',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: '#1a1a24',
  background_color: '#1a1a24',
};

for (const [field, expected] of Object.entries(expectedManifest)) {
  assert(
    manifest[field] === expected,
    `manifest ${field} is ${manifest[field]}, expected ${expected}`,
  );
}

assert(
  Array.isArray(manifest.icons) &&
    manifest.icons.some(
      (icon) =>
        icon.src === '/icon.svg' &&
        icon.sizes === 'any' &&
        icon.type === 'image/svg+xml' &&
        icon.purpose === 'any maskable',
    ),
  'manifest does not include the local maskable SVG icon',
);
for (const [src, sizes] of [
  ['/icon-192.png', '192x192'],
  ['/icon-512.png', '512x512'],
]) {
  assert(
    manifest.icons.some(
      (icon) =>
        icon.src === src &&
        icon.sizes === sizes &&
        icon.type === 'image/png' &&
        icon.purpose === 'any maskable',
    ),
    `manifest does not include the local ${sizes} PNG icon`,
  );
}

const serviceWorker = await readDistText('sw.js');
for (const snippet of [
  'precacheAndRoute',
  'createHandlerBoundToURL("/index.html")',
  '/^\\/auth\\/callback',
  '/^\\/api',
  '/^\\/ws',
]) {
  assert(serviceWorker.includes(snippet), `service worker missing ${snippet}`);
}

console.log('PWA build verification passed.');
