# Threat model: server-side error tracking (#48)

> Status: **DRAFT for ratification.** Roadmap Phase 6 #48. Server-side `@sentry/node` error tracking for
> `apps/api`, built **SDK-first + DSN-GATED** — completely disabled (a no-op) when `SENTRY_DSN` is unset,
> which is the default until arming. Backend = self-hosted **GlitchTip** (Sentry-API-compatible) stood up as a
> gated Compose service on the VM at arming (**Slice B**); SaaS Sentry EU is a one-line DSN swap (same SDK +
> protocol, zero lock-in). **Build-only:** the SDK + scrubbing + gating land now (**Slice A**); nothing emits
> until a DSN is configured at arming. Frontend error tracking (`@sentry/react`) is **out of scope** (separate
> work). Mirrors the crypto-blind, IDs/metadata-only posture of the #47 metrics (`observability.md`).

## 1. Feature & data flow

```
API request → handler throws / explicitly-reported error
   → @sentry/node captures (exception + request context)
   → beforeSend / beforeBreadcrumb   [DEFAULT-DENY SCRUB]   ← the single critical control
   → event over HTTPS to SENTRY_DSN → GlitchTip (self-hosted on the VM)   |   SENTRY_DSN unset = NO-OP (nothing sent)
```

After scrubbing, an event carries **only**: error type + message + stack (code paths), HTTP method +
route-**TEMPLATE** (e.g. `POST /conversations/:id/messages` — never the populated path, IDs, or query), the
release/commit SHA, the environment, and at most an **opaque tenant/user id** as a metadata tag. It **never**
carries: E2EE message plaintext, MLS / session / device keys, passphrases, auth tokens, full `Authorization`
headers, cookies, request/response bodies, query strings, or presigned B2 URLs. The server stays **crypto-blind**
on this path exactly as on the request path — message bodies are ciphertext it never decrypts, and the error
stream is a metadata-only projection, the same posture as the #47 metrics.

## 2. Assets & trust boundaries

- **Assets:** the error-event **stream** (the thing that would leak content/secrets if unscrubbed); the
  `SENTRY_DSN` (a **write-only ingest key** — can submit events, cannot read them); the GlitchTip store (error
  metadata + stacks only).
