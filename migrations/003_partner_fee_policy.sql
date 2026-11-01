-- Track the actual DBC partner fee flow used for HYMET's distinct 20% share.
ALTER TABLE fee_accruals
  DROP CONSTRAINT IF EXISTS fee_accruals_source_check;
ALTER TABLE fee_accruals
  ADD CONSTRAINT fee_accruals_source_check
  CHECK (source IN ('dbc_creator_fee','dbc_partner_fee','damm_partner_fee','damm_creator_fee'));

-- Keep claim history capable of recording a platform claim separately from
-- creator and holder claims. Claims remain indexed by confirmed signature.
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_claim_type_check;
ALTER TABLE claims
  ADD CONSTRAINT claims_claim_type_check
  CHECK (claim_type IN ('creator','holder','platform'));
ALTER TABLE claims
  DROP CONSTRAINT IF EXISTS claims_check;
ALTER TABLE claims
  ADD CONSTRAINT claims_entitlement_type_check
  CHECK ((claim_type = 'holder' AND entitlement_id IS NOT NULL) OR claim_type IN ('creator','platform'));

-- Fee amounts are in HYPE base units. Floor the HYMET fifth to an integer;
-- the remaining distributable units stay in the creator/holder allocation.
ALTER TABLE fee_settlements
  ADD CONSTRAINT fee_settlements_hymet_share_check
  CHECK (hymet_amount = trunc(distributable_amount * 0.20)) NOT VALID;
