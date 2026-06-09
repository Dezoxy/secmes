# Threat model: code-delivery integrity (SRI + service-worker pinning + published bundle hash)

> Status: **DRAFT for ratification.** Covers the remaining roadmap **#43** frontend-build track: Subresource
> Integrity on the built bundles, service-worker pinning, and a published bundle hash. The CSP / security-header
> slice of #43 already shipped (Caddy, PR #150). **No API, database, or crypto-path change** — this is purely
> integrity of the static client as it is delivered to the browser.

## 1. Feature & data flow

The web app is a Vite-built PWA served as static files by Caddy (`/srv`) behind the Cloudflare edge. The browser
loads `index.html`, which boots the JS/CSS bundles (including the `@argus/crypto` glue), then talks to the
API/WebSocket for ciphertext + metadata, to Zitadel for auth, and to B2 presigned URLs for attachments.

The executable client is the most security-sensitive static artifact: it runs in the same origin that holds
decrypted message content and key material in memory. If an attacker can substitute a tampered bundle, every
client-side control (E2EE, the crypto-blind posture) is moot — the swapped code can read plaintext and keys
directly. This feature hardens **delivery** of that code:

- **SRI** — at build time, `vite-plugin-sri3` injects `integrity="sha384-…"` onto every `<script>`,
  `<link rel="modulepreload">`, and `<link rel="stylesheet">` in `index.html`. The browser refuses to execute
  any bundle whose bytes do not match the baked-in hash.
- **Service-worker pinning** — the SW is the highest-privilege script (it intercepts all fetches and persists
  across navigations) and **cannot carry an SRI hash** (no `integrity` on `navigator.serviceWorker.register`).
  Pinning means: keep updates user-gated (`registerType: 'prompt'`), force the SW + its imports + the manifest
  to **always revalidate from origin** (Caddy `Cache-Control: no-cache`), and immutable-cache only the
  content-hashed `/assets/*`. The browser can never get stuck on a stale/cached SW.
- **Published bundle hash** — the build emits `bundle-manifest.json` (sha384 per JS/CSS asset + one
  deterministic `bundleDigest`, the per-build fingerprint). It contains only hashes of **public** static files,
  lets an auditor verify "what bytes is my browser running", and feeds the future security page (roadmap G7).

No sensitive data flows here: the manifest hashes public assets; the server still only forwards static files
and ciphertext.

## 2. Assets & trust boundaries

- **Assets:** the executable client bundles (JS/CSS, incl. crypto glue); `index.html` (the SRI bootstrap); the
  service worker (controls all fetches); the published integrity manifest (non-secret).
- **Boundaries:** build pipeline → image artifact → Caddy origin → Cloudflare edge/cache → browser → SW cache.
  Trust changes at each cache/edge hop where a tampered or stale artifact could be substituted, and at the
  browser↔service-worker line (the SW outlives any single page load).

## 3. Threats (STRIDE-lite)

- **Tampering — swapped/altered JS or CSS bundle** (compromised edge cache, MITM beneath TLS, malicious origin
  write). → sha384 SRI on the entry `<script>` + every `modulepreload`/stylesheet `<link>` in `index.html`; the
  browser rejects mismatched bytes. Workbox precache revisions are a second check for cached assets (verified:
  content-hashed `/assets/*` precache with `revision:null`, so Workbox refuses bytes that don't match the
  filename hash). Strict CSP `script-src 'self'` blocks foreign/inline script regardless. **Caveat:** SRI
  attributes cover the entry + statically-referenced chunks + CSS, **not** dynamically-`import()`ed chunks (lazy
  routes + ts-mls's internal crypto chunks) — a browser-platform gap — see §6.
- **Tampering — swapped `index.html`** (the SRI bootstrap itself). `index.html` carries the integrity attrs, so
  a swapped `index.html` could strip them — SRI cannot self-protect the document that declares it. → Mitigated
  by edge TLS (HTTPS), CSP `base-uri 'none'` / `frame-ancestors 'none'`, and the SW: an installed client
  **precaches the known-good SRI'd `index.html`** (verified: precache revision == md5 of the SRI'd file) and
  keeps serving it until a user-approved update, so a later origin tamper does not silently reach returning
  users. The published bundle hash is the detective backstop. Residual (first-load TOFU) — see §6.
- **Tampering — malicious or stale service worker.** No native SRI for SWs. → CSP `worker-src 'self'` (must be
  same-origin), `registerType: 'prompt'` (no silent auto-activation/swap), update checks fetched with
  `cache: 'no-store'`, and Caddy `no-cache` on `sw.js` + `workbox-*.js` + `manifest.webmanifest` so a stale copy
  can never pin the client. Residual: a same-origin origin compromise serving a malicious `sw.js` is not
  defeated by SRI (browser limitation) — see §6.
- **Information disclosure — `bundle-manifest.json` leaks something.** → It is sha384 of files that are already
  public (the served JS/CSS) plus a derived digest — no app version, no keys, tokens, plaintext, or paths beyond
  public asset names. It is outside the PWA precache glob and Caddy serves it `no-cache`, so it stays
  network-fresh; gitleaks + Semgrep gate the diff.
- **Spoofing / Elevation:** unchanged — auth and authorization are untouched by this feature.

## 4. Invariant check

