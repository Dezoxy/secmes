-- GDPR Art. 17 erasure: allow the app role to delete audit_events rows by actor_sub.
-- Migration 0002 only grants SELECT + INSERT; this adds DELETE for the erasure flow.
grant delete on audit_events to argus_app;
