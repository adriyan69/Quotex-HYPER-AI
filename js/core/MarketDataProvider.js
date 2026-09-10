/**
 * MarketDataProvider — abstract interface (unchanged from the desktop build).
 *
 * Any concrete provider (simulated/replay, or a legitimate licensed
 * market-data feed you are authorized to use) implements this shape.
 * The analysis engine (running in engine.worker.js) depends ONLY on this
 * interface, never on a specific vendor.
 *
 * This project does not, and will not, implement a provider that logs into
 * Quotex, reads its session/auth tokens, or scrapes its private endpoints.
 */
export class MarketDataProvider {
  async getCandles(asset, timeframe, count) {
    throw new Error('getCandles() not implemented');
  }

  async getLatestPrice(asset) {
    throw new Error('getLatestPrice() not implemented');
  }

  /**
   * @param {(event: {type:'tick'|'candle_close', candle:object}) => void} onData
   * @returns {() => void} unsubscribe function
   */
  subscribeToRealtimeData(asset, timeframe, onData) {
    throw new Error('subscribeToRealtimeData() not implemented');
  }

  async getMarketStatus(asset) {
    throw new Error('getMarketStatus() not implemented');
  }
}
