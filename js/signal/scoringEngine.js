import { analyzePriceAction } from './priceAction.js';

/**
 * ScoringEngine — the multi-confirmation weighted scoring system from the
 * original spec (Section 4):
 *
 *   Trend             25 pts
 *   Momentum          20 pts
 *   Market structure  20 pts
 *   Price action      15 pts
 *   Support/Resistance 10 pts
 *   Volatility        10 pts  (reinforces the leading side only, never
 *                              initiates a direction by itself, and is
 *                              withheld entirely in a HIGH-volatility
 *                              regime — see Section 15)
 *   ------------------------
 *   Total            100 pts
 *
 * BUY and SELL scores are accumulated independently. The engine prefers
 * NO_TRADE over forcing a signal whenever: too many categories are
 * "insufficient", the leading score is too low, or the gap between BUY and
 * SELL is too small (conflicting evidence) — exactly the "NO TRADE —
 * insufficient confirmation" behavior called for from the start.
 *
 * "Signal strength" is explicitly a 0-100 evidence score, NOT a claimed
 * win probability. Phase 10 (performance dashboard) is what will show the
 * real historical win rate per strength bucket, from logged outcomes.
 */
export class ScoringEngine {
  /**
   * @param {Array} candles - a small recent window (price action + S/R only
   *   ever look at the last couple of candles; this is NOT the full history)
   * @param {object} indicators - from RealtimeEngine/IndicatorEngine
   * @param {object} structure - from RealtimeEngine/StructureEngine
   * @param {Array<number>} [atrHistory] - rolling recent ATR values, for the
   *   volatility-regime check. Passed in rather than recomputed from candles
   *   so this stays O(1) against RealtimeEngine's already-maintained buffer
   *   instead of re-scanning history (Phase 6).
   */
  compute(candles, indicators, structure, atrHistory = []) {
    const priceAction = analyzePriceAction(candles);
    const supportResistance = evaluateSupportResistance(candles, structure, indicators);
    const regime = evaluateVolatilityRegime(atrHistory);

    const categories = {
      trend: { weight: 25, ...trendVote(indicators) },
      momentum: { weight: 20, ...momentumVote(indicators) },
      structure: { weight: 20, ...structureVote(structure) },
      priceAction: { weight: 15, direction: priceAction.direction, label: priceAction.label },
      supportResistance: { weight: 10, ...supportResistance },
    };

    let buyScore = 0;
    let sellScore = 0;
    let insufficientWeight = 0;
    const directionalWeight = 25 + 20 + 20 + 15 + 10; // 90, volatility handled separately

    for (const key of Object.keys(categories)) {
      const cat = categories[key];
      if (cat.direction === 'bullish') buyScore += cat.weight;
      else if (cat.direction === 'bearish') sellScore += cat.weight;
      else if (cat.direction === 'insufficient') insufficientWeight += cat.weight;
    }

    const warnings = [];

    // Volatility never initiates a direction; it only reinforces whichever
    // side is already leading, and only when the regime isn't HIGH.
    let volatilityApplied = false;
    if (regime.status === 'HIGH') {
      warnings.push(`High volatility regime (ATR ${regime.ratio.toFixed(2)}x average) — requiring stronger confirmation, volatility bonus withheld`);
    } else if (regime.status !== 'UNKNOWN') {
      if (buyScore > sellScore) { buyScore += 10; volatilityApplied = true; }
      else if (sellScore > buyScore) { sellScore += 10; volatilityApplied = true; }
    }
    categories.volatility = { weight: 10, direction: regime.status === 'UNKNOWN' ? 'insufficient' : 'neutral', label: regime.label, applied: volatilityApplied };

    if (insufficientWeight >= directionalWeight / 2) {
      return finalize({
        state: 'NO_TRADE',
        strength: 0,
        buyScore,
        sellScore,
        categories,
        regime,
        reasons: ['Not enough confirmed data across most categories yet'],
        warnings: [...warnings, 'NO TRADE — insufficient confirmation'],
      });
    }

    const diff = buyScore - sellScore;
    const leadingSide = buyScore >= sellScore ? 'BUY' : 'SELL';
    const leadingScore = Math.max(buyScore, sellScore);

    const minSeparation = regime.status === 'HIGH' ? 25 : 15;
    const minLeadingScore = regime.status === 'HIGH' ? 55 : 40;

    let state;
    if (leadingScore < minLeadingScore || Math.abs(diff) < minSeparation) {
      state = 'NO_TRADE';
      warnings.push('NO TRADE — insufficient confirmation (scores too close or too low)');
    } else if (leadingScore < minLeadingScore + 15) {
      state = 'WAIT';
      warnings.push(`Leaning ${leadingSide} but below full confirmation threshold — wait for stronger confluence`);
    } else if (leadingScore >= 80) {
      state = leadingSide === 'BUY' ? 'STRONG_BUY' : 'STRONG_SELL';
    } else {
      state = leadingSide === 'BUY' ? 'BUY' : 'SELL';
    }

    const reasons = buildReasons(categories, leadingSide, state);

    return finalize({
      state,
      strength: leadingScore,
      buyScore,
      sellScore,
      categories,
      regime,
      reasons,
      warnings,
    });
  }
}

