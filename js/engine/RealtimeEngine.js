import { trendLabel, rsiLabel, macdLabel, bollingerLabel } from '../indicators/index.js';
import { deriveBias, biasLabel, deriveEvent } from '../structure/marketStructure.js';

/**
 * RealtimeEngine — Phase 6's incremental real-time loop (spec Section 8).
 *
 * Everything in Phases 3-5 recomputed indicators/structure from the FULL
 * candle history on every tick (cheap enough at ~300 candles, but not how
 * a real live feed running for hours/days should behave). This engine
 * instead keeps small running state per indicator and per swing-point
 * scan, so each new candle costs O(1)-to-O(lookback) work instead of
 * O(n) — never re-scanning the whole history just because one more
 * candle closed.
 *
 * ingest(candle) implements steps 1-6 of the spec's real-time loop
 * (receive -> validate -> update history -> recalc indicators -> detect
 * structure) and returns the updated {indicators, structure} snapshot in
 * the exact same shape IndicatorEngine/StructureEngine produced, so
 * nothing downstream (ScoringEngine, the UI) needs to change shape-wise.
 * Steps 7-14 (score, check conflicts, determine signal, update UI, log)
 * stay the worker's job, using this engine's output plus ScoringEngine.
 */
export class RealtimeEngine {
  constructor(options = {}) {
    this.lookback = options.lookback ?? 3;

    this.emaStates = {
      9: makeEmaState(9),
      21: makeEmaState(21),
      50: makeEmaState(50),
      200: makeEmaState(200),
    };
    this.rsiState = makeRsiState(14);
    this.atrState = makeAtrState(14);
    this.macdFastState = makeEmaState(12);
    this.macdSlowState = makeEmaState(26);
    this.macdSignalState = makeEmaState(9);
    this.bollingerState = makeBollingerState(20, 2);
    this.rocState = makeRocState(9);
    this.structureState = makeStructureState(this.lookback);

    this.candleCount = 0;
    this.lastCandle = null;
    this.lastIndicators = null;
    this.lastStructure = null;
    this.atrHistory = []; // rolling recent ATR values, for the scoring engine's volatility regime check
    this.recentCandles = []; // small rolling window (price action + S/R only need the last couple candles)
    this.invalidCount = 0;
  }

  /** Feed a batch of candles through ingest() without caring about the
   * intermediate snapshots — used once at startup to seed all the
   * incremental state from priming history. Still O(1) per candle
   * internally; this just avoids the caller handling n intermediate
   * results it doesn't need. */
  prime(candles) {
    for (const c of candles) this.ingest(c);
  }

  /** Steps 1-6 of the real-time loop, for exactly one new candle. */
  ingest(candle) {
    if (!isValidCandle(candle)) {
      this.invalidCount += 1;
      return null; // step 2: validate — bad data is dropped, not guessed at
    }

    this.candleCount += 1;
    this.lastCandle = candle;

    this.recentCandles.push(candle);
    if (this.recentCandles.length > 5) this.recentCandles.shift();

    const ema9 = updateEma(this.emaStates[9], candle.close);
    const ema21 = updateEma(this.emaStates[21], candle.close);
    const ema50 = updateEma(this.emaStates[50], candle.close);
    const ema200 = updateEma(this.emaStates[200], candle.close);

    const rsi = updateRsi(this.rsiState, candle.close);

    const atr = updateAtr(this.atrState, candle);
    if (atr !== null) {
      this.atrHistory.push(atr);
      if (this.atrHistory.length > 25) this.atrHistory.shift();
    }

    const fast = updateEma(this.macdFastState, candle.close);
    const slow = updateEma(this.macdSlowState, candle.close);
    let macdLine = null;
    let signalLine = null;
    let histogram = null;
    if (fast !== null && slow !== null) {
      macdLine = fast - slow;
      signalLine = updateEma(this.macdSignalState, macdLine);
      if (signalLine !== null) histogram = macdLine - signalLine;
    }

    const bb = updateBollinger(this.bollingerState, candle.close);
    const roc = updateRoc(this.rocState, candle.close);

    updateStructure(this.structureState, candle);

    const indicators = {
      candleCount: this.candleCount,
      trend: { ema9, ema21, ema50, ema200, label: trendLabel(ema9, ema21, ema50, ema200) },
      momentum: {
        rsi,
        rsiLabel: rsiLabel(rsi),
        macd: { macdLine, signalLine, histogram },
        macdLabel: macdLabel(histogram),
        roc,
        rocLabel: roc === null ? 'Insufficient data' : roc >= 0 ? 'Positive' : 'Negative',
      },
      volatility: {
        atr,
        bollinger: bb,
        bollingerLabel: bollingerLabel(candle.close, bb.upper, bb.lower),
      },
    };

    const structure = structureSnapshot(this.structureState);

    this.lastIndicators = indicators;
    this.lastStructure = structure;

    return { indicators, structure };
  }
}

// ---------------- validation ----------------

function isValidCandle(c) {
  if (!c || typeof c !== 'object') return false;
  const { open, high, low, close } = c;
  if ([open, high, low, close].some((v) => typeof v !== 'number' || Number.isNaN(v))) return false;
  if (high < Math.max(open, close) || low > Math.min(open, close)) return false;
  return true;
}

// ---------------- EMA (shared by trend EMAs and MACD's fast/slow/signal) ----------------

function makeEmaState(period) {
  return { period, value: null, seedBuffer: [] };
}

function updateEma(state, input) {
  if (state.value === null) {
    state.seedBuffer.push(input);
    if (state.seedBuffer.length === state.period) {
      state.value = state.seedBuffer.reduce((a, b) => a + b, 0) / state.period;
    }
    return state.value;
  }
  const k = 2 / (state.period + 1);
  state.value = input * k + state.value * (1 - k);
  return state.value;
}

