import { ReplayDataProvider } from '../core/ReplayDataProvider.js';
import { sampleCandles } from '../core/sampleData.js';

// The engine only ever talks to a MarketDataProvider through its interface.
// Right now that's ReplayDataProvider fed by either the bundled synthetic
// sample or candles you imported yourself. Swapping in a real licensed feed
// later (Phase 12) never requires touching this file's control flow.
let provider = new ReplayDataProvider(sampleCandles, { intervalMs: 2000, label: 'synthetic sample' });
let unsubscribe = null;
let running = false;
let currentDatasetLabel = 'Synthetic sample (not real market data)';

const STATES = ['STRONG_BUY', 'BUY', 'WAIT', 'SELL', 'STRONG_SELL', 'NO_TRADE'];

function scorePlaceholder(candle, marketStatus) {
  // PLACEHOLDER ONLY — replaced by the real weighted multi-confirmation
  // scoring engine in Phase 5 (trend/momentum/structure/price-action/S-R/volatility).
  // The candle itself is now real replay data (Phase 2); only the scoring
  // logic that reads it is still a stand-in.
  const state = marketStatus === 'CLOSED' ? 'NO_TRADE' : STATES[Math.floor(Math.random() * STATES.length)];
  const strength = marketStatus === 'CLOSED' ? 0 : Math.floor(30 + Math.random() * 60);
  return {
    mock: true,
    dataset: currentDatasetLabel,
    asset: 'EUR/USD (sample)',
    timeframe: '1M',
    marketStatus,
    signalState: state,
    strength,
    lastCandle: candle || null,
    reasons: [
      'Indicator engine not yet wired (Phase 3)',
      'Structure engine not yet wired (Phase 4)',
      'Scoring engine not yet wired (Phase 5)',
    ],
    warnings:
      marketStatus === 'CLOSED'
        ? ['Replay data exhausted — tap START to restart']
        : ['Signal state/strength are still placeholders, not real analysis'],
    timestamp: new Date().toISOString(),
  };
}

async function postCurrentSnapshot() {
  const status = await provider.getMarketStatus();
  const candles = await provider.getCandles('sample', '1m', 1);
  const lastCandle = candles[candles.length - 1] || null;
  self.postMessage(scorePlaceholder(lastCandle, status.status));
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
      self.postMessage(scorePlaceholder(event.candle, status.status));
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
