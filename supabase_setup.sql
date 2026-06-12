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

-- RLS: bara inloggade konton får läsa, writes begränsas till service_role
ALTER TABLE world_market_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read access"
  ON world_market_data FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role write access"
  ON world_market_data FOR ALL
  USING (true)
  WITH CHECK (true);

-- Bara inloggade (authenticated) får läsa — anon-rollen får inget.
GRANT SELECT ON world_market_data TO authenticated;
GRANT ALL ON world_market_data TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- Lås ner item_offers på samma sätt (tabellen skapas av Phase 2-scannern).
-- Kör bara dessa rader om tabellen redan finns.
ALTER TABLE item_offers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read access"
  ON item_offers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role write access"
  ON item_offers FOR ALL
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON item_offers TO authenticated;
GRANT ALL ON item_offers TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- VIKTIGT — gör detta i Supabase Dashboard, inte i SQL:
--   1. Authentication → Providers → Email: stäng av "Enable signups" (annars kan
--      vem som helst registrera sig själv). Lägg till konton manuellt under
--      Authentication → Users → "Add user" (sätt ett lösenord, bekräfta e-post).
--   2. Om du redan kört den gamla "Public read access"-policyn: ta bort den med
--      DROP POLICY "Public read access" ON world_market_data;
--      REVOKE SELECT ON world_market_data FROM anon;
