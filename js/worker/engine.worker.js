import { ReplayDataProvider } from '../core/ReplayDataProvider.js';
import { sampleCandles } from '../core/sampleData.js';
import { normalizeCandles } from '../core/CandleNormalizer.js';
import { RealtimeEngine } from '../engine/RealtimeEngine.js';
import { ScoringEngine } from '../signal/scoringEngine.js';

// The engine only ever talks to a MarketDataProvider through its interface.
// Right now that's ReplayDataProvider fed by either the bundled synthetic
// sample or candles you imported yourself. Swapping in a real licensed feed
// later (Phase 12) never requires touching this file's control flow.
//
// sampleData.js stores raw [time,o,h,l,c] rows (compact for bundling), so
// it goes through the same normalizer as any imported file before use —
// nothing downstream should ever see anything but the canonical
// {time, open, high, low, close} shape.
let provider = new ReplayDataProvider(normalizeCandles(sampleCandles), { intervalMs: 2000, label: 'synthetic sample' });
let rt = new RealtimeEngine({ lookback: 3 });
let unsubscribe = null;
let running = false;
let currentDatasetLabel = 'Synthetic sample (not real market data)';

const scoringEngine = new ScoringEngine();

// Phase 6: the real-time loop. Every new candle now costs O(1)/O(lookback)
// work in RealtimeEngine instead of re-scanning the full candle history
// (verified numerically identical to the old full-recompute approach across
// every tick of the sample dataset before this shipped). Steps 7-14 of the
// spec's real-time loop (score -> check conflicts -> determine signal ->
// update UI) happen here in buildPayload, using RealtimeEngine's output.

async function seedFromProvider() {
  rt = new RealtimeEngine({ lookback: 3 });
  const primingCandles = await provider.getCandles('sample', '1m', 10_000);
  rt.prime(primingCandles);
}

function buildPayload(indicatorsAndStructure, marketStatus) {
  const { indicators, structure } = indicatorsAndStructure;
  const signal =
    marketStatus === 'CLOSED'
      ? { state: 'NO_TRADE', strength: 0, buyScore: 0, sellScore: 0, reasons: ['Replay stopped'], warnings: [] }
      : scoringEngine.compute(rt.recentCandles, indicators, structure, rt.atrHistory);

  const warnings = [...signal.warnings];
  if (marketStatus === 'CLOSED') {
    warnings.push('Replay data exhausted — tap RESTART to replay from the beginning');
  }
  if (indicators.candleCount < 200) {
    warnings.push(`EMA200 needs 200 candles (have ${indicators.candleCount}) — reported as insufficient until then`);
  }
  if (rt.invalidCount > 0) {
    warnings.push(`${rt.invalidCount} malformed candle(s) were received and skipped`);
  }
  warnings.push('Not backtested/paper-traded yet — strength is an evidence score, not a win probability (Phase 9-10)');

  return {
    dataset: currentDatasetLabel,
    asset: 'EUR/USD (sample)',
    timeframe: '1M',
    marketStatus,
    signalState: signal.state,
    strength: signal.strength,
    buyScore: signal.buyScore ?? 0,
    sellScore: signal.sellScore ?? 0,
    lastCandle: rt.lastCandle,
    indicators,
    structure,
    reasons: signal.reasons,
    warnings,
    timestamp: new Date().toISOString(),
  };
}

async function postCurrentSnapshot() {
  const status = await provider.getMarketStatus();
  if (!rt.lastCandle) {
    // Nothing ingested yet (e.g. right after loading a dataset with too few
    // candles to prime). Post a minimal "not enough data" payload rather
    // than crashing on a null candle.
    self.postMessage(buildPayload({ indicators: emptyIndicators(), structure: emptyStructure() }, status.status));
    return;
  }
  const snapshot = { indicators: rt.lastIndicators, structure: rt.lastStructure };
  self.postMessage(buildPayload(snapshot, status.status));
}

self.onmessage = async (e) => {
  const { type, payload } = e.data || {};

  if (type === 'loadCandles') {
    if (unsubscribe) unsubscribe();
    running = false;
    provider = new ReplayDataProvider(payload.candles, { intervalMs: 2000, label: payload.label });
    currentDatasetLabel = payload.label || 'Imported dataset';
    await seedFromProvider();
    await postCurrentSnapshot();
    return;
  }

  if (type === 'start') {
    if (running) return;
    running = true;
    if (!rt.lastCandle) {
      // First start (or after loadCandles/restart already reseeded) — prime
      // once. Resuming after a plain STOP reuses the existing rt state as-is
      // instead of re-priming from scratch.
      await seedFromProvider();
    }
    unsubscribe = provider.subscribeToRealtimeData('sample', '1m', (event) => {
      if (event.type === 'end') {
        postCurrentSnapshot();
        running = false;
        return;
      }
      rt.ingest(event.candle);
      provider.getMarketStatus().then((status) => {
        self.postMessage(buildPayload({ indicators: rt.lastIndicators, structure: rt.lastStructure }, status.status));
      });
    });
    await postCurrentSnapshot(); // immediate first update, using the primed state
  }

  if (type === 'stop') {
    running = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    await postCurrentSnapshot();
  }

  if (type === 'restart') {
    running = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    provider.reset();
    await seedFromProvider();
    await postCurrentSnapshot();
  }
};

function emptyIndicators() {
  return {
    candleCount: 0,
    trend: { ema9: null, ema21: null, ema50: null, ema200: null, label: 'Insufficient data' },
    momentum: {
      rsi: null, rsiLabel: 'Insufficient data',
      macd: { macdLine: null, signalLine: null, histogram: null }, macdLabel: 'Insufficient data',
      roc: null, rocLabel: 'Insufficient data',
    },
    volatility: { atr: null, bollinger: { upper: null, middle: null, lower: null }, bollingerLabel: 'Insufficient data' },
  };
}

function emptyStructure() {
  return {
    swingHighCount: 0, swingLowCount: 0,
    lastSwingHigh: null, lastSwingLow: null,
    bias: 'INSUFFICIENT', biasLabel: 'Insufficient data',
    event: null, recentSequence: [],
  };
}
