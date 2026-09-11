/**
 * Rate of Change (%): (close - close[n periods ago]) / close[n periods ago] * 100.
 * Returns an array aligned to values.length, null before defined.
 */
export function roc(values, period = 9) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const past = values[i - period];
    if (past !== 0) out[i] = ((values[i] - past) / past) * 100;
  }
  return out;
}
