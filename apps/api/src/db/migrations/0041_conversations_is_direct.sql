-- 0041_conversations_is_direct — roster recovery: mark direct 1:1 conversations so a reinstalled
-- device can filter its server-side membership list. contact-list-recovery-plan.md §PR 2.
--
-- NULL  = pre-migration row; cannot be classified without a creation-type field — excluded from
--         recovery (safer than false-positive is_direct on a group). Threat-model §5 backfill rule.
-- TRUE  = created as a direct 1:1 via POST /conversations with one peer.
-- FALSE = created as a group.
--
-- No backfill: existing rows stay NULL (ambiguous). Recovery skips NULL rows.
-- No new index: recovery queries per-member (conversation_members → conversations JOIN) and the
-- existing conversations_tenant_idx (tenant_id, created_at) covers that JOIN path.
--
-- down: ALTER TABLE conversations DROP COLUMN is_direct;

ALTER TABLE conversations ADD COLUMN is_direct boolean;
