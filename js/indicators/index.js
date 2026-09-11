import { ema, latestValue } from './ema.js';
import { rsi } from './rsi.js';
import { macd } from './macd.js';
import { atr } from './atr.js';
import { bollingerBands } from './bollinger.js';
import { roc } from './roc.js';

/**
 * IndicatorEngine.compute(candles) -> snapshot
 *
 * Pure function over a candle array (ascending by time, no look-ahead —
 * whatever ReplayDataProvider.getCandles() currently exposes). Returns the
 * latest value of each indicator plus a simple per-indicator label
 * (bullish/bearish/neutral, overbought/oversold, etc).
 *
 * This is Phase 3 only: indicator MATH and per-indicator labels. It does
 * NOT combine these into a weighted score or a BUY/SELL decision —
 * that's the multi-confirmation scoring engine, Phase 5. Anything here
 * reports "insufficient data" rather than guessing when there isn't
 * enough history yet, matching the project's "prefer NO TRADE /
 * insufficient" philosophy.
 */
export class IndicatorEngine {
  compute(candles) {
    const closes = candles.map((c) => c.close);
    const n = closes.length;

    const ema9 = latestValue(ema(closes, 9));
    const ema21 = latestValue(ema(closes, 21));
    const ema50 = latestValue(ema(closes, 50));
    const ema200 = latestValue(ema(closes, 200));

    const rsiSeries = rsi(closes, 14);
    const rsiVal = latestValue(rsiSeries);

    const macdResult = macd(closes, 12, 26, 9);
    const macdLine = latestValue(macdResult.macdLine);
    const signalLine = latestValue(macdResult.signalLine);
    const histogram = latestValue(macdResult.histogram);

    const atrSeries = atr(candles, 14);
    const atrVal = latestValue(atrSeries);

    const bb = bollingerBands(closes, 20, 2);
    const bbUpper = latestValue(bb.upper);
    const bbMiddle = latestValue(bb.middle);
    const bbLower = latestValue(bb.lower);

    const rocSeries = roc(closes, 9);
    const rocVal = latestValue(rocSeries);

    const lastClose = closes[n - 1] ?? null;

    return {
      candleCount: n,
      trend: {
        ema9, ema21, ema50, ema200,
        label: trendLabel(ema9, ema21, ema50, ema200),
      },
      momentum: {
        rsi: rsiVal,
        rsiLabel: rsiLabel(rsiVal),
        macd: { macdLine, signalLine, histogram },
        macdLabel: macdLabel(histogram),
        roc: rocVal,
        rocLabel: rocVal === null ? 'Insufficient data' : rocVal >= 0 ? 'Positive' : 'Negative',
      },
      volatility: {
        atr: atrVal,
        bollinger: { upper: bbUpper, middle: bbMiddle, lower: bbLower },
        bollingerLabel: bollingerLabel(lastClose, bbUpper, bbLower),
      },
    };
  }
}

export function trendLabel(ema9, ema21, ema50, ema200) {
  if (ema9 === null || ema21 === null || ema50 === null) return 'Insufficient data';
  if (ema200 === null) {
    // Still meaningful with the shorter EMAs even before EMA200 is defined.
    if (ema9 > ema21 && ema21 > ema50) return 'Bullish (EMA200 pending)';
    if (ema9 < ema21 && ema21 < ema50) return 'Bearish (EMA200 pending)';
    return 'Mixed (EMA200 pending)';
  }
  if (ema9 > ema21 && ema21 > ema50 && ema50 > ema200) return 'Bullish';
  if (ema9 < ema21 && ema21 < ema50 && ema50 < ema200) return 'Bearish';
  return 'Mixed';
}

export function rsiLabel(v) {
  if (v === null) return 'Insufficient data';
  if (v >= 70) return 'Overbought';
  if (v <= 30) return 'Oversold';
  return 'Neutral';
}

export function macdLabel(histogram) {
  if (histogram === null) return 'Insufficient data';
  if (histogram > 0) return 'Bullish momentum';
  if (histogram < 0) return 'Bearish momentum';
  return 'Flat';
}

export function bollingerLabel(close, upper, lower) {
  if (close === null || upper === null || lower === null) return 'Insufficient data';
  if (close > upper) return 'Above upper band';
  if (close < lower) return 'Below lower band';
  return 'Inside bands';
}
