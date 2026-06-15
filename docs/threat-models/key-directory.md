# Threat model: key directory & server key-substitution (MITM)

> Status: **DRAFT for ratification.** Blocks Phase 2 (device keys) / Phase 3 (1:1 text). This is the **#1 crypto gap** both external reviews flagged: nothing currently stops a compromised server from handing out a key it controls. Written against the verified `ts-mls` model (KeyPackages + Welcome).

## 1. Feature & data flow

```
client → publishes its public MLS KeyPackage(s) to the server's key directory
to message Bob:  Alice → fetches Bob's KeyPackage from the server
                 Alice → addBob proposal + commit → produces a Welcome → Bob joins the group
```

The server **stores and serves public KeyPackages**. It never sees private keys or plaintext. But it is the **introducer** — it decides which KeyPackage Alice receives when she asks for "Bob".

## 2. Assets & trust boundaries

- **Asset:** the authenticity of the binding **identity ↔ public key**. If that breaks, confidentiality breaks.
- **Boundary:** client ↔ server. The server is *crypto-blind* (can't read messages) but is **trusted to introduce the right key** — and that trust is exactly what we must not require.

## 3. Threats (STRIDE-lite)

1. **Server key-substitution / active MITM (Spoofing + Info-disclosure — the critical one).**
   A compromised (or coerced) server returns **its own** KeyPackage instead of Bob's. Alice adds the *server* to the group via Welcome; the server now decrypts everything, optionally re-encrypting to the real Bob (full MITM). The MLS LeafNode credential is `basic` (just an identity string the server also vouches for), so MLS alone doesn't catch this — **the server attests identity↔key, which is the thing we're trying not to trust.**
   → Answer "can a compromised server read my future messages?" must be **no**, and today it's *yes*.

2. **Stale/forced KeyPackage exhaustion.** Server hands out a single attacker-known last-resort KeyPackage repeatedly. → KeyPackage lifecycle (see attachments/device notes): pool + replenish, never reuse the last-resort KP silently.

3. **Intra-tenant pool drain (DoS, authenticated).** A valid tenant member can claim — and thus consume — another member's one-time-use KeyPackages with no per-resource authorization, iterating user-ids to exhaust pools. → Mitigated for beta by: a **per-device publish cap** (bounds growth), **auditing every claim** (`keydir.key_package_claimed`, actorSub — drains are detectable), and **`POST`, not `GET`** (a consume-once resource must not be cacheable/prefetchable). Full per-(caller, target) **rate-limiting is checkpoint 46**; a **last-resort KeyPackage** + client replenishment close the empty-pool gap later.

## Server-side implementation (checkpoint 19)

`devices` + `key_packages` tables (tenant-scoped, FORCE RLS). The server **binds** every KeyPackage to the authenticated uploader (`publish` resolves the device from the verified `sub`; a user can only publish for their own device) and serves them **one-time-use** (atomic `UPDATE … FOR UPDATE SKIP LOCKED`; empty pool → 404, never silent reuse). It stores only **public** base64 key material (opaque; crypto-blind upheld). This is the binding + lifecycle half only — **identity↔key authenticity still rests on client-side fingerprint verification** (§5 v1), which is the actual MITM defense and is NOT yet implemented.

## 4. Invariant check

Directly tests invariant #1 (crypto-blind server). Substitution **violates** it. The fix must make substitution **detectable by the client/users**, not merely *policy*.

## 5. Decision & mitigations (layered)

- **v1 (Phase 5, pragmatic — ship this):** **safety-number / fingerprint verification.** Derive a stable fingerprint from each device's MLS **signature public key**; show it as a number + QR. On first contact (TOFU), pin it; **warn loudly if a contact's key changes** (the substitution signal). UI already anticipated in the Stitch prompts ("device fingerprint", "key verification").
- **v1 defensive default:** treat an unexpected key change as **block-and-warn**, not silent-accept.
- **Later (enterprise / when a buyer demands provable non-substitution):** a **key-transparency log** — append-only, server-signed, auditable — so substitution is *globally detectable* without per-pair manual verification. (Tracked in plan §18 / Enterprise-optional.)

Actions: add a **row to plan §14** ("server key-substitution → fingerprint verification + (later) transparency log"); add a **Phase-5 key-verification UX checkpoint**; **gate crypto-review checkpoint 20** on this note being implemented, not just written.

## 6. Residual risk

TOFU has a first-contact window (no out-of-band channel yet on first add). Metadata (who fetches whose KeyPackage, when) is visible to the operator. Both disclosed in §14/§15 + the DPA; the transparency log closes the TOFU gap later. Accept for beta **only with the change-warning shipped.**
