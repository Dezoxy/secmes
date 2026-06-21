# Front-load — start now, parallel to Phase 0

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 0/2 done (1 in progress).

Front-load the unknowns: the hardest thing (MLS) and the longest-lead-time thing (paid audits) start _now_, not in sequence.

- [~] S1. **MLS spike** (laptop, no cluster) — `ts-mls` two-party encrypt/decrypt + add-member, run RFC 9420 interop vectors, measure gzipped bundle size, **prove it on a real iOS-Safari installed PWA**, sketch an IndexedDB keystore. Ratifies `docs/architecture/mls-library-selection.md`. 🔒 — _residual: RFC 9420 interop vectors, gzipped bundle-size measurement, and the iOS-Safari installed-PWA proof (USER)._
- [ ] S2. **Book the paid GA gates** — quotes + provisional calendar holds for G4 (crypto review) and G5 (pen test), ~2 months out. Lead time is the schedule risk, not the audits.
