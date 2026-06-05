---
name: feature-threat-model
description: Produce a short threat-model note before building a security-relevant feature in argus. Use when adding messaging, key, auth, attachment, admin, or tenant features — anything that touches the security boundary — so design risks surface before code.
---

# feature-threat-model

A lightweight, written threat model done *before* coding. Keep it to one page.

## Produce these sections
1. **Feature & data flow** — what it does; draw the path of any sensitive data (who encrypts, who can read, what the server sees). Confirm the server only ever sees ciphertext + metadata.
2. **Assets & trust boundaries** — what's worth protecting (keys, content, tenant data) and where trust changes (client↔server, tenant↔tenant, user↔admin).
3. **Threats (STRIDE-lite)** — for each boundary, list realistic Spoofing / Tampering / Info-disclosure / Elevation risks. Skip categories that don't apply.
4. **Invariant check** — explicitly verify against `CLAUDE.md`'s six invariants (crypto-blind server, no secret logging, RLS, no hand-rolled crypto, secrets via Key Vault, no admin content access). Note any tension.
5. **Decision & mitigations** — what you'll do, and the boundary checks that apply (which subagent reviews it, what tests/scans gate it).
6. **Residual risk** — what remains and why it's acceptable for this phase.

## Output
Write the note to `docs/threat-models/<feature>.md` and summarize the must-fix mitigations. If the feature conflicts with an invariant (e.g. a requested admin "read messages" feature vs. E2EE), stop and surface the conflict for an explicit product decision before coding.
