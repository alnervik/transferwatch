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
node scanner.js --phase1 --force             # Phase 1, re-scan ALL worlds (ignore freshness skip)
node scanner.js --phase1 --force --skip=0 --take=95   # Phase 1 in 95-world batches (API caps ~100 req/run)
node scanner.js --phase2                     # Phase 2 only: fetch market board (reads phase 1 from Supabase)
node scanner.js --phase2 --skip=95 --take=95 # Phase 2 with pagination (used by CI batches)
node scanner.js --targeted --batch=1/2       # Targeted mode: verify specific trades (TARGETS_JSON env var)

node fetch_item_metadata.js                  # Refresh item_metadata.json cache from API

npm run export                               # Dump world_market_data → data/snapshot.json + patient_trades_report.md
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

2. **Phase 2** — Reads phase 1 data back from Supabase, identifies item/world pairs that pass profit thresholds, then fetches full order books (`market_board`) for those pairs and writes to `item_offers` (`world_name`, `item_id`, `sellers`, `buyers`, `scanned_at`). The `--skip=0` batch also purges `item_offers` rows older than `STALE_OFFERS_MS` (36h) so dead order books don't accumulate (the CI batches always run with `--take`, so a "full run only" wipe would never trigger there).

3. **Frontend** (`index.html`) — Vanilla JS dashboard that queries Supabase directly via its REST API, displays trade routes grouped by world, calculates profit after transfer cost (750 Tibia Coins), and lets users trigger targeted scans via the GitHub Actions API. A tab bar splits the UI into the **Arbitrage** view (everything above), an **Inköpslista** tab (see below) and a **Soul Cores** tab: a per-world summary of soul cores for sale (sell-offer counts/types from `world_market_data`, filterable by green/yellow Battleye, items identified via `category: "Soul Cores"` in `item_metadata.json`) that drills down into a single world's for-sale soul cores with current prices and expandable order books (cached `item_offers` or live market-API fetch). `item_offers` is fetched with Range-paginated requests (`fetchAllRows`, 1000 rows/page — PostgREST caps single responses at its Max Rows setting) and rows older than `OFFERS_MAX_AGE_MS` (36h) are dropped at load so stale boards can't render as ✓-verified.

### Inköpslista tab (`#tabBuylist` in `index.html`)
The reverse of the Arbitrage tab: instead of "where do I sell what I have", it answers "where do I buy a specific shopping list before transferring to *my* world". Pick several items (chips with per-item quantities, sharing the `#itemLookupList` datalist/index with the item lookup), a **target world** (where you transfer *to*), and a green/yellow **Battleye filter** on the candidate buy worlds. Every world that may transfer into the target (`canTransfer` — PvP tier + Battleye, so a yellow world never appears for a green target) is scored:

| Column | How it's computed |
|---|---|
| Korgkostnad | Per item: `buyLadderCost` up the real start-world seller ladder when an order book exists (resilient + thin-book fallback, same as everywhere else) — `✓ bok`; units the book can't cover are priced at the ladder average (`✓ n/m`), and with no book at all the `market_values` ask is used (`~est`). Items with no sell offer count into **Saknas**. |
| Transfer (750 TC) | `TRANSFER_COST_TC × buy world's TC bid` — the gold you give up by spending the coins there. A world with no TC bid of its own is priced off `medianTcBid()` (the median bid across all scanned worlds) and marked `~`, so it can't look like a free transfer and win the list by default. |
| Sämsta item | Multi-item only: the *worst* per-item price vs. the target world (`basket.worstDelta`), with all per-item deltas in the tooltip. A world can be a bargain on one item and daylight robbery on the next — the basket total hides that, this column doesn't. Sort **"Bra på ALLA items (maximin)"** ranks by it. **Kräv alla items** hides worlds missing anything on the list. |
| Instant profit | `instantTradesBetween()` — take-take trades buy-world → target world on the same trip, matched against real books (`matchWithFallback`) when both exist, otherwise a `market_values` estimate, greedily allocated by margin % over a separate **trade capital** input (default 5M gp; the basket and the trade capital are deliberately two different pockets). Capped at `BUY_MAX_TRADES` (10) trades from the `BUY_CAND_SCAN` (250) best-margin candidates, floored at `MIN_TRADE_PROFIT`. A `✓ täcker` / `n%` badge shows how much of the transfer cost the trades pay back. |
| Netto | `basket + transfer − instant profit`, the ranking key. `Ignorera transferkostnad` drops the transfer term. |
| Mot \<target\> | Net vs. the baseline row: buying the same basket on the target world itself, no transfer. Says whether the trip is worth it at all. |

