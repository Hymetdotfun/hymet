-- Chain-confirmed distributor events are the source of truth for fee and claim rows.
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS last_signature text;

CREATE TABLE IF NOT EXISTS distributor_chain_events (
  signature text NOT NULL,
  event_index integer NOT NULL CHECK (event_index >= 0),
  program_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('FeesSettled','HolderEpochFunded','HolderClaimed','CreatorClaimed','MigrationPoolRegistered')),
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  slot bigint NOT NULL CHECK (slot > 0),
  commitment text NOT NULL CHECK (commitment IN ('confirmed','finalized')),
  payload jsonb NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signature,event_index)
);
CREATE INDEX IF NOT EXISTS distributor_events_mint_slot_idx ON distributor_chain_events(mint_address,slot DESC);

-- Prepared from one confirmed token-account snapshot before a fund_epoch instruction.
-- It becomes claimable only when a matching HolderEpochFunded event is confirmed.
CREATE TABLE IF NOT EXISTS holder_snapshot_candidates (
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  epoch bigint NOT NULL CHECK (epoch >= 0),
  snapshot_slot bigint NOT NULL CHECK (snapshot_slot > 0),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  merkle_root text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  funded_amount numeric(40,0) NOT NULL CHECK (funded_amount > 0),
  allocated_amount numeric(40,0) NOT NULL CHECK (allocated_amount >= 0 AND allocated_amount <= funded_amount),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','funded','rejected')),
  funding_signature text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint_address,epoch),
  CHECK ((status='prepared' AND funding_signature IS NULL) OR (status IN ('funded','rejected')))
);
CREATE TABLE IF NOT EXISTS holder_snapshot_candidate_rows (
  mint_address text NOT NULL,
  epoch bigint NOT NULL,
  wallet_address text NOT NULL,
  token_balance numeric(40,0) NOT NULL CHECK (token_balance > 0),
  reward_amount numeric(40,0) NOT NULL CHECK (reward_amount >= 0),
  leaf_hash text NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  merkle_proof jsonb NOT NULL,
  PRIMARY KEY (mint_address,epoch,wallet_address),
  FOREIGN KEY (mint_address,epoch) REFERENCES holder_snapshot_candidates(mint_address,epoch) ON DELETE CASCADE
);
