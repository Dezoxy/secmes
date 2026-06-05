# MLS library selection

> Status: **DRAFT recommendation for ratification.** Blocks Phase 2 (no `packages/crypto` exists yet). Researched June 2026. The plan (§3.3) assumed "MLS via a wasm library" — this note revisits that, because the **license** and the **iOS-Safari-wasm risk** both point a different way.

## The candidates

| Library | Lang / form | License | RFC 9420 | 3rd-party audit | Browser key storage | Notes |
|---|---|---|---|---|---|---|
| **Wire CoreCrypto** (`@wireapp/core-crypto`) | OpenMLS (Rust) → **WASM** + TS bindings | **GPL-3.0** ⛔ | yes | none stated | **built-in** IndexedDB AES-256-GCM keystore | Production-proven in Wire's browser app; iOS/Android FFI too. **Killed by the license.** |
| **ts-mls** (`ts-mls`) | **Pure TypeScript** | **MIT** ✅ | "full impl", interop/test-vector support | **none** (explicit disclaimer) | DIY (we build IndexedDB) | v1.6.2 (Mar 2026), 34 releases, 20+ ciphersuites incl. post-quantum (ML-KEM, X-Wing). **Single maintainer.** |
| **mls-rs** (`awslabs/mls-rs`) | Rust → WASM (DIY bindings) | **Apache-2.0** ✅ | 100% conformance | **none yet** | DIY (in-mem/SQLite traits) | AWS-backed (Wickr lineage); browser binding + TS wrapper are our work. |

## The two decisive filters