function trendVote(indicators) {
  const label = indicators.trend.label;
  if (label === 'Insufficient data') return { direction: 'insufficient', label };
  if (label.startsWith('Bullish')) return { direction: 'bullish', label };
  if (label.startsWith('Bearish')) return { direction: 'bearish', label };
  return { direction: 'neutral', label };
}

function momentumVote(indicators) {
  const votes = [];
  const { rsi, macd, roc } = indicators.momentum;

  if (rsi !== null) votes.push(rsi > 55 ? 'bullish' : rsi < 45 ? 'bearish' : 'neutral');
  if (macd.histogram !== null) votes.push(macd.histogram > 0 ? 'bullish' : macd.histogram < 0 ? 'bearish' : 'neutral');
  if (roc !== null) votes.push(roc > 0 ? 'bullish' : roc < 0 ? 'bearish' : 'neutral');

  if (votes.length < 2) return { direction: 'insufficient', label: 'Insufficient data' };

  const bullish = votes.filter((v) => v === 'bullish').length;
  const bearish = votes.filter((v) => v === 'bearish').length;

  if (bullish > bearish) return { direction: 'bullish', label: `Momentum: ${bullish}/${votes.length} indicators bullish` };
  if (bearish > bullish) return { direction: 'bearish', label: `Momentum: ${bearish}/${votes.length} indicators bearish` };
  return { direction: 'neutral', label: 'Momentum indicators split evenly' };
}

function structureVote(structure) {
  if (structure.event) {
    const label = structure.event.label;
    return { direction: structure.event.direction, label };
  }
  if (structure.bias === 'UPTREND') return { direction: 'bullish', label: structure.biasLabel };
  if (structure.bias === 'DOWNTREND') return { direction: 'bearish', label: structure.biasLabel };
  if (structure.bias === 'RANGING') return { direction: 'neutral', label: structure.biasLabel };
  return { direction: 'insufficient', label: structure.biasLabel };
}

function evaluateSupportResistance(candles, structure, indicators) {
  const { lastSwingHigh, lastSwingLow } = structure;
  const atrVal = indicators.volatility.atr;
  const lastCandle = candles[candles.length - 1];

  if (!lastSwingHigh || !lastSwingLow || atrVal === null || !lastCandle) {
    return { direction: 'insufficient', label: 'Insufficient data' };
  }

  const threshold = atrVal * 0.5;
  const nearSupport = Math.abs(lastCandle.close - lastSwingLow.price) <= threshold;
  const nearResistance = Math.abs(lastCandle.close - lastSwingHigh.price) <= threshold;
  const bullishCandle = lastCandle.close > lastCandle.open;
  const bearishCandle = lastCandle.close < lastCandle.open;

  if (nearSupport && bullishCandle) {
    return { direction: 'bullish', label: `Bouncing off support near ${lastSwingLow.price.toFixed(5)}` };
  }
  if (nearResistance && bearishCandle) {
    return { direction: 'bearish', label: `Rejecting resistance near ${lastSwingHigh.price.toFixed(5)}` };
  }
  return { direction: 'neutral', label: 'Not currently at a confirmed S/R level' };
}

function evaluateVolatilityRegime(atrHistory) {
  const series = atrHistory.filter((v) => v !== null && v !== undefined);
  if (series.length < 15) {
    return { status: 'UNKNOWN', ratio: 1, label: 'Insufficient data for volatility regime' };
  }
  const last = series[series.length - 1];
  const lookback = series.slice(-20, -1);
  const avg = lookback.reduce((a, b) => a + b, 0) / lookback.length;
  const ratio = avg > 0 ? last / avg : 1;

  if (ratio > 1.5) return { status: 'HIGH', ratio, label: `High volatility (ATR ${ratio.toFixed(2)}x average)` };
  if (ratio < 0.6) return { status: 'LOW', ratio, label: `Low volatility (ATR ${ratio.toFixed(2)}x average)` };
  return { status: 'NORMAL', ratio, label: `Normal volatility (ATR ${ratio.toFixed(2)}x average)` };
}

function buildReasons(categories, leadingSide, state) {
  if (state === 'NO_TRADE') return ['Conflicting or insufficient confirmation across categories'];

  const wantDirection = leadingSide === 'BUY' ? 'bullish' : 'bearish';
  const order = ['trend', 'momentum', 'structure', 'priceAction', 'supportResistance'];
  const reasons = order
    .filter((key) => categories[key].direction === wantDirection)
    .map((key) => categories[key].label);

  if (categories.volatility.applied) {
    reasons.push(categories.volatility.label + ' (reinforcing)');
  }
  if (!reasons.length) reasons.push('Weighted score favors this direction');
  return reasons.slice(0, 3);
}

function finalize(result) {
  return result;
}
