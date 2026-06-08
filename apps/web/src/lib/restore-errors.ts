/**
 * Thrown when a recovery restore has been APPLIED — the active device / group-state / message-history stores
 * are already cleared + re-imported — but a step AFTER that destructive boundary failed (a second import
 * write, a key-package publish, etc.). A live caller (the Settings recovery panel) must RELOAD: its
 * in-memory session is now stale on the cleared stores, so it cannot safely continue or claim the session
 * was "preserved". This is distinct from a PRE-clear failure (a bad artifact / wrong passphrase, rejected
 * before any clear), which IS safe to keep the current session on.
 *
 * It lives in its own module so both `recovery.ts` (where the clear happens) and `device-restore.ts` (where
 * the post-restore provisioning happens) can throw it without an import cycle.
 */
export class RestoreCommittedError extends Error {
  constructor(readonly cause: unknown) {
    super('restore applied but a post-restore step failed');
    this.name = 'RestoreCommittedError';
  }
}
