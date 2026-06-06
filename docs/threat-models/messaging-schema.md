# Threat model: messaging schema (conversations / members / messages)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 25** — the Phase-3 data model for 1:1 (and later group) encrypted text. Schema + RLS only; the send API authz is checkpoint 26, end-to-end text is 27. Written before the migration.

## 1. Feature & data flow

```
send:   client MLS-encrypts plaintext → CipherEnvelope{ciphertext(b64), alg, epoch}
        → POST (26) → server stores a messages row (CIPHERTEXT ONLY) under the sender's tenant
fetch:  member client → GET (27) → server returns the opaque rows → client MLS-decrypts locally
```

Three tenant-scoped tables:

- **`conversations`** — a conversation/MLS group. Metadata only: `id`, `tenant_id`, `created_by`, `created_at`. **No name/title column** — a group name would be plaintext metadata; 1:1 needs none, and if added later it must be encrypted.
- **`conversation_members`** — user↔conversation membership (`tenant_id`, `conversation_id`, `user_id`, `joined_at`). Drives app-layer send/read authz (26). User-level; device/leaf fan-out is the MLS client's concern.
- **`messages`** — `ciphertext` (opaque base64 MLS wire bytes), plus metadata the server legitimately needs to route/version/dedup: `alg`, `epoch`, `client_message_id`, `sender_user_id`, optional `attachment_object_key`. **No plaintext-bearing column.**

The server only ever sees ciphertext + routing metadata. It never decrypts; only MLS group members hold the keys.

## 2. Assets & trust boundaries

- **Assets:** message **content** (protected by E2EE, never in the DB as plaintext); **metadata** (who is in which conversation, message timing/volume) — visible to the operator and worth minimizing; tenant isolation.
- **Boundaries:** tenant ↔ tenant (RLS); client ↔ server (server crypto-blind); member ↔ non-member *within* a tenant (app-layer membership authz, 26 — defense-in-depth atop E2EE).

## 3. Threats (STRIDE-lite)

- **Spoofing — forge sender.** `sender_user_id` is set from the **verified token** (sub→user), never from client input; a client can't post as someone else. (Wired in 26.)
- **Tampering — mutate/replay messages.** Messages are **append-only** for the app role (`select, insert` grants; no `update`/`delete`). `client_message_id` is unique per sender for **idempotent** retries (no duplicate on resend). Ciphertext integrity is the MLS AEAD's job, not the DB's.
- **Information disclosure — cross-tenant read.** Every table has `tenant_id` + **ENABLE + FORCE RLS + WITH CHECK** keyed on `current_setting('app.tenant_id')`; the non-bypass `argus_app` role can't see another tenant's rows or disable RLS. Content disclosure is additionally barred by E2EE (a same-tenant non-member who somehow read a `messages` row gets ciphertext it can't decrypt).
- **Elevation — read a conversation you're not in (intra-tenant).** RLS stops *cross-tenant*, not *intra-tenant non-member* reads. That authz (is the caller a `conversation_members` row?) is enforced in the **app layer at 26**; E2EE is the backstop. Optionally hardenable later to DB-enforced membership RLS via an `app.user_id` session var (see §6).

## 4. Invariant check

- **#1 crypto-blind server** — upheld: `ciphertext` is opaque; `alg`/`epoch`/`client_message_id`/`attachment_object_key` are routing/version metadata, not content. No column can hold plaintext.
- **#2 no secret logging** — services log IDs/metadata only (enforced by `argus-no-secret-logging`); `ciphertext` is never logged.
- **#3 RLS on every tenant table** — all three tables: `tenant_id` + ENABLE+FORCE RLS + WITH CHECK + leading-`tenant_id` index.
- **#4 no hand-rolled crypto / #5 Key Vault / #6 no admin content access** — N/A to the schema, upheld elsewhere; admin/ops see metadata only (no decryptable content exists server-side).

## 5. Decision & mitigations

- Migration `0007_messaging.sql`: the three tables with `tenant_id` + FORCE RLS + WITH CHECK; leading-`tenant_id` indexes (`(tenant_id, conversation_id, created_at)` for fetch; unique `(tenant_id, conversation_id, sender_user_id, client_message_id)` for **conversation-scoped** idempotency (0008 — so a reused `client_message_id` can't silently dedup across conversations); unique `(tenant_id, conversation_id, user_id)` for membership). Grants: `conversations` select/insert; `conversation_members` select/insert/delete; `messages` **select/insert only** (append-only). FKs cascade from `tenants`/`conversations`.
- **Composite-FK tenant pinning (defence-in-depth beneath RLS):** every FK that could otherwise cross a tenant is pinned to the row's `tenant_id`. `conversations` and `users` each carry `unique (tenant_id, id)`; `conversation_members`/`messages` reference `(tenant_id, conversation_id) → conversations(tenant_id, id)`, and **all user references** (`conversations.created_by`, `conversation_members.user_id`, `messages.sender_user_id`) reference `(tenant_id, user_col) → users(tenant_id, id)`. A row therefore **cannot** point at a conversation *or a user* in a different tenant even with a mismatched `tenant_id` (the DB rejects it, not just RLS), and a cross-tenant user delete cannot cascade into another tenant's rows. `epoch` carries `check (epoch >= 0)`.
- **Send/fetch API (26/27):** `POST /conversations` (+ members), `POST /conversations/:id/messages` (store ciphertext), `GET /conversations/:id/messages` (list ciphertext, keyset-paginated). All three enforce **membership authz** at the app layer via `requireMembership` — non-member / cross-tenant / non-existent conversation collapse to a uniform **404** (no existence leak). The fetch returns the opaque `ciphertext` + routing metadata verbatim (crypto-blind); cursor lookups are RLS-scoped so a foreign cursor yields an empty page.
- Gate: **`security-boundary-auditor`** review; the `rls.spec.ts`-style integration tests prove cross-tenant read/write are blocked and fail-closed without tenant context.

## 6. Residual risk

- **Metadata to the operator.** Conversation membership and message timing/size are visible server-side (inherent to a store-and-forward server). Disclosed in plan §14/§15 + DPA; padding/cover-traffic is out of scope for beta.
- **Intra-tenant membership authz is app-layer (26), not yet DB-enforced.** A bug in the send/fetch authz would expose *ciphertext* (still undecryptable by non-members) and metadata to a same-tenant user. Backstopped by E2EE; hardenable to membership-RLS (`app.user_id` session var) later if warranted.
- **"Sender/member is in the conversation" is not DB-enforced.** The composite FK pins a message/membership to a same-tenant conversation, but there is no FK from `messages.sender_user_id` to `conversation_members` — a same-tenant user could (absent the 26 authz check) insert a message into a conversation they're not a member of. Enforced at the app layer (26); companion to the read-side gap above; E2EE remains the content backstop.
- **Retention & deletion semantics.** Messages are append-only with no prune yet. The user-referencing FKs (`created_by`, `sender_user_id`) are **`ON DELETE NO ACTION`**, so a direct user delete **cannot** cascade-erase message history — it is blocked if the user created a conversation or sent a message. Offboarding should therefore be a **soft delete** (`users.status`), not a hard `DELETE`; a **tenant** teardown still cascades everything (verified). A deliberate **GDPR erasure** path (remove a user's messages/PII explicitly, or rely on E2EE key destruction making ciphertext unrecoverable) is a later owner-level flow — it must be explicit, never an accidental cascade. (`conversation_members.user_id` stays `CASCADE`: removing a deleted user's membership rows erases no content.)
