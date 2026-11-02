-- Instant graduation: the app records a request once the chain shows a complete DBC curve; the keeper's graduation
-- watcher (scripts/graduation-watcher.mjs) is woken by NOTIFY and runs the normal keeper for that mint at once.
-- One row per mint; the periodic keeper stays the fallback, so a lost request only delays migration.
CREATE TABLE IF NOT EXISTS graduation_requests (
  mint_address text PRIMARY KEY REFERENCES tokens(mint_address),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION hymet_notify_graduation() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'pending' THEN PERFORM pg_notify('hymet_graduation', NEW.mint_address); END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS graduation_requests_notify ON graduation_requests;
CREATE TRIGGER graduation_requests_notify AFTER INSERT OR UPDATE OF status ON graduation_requests
  FOR EACH ROW EXECUTE FUNCTION hymet_notify_graduation();
