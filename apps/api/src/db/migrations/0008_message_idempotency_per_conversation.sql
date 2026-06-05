-- 0008_message_idempotency_per_conversation — scope the send-idempotency key to the CONVERSATION.
-- 0007 made it unique on (tenant_id, sender_user_id, client_message_id); a client that reused a
-- client_message_id across two conversations would then silently dedup into the first and drop the
-- second message. Scoping the key to the conversation makes each conversation its own id space, so the
-- send path dedups correctly. Forward-only: drop the old index, create the conversation-scoped one.
drop index if exists messages_idempotency_idx;
create unique index if not exists messages_idempotency_idx
  on messages (tenant_id, conversation_id, sender_user_id, client_message_id);
