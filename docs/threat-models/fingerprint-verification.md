# Threat model: out-of-band fingerprint / safety-number verification (checkpoint 20)

> One page. Written before code. Closes the MITM gate named in `key-directory.md` §5 and the
> `deviceIdentity()` docstring: MLS `addMember` does **not** verify peer identity, so a malicious
> server/network could swap a key. This is the human-in-the-loop defense.

## 1. Feature & data flow

Two users compare a short **safety number** derived from their devices' **identity (Ed25519 signature)
public keys**, over an out-of-band channel (read aloud, video call, QR — anything not the argus server).
If it matches, they mark the conversation **verified**; a mismatch means a key was swapped (MITM).

- The number is computed **locally from public keys only**. Nothing is sent to the server, and no
  private material is involved.
- The signature public key is the device's **stable identity** (survives recovery: `exportIdentity`/
  `deviceFromIdentity` preserve it), so the safety number is stable across re-mints of one-time
  KeyPackages — only a genuinely different identity key changes it.
- v1 scope: **2-party** (the current `lib/mls.ts` you+peer session). The live remote flow reuses the
  same derivation once the message loop delivers the peer's published key.

## 2. Assets & trust boundaries

- **Asset:** the *authenticity* of the peer's identity key — the root of all E2EE here. If a MITM
  substituted it during member-add, they can read/inject everything; nothing else in the stack catches
  that.
- **Boundaries:** client↔client (the out-of-band comparison is the **only** trusted input) and
  client↔key-directory (the server delivers public keys but is **untrusted for authenticity** — exactly
  why verification is out-of-band, not "the server says they match").

## 3. Threats (STRIDE-lite)

- **Spoofing (the core threat):** a malicious server or network MITM hands you a KeyPackage carrying the
  *attacker's* key under the peer's name. → The safety number is derived from the key you **actually
  hold** for the peer; it won't match the peer's real number when compared out-of-band → MITM detected.
- **Tampering / non-determinism:** if the two sides computed different numbers for the same key pair,
  every comparison would "fail" and users would learn to ignore it. → Derivation is **deterministic** and
  **symmetric**: sort the two per-device fingerprints before combining, so both sides get the same string.
- **Information disclosure:** the number derives from **public** keys only — no secret is exposed, and it
  is never logged. (Invariant #2 holds trivially.)
- **Elevation / stale trust:** a "verified" flag must track the *actual* keys. If the peer's identity key
  changes (new device / re-key), a stale "verified" badge would mask a possible new MITM. → Verification
  is **keyed to the safety number**; if the number changes, the badge resets to unverified.

## 4. Invariant check

- **#1 crypto-blind server:** upheld — the number is computed client-side from public keys; nothing new
  is sent to or derived on the server.
- **#2 no secret logging:** upheld — only public keys involved; the number is not a secret but isn't
  logged either.
- **#4 no hand-rolled crypto:** the derivation lives in **`@argus/crypto`** and uses **SHA-256**
  (WebCrypto / the audited suite) — a standard hash over public keys, no invented primitive. CSPRNG is
  N/A (no randomness in a fingerprint).
- **#3/#5/#6:** untouched. No tension.

## 5. Decision & mitigations

- `safetyNumber(local, remote)` = `render(SHA-256(sort([fp(local), fp(remote)])))`, where
  `fp(keys) = SHA-256("argus-fp:v1" || u16(len(identity)) || identity || signaturePublicKey)` — the
  16-bit length prefix removes identity/key boundary ambiguity (enforced: identities > 65535 bytes are
  rejected). Rendered as **8 groups of 5
  decimal digits** (read-aloud friendly). Sorting makes it symmetric; the version tag domain-separates it.
- UI: a **"Verify security"** panel (from the chat header) shows the number + a **Mark as verified**
  toggle and an explainer to compare out-of-band; the chat header shows a verified badge. The flag is
  derived per safety-number, so a key change clears it.
- **Reviewer:** `crypto-reviewer`. **Tests:** deterministic (same inputs → same number), **symmetric**
  (`safetyNumber(a,b) === safetyNumber(b,a)`), and **key-sensitive** (a different identity key → a
  different number).

## 6. Residual risk

- **Users must actually compare** out-of-band — the UI nudges but can't force it (inherent to the model;
  same as Signal/WhatsApp). Accepted.
- **Device compromise** (not network MITM) — stealing a device's keys — is a different threat this does
  not address (it verifies *which* key, not whether the holder is honest).
- **Group (N-party) safety numbers** are deferred with group chat (B1); v1 is 2-party.
- The demo computes the number for the **local loopback** peer; verifying a **remote** peer rides the
  live message loop (key directory + Welcome delivery), which is not built yet.
