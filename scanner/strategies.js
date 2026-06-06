// TransferWatch — shared trade-strategy evaluation
// Used by scanner.js (Phase 2 candidate selection) and export_snapshot.js.
// The frontend (index.html) carries an inline port of these same functions.
//
// Four strategies, distinguished by whether you TAKE an existing market offer
// or MAKE your own (and wait for it to fill). With
//   ask = sell_offer (lowest seller)   bid = buy_offer (highest buyer):
//
//   take-take : buy at ask(start),  sell at bid(target)   margin = bid(t) - ask(s)   (narrowest, instant)
//   make-take : buy offer on start, sell at bid(target)   margin = bid(t) - bid(s)
//   take-make : buy at ask(start),  sell offer on target  margin = ask(t) - ask(s)
//   make-make : offers on both ends                        margin = ask(t) - bid(s)   (widest, slowest)
//
// "make" sides do not fill instantly. We estimate fill time from each world's
// daily flow (day_sold = units sold INTO buy offers → fills your buy offer;
// day_bought = units bought FROM sell offers → fills your sell offer), diluted
// by competing offers already on the book. HORIZON_DAYS bounds how long we are
// willing to queue, which in turn bounds both the realistic quantity and ETA.
//
// HORIZON_DAYS / COMP_WEIGHT are first-pass values meant to be calibrated
// against a real snapshot (npm run export → data/patient_trades_report.md).

const HORIZON_DAYS = 7;   // planning window for "make" offers; bounds qty & ETA
const COMP_WEIGHT  = 1;   // how strongly each competing offer dilutes your flow share

// Sell-price realism. A "make" sell offer only fills near what items actually
// transact for. The API's month_average_sell is the real anchor: we re-price a
// patient sell to min(current ask, month_average_sell × SELL_PREMIUM) so an
// inflated lone ask (e.g. avg 500k, sell offer 1M) collapses to a realistic
// ~550k rather than showing fantasy profit. SELL_PREMIUM is the mild patient
// premium you can list above the rolling average and still expect to fill.
// MAX_SELL_OVER_BID is the fallback guard for items scanned before the average
// fields existed (bid = what buyers pay right now).
const SELL_PREMIUM = 1.10;
const MAX_SELL_OVER_BID = 1.7;

// Prefer the stable monthly average flow (month volume / 30) over a single
// noisy day; fall back to the day value when monthly data is absent.
function perDay(monthVal, dayVal) {
  return monthVal > 0 ? monthVal / 30 : (dayVal || 0);
}

// Which (type, buySide, sellSide) strategies to evaluate. The buy side is
// always "take": placing a buy offer (make-buy, i.e. make-take / make-make)
// assumes a lowball bid that may never fill — the source of false-positive
// "trades" that never actually let you acquire the item. We keep only the
// strategies where you genuinely own the item (take-buy) and optionally stay
// patient on the sell side. Re-add a row here to bring make-buy back.
const ACTIVE_STRATEGIES = [
  ['take-take', 'take', 'take'],
  ['take-make', 'take', 'make'],
];

export const STRATEGY_LABELS = {
  'take-take': 'Take-Take',
  'make-take': 'Make-Take',
  'take-make': 'Take-Make',
  'make-make': 'Make-Make',
};

// Units/day you can realistically capture on a "make" side, after competition.
function makeFlow(dailyFlow, competingOffers) {
  return (dailyFlow || 0) / (1 + COMP_WEIGHT * (competingOffers || 0));
}

function evalOne(type, buySide, sellSide, sItem, tItem, opts) {
  const buyPrice = buySide === 'make' ? sItem.buy_offer : sItem.sell_offer;
  let sellPrice  = sellSide === 'make' ? tItem.sell_offer : tItem.buy_offer;
  if (!(buyPrice > 0) || !(sellPrice > 0)) return null;

  // Sell-realism (make-sell only): re-price to a level you can actually fill.
  if (sellSide === 'make') {
    const premium = opts && opts.sellPremium != null ? opts.sellPremium : SELL_PREMIUM;
    const avgSell = tItem.month_average_sell || tItem.day_average_sell || 0;
    if (avgSell > 0) {
      sellPrice = Math.min(sellPrice, Math.round(avgSell * premium));
    } else {
      // Fallback for pre-upgrade data with no average: hard bid-ratio guard.
      const maxOverBid = opts && opts.maxSellOverBid != null ? opts.maxSellOverBid : MAX_SELL_OVER_BID;
      if (maxOverBid > 0 && tItem.buy_offer > 0 && sellPrice > tItem.buy_offer * maxOverBid) return null;
    }
  }

  const margin = sellPrice - buyPrice;
  if (margin <= 0) return null;
  const marginPct = (margin / buyPrice) * 100;

  // Available quantity per side. Take = current offer count (instant depth,
  // same proxy legacy code used). Make = flow you can queue within HORIZON_DAYS.
  // Take sides require a present offer count (matches legacy buy_offers gate).
  // Flow: items sold into buy offers (sold) fill YOUR buy offer; items bought
  // from sell offers (bought) fill YOUR sell offer. Competition = the offers on
  // the same side you'd queue behind (buy_offers when you make a buy, sell_offers
  // when you make a sell).
  const buyFlow  = makeFlow(perDay(sItem.month_sold,   sItem.day_sold),   sItem.buy_offers);
  const sellFlow = makeFlow(perDay(tItem.month_bought, tItem.day_bought), tItem.sell_offers);

  let buyAvail, sellAvail;
  if (buySide === 'make') {
    buyAvail = buyFlow * HORIZON_DAYS;
  } else {
    if (!(sItem.sell_offers > 0)) return null;
    buyAvail = sItem.sell_offers;
  }
  if (sellSide === 'make') {
    sellAvail = sellFlow * HORIZON_DAYS;
  } else {
    if (!(tItem.buy_offers > 0)) return null;
    sellAvail = tItem.buy_offers;
  }

  const qtyCap = Math.floor(Math.min(buyAvail, sellAvail));
  if (qtyCap < 1) return null;

  const daysToFillBuy  = buySide  === 'make' ? (buyFlow  > 0 ? qtyCap / buyFlow  : Infinity) : 0;
  const daysToFillSell = sellSide === 'make' ? (sellFlow > 0 ? qtyCap / sellFlow : Infinity) : 0;
  const etaDays = Math.max(daysToFillBuy, daysToFillSell);

  return {
    type,
    action: { buy: buySide, sell: sellSide },
    buyPrice, sellPrice, margin, marginPct,
    qtyCap, daysToFillBuy, daysToFillSell, etaDays,
    estProfit: margin * qtyCap,
  };
}

// All priced & feasible strategies for one (start item, target item) snapshot.
export function evaluateStrategies(sItem, tItem, opts) {
  return ACTIVE_STRATEGIES
    .map(([type, buySide, sellSide]) => evalOne(type, buySide, sellSide, sItem, tItem, opts))
    .filter(Boolean);
}

// Best strategy by estimated profit, subject to ETA and margin gates.
export function bestStrategy(sItem, tItem, opts = {}) {
  const maxEta = opts.maxEtaDays ?? Infinity;
  const minMarginPct = opts.minMarginPct ?? 0;
  const candidates = evaluateStrategies(sItem, tItem, opts)
    .filter(s => s.etaDays <= maxEta && s.marginPct >= minMarginPct);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.estProfit - a.estProfit);
  return candidates[0];
}
