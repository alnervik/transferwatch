// TransferWatch Scanner — Two-Phase
// Phase 1: Fetch market_values for all worlds
// Phase 2: Fetch market_board for items in profitable trades
// Körs via GitHub Actions cron eller manuellt: npm run scan

import { createClient } from '@supabase/supabase-js';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MARKET_API = 'https://api.tibiamarket.top:8001';
const TIBIADATA_API = 'https://api.tibiadata.com/v4';
const PAGE_LIMIT = 5000;
const MAX_RETRIES = 5;
const MAX_BOARD_FETCHES = 200;

const TC_ITEM_ID = 22118;
const TRANSFER_COST_TC = 750;

// PvP transfer rules
const PVP_RANK = {
  'Optional PvP': 0, 'Open PvP': 1,
  'Retro Open PvP': 2, 'Retro Hardcore PvP': 3
};

const GREEN_BE = new Set([
  'Aethera','Blumera','Bravoria','Cantabra','Citra','Collabra','Descubra','Dia','Dracobra',
  'Eclipta','Escura','Etebra','Gladibra','Honbra','Hostera','Idyllia','Ignitera','Issobra',
  'Jadebra','Kalanta','Kalimera','Karmeya','Luzibra','Monstera','Mystera','Nevia','Noctalia',
  'Ombra','Ourobra','Penumbra','Quidera','Rasteibra','Retalia','Sombra','Sonira','Stralis',
  'Tempestera','Terribra','Tornabra','Unebra','Ustebra','Venebra','Victoris','Yovera','Yubra'
]);

function canTransfer(fromName, fromPvp, toName, toPvp) {
  const fr = PVP_RANK[fromPvp], tr = PVP_RANK[toPvp];
  if (fr === undefined || tr === undefined) return false;
  if (tr > fr) return false;
  const fromBE = GREEN_BE.has(fromName) ? 'green' : 'yellow';
  const toBE = GREEN_BE.has(toName) ? 'green' : 'yellow';
  if (fromBE === 'yellow' && toBE === 'green') return false;
  return true;
}

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── HELPERS ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Smart rate limiter: burst 4 requests, pause, long pause every ~85 requests
const BURST_SIZE = 4;          // requests per burst
const BURST_DELAY = 2000;      // 3s between requests in a burst
const BURST_PAUSE = 15000;     // 15s pause between bursts
const LONG_PAUSE_EVERY = 85;   // long pause after this many requests
const LONG_PAUSE_MS = 180000;  // 3 min long pause to fully reset bucket

let requestCount = 0;
let burstCount = 0;