1. **License (hard gate).** secmes ships **proprietary / all-rights-reserved**. **CoreCrypto is GPL-3.0** — linking our client against it would trigger copyleft (and the JS/WASM linking question is legally murky enough that we don't want to bet the company on it). Ruled out unless you (a) open-source the client, or (b) buy a Wire commercial license. → **CoreCrypto is out.** That leaves the two permissive options (MIT, Apache-2.0).
2. **The iOS/PWA constraint we already committed to.** The plan flagged "wasm/iOS-PWA binding maturity" as a risk (§3.2). **ts-mls is pure TypeScript — no WASM at all**, so that entire risk class disappears (iOS Safari runs JS natively; WASM has historically been the fragile part on iOS PWAs). For a *PWA-on-every-platform* product, a pure-TS MLS is a better structural fit than any wasm option.

## Recommendation

**Primary: `ts-mls` (MIT, pure TypeScript).** Best fit for a solo-dev web PWA: zero Rust/WASM toolchain, integrates as a normal pnpm dep, the code is auditable *in the language we already use*, no iOS-wasm risk, post-quantum-ready, and MIT means we can **vendor/fork it** if the single maintainer stalls.

**Fallback: `mls-rs` (Apache-2.0).** If the spike shows ts-mls is too immature for our ciphersuite or has interop gaps, switch to mls-rs and accept the WASM-bindings + keystore work. Because both speak RFC 9420, the *protocol* is portable; only the wrapper changes.

**Both are unaudited** — which is *not* a tie-breaker, it's a reason the roadmap's **G4 independent crypto review is mandatory regardless of library**, and it should explicitly audit *our `packages/crypto` integration* of whichever we pick.

This **updates plan §3.3**: prefer **pure-TS MLS (ts-mls)** over "MLS via wasm"; keep mls-rs(wasm) as the documented fallback.

## The spike (do this week, before more infra — checkpoint S1)

Time-box 2–3 days on a laptop, no cluster:

1. `ts-mls`: two in-memory clients → create group → encrypt → decrypt → add a member (Welcome) → verify. Capture the KeyPackage / Welcome / commit shapes (feeds the `messages.ciphertext` and key-directory specs).
2. **Run the official MLS interop test vectors** against ts-mls for the ciphersuite we'll use (start: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`).
3. **Bundle size**: measure the gzipped client cost of importing ts-mls (it should beat any wasm option).
4. **iOS Safari PWA**: run the 2-party flow in an installed PWA on a real iPhone — the single most important de-risking step.
5. **Minimal IndexedDB keystore**: store/load a client's private MLS state; confirm it survives reload (and design for the iOS eviction case → ties to `key-backup.md`).

## Spike result — Node portion VERIFIED (2026-06-05)

Step 1 passed against **`ts-mls` 1.6.2**: full 2-party flow in Node — `keyPackage → createGroup → createCommit add(bob) → joinGroup (via Welcome) → createApplicationMessage → processMessage (decrypt)`. Ciphertext ≈331 B, ≈35 ms round trip. The spike code is a deliberate throwaway (not committed); the **exact runnable script is inlined below** so the result is reproducible and auditable from this repo alone.

**Reproduce (standalone, outside the pnpm workspace):**

```sh
mkdir mls-poc && cd mls-poc && pnpm init
pnpm install --ignore-workspace ts-mls@1.6.2 @noble/hashes @noble/curves @noble/ciphers
# save the script below as flow.mjs, then:
node flow.mjs        # expect: "PASS ✅"
```

`flow.mjs` (verbatim, as verified):

```js
// 2-party MLS flow (ts-mls 1.6.2 — positional API, verified against the installed exports).
import {
  getCiphersuiteImpl,
  getCiphersuiteFromName,
  generateKeyPackage,
  createGroup,
  createCommit,
  joinGroup,
  createApplicationMessage,
  processMessage,
  defaultCapabilities,
  defaultLifetime,
  emptyPskIndex,
  acceptAll,
  encodeMlsMessage,
} from 'ts-mls';

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const call = (x, ...a) => (typeof x === 'function' ? x(...a) : x); // some defaults are fns, some values

const impl = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));

const mkKp = (name) =>
  generateKeyPackage(
    { credentialType: 'basic', identity: enc(name) },
    call(defaultCapabilities),
    call(defaultLifetime),
    [],
    impl,
  );
const alice = await mkKp('alice');
const bob = await mkKp('bob');

let aliceGroup = await createGroup(
  enc('spike-group-1'),
  alice.publicPackage,
  alice.privatePackage,
  [],
  impl,
);

const addBob = { proposalType: 'add', add: { keyPackage: bob.publicPackage } };
const commit = await createCommit({ state: aliceGroup, cipherSuite: impl }, { extraProposals: [addBob] });
aliceGroup = commit.newState;

let bobGroup = await joinGroup(
  commit.welcome,
  bob.publicPackage,
  bob.privatePackage,
  call(emptyPskIndex),
  impl,
  aliceGroup.ratchetTree,
);

const plaintext = 'hello bob — this is E2EE over MLS';
const made = await createApplicationMessage(aliceGroup, enc(plaintext), impl);
const wire = encodeMlsMessage({
  wireformat: 'mls_private_message',
  version: 'mls10',
  privateMessage: made.privateMessage,
});

const wireMsg = { wireformat: 'mls_private_message', version: 'mls10', privateMessage: made.privateMessage };
const res = await processMessage(wireMsg, bobGroup, call(emptyPskIndex), acceptAll, impl);
const got = dec(res.message);

const ok = got === plaintext;
console.log(ok ? `PASS ✅  ${wire.length} B ciphertext` : `FAIL: got "${got}"`);
process.exit(ok ? 0 : 1);
```

**API notes (published 1.6.2 differs from the `main` README):** it uses **positional args** + **string discriminants** (`credentialType:'basic'`, `proposalType:'add'`) — not the options-objects the README shows. Needs the `@noble/{hashes,curves,ciphers}` peers. `keyPackage` returns `{publicPackage, privatePackage}`; `processMessage` returns `{kind, message, newState, consumed}`. These shapes feed the `messages.ciphertext` envelope and the key-directory spec.

**Still pending (the actual de-risk):** steps 2–5 — RFC 9420 interop vectors, gzipped bundle size, **iOS-Safari installed-PWA proof**, and the IndexedDB keystore. S1 stays `[~]` until the iOS-PWA proof passes. Ratification of `ts-mls` as primary is provisional until then.

## Open questions for you to ratify

- Ciphersuite: classical (X25519/AES-GCM) for v1, or adopt the **post-quantum** X-Wing hybrid now (ts-mls supports it; bigger keys, but future-proof and a sales point)?
- Single-device v1 (agreed) → confirm we only need single-leaf groups for 1:1 initially.
- Accept ts-mls single-maintainer risk with the MIT vendor-fork escape hatch, or prefer mls-rs's institutional backing despite more integration work?

## Sources

- [@wireapp/core-crypto (npm)](https://www.npmjs.com/package/@wireapp/core-crypto) · [wireapp/core-crypto (GitHub, GPL-3.0)](https://github.com/wireapp/core-crypto)
- [LukaJCB/ts-mls (GitHub, MIT)](https://github.com/LukaJCB/ts-mls)
- [awslabs/mls-rs (GitHub, Apache-2.0)](https://github.com/awslabs/mls-rs)
- [MLS implementations registry](https://github.com/mlswg/mls-implementations/blob/main/implementation_list.md)
