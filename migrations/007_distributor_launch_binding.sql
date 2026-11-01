ALTER TABLE tokens ADD COLUMN distributor_program_id text;
ALTER TABLE tokens ADD COLUMN distributor_fee_pool text;
ALTER TABLE tokens ADD CONSTRAINT distributor_binding_complete CHECK ((distributor_program_id IS NULL) = (distributor_fee_pool IS NULL));
CREATE UNIQUE INDEX tokens_distributor_fee_pool ON tokens(distributor_program_id,distributor_fee_pool) WHERE distributor_program_id IS NOT NULL;
