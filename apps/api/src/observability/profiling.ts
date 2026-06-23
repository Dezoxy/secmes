// Loaded via --import alongside tracing.ts. Zero-cost no-op when PYROSCOPE_SERVER_ADDRESS is unset.
// Pyroscope pulls profiles from the SDK; the app code does not push — pull mode only.
import { init } from '@pyroscope/nodejs';

if (process.env['PYROSCOPE_SERVER_ADDRESS']) {
  init({
    serverAddress: process.env['PYROSCOPE_SERVER_ADDRESS'],
    appName: 'argus.api',
    tags: { version: process.env['IMAGE_TAG'] ?? 'dev' },
  });
}
