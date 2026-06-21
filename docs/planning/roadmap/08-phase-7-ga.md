# Phase 7 — GA / go-to-market (the last mile to selling)

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 6/8 done (2 in progress — the external paid GA gates G4/G5).

> Not in the 50 — the commercialization layer once the beta is solid.

- [x] G1. **Self-serve tenant onboarding** — org create → admin → invite users
- [x] G2. **Per-tenant SSO** — customers federate their own Entra/Okta/Google (OIDC/SAML)
- [x] G3. **Admin panel** — metadata only (users, devices, revoke, audit); never content 🔒
- [~] G4. **🔒 Independent cryptography review** of the MLS integration *(external, paid — deferred; not blocking GA for now)*
- [~] G5. **🔒 Third-party pen test** + remediation *(external, paid — deferred; not blocking GA for now)*
- [x] G6. **GDPR pack** — DPA, processing records, residency doc, deletion/export (metadata)
- [x] G7. **Security page** — protocol, bundle hashes, sub-processors
- [x] G8. **Billing/plan gating** — Free/Pro/Enterprise tiers; member-limit + SSO gating; Stripe Checkout/Portal/webhooks
