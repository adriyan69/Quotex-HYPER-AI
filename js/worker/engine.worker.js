import { ReplayDataProvider } from '../core/ReplayDataProvider.js';
import { sampleCandles } from '../core/sampleData.js';
import { normalizeCandles } from '../core/CandleNormalizer.js';
import { IndicatorEngine } from '../indicators/index.js';

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

// Signal state/strength are STILL a placeholder — Phase 5 replaces this
// with the real weighted multi-confirmation scoring engine (trend/momentum/
// structure/price-action/S-R/volatility). What's real as of Phase 3 is the
// indicator math itself and the per-indicator labels built from it.
const STATES = ['STRONG_BUY', 'BUY', 'WAIT', 'SELL', 'STRONG_SELL', 'NO_TRADE'];

function buildReasons(indicators) {
  const reasons = [];
  if (indicators.trend.label !== 'Insufficient data') {
    reasons.push(`Trend (EMA alignment): ${indicators.trend.label}`);
  }
  if (indicators.momentum.rsi !== null) {
    reasons.push(`RSI ${indicators.momentum.rsi.toFixed(1)}: ${indicators.momentum.rsiLabel}`);
  }
  if (indicators.momentum.macd.histogram !== null) {
    reasons.push(`MACD histogram ${indicators.momentum.macd.histogram.toFixed(6)}: ${indicators.momentum.macdLabel}`);
  }
  if (indicators.volatility.bollingerLabel !== 'Insufficient data') {
    reasons.push(`Bollinger: ${indicators.volatility.bollingerLabel}`);
  }
  if (!reasons.length) reasons.push('Not enough candle history yet for indicators to be defined.');
  return reasons.slice(0, 3);
}

async function buildPayload(candle, marketStatus) {
  const candles = await provider.getCandles('sample', '1m', 300);
  const indicators = indicatorEngine.compute(candles);

  const state = marketStatus === 'CLOSED' ? 'NO_TRADE' : STATES[Math.floor(Math.random() * STATES.length)];
  const strength = marketStatus === 'CLOSED' ? 0 : Math.floor(30 + Math.random() * 60);

  const warnings = [];
  if (marketStatus === 'CLOSED') {
    warnings.push('Replay data exhausted — tap RESTART to replay from the beginning');
  } else {
    warnings.push('Signal state/strength are still placeholder/random — real scoring arrives in Phase 5');
  }
  if (indicators.candleCount < 200) {
    warnings.push(`EMA200 needs 200 candles (have ${indicators.candleCount}) — reported as insufficient until then`);
  }

  return {
    mock: true,
    dataset: currentDatasetLabel,
    asset: 'EUR/USD (sample)',
    timeframe: '1M',
    marketStatus,
    signalState: state,
    strength,
    lastCandle: candle || null,
    indicators,
    reasons: buildReasons(indicators),
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
