# Phase 4 — Encrypted images

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 6/6 done.

> Goal: encrypted attachments, blobs the server can't read.

- [x] 33. **Presigned upload** — private bucket + presigned grant API 🔒
- [x] 34. **Client-side image encryption** with a random content key 🔒
- [x] 35. **Attachment refs** — encrypted blob upload + `attachments` table (RLS, ciphertext refs) 🔒
- [x] 36. **Download + decrypt** — recipient renders; member-only authz 🔒
- [x] 37. **Limits + lifecycle** — size limit (no type limit) + expiry/cleanup 🔒
- [x] 38. **Re-audit** — 42Crunch incl. attachment routes (100/100)
