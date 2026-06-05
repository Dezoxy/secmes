-- 0003_users_email_index — serve the tenant directory (`order by email`) without a sort/scan.
-- Leading tenant_id per the repo's table procedure; RLS already filters by tenant_id, so this
-- index turns `where tenant_id = current order by email limit N` into an index range scan.
create index if not exists users_tenant_email_idx on users (tenant_id, email);
