# Threat model — Profile editing

**Feature:** `PUT /users/me { displayName?, avatarSeed? }`
**Phase:** Phase 4 of the private-messenger redesign

---

## 1. What this feature does

Allows an authenticated user to update their own `displayName` (a nickname validated by the hardened, shared `displayNameSchema` — see §7) and `avatarSeed` (a short non-PII token used client-side to pick a deterministic generated avatar via DiceBear). Neither field is sensitive. The feature replaces the old Zitadel-driven "display name collision retry" logic; names are now free nicknames, no longer unique per tenant.

**Custom photo upload is currently disabled** in the UI (see §8): the avatar is always generated client-side from a non-PII seed, so no user-supplied image ever enters the app.

---

## 2. Threat surface

| Threat | Impact | Mitigation |
|--------|--------|------------|
| Caller updates another user's profile (IDOR) | Unauthorised data modification | UPDATE scoped to `WHERE id = auth.userId AND tenant_id = auth.tenantId` under RLS — only the caller's own row can be modified |
| Caller changes their `argus_id` (identity hijack) | Breaks identity immutability invariant | `PUT /users/me` body schema has no `argusId` field; Zod strips unknown properties. DB trigger `users_argus_id_immutable` (added in migration 0030) raises an exception if `argus_id` ever changes — last line of defence |
| Caller changes `role` or `status` | Privilege escalation / account suspension bypass | Body schema only allows `displayName` and `avatarSeed`; all other fields are stripped by Zod and not included in the UPDATE SET clause |
| Bulk display-name churn (impersonation via display name) | Confusion / social engineering | Rate limit: 20 requests/min per user (`SENSITIVE_LIMITS.updateProfile`). Display names are free text and never unique, so impersonation resistance relies on argus-id being the stable, canonical identity. The hardened validator (§7) blocks the highest-leverage spoofing tricks — zero-width / RTL-override / homoglyph-script (e.g. Cyrillic look-alikes) names are rejected outright |
| avatarSeed injection (e.g. XSS via stored seed) | Stored XSS if seed is rendered without escaping | `avatarSeed` is an opaque string stored as-is; the client passes it to DiceBear's deterministic generator — it is NEVER rendered as raw HTML. Length cap (≤64 chars) prevents oversized payloads |
| Display name as injection / obfuscation vector | SQL injection / stored XSS / invisible-text abuse | Drizzle parameterised query; the string is rendered only through JSX (auto-escaped) and never reaches an HTML sink, `document.title`, or a push body. Beyond that, `displayNameSchema` (§7) rejects control, zero-width, bidi-override, emoji, and combining-mark characters at the boundary, so a name cannot carry hidden or display-spoofing payloads in the first place |

---

## 3. argus_id immutability

The `users_argus_id_immutable` BEFORE UPDATE trigger (migration 0030) enforces:

```sql
IF NEW.argus_id IS DISTINCT FROM OLD.argus_id THEN
  RAISE EXCEPTION 'argus_id is immutable';
END IF;
```

This fires for ALL UPDATE statements on the `users` table, including `ON CONFLICT DO UPDATE` paths. `PUT /users/me` never includes `argus_id` in its SET clause, so the trigger never fires in normal operation.

---

## 4. Display name uniqueness removal

Migration 0038 drops `users_tenant_display_name_idx` (the unique index that made display names unique per tenant). Display names are now free nicknames — two users can share the same name. Identity is argus-id only. The collision-retry loop in `user.service.ts provisionFromToken()` is removed.

---

## 5. Invariant check

| Invariant | Status |
|-----------|--------|
| 1. Server is crypto-blind — no message content read | ✅ No message content involved |
| 2. No secrets/tokens/content in logs | ✅ `displayName` is user-chosen metadata, not a secret. `avatarSeed` is non-PII. Neither is logged |
| 3. Every tenant-scoped table has `tenant_id` + RLS | ✅ UPDATE runs via `withTenant()` under the RLS-enforced `users` table |
| 4. No hand-rolled crypto | ✅ No crypto in this endpoint |
| 5. Secrets via Key Vault — no env secrets | ✅ No secrets involved |
| 6. No admin path to content | ✅ Returns 204 No Content only; no content fields |

---

## 6. Audit coverage

`users.profile_updated` audit event on success with:
- `actorSub` (caller's subject)
- `fields: ['displayName', 'avatarSeed']` (which fields were updated — never their values)

Never log `displayName` or `avatarSeed` values in audit events.

---

## 7. Hardened display-name policy

`displayName` is the only user-controlled free-text identity field, so it is validated by a single shared schema — `displayNameSchema` in `@argus/contracts` — enforced identically on the web form (`ProfileEdit`) and the API (`ZodValidationPipe(UpdateProfileSchema)`). The policy:

- **Trim**, then **collapse internal whitespace** runs to a single space.
- **Length 2–32 characters.**
- **Strict Latin allow-list**: letters `A–Za–z`, digits `0–9`, space, and `. _ - '` only.
- **Reserved sentinels** (e.g. `breakglass-admin`) rejected, case-insensitively.

Rationale — the allow-list is a *positive* filter, so by construction it rejects entire classes of abuse without enumerating them:

| Attack | Why it fails |
|--------|--------------|
| Zero-width characters (U+200B–200D) — invisible duplicates, padding | Not in the allow-list |
| Bidirectional overrides (U+202A–202E / U+2066–2069) — "Trojan" / RTL display spoofing | Not in the allow-list |
| Homoglyph / mixed-script impersonation (Cyrillic `А`, Greek `Ο`) | Only ASCII Latin letters allowed; confusable scripts rejected |
| Combining-mark (Zalgo) spam | Combining marks not in the allow-list |
| Emoji / pictographs | Not in the allow-list |
| Control characters / newlines | Not in the allow-list |
| Length abuse / UI overflow | Capped at 32 |

**Residual:** within-ASCII look-alikes (`rn` vs `m`, `0` vs `O`, `l` vs `1`) are still possible — full single-script/confusable enforcement is deferred. The canonical, non-spoofable identity remains the immutable `argus-id`; display names are a convenience label only. Auto-generated `<Adjective> <Animal>` handles always satisfy this policy (guarded by a test in `handle-words.spec.ts`).

---

## 8. Avatar upload deferral

Custom avatar **photo upload is disabled** in the UI. The "Upload photo" control now shows a "coming soon" notice instead of opening a file picker; the avatar is always generated client-side (DiceBear). Custom photos were only ever stored client-side (the server holds at most a non-PII `avatarSeed`, never image bytes), so removing the entry point means **no _new_ user-supplied image can be added through the UI**. A custom photo persisted on a device *before* this change still loads from client storage and renders (sanitised by `safeAvatarSrc` — raster-data-URI allow-list + 120 KB cap, `apps/web/src/features/chat/seed.ts`); fully purging those would require clearing the persisted `avatar` on load. None of this is ever sent to or stored on the server.

Security effect: eliminates the client-side image-decode/compression/canvas *intake* surface and any EXIF/metadata-in-photo exposure for new images until a properly reviewed upload pipeline (content scanning, metadata stripping, size/type enforcement) is designed. `avatarSeed` and the `PUT /me` schema are unchanged; this is a UI-only restriction, reversible when the feature is built.
