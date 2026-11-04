-- A token is identified by its mint address; names and tickers no longer have to be unique. Additive to the data: only the
-- uniqueness rules go. The columns stay as search keys, and launch records remain as anti-spam and duplicate-submission
-- protection through their wallet, nonce and signature constraints.
DROP INDEX IF EXISTS launch_reservations_active_name_key;
DROP INDEX IF EXISTS launch_reservations_active_ticker_key;
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_name_key_key;
ALTER TABLE tokens DROP CONSTRAINT IF EXISTS tokens_ticker_key_key;
CREATE INDEX IF NOT EXISTS tokens_name_key_idx ON tokens(name_key);
CREATE INDEX IF NOT EXISTS tokens_ticker_key_idx ON tokens(ticker_key);
CREATE INDEX IF NOT EXISTS launch_reservations_wallet_active ON launch_reservations(creator_wallet, expires_at) WHERE status = 'reserved';
