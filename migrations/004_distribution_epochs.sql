-- Auditable, funded holder epochs. This stores evidence/indexing state only;
-- chain custody and one-time claims must be enforced by the distributor program.
CREATE TABLE holder_reward_epochs (
  mint_address text NOT NULL REFERENCES tokens(mint_address),
  epoch bigint NOT NULL CHECK (epoch >= 0),
  snapshot_slot bigint NOT NULL CHECK (snapshot_slot > 0),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  merkle_root text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  funded_amount numeric(40,0) NOT NULL CHECK (funded_amount > 0),
  allocated_amount numeric(40,0) NOT NULL CHECK (allocated_amount >= 0 AND allocated_amount <= funded_amount),
  quote_mint text NOT NULL,
  funding_signature text NOT NULL UNIQUE,
  finalized_signature text UNIQUE,
  status text NOT NULL CHECK (status IN ('funded','finalized','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mint_address, epoch),
  CHECK ((status = 'funded' AND finalized_signature IS NULL) OR (status IN ('finalized','closed') AND finalized_signature IS NOT NULL))
);

ALTER TABLE holder_reward_entitlements
  ADD COLUMN IF NOT EXISTS leaf_hash text CHECK (leaf_hash IS NULL OR leaf_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS merkle_proof jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE holder_reward_entitlements
  ADD CONSTRAINT holder_entitlements_epoch_fk
  FOREIGN KEY (mint_address, epoch) REFERENCES holder_reward_epochs(mint_address, epoch) NOT VALID;

ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_claim_type_check;
ALTER TABLE claims
  ADD CONSTRAINT claims_claim_type_check CHECK (claim_type IN ('creator','holder','platform'));
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_entitlement_type_check;
ALTER TABLE claims
  ADD CONSTRAINT claims_entitlement_type_check
  CHECK ((claim_type = 'holder' AND entitlement_id IS NOT NULL) OR claim_type IN ('creator','platform'));
CREATE UNIQUE INDEX IF NOT EXISTS claims_holder_entitlement_once
  ON claims(entitlement_id) WHERE claim_type = 'holder';
CREATE INDEX IF NOT EXISTS holder_reward_epochs_status_idx
  ON holder_reward_epochs(status, mint_address, epoch);
