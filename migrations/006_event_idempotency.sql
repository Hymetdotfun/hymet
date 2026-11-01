-- A Solana transaction may settle or claim more than one pool/epoch.
ALTER TABLE fee_accruals ADD COLUMN IF NOT EXISTS event_index integer NOT NULL DEFAULT 0 CHECK (event_index >= 0);
ALTER TABLE fee_accruals DROP CONSTRAINT IF EXISTS fee_accruals_source_signature_source_key;
CREATE UNIQUE INDEX IF NOT EXISTS fee_accruals_signature_event_source_uq
  ON fee_accruals(source_signature,event_index,source);

ALTER TABLE fee_settlements ADD COLUMN IF NOT EXISTS event_index integer NOT NULL DEFAULT 0 CHECK (event_index >= 0);
ALTER TABLE fee_settlements DROP CONSTRAINT IF EXISTS fee_settlements_transaction_signature_key;
CREATE UNIQUE INDEX IF NOT EXISTS fee_settlements_signature_event_uq
  ON fee_settlements(transaction_signature,event_index);

ALTER TABLE claims ADD COLUMN IF NOT EXISTS event_index integer NOT NULL DEFAULT 0 CHECK (event_index >= 0);
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_transaction_signature_key;
CREATE UNIQUE INDEX IF NOT EXISTS claims_signature_event_uq
  ON claims(transaction_signature,event_index);

ALTER TABLE holder_reward_epochs ADD COLUMN IF NOT EXISTS funding_event_index integer NOT NULL DEFAULT 0 CHECK (funding_event_index >= 0);
ALTER TABLE holder_reward_epochs DROP CONSTRAINT IF EXISTS holder_reward_epochs_funding_signature_key;
CREATE UNIQUE INDEX IF NOT EXISTS holder_epochs_funding_signature_event_uq
  ON holder_reward_epochs(funding_signature,funding_event_index);

ALTER TABLE holder_snapshot_candidates ADD COLUMN IF NOT EXISTS funding_event_index integer NOT NULL DEFAULT 0 CHECK (funding_event_index >= 0);
ALTER TABLE holder_snapshot_candidates DROP CONSTRAINT IF EXISTS holder_snapshot_candidates_funding_signature_key;
CREATE UNIQUE INDEX IF NOT EXISTS holder_candidates_funding_signature_event_uq
  ON holder_snapshot_candidates(funding_signature,funding_event_index)
  WHERE funding_signature IS NOT NULL;
