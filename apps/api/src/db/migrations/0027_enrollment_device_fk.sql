-- 0027_enrollment_device_fk — tighten fk_enroll_device to include user_id dimension.
-- The original FK in 0024 pins requesting_device_id to (tenant_id, id) only, which proves the
-- device exists in this tenant but does NOT prove it belongs to the enrollment's user_id. A row
-- with a mismatched user_id could be inserted (e.g. tenant admin inserting a cross-user enrollment).
-- Fix: reference (tenant_id, user_id, id) via the devices_tenant_user_id_uidx unique index
-- added in 0012, which closes the gap.

alter table device_enrollments
  drop constraint if exists fk_enroll_device;

alter table device_enrollments
  add constraint fk_enroll_device
    foreign key (tenant_id, user_id, requesting_device_id)
    references devices (tenant_id, user_id, id) on delete cascade;
