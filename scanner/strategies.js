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

function evalOne(type, buySide, sellSide, sItem, tItem) {
  const buyPrice  = buySide  === 'make' ? sItem.buy_offer  : sItem.sell_offer;
  const sellPrice = sellSide === 'make' ? tItem.sell_offer : tItem.buy_offer;
  if (!(buyPrice > 0) || !(sellPrice > 0)) return null;

  const margin = sellPrice - buyPrice;
  if (margin <= 0) return null;
  const marginPct = (margin / buyPrice) * 100;

  // Available quantity per side. Take = current offer count (instant depth,
  // same proxy legacy code used). Make = flow you can queue within HORIZON_DAYS.
  // Take sides require a present offer count (matches legacy buy_offers gate).
  const buyFlow  = makeFlow(sItem.day_sold,   sItem.sell_offers);
  const sellFlow = makeFlow(tItem.day_bought, tItem.buy_offers);

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
export function evaluateStrategies(sItem, tItem) {
  return [
    evalOne('take-take', 'take', 'take', sItem, tItem),
    evalOne('make-take', 'make', 'take', sItem, tItem),
    evalOne('take-make', 'take', 'make', sItem, tItem),
    evalOne('make-make', 'make', 'make', sItem, tItem),
  ].filter(Boolean);
}

// Best strategy by estimated profit, subject to ETA and margin gates.
export function bestStrategy(sItem, tItem, opts = {}) {
  const maxEta = opts.maxEtaDays ?? Infinity;
  const minMarginPct = opts.minMarginPct ?? 0;
  const candidates = evaluateStrategies(sItem, tItem)
    .filter(s => s.etaDays <= maxEta && s.marginPct >= minMarginPct);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.estProfit - a.estProfit);
  return candidates[0];
}