async function throttledFetch(url) {
  // Long pause to reset the ~100-request bucket
  if (requestCount > 0 && requestCount % LONG_PAUSE_EVERY === 0) {
    console.log(`\n  ⏸️  Long pause: ${LONG_PAUSE_MS / 1000}s to reset rate limit bucket (${requestCount} requests done)...\n`);
    await sleep(LONG_PAUSE_MS);
    burstCount = 0;
  }

  // Burst pause: after BURST_SIZE requests, wait longer
  if (burstCount > 0 && burstCount % BURST_SIZE === 0) {
    await sleep(BURST_PAUSE);
    burstCount = 0;
  } else if (burstCount > 0) {
    await sleep(BURST_DELAY);
  }

  requestCount++;
  burstCount++;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        // Hit rate limit — back off aggressively
        const backoff = Math.min(30000 * attempt, 120000);
        console.log(`  ⏳ Rate limited, waiting ${backoff / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      const backoff = 5000 * attempt;
      console.log(`  ⚠️ Error: ${e.message}, retry in ${backoff / 1000}s (${attempt}/${MAX_RETRIES})`);
      await sleep(backoff);
    }
  }
  throw new Error('All retries exhausted');
}

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
    }));
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const PHASE2_ONLY = process.argv.includes('--phase2');
  console.log('🔍 TransferWatch Scanner starting...');
  if (PHASE2_ONLY) console.log('   ⚡ Phase 2 only — loading world data from Supabase');
  console.log('');

  const worldMarket = {};  // worldName → trimmed items array
  const worldPvp = {};     // worldName → pvp_type

  if (!PHASE2_ONLY) {
    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1: Fetch market_values for all worlds
    // ═══════════════════════════════════════════════════════════════════════
    console.log('═══ PHASE 1: Market Values ═══\n');

    console.log('📡 Fetching world list from TibiaData...');
    const worldResponse = await fetch(`${TIBIADATA_API}/worlds`).then(r => r.json());
    const allWorlds = (worldResponse.worlds.regular_worlds || [])
      .filter(w => w.transfer_type === 'regular');
    console.log(`   Found ${allWorlds.length} transferable worlds\n`);

    let scanned = 0, failed = 0;

    for (const world of allWorlds) {
      const idx = scanned + failed + 1;
      process.stdout.write(`[${idx}/${allWorlds.length}] ${world.name}... `);

      try {
        const rawItems = await fetchWorldMarket(world.name);
        const trimmed = trimItems(rawItems);

        const { error } = await supabase
          .from('world_market_data')
          .upsert({
            world_name: world.name,
            pvp_type: world.pvp_type,
            items: trimmed,
            scanned_at: new Date().toISOString(),
          }, { onConflict: 'world_name' });

        if (error) throw new Error(`Supabase: ${error.message}`);

        worldMarket[world.name] = trimmed;
        worldPvp[world.name] = world.pvp_type;
        scanned++;
        console.log(`✅ ${trimmed.length} items`);
      } catch (e) {
        failed++;
        console.log(`❌ ${e.message}`);
      }
    }

    const phase1Time = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\nPhase 1 done: ${scanned} worlds in ${phase1Time} min\n`);

    // Pause between phases to let rate limit reset
    console.log('⏸️  Pausing 120s to let rate limit fully reset...\n');
    await sleep(120000);
    requestCount = 0;
    burstCount = 0;

  } else {
    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2 ONLY: Load world data from Supabase
    // ═══════════════════════════════════════════════════════════════════════
    console.log('═══ Loading world data from Supabase ═══\n');

    const { data: rows, error } = await supabase
      .from('world_market_data')
      .select('world_name, pvp_type, items');

    if (error) throw new Error('Supabase load failed: ' + error.message);

    for (const row of rows) {
      worldMarket[row.world_name] = row.items;
      worldPvp[row.world_name] = row.pvp_type;
    }

    console.log(`   Loaded ${rows.length} worlds from Supabase\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: Find profitable trades → fetch market_board for those items
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═══ PHASE 2: Market Board (offers detail) ═══\n');

  // Build price indexes per world: itemId → item data
  const worldIndex = {};
  for (const [name, items] of Object.entries(worldMarket)) {
    const idx = {};
    items.forEach(it => { idx[it.id] = it; });
    worldIndex[name] = idx;
  }

  // Find all unique (world, itemId) pairs needed for profitable trades
  // We need: sellers on start world + buyers on target world
  const neededPairs = new Set();  // "world:itemId"
  const worldNames = Object.keys(worldMarket);

  // Score each pair for prioritization (higher estimated profit → fetch first)
  const pairScores = {};  // "world:itemId" → estimated max profit

  console.log('🔎 Scanning all world pairs for profitable trades...');

  for (const startName of worldNames) {
    const startIdx = worldIndex[startName];
    const startPvp = worldPvp[startName];

    for (const targetName of worldNames) {
      if (targetName === startName) continue;
      if (!canTransfer(startName, startPvp, targetName, worldPvp[targetName])) continue;

      const targetIdx = worldIndex[targetName];

      for (const [itemIdStr, tItem] of Object.entries(targetIdx)) {
        if (!tItem.buy_offers || tItem.buy_offer <= 0) continue;

        const sItem = startIdx[itemIdStr];
        if (!sItem || sItem.sell_offer <= 0) continue;
        if (tItem.buy_offer <= sItem.sell_offer) continue;

        const margin = tItem.buy_offer - sItem.sell_offer;
        const qty = Math.min(tItem.buy_offers, Math.floor(1e9 / sItem.sell_offer)); // rough cap
        const estProfit = margin * qty;

        if (estProfit <= 500000) continue;  // skip low-value trades

        // Need sellers on start world
        const startKey = `${startName}:${itemIdStr}`;
        neededPairs.add(startKey);
        pairScores[startKey] = Math.max(pairScores[startKey] || 0, estProfit);

        // Need buyers on target world
        const targetKey = `${targetName}:${itemIdStr}`;
        neededPairs.add(targetKey);
        pairScores[targetKey] = Math.max(pairScores[targetKey] || 0, estProfit);
      }
    }
  }

  console.log(`   Found ${neededPairs.size} unique (world, item) pairs\n`);

  // Sort by estimated profit and cap
  const sortedPairs = [...neededPairs]
    .sort((a, b) => (pairScores[b] || 0) - (pairScores[a] || 0))
    .slice(0, MAX_BOARD_FETCHES);

  console.log(`   Fetching top ${sortedPairs.length} pairs (capped at ${MAX_BOARD_FETCHES})\n`);

  // Clear old item_offers before inserting new data
  const { error: deleteError } = await supabase
    .from('item_offers')
    .delete()
    .neq('world_name', '___never_matches___');  // delete all rows
  if (deleteError) console.log(`   ⚠️ Could not clear old item_offers: ${deleteError.message}`);

  // Fetch market_board and store
  let boardFetched = 0, boardFailed = 0;
  const BATCH_SIZE = 50;  // upsert in batches

  let batch = [];

  for (let i = 0; i < sortedPairs.length; i++) {
    const [worldName, itemId] = sortedPairs[i].split(':');
    const pctDone = ((i + 1) / sortedPairs.length * 100).toFixed(0);

    process.stdout.write(`[${i + 1}/${sortedPairs.length}] ${worldName} #${itemId} (${pctDone}%)... `);

    try {
      const url = `${MARKET_API}/market_board?server=${encodeURIComponent(worldName)}&item_id=${itemId}`;
      const data = await throttledFetch(url);

      const sellers = (data.sellers || []).map(s => ({
        price: s.price, amount: s.amount || 1
      }));
      const buyers = (data.buyers || []).map(b => ({
        price: b.price, amount: b.amount || 1
      }));

      batch.push({
        world_name: worldName,
        item_id: parseInt(itemId),
        sellers,
        buyers,
        scanned_at: new Date().toISOString(),
      });

      boardFetched++;
      console.log(`✅ ${sellers.length}S/${buyers.length}B`);

      // Flush batch
      if (batch.length >= BATCH_SIZE) {
        const { error } = await supabase
          .from('item_offers')
          .upsert(batch, { onConflict: 'world_name,item_id' });
        if (error) console.log(`  ⚠️ Batch upsert error: ${error.message}`);
        batch = [];
      }
    } catch (e) {
      boardFailed++;
      console.log(`❌ ${e.message}`);
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const { error } = await supabase
      .from('item_offers')
      .upsert(batch, { onConflict: 'world_name,item_id' });
    if (error) console.log(`  ⚠️ Final batch upsert error: ${error.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Phase 1: ${scanned}/${allWorlds.length} worlds scanned`);
  console.log(`Phase 2: ${boardFetched}/${sortedPairs.length} market_board fetched (${boardFailed} failed)`);
  console.log(`⏱️  Total time: ${totalTime} minutes`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
