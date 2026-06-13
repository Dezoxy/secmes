-- Provisional devices are freshly published key pairs that have not yet been verified by the
-- enrollment ceremony (B2). A device is provisional from the moment it is published to the
-- key-directory until its enrollment is approved by a non-provisional (trusted) device.
-- Only non-provisional devices may approve new enrollments — this blocks a stolen bearer token
-- from publishing a fresh key pair and immediately using it to approve a rogue enrollment.

ALTER TABLE devices ADD COLUMN is_provisional boolean NOT NULL DEFAULT false;

-- Index for the approveEnrollment + publishKeyPackages checks (both filter on userId + is_provisional).
CREATE INDEX ix_devices_tenant_user_provisional
  ON devices (tenant_id, user_id, is_provisional);
