import { readFileSync } from 'node:fs';
import pino from 'pino';
import { pinoConfig } from '../observability/logger.js';

const logger = pino({ ...pinoConfig, name: 'PushConfig' });

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  /** false when any VAPID value is missing — PushService becomes a no-op. */
  configured: boolean;
}

export function loadVapidConfig(): VapidConfig {
  const publicKey = process.env.VAPID_PUBLIC_KEY ?? '';
  const privateKey = resolvePrivateKey();
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:admin@argus.local';
  const configured = Boolean(publicKey && privateKey && subject);
  return { publicKey, privateKey, subject, configured };
}

function resolvePrivateKey(): string {
  const file = process.env.VAPID_PRIVATE_KEY_FILE;
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    // Log only that the file is unreadable — never the path or its contents (invariant #2).
    logger.warn('push: VAPID credential file unreadable; push disabled');
    return '';
  }
}
