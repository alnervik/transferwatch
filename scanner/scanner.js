// TransferWatch Scanner
// Hämtar marknadsdata från tibiamarket.top och sparar i Supabase.
// Körs via GitHub Actions cron eller manuellt: npm run scan

import { createClient } from '@supabase/supabase-js';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MARKET_API = 'https://api.tibiamarket.top:8001';
const TIBIADATA_API = 'https://api.tibiadata.com/v4';
const PAGE_LIMIT = 5000;
const THROTTLE_MS = 2000;   // 2s between API calls — safe for rate limits
const MAX_RETRIES = 5;

// Supabase — set via env vars or .env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── HELPERS ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastFetchTime = 0;

async function throttledFetch(url) {
  const now = Date.now();
  const wait = THROTTLE_MS - (now - lastFetchTime);
  if (wait > 0) await sleep(wait);
  lastFetchTime = Date.now();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const backoff = Math.min(4000 * attempt, 20000);
        console.log(`  ⏳ Rate limited, waiting ${backoff / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(backoff);
        lastFetchTime = Date.now();
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      const backoff = 3000 * attempt;
      console.log(`  ⚠️ Error: ${e.message}, retry in ${backoff / 1000}s (${attempt}/${MAX_RETRIES})`);
      await sleep(backoff);
    }
  }
}

// Fetch all market_values pages for a world
async function fetchWorldMarket(server) {
  let all = [];
  let skip = 0;
  while (true) {
    const url = `${MARKET_API}/market_values?server=${encodeURIComponent(server)}&skip=${skip}&limit=${PAGE_LIMIT}`;
    const data = await throttledFetch(url);
    if (!Array.isArray(data) || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE_LIMIT) break;
    skip += PAGE_LIMIT;
  }
  return all;
}

// Trim item data to only fields we need — reduces storage significantly
function trimItems(items) {
  return items
    .filter(it => it.buy_offer > 0 || it.sell_offer > 0)
    .map(it => ({
      id:          it.id,
      buy_offer:   it.buy_offer,
      sell_offer:  it.sell_offer,
      buy_offers:  it.buy_offers  || 0,
      sell_offers: it.sell_offers || 0,
      day_sold:    it.day_sold    || 0,
      day_bought:  it.day_bought  || 0,
      month_avg_buy:  it.month_average_buy  || 0,
      month_avg_sell: it.month_average_sell || 0,
      month_bought:   it.month_bought || 0,
      month_sold:     it.month_sold   || 0,
    }));
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  console.log('🔍 TransferWatch Scanner starting...\n');

  // 1. Fetch world list from TibiaData
  console.log('📡 Fetching world list from TibiaData...');
  const worldData = await fetch(`${TIBIADATA_API}/worlds`).then(r => r.json());
  const allWorlds = (worldData.worlds.regular_worlds || [])
    .filter(w => w.transfer_type === 'regular');
  console.log(`   Found ${allWorlds.length} transferable worlds\n`);

  // 2. Scan each world
  let scanned = 0;
  let failed = 0;
  const total = allWorlds.length;

  for (const world of allWorlds) {
    const idx = scanned + failed + 1;
    process.stdout.write(`[${idx}/${total}] ${world.name}... `);

    try {
      const rawItems = await fetchWorldMarket(world.name);
      const trimmed = trimItems(rawItems);

      // Upsert to Supabase
      const { error } = await supabase
        .from('world_market_data')
        .upsert({
          world_name: world.name,
          pvp_type: world.pvp_type,
          items: trimmed,
          scanned_at: new Date().toISOString(),
        }, { onConflict: 'world_name' });

      if (error) throw new Error(`Supabase: ${error.message}`);

      scanned++;
      console.log(`✅ ${rawItems.length} raw → ${trimmed.length} items stored`);
    } catch (e) {
      failed++;
      console.log(`❌ ${e.message}`);
    }
  }

  // 3. Summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✅ Scanned: ${scanned}/${total} worlds`);
  if (failed > 0) console.log(`❌ Failed: ${failed} worlds`);
  console.log(`⏱️  Time: ${elapsed} minutes`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
