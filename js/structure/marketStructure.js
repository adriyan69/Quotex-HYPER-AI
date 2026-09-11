import { findSwingPoints } from './swingPoints.js';

/**
 * Classifies a series of same-type swing points (all highs, or all lows)
 * against their immediate predecessor: HH/LH for highs, HL/LL for lows.
 */
function classify(points, higherLabel, lowerLabel) {
  return points.map((p, i) => {
    if (i === 0) return { ...p, label: null };
    const label = p.price > points[i - 1].price ? higherLabel : lowerLabel;
    return { ...p, label };
  });
}

/**
 * StructureEngine.compute(candles) -> snapshot
 *
 * Pure function over a candle array (already capped at the current replay
 * position, so no look-ahead). Produces:
 *  - the most recent classified swing highs/lows (HH/LH/HL/LL)
 *  - an overall trend "bias" derived from that sequence
 *  - the latest BOS (trend continuation) or CHoCH (early reversal signal)
 *    event, judged against the most recently CONFIRMED swing points only
 *
 * This is rule-based market-structure detection in the common price-action
 * sense (similar to what's usually meant by "BOS"/"CHoCH"), not a proven
 * predictive signal by itself — Phase 5 combines this with indicators
 * and price action into the real weighted scoring engine.
 */
export class StructureEngine {
  constructor(options = {}) {
    this._lookback = options.lookback ?? 3;
  }

  compute(candles) {
    if (candles.length < this._lookback * 2 + 2) {
      return emptySnapshot(candles.length);
    }

    const { highs, lows } = findSwingPoints(candles, this._lookback);
    const classifiedHighs = classify(highs, 'HH', 'LH');
    const classifiedLows = classify(lows, 'HL', 'LL');

    const lastHigh = classifiedHighs[classifiedHighs.length - 1] || null;
    const lastLow = classifiedLows[classifiedLows.length - 1] || null;

    const bias = deriveBias(lastHigh, lastLow);
    const lastClose = candles[candles.length - 1].close;
    const event = deriveEvent(bias, lastHigh, lastLow, lastClose, candles[candles.length - 1].time);

    // Most recent few points of either type, in chronological order, for display.
    const recentSequence = [...classifiedHighs.slice(-2), ...classifiedLows.slice(-2)]
      .filter((p) => p.label)
      .sort((a, b) => a.time - b.time)
      .slice(-4);

    return {
      candleCount: candles.length,
      swingHighCount: classifiedHighs.length,
      swingLowCount: classifiedLows.length,
      lastSwingHigh: lastHigh,
      lastSwingLow: lastLow,
      bias,
      biasLabel: biasLabel(bias),
      event,
      recentSequence,
    };
  }
}

function deriveBias(lastHigh, lastLow) {
  if (!lastHigh || !lastLow || !lastHigh.label || !lastLow.label) return 'INSUFFICIENT';
  if (lastHigh.label === 'HH' && lastLow.label === 'HL') return 'UPTREND';
  if (lastHigh.label === 'LH' && lastLow.label === 'LL') return 'DOWNTREND';
  return 'RANGING';
}

function biasLabel(bias) {
  switch (bias) {
    case 'UPTREND': return 'Uptrend (HH + HL)';
    case 'DOWNTREND': return 'Downtrend (LH + LL)';
    case 'RANGING': return 'Ranging / mixed structure';
    default: return 'Insufficient data';
  }
}

function deriveEvent(bias, lastHigh, lastLow, lastClose, time) {
  if (bias === 'UPTREND' && lastHigh) {
    if (lastClose > lastHigh.price) {
      return { type: 'BOS', direction: 'bullish', label: 'Bullish BOS — trend continuation', price: lastClose, time };
    }
    if (lastLow && lastClose < lastLow.price) {
      return { type: 'CHOCH', direction: 'bearish', label: 'Bearish CHoCH — possible reversal', price: lastClose, time };
    }
  }
  if (bias === 'DOWNTREND' && lastLow) {
    if (lastClose < lastLow.price) {
      return { type: 'BOS', direction: 'bearish', label: 'Bearish BOS — trend continuation', price: lastClose, time };
    }
    if (lastHigh && lastClose > lastHigh.price) {
      return { type: 'CHOCH', direction: 'bullish', label: 'Bullish CHoCH — possible reversal', price: lastClose, time };
    }
  }
  return null;
}

function emptySnapshot(candleCount) {
  return {
    candleCount,
    swingHighCount: 0,
    swingLowCount: 0,
    lastSwingHigh: null,
    lastSwingLow: null,
    bias: 'INSUFFICIENT',
    biasLabel: 'Insufficient data',
    event: null,
    recentSequence: [],
  };
}
