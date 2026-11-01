-- Automatic holder payouts: chunked push distribution and a carry ledger for
-- amounts below the payout threshold (they stay in the on-chain holder pool).
ALTER TABLE distributor_chain_events DROP CONSTRAINT IF EXISTS distributor_chain_events_event_type_check;
ALTER TABLE distributor_chain_events ADD CONSTRAINT distributor_chain_events_event_type_check
  CHECK (event_type IN ('FeesSettled','HolderEpochFunded','HolderClaimed','HolderPaid','HolderEpochClosed','CreatorClaimed','MigrationPoolRegistered'));

ALTER TABLE holder_snapshot_candidates ADD COLUMN IF NOT EXISTS chunk_count integer CHECK (chunk_count IS NULL OR chunk_count BETWEEN 1 AND 1024);
ALTER TABLE holder_snapshot_candidates ADD COLUMN IF NOT EXISTS carry_after jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE holder_snapshot_candidate_rows ADD COLUMN IF NOT EXISTS chunk_index integer CHECK (chunk_index IS NULL OR chunk_index >= 0);
ALTER TABLE holder_snapshot_candidate_rows ADD COLUMN IF NOT EXISTS new_account boolean NOT NULL DEFAULT false;
ALTER TABLE holder_reward_entitlements ADD COLUMN IF NOT EXISTS chunk_index integer CHECK (chunk_index IS NULL OR chunk_index >= 0);

CREATE TABLE IF NOT EXISTS holder_reward_carry (
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  wallet_address text NOT NULL,
  amount numeric(40,0) NOT NULL CHECK (amount >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint_address, wallet_address)
);
