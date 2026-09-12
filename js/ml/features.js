/**
 * extractFeatures — pure function producing a fixed-length numeric feature
 * vector from the same indicator/structure/price-action state the
 * rule-based ScoringEngine already computes (spec Section 14's suggested
 * inputs: RSI, MACD, EMA distances, ATR, Bollinger position, candle/trend/
 * structure features, volatility, time/session features).
 *
 * Used ONLY by the experimental ML trainer (Phase 11, MLExperiment.js) —
 * the live SIGNAL stays purely rule-based (Phases 3-5). Returns `null`
 * when there isn't enough indicator history yet to build a meaningful
 * vector (early in a dataset) — MLExperiment skips those candles rather
 * than feeding the model rows of fabricated zeros.
 */
export const FEATURE_NAMES = [
  'rsi_norm', 'macd_hist_norm', 'roc_norm',
  'ema9_21_dist', 'ema21_50_dist', 'ema50_200_dist', 'close_ema9_dist',
  'atr_rel', 'bb_percent_b',
  'price_action_bullish', 'price_action_bearish',
  'structure_bias', 'structure_event',
  'hour_sin', 'hour_cos',
];

export function extractFeatures(indicators, structure, priceAction, closePrice, time) {
  const t = indicators.trend;
  const m = indicators.momentum;
  const bb = indicators.volatility.bollinger;
  const atr = indicators.volatility.atr;

  // Require the core short-period indicators (RSI/MACD/ATR/Bollinger all
  // need roughly the same ~20-26 candle warm-up) before this candle counts
  // as a usable training row at all.
  if (atr === null || atr <= 0 || m.rsi === null || m.macd.histogram === null || bb.upper === null) {
    return null;
  }

  const rsiNorm = (m.rsi - 50) / 50; // -1..1
  const macdHistNorm = clamp(m.macd.histogram / atr, -3, 3) / 3;
  const rocNorm = m.roc !== null ? clamp(m.roc, -3, 3) / 3 : 0;

  const dist = (a, b) => (a !== null && b !== null ? clamp((a - b) / atr, -5, 5) / 5 : 0);
  const ema9_21 = dist(t.ema9, t.ema21);
  const ema21_50 = dist(t.ema21, t.ema50);
  const ema50_200 = dist(t.ema50, t.ema200);
  const closeEma9 = dist(closePrice, t.ema9);

  const atrRel = closePrice ? clamp(atr / closePrice, 0, 0.02) / 0.02 : 0;

  let bbPercentB = 0;
  if (bb.upper !== bb.lower) {
    bbPercentB = clamp((closePrice - bb.lower) / (bb.upper - bb.lower), -1, 2);
  }

  // priceAction comes from analyzePriceAction() on the last couple of
  // candles — { direction: 'bullish'|'bearish'|'neutral'|'insufficient', label }.
  // This function only receives the close price (not full OHLC), so candle
  // body/wick geometry isn't independently recomputable here — priceAction's
  // direction flags are the price-action signal available at this signature.
  const priceActionBullish = priceAction && priceAction.direction === 'bullish' ? 1 : 0;
  const priceActionBearish = priceAction && priceAction.direction === 'bearish' ? 1 : 0;

  const structureBias = structure.bias === 'UPTREND' ? 1 : structure.bias === 'DOWNTREND' ? -1 : 0;
  const structureEvent = !structure.event
    ? 0
    : structure.event.direction === 'bullish'
      ? (structure.event.type === 'BOS' ? 1 : 0.5)
      : (structure.event.type === 'BOS' ? -1 : -0.5);

  const hour = new Date(time).getHours();
  const hourSin = Math.sin((2 * Math.PI * hour) / 24);
  const hourCos = Math.cos((2 * Math.PI * hour) / 24);

  return [
    rsiNorm, macdHistNorm, rocNorm,
    ema9_21, ema21_50, ema50_200, closeEma9,
    atrRel, bbPercentB,
    priceActionBullish, priceActionBearish,
    structureBias, structureEvent,
    hourSin, hourCos,
  ];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
