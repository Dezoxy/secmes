# Review 02 — Server boundary

> **Slice 2** of the security review campaign (`docs/planning/security-review-campaign-plan.md`).
> **Date:** 2026-06-19 · **Reviewed against `main`** (post-#251).
> **Method:** ultracode workflow — 12 `security-boundary-auditor` subagents (Opus, max effort): 1 recon + 6
> adversarial finders (one per claim) + a skeptic refutation pass on every finding.
> **Result:** all six claims **PROVEN**. No P1/P2. 2 distinct P3 findings (one flagged independently by 3
> dimensions); 1 candidate finding **refuted**. This is the highest-stakes slice — a cross-tenant read, IDOR,
> server-side decrypt, secret-in-log, or unguarded `/ws` subscription would surface here.

## Claims in scope (proves invariants 1, 2, 3, 6)

| # | Claim | Verdict |
|---|---|---|
| crypto-blindness | Server stores/forwards ciphertext only; never decrypts/inspects/infers from content; content columns are opaque. | ✅ PROVEN |
| rls-tenant-isolation | Every tenant table has `tenant_id` + an enforced (`FORCE`) RLS policy; tenant context comes only from verified auth, a fixed server constant (`DEFAULT_TENANT_ID`, for passkey/breakglass bootstrap), or a server-derived row (e.g. the `auth_sessions` row matched by refresh-token hash on `@Public` refresh) — never client input — and reverts per tx; no cross-tenant read path. | ✅ PROVEN |
| authz-idor | Every object reached by a client-supplied id is authz'd (ownership/membership) before use; not-found and not-authorized are a uniform response. | ✅ PROVEN |
| safe-logging | No log/error emits content, keys, passphrases, tokens, full `Authorization`, or presigned URLs — IDs/metadata only. | ✅ PROVEN |
| ws-gateway | `/ws` + the realtime bus enforce the same tenant + membership authz as HTTP, despite the global JWT guard skipping the `ws` context. | ✅ PROVEN |
| zod-spec | Every route validates input with Zod/DTO at the boundary; every route is in the OpenAPI spec with its auth posture. | ✅ PROVEN |

## Evidence (highlights — full per-claim evidence in the workflow transcript)

- **crypto-blindness.** Content columns are opaque `text` (`messages.ciphertext`, `conversation_commits.commit`,
  `conversation_welcomes.welcome`/`ratchet_tree`, `attachments.object_key`); no plaintext/title/content-type
  column anywhere. Grep for `decrypt|decipher|.subtle|aes-|chacha|deriveKey` in the request path → **zero**. The
  only crypto verb is an Ed25519 *public-key* signature check (an authz step, not decryption). `body.alg` is
  stored/echoed, never branched on; no content field is length/shape-measured. Read paths return ciphertext
  verbatim under RLS, and a row-shape mismatch throws a **static** string (ciphertext never reaches an error).
- **rls-tenant-isolation.** The `ENABLE`-RLS and `FORCE`-RLS sets are identical (every enabled table is forced);
  all 18 live tenant tables carry a tenant-isolation policy + leading `tenant_id` index. Policy predicates
  fail closed on an unset GUC (throw or `NULL`→0 rows); the three widening policies are each gated by an
  unguessable 256-bit secret or a server-set GUC. `withTenant` sets the tenant tx-locally and drops to the
  non-bypass `argus_app` role; **all ≈80 call sites** pass verified `auth.tenantId`, the `DEFAULT_TENANT_ID`
  constant, or a server-derived `row.tenantId` — no header/body/param reaches it. `argus_backup` is the only
  `BYPASSRLS` role (NOLOGIN, dump-only). Backed by `db/rls.spec.ts` (own-tenant-only, WITH CHECK blocks
  cross-tenant write, unset-context fails closed, pooled-connection no residual leak).
- **authz-idor.** `requireUser` + `requireMembership` gate every conversation path with a uniform 404; friends
  accept/decline/cancel/unfriend are party-scoped `(id, tenant_id)` → uniform `NotFoundException`; attachment
  download derives the conversation from the **row** (not the client ref) then checks membership; devices/push
  scope to the resolved caller; tenants/admin are `AdminGuard`-gated and `(id, tenant_id)`-scoped.
- **safe-logging.** No `console.*` in the request path. The off-box sink (`error-tracking.ts`) is default-deny:
  drops request body/query/cookies/url, allowlists 4 headers, redacts presigned-URL/JWT/Bearer by value-shape
  and sensitive keys whole-subtree. The Zod pipe emits `path: message`, never the rejected value. Push fan-out
  logs the subscription row id only.
- **ws-gateway.** Connect uses the **same** `AuthService.verify` as HTTP (token never logged); unbound tenant →
  close 4403. Subscribe requires auth, UUID-validates `conversationId`, and gates on `isMember` under RLS;
  room key = `verified-tenantId:conversationId`, so fan-out cannot cross tenant or reach a non-member. A `sub`
  maps to exactly one tenant globally (`user_tenant_index.sub` PK), closing the cross-tenant collision concern.
  Exactly one gateway, one native ws adapter, zero direct DB access. Pinned by `realtime.gateway.spec.ts`.
- **zod-spec.** Every `@Body` is wrapped in `ZodValidationPipe`; every UUID param uses `ParseUUIDPipe`; no
  handler reads `req.body/query` raw; no DTO spread (no mass-assignment). 60 routes ↔ 60 `@ApiOperation`; the 2
  spec-absent routes are deliberate `@ApiExcludeEndpoint` (`/healthz`, `/`); 7 unauthenticated operations are
  exactly the `@Public` auth-bootstrap endpoints.

## Findings — 2 distinct, both P3 (none block; none are boundary defects)

| # | Title | File | Note |
|---|---|---|---|
| F1 | Stale `withTenant` docstring blessed a decommissioned Stripe-webhook "sanctioned exception" for a client-derived `tenantId` | `apps/api/src/db/index.ts:68-71` | Billing is decommissioned (no `billing.service.ts`, no `@Public` webhook); the exception can't fire. Doc hygiene — but it contradicts invariant 3 and could mislead a future dev into re-introducing a client-influenced tenant path. **Fixed in this PR** (comment-only). Flagged by 3 dimensions independently. |
| F2 | Seven boundary schemas use plain `z.object` (silently strip unknown keys) instead of `.strict()` | `packages/contracts/src/index.ts:57,67,76,88,130,147` + `apps/api/src/users/users.controller.ts:36` | Not exploitable (every handler reads only named fields; no DTO spread; `user.service` hand-picks updatable columns). Deviates from the repo's own fail-closed `.strict()` convention. **Spun off as a follow-up** — adding `.strict()` is behaviour-touching (a client sending an extra key would now 400), so it needs web-client verification + an E2E check, not a bundle into the evidence PR. |

### Refuted by the skeptic pass (1)
- *Dead `set_config('app.invite_token_hash')`* — false positive from reading a **superseded** migration: `0028`
  `ALTER POLICY tenant_invites_accept_flow … using (token_hash = current_setting('app.invite_token_hash', true))`
  supersedes `0018`'s IS-NULL form (migrations apply in sorted order). The `set_config` line is load-bearing;
  removing it would break invite redemption and weaken the RLS backstop. `rls.spec.ts:137-155` confirms shipped
  behaviour matches `0028`.

## Guards added / not added (this PR)
- No new automated guard. The boundary is already well-guarded: `db/rls.spec.ts` (+ per-table RLS specs), the
  `argus-no-secret-logging` Semgrep rule, the controller specs (Slices A–C) pinning guard posture, and the
  spec/route coverage. A **"every tenant-scoped table has a FORCE-RLS policy" meta-test** (analogous to the
  controller-spec coverage guard) is a high-value future addition — recommended, deferred to avoid scope creep.

## Residual risk / follow-ups (accepted for this phase)
- **F2** `.strict()` hardening → follow-up PR with web-client verification + E2E (the `UpdateProfileSchema`
  silent-strip is currently load-bearing for `argusId` immutability, so the change isn't purely cosmetic).
- **Dead `rawBody: true`** in `apps/api/src/main.ts:23` — a related Stripe leftover, buffered but never read.
  Removing it shrinks the body-handling surface; deferred as a separately-verified bootstrap edit.
- **FORCE-RLS coverage meta-test** — recommended standing guard (see above).
