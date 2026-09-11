import { ema } from './ema.js';

/**
 * MACD: fast EMA - slow EMA, plus an EMA-of-that as the signal line.
 * Returns { macdLine[], signalLine[], histogram[] }, each aligned to
 * `values` length with `null` before defined.
 */
export function macd(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);

  const macdLine = values.map((_, i) =>
    fast[i] !== null && slow[i] !== null ? fast[i] - slow[i] : null
  );

  // EMA of the MACD line itself, computed only over its defined portion.
  const firstDefined = macdLine.findIndex((v) => v !== null);
  const signalLine = new Array(values.length).fill(null);
  if (firstDefined !== -1) {
    const macdTail = macdLine.slice(firstDefined);
    const signalTail = ema(macdTail, signalPeriod);
    signalTail.forEach((v, i) => {
      signalLine[firstDefined + i] = v;
    });
  }

  const histogram = values.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null ? macdLine[i] - signalLine[i] : null
  );

  return { macdLine, signalLine, histogram };
}
