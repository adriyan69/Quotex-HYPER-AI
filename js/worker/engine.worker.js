import { MockDataProvider } from '../core/MockDataProvider.js';

// The engine only ever talks to a MarketDataProvider through its interface.
// Swapping MockDataProvider for a real replay/licensed-feed provider later
// (Phase 2+) never requires touching this file's control flow.
const provider = new MockDataProvider();

let unsubscribe = null;
let running = false;

const STATES = ['STRONG_BUY', 'BUY', 'WAIT', 'SELL', 'STRONG_SELL', 'NO_TRADE'];

function scorePlaceholder() {
  // PLACEHOLDER ONLY — replaced by the real weighted multi-confirmation
  // scoring engine in Phase 5 (trend/momentum/structure/price-action/S-R/volatility).
  const state = STATES[Math.floor(Math.random() * STATES.length)];
  const strength = Math.floor(30 + Math.random() * 60);
  return {
    mock: true,
    asset: 'EUR/USD OTC',
    timeframe: '1M',
    marketStatus: 'ACTIVE',
    signalState: state,
    strength,
    reasons: [
      'Indicator engine not yet wired (Phase 3)',
      'Structure engine not yet wired (Phase 4)',
      'Scoring engine not yet wired (Phase 5)',
    ],
    warnings: ['This is MOCK data \u2014 Phase 1 shell only'],
    timestamp: new Date().toISOString(),
  };
}

self.onmessage = async (e) => {
  const { type } = e.data || {};

  if (type === 'start') {
    if (running) return;
    running = true;
    await provider.getCandles('EUR/USD OTC', '1m', 50); // priming, unused by the mock scorer yet
    unsubscribe = provider.subscribeToRealtimeData('EUR/USD OTC', '1m', () => {
      self.postMessage(scorePlaceholder());
    });
    self.postMessage(scorePlaceholder()); // immediate first update
  }

  if (type === 'stop') {
    running = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    self.postMessage({
      mock: true,
      asset: 'EUR/USD OTC',
      timeframe: '1M',
      marketStatus: 'PAUSED',
      signalState: 'NO_TRADE',
      strength: 0,
      reasons: [],
      warnings: ['Analysis stopped'],
      timestamp: new Date().toISOString(),
    });
  }
};
