import { ReplayDataProvider } from '../core/ReplayDataProvider.js';
import { sampleCandles } from '../core/sampleData.js';
import { normalizeCandles } from '../core/CandleNormalizer.js';
import { IndicatorEngine } from '../indicators/index.js';
import { StructureEngine } from '../structure/marketStructure.js';
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
let unsubscribe = null;
let running = false;
let currentDatasetLabel = 'Synthetic sample (not real market data)';

const indicatorEngine = new IndicatorEngine();
const structureEngine = new StructureEngine({ lookback: 3 });
const scoringEngine = new ScoringEngine();

// As of Phase 5, signal state/strength are REAL: computed by ScoringEngine
// from the weighted multi-confirmation system (trend/momentum/structure/
// price-action/S-R, reinforced-not-initiated by volatility regime). It is
// NOT backtested or paper-traded yet (Phases 9-10), so "signal strength"
// must never be read as a win probability — it's an evidence score out of
// 100, nothing more, until real logged outcomes say otherwise.

async function buildPayload(candle, marketStatus) {
  const candles = await provider.getCandles('sample', '1m', 300);
  const indicators = indicatorEngine.compute(candles);
  const structure = structureEngine.compute(candles);
  const signal = marketStatus === 'CLOSED'
    ? { state: 'NO_TRADE', strength: 0, reasons: ['Replay stopped'], warnings: [] }
    : scoringEngine.compute(candles, indicators, structure);

  const warnings = [...signal.warnings];
  if (marketStatus === 'CLOSED') {
    warnings.push('Replay data exhausted — tap RESTART to replay from the beginning');
  }
  if (indicators.candleCount < 200) {
    warnings.push(`EMA200 needs 200 candles (have ${indicators.candleCount}) — reported as insufficient until then`);
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
    lastCandle: candle || null,
    indicators,
    structure,
    reasons: signal.reasons,
    warnings,
    timestamp: new Date().toISOString(),
  };
}

async function postCurrentSnapshot() {
  const status = await provider.getMarketStatus();
  const candles = await provider.getCandles('sample', '1m', 1);
  const lastCandle = candles[candles.length - 1] || null;
  self.postMessage(await buildPayload(lastCandle, status.status));
}

self.onmessage = async (e) => {
  const { type, payload } = e.data || {};

  if (type === 'loadCandles') {
    // Swap the replay dataset (e.g. a file the user imported on the UI
    // thread and normalized before sending it here). Stops any running
    // replay first.
    if (unsubscribe) unsubscribe();
    running = false;
    provider = new ReplayDataProvider(payload.candles, { intervalMs: 2000, label: payload.label });
    currentDatasetLabel = payload.label || 'Imported dataset';
    await postCurrentSnapshot();
    return;
  }

  if (type === 'start') {
    if (running) return;
    running = true;
    unsubscribe = provider.subscribeToRealtimeData('sample', '1m', async (event) => {
      if (event.type === 'end') {
        await postCurrentSnapshot();
        running = false;
        return;
      }
      const status = await provider.getMarketStatus();
      self.postMessage(await buildPayload(event.candle, status.status));
    });
    await postCurrentSnapshot(); // immediate first update
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
    await postCurrentSnapshot();
  }
};
