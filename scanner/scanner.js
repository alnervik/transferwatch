// TransferWatch Scanner
// Phase 1: Fetch market_values for all worlds → Supabase
// Phase 2: Fetch market_board for profitable trades → Supabase
//
// Usage:
//   node scanner.js                           # Both phases
//   node scanner.js --phase1                  # Only phase 1
//   node scanner.js --phase2                  # Only phase 2 (reads phase 1 from Supabase)
//   node scanner.js --phase2 --skip=85 --take=85   # Phase 2, skip 85, fetch next 85
//   node scanner.js --targeted --batch=1/2    # Targeted: kör TARGETS_JSON, batch 1 av 2

import { createClient } from '@supabase/supabase-js';

// ─── CONFIG ────────────────────────────────────────────────────────────────
const MARKET_API = 'https://api.tibiamarket.top:8001';
const TIBIADATA_API = 'https://api.tibiadata.com/v4';
const PAGE_LIMIT = 5000;
const MAX_RETRIES = 5;
const MAX_BOARD_FETCHES = 850;  // 10 batches × 85
const MIN_MARGIN_PCT = 20;  // min % margin för att räknas som scan-kandidat
const MIN_EST_PROFIT = 800_000;  // min top-of-book estimate per par. Höjd för att kompensera för att verklig profit (matchOffers i UI) typiskt är 30-70% av estimate — målet är att Phase 2-slots går till par som faktiskt når ~400k verklig bruttovinst.
const WORLD_FRESH_THRESHOLD_MS = 0;  // 0 = skippa skan om tibiamarkets last_update <= vår scanned_at

const TC_ITEM_ID = 22118;
const TRANSFER_COST_TC = 750;

// Items always included in scan regardless of margin/profit thresholds
const PINNED_ITEM_IDS = new Set([22721, 22516]); // Gold Token, Silver Token

// Rate limiter: 1 request → 12s pause → repeat (safe, no 429s)
const REQUEST_PAUSE = 12000;

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
  'Tempestera','Terribra','Tornabra','Unebra','Ustebra','Venebra','Victoris','Xyla','Xymera'
  'Xybra','Yovera','Yubra'
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

let requestCount = 0;

async function throttledFetch(url) {
  // Pause before every request (except the first)
  if (requestCount > 0) {
    await sleep(REQUEST_PAUSE);
  }
  requestCount++;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
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
      console.log(`  ⚠️ Error: ${e.message}, retry in ${backoff / 1000}s`);
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

// ─── PARSE FLAGS ───────────────────────────────────────────────────────────
function getFlag(name) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : null;
}

const PHASE1_ONLY = process.argv.includes('--phase1');
const PHASE2_ONLY = process.argv.includes('--phase2');
const TARGETED_MODE = process.argv.includes('--targeted');
const SKIP_COUNT = parseInt(getFlag('skip') || '0');
const TAKE_COUNT = parseInt(getFlag('take') || '0');  // 0 = take all remaining
const BATCH_FLAG = getFlag('batch');  // "1/2" eller "2/2" (endast targeted mode)

