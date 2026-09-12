import { BacktestEngine } from '../backtest/BacktestEngine.js';

// A dedicated worker for backtesting (separate from engine.worker.js, which
// runs the live replay loop) — so a potentially heavier one-off computation
// never blocks or competes with the live analysis loop, matching the
// architecture's "Backtesting Engine" as its own box feeding results back,
// not something bolted onto the real-time engine.

const engine = new BacktestEngine();

self.onmessage = (e) => {
  const { type, payload } = e.data || {};
  if (type !== 'run') return;

  try {
    const result = engine.run(payload.candles, payload.options || {});
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
