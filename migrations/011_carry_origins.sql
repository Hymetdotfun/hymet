-- Carried holder rewards remember the funded snapshot that allocated them, so a wallet that later sells can be paid with its
-- true balance at that snapshot. Additive: no existing value changes. Existing carry has no origin until it is backfilled,
-- and without one it stays carried, attributed to its wallet.
ALTER TABLE holder_snapshot_candidates ADD COLUMN IF NOT EXISTS snapshot_balances jsonb;
ALTER TABLE holder_snapshot_candidates ADD COLUMN IF NOT EXISTS carry_origins jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE holder_snapshot_candidate_rows ADD COLUMN IF NOT EXISTS origin_epoch numeric(20,0);
ALTER TABLE holder_snapshot_candidate_rows ADD COLUMN IF NOT EXISTS origin_snapshot_slot numeric(20,0);
ALTER TABLE holder_reward_entitlements ADD COLUMN IF NOT EXISTS origin_epoch numeric(20,0);
ALTER TABLE holder_reward_entitlements ADD COLUMN IF NOT EXISTS origin_snapshot_slot numeric(20,0);
ALTER TABLE holder_reward_carry ADD COLUMN IF NOT EXISTS origin_epoch numeric(20,0);
ALTER TABLE holder_reward_carry ADD COLUMN IF NOT EXISTS origin_snapshot_slot numeric(20,0);
ALTER TABLE holder_reward_carry ADD COLUMN IF NOT EXISTS origin_token_balance numeric(40,0) CHECK (origin_token_balance IS NULL OR origin_token_balance > 0);