// ─── TARGETED MODE ─────────────────────────────────────────────────────────
// Tar en JSON-lista i env TARGETS_JSON: [{start, target, item_id}, ...]
// Dedupar till unika (world, item_id) och splittar modulo batch/total.
async function runTargeted() {
  const startTime = Date.now();
  console.log('🎯 TransferWatch Scanner — Targeted mode');

  const raw = process.env.TARGETS_JSON;
  if (!raw) {
    console.error('Saknar TARGETS_JSON env var');
    process.exit(1);
  }

  let triplets;
  try {
    triplets = JSON.parse(raw);
    if (!Array.isArray(triplets)) throw new Error('inte en array');
  } catch (e) {
    console.error('Ogiltig TARGETS_JSON:', e.message);
    process.exit(1);
  }

  // Dedupa till unika world:item_id-par
  const uniqueSet = new Set();
  for (const t of triplets) {
    if (!t || !t.start || !t.target || !t.item_id) continue;
    uniqueSet.add(`${t.start}:${t.item_id}`);
    uniqueSet.add(`${t.target}:${t.item_id}`);
  }
  const allPairs = [...uniqueSet].sort();  // deterministisk ordning över runners

  // Splitta modulo batch
  let batchIdx = 0, batchTotal = 1;
  if (BATCH_FLAG) {
    const m = BATCH_FLAG.match(/^(\d+)\/(\d+)$/);
    if (!m) {
      console.error('Ogiltig --batch=N/M:', BATCH_FLAG);
      process.exit(1);
    }
    batchIdx = parseInt(m[1]) - 1;  // 1-based → 0-based
    batchTotal = parseInt(m[2]);
  }
  const myPairs = allPairs.filter((_, i) => i % batchTotal === batchIdx);

  console.log(`   Triplets input: ${triplets.length}`);
  console.log(`   Unika par totalt: ${allPairs.length}`);
  console.log(`   Batch: ${batchIdx + 1}/${batchTotal} → ${myPairs.length} par\n`);

  let fetched = 0, failed = 0;
  let batch = [];

  for (let i = 0; i < myPairs.length; i++) {
    const [worldName, itemIdStr] = myPairs[i].split(':');
    process.stdout.write(`[${i + 1}/${myPairs.length}] ${worldName} #${itemIdStr}... `);

    try {
      const url = `${MARKET_API}/market_board?server=${encodeURIComponent(worldName)}&item_id=${itemIdStr}`;
      const data = await throttledFetch(url);

      batch.push({
        world_name: worldName,
        item_id: parseInt(itemIdStr),
        sellers: (data.sellers || []).map(s => ({ price: s.price, amount: s.amount || 1 })),
        buyers:  (data.buyers  || []).map(b => ({ price: b.price, amount: b.amount || 1 })),
        scanned_at: new Date().toISOString(),
      });
      fetched++;
      const s = batch[batch.length - 1].sellers.length;
      const b = batch[batch.length - 1].buyers.length;
      console.log(`✅ ${s}S/${b}B`);

      if (batch.length >= 20) {
        const { error } = await supabase
          .from('item_offers')
          .upsert(batch, { onConflict: 'world_name,item_id' });
        if (error) console.log(`  ⚠️ Batch error: ${error.message}`);
        batch = [];
      }
    } catch (e) {
      failed++;
      console.log(`❌ ${e.message}`);
    }
  }

  if (batch.length > 0) {
    const { error } = await supabase
      .from('item_offers')
      .upsert(batch, { onConflict: 'world_name,item_id' });
    if (error) console.log(`  ⚠️ Final batch error: ${error.message}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Fetched: ${fetched} | ❌ Failed: ${failed} | ⏱️ ${elapsed} min`);
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  if (TARGETED_MODE) {
    await runTargeted();
    return;
  }

  const startTime = Date.now();
  console.log('🔍 TransferWatch Scanner');
  if (PHASE1_ONLY) console.log('   Mode: Phase 1 only');
  else if (PHASE2_ONLY) console.log('   Mode: Phase 2 only (data from Supabase)');
  else console.log('   Mode: Full scan (phase 1 + 2)');
  if (SKIP_COUNT > 0) console.log(`   Skip: ${SKIP_COUNT}`);
  if (TAKE_COUNT > 0) console.log(`   Take: ${TAKE_COUNT}`);
  console.log('');

  const worldMarket = {};
  const worldPvp = {};

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1
  // ═══════════════════════════════════════════════════════════════════════
  if (!PHASE2_ONLY) {
    console.log('═══ PHASE 1: Market Values ═══\n');

    const worldResponse = await fetch(`${TIBIADATA_API}/worlds`).then(r => r.json());
    const allWorlds = (worldResponse.worlds.regular_worlds || [])
      .filter(w => w.transfer_type === 'regular');
    console.log(`📡 ${allWorlds.length} transferable worlds\n`);

    // Hämta last_update per world från tibiamarket (för att kunna skippa färska worlds)
    const lastUpdateByWorld = {};
    try {
      const worldMeta = await fetch(`${MARKET_API}/world_data`).then(r => r.json());
      if (Array.isArray(worldMeta)) {
        for (const w of worldMeta) {
          if (w && w.name && w.last_update) {
            lastUpdateByWorld[w.name] = new Date(w.last_update).getTime();
          }
        }
        console.log(`📡 ${Object.keys(lastUpdateByWorld).length} worlds med last_update\n`);
      } else {
        console.log('⚠️  tibiamarket /worlds returnerade oväntat format — skip-logik inaktiv\n');
      }
    } catch (e) {
      console.log(`⚠️  Kunde ej hämta tibiamarket /worlds (${e.message}) — skip-logik inaktiv\n`);
    }

    // Hämta befintlig scanned_at per world
    const { data: existingRows } = await supabase
      .from('world_market_data')
      .select('world_name, scanned_at, items');
    const existingByWorld = {};
    for (const r of existingRows || []) existingByWorld[r.world_name] = r;

    let scanned = 0, failed = 0, skipped = 0;

    for (const world of allWorlds) {
      const idx = scanned + failed + skipped + 1;

      // Skip om tibiamarkets data inte uppdaterats sedan vår senaste scan
      const prev = existingByWorld[world.name];
      const lastUpdate = lastUpdateByWorld[world.name];
      if (prev && lastUpdate) {
        const prevMs = new Date(prev.scanned_at).getTime();
        if (lastUpdate - WORLD_FRESH_THRESHOLD_MS <= prevMs) {
          worldMarket[world.name] = prev.items;
          worldPvp[world.name] = world.pvp_type;
          skipped++;
          console.log(`[${idx}/${allWorlds.length}] ${world.name}... ⏭️  fresh (last_update ${new Date(lastUpdate).toISOString()})`);
          continue;
        }
      }

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

    console.log(`\nPhase 1 done: ${scanned} scanned, ${skipped} skipped (fresh), ${failed} failed / ${allWorlds.length} worlds\n`);

    if (PHASE1_ONLY) {
      const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`⏱️  ${elapsed} min — run --phase2 to fetch offers`);
      return;
    }

    // Reset request counter between phases
    requestCount = 0;

  } else {
    // Load from Supabase — fetch world list first, then items per world
    // (loading all at once can timeout on free tier)
    console.log('═══ Loading world data from Supabase ═══\n');

    const { data: worldList, error: listErr } = await supabase
      .from('world_market_data')
      .select('world_name, pvp_type');
    if (listErr) throw new Error('Supabase: ' + listErr.message);

    console.log(`   ${worldList.length} worlds found, loading items...`);

    for (const w of worldList) {
      const { data: row, error: rowErr } = await supabase
        .from('world_market_data')
        .select('items')
        .eq('world_name', w.world_name)
        .single();

      if (rowErr) {
        console.log(`   ⚠️ ${w.world_name}: ${rowErr.message}`);
        continue;
      }
      worldMarket[w.world_name] = row.items;
      worldPvp[w.world_name] = w.pvp_type;
    }

    console.log(`✅ ${Object.keys(worldMarket).length} worlds loaded\n`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: Find profitable trades → fetch market_board
  // ═══════════════════════════════════════════════════════════════════════
  console.log('═══ PHASE 2: Market Board ═══\n');

  // Build indexes
  const worldIndex = {};
  for (const [name, items] of Object.entries(worldMarket)) {
    const idx = {};
    items.forEach(it => { idx[it.id] = it; });
    worldIndex[name] = idx;
  }

  // Find profitable pairs
  const neededPairs = new Set();
  const pairScores = {};
  const worldNames = Object.keys(worldMarket);

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
        const marginPct = (margin / sItem.sell_offer) * 100;
        const pinned = PINNED_ITEM_IDS.has(Number(itemIdStr));
        if (!pinned && marginPct < MIN_MARGIN_PCT) continue;
        const qty = Math.min(tItem.buy_offers, Math.floor(1e9 / sItem.sell_offer));
        const estProfit = margin * qty;
        if (!pinned && estProfit < MIN_EST_PROFIT) continue;

        const startKey = `${startName}:${itemIdStr}`;
        neededPairs.add(startKey);
        pairScores[startKey] = Math.max(pairScores[startKey] || 0, estProfit);

        const targetKey = `${targetName}:${itemIdStr}`;
        neededPairs.add(targetKey);
        pairScores[targetKey] = Math.max(pairScores[targetKey] || 0, estProfit);
      }
    }
  }

  // Sort by profit, apply skip/take
  const allSorted = [...neededPairs]
    .sort((a, b) => (pairScores[b] || 0) - (pairScores[a] || 0))
    .slice(0, MAX_BOARD_FETCHES);

  const endIdx = TAKE_COUNT > 0 ? Math.min(SKIP_COUNT + TAKE_COUNT, allSorted.length) : allSorted.length;
  const myPairs = allSorted.slice(SKIP_COUNT, endIdx);

  console.log(`Total pairs: ${neededPairs.size} → top ${allSorted.length}`);
  console.log(`This batch: #${SKIP_COUNT + 1} to #${SKIP_COUNT + myPairs.length} (${myPairs.length} pairs)\n`);

  // Only clear old data on full fresh run
  if (SKIP_COUNT === 0 && !TAKE_COUNT) {
    const { error: delErr } = await supabase
      .from('item_offers')
      .delete()
      .neq('world_name', '___never___');
    if (delErr) console.log(`⚠️ Clear error: ${delErr.message}`);
  }

  // Fetch and store
  let fetched = 0, failed = 0;
  let batch = [];

  for (let i = 0; i < myPairs.length; i++) {
    const [worldName, itemId] = myPairs[i].split(':');
    const globalIdx = SKIP_COUNT + i + 1;

    process.stdout.write(`[${globalIdx}/${allSorted.length}] ${worldName} #${itemId}... `);

    try {
      const url = `${MARKET_API}/market_board?server=${encodeURIComponent(worldName)}&item_id=${itemId}`;
      const data = await throttledFetch(url);

      batch.push({
        world_name: worldName,
        item_id: parseInt(itemId),
        sellers: (data.sellers || []).map(s => ({ price: s.price, amount: s.amount || 1 })),
        buyers:  (data.buyers  || []).map(b => ({ price: b.price, amount: b.amount || 1 })),
        scanned_at: new Date().toISOString(),
      });
      fetched++;
      const s = batch[batch.length - 1].sellers.length;
      const b = batch[batch.length - 1].buyers.length;
      console.log(`✅ ${s}S/${b}B`);

      if (batch.length >= 50) {
        const { error } = await supabase
          .from('item_offers')
          .upsert(batch, { onConflict: 'world_name,item_id' });
        if (error) console.log(`  ⚠️ Batch error: ${error.message}`);
        batch = [];
      }
    } catch (e) {
      failed++;
      console.log(`❌ ${e.message}`);
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const { error } = await supabase
      .from('item_offers')
      .upsert(batch, { onConflict: 'world_name,item_id' });
    if (error) console.log(`  ⚠️ Final batch error: ${error.message}`);
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Fetched: ${fetched} | ❌ Failed: ${failed} | ⏱️ ${elapsed} min`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
