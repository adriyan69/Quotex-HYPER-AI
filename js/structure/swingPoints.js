/**
 * Swing point detection (fractal method).
 *
 * A candle at index i is a swing HIGH if its high is greater than the highs
 * of `lookback` candles on each side; a swing LOW is the mirror on lows.
 *
 * Critically: a swing point can only be CONFIRMED once `lookback` candles
 * have closed *after* it — you can't know index i was a local high until
 * you've seen what came next. So `findSwingPoints` only ever returns
 * confirmed points for the candle array it's given, which itself is
 * already capped at the current replay position by ReplayDataProvider's
 * no-look-ahead rule. This keeps swing detection realistic: in a live
 * scenario you'd have exactly this same lag, not perfect hindsight.
 */
export function findSwingPoints(candles, lookback = 3) {
  const highs = [];
  const lows = [];

  // Only indices with `lookback` candles on both sides can be evaluated,
  // and only those with `lookback` candles after them are "confirmed" —
  // which, since i only ranges up to length - lookback - 1, is automatic.
  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candle.high) isHigh = false;
      if (candles[j].low <= candle.low) isLow = false;
    }

    if (isHigh) highs.push({ index: i, time: candle.time, price: candle.high });
    if (isLow) lows.push({ index: i, time: candle.time, price: candle.low });
  }

  return { highs, lows };
}
