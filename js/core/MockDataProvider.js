import { MarketDataProvider } from './MarketDataProvider.js';

/**
 * MockDataProvider — Phase 1 placeholder ONLY.
 * Emits a synthetic random-walk "candle close" on an interval so the full
 * pipeline (provider -> engine -> UI) can be proven end-to-end without any
 * real market connection. Phase 2 replaces this with a real historical
 * candle replay provider (no live Quotex connection, per project rules).
 */
export class MockDataProvider extends MarketDataProvider {
  constructor() {
    super();
    this._price = 1.0850;
    this._timer = null;
  }

  async getCandles(asset, timeframe, count) {
    const candles = [];
    let p = this._price;
    for (let i = 0; i < count; i++) {
      const open = p;
      const close = open + (Math.random() - 0.5) * 0.0006;
      const high = Math.max(open, close) + Math.random() * 0.0002;
      const low = Math.min(open, close) - Math.random() * 0.0002;
      candles.push({ time: Date.now() - (count - i) * 60000, open, high, low, close });
      p = close;
    }
    return candles;
  }

  async getLatestPrice(asset) {
    return { price: this._price, time: Date.now() };
  }

  subscribeToRealtimeData(asset, timeframe, onData) {
    this._timer = setInterval(() => {
      const open = this._price;
      const close = open + (Math.random() - 0.5) * 0.0006;
      this._price = close;
      onData({
        type: 'candle_close',
        candle: {
          time: Date.now(),
          open,
          close,
          high: Math.max(open, close) + Math.random() * 0.0002,
          low: Math.min(open, close) - Math.random() * 0.0002,
        },
      });
    }, 3000);
    return () => clearInterval(this._timer);
  }

  async getMarketStatus(asset) {
    return { status: 'ACTIVE' };
  }
}
