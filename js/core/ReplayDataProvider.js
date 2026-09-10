import { MarketDataProvider } from './MarketDataProvider.js';

/**
 * ReplayDataProvider
 *
 * Takes an already-normalized, ascending-by-time candle array (synthetic
 * sample data, or a user-imported legitimate historical file) and replays
 * it candle-by-candle on an interval, simulating a live feed.
 *
 * Deliberately enforces no-look-ahead: `getCandles()` and `getLatestPrice()`
 * only ever return data up to the current replay position, never candles
 * that haven't "closed" yet in replay time. This matters now (so the engine
 * is built against realistic constraints) and matters even more from
 * Phase 9 onward, when the same rule prevents look-ahead bias in backtests.
 *
 * This still has no connection to Quotex or any live broker feed — the
 * data source is either the bundled synthetic sample or a file you supply.
 */
export class ReplayDataProvider extends MarketDataProvider {
  /**
   * @param {Array<{time:number, open:number, high:number, low:number, close:number}>} candles
   * @param {{ intervalMs?: number, label?: string }} [options]
   */
  constructor(candles, options = {}) {
    super();
    this._candles = candles;
    this._index = Math.min(20, candles.length); // prime with a small history so indicators (Phase 3+) have something to work with immediately
    this._intervalMs = options.intervalMs ?? 2000;
    this._label = options.label ?? 'replay';
    this._timer = null;
  }

  async getCandles(asset, timeframe, count) {
    const upTo = this._candles.slice(0, this._index);
    return upTo.slice(Math.max(0, upTo.length - count));
  }

  async getLatestPrice(asset) {
    const visible = this._candles.slice(0, this._index);
    const last = visible[visible.length - 1];
    return last ? { price: last.close, time: last.time } : { price: null, time: null };
  }

  subscribeToRealtimeData(asset, timeframe, onData) {
    this._timer = setInterval(() => {
      if (this._index >= this._candles.length) {
        clearInterval(this._timer);
        onData({ type: 'end' });
        return;
      }
      const candle = this._candles[this._index];
      this._index += 1;
      onData({ type: 'candle_close', candle });
    }, this._intervalMs);

    return () => {
      if (this._timer) clearInterval(this._timer);
    };
  }

  async getMarketStatus() {
    if (this._index >= this._candles.length) {
      return { status: 'CLOSED', reason: 'Replay data exhausted' };
    }
    return { status: 'ACTIVE', reason: `Replaying ${this._label}` };
  }

  /** Reset the replay position back to the start (used by the "restart" control). */
  reset() {
    if (this._timer) clearInterval(this._timer);
    this._index = Math.min(20, this._candles.length);
  }
}
