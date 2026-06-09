/* global URL, console */
/* eslint-disable no-console, security/detect-non-literal-fs-filename */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';

const distUrl = new URL('../apps/web/dist/', import.meta.url);

function distPath(relativePath) {
  return new URL(relativePath, distUrl);
}

async function readDistText(relativePath) {
  return readFile(distPath(relativePath), 'utf8');
}

async function findDistAsset(predicate, description) {
  const assets = await readdir(distPath('assets/'));
  const match = assets.find(predicate);
  assert(match, `missing ${description}`);
  return match;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`PWA build verification failed: ${message}`);
  }
}

for (const file of [
  'index.html',
  'manifest.webmanifest',
  'robots.txt',
  'sw.js',
  'favicon-16.png',
  'favicon-32.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'maskable-icon-192.png',
  'maskable-icon-512.png',
]) {
  assert(existsSync(distPath(file)), `missing ${file}`);
}

const indexHtml = await readDistText('index.html');
assert(indexHtml.includes('rel="manifest"'), 'index.html does not link the web manifest');
assert(
  indexHtml.includes('name="description"') &&
    indexHtml.includes('privacy-first, end-to-end-encrypted messaging PWA'),
  'index.html does not include the Lighthouse-visible app description',
);
assert(indexHtml.includes('rel="apple-touch-icon"'), 'index.html does not link the Apple touch icon');
assert(
  indexHtml.includes('apple-mobile-web-app-title'),
  'index.html does not include the iOS Home Screen title',
);
assert(indexHtml.includes('type="module"'), 'index.html does not load the app module');

const appBundleFile = await findDistAsset(
  (file) => /^index-[\w-]+\.js$/.test(file),
  'hashed app bundle',
);
const appBundle = await readDistText(`assets/${appBundleFile}`);
for (const snippet of ['/sw.js', 'workbox-window', 'messageSkipWaiting']) {
  assert(appBundle.includes(snippet), `app bundle missing ${snippet}`);
}

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
        icon.purpose === 'any',
    ),
  'manifest does not include the local SVG icon',
);
for (const [src, sizes, purpose] of [
  ['/icon-192.png', '192x192', 'any'],
  ['/icon-512.png', '512x512', 'any'],
  ['/maskable-icon-192.png', '192x192', 'maskable'],
  ['/maskable-icon-512.png', '512x512', 'maskable'],
]) {
  assert(
    manifest.icons.some(
      (icon) =>
        icon.src === src &&
        icon.sizes === sizes &&
        icon.type === 'image/png' &&
        icon.purpose === purpose,
    ),
    `manifest does not include the local ${sizes} ${purpose} PNG icon`,
  );
}

const serviceWorker = await readDistText('sw.js');
for (const snippet of [
  'SKIP_WAITING',
  'precacheAndRoute',
  'createHandlerBoundToURL("/index.html")',
  '/^\\/auth\\/callback',
  '/^\\/api',
  '/^\\/ws',
]) {
  assert(serviceWorker.includes(snippet), `service worker missing ${snippet}`);
}

console.log('PWA build verification passed.');
