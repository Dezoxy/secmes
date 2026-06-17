// Operator tool: generate the ADMIN_BOOTSTRAP_HASH_FILE JSON from a password read on stdin.
// Uses the exact same @noble/hashes code path as BreakglassService so the encoding always matches.
// Usage (safe — password never appears in argv or shell history):
//   read -rs BGPASS && printf '%s' "$BGPASS" | pnpm --filter @argus/api generate-admin-hash > /tmp/admin_hash.json
//   export ADMIN_BOOTSTRAP_HASH_FILE=/tmp/admin_hash.json
// WARNING: do NOT use  echo -n "password" |  — that exposes the password in process listings and shell history.
// @noble/hashes is a pre-cleared invariant #4 exception; see docs/threat-models/breakglass-admin.md §invariant-4.
import { randomBytes } from 'node:crypto';

import { argon2idAsync } from '@noble/hashes/argon2.js';

const PARAMS = { m: 65536, t: 3, p: 1 };
const HASH_LEN = 32;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const password = Buffer.concat(chunks).toString('utf8').trimEnd();
  if (!password) {
    process.stderr.write('error: password must not be empty\n');
    process.exit(1);
  }
  if (password.length < 12) {
    process.stderr.write(
      `error: password must be at least 12 characters (got ${password.length}) — breakglass hash not generated\n`,
    );
    process.exit(1);
  }

  const salt = randomBytes(16);
  const hash = Buffer.from(
    await argon2idAsync(Buffer.from(password, 'utf8'), salt, { ...PARAMS, dkLen: HASH_LEN }),
  );

  process.stdout.write(
    JSON.stringify({ hash: hash.toString('base64'), salt: salt.toString('base64'), ...PARAMS }) +
      '\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${String(err)}\n`);
  process.exit(1);
});
