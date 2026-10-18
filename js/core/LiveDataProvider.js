import { MarketDataProvider } from './MarketDataProvider.js';
import { normalizeCandles } from './CandleNormalizer.js';

/**
 * LiveDataProvider — a GENERIC template implementing the same
 * MarketDataProvider interface ReplayDataProvider/MockDataProvider use.
 * This is not wired into the app by default and does not point at any
 * real vendor out of the box — fill in the three TODO sections below with
 * your chosen provider's actual REST/WebSocket details (see
 * LIVE-DATA-GUIDE.md for provider options and the API-key exposure
 * tradeoffs before you do).
 *
 * This file has NOTHING to do with Quotex and must never be adapted to
 * call anything Quotex-owned, authenticated, or private — see the guide
 * and the project's original constraints (Section 19).
 *
 * Design notes:
 *  - All raw data is passed through normalizeCandles() before anything
 *    downstream ever sees it — same rule as every other provider in this
 *    app, so indicators/structure/scoring never need to know or care
 *    where a candle came from.
 *  - getMarketStatus() should reflect whether the REAL market is open,
 *    not just "is this provider reachable" — forex markets close on
 *    weekends, for instance. Adjust the placeholder logic below for
 *    your asset class.
 *  - The WebSocket path reconnects with exponential backoff on drops,
 *    capped at a sane maximum, so a flaky mobile connection doesn't spin
 *    forever or hammer the provider.
 */
export class LiveDataProvider extends MarketDataProvider {
  /**
   * @param {{ apiKey: string, asset: string, timeframe: string }} config
   */
  constructor(config) {
    super();
    this._apiKey = config.apiKey;
    this._asset = config.asset;
    this._timeframe = config.timeframe || '1min';
    this._ws = null;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._subscribers = new Set();
    this._lastCandle = null;
  }

  async getCandles(asset, timeframe, count) {
    // TODO: replace with your provider's historical-candles REST endpoint.
    // Example shape (adjust to your provider's actual request format):
    //
    //   const url = `https://api.YOURPROVIDER.com/candles` +
    //     `?symbol=${encodeURIComponent(asset)}` +
    //     `&interval=${encodeURIComponent(timeframe)}` +
    //     `&outputsize=${count}` +
    //     `&apikey=${this._apiKey}`;
    //   const res = await fetch(url);
    //   if (!res.ok) throw new Error(`Historical candle fetch failed: ${res.status}`);
    //   const raw = await res.json();
    //   return normalizeCandles(raw.values); // adjust `raw.values` to your provider's response shape

    throw new Error(
      'LiveDataProvider.getCandles() is a template — fill in your provider\'s ' +
      'REST endpoint in js/core/LiveDataProvider.js before using this.'
    );
  }

  async getLatestPrice(asset) {
    if (this._lastCandle) {
      return { price: this._lastCandle.close, time: this._lastCandle.time };
    }
    // TODO: optionally add a REST fallback for "latest price" if your
    // provider has a lightweight quote endpoint separate from candles.
    return { price: null, time: null };
  }

  subscribeToRealtimeData(asset, timeframe, onData) {
    this._subscribers.add(onData);
    if (!this._ws) this._connect();

    return () => {
      this._subscribers.delete(onData);
      if (this._subscribers.size === 0) this._disconnect();
    };
  }

  async getMarketStatus(asset) {
    // TODO: replace with real market-hours logic for your asset class.
    // Placeholder below treats Sat/Sun UTC as closed (typical for forex) —
    // adjust or replace entirely depending on what you're connecting to.
    const day = new Date().getUTCDay(); // 0 = Sunday, 6 = Saturday
    const isWeekend = day === 0 || day === 6;
    return isWeekend
      ? { status: 'CLOSED', reason: 'Market closed (weekend)' }
      : { status: 'ACTIVE', reason: 'Live feed connected' };
  }

  // ---- WebSocket connection, with reconnect/backoff ----

  _connect() {
    // TODO: replace with your provider's WebSocket URL and auth scheme.
    // Example:
    //   const url = `wss://api.YOURPROVIDER.com/stream?apikey=${this._apiKey}`;
    //   this._ws = new WebSocket(url);
    //
    //   this._ws.onopen = () => {
    //     this._reconnectAttempt = 0;
    //     this._ws.send(JSON.stringify({ action: 'subscribe', symbol: this._asset }));
    //   };
    //
    //   this._ws.onmessage = (event) => {
    //     const msg = JSON.parse(event.data);
    //     // TODO: adapt this to however your provider frames a closed candle
    //     // vs. a mid-candle tick. If the provider only sends ticks (no
    //     // candle-close events), you'll need to aggregate ticks into
    //     // candles yourself here before calling _emit().
    //     if (msg.type === 'candle_close') {
    //       const [candle] = normalizeCandles([msg.candle]);
    //       if (candle) {
    //         this._lastCandle = candle;
    //         this._emit({ type: 'candle_close', candle });
    //       }
    //     }
    //   };
    //
    //   this._ws.onclose = () => this._scheduleReconnect();
    //   this._ws.onerror = () => this._ws.close();

    throw new Error(
      'LiveDataProvider._connect() is a template — fill in your provider\'s ' +
      'WebSocket URL and message handling in js/core/LiveDataProvider.js before using this.'
    );
  }

  _disconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.onclose = null; // prevent the reconnect handler firing on a deliberate close
      this._ws.close();
      this._ws = null;
    }
  }

  _scheduleReconnect() {
    this._ws = null;
    if (this._subscribers.size === 0) return; // nobody's listening anymore, don't bother

    const delay = Math.min(30_000, 1000 * 2 ** this._reconnectAttempt);
    this._reconnectAttempt += 1;
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _emit(event) {
    for (const cb of this._subscribers) cb(event);
  }
}
