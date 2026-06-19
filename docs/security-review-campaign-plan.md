# Security review campaign — prove argus is private & safe

> **Status:** DRAFT — awaiting owner approval. Once approved, executed slice-by-slice through the standard
> dual-review PR flow (same cadence as the controller-spec-coverage effort).
> **Goal (owner's words):** "It is a private and safe messenger app and I want to prove it." So this is not a
> normal quality pass — it is an **adversarial, evidence-producing audit**: each slice ends with *what we
> checked, the proof it holds, and the gaps that don't*. Diligence we can show, not vibes.

## What "prove" means here (scope honesty)

An internal adversarial review **cannot** mint a third-party security certificate. What it *can* do, and what
this campaign delivers:

1. **Verify** every privacy/safety claim against the actual code (not the threat-model prose) — adversarially,
   trying to break each invariant.
2. **Produce evidence** for each claim: a passing test, a grep that returns nothing, a scanner result, or a
   reviewer attestation tied to specific files/lines.
3. **Leave guards behind.** Where an invariant holds, prefer a *standing automated check* (like the controller-
   spec coverage guard) over a one-time "looks fine" — so the proof can't silently rot. This is the through-line.
4. **A residual-risk register** — what remains, why it's acceptable at this phase, and what would close it.

The capstone "proof" a paying enterprise expects — an **independent external pentest / cryptography audit** — is
out of scope for the campaign itself and listed as the enterprise-optional final step. Internal first; it makes
the external one cheaper and less embarrassing.

## The six invariants are the spine

Every slice maps back to argus's six non-negotiables (AGENTS.md). The campaign exists to prove each one, by
attacking it:

1. **Server is crypto-blind** — stores/forwards ciphertext only.
2. **Never log/persist** plaintext, keys, passphrases, tokens, full `Authorization` headers, presigned URLs.
3. **Every tenant table has `tenant_id` + enforced RLS** — no cross-tenant reads.
4. **No hand-rolled crypto** — all via `packages/crypto` (MLS).
5. **Secrets from Key Vault via Managed Identity** — credential files, never env.
6. **No admin path to content** — admin/ops see metadata only.

## Method (per slice)

Each slice is one PR and follows the same loop:

1. **Deep pass by the matching reviewer subagent** (Opus, max effort) — `crypto-reviewer` /
   `security-boundary-auditor` / `infra-reviewer` / `security-architect`. The reviewer runs *adversarially*:
   for each claim in scope, it tries to find the input, path, or query that breaks it.
2. **Verification by the main session** — I turn the reviewer's claims into evidence: run the existing tests,
   write targeted greps/tests that would go red if the invariant broke, run the relevant scanner
   (Semgrep `.semgrep/`, 42Crunch, CodeQL, gitleaks) and capture the result.
3. **Findings triaged** into the four tiers (Must-fix / Should-improve / Nice-to-have / Enterprise-optional),
   each with one line of "why it matters" and a file:line.
4. **Evidence note** written to `docs/reviews/NN-<area>.md` using the template below.
5. **Standing guards** added where cheap — a meta-test or Semgrep rule that fails if the invariant regresses.
6. **Must-fixes spin off as their own code PRs** (each through the normal plan-mode → dual-review flow). The
   review slice itself lands as a *docs + guards* PR; it does not bundle behaviour fixes. This keeps each PR
   reviewable and lets fixes be prioritised independently of the audit.

### Evidence-note template (`docs/reviews/NN-<area>.md`)

```
# Review NN — <area>   (<date>, head <sha>)
## Claims in scope        — the invariants/threat-model assertions this slice proves
## Method                 — what the reviewer + verification actually did
## Evidence               — per claim: PROVEN (link to test/grep/scan) | GAP (finding id)
## Findings               — Must / Should / Nice / Enterprise, each with file:line + why
## Guards added           — standing checks left behind
## Residual risk          — what remains and why acceptable now
```

## Slices (ordered by blast radius — confidentiality core first)

> Ordering rationale: a hole in the crypto core or the crypto-blind boundary breaks the whole privacy promise,
> so those go first. Client and infra matter but sit on top of that foundation.

### Slice 1 — Crypto core & key lifecycle  *(reviewer: `crypto-reviewer`)*
The heart of "private." Scope: `packages/crypto` (`seal`, `device-proof`, `device-codec`), the message
**envelope** in `@argus/contracts`, `key-directory` (publish/claim/revoke of key packages), **key backup &
recovery** (Argon2id + unique salt), device/session key handling, and `mls-integration` status.
Proves invariants **1, 4**. Adversarial questions: can any plaintext or key material reach a log or the wire in
clear? is there any `Math.random` in a security path (CSPRNG-only)? does key backup use a unique salt every
time? can a claimed key package be substituted (key-substitution / MITM)? Cross-check against
`docs/threat-models/{key-model,key-directory,device-keystore,prf-keystore-unlock,csprng-audit,mls-integration}.md`.

### Slice 2 — Server boundary: crypto-blindness, RLS, authz, logging  *(reviewer: `security-boundary-auditor`)*
The proof the server *can't* read what it carries. Scope: all 18 controllers + their services + queries +
migrations. Proves invariants **1, 2, 3, 6**. Adversarial questions: does every tenant-scoped table have an
*enforced* RLS policy (not just a `tenant_id` column)? is the tenant session var ever set from unverified client
input? any IDOR (object reached without an ownership/membership check)? any banned log pattern (plaintext,
token, full `Authorization`, presigned URL)? does any endpoint return content where it should return metadata?
Lean on the just-completed controller specs as a baseline; this slice goes one layer deeper into the service +
SQL. Cross-check `docs/threat-models/{rls-tenant-isolation,auth-tenant-context,metadata-exposure,audit-logging}.md`.

### Slice 3 — Auth, identity & device trust  *(reviewers: `security-boundary-auditor` + `crypto-reviewer`)*
Proves you're talking to who you think, and that the server can't impersonate. Scope: `auth/webauthn`
(passkey), `auth/session-token`, `auth/breakglass` (admin + Cloudflare Access gating), `argus-id` identity,
device provisioning / multi-device enrolment, fingerprint verification. Adversarial questions: can a session
token be forged or replayed? is breakglass truly fenced (CfAccess + AdminGuard + audited)? can a malicious
server silently add a device to a user (the classic E2EE backdoor)? does fingerprint/safety-number verification
actually bind the keys a user sees? Cross-check `docs/threat-models/{passkey-auth,session-tokens,breakglass-
admin,argus-id-identity,multi-device-enrollment,fingerprint-verification,device-provisioning}.md`.

### Slice 4 — Metadata exposure & privacy-at-rest  *(reviewers: `security-architect` + `security-boundary-auditor`)*
The "private" claim *beyond* message bodies — what an honest-but-curious server, an admin, the logs, or a DB
dump can infer. Scope: admin panel + `gdpr` controllers, audit logging, centralized/structured logs,
observability (Sentry/Glitchtip), what metadata each table stores (who-talks-to-whom, timing, sizes), and the
GDPR export/erasure paths. Proves invariants **2, 6**. Adversarial questions: what's the *worst* a DB-dump
attacker learns about the social graph? do logs/error-tracking ever carry content or identifiers they shouldn't?
does GDPR export leak another user's data? does admin tooling have any content path? Cross-check
`docs/threat-models/{metadata-exposure,admin-panel,admin-access-gating,audit-logging,centralized-logs,
observability,error-tracking,gdpr,frontend-observability}.md`.

### Slice 5 — Client / PWA security  *(reviewer: `security-architect`, with targeted code-review)*
The endpoint actually holds plaintext and keys — the strongest crypto is moot if the browser leaks. Scope:
`apps/web` key handling in-browser, the PRF/keystore unlock, service worker (`sw.ts`), **code-delivery
integrity** (can a tampered bundle exfiltrate keys?), CSP/headers, XSS surface, and frontend observability (no
content/keys in client telemetry). Adversarial questions: where do decrypted plaintext and private keys live in
memory/storage, and for how long? is there a CSP that would stop injected JS from posting keys out? is the
served bundle integrity-checked? Cross-check `docs/threat-models/{device-keystore,prf-keystore-unlock,code-
delivery-integrity,frontend-observability,web-push}.md`.

### Slice 6 — Infra, secrets, deploy & supply chain  *(reviewer: `infra-reviewer`)*
Proves the runtime doesn't undo the app's guarantees. Scope: `infra/{aws,azure,stack,b2,backup,vm}`,
`compose.yaml`, `.github/workflows/`, Dockerfiles. Proves invariants **2, 5**. Adversarial questions: any secret
in code/env (vs Key Vault credential files via Managed Identity)? containers non-root + read-only FS + dropped
caps + limits? data services truly private (no public endpoint)? CI uses OIDC and never interpolates untrusted
event input into `run:`? backups encrypted, EU-pinned, restorable? Cross-check `docs/threat-models/{vm-secrets,
cross-cloud-secret-fetch,vm-ingress,vm-cd,db-backup,centralized-logs}.md` and `docs/security_toolchain.md`.

### Slice 7 — Synthesis, threat-model reconciliation & attestation  *(reviewer: `security-architect`)*
Pull it together. Scope: reconcile every `docs/threat-models/*` note against what slices 1–6 actually found
(flag any note that overclaims), assemble the **residual-risk register**, and write the top-level
`docs/reviews/00-attestation.md` — the one-page "here is the privacy/safety posture, proven by these artifacts,
with these known limits." This is the document you show someone who asks "prove it's safe."

## Definition of done (campaign)

- Each slice 1–6 has a `docs/reviews/NN-<area>.md` evidence note with every in-scope claim marked PROVEN
  (linked artifact) or GAP (finding id).
- Every Must-fix finding is either fixed (its own merged PR) or has a recorded, owner-accepted justification.
- At least one new **standing guard** per slice where an invariant was cheap to lock (test or Semgrep rule).
- `docs/reviews/00-attestation.md` exists and the residual-risk register is complete.
- The existing CI gate stays green throughout (Semgrep, OSV, Trivy, Checkov, gitleaks, 42Crunch, CodeQL).

## Sequencing notes

- **Independent of the AWS deploy track** but complementary: slices 2/6 directly de-risk the first deploy, so if
  deploy timing pressures, pull those two forward.
- Slices are mostly parallelisable (fresh reviewer context each), but **run 1→2→3 in order** — later slices lean
  on earlier findings (e.g. Slice 3 trusts Slice 1's key-handling conclusions). 4/5/6 can interleave.
- One slice per PR. Same dual-review flow (Codex + `@claude`), only pause for `gh pr merge`.

## Out of scope (campaign)

- Independent external pentest / formal cryptography audit — **enterprise-optional capstone**; do it *after*
  this campaign so the external engagement starts from a clean internal baseline.
- The `MessagingService` god-object / `ChatScreen` god-component refactors — maintainability, tracked separately.
- Net-new features. Findings that imply features become roadmap items, not part of a review slice.

## Decisions to confirm before Slice 1

1. **Depth confirmed: deep/adversarial** (owner stated). ✔
2. **Slice count = 7** as above — OK, or fold any together (e.g. 4+5)?
3. **Fixes spin off as separate PRs** (recommended) vs. bundled into the slice PR.
4. **Start slice** — recommend **Slice 1 (Crypto core)**: it's the foundation everything else rests on, and the
   place where "private" is won or lost.
