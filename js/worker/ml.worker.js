import { MLExperiment } from '../ml/MLExperiment.js';

// Dedicated worker for the experimental ML Lab (Phase 11) — separate from
// both the live analysis loop and the backtest worker, so training never
// competes with either.

const experiment = new MLExperiment();

self.onmessage = (e) => {
  const { type, payload } = e.data || {};
  if (type !== 'run') return;

  try {
    const result = experiment.run(payload.candles, payload.options || {});
    self.postMessage({ type: 'result', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
