-- Reverses 011_carry_origins.sql. Run it by hand only, after the app and keeper are back on code from before 011, because
-- that code does not use these columns and newer code requires them.
-- Carried amounts are kept, attributed to the same wallets. Only origin records and stored snapshot balances go, so
-- reapplying 011 needs a fresh backfill before sellers can be proven. Take a backup first.
BEGIN;
ALTER TABLE holder_reward_carry DROP COLUMN IF EXISTS origin_token_balance;
ALTER TABLE holder_reward_carry DROP COLUMN IF EXISTS origin_snapshot_slot;
ALTER TABLE holder_reward_carry DROP COLUMN IF EXISTS origin_epoch;
ALTER TABLE holder_reward_entitlements DROP COLUMN IF EXISTS origin_snapshot_slot;
ALTER TABLE holder_reward_entitlements DROP COLUMN IF EXISTS origin_epoch;
ALTER TABLE holder_snapshot_candidate_rows DROP COLUMN IF EXISTS origin_snapshot_slot;
ALTER TABLE holder_snapshot_candidate_rows DROP COLUMN IF EXISTS origin_epoch;
ALTER TABLE holder_snapshot_candidates DROP COLUMN IF EXISTS carry_origins;
ALTER TABLE holder_snapshot_candidates DROP COLUMN IF EXISTS snapshot_balances;
DELETE FROM hymet_schema_migrations WHERE name = '011_carry_origins.sql';
COMMIT;
