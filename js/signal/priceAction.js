/**
 * Minimal price-action pattern detection over the last 1-2 closed candles.
 * Pure function, no DOM/UI dependency. Deliberately conservative: only
 * recognizes a small, well-defined set of patterns (engulfing, pin bar
 * rejection) rather than trying to cover every named candlestick pattern.
 */
export function analyzePriceAction(candles) {
  if (candles.length < 2) {
    return { direction: 'insufficient', label: 'Insufficient data' };
  }

  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];

  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  const currRange = curr.high - curr.low || 1e-9;
  const upperWick = curr.high - Math.max(curr.open, curr.close);
  const lowerWick = Math.min(curr.open, curr.close) - curr.low;

  // Engulfing: current candle's body fully covers the previous candle's body,
  // in the opposite direction of the previous candle.
  const prevBearish = prev.close < prev.open;
  const prevBullish = prev.close > prev.open;
  const currBullish = curr.close > curr.open;
  const currBearish = curr.close < curr.open;

  const engulfsPrev = curr.open <= Math.min(prev.open, prev.close) && curr.close >= Math.max(prev.open, prev.close);
  const engulfsPrevBear = curr.open >= Math.max(prev.open, prev.close) && curr.close <= Math.min(prev.open, prev.close);

  if (prevBearish && currBullish && engulfsPrev) {
    return { direction: 'bullish', label: 'Bullish engulfing candle' };
  }
  if (prevBullish && currBearish && engulfsPrevBear) {
    return { direction: 'bearish', label: 'Bearish engulfing candle' };
  }

  // Pin bar / rejection wick: a long wick on one side with a small body,
  // closing away from that wick, signals rejection of that price level.
  const isPinBar = currBody < currRange * 0.35;
  if (isPinBar && lowerWick > currBody * 2 && lowerWick > upperWick) {
    return { direction: 'bullish', label: 'Bullish pin bar (lower-wick rejection)' };
  }
  if (isPinBar && upperWick > currBody * 2 && upperWick > lowerWick) {
    return { direction: 'bearish', label: 'Bearish pin bar (upper-wick rejection)' };
  }

  return { direction: 'neutral', label: 'No clear single/two-candle pattern' };
}
