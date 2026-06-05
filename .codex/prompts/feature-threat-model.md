Write a one-page threat-model note BEFORE coding a security-relevant secmes feature. Save it to `docs/threat-models/<feature>.md`.

Sections:
1. Feature & data flow — trace any sensitive data; confirm the server only ever sees ciphertext + metadata.
2. Assets & trust boundaries — keys, content, tenant data; client↔server, tenant↔tenant, user↔admin.
3. Threats (STRIDE-lite) — per boundary, realistic Spoofing/Tampering/Info-disclosure/Elevation risks.
4. Invariant check — verify against the 6 invariants in AGENTS.md; note any tension.
5. Decision & mitigations — what you'll do and which review checklist + scans gate it.
6. Residual risk — what remains and why it's acceptable now.

If the feature conflicts with an invariant (e.g. an admin "read messages" feature vs. E2EE), STOP and surface the conflict for a product decision before coding.
