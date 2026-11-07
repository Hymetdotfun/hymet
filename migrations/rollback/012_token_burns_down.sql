-- Removes the burn tracker tables. The burn index can be rebuilt from the chain at any time.
DROP TABLE IF EXISTS token_burn_checkpoints;
DROP TABLE IF EXISTS token_burns;
DELETE FROM hymet_schema_migrations WHERE name = '012_token_burns.sql';
