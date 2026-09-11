/**
 * Exponential Moving Average.
 * Returns an array the same length as `values`, with `null` for indices
 * before the EMA is defined (fewer than `period` data points seen yet).
 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  // Seed with a simple moving average of the first `period` values.
  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  sma /= period;
  out[period - 1] = sma;

  let prev = sma;
  for (let i = period; i < values.length; i++) {
    const next = values[i] * k + prev * (1 - k);
    out[i] = next;
    prev = next;
  }
  return out;
}

export function latestValue(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !Number.isNaN(arr[i])) return arr[i];
  }
  return null;
}
