import { RealtimeEngine } from '../engine/RealtimeEngine.js';
import { analyzePriceAction } from '../signal/priceAction.js';
import { extractFeatures, FEATURE_NAMES } from './features.js';
import { LogisticRegression, standardize } from './logisticRegression.js';

/**
 * MLExperiment — Phase 11's "optional ML experimentation," kept
 * deliberately separate from the live SIGNAL engine (see features.js for
 * why). Builds a labeled dataset by walking the candle history exactly
 * once with RealtimeEngine (same no-look-ahead guarantee already verified
 * for the backtester — a feature vector at candle i only ever reflects
 * candles[0..i]), splits it CHRONOLOGICALLY (never shuffled — shuffling
 * a time series before splitting leaks future information into training),
 * trains a small logistic regression on the training split only, and
 * reports accuracy on validation and (crucially) a held-out TEST set the
 * model never touched during training — plus a probability-calibration
 * table on that same test set, the same honesty mechanism Phase 10 uses
 * for the rule-based signal strength, applied here to the model's own
 * predicted probabilities.
 *
 * Also runs a short walk-forward evaluation (expanding-window retrain,
 * test on the next chronological fold, repeat) as a second, more robust
 * out-of-sample estimate — matching the spec's
 * "train -> validate -> test -> walk-forward -> paper trading" pipeline,
 * short of actual paper trading (that would require a live feed, out of
 * scope for a client-only PWA with only replay/imported data).
 */
export class MLExperiment {
  run(candles, options = {}) {
    const holdingPeriod = options.holdingPeriod ?? 1;
    const trainFrac = options.trainFrac ?? 0.6;
    const valFrac = options.valFrac ?? 0.2;
    // testFrac is whatever remains

    const { X, y, times } = buildDataset(candles, holdingPeriod);

    if (X.length < 40) {
      return { insufficientData: true, sampleSize: X.length };
    }

    const n = X.length;
    const trainEnd = Math.floor(n * trainFrac);
    const valEnd = Math.floor(n * (trainFrac + valFrac));

    const rawTrainX = X.slice(0, trainEnd);
    const trainY = y.slice(0, trainEnd);
    const rawValX = X.slice(trainEnd, valEnd);
    const valY = y.slice(trainEnd, valEnd);
    const rawTestX = X.slice(valEnd);
    const testY = y.slice(valEnd);
    const testTimes = times.slice(valEnd);

    const { trainX, otherSets: [valX, testX] } = standardize(rawTrainX, rawValX, rawTestX);

    const model = new LogisticRegression({ epochs: 300, learningRate: 0.2, l2: 0.02 });
    model.fit(trainX, trainY);

    const trainAcc = accuracy(model, trainX, trainY);
    const valAcc = accuracy(model, valX, valY);
    const testAcc = accuracy(model, testX, testY);

    const testPredictions = testX.map((x, i) => ({
      proba: model.predictProba(x),
      actual: testY[i],
      time: testTimes[i],
    }));
    const calibration = buildCalibrationTable(testPredictions);

    const walkForward = runWalkForward(X, y, holdingPeriod);

    return {
      insufficientData: false,
      sampleSize: n,
      splitSizes: { train: trainEnd, validation: valEnd - trainEnd, test: n - valEnd },
      trainAccuracy: trainAcc,
      validationAccuracy: valAcc,
      testAccuracy: testAcc,
      calibration,
      walkForward,
      featureNames: FEATURE_NAMES,
      weights: model.weights,
      holdingPeriod,
    };
  }
}

/** Walks the candles once (no look-ahead) building a (features, label,
 * time) triple per usable candle. Label = 1 if price is higher
 * `holdingPeriod` candles later, else 0 — grading is the only place this
 * looks forward, exactly like the backtester. */
function buildDataset(candles, holdingPeriod) {
  const rt = new RealtimeEngine({ lookback: 3 });
  const X = [];
  const y = [];
  const times = [];

  for (let i = 0; i < candles.length; i++) {
    const result = rt.ingest(candles[i]);
    if (!result) continue;

    const futureIndex = i + holdingPeriod;
    if (futureIndex >= candles.length) continue; // no future candle to grade against yet

    const priceAction = analyzePriceAction(rt.recentCandles);
    const features = extractFeatures(result.indicators, result.structure, priceAction, candles[i].close, candles[i].time);
    if (!features) continue;

    X.push(features);
    y.push(candles[futureIndex].close > candles[i].close ? 1 : 0);
    times.push(candles[i].time);
  }

  return { X, y, times };
}

function accuracy(model, X, y) {
  if (!X.length) return null;
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = model.predictProba(X[i]) >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  return (correct / X.length) * 100;
}

/** Buckets test-set predictions by predicted probability decile and
 * reports the ACTUAL outcome rate in each bucket — the same honesty
 * mechanism as Phase 10's strength-vs-win-rate table, applied to this
 * model's own output instead of the rule-based strength score. */
function buildCalibrationTable(predictions) {
  const buckets = {};
  for (const p of predictions) {
    const bucket = Math.min(90, Math.floor(p.proba * 100 / 10) * 10);
    const label = `${bucket}-${bucket + 9}%`;
    if (!buckets[label]) buckets[label] = [];
    buckets[label].push(p);
  }
  return Object.keys(buckets)
    .sort((a, b) => parseInt(a) - parseInt(b))
    .map((label) => {
      const group = buckets[label];
      const actualRate = (group.filter((p) => p.actual === 1).length / group.length) * 100;
      return { label, count: group.length, actualUpRate: actualRate };
    });
}

/** Expanding-window walk-forward: fold the dataset into `folds` chronological
 * chunks, train on everything before fold k, test on fold k, for k=2..folds.
 * Each fold's model only ever sees data strictly before that fold — no
 * look-ahead across folds either. */
function runWalkForward(X, y, holdingPeriod, folds = 5) {
  const n = X.length;
  if (n < folds * 10) return { ran: false, reason: 'not enough data for walk-forward folds' };

  const foldSize = Math.floor(n / folds);
  const foldAccuracies = [];

  for (let k = 1; k < folds; k++) {
    const trainEnd = foldSize * k;
    const testStart = trainEnd;
    const testEnd = k === folds - 1 ? n : foldSize * (k + 1);

    const rawTrainX = X.slice(0, trainEnd);
    const trainY = y.slice(0, trainEnd);
    const rawTestX = X.slice(testStart, testEnd);
    const testY = y.slice(testStart, testEnd);
    if (!rawTrainX.length || !rawTestX.length) continue;

    const { trainX, otherSets: [testX] } = standardize(rawTrainX, rawTestX);
    const model = new LogisticRegression({ epochs: 250, learningRate: 0.2, l2: 0.02 });
    model.fit(trainX, trainY);
    const acc = accuracy(model, testX, testY);
    if (acc !== null) foldAccuracies.push(acc);
  }

  if (!foldAccuracies.length) return { ran: false, reason: 'no valid folds' };
  const avg = foldAccuracies.reduce((a, b) => a + b, 0) / foldAccuracies.length;
  return { ran: true, folds: foldAccuracies.length, foldAccuracies, averageAccuracy: avg };
}
