# Threat model: <feature>

> One page. Written before code. Ratified by the human before Phase work starts.

## 1. Feature & data flow

What it does; trace any sensitive data (who encrypts, who can read, what the server sees). Confirm the server only ever sees ciphertext + metadata.

## 2. Assets & trust boundaries

Assets worth protecting (keys, content, tenant data). Where trust changes (client↔server, tenant↔tenant, user↔admin).

## 3. Threats (STRIDE-lite)

Per boundary, the realistic risks. Skip categories that don't apply.

- **Spoofing:**
- **Tampering:**
- **Information disclosure:**
- **Elevation of privilege:**

## 4. Invariant check

Verify against the six invariants in `AGENTS.md` (crypto-blind server; no secret logging; RLS; no hand-rolled crypto; secrets via Key Vault; no admin content access). Note any tension.

## 5. Decision & mitigations

What you'll do, and which review checklist + scans gate it.

## 6. Residual risk

What remains and why it's acceptable for this phase.
