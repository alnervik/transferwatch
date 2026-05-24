# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TransferWatch is a Tibia market arbitrage scanner. It monitors item prices across game servers ("worlds") and finds profitable transfer routes — buy low on one world, sell high on another.

## Commands

### Scanner (Node.js)
```bash
cd scanner
npm install

node scanner.js                              # Both phases
node scanner.js --phase1                     # Phase 1 only: fetch market values → Supabase
node scanner.js --phase2                     # Phase 2 only: fetch market board (reads phase 1 from Supabase)
node scanner.js --phase2 --skip=85 --take=85 # Phase 2 with pagination (used by CI batches)
node scanner.js --targeted --batch=1/2       # Targeted mode: verify specific trades (TARGETS_JSON env var)

node fetch_item_metadata.js                  # Refresh item_metadata.json cache from API
```

No test runner or linter is configured.

### Environment
Copy `scanner/.env.example` to `scanner/.env` and fill in:
```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGci...
```

## Architecture

### Data Flow

1. **Phase 1** — `scanner.js` fetches `market_values` from `api.tibiamarket.top` for all ~140 transferable Tibia worlds and writes results to the `world_market_data` Supabase table (`world_name` PK, `pvp_type`, `items` JSONB, `scanned_at`).

2. **Phase 2** — Reads phase 1 data back from Supabase, identifies item/world pairs that pass profit thresholds, then fetches full order books (`market_board`) for those pairs and writes to `item_offers` (`world_name`, `item_id`, `sellers`, `buyers`, `scanned_at`).

3. **Frontend** (`index.html`) — Vanilla JS dashboard that queries Supabase directly via its REST API, displays trade routes grouped by world, calculates profit after transfer cost (750 Tibia Coins), and lets users trigger targeted scans via the GitHub Actions API.

### Transfer Eligibility Rules (`canTransfer` in scanner.js)
- Transfers can only go to an equal or lower PvP tier (Optional → Open → Retro Open → Retro Hardcore).
- Yellow Battleye servers cannot transfer to Green Battleye servers. `GREEN_BE` in scanner.js contains the full list.

### Profit Thresholds
Scanner Phase 2 candidate selection (`scanner.js`):
| Condition | Margin | Est. Profit |
|---|---|---|
| Default | ≥10% | ≥150k gold |
| Fast-selling (≥10/day on target) | ≥6% | ≥100k gold |
| Pinned items (Gold Token 22721, Silver Token 22516) | always included | — |

Frontend (`index.html`) hides individual trades below a flat 100k gross profit floor (50k in per-world deep-search mode). The budget reserves the 750 TC transfer cost before computing spendable gold.

### CI / GitHub Actions (`.github/workflows/`)
- `scan.yml` — Runs daily at 01:54 UTC. Phase 1 runs first, then Phase 2 runs a 15-batch matrix (`--skip`/`--take` pagination, 95 each = 1425 pairs) with `max-parallel: 5` to cap concurrent load on the market API.
- `scan-phase2.yml` — Manual Phase 2 re-run; same 15-batch matrix (max 5 parallel).
- `scan-targeted.yml` — Manual targeted verification; splits `TARGETS_JSON` across 2 batch runners. Triggered by the frontend "Verify" button via the GitHub API.

### Key Files
- `scanner/scanner.js` — All scanning logic (~600 lines). Constants at top control thresholds and rate limiting (`REQUEST_PAUSE = 12s`).
- `index.html` — Entire frontend in one file (HTML + CSS + JS).
- `supabase_setup.sql` — Database schema and RLS policy setup. Run once to initialize.
- `item_metadata.json` — Cached item catalog (~3.6 MB). Regenerate with `fetch_item_metadata.js`.
