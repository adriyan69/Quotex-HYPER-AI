/**
 * Bollinger Bands: SMA midline, upper/lower at +/- (multiplier * stddev).
 * Returns { upper[], middle[], lower[] }, each aligned to values.length.
 */
export function bollingerBands(values, period = 20, multiplier = 2) {
  const upper = new Array(values.length).fill(null);
  const middle = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const stddev = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + multiplier * stddev;
    lower[i] = mean - multiplier * stddev;
  }

  return { upper, middle, lower };
}