1. **Crypto-blind server** — unaffected. The server still forwards static files + ciphertext; SRI/SW/manifest
   are client-delivery integrity only.
2. **No secret logging/persistence** — the manifest is sha384 of **public** assets + version; no secrets, keys,
   tokens, plaintext, or presigned URLs. ✓
3. **RLS** — N/A (no DB/table).
4. **No hand-rolled crypto** — SRI uses the browser's **native** Subresource Integrity (SHA-384). The manifest
   uses Node's `crypto` SHA-384 to **checksum public artifacts** for an integrity digest — a checksum over
   public bytes, not a cryptographic protocol and no key material. This is not message/key crypto and does not
   belong in `packages/crypto`. Noted for the crypto reviewer; no tension with the invariant.
5. **Secrets via Key Vault** — N/A. The build args (`VITE_OIDC_*`) are non-secret (issuer/client-id are public).
6. **No admin content path** — N/A.

## 5. Decision & mitigations

Ship all three:

- **SRI:** add `vite-plugin-sri3` (v2.0.0; MIT; **zero runtime deps**; Vite `^3..^8` peer — verified against our
  Vite 8.0.16). It chains onto Vite's `build-import-analysis` `generateBundle`, so integrity lands in
  `index.html` **before** `vite-plugin-pwa`'s `closeBundle` precaches it — verified the precache revision equals
  the md5 of the SRI'd file, so the SW caches the integrity-protected HTML (no stale-content trap). Note: the dep
  has a build-time `fetch()` branch for remote `<script src="https://…">` / `modulepreload` tags; our index.html
  is same-origin only and the "no external requests" rule + CSP `script-src 'self'` keep that branch unreachable
  — a future drive-by adding an external tag must not silently introduce a build-time fetch.
- **SW pinning:** Caddy serves `sw.js` / `workbox-*.js` / `manifest.webmanifest` / `bundle-manifest.json` with
  `Cache-Control: no-cache` (always revalidate) and `/assets/*` (content-hashed, immutable) with
  `max-age=31536000, immutable`. Updates stay `prompt`-gated (existing). The pin relies on `no-cache` **and**
  `vite-plugin-pwa`'s default `updateViaCache` together: `no-cache` forces the browser to revalidate the SW
  script on every update check so a stale copy can't pin the client; the immutable `workbox-<hash>.js` is safe
  because each deploy ships a fresh `sw.js` that `importScripts` a new hashed filename.
- **Published bundle hash:** a small build-time Vite plugin emits `bundle-manifest.json` (per-asset sha384 that
  matches the SRI values + one deterministic `bundleDigest`) to `dist/`, served by Caddy. It hashes assets read
  back from disk in `writeBundle`, so it is order-independent of sri3 / the PWA plugin.

**Gated by:** `infra-reviewer` (Vite build config, Caddy headers, CI), the existing `script-src 'self'` CSP,
Semgrep + gitleaks (no secrets in the manifest), and the build itself (integrity attrs present; precache
revision consistent; manifest sha384 == SRI integrity).

## 6. Residual risk

- **No native SRI for service workers, and `index.html` is a first-load TOFU bootstrap.** A same-origin
  origin/edge compromise serving a malicious `sw.js` or a freshly-stripped `index.html` to a *first-time* visitor
  is not prevented by SRI (a browser-platform gap, not a config miss). Mitigated by edge TLS, CSP, prompt-mode SW
  updates, the SW pinning a known-good `index.html` for returning/installed users, and the published bundle hash
  as a detective control. Accepted for this phase; a signed-SW / signed-index transparency scheme and the G7
  security page surfacing the bundle hash are the next step.
- **SRI covers the entry script + CSS, not dynamically-`import()`ed chunks.** The `integrity` attribute lives on
  the `<script>`/`<link>` tags in `index.html`, so it robustly protects the entry bundle and stylesheet. The lazy
  route chunks (`React.lazy` → Settings / Security / **Recovery** / Devices) and ts-mls's internal crypto chunks
  load via native dynamic `import()`, which **cannot carry an integrity attribute** — a browser-platform gap, not
  a config miss. (The spec's fix is import-map `integrity`, shipped only in recent Chrome/Safari — not Firefox —
  and an inline import map collides with our `script-src 'self'` CSP.) So a same-origin/edge **cache-poisoning
  swap of a route or crypto chunk** would execute unverified. Partially mitigated: `script-src 'self'` blocks
  foreign script; immutable content-hashed filenames + the SW precache narrow the window for installed users; and
  the published `bundle-manifest.json` is the detective control (an auditor / the G7 page can diff served chunk
  hashes against it). **Decision (2026-06-09, with the maintainer): accept this residual** rather than (a)
  `inlineDynamicImports` into one SRI-covered entry — which reverts the deliberate route/crypto code-splitting
  and bloats the unauthenticated load — or (b) import-map integrity (partial browser support + a build↔Caddy-CSP
  coupling). Revisit when import-map integrity is broadly supported, or fold it into the G7 signed-transparency
  work. (Codex #152 P1.)
- **The bundle manifest is detective, not preventive** — it lets an auditor or the future security page detect a
  divergent build but does not itself block a tampered load. Acceptable: it pairs with SRI (the preventive
  control) on the assets that *can* carry integrity.
