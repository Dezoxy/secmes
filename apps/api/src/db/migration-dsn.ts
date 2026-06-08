import { readFileSync } from 'node:fs';

/**
 * Resolve the migration (OWNER) connection URL WITHOUT requiring the password in env (invariant #5).
 *
 * Precedence (file-first, so the owner DSN can be a mounted credential file, never env):
 *   MIGRATION_DATABASE_URL_FILE  →  MIGRATION_DATABASE_URL  →  DATABASE_URL_FILE  →  DATABASE_URL
 *
 * The deploy (migrate-on-deploy) mounts the owner DSN as a tmpfs file and sets MIGRATION_DATABASE_URL_FILE,
 * so the owner credential is never in the container environment. Mirrors blob-config's S3_SECRET_ACCESS_KEY_FILE
 * and db/index.ts's resolveDatabaseUrl. Returns undefined if nothing is set.
 */
export function resolveMigrationDsn(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const readFile = (path: string | undefined): string | undefined => {
    if (!path) return undefined;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-set deploy path, not user input
    return readFileSync(path, 'utf8').trim();
  };
  return (
    readFile(env.MIGRATION_DATABASE_URL_FILE) ??
    env.MIGRATION_DATABASE_URL ??
    readFile(env.DATABASE_URL_FILE) ??
    env.DATABASE_URL
  );
}
