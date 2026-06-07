// Single-writer guard for MLS ratchet ops (send/receive both advance + persist group state). Two tabs of
// the same origin each hold their OWN in-memory Conversation with an independent op queue, so the keystore's
// cross-instance version/CAS is the DURABLE backstop against rollback — but we also want to stop two tabs
// from racing the same conversation's ratchet in the first place. The Web Locks API serializes an
// exclusively-named lock ACROSS tabs of an origin; where it's unavailable (older browsers, jsdom in tests)
// we degrade to an in-process promise-chain mutex — still correct within one tab, and the CAS still prevents
// any cross-tab durable rollback. A GroupStateConflict from the keystore is the signal a follower lost anyway.

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive' | 'shared' },
    callback: () => Promise<T>,
  ): Promise<T>;
}

function webLocks(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as unknown as { locks?: LockManagerLike }).locks;
}

// Per-name tail promise for the in-process fallback — the same shape as Conversation's op mutex.
const fallbackChains = new Map<string, Promise<unknown>>();

/** The lock name for a conversation's ratchet ops. */
export function conversationLock(conversationId: string): string {
  return `argus-mls:${conversationId}`;
}

/**
 * Run `fn` while holding an EXCLUSIVE lock `name` — serialized across tabs via the Web Locks API, or via an
 * in-process mutex where Web Locks is absent. `fn`'s result (and rejection) propagate to the caller; the
 * fallback chain swallows them so a throwing op never poisons the next waiter.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = webLocks();
  if (locks) return locks.request(name, { mode: 'exclusive' }, fn);

  const prev = fallbackChains.get(name) ?? Promise.resolve();
  const run = prev.then(fn, fn); // proceed whether the previous holder resolved or rejected
  fallbackChains.set(
    name,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
