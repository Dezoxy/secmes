import { randomInt } from 'node:crypto';

import { HANDLE_ANIMALS } from './handle-words.js';

// 31 unambiguous lowercase alphanumeric chars (no 0, 1, i, l, o).
// randomInt(31) is rejection-sampling-based internally — uniform, no bias.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** The unique index whose 23505 violation means an argus_id collision. */
export const ARGUS_ID_INDEX = 'users_argus_id_idx';

/** Generate a CSPRNG-backed argus-id: `argus-<16 chars>-<animal>`. */
export function generateArgusId(): string {
  let id = '';
  while (id.length < 16) {
    id += ALPHABET[randomInt(ALPHABET.length)]!; // ! safe: randomInt guarantees in-range index
  }
  const animal = HANDLE_ANIMALS[randomInt(HANDLE_ANIMALS.length)]!;
  return `argus-${id}-${animal.toLowerCase()}`;
}

/** True iff err (or any error in its .cause chain) is a Postgres unique-violation (23505)
 *  against the argus_id global unique index specifically. */
export function isArgusIdCollision(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur !== 'object') break;
    const o = cur as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (o.code === '23505') {
      const c =
        (typeof o.constraint_name === 'string' && o.constraint_name) ||
        (typeof o.constraint === 'string' && o.constraint) ||
        '';
      if (c === ARGUS_ID_INDEX) return true;
    }
    cur = o.cause;
  }
  return false;
}
