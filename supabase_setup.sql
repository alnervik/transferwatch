-- TransferWatch: Supabase schema
-- Kör detta i Supabase SQL Editor

-- Tabell för cachad marknadsdata per värld
CREATE TABLE world_market_data (
  world_name TEXT PRIMARY KEY,
  pvp_type TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index för snabbare queries
CREATE INDEX idx_world_market_scanned ON world_market_data (scanned_at DESC);

-- RLS: tillåt public reads (anon key), begränsa writes till service_role
ALTER TABLE world_market_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access"
  ON world_market_data FOR SELECT
  USING (true);

CREATE POLICY "Service role write access"
  ON world_market_data FOR ALL
  USING (true)
  WITH CHECK (true);

-- Ge anon-rollen läsrättigheter
GRANT SELECT ON world_market_data TO anon;
GRANT ALL ON world_market_data TO service_role;