Rows expand into a per-item purchase breakdown (each line vs. the target world's price, in % and gold) and the list of instant trades. `worldItemIndex()` caches `itemId → item` per world since the scan touches every world on each recompute. The summary cards and the "best" highlight always pick from worlds with a **complete** basket when any exist — a world that's cheap because it's missing half your list must not win.

**The TC translation.** Every gold figure carries the same amount converted to Tibia Coins underneath (`.tc-sub`), at the TC bid of the world where that gold is actually paid — basket and transfer on the buy world, instant profit on the target — because a gold sum means different things on different worlds (`goldToTC`, `tcRateNote` shows the rate each row used). In TC the transfer cost is exactly 750 on every world, and the two sides of the trip become addable: `netTC = basketTC + 750 − profitTC`. The gp and TC rankings can disagree, so **"Netto i TC"** is a separate sort and a note above the table names both winners when they differ. Per-item deltas carry the TC-adjusted % as a sub-line for the same reason.

### Auth Gate
The dashboard is gated behind a Supabase Auth (GoTrue) login (`#authGate` in `index.html`). The app stays hidden until a valid session exists; sign-in posts to `/auth/v1/token?grant_type=password`, the session is cached in `localStorage` under `tw_session`, and `authHeaders()` swaps the user's `access_token` in as the `Bearer` for all Supabase REST calls (anon key stays as `apikey`). `ensureFreshSession()` refreshes expired tokens before each data load. RLS (`supabase_setup.sql`) only grants `SELECT` to the `authenticated` role, so the public anon key alone can't read the data — hiding the UI isn't enough on its own. Accounts are added manually in the Supabase dashboard (signups disabled); there is no self-registration.

### Transfer Eligibility Rules (`canTransfer` in scanner.js)
- Transfers can only go to an equal or lower PvP tier (Optional → Open → Retro Open → Retro Hardcore).
- Yellow Battleye servers cannot transfer to Green Battleye servers. `GREEN_BE` in scanner.js contains the full list.

### Trade Strategies (`scanner/strategies.js`)
TransferWatch models four strategies per item/world pair, distinguished by whether you **take** an existing market offer or **make** (place) your own and wait for it to fill (`ask` = `sell_offer`, `bid` = `buy_offer`):

| Strategy | Buy on start | Sell on target | Margin | Wait | Active |
|---|---|---|---|---|---|
| **take-take** (instant) | take ask | take bid | `bid(t) − ask(s)` (narrowest) | none | ✅ |
| **take-make** | take ask | place sell offer | `≈ ask(t) − ask(s)` | sell side | ✅ |
| **make-take** | place buy offer | take bid | `≈ bid(t) − bid(s)` | buy side | ❌ |
| **make-make** | place buy offer | place sell offer | `≈ ask(t) − bid(s)` (widest) | both | ❌ |

Only the **take-buy** strategies are active (`ACTIVE_STRATEGIES` in `strategies.js`). The make-buy strategies (`make-take`, `make-make`) were disabled: a placed buy offer assumes a lowball bid that may never fill, producing false-positive "trades" that never let you acquire the item. The buy side is therefore always a real take; only the sell side stays patient.

"make" sides don't fill instantly; `strategies.js` estimates fill time (`etaDays`) from each world's flow (`day_bought`/`month_bought` fills your sell offer, `day_sold`/`month_sold` would fill a buy offer — monthly volume ÷ 30 is preferred as more stable) diluted by competing offer counts, bounded by `HORIZON_DAYS`. **Sell-price realism:** a make-sell is re-priced to `min(current ask, month_average_sell × SELL_PREMIUM)` so an inflated lone ask (e.g. avg 500k, ask 1M) collapses to a realistic price instead of fantasy profit; `MAX_SELL_OVER_BID` is a fallback bid-ratio guard for data scanned before the average fields existed. `trimItems` (`scanner.js`) captures `month_average_sell/buy` and `month_sold/bought` from the API for this. `bestStrategy()` picks the highest-`estProfit` strategy with `etaDays ≤ maxEtaDays`. These constants are first-pass and meant to be calibrated against a real snapshot (`npm run export`). `scanner.js` and `export_snapshot.js` import this module; `index.html` carries an inline port.

### Profit Thresholds
Scanner Phase 2 candidate selection (`scanner.js`) ranks pairs by the best strategy's estimated profit, feasibility-gated by `MAX_ETA_DAYS` (14):
| Condition | Margin | Est. Profit |
|---|---|---|
| Default | ≥10% | ≥150k gold |
| Fast-selling (≥10/day on target) | ≥6% | ≥100k gold |
| Pinned items (Gold Token 22721, Silver Token 22516) | always included | — |

Frontend (`index.html`) has a **strategy mode** selector:
- **Instant (take-take)** — original behaviour: scores trades with **resilient profit** (`matchResilient`), the profit that survives if the single cheapest seller offer disappears. Trades backed by a genuine order book keep their value; single-offer "stale lowball" mirages collapse to ~0 and get filtered. Used in both the per-world view and the "Top 5 routes" leaderboard so they agree, and lets the flat floor stay low (25k gross, 15k in per-world deep-search mode; leaderboard per-item floor 15k) while still surfacing only genuine trades.
  - **Thin-book fallback** (`matchWithFallback`, mirrored in `buyLadderCost`): dropping the cheapest ask deleted real trades on expensive items, where the book is inherently thin — above 10M gp the median item has *one* sell offer, so `slice(1)` emptied the ladder and the trade was filtered out at 0 profit. When the resilient match zeroes a trade, the full book is used instead **if the cheapest ask passes a lowball test** (`price ≥ LOWBALL_RATIO × month_average_sell`, 0.7). Measured over a full snapshot, only 0.4% of asks above 10M sit below 0.7× the monthly average versus 24% below 100k — mirages are a cheap-item phenomenon, so the resilient rule still governs there unchanged. Rescued trades stay verified against real order data but carry `thinBook` and render a `✓ tunn` badge, since the whole trade rests on one offer. Without `month_average_sell` (data scanned before the field existed) the cautious original behaviour applies.
- **Patient (offers)** — computes the best of all four strategies from `market_values` alone (no order book fetch). Trades show a strategy badge, a 📌 marker on the make side(s), and an ETA (reusing the speed badge / "Max väntetid" filter). The leaderboard stays take-take only. The buy side is verified against the real start book via `buyLadderCost`; the make-sell stays an estimate.

### Verification state (`bookState`)
Every trade carries `bookState`, which is what the ⚡ "Verifiera alla" button actually drives. `verified` alone conflated two different things and made the button's promise unreachable:
| State | Meaning | Badge | Counted in world net? |
|---|---|---|---|
| `none` | no order book fetched for the pair yet | `~est` | yes (it's an estimate, nothing contradicts it) |
| `ok` | the book confirms a profitable buy | `✓` / `✓ tunn` | yes, re-priced off the real ladder |
| `refuted` | the book **is** fetched and does not support the estimate | `⚠ ej i boken` | **no** — row stays visible, dimmed, numbers shown as estimate |

The world header shows **Kollade mot bok `checked/total`** (= `ok` + `refuted`), which reaches N/N when a targeted run succeeds, with a `✓ n bekräftade · ⚠ n motsagda` sub-line. Refuted trades are skipped by the budget allocation so they can't crowd out real trades, and are excluded from `totalGross`/`netProfit`.

**`ladderCost` price cap.** `buyLadderCost`/`ladderCost` take a `maxPrice` (the sell price) and stop at the first ask at or above it — the same rule `matchOffers` has always applied via its `margin <= 0` break. Without it the ladder climbed past the sell price to fill `wantQty`, the average was dragged over `sell_price`, and the caller rejected the *whole* trade on `ladMargin <= 0` instead of buying the units that are actually profitable. That was the real cause of "Verifiera alla gör inte alla": the run fetched every book successfully, the ladder then refused to verify any trade whose second-cheapest ask sat above the sell price (common on expensive items and thin margins), and the trade stayed `~est` with its single-ask fantasy profit — identically, every re-run. Note the thin-book fallback did not cover this: it only triggers when the resilient ladder comes back *empty*, not when it comes back *unprofitable*.

The budget reserves the 750 TC transfer cost before computing spendable gold. Spendable TC that the budget allocation never converts to purchases is credited as a **TC-bonus** when the target world's TC bid beats the start world's — you only liquidate the TC you need on the start world and sell the surplus after the transfer. The bonus (`tcSellBonus`) is added to each route's net profit in both the per-world view and the leaderboard, and shown on the world's transfer-cost line.

### CI / GitHub Actions (`.github/workflows/`)
- `scan.yml` — Runs daily at 01:54 UTC. Phase 1 runs as a 2-batch matrix (`--skip`/`--take`, 95 worlds each — each scanned world ≈ 1 request and the API throttles around ~100 req/run), then Phase 2 runs a 15-batch matrix (`--skip`/`--take` pagination, 95 each = 1425 pairs) with `max-parallel: 5` to cap concurrent load on the market API. Phase 1's `--force` flag bypasses the freshness skip to re-scan every world (needed after adding fields to `trimItems`).
- `scan-phase2.yml` — Manual Phase 2 re-run; same 15-batch matrix (max 5 parallel).
- `scan-targeted.yml` — Manual targeted verification; splits `TARGETS_JSON` across 8 batch runners (~12 pairs each, ~2 min per runner). Triggered by the frontend "Verifiera alla" button via the GitHub API.

### Key Files
- `scanner/scanner.js` — All scanning logic (~600 lines). Constants at top control thresholds and rate limiting (`REQUEST_PAUSE = 12s`).
- `scanner/strategies.js` — Shared 4-strategy evaluation + ETA/feasibility model (imported by scanner + export).
- `scanner/export_snapshot.js` — Dumps `world_market_data` to `scanner/data/snapshot.json` and writes a ranked `patient_trades_report.md`. Run with `npm run export`.
- `index.html` — Entire frontend in one file (HTML + CSS + JS).
- `supabase_setup.sql` — Database schema and RLS policy setup. Run once to initialize.
- `item_metadata.json` — Cached item catalog (~3.6 MB). Regenerate with `fetch_item_metadata.js`.