// ---------------- RSI (Wilder's smoothing) ----------------

function makeRsiState(period) {
  return { period, prevClose: null, avgGain: null, avgLoss: null, gainBuf: [], lossBuf: [] };
}

function updateRsi(state, close) {
  if (state.prevClose === null) {
    state.prevClose = close;
    return null;
  }
  const change = close - state.prevClose;
  state.prevClose = close;
  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? -change : 0;

  if (state.avgGain === null) {
    state.gainBuf.push(gain);
    state.lossBuf.push(loss);
    if (state.gainBuf.length === state.period) {
      state.avgGain = state.gainBuf.reduce((a, b) => a + b, 0) / state.period;
      state.avgLoss = state.lossBuf.reduce((a, b) => a + b, 0) / state.period;
    } else {
      return null;
    }
  } else {
    state.avgGain = (state.avgGain * (state.period - 1) + gain) / state.period;
    state.avgLoss = (state.avgLoss * (state.period - 1) + loss) / state.period;
  }

  if (state.avgLoss === 0) return 100;
  const rs = state.avgGain / state.avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------------- ATR (Wilder's smoothing) ----------------

function makeAtrState(period) {
  return { period, prevClose: null, avg: null, trBuf: [] };
}

function updateAtr(state, candle) {
  if (state.prevClose === null) {
    state.prevClose = candle.close;
    return null;
  }
  const tr = Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - state.prevClose),
    Math.abs(candle.low - state.prevClose)
  );
  state.prevClose = candle.close;

  if (state.avg === null) {
    state.trBuf.push(tr);
    if (state.trBuf.length === state.period) {
      state.avg = state.trBuf.reduce((a, b) => a + b, 0) / state.period;
    } else {
      return null;
    }
  } else {
    state.avg = (state.avg * (state.period - 1) + tr) / state.period;
  }
  return state.avg;
}

// ---------------- Bollinger Bands (rolling window, O(1) amortized per tick) ----------------

function makeBollingerState(period, multiplier) {
  return { period, multiplier, window: [], sum: 0, sumSq: 0 };
}

function updateBollinger(state, close) {
  state.window.push(close);
  state.sum += close;
  state.sumSq += close * close;
  if (state.window.length > state.period) {
    const removed = state.window.shift();
    state.sum -= removed;
    state.sumSq -= removed * removed;
  }
  if (state.window.length < state.period) return { upper: null, middle: null, lower: null };

  const mean = state.sum / state.period;
  const variance = Math.max(state.sumSq / state.period - mean * mean, 0);
  const stddev = Math.sqrt(variance);
  return {
    upper: mean + state.multiplier * stddev,
    middle: mean,
    lower: mean - state.multiplier * stddev,
  };
}

// ---------------- Rate of Change (rolling window) ----------------

function makeRocState(period) {
  return { period, window: [] };
}

function updateRoc(state, close) {
  state.window.push(close);
  if (state.window.length > state.period + 1) state.window.shift();
  if (state.window.length < state.period + 1) return null;
  const past = state.window[0];
  return past !== 0 ? ((close - past) / past) * 100 : null;
}

// ---------------- Market structure (incremental fractal swing detection) ----------------

function makeStructureState(lookback) {
  return {
    lookback,
    pendingBuffer: [], // last (2*lookback+1) raw candles, for confirming the middle one
    swingHighs: [], // confirmed, classified: { time, price, label }
    swingLows: [],
    lastClose: null,
    lastCloseTime: null,
  };
}

function updateStructure(state, candle) {
  state.lastClose = candle.close;
  state.lastCloseTime = candle.time;

  state.pendingBuffer.push(candle);
  const windowSize = state.lookback * 2 + 1;
  if (state.pendingBuffer.length > windowSize) state.pendingBuffer.shift();

  if (state.pendingBuffer.length === windowSize) {
    const mid = state.pendingBuffer[state.lookback];
    let isHigh = true;
    let isLow = true;
    for (let j = 0; j < state.pendingBuffer.length; j++) {
      if (j === state.lookback) continue;
      const other = state.pendingBuffer[j];
      if (other.high >= mid.high) isHigh = false;
      if (other.low <= mid.low) isLow = false;
    }
    if (isHigh) {
      const prev = state.swingHighs[state.swingHighs.length - 1] || null;
      const label = prev ? (mid.high > prev.price ? 'HH' : 'LH') : null;
      state.swingHighs.push({ time: mid.time, price: mid.high, label });
    }
    if (isLow) {
      const prev = state.swingLows[state.swingLows.length - 1] || null;
      const label = prev ? (mid.low > prev.price ? 'HL' : 'LL') : null;
      state.swingLows.push({ time: mid.time, price: mid.low, label });
    }
  }
}

function structureSnapshot(state) {
  const lastHigh = state.swingHighs[state.swingHighs.length - 1] || null;
  const lastLow = state.swingLows[state.swingLows.length - 1] || null;
  const bias = deriveBias(lastHigh, lastLow);
  const event =
    state.lastClose !== null
      ? deriveEvent(bias, lastHigh, lastLow, state.lastClose, state.lastCloseTime)
      : null;

  return {
    swingHighCount: state.swingHighs.length,
    swingLowCount: state.swingLows.length,
    lastSwingHigh: lastHigh,
    lastSwingLow: lastLow,
    bias,
    biasLabel: biasLabel(bias),
    event,
    recentSequence: [...state.swingHighs.slice(-2), ...state.swingLows.slice(-2)]
      .filter((p) => p.label)
      .sort((a, b) => a.time - b.time)
      .slice(-4),
  };
}
