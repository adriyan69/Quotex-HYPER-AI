/**
 * Average True Range (Wilder's smoothing). Takes full candles (needs
 * high/low/close), returns an array aligned to candles.length.
 */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    trueRanges.push(tr);
  }

  let avg = 0;
  for (let i = 0; i < period; i++) avg += trueRanges[i];
  avg /= period;
  out[period] = avg;

  for (let i = period; i < trueRanges.length; i++) {
    avg = (avg * (period - 1) + trueRanges[i]) / period;
    out[i + 1] = avg;
  }
  return out;
}
