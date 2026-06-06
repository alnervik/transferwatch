// TransferWatch — snapshot export + patient-trades report
//
// Pulls world_market_data from Supabase, writes a compact JSON snapshot, and
// computes a ranked report of the best offer-based ("patient") trades across
// every transfer-eligible world pair using the shared strategies.js model.
//
// Usage:
//   cd scanner && npm install && npm run export
// Requires SUPABASE_URL / SUPABASE_SERVICE_KEY (scanner/.env).
//
// Outputs:
//   scanner/data/snapshot.json             — raw market_values snapshot (commit this)
//   scanner/data/patient_trades_report.md  — top trades, human-readable

import { createClient } from '@supabase/supabase-js';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { bestStrategy, STRATEGY_LABELS } from './strategies.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const MAX_ETA_DAYS = 14;
const TOP_N = 150;

// ─── Transfer rules (kept in sync with scanner.js) ─────────────────────────
const PVP_RANK = { 'Optional PvP': 0, 'Open PvP': 1, 'Retro Open PvP': 2, 'Retro Hardcore PvP': 3 };
const GREEN_BE = new Set([
  'Aethera','Blumera','Bravoria','Cantabra','Citra','Collabra','Descubra','Dia','Dracobra',
  'Eclipta','Escura','Etebra','Gladibra','Honbra','Hostera','Idyllia','Ignitera','Issobra',
  'Jadebra','Kalanta','Kalimera','Karmeya','Luzibra','Monstera','Mystera','Nevia','Noctalia',
  'Ombra','Ourobra','Penumbra','Quidera','Rasteibra','Retalia','Sombra','Sonira','Stralis',
  'Tempestera','Terribra','Tornabra','Unebra','Ustebra','Venebra','Victoris','Xyla','Xymera',
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

function loadItemNames() {
  const names = {};
  try {
    const arr = JSON.parse(readFileSync('../item_metadata.json', 'utf8'));
    for (const it of arr) names[it.id] = it.wiki_name || it.name || ('#' + it.id);
  } catch (e) {
    console.log('(item_metadata.json not loaded, using raw ids)');
  }
  return names;
}

async function main() {
  const { data, error } = await supabase
    .from('world_market_data')
    .select('world_name,pvp_type,items,scanned_at');
  if (error) { console.error('Supabase error:', error.message); process.exit(1); }

  // Compact snapshot: keep only items with a bid or an ask.
  const worlds = (data || []).map(w => ({
    world_name: w.world_name,
    pvp_type: w.pvp_type,
    scanned_at: w.scanned_at,
    items: (w.items || []).filter(it => it.buy_offer > 0 || it.sell_offer > 0),
  }));

  mkdirSync('data', { recursive: true });
  writeFileSync('data/snapshot.json',
    JSON.stringify({ exported_at: new Date().toISOString(), worlds }));
  console.log(`Wrote data/snapshot.json (${worlds.length} worlds)`);

  // Index per world for O(1) item lookup.
  const idx = {};
  for (const w of worlds) {
    const m = {};
    for (const it of w.items) m[it.id] = it;
    idx[w.world_name] = { pvp: w.pvp_type, items: m };
  }
  const names = Object.keys(idx);
  const itemNames = loadItemNames();

  const trades = [];
  for (const s of names) {
    for (const t of names) {
      if (s === t) continue;
      if (!canTransfer(s, idx[s].pvp, t, idx[t].pvp)) continue;
      for (const [id, tItem] of Object.entries(idx[t].items)) {
        const sItem = idx[s].items[id];
        if (!sItem) continue;
        const best = bestStrategy(sItem, tItem, { maxEtaDays: MAX_ETA_DAYS });
        if (!best) continue;
        trades.push({ start: s, target: t, item_id: Number(id), ...best });
      }
    }
  }
  trades.sort((a, b) => b.estProfit - a.estProfit);
  const top = trades.slice(0, TOP_N);

  // Strategy mix (how many feasible trades each strategy contributes overall).
  const mix = {};
  for (const tr of trades) mix[tr.type] = (mix[tr.type] || 0) + 1;

  let md = `# Patient trades report\n\n`;
  md += `Exported ${new Date().toISOString()} · ${names.length} worlds · `;
  md += `${trades.length} feasible trades (maxEta ${MAX_ETA_DAYS}d)\n\n`;
  md += `Strategy mix: ` + Object.entries(mix).map(([k, v]) => `${STRATEGY_LABELS[k]} ${v}`).join(' · ') + `\n\n`;
  md += `| # | Strategy | Start → Target | Item | Buy | Sell | Margin% | Qty | ETA(d) | Est. profit |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|\n`;
  top.forEach((r, i) => {
    const name = itemNames[r.item_id] || ('#' + r.item_id);
    const eta = isFinite(r.etaDays) ? r.etaDays.toFixed(1) : '∞';
    md += `| ${i + 1} | ${STRATEGY_LABELS[r.type]} | ${r.start} → ${r.target} | ${name} | `;
    md += `${r.buyPrice.toLocaleString('en-US')} | ${r.sellPrice.toLocaleString('en-US')} | `;
    md += `${r.marginPct.toFixed(1)} | ${r.qtyCap} | ${eta} | ${Math.round(r.estProfit).toLocaleString('en-US')} |\n`;
  });
  writeFileSync('data/patient_trades_report.md', md);
  console.log(`Wrote data/patient_trades_report.md (top ${top.length} of ${trades.length})`);
  console.log('Strategy mix:', mix);
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
