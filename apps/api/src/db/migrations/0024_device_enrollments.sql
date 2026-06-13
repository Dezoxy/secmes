-- 0024_device_enrollments — B2: multi-device enrollment coordination.
-- Stores METADATA ONLY — the server never sees private key material or makes the trust decision.
-- D2 registers here (fingerprint is public: derived from D2's published signature key). D1 verifies
-- the fingerprint out-of-band, then calls /approve with an Ed25519 enroll-proof. The server verifies
-- the proof against D1's published signature public key and emits a WS nudge to D2. The trust
-- decision is 100% client-side (D1 fingerprint comparison + proof-of-possession). Invariant #1 holds.
-- 15-minute expires_at bounds the enrollment window; expired rows are GC'd async.
-- See docs/threat-models/multi-device-enrollment.md T1–T4.

create table if not exists device_enrollments (
  id                     uuid        primary key default gen_random_uuid(),
  tenant_id              uuid        not null,
  user_id                uuid        not null,
  requesting_device_id   uuid        not null,
  approved_by_device_id  uuid,
  -- PUBLIC fingerprint displayed by D2 (QR + 6-digit code). Derived from the published signature key;
  -- not a secret. D1 compares this to the fingerprint it computes from the claimed KeyPackage.
  fingerprint            text        not null,
  -- 'pending' | 'approved' | 'rejected' | 'expired'
  status                 text        not null default 'pending',
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz,
  -- Enrollment window: pending enrollment auto-expires after 15 minutes. Bounds the DoS blast radius
  -- (T4) and prevents stale enrollments from being approved hours later (T1 residual).
  expires_at             timestamptz not null default now() + interval '15 minutes',

  -- Tenant pinning: requesting_device_id MUST be a device in this tenant owned by user_id.
  constraint fk_enroll_user
    foreign key (tenant_id, user_id)
    references users (tenant_id, id) on delete cascade,
  constraint fk_enroll_device
    foreign key (tenant_id, requesting_device_id)
    references devices (tenant_id, id) on delete cascade,
  -- SET NULL on approver delete: preserve the audit trail after a device is removed.
  -- Column list required: without it PG nullifies the entire FK tuple (incl. tenant_id NOT NULL).
  constraint fk_enroll_approver
    foreign key (tenant_id, approved_by_device_id)
    references devices (tenant_id, id) on delete set null (approved_by_device_id)
);

-- Invariant #3: tenant isolation + FORCE RLS so even the table owner hits the tenant filter.
alter table device_enrollments enable row level security;
alter table device_enrollments force row level security;
drop policy if exists enrollments_tenant_isolation on device_enrollments;
create policy enrollments_tenant_isolation on device_enrollments
  using  (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- "What pending enrollments does D1 need to review?" — the D1 inbox query.
create index if not exists ix_enrollments_tenant_user_status
  on device_enrollments (tenant_id, user_id, status);

-- Minimal grants: argus_app may SELECT (D1 list), INSERT (D2 register), and UPDATE status/resolved_at
-- (D1 approve/reject). No DELETE — expired rows are left for the audit trail and GC'd externally.
grant select, insert on device_enrollments to argus_app;
grant update (status, approved_by_device_id, resolved_at) on device_enrollments to argus_app;
