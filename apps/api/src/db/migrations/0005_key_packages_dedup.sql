-- 0005 — one-time-use integrity: never store the same KeyPackage twice for a device, so two members
-- can't claim identical MLS bytes (init-key reuse). md5() keeps the index small (key_package can be
-- long); dedup is an integrity guard, not a security boundary (an attacker gains nothing from a collision).
create unique index if not exists key_packages_unique_idx
  on key_packages (tenant_id, device_id, md5(key_package));