- **Boundaries:**
  - **API process → error backend** — with self-hosted GlitchTip this stays inside the VM trust zone (no new
    sub-processor, EU residency). A SaaS DSN would make the backend an external **sub-processor** — a
    deliberate, swappable config choice, not the default.
  - **operator/admin ↔ GlitchTip UI** — admins see error metadata + stacks only, never message content
    (invariant #6); scrubbing guarantees content never reaches the store in the first place.
  - **DSN gate** — `SENTRY_DSN` unset ⇒ the SDK is a no-op ⇒ **no egress at all** (the secure default for
    local dev / CI / pre-arming).

## 3. Threats (STRIDE-lite)

- **Info-disclosure (THE risk).** An exception message, breadcrumb, or request-context field accidentally
  carries plaintext / keys / token / PII and is shipped off the box. → **Default-deny scrubbing**:
  `sendDefaultPii: false`; drop `request.data` (body), `request.query_string`, `request.cookies`, and the
  `Authorization` / `Cookie` headers wholesale (allowlist only innocuous headers); a `beforeSend` /
  `beforeBreadcrumb` that recursively **redacts any key** matching `token|key|secret|passphrase|password|authorization|cookie|dsn`
  and any **value** matching a bearer-token / JWT / presigned-URL shape (a signed URL is redacted **atomically** —
  whole URL, not just the signature param); truncate oversized strings. The **entire event is walked** (not
  hand-picked bags) so a field we didn't enumerate can't ship a secret, and stack-frame locals (`vars`),
  `server_name`, and `modules` are dropped outright. Capture from server code paths only — never serialize
  message ciphertext or crypto material into error context. A unit suite (incl. a whole-event "secret in every
  bag" test) asserts content / keys / tokens / headers / presigned-URLs are stripped.
- **Info-disclosure via the DSN.** A leaked DSN lets an attacker **submit** noise events (it cannot read
  them). Low impact; the DSN is a write-only ingest key — treated as config (optionally a credential file),
  never logged.
- **Tampering / Spoofing of events.** Forged error events → noise / DoS of the error store only; no app
  integrity impact. The GlitchTip ingest is internal-only (VM network) + the edge rate-limit bound it.
- **Elevation.** None new — the SDK runs in-process at the API's existing privilege and opens only an
  outbound HTTPS egress to the DSN host.
- **DoS (event volume).** An error storm floods the backend / egress. → Client-side rate-limit + sampling in
  the SDK; GlitchTip server-side quotas at arming.

## 4. Invariant check (CLAUDE.md ×6)

1. **Crypto-blind server** — ✅ the error path adds no decryption; events carry code paths + metadata, never
   ciphertext or content.
2. **No secret/plaintext logging or persistence** — ✅ **THE central control.** Error tracking is a form of
   logging; default-deny scrubbing + `sendDefaultPii:false` + body/headers/query stripping + the redaction
   `beforeSend` keep plaintext, keys, tokens, full `Authorization` headers, and presigned URLs out of the
   event. Tested. This is the one invariant in tension, and the whole design is built around it.
3. **tenant_id + RLS** — N/A (no schema/table). At most an **opaque** tenant id rides as a metadata tag; it is
   never used to read cross-tenant data.
4. **No hand-rolled crypto** — ✅ none; TLS to the DSN host is the platform's.
5. **Secrets via Key Vault as files** — the `SENTRY_DSN` is a **write-only ingest key**, not a read
   credential; it may ride env per the invariant-#5 carve-out for non-secret-ish config, or be delivered as a
   `SENTRY_DSN_FILE` credential file for consistency. No long-lived cloud cred in env. Default unset ⇒ disabled.
6. **No admin path to content** — ✅ GlitchTip admins see error metadata + stacks only; scrubbing guarantees
   content never reaches the store.

## 5. Decision & mitigations

Ship **Slice A** now: the `@sentry/node` SDK init (gated on `SENTRY_DSN`; a no-op when unset), the default-deny
scrubbing hook, a global capture path (a Nest exception filter / the Sentry Nest integration) that records
**unhandled** errors *after* the existing typed `ErrorResponse` mapping, and a scrubbing unit-test suite. No
infra in Slice A — nothing emits until a DSN is set at arming. **Slice B** (later) stands up the GlitchTip
Compose service (its own Postgres + Redis, behind **Cloudflare Access**, **no published ports**) at arming.

Must-hold:

- **DSN-gated** — `SENTRY_DSN` unset ⇒ a complete no-op (the secure default; verified by test).
- **Default-deny scrubbing** — strip body / query / cookies / `Authorization`; redact
  `token|key|secret|passphrase|password|authorization|cookie|dsn` keys; drop presigned URLs + bearer tokens;
  `sendDefaultPii:false`. Tested.
- **Route-TEMPLATE labels only** — no populated paths / IDs / query (same as #47 metrics).
- **Dependency justification** — `@sentry/node` (the canonical, GlitchTip-compatible SDK): one line in
  `apps/api/package.json`; no other new deps.

Reviewer: **security-boundary-auditor** (`apps/api`, the logging/telemetry boundary — no content/secret
egress, safe logging, gated). Gates: the scrubbing unit tests, **Semgrep** (`.semgrep/` banned-log-pattern
rules), the existing CI suite. Enables nothing — `SENTRY_DSN` stays unset until arming.

## 6. Residual risk

- **A secret under a benign key whose value matches no shape** (e.g. raw base64 ciphertext thrown inside a
  plain object, or a novel free-text message) could still ship. The whole-event walk closes the
  "unenumerated bag" class — every field is scrubbed — but value-shape redaction of free text is best-effort,
  not provable. → Mitigated by the default-deny posture (request data dropped entirely, stack-frame vars
  dropped, redact by key + value-shape, truncate large strings) + the convention that handlers don't `throw`
  raw objects carrying content/keys; a periodic audit of captured events at arming is the follow-up.
- **Self-hosted GlitchTip shares the VM failure domain** (a VM-down event loses the tool that would explain
  it). → Accepted for this phase; aggregate liveness is the edge/uptime check's job, GlitchTip answers "why
  did this throw". Multi-host is the B4 enterprise path.
- **The DSN, as a write-only ingest key, can be abused to submit noise if leaked.** → Low impact (no read);
  the internal-only ingest + edge bound it; rotate via the same Key-Vault path if needed.
